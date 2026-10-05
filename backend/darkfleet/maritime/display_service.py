"""Compose the display and dataset-health responses from the installed snapshots.

WHAT THIS MODULE IS FOR
-----------------------
Two things the globe and the system panel need that the analytical readers do not provide:

    /api/maritime/layers   simplified geometry with SAME-DATASET provenance
    /api/maritime/datasets the honest state of every local reference dataset

It reads the SAME installed payloads the analytical path reads. There is no second
download, no second preparation step, and no path that could show the globe geometry from
one dataset version while the dossier quotes another.

THE BLOCKER VOCABULARY
----------------------
``NOT_INSTALLED`` is the normal state for an optional dataset and is not a fault. The
World Port Index is a different case: it is registered, it is wanted, and it cannot be
obtained because the publisher's service will not complete a trusted TLS handshake. Those
are different facts and get different words:

    optional dataset, not installed      no blocker_reason
    wanted, transport unavailable        blocker_reason set

A panel that printed "NOT INSTALLED" for both would tell an operator that nothing is
wrong with the port data, which is not what happened.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from darkfleet.api.maritime_geometry_models import (
    CoastlineGeometryResponse,
    DatasetHealthEntry,
    DatasetHealthResponse,
    DisplayGeometryMeta,
    DisplayLine,
    DisplayPolygon,
    ZoneGeometryResponse,
)
from darkfleet.api.maritime_models import SourceRef
from darkfleet.maritime.context import HIGH_SEAS_DATASET, ZONE_DATASET
from darkfleet.maritime.datasets import InstalledDataset, InstallStatus
from darkfleet.maritime.display import (
    bbox_of,
    coast_display_geometry,
    overlaps,
    zone_display_geometry,
)
from darkfleet.maritime.display_cache import cached_or_build, peek
from darkfleet.maritime.provenance import DatasetProvenance, MaritimeZone
from darkfleet.maritime.registry import dataset_label, known_dataset_ids
from darkfleet.maritime.service import COAST_ID
from darkfleet.maritime.store import all_statuses, load_prepared, status_of

#: Datasets whose absence is a deliberate choice. Not a fault, no blocker wording.
OPTIONAL_DATASETS = frozenset({"gebco_2025"})

#: Datasets that are wanted and could not be obtained. Recorded as an external blocker
#: rather than a TODO, because the reason is a publisher's transport, not DarkFleet's
#: backlog.
BLOCKED_DATASETS: dict[str, str] = {
    "nga_world_port_index": (
        "TRUSTED TRANSPORT UNAVAILABLE - the publisher's FeatureServer at "
        "vcps.nga.mil presents a certificate with an empty issuer and a self-signed "
        "certificate in the chain, so verification fails; over an unverified channel the "
        "endpoint closes the connection without responding. TLS verification was NOT "
        "disabled and no third-party copy was substituted."
    ),
}

#: Which dataset each displayable layer draws from.
LAYER_DATASETS: dict[str, str] = {
    "REFERENCE_COASTLINE": COAST_ID,
    "EEZ_BOUNDARIES": ZONE_DATASET,
    "HIGH_SEAS": HIGH_SEAS_DATASET,
}


def _source_ref(provenance: DatasetProvenance | None, install_status: InstallStatus) -> SourceRef | None:
    """A :class:`SourceRef` from an installed dataset's provenance.

    Built from what is on disk, so the version the globe draws is the version the dossier
    quotes. For a dataset that is not installed the manifest is used instead, so the UI
    can still NAME what is missing -- an anonymous absence is not actionable.
    """
    if provenance is None:
        return None
    return SourceRef(
        provider=provenance.provider,
        dataset=provenance.dataset,
        version=provenance.version,
        license=provenance.license,
        attribution=provenance.attribution,
        identifier=provenance.identifier,
        # `DatasetProvenance` carries neither `release_date` nor `retrieved_at`: both are
        # properties of what is ON DISK, not of the derived provenance. The dataset-health
        # route reads them from the manifest; here the caller supplies them.
        release_date=None,
        retrieved_at=None,
        terms_notes=provenance.terms_notes,
        limitations=provenance.limitations,
        coverage_note=provenance.coverage_note,
        install_status=install_status.value,
    )


def _installed_ref(data_dir: Path, dataset_id: str) -> SourceRef | None:
    """A :class:`SourceRef` for a dataset whatever its install state.

    Constructed from the MANIFEST plus the observed on-disk state, which is the only pair
    that carries everything: the manifest holds the identity fields, and the observed state
    holds ``release_date``-adjacent facts like ``retrieved_at`` that the derived provenance
    does not. Present even when NOT_INSTALLED, so an absent dataset is named rather than
    anonymous.
    """
    state = status_of(data_dir, dataset_id)
    provenance = InstalledDataset(
        manifest=state.manifest, status=state.status
    ).provenance()
    ref = _source_ref(provenance, state.status)
    if ref is None:
        return None
    # Filled from the manifest and the install record rather than left out. The Marine
    # Regions layers are service snapshots with NO established version, so the retrieval
    # timestamp is the only thing that tells one snapshot from another -- dropping it here
    # would make the globe unable to say when the geometry it is drawing was read.
    return ref.model_copy(
        update={
            "release_date": state.manifest.release_date,
            "retrieved_at": state.retrieved_at,
        }
    )


#: The notice carried on every display payload. Restated in the body, not only in the UI,
#: so a screenshot or an export keeps the "this is simplified" qualification.
_SIMPLIFIED_NOTICE = (
    "DISPLAY GEOMETRY - simplified for rendering. The backend's distance and zone "
    "authority reads the full installed geometry and is unaffected."
)


def _absent_meta(tolerance_deg: float) -> DisplayGeometryMeta:
    """A meta block for an absent dataset, so the client has one shape to render."""
    return DisplayGeometryMeta(
        tolerance_deg=tolerance_deg,
        source_vertex_count=0,
        vertex_count=0,
        part_count=0,
        hole_count=0,
        viewport_filtered=False,
    )


def coastline_layer(
    data_dir: Path,
    *,
    tolerance_deg: float = 0.02,
    viewport: tuple[float, float, float, float] | None = None,
) -> CoastlineGeometryResponse:
    """Simplified coastline for the globe.

    ALWAYS returns the one response model, with ``status`` carrying the state. A separate
    error model was considered and rejected: it would make the generated contract a union
    and push "which shape did I get?" into every client, in exchange for distinguishing
    two states a ``status`` field distinguishes perfectly well.
    """
    state = status_of(data_dir, COAST_ID)
    ref = _installed_ref(data_dir, COAST_ID)
    if not state.usable:
        return CoastlineGeometryResponse(
            layer="REFERENCE_COASTLINE",
            status=state.status.value,
            detail=state.detail
            or "The Natural Earth coastline dataset is not installed on this machine.",
            provenance=ref,
            meta=_absent_meta(tolerance_deg),
        )

    memoised, _installed = peek(data_dir, COAST_ID, tolerance_deg)
    if memoised is None:
        payload = load_prepared(data_dir, COAST_ID)
        if not payload:
            return CoastlineGeometryResponse(
                layer="REFERENCE_COASTLINE",
                status="INVALID",
                detail="The installed coastline payload could not be read.",
                provenance=ref,
                meta=_absent_meta(tolerance_deg),
            )

    geometries = memoised if memoised is not None else cached_or_build(
        data_dir, COAST_ID, tolerance_deg,
        lambda _state: coast_display_geometry(
            load_prepared(data_dir, COAST_ID) or {}, tolerance_deg=tolerance_deg
        ),
    )
    if viewport is not None:
        geometries = [
            geometry
            for geometry in geometries
            if overlaps(viewport, bbox_of(geometry.parts))
        ]

    lines = tuple(
        DisplayLine(coordinates=part) for geometry in geometries for part in geometry.parts
    )
    return CoastlineGeometryResponse(
        layer="REFERENCE_COASTLINE",
        status=state.status.value,
        provenance=ref,
        lines=lines,
        meta=DisplayGeometryMeta(
            tolerance_deg=tolerance_deg,
            source_vertex_count=sum(g.source_vertex_count for g in geometries),
            vertex_count=sum(g.vertex_count for g in geometries),
            part_count=len(lines),
            hole_count=0,
            viewport_filtered=viewport is not None,
        ),
        bbox=bbox_of(part for line in lines for part in (line.coordinates,)),
    )


def zone_layer(
    data_dir: Path,
    layer: str,
    *,
    tolerance_deg: float = 0.02,
    viewport: tuple[float, float, float, float] | None = None,
) -> ZoneGeometryResponse:
    """Simplified zone polygons for ``EEZ_BOUNDARIES`` or ``HIGH_SEAS``.

    Same single-shape decision as the coastline: an unknown layer name is still answered
    with the one model and a status, because the function is called from routes whose path
    segment is fixed. A wrong name therefore cannot produce a shape the client cannot
    render.
    """
    dataset_id = LAYER_DATASETS.get(layer)
    if dataset_id is None:
        return ZoneGeometryResponse(
            layer=layer,
            status="NOT_ESTABLISHED",
            detail=f"Unknown display layer {layer!r}.",
            meta=_absent_meta(tolerance_deg),
        )

    state = status_of(data_dir, dataset_id)
    ref = _installed_ref(data_dir, dataset_id)
    if not state.usable:
        detail = state.detail or (
            f"{dataset_label(dataset_id)} is not installed on this machine."
        )
        if dataset_id in BLOCKED_DATASETS:
            # The blocker is appended rather than substituted: the install status says
            # what is on disk, the blocker says why nothing will arrive.
            detail = f"{detail} {BLOCKED_DATASETS[dataset_id]}"
        return ZoneGeometryResponse(
            layer=layer,
            status=state.status.value,
            detail=detail,
            provenance=ref,
            meta=_absent_meta(tolerance_deg),
        )

    # The memo is consulted BEFORE the payload is read. The Marine Regions snapshot is
    # 84 MB of JSON and parsing it costs ~1.5 s, so reading it on every request to then
    # discard the result is what kept a warm hit slow.
    memoised, _installed = peek(data_dir, dataset_id, tolerance_deg)
    if memoised is not None:
        entries = memoised
    else:
        payload = load_prepared(data_dir, dataset_id)
        if not payload:
            return ZoneGeometryResponse(
                layer=layer,
                status="INVALID",
                detail="The installed zone payload could not be read.",
                provenance=ref,
                meta=_absent_meta(tolerance_deg),
            )
        entries = cached_or_build(
            data_dir, dataset_id, tolerance_deg,
            lambda _state: zone_display_geometry(payload, tolerance_deg=tolerance_deg),
        )
    total = len(entries)

    if viewport is not None:
        entries = [
            entry
            for entry in entries
            if overlaps(viewport, bbox_of(entry["geometry"].parts))
        ]
    filtered = total - len(entries)

    polygons = tuple(
        DisplayPolygon(
            id=str(entry["id"]),
            zone=MaritimeZone(entry["zone"]) if entry["zone"] else None,
            pol_type=entry["pol_type"],
            geoname=entry["geoname"],
            sovereign_names=entry["sovereign_names"],
            territory_names=entry["territory_names"],
            dispute_note=entry["dispute_note"],
            disputed=bool(entry["disputed"]),
            parts=tuple(
                DisplayLine(coordinates=part) for part in entry["geometry"].parts
            ),
            holes=tuple(
                DisplayLine(coordinates=hole) for hole in entry["geometry"].holes
            ),
        )
        for entry in entries
    )

    return ZoneGeometryResponse(
        layer=layer,
        status=state.status.value,
        provenance=ref,
        polygons=polygons,
        meta=DisplayGeometryMeta(
            tolerance_deg=tolerance_deg,
            source_vertex_count=sum(
                entry["geometry"].source_vertex_count for entry in entries
            ),
            vertex_count=sum(entry["geometry"].vertex_count for entry in entries),
            part_count=sum(len(entry["geometry"].parts) for entry in entries),
            hole_count=sum(len(entry["geometry"].holes) for entry in entries),
            viewport_filtered=viewport is not None,
        ),
        bbox=bbox_of(
            part
            for polygon in polygons
            for part in (line.coordinates for line in (*polygon.parts, *polygon.holes))
        ),
        total_feature_count=total,
        filtered_feature_count=filtered,
    )


# ===========================================================================
# Dataset health
# ===========================================================================


def dataset_health(data_dir: Path) -> DatasetHealthResponse:
    """Every registered dataset's honest state on this machine.

    ``optional`` and ``blocker_reason`` are the two facts that keep the panel honest:
    without them, "GEBCO not installed" and "the port index could not be fetched" would
    render identically, and the second of those is a real external blocker.
    """
    entries: list[DatasetHealthEntry] = []
    for state in all_statuses(data_dir):
        manifest = state.manifest
        entries.append(
            DatasetHealthEntry(
                id=manifest.id,
                label=dataset_label(manifest.id),
                install_status=state.status.value,
                usable=state.usable,
                blocker_reason=BLOCKED_DATASETS.get(manifest.id),
                optional=manifest.id in OPTIONAL_DATASETS,
                provider=manifest.provider,
                dataset=manifest.dataset,
                version=manifest.version,
                version_established=manifest.version_established,
                release_date=manifest.release_date,
                # From the install record, not the manifest: the manifest carries no
                # retrieval time because it is a property of one snapshot, not of the
                # dataset. Reading the manifest here would always yield None for exactly
                # the service snapshots that most need it.
                retrieved_at=state.retrieved_at,
                license=manifest.license.value,
                attribution=manifest.attribution,
                identifier=manifest.identifier,
                source_mechanism=manifest.source_mechanism.value,
                source_service=manifest.source_service,
                source_layer=manifest.source_layer,
                source_feature_count=manifest.source_feature_count,
                installed_at=state.installed_at,
                computed_sha256=state.computed_sha256,
                expected_sha256=manifest.expected_sha256,
                coverage_note=manifest.coverage_note,
                terms_notes=manifest.terms_notes,
                limitations=manifest.limitations,
                detail=state.detail or BLOCKED_DATASETS.get(manifest.id, ""),
            )
        )

    # Ordered so the datasets the product actually uses come first, and the un-installed
    # optional one last. A panel listing GEBCO above the coastline would read as though
    # bathymetry mattered more than the coast.
    order = {dataset_id: index for index, dataset_id in enumerate(known_dataset_ids())}
    entries.sort(key=lambda entry: (not entry.usable, order.get(entry.id, 99)))

    return DatasetHealthResponse(
        datasets=tuple(entries),
        generated_at=datetime.now(UTC).replace(microsecond=0),
        usable_count=sum(1 for entry in entries if entry.usable),
        verified_count=sum(
            1 for entry in entries if entry.install_status == InstallStatus.READY.value
        ),
    )
