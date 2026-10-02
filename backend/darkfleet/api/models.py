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
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from darkfleet.jobs.models import ScanStage

__all__ = [
    "ApiError",
    "BBox",
    "DebugLayerResponse",
    "EvidenceDocumentResponse",
    "ExportFormatNotImplemented",
    "HealthResponse",
    "LayerStats",
    "NotFoundError",
    "ProviderHealthEntry",
    "RuntimeModeLiteral",
    "ScanAccepted",
    "ScanCreateRequest",
    "ScanStateResponse",
    "ScanTargetsResponse",
    "SceneListResponse",
    "SceneSummary",
    "StageEventOut",
    "TargetEvidenceResponse",
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
    provider: str = Field(default="planetary-computer")
    product: Literal["rtc", "grd"] = "rtc"
    cfar_config: dict[str, Any] | None = Field(
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
    """One real stage transition as recorded by the runner."""

    stage: str
    timestamp: datetime
    detail: str
    terminal: bool


class ScanStateResponse(BaseModel):
    """``GET /api/scans/{id}``: current state plus the full transition history."""

    scan_id: str
    stage: str
    terminal: bool
    runtime_mode: str
    synthetic: bool
    known: bool = Field(description="False when the record was recovered from disk only.")
    source: Literal["runner", "run_store"] = "runner"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    failed_at: str | None = Field(
        default=None, description="Pipeline stage that was in flight when the job failed."
    )
    error: str | None = None
    history: list[StageEventOut] = Field(default_factory=list)
    record_persisted: bool = False


class ScanTargetsResponse(BaseModel):
    """``GET /api/scans/{id}/targets`` for a completed scan."""

    scan_id: str
    stage: str
    runtime_mode: str
    synthetic: bool
    #: The extent this scan covered. Needed by any surface that has to describe
    #: the same water (acquisition planning, exports), so it travels with the
    #: targets rather than requiring a second request.
    aoi: list[float] = Field(default_factory=list)
    count: int
    ais_only_count: int
    counts: dict[str, int] = Field(default_factory=dict)
    targets: list[dict[str, Any]] = Field(default_factory=list)
    ais_only: list[dict[str, Any]] = Field(default_factory=list)
    provenance: dict[str, Any] = Field(default_factory=dict)
    #: Source scene and acquisition instant. Both are already in the persisted
    #: record; they are exposed here because the evidence inspector and the
    #: timeline both need them, and without them the client would have to guess
    #: or fetch a second time.
    scene: dict[str, Any] | None = None
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
    status: str = Field(description="ProviderStatus value for the probe behind these scenes.")
    note: str | None = None
    count: int
    scenes: list[SceneSummary] = Field(default_factory=list)


class ProviderHealthEntry(BaseModel):
    """One provider's live probe result. Never carries a credential."""

    provider: str
    status: str = Field(description="ProviderStatus value.")
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


class TargetEvidenceResponse(BaseModel):
    """``GET /api/targets/{id}``: ``evidence.target_evidence`` output verbatim."""

    scan_id: str
    runtime_mode: str
    synthetic: bool
    ambiguous: bool = Field(
        description="True when the target id exists in more than one stored scan."
    )
    candidate_scan_ids: list[str] = Field(default_factory=list)
    evidence: dict[str, Any]


class EvidenceDocumentResponse(BaseModel):
    """``GET /api/evidence/{target_id}``: the owning scan's whole evidence document."""

    scan_id: str
    runtime_mode: str
    synthetic: bool
    ambiguous: bool
    candidate_scan_ids: list[str] = Field(default_factory=list)
    evidence: dict[str, Any]


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
    """``GET /api/debug/{scan_id}/{layer}``: a summary, not a blob."""

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
    rows: int | None = None
    row_limit: int | None = None
    truncated: bool = False
    grid_size: int | None = Field(default=None, description="Side length of the returned grid.")
    grid: list[list[float]] | None = None
    notes: list[str] = Field(default_factory=list)


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