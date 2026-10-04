"""Typed request/response contracts for the DarkFleet HTTP API (API-011).

Every field the API accepts or returns is declared here once. The frontend
mirrors these shapes; it never re-derives them, and this module never
re-implements pipeline logic -- evidence and provenance bodies are passed
through verbatim from :mod:`darkfleet.evidence` and
:func:`darkfleet.pipeline.run_scan`, so the domain modules stay the single
authority on what a scan *is*.

Two rules encoded in the contracts:

* ``runtime_mode`` and ``synthetic`` travel together on every scan-bearing
  response. A caller must never have to guess which world a payload came from
  (OPS-014).
* Error bodies carry a ``status`` string. For provider failures it is a
  :class:`darkfleet.providers.ProviderStatus` value; for other rejections it is
  a ``REASON_*`` code listed on :class:`ApiError`.
"""

from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Final, Literal

import numpy as np
from pydantic import (
    AfterValidator,
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    model_validator,
)

from darkfleet.jobs.models import ScanStage

from ..providers import ProviderStatus
from .evidence_models import EvidenceDocument, ScanRecordDocument
from .targets import AisOnlyTarget, ScanScene, VesselTarget

__all__ = [
    "ApiError",
    "BBox",
    "DebugLayerResponse",
    "EvidenceDocument",
    "EvidenceDocumentResponse",
    "ExportFormatNotImplemented",
    "HealthResponse",
    "LayerStats",
    "NotFoundError",
    "ProviderHealthEntry",
    "RuntimeModeLiteral",
    "ScanAccepted",
    "ScanCreateRequest",
    "ScanRecordDocument",
    "ScanStateResponse",
    "ScanTargetsResponse",
    "SceneListResponse",
    "SceneSummary",
    "StageEventOut",
    "TargetEvidenceResponse",
    "TargetSummaryResponse",
    "jsonable",
]

#: The only runtime mode a scan can have. See :class:`darkfleet.jobs.models.RuntimeMode`.
RuntimeModeLiteral = Literal["REAL"]

#: Export formats served today. PNG and PDF are rendered server-side from the
#: persisted record, so an exported artefact carries the same provenance as the
#: API response instead of being a browser screenshot.
SUPPORTED_EXPORT_FORMATS: Final[tuple[str, ...]] = ("geojson", "kml", "json", "png", "pdf")

#: Export formats that are known but not implemented yet (answered with 501).
DEFERRED_EXPORT_FORMATS: Final[tuple[str, ...]] = ()


def _validate_bbox(values: list[float]) -> list[float]:
    """A bbox is ``[min_lon, min_lat, max_lon, max_lat]`` in degrees.

    Rejects anything a scan could not honour: non-finite values, wrong arity,
    out-of-range coordinates, or an inverted box. Raises ``ValueError`` so
    FastAPI answers 422 rather than letting a nonsense AOI reach the pipeline.
    """
    if len(values) != 4:
        raise ValueError(f"bbox must hold exactly 4 values, got {len(values)}")
    for value in values:
        if not math.isfinite(value):
            raise ValueError(f"bbox values must be finite, got {value!r}")
    min_lon, min_lat, max_lon, max_lat = values
    if not -180.0 <= min_lon <= 180.0 or not -180.0 <= max_lon <= 180.0:
        raise ValueError(f"longitude must be within [-180, 180], got {min_lon}..{max_lon}")
    if not -90.0 <= min_lat <= 90.0 or not -90.0 <= max_lat <= 90.0:
        raise ValueError(f"latitude must be within [-90, 90], got {min_lat}..{max_lat}")
    if min_lon >= max_lon:
        raise ValueError(f"bbox min_lon must be < max_lon, got {min_lon} >= {max_lon}")
    if min_lat >= max_lat:
        raise ValueError(f"bbox min_lat must be < max_lat, got {min_lat} >= {max_lat}")
    return values


#: Validated ``[min_lon, min_lat, max_lon, max_lat]`` list.
BBox = Annotated[
    list[float],
    Field(
        min_length=4,
        max_length=4,
        description="[min_lon, min_lat, max_lon, max_lat] in decimal degrees",
    ),
    AfterValidator(_validate_bbox),
]


def jsonable(value: Any) -> Any:
    """Recursively convert numpy / datetime / path values into JSON-native ones.

    FastAPI's encoder stringifies anything it does not recognise, so an
    unconverted ``np.float64`` would silently become the text ``"1.25"`` in a
    response. This keeps numbers numbers.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, np.generic):
        return jsonable(value.item())
    if isinstance(value, np.ndarray):
        return jsonable(value.tolist())
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, ScanStage):
        return value.value
    return str(value)


# --------------------------------------------------------------- requests


class CfarConfig(BaseModel):
    """CA-CFAR / speckle overrides for ``POST /api/scans``.

    This was ``dict[str, Any]``, which is how two separate failures survived a
    green test suite:

    1. **Wrong casing was silently ignored.** The interface emits camelCase
       (``trainingCells``); the pipeline subscripts snake_case
       (``training_cells``). Nothing rejected the mismatch, so the overrides were
       dropped and the detector ran on defaults while the interface reported a
       pending recompute.
    2. **Any partial payload destroyed the run.** The pipeline replaced its
       defaults rather than merging, so omitting a key raised ``KeyError``
       mid-scan.

    Declaring the fields fixes both. CamelCase is accepted as an explicit
    validation alias, so the existing interface keeps working *and* now genuinely
    reaches the detector; ``extra="forbid"`` turns a typo or a stale key name
    into a loud 422 instead of a silent no-op; and the bounds below are the ones
    the interface advertises, so "the controls match the backend" becomes a
    claim a test can check instead of a claim nobody checks.

    Every field is optional. Unset keys keep the pipeline default, which
    :func:`darkfleet.pipeline.merge_cfar_config` now actually implements.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    training_cells: int | None = Field(
        default=None,
        ge=8,
        le=32,
        validation_alias=AliasChoices("trainingCells", "training_cells"),
        serialization_alias="trainingCells",
        description="N_train: reference ring width in cells.",
    )
    guard_cells: int | None = Field(
        default=None,
        ge=2,
        le=8,
        validation_alias=AliasChoices("guardCells", "guard_cells"),
        serialization_alias="guardCells",
        description="N_guard: inner guard ring width in cells.",
    )
    threshold_factor: float | None = Field(
        default=None,
        ge=2.0,
        le=5.5,
        validation_alias=AliasChoices("thresholdFactor", "threshold_factor"),
        serialization_alias="thresholdFactor",
        description="Multiplier on the background estimate (P_fa control).",
    )
    min_pixels: int | None = Field(
        default=None,
        ge=1,
        le=50,
        validation_alias=AliasChoices("minPixels", "min_pixels"),
        serialization_alias="minPixels",
        description="Smallest connected component kept as a candidate target, in pixels.",
    )
    max_pixels: int | None = Field(
        default=None,
        ge=100,
        le=5000,
        validation_alias=AliasChoices("maxPixels", "max_pixels"),
        serialization_alias="maxPixels",
        description="Largest component kept; anything larger is treated as a structure.",
    )
    speckle_filter: Literal["none", "median", "lee"] | None = Field(
        default=None,
        validation_alias=AliasChoices("speckleFilter", "speckle_filter"),
        serialization_alias="speckleFilter",
        description="Pre-detection speckle filter.",
    )
    kernel_size: int | None = Field(
        default=None,
        ge=3,
        le=7,
        validation_alias=AliasChoices("kernelSize", "kernel_size"),
        serialization_alias="kernelSize",
        description="Speckle kernel side.",
    )
    coastline_buffer_meters: int | None = Field(
        default=None,
        ge=50,
        le=500,
        validation_alias=AliasChoices("coastlineBufferMeters", "coastline_buffer_meters"),
        serialization_alias="coastlineBufferMeters",
        description="Coastline exclusion distance in metres.",
    )

    def overrides(self) -> dict[str, Any]:
        """Only the keys the caller actually set, in pipeline (snake) form.

        Returning ``None`` for unset fields is the point: the pipeline merges
        these over its defaults, so an omitted key stays omitted rather than
        becoming an explicit ``None`` that would fail a numeric subscript.
        """
        return {
            name: value
            for name, value in self.model_dump(by_alias=False, exclude_none=True).items()
        }


class ScanCreateRequest(BaseModel):
    """Body of ``POST /api/scans``.

    There is no ``runtime_mode``. Every scan is a REAL scan against a live
    provider: a client cannot ask this API for fabricated observations.
    """

    model_config = ConfigDict(extra="forbid")

    bbox: BBox
    datetime_range: str | None = Field(
        default=None,
        description="STAC datetime interval, e.g. '2026-01-01T00:00:00Z/2026-01-31T00:00:00Z'.",
    )
    scene_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("sceneId", "scene_id"),
        serialization_alias="sceneId",
        description=(
            "Pin one catalogue acquisition by item id. The match is exact: an id "
            "that does not intersect this area fails the scan rather than "
            "silently processing whatever scene happened to come back."
        ),
    )
    provider: str = Field(default="planetary-computer")
    product: Literal["rtc", "grd"] = "rtc"
    cfar_config: CfarConfig | None = Field(
        default=None,
        description="Overrides for the CA-CFAR/speckle configuration; unset keys keep pipeline defaults.",
    )


# -------------------------------------------------------------- responses


class ScanAccepted(BaseModel):
    """202 body: the job exists and is queued. Work happens in the background."""

    scan_id: str
    status: str = Field(description="ScanStage the job was accepted in (always QUEUED).")
    runtime_mode: RuntimeModeLiteral
    synthetic: bool


class StageEventOut(BaseModel):
    """One real stage transition as recorded by the runner.

    ``stage`` is typed as the enum rather than as ``str`` so the generated
    contract carries the real stage list. As a bare ``str`` it serialised to
    ``{"type": "string"}``, the frontend had to hand-maintain the union, and
    adding a stage silently produced a value the UI could not type -- which is
    exactly what happened when GEO-CORR added GEOLOCATING.
    """

    stage: ScanStage
    timestamp: datetime
    detail: str
    terminal: bool


class ScanStateResponse(BaseModel):
    """``GET /api/scans/{id}``: current state plus the full transition history."""

    scan_id: str
    stage: ScanStage
    terminal: bool
    runtime_mode: str
    synthetic: bool
    known: bool = Field(description="False when the record was recovered from disk only.")
    source: Literal["runner", "run_store"] = "runner"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    failed_at: ScanStage | None = Field(
        default=None, description="Pipeline stage that was in flight when the job failed."
    )
    error: str | None = None
    history: list[StageEventOut] = Field(default_factory=list)
    record_persisted: bool = False


class ScanTargetsResponse(BaseModel):
    """``GET /api/scans/{id}/targets`` for a completed scan.

    ``extra="forbid"`` is deliberate and matches ``src/api/validate.ts``, which
    rejects an unrecognised top-level key. If the server allowed extras while the
    browser refused them, an ordinary additive backend change would break every
    client at runtime with a message neither side authored. Forbidding here means
    the drift is caught at the boundary where it was introduced.
    """

    model_config = ConfigDict(extra="forbid")

    scan_id: str
    stage: str
    runtime_mode: str
    synthetic: bool
    #: The extent this scan covered. Needed by any surface that has to describe
    #: the same water (acquisition planning, exports), so it travels with the
    #: targets rather than requiring a second request. Required: the record
    #: always holds it, and an absent AOI would leave the map with nothing to frame.
    aoi: list[float]
    count: int
    ais_only_count: int
    #: Required, not defaulted. The route always sends these four, and `count` and
    #: `ais_only_count` are already required -- leaving the collections optional
    #: would make the schema claim a response can omit the very arrays its own
    #: count fields describe. It would also make the generated TypeScript mark
    #: them optional, pushing every consumer into defensive `?? []` code.
    counts: dict[str, int]
    #: IR1/Checkpoint B: these were ``list[dict[str, Any]]``, so FastAPI validated
    #: nothing inside a detection and a backend rename surfaced in the browser as
    #: ``undefined``. They are now real models, and the frontend is generated from
    #: the resulting OpenAPI schema rather than restating them by hand.
    targets: list[VesselTarget]
    ais_only: list[AisOnlyTarget]
    provenance: dict[str, Any] = Field(default_factory=dict)
    #: Source scene and acquisition instant. Both are already in the persisted
    #: record; they are exposed here because the evidence inspector and the
    #: timeline both need them, and without them the client would have to guess
    #: or fetch a second time. Typed, not ``dict[str, Any]``: the timeline reads
    #: ``scene.item_id`` and ``scene.polarization``, which cannot be done safely
    #: against an untyped object.
    scene: ScanScene | None = None
    acquisition_time: str | None = None


class SceneSummary(BaseModel):
    """One candidate scene. ``synthetic`` is an invariant, always ``False``."""

    id: str
    provider: str
    platform: str
    product: str
    polarization: str
    acquisition_time: str
    bbox: list[float]
    resolution_meters: float | None = None
    georeferencing: str | None = None
    sea_clutter_level: str | None = None
    runtime_mode: RuntimeModeLiteral
    synthetic: bool


class SceneListResponse(BaseModel):
    """``GET /api/scenes``. Proxies the provider; there is no local catalogue."""

    runtime_mode: RuntimeModeLiteral
    synthetic: bool
    provider: str
    status: ProviderStatus = Field(description="ProviderStatus value for the probe behind these scenes.")
    note: str | None = None
    count: int
    scenes: list[SceneSummary] = Field(default_factory=list)


class ProviderHealthEntry(BaseModel):
    """One provider's live probe result. Never carries a credential."""

    provider: str
    status: ProviderStatus = Field(description="ProviderStatus value.")
    detail: str
    last_check: datetime
    latency_ms: float | None = None
    error: str | None = None
    capabilities: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """``GET /api/providers/health``: one live probe per provider."""

    checked_at: datetime
    runtime_mode: str
    probe: str = Field(default="live", description="Always 'live': statuses come from real requests.")
    providers: list[ProviderHealthEntry] = Field(default_factory=list)


# =====================================================================
# TARGET SUMMARY (DF-X7V section 42)
#
# `/targets/{id}/summary` returned `dict[str, Any]`. A route with no response
# model generates no OpenAPI schema, no TypeScript type and no validator keys, so
# the frontend could not have detected a change in this response even if it wanted
# to. These models exist so that route has a checkable contract.
#
# The envelope is strict (`extra="forbid"`) because its shape is entirely ours.
# `evidence` is the shared evidence document and is strict too: it is declared
# in :mod:`darkfleet.api.evidence_models`, which enumerates every key
# :func:`darkfleet.evidence.target_evidence` emits.
# =====================================================================


class NarrativeModelIdentity(BaseModel):
    """Which writer produced the narrative. Never omitted."""

    model_config = ConfigDict(extra="forbid")

    model_id: str
    provider: str
    template_version: str


class NarrativeProvenance(BaseModel):
    """Whether the narrative required network calls.

    `network_calls` is asserted rather than trusted: a deterministic template
    writer must report zero, and a payload claiming otherwise is stating that a
    network dependency exists in the path.
    """

    model_config = ConfigDict(extra="forbid")

    writer: str
    network_calls: int = Field(ge=0)


class NarrativeDocument(BaseModel):
    """A validated narrative. Present only when `status` is OK."""

    model_config = ConfigDict(extra="forbid")

    target_id: str
    observed: list[str]
    hypotheses: list[str]
    unknowns: list[str]
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    summary: str
    model: NarrativeModelIdentity
    provenance: NarrativeProvenance


class NarrativeEnvelope(BaseModel):
    """Either a narrative or an explicit refusal.

    The refusal is a first-class variant, not an error string. A caller must be
    able to render the deterministic evidence either way, which means it must be
    able to tell the two apart without reading prose.
    """

    model_config = ConfigDict(extra="forbid")

    status: Literal["OK", "AI_UNAVAILABLE"]
    document: NarrativeDocument | None = None
    #: Why no narrative was produced. Populated when status is AI_UNAVAILABLE.
    reason: str | None = None

    @model_validator(mode="after")
    def _variant_is_coherent(self) -> NarrativeEnvelope:
        """A refusal must carry a reason, and a success must carry a document.

        Without this, `AI_UNAVAILABLE` with no reason and `OK` with no document are
        both representable, and a consumer has no way to tell a truncated payload
        from an intentional one.
        """
        if self.status == "OK" and self.document is None:
            raise ValueError("status OK requires a document")
        if self.status == "AI_UNAVAILABLE":
            if not self.reason:
                raise ValueError("status AI_UNAVAILABLE requires a reason")
            if self.document is not None:
                raise ValueError("status AI_UNAVAILABLE must not carry a document")
        return self


class TargetSummaryResponse(BaseModel):
    """``GET /api/targets/{id}/summary``: evidence plus optional narrative.

    `classification` is nullable because a stored target may predate the field; it
    is not nullable to hide a missing classification, and `evidence.classification`
    carries the authoritative value when this is null.

    `evidence` is the same declared document `/targets/{id}` serves, so the two
    routes can no longer drift apart in a way only a reader would notice.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    scan_id: str
    target_id: str
    classification: str | None = None
    ambiguous: bool = Field(
        description="True when this target id exists in more than one stored scan."
    )
    evidence: EvidenceDocument
    narrative: NarrativeEnvelope


class TargetEvidenceResponse(BaseModel):
    """``GET /api/targets/{id}``: the target's evidence slice, fully declared."""

    scan_id: str
    runtime_mode: str
    synthetic: bool
    ambiguous: bool = Field(
        description="True when the target id exists in more than one stored scan."
    )
    candidate_scan_ids: list[str] = Field(default_factory=list)
    #: Typed rather than ``dict[str, Any]``. This is the document a UI is about
    #: to render as the authoritative analytical record, and an untyped dict
    #: cannot be validated -- so a field rename or a missing block would be
    #: silently invisible, which is the same defect class as a stale golden.
    evidence: EvidenceDocument


class EvidenceDocumentResponse(BaseModel):
    """``GET /api/evidence/{target_id}``: the owning scan's whole record.

    Despite the name, this route does NOT serve the per-target evidence
    document: it serves the persisted record of the scan that owns the target,
    which is why ``evidence.targets`` and ``evidence.config`` exist on it.
    :class:`~darkfleet.api.evidence_models.ScanRecordDocument` types that shape
    separately so the distinction is declared rather than assumed.
    """

    scan_id: str
    runtime_mode: str
    synthetic: bool
    ambiguous: bool
    candidate_scan_ids: list[str] = Field(default_factory=list)
    evidence: ScanRecordDocument


class LayerStats(BaseModel):
    """Compact statistics for a debug layer. Never the full array."""

    size: int
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    std: float | None = None
    p01: float | None = None
    p50: float | None = None
    p99: float | None = None
    nan_count: int = 0
    finite_fraction: float = 0.0
    true_count: int | None = Field(
        default=None, description="Set for boolean layers: number of True pixels."
    )


class DebugLayerResponse(BaseModel):
    """``GET /api/debug/{scan_id}/{layer}``: a summary, not a blob.

    Two payload shapes, one per ``kind``:

    ``array``
        Statistics over the whole grid plus an optional block-mean ``grid`` for
        display. The full raster is never serialised.

    ``table``
        ``columns`` names the fields, ``data`` carries the rows. ``rows`` is the
        TOTAL row count, ``row_limit`` is how many were returned, and
        ``truncated`` says whether the window dropped any.

        The ``data`` field is the important one. This model used to describe a
        table by naming its columns and counting its rows while returning no rows
        at all, which made ``kind="table"``, ``limit``, ``row_limit`` and
        ``truncated`` four promises the payload did not keep -- a caller could
        confirm a layer existed and learn nothing about its contents. ``limit``
        now genuinely bounds the window and the counts describe it honestly.
    """

    scan_id: str
    layer: str
    kind: Literal["array", "table"]
    source: str | None = Field(
        default=None, description="Pipeline artifact the layer was derived from."
    )
    shape: list[int] = Field(default_factory=list)
    dtype: str | None = None
    stats: LayerStats | None = None
    columns: list[str] | None = None
    rows: int | None = Field(default=None, description="Total rows in the layer.")
    row_limit: int | None = Field(default=None, description="Rows returned in `data`.")
    truncated: bool = False
    data: list[dict[str, Any]] | None = Field(
        default=None,
        description=(
            "Row objects keyed by `columns`. Null for an array layer, which "
            "returns `grid` instead. Never empty-and-null for a table with rows."
        ),
    )
    grid_size: int | None = Field(default=None, description="Side length of the returned grid.")
    grid: list[list[float]] | None = None
    notes: list[str] = Field(default_factory=list)


# ------------------------------------------------------- coordinate probe (DF-X6B)


class ProbeRequest(BaseModel):
    """A position in the ANALYTICAL raster's own pixel space.

    Deliberately ``row``/``col`` floats, not integers. Connected-component
    centroids are not whole pixels, and an integer field would either truncate the
    sub-pixel position or invite a cast at the call site. GEO-CORR exists to
    preserve that sub-pixel signal; the request type must not throw it away
    before the arithmetic runs.

    ``extra="forbid"`` because a probe with an unrecognised field is a caller
    misunderstanding the coordinate space, and answering it anyway would place a
    point somewhere the caller did not ask about.
    """

    model_config = ConfigDict(extra="forbid")

    row: float = Field(description="Row index in the window raster; 0 is the first row.")
    col: float = Field(description="Column index in the window raster; 0 is the first column.")


class ProbePixel(BaseModel):
    """The requested position, echoed with the convention that was applied."""

    model_config = ConfigDict(extra="forbid")

    row: float
    col: float
    #: The interpretation applied. Pixel centres, not corners: `row=0` is the
    #: CENTRE of the first sample, matching `rasterio.transform.xy(offset="center")`
    #: and `geolocation.pixel_to_wgs84(centre_offset=0.5)`.
    convention: Literal["PIXEL_CENTER"] = "PIXEL_CENTER"
    centre_offset: float = Field(
        default=0.5, description="Sample-index to sample-centre offset that was applied."
    )


class ProbeSource(BaseModel):
    """The projected coordinate the pixel centre maps to, before reprojection."""

    model_config = ConfigDict(extra="forbid")

    crs: str
    x: float
    y: float


class ProbeGeoreferencing(BaseModel):
    """Enough of the georeferencing to reproduce the answer independently."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["AFFINE_GEOREFERENCED", "GCP_GEOREFERENCED", "UNREFERENCED"]
    raster_width: int
    raster_height: int
    window_bounds: list[float] = Field(
        default_factory=list,
        description="[col_min, row_min, col_max, row_max] read from the source raster.",
    )
    #: The affine actually used, as [a, b, c, d, e, f]. This is the WINDOW
    #: transform of the raster that was read, not the full-scene transform:
    #: GEO-001 measured a material error from applying the wrong one.
    transform: list[float] = Field(default_factory=list)
    resolution_m: float | None = None
    #: Whether the CRS transform is axis-order-safe (`always_xy=True`).
    always_xy: bool = True


class ProbeProvenance(BaseModel):
    """Which scan and which acquisition the coordinate came from."""

    model_config = ConfigDict(extra="forbid")

    scan_id: str
    scene_id: str | None = None
    provider: str | None = None
    platform: str | None = None
    acquisition_time: str | None = None
    product: str | None = None
    polarization: str | None = None
    software_version: str | None = None
    processing_version: str | None = None
    #: The requested area of interest. Context only. It is NOT an input to the
    #: conversion, and `test_changing_the_aoi_does_not_move_a_probed_pixel`
    #: exists to keep that true.
    requested_aoi: list[float] = Field(default_factory=list)


class ProbeResponse(BaseModel):
    """A pixel's coordinate, with its full derivation retained.

    No altitude is reported. SAR does not measure height, and a field named
    `altitude` on a radar product would be read as a measurement of something
    this sensor never observed.
    """

    model_config = ConfigDict(extra="forbid")

    scan_id: str
    pixel: ProbePixel
    source: ProbeSource
    wgs84_lat: float
    wgs84_lon: float
    georeferencing: ProbeGeoreferencing
    provenance: ProbeProvenance


# ------------------------------------------------------------------ errors


class ApiError(BaseModel):
    """Error body shared by every non-2xx API response.

    ``status`` is a :class:`darkfleet.providers.ProviderStatus` value whenever a
    provider is involved. Other rejections use these reason codes:
    ``UNKNOWN_PROVIDER``, ``NO_SCENE_COVERAGE``, ``UNKNOWN_SCAN``,
    ``UNKNOWN_TARGET``, ``SCAN_NOT_READY``, ``BAD_EXPORT_FORMAT``,
    ``EXPORT_FORMAT_NOT_IMPLEMENTED``, ``INVALID_REQUEST``, ``RUNSTORE_ERROR``.
    """

    error: str
    status: str
    message: str
    provider: str | None = None
    scan_id: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)
    suggestions: list[str] = Field(default_factory=list)


class NotFoundError(ApiError):
    """404 body for an unknown id. Same shape as every other error."""

    error: str = "UNKNOWN_SCAN"
    status: str = "UNKNOWN_SCAN"


class ExportFormatNotImplemented(ApiError):
    """501 body for formats that land in CP12. Honest, not a fake file."""

    error: str = "EXPORT_FORMAT_NOT_IMPLEMENTED"
    status: str = "EXPORT_FORMAT_NOT_IMPLEMENTED"
    requested_format: str
    planned_in: str = "CP12"
    supported: list[str] = Field(default_factory=lambda: list(SUPPORTED_EXPORT_FORMATS))