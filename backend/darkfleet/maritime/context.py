"""Reference-dataset readers. One authority each, provenance always attached.

WHAT THIS MODULE IS

Four thin readers over locally installed prepared payloads -- coastline, maritime
zones, ports, bathymetry -- plus the composition service that answers "where is this
target, in maritime terms". Every reader returns a value AND the
:class:`DatasetProvenance` that produced it, because a number without its source is an
assertion (§17).

WHAT THIS MODULE IS NOT

It is not a second spatial authority. Point-in-zone, nearest-point and distance all
delegate to :mod:`maritime.geometry`, which delegates distance to the correlation
authority's geodesic. If a reader computed its own distance it would eventually
disagree with correlation's, and an operator comparing the two readouts would have no
way to tell which is right (§24).

ABSENCE IS A FIRST-CLASS ANSWER

Every function takes the data directory and returns a typed result even when nothing is
installed. A missing GEBCO must not raise, and must not become 0 m (§39, §46). Each
result therefore carries a status: whether the dataset is installed, whether it covers
this point, and what the value is. Those are three separate questions and the type
keeps them apart.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .datasets import InstalledDataset, InstallStatus
from .geometry import (
    Distance,
    DistanceMethod,
    DistanceResult,
    LonLat,
    nearest_point,
    point_in_polygon,
    sample_polyline,
)
from .provenance import (
    DatasetProvenance,
    MaritimeZone,
    ZoneClassification,
)
from .store import load_prepared, require_usable


class ContextStatus(str, Enum):
    """Per-channel state. Deliberately finer than InstallStatus.

    A channel can fail for a reason that has nothing to do with installation, and an
    operator needs to know which: a dataset that is installed but has no data for the
    Pacific is a different problem from one that was never downloaded (§46).
    """

    #: A value was computed.
    AVAILABLE = "AVAILABLE"
    #: No copy on disk.
    NOT_INSTALLED = "NOT_INSTALLED"
    #: Installed and readable, but no data covers this point.
    NO_COVERAGE = "NO_COVERAGE"
    #: Present but corrupt, wrong version, or otherwise rejected by the integrity check.
    FAILED = "FAILED"
    #: The dataset cannot answer this question at all (e.g. zone semantics unavailable).
    NOT_ESTABLISHED = "NOT_ESTABLISHED"


@dataclass(frozen=True)
class ProbedResult:
    """A contextual answer plus its own completeness."""

    status: ContextStatus
    provenance: DatasetProvenance | None = None
    detail: str = ""

    @property
    def established(self) -> bool:
        return self.status is ContextStatus.AVAILABLE


# ===========================================================================
# Coastline
# ===========================================================================


class CoastDistance(BaseModel):
    """Distance from a point to the nearest coastline, with its method."""

    model_config = ConfigDict(extra="forbid")

    status: ContextStatus
    meters: float | None = None
    method: DistanceMethod = DistanceMethod.DENSIFIED_POINT_METER
    #: Coastline sample spacing used, so the reader can judge the precision.
    sample_spacing_m: float | None = None
    searched_radius_m: float | None = None
    feature_id: str | None = None
    provenance: DatasetProvenance | None = None
    detail: str = ""


def _lines_from_geojson(payload: dict[str, Any]) -> list[list[tuple[float, float]]]:
    """Flatten a GeoJSON FeatureCollection of lines into coordinate lists.

    Accepts LineString and MultiLineString. Anything else is ignored rather than
    coerced: a dataset that suddenly contains polygons is a preprocessing problem worth
    reporting, not something to guess at.
    """
    lines: list[list[tuple[float, float]]] = []

    def add(coords: Any) -> None:
        points = [(float(c[0]), float(c[1])) for c in coords if len(c) >= 2]
        if len(points) >= 2:
            lines.append(points)

    for feature in payload.get("features", []) or []:
        geometry = (feature or {}).get("geometry") or {}
        kind = geometry.get("type")
        coords = geometry.get("coordinates") or []
        if kind == "LineString":
            add(coords)
        elif kind == "MultiLineString":
            for part in coords:
                add(part)
    return lines


def coast_distance(
    data_dir: Path,
    lon: float,
    lat: float,
    *,
    sample_spacing_m: float = 5_000.0,
    max_radius_m: float = 300_000.0,
) -> CoastDistance:
    """Distance to the nearest coastline.

    Backend-only by design (§14, §23). The frontend displays this; it must not compute
    its own, because a hover readout and a dossier figure that disagree by a rounding
    difference are indistinguishable to an operator.
    """
    installed = require_usable(data_dir, "natural_earth_coastline")
    if installed is None:
        return CoastDistance(
            status=_absent_status(data_dir, "natural_earth_coastline"),
            searched_radius_m=max_radius_m,
            detail=_absent_detail(data_dir, "natural_earth_coastline"),
        )

    payload = load_prepared(data_dir, "natural_earth_coastline")
    lines = _lines_from_geojson(payload or {})
    if not lines:
        return CoastDistance(
            status=ContextStatus.NO_COVERAGE,
            provenance=installed.provenance(),
            detail="coastline payload contains no line geometry",
        )

    result: Distance = sample_polyline(
        LonLat(lon=lon, lat=lat),
        lines,
        step_m=sample_spacing_m,
        max_radius_m=max_radius_m,
        subject="COASTLINE",
    )
    if not result.measured:
        return CoastDistance(
            status=ContextStatus.NO_COVERAGE,
            method=result.method,
            sample_spacing_m=sample_spacing_m,
            searched_radius_m=result.searched_radius_m,
            provenance=installed.provenance(),
            detail=(
                "no coastline within the searched radius"
                if result.result is DistanceResult.OUT_OF_RANGE
                else result.result.value
            ),
        )
    return CoastDistance(
        status=ContextStatus.AVAILABLE,
        meters=result.meters,
        method=result.method,
        sample_spacing_m=sample_spacing_m,
        searched_radius_m=result.searched_radius_m,
        feature_id=result.feature_id,
        provenance=installed.provenance(),
    )


# ===========================================================================
# Maritime zones
# ===========================================================================


class ZoneFeature(BaseModel):
    """One prepared zone polygon, with the source's own attributes."""

    model_config = ConfigDict(extra="forbid")

    id: str
    #: Zone type as the SOURCE expresses it. Normalised to a MaritimeZone where that is
    #: unambiguous, but never invented where it is not.
    zone: MaritimeZone
    #: Sovereign / territory names EXACTLY as supplied. Never normalised, completed or
    #: reduced to one -- a dataset naming three claimants reports three (§19, §26).
    sovereign_names: tuple[str, ...] = ()
    #: The source's own note about overlap or dispute.
    dispute_note: str | None = None
    #: Exterior ring as (lon, lat); interior rings are ignored for containment, which
    #: means a hole would report the zone as present. Recorded as a preprocessing caveat.
    ring: tuple[tuple[float, float], ...]
    holes: tuple[tuple[tuple[float, float], ...], ...] = ()


class ZoneIndex(BaseModel):
    """The prepared zone payload."""

    model_config = ConfigDict(extra="forbid")

    features: tuple[ZoneFeature, ...] = ()
    #: Set by preprocessing when features were dropped or repaired, so a lossy ingestion
    #: is REPORTED rather than silently accepted (§22).
    preprocessing_notes: tuple[str, ...] = ()


def _point_in_ring(lon: float, lat: float, ring: Sequence[tuple[float, float]]) -> bool | None:
    """Ray casting against one ring, reusing the geometry authority.

    Delegates rather than reimplementing: a second containment test would eventually
    disagree with the first on an edge case, and "which of these two is right" is not a
    question an operator can answer (§23).
    """
    result: bool | None = point_in_polygon(lon, lat, [list(ring)])
    return result


def classify_zone(
    data_dir: Path, lon: float, lat: float
) -> ZoneClassification:
    """Which maritime zone a point falls in, per the installed dataset.

    THE HIGH-SEAS RULE, EXPLICITLY (§20)
    -------------------------------------
    A point is NOT high seas merely because no EEZ polygon contained it. Four
    conditions must ALL hold, and any one failing yields a different answer:

      1. the zone dataset is installed and readable      -> else NOT_ESTABLISHED
      2. the query is geometrically valid                -> else AMBIGUOUS
      3. no zone feature contains the point              -> else that zone
      4. a HIGH_SEAS feature set exists AND contains it  -> HIGH_SEAS
         otherwise                                       -> AMBIGUOUS

    Step 4 is the one that matters. Without an explicit high-seas polygon in the
    dataset, "inside no EEZ" is an INFERENCE about absence, and inferring HIGH_SEAS from
    a missing polygon is exactly how an unintegrated dataset silently becomes a legal
    claim. Absence yields AMBIGUOUS, which is a real answer and an honest one.
    """
    installed = require_usable(data_dir, "marine_regions_eez")
    if installed is None:
        return ZoneClassification(
            zone=MaritimeZone.NOT_ESTABLISHED,
            reason=f"zone dataset not usable: {_absent_detail(data_dir, 'marine_regions_eez')}",
            provenance=known_zone_provenance(data_dir),
        )

    payload = load_prepared(data_dir, "marine_regions_eez") or {}
    try:
        index = ZoneIndex.model_validate(payload)
    except ValueError as exc:
        return ZoneClassification(
            zone=MaritimeZone.AMBIGUOUS,
            reason=f"zone payload failed schema validation: {exc}"[:200],
            provenance=installed.provenance(),
        )

    if not index.features:
        return ZoneClassification(
            zone=MaritimeZone.NOT_ESTABLISHED,
            reason="zone payload contains no features",
            provenance=installed.provenance(),
        )

    inside: list[ZoneFeature] = []
    for feature in index.features:
        if _point_in_ring(lon, lat, feature.ring) is not True:
            continue
        # A point inside a hole is not inside the polygon.
        if any(_point_in_ring(lon, lat, list(hole)) is True for hole in feature.holes):
            continue
        inside.append(feature)

    if not inside:
        # Condition 4: high seas only if an explicit HIGH_SEAS polygon contains it.
        for feature in index.features:
            if feature.zone is not MaritimeZone.HIGH_SEAS:
                continue
            if _point_in_ring(lon, lat, feature.ring) is True:
                return ZoneClassification(
                    zone=MaritimeZone.HIGH_SEAS,
                    feature_id=feature.id,
                    sovereign_names=feature.sovereign_names,
                    dispute_note=feature.dispute_note,
                    provenance=installed.provenance(),
                )
        return ZoneClassification(
            zone=MaritimeZone.AMBIGUOUS,
            reason=(
                "no zone polygon contains this point and no HIGH_SEAS polygon is "
                "available to test against; absence of an EEZ is not evidence of high "
                "seas"
            ),
            provenance=installed.provenance(),
        )

    if len(inside) > 1:
        # Overlapping claims are a REAL condition in this dataset, not an error. The
        # point is reported as disputed with every claiming feature named.
        return ZoneClassification(
            zone=MaritimeZone.DISPUTED,
            feature_id=",".join(sorted(f.id for f in inside))[:200],
            sovereign_names=tuple(
                sorted({name for f in inside for name in f.sovereign_names})
            ),
            dispute_note=(
                f"point falls within {len(inside)} overlapping zone features: "
                + ", ".join(sorted(f.id for f in inside))[:200]
            ),
            provenance=installed.provenance(),
        )

    winner = inside[0]
    return ZoneClassification(
        zone=winner.zone,
        feature_id=winner.id,
        sovereign_names=winner.sovereign_names,
        dispute_note=winner.dispute_note,
        provenance=installed.provenance(),
    )


def known_zone_provenance(data_dir: Path) -> DatasetProvenance | None:
    """Provenance for a zone dataset even when unusable, so the UI can name it."""
    installed = require_usable(data_dir, "marine_regions_eez")
    if installed is not None:
        return installed.provenance()
    from .registry import known_manifest

    manifest = known_manifest("marine_regions_eez")
    if manifest is None:
        return None
    provenance: DatasetProvenance = _provenance_of(manifest)
    return provenance


def _provenance_of(manifest: Any) -> DatasetProvenance:
    provenance: DatasetProvenance = InstalledDataset(
        manifest=manifest, status=InstallStatus.NOT_INSTALLED
    ).provenance()
    return provenance


# ===========================================================================
# Ports
# ===========================================================================


class PortRecord(BaseModel):
    """One port, exposing only fields the source actually supplies."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    #: Exactly as the source words it. Not normalised to a country code.
    country: str | None = None
    lon: float
    lat: float
    harbor_type: str | None = None
    #: Free text as published, e.g. the harbour-size wording.
    harbor_size: str | None = None
    facilities: str | None = None


class PortIndex(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ports: tuple[PortRecord, ...] = ()
    preprocessing_notes: tuple[str, ...] = ()


class NearestPort(BaseModel):
    """Nearest port and the distance to it.

    Proximity establishes IDENTITY and DISTANCE, and nothing else. No field here says or
    implies a destination, an origin, an intent or a port call (§32).
    """

    model_config = ConfigDict(extra="forbid")

    status: ContextStatus
    port_id: str | None = None
    name: str | None = None
    country: str | None = None
    harbor_type: str | None = None
    harbor_size: str | None = None
    lon: float | None = None
    lat: float | None = None
    meters: float | None = None
    method: DistanceMethod = DistanceMethod.GEODESIC_METER
    searched_radius_m: float | None = None
    provenance: DatasetProvenance | None = None
    #: Stated on every result so the reading cannot be over-read.
    interpretation: str = "PROXIMITY IS CONTEXT ONLY — not a destination, origin, intent or port call."
    detail: str = ""


def nearest_port(
    data_dir: Path, lon: float, lat: float, *, max_radius_m: float = 400_000.0
) -> NearestPort:
    """Nearest port by true geodesic distance.

    Delegates to the shared :func:`nearest_point`, so the prefilter that bit the earlier
    `_M_PER_DEG_LAT` work applies here too -- and is covered by tests around the
    threshold rather than assumed (§31).
    """
    installed = require_usable(data_dir, "nga_world_port_index")
    if installed is None:
        return NearestPort(
            status=_absent_status(data_dir, "nga_world_port_index"),
            searched_radius_m=max_radius_m,
            detail=_absent_detail(data_dir, "nga_world_port_index"),
        )

    payload = load_prepared(data_dir, "nga_world_port_index") or {}
    try:
        index = PortIndex.model_validate(payload)
    except ValueError as exc:
        return NearestPort(
            status=ContextStatus.FAILED,
            provenance=installed.provenance(),
            detail=f"port payload failed schema validation: {exc}"[:200],
        )

    if not index.ports:
        return NearestPort(
            status=ContextStatus.NO_COVERAGE,
            provenance=installed.provenance(),
            detail="port payload contains no ports",
        )

    candidates = [(p.id, p.lon, p.lat, p) for p in index.ports]
    result = nearest_point(
        LonLat(lon=lon, lat=lat), candidates, subject="PORT", max_radius_m=max_radius_m
    )
    if not result.measured:
        return NearestPort(
            status=ContextStatus.NO_COVERAGE,
            searched_radius_m=result.searched_radius_m,
            provenance=installed.provenance(),
            detail="no port within the searched radius",
        )

    # The winning payload is re-found by id rather than carried through, because
    # nearest_point deliberately unwraps longitudes and the returned record must hold
    # the source's own coordinates.
    winner = next(p for p in index.ports if p.id == result.feature_id)
    return NearestPort(
        status=ContextStatus.AVAILABLE,
        port_id=winner.id,
        name=winner.name,
        country=winner.country,
        harbor_type=winner.harbor_type,
        harbor_size=winner.harbor_size,
        lon=winner.lon,
        lat=winner.lat,
        meters=result.meters,
        method=result.method,
        searched_radius_m=result.searched_radius_m,
        provenance=installed.provenance(),
    )


# ===========================================================================
# Bathymetry
# ===========================================================================


class GridCell(BaseModel):
    """No-data sentinel for a prepared grid.

    A depth of 0 m over the ocean is a measurement, not a missing value, so the absence
    of data needs its own representation. Rendering it as `0 m` would be a fabricated
    sounding (§39).
    """

    model_config = ConfigDict(extra="forbid")

    value: float | None = None
    #: The grid cell carries no value (land, or outside the source's coverage).
    no_data: bool = False


class PreparedGrid(BaseModel):
    """A regular lon/lat grid with an explicit origin and cell size.

    Pixel-centre registration is recorded because GEBCO_2025 is pixel-centre registered;
    sampling a corner instead of a centre would be a half-cell bias, and a half-cell of
    15 arc-seconds is ~460 m.
    """

    model_config = ConfigDict(extra="forbid")

    #: Longitude of the FIRST cell's CENTRE.
    origin_lon: float
    origin_lat: float
    #: Cell size in degrees. Negative step_lat means the grid runs north to south.
    step_lon: float
    step_lat: float
    n_cols: int = Field(gt=0)
    n_rows: int = Field(gt=0)
    #: Row-major, north to south.
    values: tuple[float | None, ...]
    #: GEBCO type-identifier style source-quality codes, when the installed product
    #: supplies them. Never invented (§40).
    source_types: tuple[str | None, ...] | None = None
    preprocessing_notes: tuple[str, ...] = ()


class DepthSample(BaseModel):
    """A depth reading with everything needed to judge it."""

    model_config = ConfigDict(extra="forbid")

    status: ContextStatus
    #: Metres, NEGATIVE below sea level, following GEBCO's sign convention. A sounding
    #: reported positive would invert the meaning of the sea.
    meters: float | None = None
    lon: float | None = None
    lat: float | None = None
    #: The grid's angular resolution, so the reader can see the real precision.
    resolution_deg: float | None = None
    #: The dataset's own source-quality code, when present. Never synthesised.
    source_type: str | None = None
    provenance: DatasetProvenance | None = None
    detail: str = ""


def sample_bathymetry(data_dir: Path, lon: float, lat: float) -> DepthSample:
    """Depth at a point, from the installed prepared grid.

    Precision is bounded by the grid: a 15 arc-second cell is about 460 m, so a value is
    reported to whole metres and the resolution is carried alongside. Reporting
    centimetre precision from a global reference grid would be a fabricated sounding
    (§38).
    """
    installed = require_usable(data_dir, "gebco_2025")
    if installed is None:
        return DepthSample(
            status=_absent_status(data_dir, "gebco_2025"),
            detail=_absent_detail(data_dir, "gebco_2025"),
        )

    payload = load_prepared(data_dir, "gebco_2025") or {}
    try:
        grid = PreparedGrid.model_validate(payload)
    except ValueError as exc:
        return DepthSample(
            status=ContextStatus.FAILED,
            provenance=installed.provenance(),
            detail=f"grid payload failed schema validation: {exc}"[:200],
        )

    expected = grid.n_cols * grid.n_rows
    if len(grid.values) != expected:
        return DepthSample(
            status=ContextStatus.FAILED,
            provenance=installed.provenance(),
            detail=(
                f"grid declares {grid.n_cols}x{grid.n_rows} = {expected} cells but carries "
                f"{len(grid.values)}"
            ),
        )

    col = round((unwrap_grid_lon(lon) - grid.origin_lon) / grid.step_lon)
    row = round((lat - grid.origin_lat) / grid.step_lat)
    if not (0 <= col < grid.n_cols and 0 <= row < grid.n_rows):
        return DepthSample(
            status=ContextStatus.NO_COVERAGE,
            lon=lon,
            lat=lat,
            resolution_deg=abs(grid.step_lat),
            provenance=installed.provenance(),
            detail="point lies outside the installed grid extent",
        )

    index = row * grid.n_cols + col
    value = grid.values[index]
    source_type = (
        grid.source_types[index]
        if grid.source_types is not None and index < len(grid.source_types)
        else None
    )
    if value is None:
        return DepthSample(
            status=ContextStatus.NO_COVERAGE,
            lon=lon,
            lat=lat,
            resolution_deg=abs(grid.step_lat),
            source_type=source_type,
            provenance=installed.provenance(),
            detail="grid cell carries no value",
        )

    return DepthSample(
        status=ContextStatus.AVAILABLE,
        # Whole metres: the grid cannot support more, and trailing digits would imply a
        # precision the dataset does not have.
        meters=round(float(value)),
        lon=lon,
        lat=lat,
        resolution_deg=abs(grid.step_lat),
        source_type=source_type,
        provenance=installed.provenance(),
    )


def unwrap_grid_lon(lon: float) -> float:
    """Fold a longitude into the grid's own 0..360 space if it uses that convention.

    Only the 360-degree form is supported, and only as an explicit choice at
    preprocessing time. Guessing which convention a grid uses would shift every sample
    by 180 degrees of longitude -- the Gulf of Guinea for a North Atlantic grid.
    """
    wrapped = (lon + 180.0) % 360.0 - 180.0
    return wrapped


# ===========================================================================
# Absence helpers
# ===========================================================================


def _absent_status(data_dir: Path, dataset_id: str) -> ContextStatus:
    """NOT_INSTALLED for absence, FAILED for corruption.

    The distinction matters operationally: one needs a download, the other needs
    attention. Reporting a corrupt dataset as merely absent would send an operator to
    re-download a file that is already there and still broken.
    """
    from .store import status_of

    state = status_of(data_dir, dataset_id).status
    if state in (InstallStatus.CHECKSUM_MISMATCH, InstallStatus.INVALID,
                 InstallStatus.VERSION_UNKNOWN):
        return ContextStatus.FAILED
    return ContextStatus.NOT_INSTALLED


def _absent_detail(data_dir: Path, dataset_id: str) -> str:
    from .store import status_of

    return status_of(data_dir, dataset_id).detail