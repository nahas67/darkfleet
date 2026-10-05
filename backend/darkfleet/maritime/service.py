"""Compose one target's maritime context from the installed local snapshots.

THE AUTHORITY CHAIN
-------------------
    (scanId, targetId)
        -> persisted scan target        -- the authoritative WGS84 position
        -> MaritimeContextService
        -> per-channel readers
        -> per-channel provenance

The client never supplies a coordinate. A route that accepted lat/lon would let a caller
ask about a different vessel than the one named in the URL while the answer still looked
authoritative, and target ids are only unique WITHIN a scan -- ``DF-002`` exists in many
scans -- so the scan half of the identity is load-bearing, not decorative.

WHY A COMPOSITION LAYER
-----------------------
Four readers, four independent datasets, four independent failure states. Composing them
in one place means each channel can fail without affecting the others, which is the
requirement: a missing GEBCO must not turn the route into a 500, and must not blank the
zone or the coastline that did resolve.

PROVENANCE PER VALUE, NOT PER RESPONSE
---------------------------------------
A single source block at the top would make "which dataset produced this number"
unanswerable, because the answer differs per channel. Each carries its own, built from the
installed manifest the reader actually consulted.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from darkfleet.api.maritime_models import (
    CONTEXT_VERSION,
    BathymetryContext,
    CoastContext,
    PortContext,
    SourceRef,
    TargetMaritimeContextResponse,
    TargetPosition,
    ZoneContext,
)
from darkfleet.maritime.context import (
    ContextStatus,
    classify_zone,
    coast_distance,
    nearest_port,
    sample_bathymetry,
)
from darkfleet.maritime.datasets import InstalledDataset, InstallStatus
from darkfleet.maritime.provenance import DatasetProvenance, MaritimeZone
from darkfleet.maritime.registry import dataset_label
from darkfleet.maritime.store import status_of

#: Dataset ids the context service reads.
#:
#: Declared here rather than imported from ``tests/maritime_fixtures.py``. A production
#: module reaching into the test package is a layering inversion: the moment the tests
#: move, or are excluded from an install, production breaks. The fixtures declare the
#: same values independently, so a change to one is a visible disagreement rather than a
#: silent coupling.
COAST_ID = "natural_earth_coastline"
PORTS_ID = "nga_world_port_index"
BATHY_ID = "gebco_2025"


def source_ref(installed: InstalledDataset | None, dataset_id: str) -> SourceRef | None:
    """A :class:`SourceRef` for a dataset, present even when it is not installed.

    Deliberate: an operator looking at ``NOT_INSTALLED`` should still learn WHICH
    dataset would answer and how to obtain it. Returning None there would make the
    absence anonymous.
    """
    state = installed if installed is not None else status_of(_CURRENT_DATA_DIR[0], dataset_id)
    manifest = state.manifest
    return SourceRef(
        provider=manifest.provider,
        dataset=manifest.dataset,
        version=manifest.version,
        license=manifest.license,
        attribution=manifest.attribution,
        identifier=manifest.identifier or "",
        release_date=manifest.release_date,
        terms_notes=manifest.terms_notes,
        limitations=manifest.limitations,
        coverage_note=manifest.coverage_note,
        install_status=state.status.value,
    )


#: Set by the route so the helpers can reach the deployment data directory without every
#: call site threading it through. A module-level holder is a deliberate simplification
#: and is annotated here so it is not mistaken for a hidden global cache.
_CURRENT_DATA_DIR: list[Path] = [Path(".")]


def _bind(data_dir: Path) -> None:
    _CURRENT_DATA_DIR[0] = data_dir


def _provenance_to_ref(
    provenance: DatasetProvenance | None, install_status: InstallStatus, dataset_id: str,
    data_dir: Path,
) -> SourceRef | None:
    """Build a :class:`SourceRef` from what is on disk.

    ``retrieved_at`` comes from the manifest rather than being stamped here. That is the
    whole point: for a service snapshot the retrieval time is the only version-like fact
    the publisher gave us, and it must be the time the snapshot was actually taken -- not
    the time this response happened to be rendered, which would change on every read and
    silently imply the data was refreshed.
    """
    if provenance is None:
        return source_ref(None, dataset_id)
    installed = status_of(data_dir, dataset_id)
    manifest = installed.manifest
    return SourceRef(
        provider=provenance.provider,
        dataset=provenance.dataset,
        version=provenance.version,
        license=provenance.license,
        attribution=provenance.attribution,
        identifier=provenance.identifier,
        release_date=manifest.release_date,
        retrieved_at=installed.retrieved_at,
        terms_notes=provenance.terms_notes,
        limitations=provenance.limitations,
        coverage_note=provenance.coverage_note,
        install_status=install_status.value,
    )


def _zone_context(data_dir: Path, lon: float, lat: float) -> ZoneContext:
    from darkfleet.maritime.context import HIGH_SEAS_DATASET, ZONE_DATASET

    classification = classify_zone(data_dir, lon=lon, lat=lat)
    # The zone's provenance comes from the dataset that DECIDED it, which may be the
    # high-seas layer rather than the EEZ layer. Reading it off the wrong manifest would
    # attribute a high-seas answer to the EEZ dataset.
    deciding_id = (
        HIGH_SEAS_DATASET
        if classification.zone is MaritimeZone.HIGH_SEAS
        else ZONE_DATASET
    )
    ref = _provenance_to_ref(
        classification.provenance,
        status_of(data_dir, deciding_id).status,
        deciding_id,
        data_dir,
    )
    if classification.established:
        return ZoneContext(
            status=ContextStatus.AVAILABLE,
            zone=classification.zone,
            feature_id=classification.feature_id,
            sovereign_names=classification.sovereign_names,
            dispute_note=classification.dispute_note,
            reason=classification.reason,
            established=classification.established,
            disputed=classification.disputed,
            provenance=ref,
        )
    # A non-answer still reports WHICH dataset was consulted, so an operator can tell
    # "installed but this point is ambiguous" from "nothing installed".
    if ref is not None and ref.install_status in (
        InstallStatus.READY.value,
        InstallStatus.CHECKSUM_UNRECORDED.value,
    ):
        status = ContextStatus.AVAILABLE
    else:
        status = ContextStatus.NOT_INSTALLED
    return ZoneContext(
        status=status,
        zone=None,
        feature_id=None,
        sovereign_names=(),
        dispute_note=None,
        reason=classification.reason,
        established=False,
        disputed=False,
        provenance=ref,
    )


def _coast_context(data_dir: Path, lon: float, lat: float) -> CoastContext:
    result = coast_distance(data_dir, lon=lon, lat=lat, max_radius_m=600_000.0)
    installed = status_of(data_dir, COAST_ID)
    if result.status is ContextStatus.AVAILABLE:
        status = ContextStatus.AVAILABLE
    elif result.status is ContextStatus.FAILED:
        status = ContextStatus.FAILED
    elif installed.usable:
        status = ContextStatus.NO_COVERAGE
    else:
        status = ContextStatus.NOT_INSTALLED
    return CoastContext(
        status=status,
        meters=result.meters,
        method=result.method,
        sample_spacing_m=result.sample_spacing_m,
        searched_radius_m=result.searched_radius_m,
        provenance=_provenance_to_ref(
            result.provenance, installed.status, COAST_ID, data_dir
        ),
        detail=result.detail,
    )


def _port_context(data_dir: Path, lon: float, lat: float) -> PortContext:
    result = nearest_port(data_dir, lon=lon, lat=lat, max_radius_m=400_000.0)
    installed = status_of(data_dir, PORTS_ID)
    if result.status is ContextStatus.AVAILABLE:
        status = ContextStatus.AVAILABLE
    elif result.status is ContextStatus.FAILED:
        status = ContextStatus.FAILED
    elif installed.usable:
        status = ContextStatus.NO_COVERAGE
    else:
        status = ContextStatus.NOT_INSTALLED
    return PortContext(
        status=status,
        port_id=result.port_id,
        name=result.name,
        country=result.country,
        harbor_type=result.harbor_type,
        harbor_size=result.harbor_size,
        longitude=result.lon,
        latitude=result.lat,
        meters=result.meters,
        method=result.method,
        searched_radius_m=result.searched_radius_m,
        provenance=_provenance_to_ref(
            result.provenance, installed.status, PORTS_ID, data_dir
        ),
        interpretation=result.interpretation,
        detail=result.detail,
    )


def _bathymetry_context(data_dir: Path, lon: float, lat: float) -> BathymetryContext:
    result = sample_bathymetry(data_dir, lon=lon, lat=lat)
    installed = status_of(data_dir, BATHY_ID)
    if result.status is ContextStatus.AVAILABLE:
        status = ContextStatus.AVAILABLE
    elif result.status is ContextStatus.FAILED:
        status = ContextStatus.FAILED
    elif installed.usable:
        status = ContextStatus.NO_COVERAGE
    else:
        status = ContextStatus.NOT_INSTALLED
    detail = result.detail
    if status is ContextStatus.NOT_INSTALLED and not detail:
        # Say what would answer, not merely that nothing did. GEBCO_2025 is an OPTIONAL
        # local dataset, so an operator needs to know it is installable rather than
        # broken.
        detail = (
            f"{dataset_label(BATHY_ID)} is an optional local dataset and is not "
            "installed. Install it with: darkfleet data install maritime --dataset "
            "gebco_2025"
        )
    return BathymetryContext(
        status=status,
        meters=result.meters,
        resolution_deg=result.resolution_deg,
        source_type=result.source_type,
        provenance=_provenance_to_ref(
            result.provenance, installed.status, BATHY_ID, data_dir
        ),
        detail=detail,
    )


def build_context(
    data_dir: Path,
    *,
    scan_id: str,
    target_id: str,
    latitude: float,
    longitude: float,
) -> TargetMaritimeContextResponse:
    """Compose the whole context. Never raises for a missing dataset."""
    _bind(data_dir)
    return TargetMaritimeContextResponse(
        scan_id=scan_id,
        target_id=target_id,
        position=TargetPosition(latitude=latitude, longitude=longitude),
        maritime_zone=_zone_context(data_dir, longitude, latitude),
        nearest_coast=_coast_context(data_dir, longitude, latitude),
        nearest_port=_port_context(data_dir, longitude, latitude),
        bathymetry=_bathymetry_context(data_dir, longitude, latitude),
        generated_at=datetime.now(UTC).replace(microsecond=0),
        context_version=CONTEXT_VERSION,
    )