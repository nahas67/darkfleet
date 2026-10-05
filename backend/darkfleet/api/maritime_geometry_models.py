"""The display-geometry and dataset-health contracts.

TWO SEPARATE SURFACES, DELIBERATELY
-----------------------------------
    /api/maritime/layers   what the globe DRAWS
    /api/maritime/datasets what an operator needs to know about the local data

They are different questions with different failure modes. Geometry missing must not look
like health missing, and health is needed when no target is selected while geometry is
only ever needed once the globe is up.

DISPLAY GEOMETRY IS NOT ANALYTICAL GEOMETRY
-------------------------------------------
The payload carries :class:`DisplayGeometryMeta` with the simplification tolerance and
the before/after vertex counts on EVERY response. An operator -- or a later reviewer --
can therefore see that the drawing is a simplification of a named dataset version rather
than the dataset itself, which is what stops "the map shows" from being read as "the data
says".

The backend's distance and zone authority reads the FULL prepared geometry and is
untouched by anything here.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from darkfleet.api.maritime_models import SourceRef, StrictModel
from darkfleet.maritime.provenance import MaritimeZone

#: Layers the globe can actually draw. ``PORTS`` and ``BATHYMETRY`` are deliberately
#: absent: with no WPI snapshot and no GEBCO grid there is nothing to draw, and a
#: declared-but-empty layer is the inert toggle the product forbids.
DISPLAY_LAYERS = ("REFERENCE_COASTLINE", "EEZ_BOUNDARIES", "HIGH_SEAS")


class DisplayGeometryMeta(StrictModel):
    """How this geometry was produced, stated on every response."""

    #: Degrees of simplification tolerance. Non-zero means the drawing is NOT the data.
    tolerance_deg: float
    #: Vertices in the installed prepared payload.
    source_vertex_count: int
    #: Vertices actually served.
    vertex_count: int
    #: Parts (rings / lines) served. Multi-part features keep all their parts.
    part_count: int
    #: Interior rings served. Never collapsed.
    hole_count: int
    #: Whether any part was left out by a viewport filter, so a partial draw is never
    #: mistaken for the whole world.
    viewport_filtered: bool = False
    #: Plain statement of what this is, carried in the body so it survives a screenshot
    #: or an export that drops the UI chrome.
    notice: str = (
        "DISPLAY GEOMETRY - simplified for rendering. The backend's distance and zone "
        "authority reads the full installed geometry and is unaffected."
    )


class DisplayLine(StrictModel):
    """One coastline part as a polyline: a (lon, lat) run."""

    coordinates: tuple[tuple[float, float], ...]


class DisplayPolygon(StrictModel):
    """One zone feature.

    Multi-part: ``parts`` holds EVERY exterior ring of the feature, so a mainland block
    plus detached island blocks is one feature with several parts rather than several
    truncated features. ``holes`` holds interior rings, also all of them.
    """

    #: Feature id exactly as the dataset writes it.
    id: str
    #: Zone type, normalised from the source's own ``pol_type``.
    zone: MaritimeZone | None = None
    #: The source's ``pol_type`` verbatim, e.g. ``200NM``. Preserved because '200NM'
    #: versus '12NM' is the difference between an EEZ and a territorial sea.
    pol_type: str | None = None
    geoname: str | None = None
    #: Every name the source gives, never reduced to one.
    sovereign_names: tuple[str, ...] = ()
    territory_names: tuple[str, ...] = ()
    #: The source's own overlap / joint-regime note, when it has one.
    dispute_note: str | None = None
    #: True when the SOURCE records more than one claimant or a joint regime.
    disputed: bool = False
    parts: tuple[DisplayLine, ...]
    holes: tuple[DisplayLine, ...] = ()


class CoastlineGeometryResponse(StrictModel):
    """`GET /api/maritime/layers/REFERENCE_COASTLINE`.

    ALWAYS 200, with ``status`` carrying the state.

    A layer whose dataset is absent and a layer whose viewport legitimately contains no
    coastline both produce an empty ``lines`` array, so the array alone cannot tell them
    apart. Rather than return a union -- which would push "which shape is this?" into
    every client and defeat the generated contract -- ``status`` and ``detail`` are
    fields of the one strict model. A renderer reads ``status`` first.
    """

    layer: str
    #: AVAILABLE / NOT_INSTALLED / CHECKSUM_UNRECORDED / CHECKSUM_MISMATCH / INVALID /
    #: VERSION_UNKNOWN. Read this before reading ``lines``.
    status: str
    #: Why, when not AVAILABLE.
    detail: str = ""
    #: The coastline is REFERENCE data, not evidence about any vessel.
    evidentiary: str = "REFERENCE"
    #: Natural Earth 4.1.0. Public domain, and the version on disk.
    provenance: SourceRef | None = None
    lines: tuple[DisplayLine, ...] = ()
    meta: DisplayGeometryMeta
    #: Bounding box of what was served, so a caller can tell a viewport-filtered payload
    #: from the full world without reading every vertex.
    bbox: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)


class ZoneGeometryResponse(StrictModel):
    """`GET /api/maritime/layers/EEZ_BOUNDARIES` or `.../HIGH_SEAS`.

    Same single-shape decision as the coastline layer: ``status`` is a field rather than a
    second response model, so the generated contract describes one thing and a client
    cannot receive a shape it was not generated for.
    """

    layer: str
    #: Read before ``polygons``: NOT_INSTALLED and a viewport with no features both give
    #: an empty tuple.
    status: str
    detail: str = ""
    evidentiary: str = "REFERENCE"
    provenance: SourceRef | None = None
    polygons: tuple[DisplayPolygon, ...] = ()
    meta: DisplayGeometryMeta
    bbox: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    #: How many features the installed payload holds in total, so a viewport-filtered
    #: response is visibly partial.
    total_feature_count: int = 0
    #: Features the viewport excluded.
    filtered_feature_count: int = 0


class DatasetHealthEntry(StrictModel):
    """One local reference dataset's state on THIS machine.

    THREE SEPARATE AXES, DELIBERATELY NOT MERGED
    -------------------------------------------
    ``install_status``   what is on disk
    ``usable``           whether a query may read it
    ``blocker_reason``   why it is absent, when it is

    A panel that showed one merged word would have to say either "OK" for a dataset with
    no publisher checksum recorded, or "unverified" for one that answers correctly. Both
    are wrong. ``blocker_reason`` is separate again because NOT_INSTALLED is the normal
    state for an optional dataset and is NOT a fault -- while for the World Port Index it
    IS a recorded external blocker.
    """

    id: str
    label: str
    install_status: str
    usable: bool
    #: Present when the dataset cannot be obtained as configured. Distinct from an
    #: optional dataset that simply has not been installed.
    blocker_reason: str | None = None
    #: True for a dataset whose absence is a deliberate choice rather than a fault.
    optional: bool = False

    provider: str
    dataset: str
    version: str
    #: False for a service snapshot whose version the service never established. The UI
    #: must not print a version number in that case.
    version_established: bool = True
    release_date: str | None = None
    retrieved_at: str | None = None
    license: str
    attribution: str
    identifier: str | None = None
    #: How it was obtained: STATIC_DOWNLOAD / WFS / ARCGIS_FEATURE_SERVICE.
    source_mechanism: str = "STATIC_DOWNLOAD"
    source_service: str | None = None
    source_layer: str | None = None
    #: The service's own feature count at install time, when it reported one.
    source_feature_count: int | None = None

    installed_at: str | None = None
    #: Digest of the payload as found on disk.
    computed_sha256: str | None = None
    #: Digest the PUBLISHER published, when one exists. Absent for service snapshots,
    #: which is why ``CHECKSUM_UNRECORDED`` is a real state rather than a bug.
    expected_sha256: str | None = None

    coverage_note: str = ""
    terms_notes: str = ""
    limitations: tuple[str, ...] = ()
    detail: str = ""


class DatasetHealthResponse(StrictModel):
    """`GET /api/maritime/datasets`.

    Deliberately NOT part of ``/api/providers/health``. Those are remote HTTP sources with
    a live-uptime meaning; these are files on this disk. Merging them would let a healthy
    basemap imply healthy reference data, or a failed provider imply the local coastline
    is broken.
    """

    datasets: tuple[DatasetHealthEntry, ...]
    generated_at: datetime
    #: Datasets actually usable right now.
    usable_count: int = Field(ge=0)
    #: Of those, how many are ``READY`` rather than merely ``CHECKSUM_UNRECORDED``.
    verified_count: int = Field(ge=0)
