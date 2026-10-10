"""HTTP routers for DarkFleet (API-001..012).

This module is the adapter between the web and the engine. It owns:

* the request/response wiring for every endpoint;
* the adapter from :func:`darkfleet.pipeline.run_scan` (an ``on_stage`` callback)
  to :class:`darkfleet.jobs.runner.ScanRunner` (a generator of transitions);
* persisting completed scans through :class:`darkfleet.storage.runs.RunStore`
  before the job is allowed to report ``COMPLETE``;
* **live** provider probing for ``/api/providers/health`` -- a status is the
  result of a real request, never of reading an environment variable;
* the real-data isolation guard: a provider failure is an explicit error
  carrying a :class:`~darkfleet.providers.ProviderStatus` value, and there is no
  code path into invented data.
"""

from __future__ import annotations

import asyncio
import functools
import itertools
import json
import math
import queue
import re
import threading
import time
from collections.abc import AsyncIterator, Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Final, NoReturn, TypedDict, cast
from xml.etree import ElementTree

import httpx
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from darkfleet import __classification_schema__, __processing_version__, __version__
from darkfleet.ais.archive import AisArchive
from darkfleet.ais.delivery import (
    DEFAULT_WINDOW_SECONDS as AIS_WINDOW_SECONDS,
)
from darkfleet.ais.delivery import (
    AisCoverageOut,
    AisCoverageState,
    AisObservationOut,
    ScanAisResponse,
    ScanAisWindow,
    TargetAisResponse,
    VesselTrackResponse,
    as_utc,
    coverage_for,
    identity_from,
    to_out,
)
from darkfleet.api.advanced import (
    DetectorCardOut,
    DetectorsOut,
    PatternOut,
    PatternsOut,
    RevisitPlanOut,
    TrackHypothesisOut,
    TracksOut,
)
from darkfleet.api.evidence_models import EvidenceDocument, ScanRecordDocument
from darkfleet.api.models import (
    DEFERRED_EXPORT_FORMATS,
    SUPPORTED_EXPORT_FORMATS,
    ApiError,
    DebugLayerResponse,
    EvidenceDocumentResponse,
    ExportFormatNotImplemented,
    HealthResponse,
    LayerStats,
    ProbeGeoreferencing,
    ProbePixel,
    ProbeProvenance,
    ProbeRequest,
    ProbeResponse,
    ProbeSource,
    ProviderHealthEntry,
    ScanAccepted,
    ScanCatalogueEntry,
    ScanCatalogueResponse,
    ScanCreateRequest,
    ScanStateResponse,
    ScanTargetsResponse,
    SceneListResponse,
    SceneSummary,
    StageEventOut,
    TargetEvidenceResponse,
    TargetSummaryResponse,
    jsonable,
)
from darkfleet.api.targets import ScanScene
from darkfleet.config.settings import Settings
from darkfleet.detectors import DetectorRegistry
from darkfleet.evidence import target_evidence
from darkfleet.exports.render import render_pdf, render_png
from darkfleet.geolocation import (
    affine_from_sequence,
    pixel_to_wgs84,
    transform_wgs84,
)
from darkfleet.jobs.models import ScanStage, is_terminal
from darkfleet.jobs.runner import ScanJob, ScanRunner, StageEvent
from darkfleet.narrative import summarise
from darkfleet.pipeline import run_scan
from darkfleet.providers import ProviderStatus, RealDataUnavailableError
from darkfleet.providers.stac import (
    SarAsset,
    cdse_sentinel1_status,
    search_earthsearch_grd,
    search_planetary_computer,
    stac_items,
)
from darkfleet.raster_render import (
    RASTER_LAYERS,
    RasterMode,
    RasterNotRenderableError,
    rectangle_for,
)
from darkfleet.raster_render import (
    render_png as render_raster_png,
)
from darkfleet.revisit import acquisitions_from_items, plan_revisit
from darkfleet.revisit import window_for as revisit_window
from darkfleet.storage.cache import ArtifactCache, CacheKey
from darkfleet.storage.runs import RunStore, run_store_for_data_dir
from darkfleet.temporal import analyse as temporal_analyse
from darkfleet.tracks import build_tracks

__all__ = [
    "DEBUG_LAYERS",
    "KNOWN_PROVIDERS",
    "ApiState",
    "ScanSpec",
    "liveness_router",
    "router",
]

# ---------------------------------------------------------------- registries

#: SAR providers this build can actually talk to. Anything else is rejected
#: explicitly (API-012) instead of being silently routed somewhere.
KNOWN_PROVIDERS: Final[frozenset[str]] = frozenset({"planetary-computer", "earthsearch"})

#: Products each provider can serve.
PROVIDER_PRODUCTS: Final[dict[str, frozenset[str]]] = {
    "planetary-computer": frozenset({"rtc", "grd"}),
    "earthsearch": frozenset({"grd"}),
}

#: Debug layers the API can serve, in pipeline order.
DEBUG_LAYERS: Final[tuple[str, ...]] = (
    "raw",
    "normalized",
    "landmask",
    "filtered",
    "cfar_threshold",
    "detection_mask",
    "components",
    "centroids",
    "ais_observations",
    "ais_predicted",
    "match_radius",
    "correlation_lines",
    "score_decomposition",
)

#: Which pipeline artifact each 2-D debug layer is read from.
_LAYER_SOURCE: Final[dict[str, str]] = {
    "raw": "raw_db",
    "normalized": "raw_db",
    "landmask": "land",
    "filtered": "filtered_db",
    "cfar_threshold": "threshold_db",
    "detection_mask": "cfar_mask",
}

#: Per-target table layers, served from the scan record rather than from a
#: cached float array.
#:
#: `components` and `centroids` used to be numeric arrays shaped (n_targets, k),
#: which forced two compromises: the target id could not be a column because a
#: float64 array cannot hold a string, so the link between a component and its
#: final target was POSITIONAL and implicit; and the sub-pixel centroid GEO-CORR
#: measured had nowhere to go. Both are now explicit columns.
#:
#: The positional link was the real hazard. A frontend given row 3 could only
#: guess which target it belonged to, and the natural guess -- nearest point --
#: is exactly the kind of manufactured relation this product refuses to invent.
_TARGET_TABLE_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    "components": (
        "target_id",
        "classification",
        "area_px",
        "mean_db",
        "max_db",
        "sar_conf",
        "ais_conf",
        "pixel_row",
        "pixel_col",
    ),
    "centroids": (
        "target_id",
        "classification",
        "pixel_row",
        "pixel_col",
        "lat",
        "lon",
        "geo_centre_offset",
    ),
}

#: Correlation layers. These are not rasters: they are per-target rows built
#: from the record's own correlation result, so a value here is always
#: traceable back to a score decomposition rather than to a rendering.
_CORRELATION_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    "ais_observations": ("target_id", "mmsi", "observed_lat", "observed_lon", "observed_at"),
    "ais_predicted": ("target_id", "mmsi", "predicted_lat", "predicted_lon"),
    "match_radius": ("target_id", "match_radius_m"),
    "correlation_lines": ("target_id", "mmsi", "distance_offset_m", "time_delta_s"),
    "score_decomposition": (
        "target_id",
        "distance_score",
        "time_score",
        "heading_score",
        "size_score",
        "total_score",
    ),
}

#: Query keys whose values must never reach a response or a log line.
_SECRET_RE: Final[re.Pattern[str]] = re.compile(
    r"(?i)\b((?:x[-_]amz[-_](?:security[-_]token|signature|credential)|"
    r"x[-_]goog[-_](?:signature|credential)|api[-_]?key|sig|signature|"
    r"sas|token|key|secret|password|passwd|credential|authorization)[a-z_]*)"
    r"\s*[=:]\s*([^\s,;&\"']+)"
)
_SECRET_DETAIL_KEY_RE: Final[re.Pattern[str]] = re.compile(
    r"(?i)(?:signature|token|secret|password|passwd|credential|"
    r"authorization|api[-_]?key|(?:^|[-_])(?:sig|sas)(?:$|[-_]))"
)


def redact(text: str) -> str:
    """Blank out anything shaped like ``key=value`` credentials."""
    return _SECRET_RE.sub(lambda m: f"{m.group(1)}=<redacted>", str(text))


def redact_details(value: Any) -> Any:
    """Scrub credentials recursively while preserving nonsensitive metadata types."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {
            str(key): (
                "<redacted>"
                if _SECRET_DETAIL_KEY_RE.search(str(key))
                else redact_details(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_details(item) for item in value]
    return value


_SSE_MEDIA_TYPE = "text/event-stream"
_KML_MEDIA_TYPE = "application/vnd.google-earth.kml+xml"
_GEOJSON_MEDIA_TYPE = "application/geo+json"
_MAX_TABLE_ROWS: Final[int] = 500
_MAX_GRID: Final[int] = 96

# ------------------------------------------------------------- app plumbing


@dataclass(frozen=True, slots=True)
class ApiState:
    """Everything a request needs, built once per app from :class:`Settings`."""

    settings: Settings
    runner: ScanRunner
    store: RunStore
    data_dir: Path

    @classmethod
    def build(cls, settings: Settings) -> ApiState:
        data_dir = Path(settings.data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            settings=settings,
            runner=ScanRunner(state_dir=data_dir / "state"),
            store=run_store_for_data_dir(data_dir),
            data_dir=data_dir,
        )

    def cache(self) -> ArtifactCache:
        return ArtifactCache(self.data_dir / "cache", __processing_version__)


def get_state(request: Request) -> ApiState:
    """FastAPI dependency: the :class:`ApiState` installed by the lifespan."""
    state: ApiState | None = getattr(request.app.state, "darkfleet_state", None)
    if state is None:  # pragma: no cover - the lifespan always installs it
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "NOT_READY", "status": "APP_NOT_READY", "message": "API state missing."},
        )
    return state


State = Annotated[ApiState, Depends(get_state)]

router = APIRouter(prefix="/api", tags=["darkfleet"])

#: Liveness is served OUTSIDE the /api prefix on purpose, so an orchestrator
#: probe cannot be mistaken for an analysis request.
liveness_router = APIRouter(tags=["liveness"])


@liveness_router.get("/health", summary="Liveness probe")
def liveness() -> dict[str, Any]:
    """Is this process serving requests?

    Deliberately touches NOTHING external: no provider probe, no filesystem
    walk, no network. Liveness answers "is the app up", and readiness for the
    providers is answered separately by ``/api/providers/health``. Conflating the
    two is a real failure mode -- it was, in fact: the container healthcheck
    pointed at the provider-status endpoint, so a slow third party pushed the
    probe past its timeout and Docker restarted a perfectly healthy API in a
    loop.
    """
    return {
        "status": "ok",
        "service": "darkfleet-api",
        "version": __version__,
        "processing_version": __processing_version__,
    }


# ------------------------------------------------------------ error helpers


def _provider_status(exc: RealDataUnavailableError) -> ProviderStatus:
    """Translate a provider failure into the ProviderStatus it actually is."""
    code = exc.details.get("http")
    if code in (401, 403):
        return ProviderStatus.AUTH_REQUIRED
    if code == 429:
        return ProviderStatus.RATE_LIMITED
    return ProviderStatus.UNAVAILABLE


def _provider_http_code(status_value: ProviderStatus) -> int:
    """Unavailable / auth / rate-limit are service-side: 503, never a fake 200."""
    if status_value in (
        ProviderStatus.UNAVAILABLE,
        ProviderStatus.AUTH_REQUIRED,
        ProviderStatus.RATE_LIMITED,
    ):
        return status.HTTP_503_SERVICE_UNAVAILABLE
    return status.HTTP_400_BAD_REQUEST


def api_error(
    http_code: int,
    *,
    error: str,
    status_value: str,
    message: str,
    provider: str | None = None,
    scan_id: str | None = None,
    detail: Mapping[str, Any] | None = None,
    suggestions: list[str] | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=http_code,
        detail=ApiError(
            error=error,
            status=status_value,
            message=redact(message),
            provider=redact(provider) if provider else None,
            scan_id=scan_id,
            detail=redact_details(dict(detail or {})),
            suggestions=[redact(text) for text in (suggestions or [])],
        ).model_dump(),
    )


def _unavailable(exc: RealDataUnavailableError, provider: str) -> HTTPException:
    """A provider failure, as an explicit response. Never a data fallback."""
    status_value = _provider_status(exc)
    return api_error(
        _provider_http_code(status_value),
        error="REAL_DATA_UNAVAILABLE",
        status_value=status_value.value,
        message=str(exc),
        provider=provider,
        detail=redact_details({key: jsonable(value) for key, value in exc.details.items()}),
        suggestions=list(exc.suggestions),
    )


def _unknown_provider(provider: str) -> HTTPException:
    return api_error(
        status.HTTP_400_BAD_REQUEST,
        error="UNKNOWN_PROVIDER",
        status_value=ProviderStatus.NOT_CONFIGURED.value,
        message=(
            f"Unknown SAR provider {provider!r}. Known providers: "
            f"{', '.join(sorted(KNOWN_PROVIDERS))}."
        ),
        provider=provider,
        detail={"known_providers": sorted(KNOWN_PROVIDERS)},
        suggestions=["Use one of the known providers."],
    )


# ------------------------------------------------------------ scene helpers


def _search_provider(
    provider: str,
    product: str,
    bbox: tuple[float, float, float, float],
    datetime_range: str | None,
) -> list[SarAsset]:
    """Proxy a REAL STAC search. Raises RealDataUnavailableError, never degrades."""
    interval = datetime_range or ""
    if provider == "planetary-computer":
        return search_planetary_computer(bbox, interval, product=product, limit=5)
    return search_earthsearch_grd(bbox, interval, limit=5)


def _scene_from_asset(asset: SarAsset, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    """Minimal scene record for the pipeline's REAL gate.

    ``run_scan`` resolves the asset itself; this record exists so a scan can
    only start once discovery has already proved the AOI is covered.
    """
    return {
        "id": asset.item_id,
        "provider": asset.provider,
        "platform": asset.platform,
        "product": asset.product,
        "polarization": asset.polarization,
        "acquisitionTime": asset.acquisition_time,
        "resolutionMeters": asset.resolution_meters,
        "bbox": list(bbox),
    }


def _scene_summary_from_asset(asset: SarAsset, bbox: list[float], runtime_mode: str) -> SceneSummary:
    return SceneSummary(
        id=asset.item_id,
        provider=asset.provider,
        platform=asset.platform,
        product=asset.product,
        polarization=asset.polarization,
        acquisition_time=asset.acquisition_time,
        bbox=list(bbox),
        resolution_meters=asset.resolution_meters,
        georeferencing=asset.georeferencing.value,
        # Invariant, not a choice: every scene this API lists is a real one.
        runtime_mode="REAL",
        synthetic=False,
    )


# ------------------------------------------------------- scan job plumbing


class ScanSpec:
    """Everything one scan needs, plus a one-shot binding for its scan id.

    ``ScanRunner`` allocates the ``DF-####`` id *inside* ``submit`` and starts the
    worker thread before returning, so the work callable cannot receive the id
    as an argument. Instead the generator waits on :meth:`wait_bound`, which the
    request handler releases as soon as ``submit`` has answered. That is a real
    handshake, not a race.
    """

    __slots__ = (
        "_bound",
        "bbox",
        "cfar_config",
        "data_dir",
        "datetime_range",
        "product",
        "provider",
        "runtime_mode",
        "scan_id",
        "scene",
        "scene_id",
        "store",
    )

    def __init__(
        self,
        *,
        runtime_mode: str,
        bbox: tuple[float, float, float, float],
        scene: Mapping[str, Any],
        provider: str,
        product: str,
        datetime_range: str | None,
        scene_id: str | None,
        cfar_config: dict[str, Any] | None,
        data_dir: Path,
        store: RunStore,
    ) -> None:
        self.runtime_mode = runtime_mode
        self.bbox = bbox
        self.scene = dict(scene)
        self.provider = provider
        self.product = product
        self.datetime_range = datetime_range
        self.scene_id = scene_id
        self.cfar_config = cfar_config
        self.data_dir = data_dir
        self.store = store
        self.scan_id = ""
        self._bound = threading.Event()

    def bind(self, scan_id: str) -> None:
        self.scan_id = scan_id
        self._bound.set()

    def wait_bound(self, timeout: float = 30.0) -> str:
        if not self._bound.wait(timeout):
            raise RuntimeError("scan id was never bound to the scan spec")
        return self.scan_id


def _scan_work(spec: ScanSpec) -> Iterator[tuple[ScanStage, str]]:
    """Adapter: ``run_scan``'s ``on_stage`` callback -> a runner work generator.

    The runner owns ``QUEUED``, so the pipeline's own ``QUEUED`` emission is
    dropped rather than replayed as an illegal repeat transition. The 15-state
    machine has no self-loops, so a stage reported twice in a row (the pipeline
    reports ``SEARCHING_SCENE`` again once an asset is chosen) is merged into one
    transition carrying both measured details.

    Persistence happens *before* the terminal transition is yielded, so a job that
    reports ``COMPLETE`` is already readable from the run store.
    """
    scan_id = spec.wait_bound()
    events: queue.Queue[tuple[ScanStage, str] | object] = queue.Queue()
    outcome: dict[str, Any] = {}
    failure: list[BaseException] = []
    done = object()

    def _run() -> None:
        try:
            outcome.update(
                run_scan(
                    bbox=list(spec.bbox),
                    data_dir=spec.data_dir,
                    cfar_config=spec.cfar_config,
                    datetime_range=spec.datetime_range,
                    scene_id=spec.scene_id,
                    provider=spec.provider,
                    product=spec.product,
                    on_stage=lambda stage, detail: events.put((ScanStage(stage), detail)),
                    scan_id=scan_id,
                )
            )
        except BaseException as exc:  # noqa: BLE001 - reported through the runner
            failure.append(exc)
        finally:
            events.put(done)

    thread = threading.Thread(target=_run, name=f"darkfleet-scan-{scan_id}", daemon=True)
    thread.start()

    current: ScanStage | None = None
    details: list[str] = []
    while True:
        item = events.get()
        if item is done:
            break
        stage, detail = cast("tuple[ScanStage, str]", item)
        if current is None:
            if stage is ScanStage.QUEUED:
                continue  # the runner already recorded QUEUED at submit time
            current, details = stage, [detail]
            continue
        if stage is current:
            details.append(detail)  # no self-loops exist: merge, keep both facts
            continue
        yield current, " | ".join(details)
        current, details = stage, [detail]

    if current is None:
        if failure:
            raise failure[0]
        raise RuntimeError("scan work produced no stage transitions")
    joined = " | ".join(details)
    if is_terminal(current):
        thread.join()
        if failure:
            raise failure[0]
        _persist_scan(spec, outcome)  # raises => the runner records FAILED
        yield current, joined
    else:
        yield current, joined
        if failure:
            raise failure[0]
        raise RuntimeError(f"scan work ended in {current.value} without a terminal stage")


# ------------------------------------------------------- persistence/debug


def _cache_inputs(spec: ScanSpec, result: Mapping[str, Any]) -> dict[str, Any]:
    """The four cache-defining inputs, recorded so debug reads can rebuild the key."""
    provenance = result.get("provenance") or {}
    sar = provenance.get("sar") or {}
    config = result.get("config") or {}
    return {
        "scene_item_id": str(sar.get("item_id") or spec.scan_id),
        "bbox": [float(value) for value in (result.get("aoi") or spec.bbox)],
        "processing_config": jsonable(config),
        "algorithm_version": __processing_version__,
    }


def _layer_arrays(spec: ScanSpec, result: Mapping[str, Any]) -> dict[str, np.ndarray]:
    """Build the cacheable payload for every debug layer of a finished scan."""
    artifacts = result.get("artifacts") or {}
    arrays: dict[str, np.ndarray] = {}
    for layer, source in _LAYER_SOURCE.items():
        payload = artifacts.get(source)
        if payload is not None:
            arrays[layer] = np.asarray(payload)
    targets = list(result.get("targets") or [])
    if targets:
        arrays["centroids"] = np.array(
            [[float(t["lat"]), float(t["lon"])] for t in targets], dtype=np.float64
        )
        arrays["components"] = np.array(
            [
                [
                    float(t["area"]),
                    float(t["meanDb"]),
                    float(t["maxDb"]),
                    float(t["sarConf"]),
                    float(t["aisConf"]),
                ]
                for t in targets
            ],
            dtype=np.float64,
        )
    else:
        arrays["centroids"] = np.zeros((0, 2), dtype=np.float64)
        arrays["components"] = np.zeros((0, 5), dtype=np.float64)
    return arrays


def _persist_scan(spec: ScanSpec, result: Mapping[str, Any]) -> None:
    """Save the completed scan plus its debug layers. Raises on a hard failure."""
    inputs = _cache_inputs(spec, result)
    arrays = _layer_arrays(spec, result)
    cache = ArtifactCache(spec.data_dir / "cache", __processing_version__)
    key = CacheKey(
        scene_item_id=str(inputs["scene_item_id"]),
        bbox=tuple(float(v) for v in inputs["bbox"]),  # type: ignore[arg-type]
        processing_config=dict(inputs["processing_config"]),
        algorithm_version=__processing_version__,
    )
    written: list[str] = []
    for layer in DEBUG_LAYERS:
        payload = arrays.get(layer)
        if payload is None:
            continue
        try:
            # Stored verbatim, NaN included: a float layer keeps its non-finite
            # pixels so the debug endpoint can report them honestly.
            cache.put(key, layer, payload)
        except (OSError, ValueError):
            # A cache write must never lose the scan itself.
            continue
        written.append(layer)
    record = jsonable({key_: value for key_, value in result.items() if key_ != "artifacts"})
    record["scan_id"] = spec.scan_id
    record["debug"] = {
        "cache": inputs,
        "layers": written,
        "columns": {name: list(columns) for name, columns in _TARGET_TABLE_COLUMNS.items()},
        "runtime_mode": spec.runtime_mode,
        "synthetic": bool(result.get("synthetic")),
    }
    spec.store.save(record)


def _debug_cache_key(record: Mapping[str, Any]) -> CacheKey | None:
    cache_meta = record.get("debug") or {}
    inputs = cache_meta.get("cache") if isinstance(cache_meta, dict) else None
    if not isinstance(inputs, dict):
        return None
    try:
        return CacheKey(
            scene_item_id=str(inputs["scene_item_id"]),
            bbox=tuple(float(value) for value in inputs["bbox"]),  # type: ignore[arg-type]
            processing_config=dict(inputs["processing_config"]),
            algorithm_version=str(inputs["algorithm_version"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _raster_context(
    record: Mapping[str, Any], state: State, layer: str
) -> tuple[np.ndarray, CacheKey, dict[str, Any]]:
    """Load one renderable raster plus the measured geometry that positions it.

    Raises an api_error rather than returning a partial answer: a raster with no
    bounds cannot be placed, and guessing its extent would put detections in the
    wrong sea.
    """
    if layer not in RASTER_LAYERS:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_RASTER_LAYER",
            status_value="UNKNOWN_RASTER_LAYER",
            message=(
                f"Unknown raster layer {layer!r}. "
                f"Renderable layers: {', '.join(RASTER_LAYERS)}."
            ),
            detail={"layers": list(RASTER_LAYERS)},
        )
    key = _debug_cache_key(record)
    if key is None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="RASTER_NOT_AVAILABLE",
            status_value="LAYERS_NOT_AVAILABLE",
            message=(
                "This scan did not persist its raster artifacts, so no image can be "
                "rendered. Re-run the scan to produce them."
            ),
        )
    array = ArtifactCache(Path(state.settings.data_dir) / "cache", __processing_version__).get(
        key, RASTER_LAYERS[layer]
    )
    if array is None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="RASTER_LAYER_ABSENT",
            status_value="LAYERS_NOT_AVAILABLE",
            message=(
                f"This scan stored no '{layer}' raster. It is written only for the "
                "products the pipeline actually produced."
            ),
            detail={"layer": layer},
        )
    raw_scene = record.get("scene")
    scene: dict[str, Any] = raw_scene if isinstance(raw_scene, dict) else {}
    geometry = {
        "crs": str(scene.get("crs") or ""),
        "transform": list(scene.get("transform") or []),
    }
    return array, key, geometry


def _raise_raster_failure(exc: RasterNotRenderableError) -> NoReturn:
    """Raise an explicit 422 for a raster that cannot be positioned.

    An image nobody can place is not a degraded result, it is a wrong one, so this
    is raised rather than returned. Returning the exception would let FastAPI try
    to serialise it as a successful response body.
    """
    raise api_error(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        error="RASTER_NOT_GEOREFERENCED",
        status_value="UNREFERENCED",
        message=exc.reason,
        detail=exc.detail,
    ) from exc


@router.get("/scans/{scan_id}/raster")
def raster_index(scan_id: str, state: State) -> Response:
    """Which rasters this scan can render, and the geometry each would occupy.

    Metadata before image, deliberately: Cesium's SingleTileImageryProvider needs
    the rectangle before it will fetch the image, so the two cannot be one
    response without either guessing the extent or inlining the image as a data
    URL. This keeps the extent measured and the image a plain PNG.
    """
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No completed scan {scan_id!r}; rasters are written at COMPLETE.",
            scan_id=scan_id,
        )
    key = _debug_cache_key(record)
    layers: list[dict[str, Any]] = []
    if key is not None:
        cache = ArtifactCache(Path(state.settings.data_dir) / "cache", __processing_version__)
        raw_scene = record.get("scene")
        scene: dict[str, Any] = raw_scene if isinstance(raw_scene, dict) else {}
        crs = str(scene.get("crs") or "")
        transform = list(scene.get("transform") or [])
        for name, source in RASTER_LAYERS.items():
            array = cache.get(key, source)
            if array is None:
                continue
            entry: dict[str, Any] = {
                "layer": name,
                "modes": ["stretch", "raw", "falsecolor"]
                if name not in ("landmask", "detection_mask")
                else ["stretch"],
                "shape": [int(array.shape[0]), int(array.shape[1])],
                "dtype": str(array.dtype),
            }
            try:
                bounds = rectangle_for(array, crs=crs, transform=transform)
                entry["rectangle"] = bounds.as_rectangle()
                entry["georeferenced"] = True
            except RasterNotRenderableError as exc:
                entry["georeferenced"] = False
                entry["reason"] = exc.reason
            layers.append(entry)

    payload = {
        "scan_id": scan_id,
        "scene_item_id": ((record.get("scene") or {}).get("item_id") if isinstance(record.get("scene"), dict) else None),
        "crs": ((record.get("scene") or {}).get("crs") if isinstance(record.get("scene"), dict) else None),
        "layers": layers,
        "renderable_count": len(layers),
    }
    return Response(
        content=json.dumps(payload, indent=2, sort_keys=True, default=str),
        media_type="application/json",
    )


@router.get("/scans/{scan_id}/raster/{layer}")
def raster_metadata(scan_id: str, layer: str, state: State) -> Response:
    """Measured geometry and statistics for one raster layer.

    Separate from the image because Cesium needs the rectangle to construct the
    imagery provider, and because an operator asking "what is this layer" deserves
    its measured numbers without decoding a PNG.
    """
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No completed scan {scan_id!r}; rasters are written at COMPLETE.",
            scan_id=scan_id,
        )
    array, _key, geometry = _raster_context(record, state, layer)
    try:
        bounds = rectangle_for(array, crs=geometry["crs"], transform=geometry["transform"])
    except RasterNotRenderableError as exc:
        _raise_raster_failure(exc)

    _png, report = render_raster_png(array, layer=layer, mode="stretch")
    raw_scene = record.get("scene")
    scene: dict[str, Any] = raw_scene if isinstance(raw_scene, dict) else {}
    payload = {
        "scan_id": scan_id,
        "layer": layer,
        "rectangle": bounds.as_rectangle(),
        "crs": geometry["crs"],
        "transform": geometry["transform"],
        "image_url": f"/api/scans/{scan_id}/raster/{layer}/image",
        "scene": {
            "item_id": scene.get("item_id"),
            "platform": scene.get("platform"),
            "acquisition_time": scene.get("acquisition_time"),
            "polarization": scene.get("polarization"),
            "product": scene.get("product"),
            "provider": scene.get("provider"),
            "resolution_m": scene.get("resolution_m"),
            "raster_window": scene.get("raster_window"),
        },
        "render": report,
        "provenance": {
            "processing_version": __processing_version__,
            "software_version": __version__,
            "classification_schema": __classification_schema__,
            # CFAR-STATE: the configuration THIS run was computed with.
            #
            # #28 requires the interface to separate "the run you are looking at"
            # from "the configuration you are proposing". The proposed side is
            # editable in the browser; the current side can only come from the
            # record, because a default value rendered in the browser is a claim
            # about what was computed that nothing established.
            #
            # Served under `provenance` rather than as a top-level `config`
            # because it is provenance for these pixels: changing it changes what
            # the pixels ARE, so it belongs with the version that produced them.
            # `config_hash` is included so two runs can be compared without
            # guessing whether an equal set of numbers means an equal run.
            "processing_config": record.get("config") or None,
        },
    }
    return Response(
        content=json.dumps(payload, indent=2, sort_keys=True, default=str),
        media_type="application/json",
    )


@router.get("/scans/{scan_id}/raster/{layer}/image")
def raster_image(
    scan_id: str,
    layer: str,
    state: State,
    mode: Annotated[
        RasterMode,
        Query(description="stretch = measured percentiles; raw = fixed dB window; falsecolor = analytical ramp."),
    ] = "stretch",
) -> Response:
    """The raster itself, as a georeferenced PNG.

    ``singleTileImageryProvider`` decodes PNG; the pipeline's assets are GeoTIFF
    over HTTP, which no browser can display. This is the server-side render that
    makes the SAR actually visible, and it renders the SAME cached array the
    detections were computed from.
    """
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No completed scan {scan_id!r}; rasters are written at COMPLETE.",
            scan_id=scan_id,
        )
    array, _key, geometry = _raster_context(record, state, layer)
    try:
        # Refuse early if it cannot be positioned: an image nobody can place is
        # not a degraded result, it is a wrong one.
        rectangle_for(array, crs=geometry["crs"], transform=geometry["transform"])
        png, report = render_raster_png(array, layer=layer, mode=mode)
    except RasterNotRenderableError as exc:
        _raise_raster_failure(exc)

    # The report travels as headers so the client can state what it is showing
    # (downsample factor, display window) rather than implying 1:1 native pixels.
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=300",
            "X-DarkFleet-Downsample": str(report["downsample_factor"]),
            "X-DarkFleet-Display-Window": json.dumps(report["display_window"]),
            "X-DarkFleet-Source-Shape": ",".join(str(v) for v in report["source_shape"]),
            "X-DarkFleet-Rendered-Shape": ",".join(str(v) for v in report["rendered_shape"]),
        },
    )


# ============================================================ coordinate probe
#
# DF-X6B. One authority for pixel -> WGS84, and it is the backend.
#
# The browser asks "what coordinate is this analytical pixel?" and the answer comes
# from `geolocation.pixel_to_wgs84` -- the function GEO-CORR established -- using
# the WINDOW transform of the raster that was actually read. Nothing here
# re-implements affine arithmetic or CRS conversion, and the requested AOI never
# enters the conversion.


@router.post("/scans/{scan_id}/debug/probe", response_model=ProbeResponse)
def probe_pixel(
    scan_id: str,
    body: ProbeRequest,
    state: State,
) -> ProbeResponse:
    """Place one analytical pixel on the Earth.

    There is exactly one geolocation authority in this codebase and this route
    calls it. It does not accept a bbox, does not interpolate against the
    requested area, and does not apply the full-scene transform to window-local
    coordinates -- each of those was a real defect GEO-001 measured.

    Bounds are refused, never clamped: a pixel outside the raster is a question
    with no correct answer, and snapping it to the nearest valid pixel would put
    a mark somewhere the operator did not click.
    """
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="SCAN_NOT_FOUND",
            status_value="UNKNOWN_SCAN",
            message=f"No completed scan {scan_id!r}; pixels need a completed raster.",
            scan_id=scan_id,
        )

    raw_scene = record.get("scene")
    scene: dict[str, Any] = raw_scene if isinstance(raw_scene, dict) else {}
    crs = str(scene.get("crs") or "")
    transform_values = [float(v) for v in (scene.get("transform") or [])][:6]

    # The raster extent is the WINDOW that was actually read, recorded as
    # [col_off, row_off, width, height]. There is no separate raster block, and
    # inventing one would be a second copy of the geometry that could drift from
    # the transform the detections were computed with.
    window = scene.get("raster_window")
    window_values = [float(v) for v in window] if isinstance(window, (list, tuple)) else []
    width = int(window_values[2]) if len(window_values) >= 4 else 0
    height = int(window_values[3]) if len(window_values) >= 4 else 0

    if not width or not height:
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="DEBUG_ARTIFACT_NOT_READY",
            status_value="LAYERS_NOT_AVAILABLE",
            message=(
                f"Scan {scan_id} records no raster dimensions, so pixel extents cannot be "
                "checked. Re-run the scan."
            ),
            scan_id=scan_id,
        )

    if len(transform_values) != 6 or not crs:
        # An unreferenced asset cannot be placed, and approximating from the AOI
        # would place it in the wrong sea. Refused, not estimated.
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="GEOREFERENCE_UNAVAILABLE",
            status_value="UNAVAILABLE",
            message=(
                f"Scan {scan_id} carries no usable affine georeferencing, so a pixel cannot be "
                "placed. An unreferenced raster is refused rather than approximated from the "
                "requested area."
            ),
            scan_id=scan_id,
            detail={"crs": crs or None, "transform": transform_values or None},
        )

    # Pixel CENTRE semantics: the valid interval is the range of sample centres,
    # so the last valid index is width-1 / height-1. A centroid of pixels inside
    # the raster always lands in that range, which is why fractional positions
    # such as row=399.5 are accepted while row=400 is not.
    row, col = body.row, body.col
    if not (0.0 <= row <= height - 1) or not (0.0 <= col <= width - 1):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            error="PIXEL_OUT_OF_BOUNDS",
            status_value="INVALID_REQUEST",
            message=(
                f"Pixel (row={row}, col={col}) is outside the analytical raster, whose sample "
                f"centres span rows 0..{height - 1} and columns 0..{width - 1}. The position is "
                "refused rather than clamped."
            ),
            scan_id=scan_id,
            detail={
                "row": row,
                "col": col,
                "valid_row_range": [0.0, float(height - 1)],
                "valid_col_range": [0.0, float(width - 1)],
                "raster_width": width,
                "raster_height": height,
            },
        )

    transform = affine_from_sequence(transform_values)
    to_wgs84 = transform_wgs84(crs)
    lat, lon = pixel_to_wgs84(col, row, transform=transform, to_wgs84=to_wgs84)

    window_bounds = window_values[:4]
    provenance_block = record.get("provenance")
    provenance_block = provenance_block if isinstance(provenance_block, dict) else {}

    return ProbeResponse(
        scan_id=scan_id,
        pixel=ProbePixel(row=row, col=col),
        source=ProbeSource(
            crs=crs,
            x=float(transform.a * (col + 0.5) + transform.b * (row + 0.5) + transform.c),
            y=float(transform.d * (col + 0.5) + transform.e * (row + 0.5) + transform.f),
        ),
        wgs84_lat=lat,
        wgs84_lon=lon,
        georeferencing=ProbeGeoreferencing(
            type="AFFINE_GEOREFERENCED",
            raster_width=width,
            raster_height=height,
            window_bounds=window_bounds,
            transform=transform_values,
            resolution_m=(
                float(scene["resolution_m"]) if scene.get("resolution_m") is not None else None
            ),
            always_xy=True,
        ),
        provenance=ProbeProvenance(
            scan_id=scan_id,
            scene_id=str(scene.get("item_id")) if scene.get("item_id") else None,
            provider=str(scene.get("provider")) if scene.get("provider") else None,
            platform=str(scene.get("platform")) if scene.get("platform") else None,
            acquisition_time=(
                str(scene["acquisition_time"]) if scene.get("acquisition_time") else None
            ),
            product=str(scene.get("product")) if scene.get("product") else None,
            polarization=(
                str(scene.get("polarization")) if scene.get("polarization") else None
            ),
            software_version=str(provenance_block.get("software_version") or "") or None,
            processing_version=str(provenance_block.get("processing_version") or "") or None,
            # Context only. Never an input to the conversion above.
            requested_aoi=[float(v) for v in (record.get("aoi") or [])],
        ),
    )


# ------------------------------------------------------------- endpoints


@router.post("/scans", response_model=ScanAccepted, status_code=status.HTTP_202_ACCEPTED)
def create_scan(body: ScanCreateRequest, state: State) -> ScanAccepted:
    """Queue one scan and return immediately (API-001).

    The provider is validated and AOI coverage is proven *before* the job is
    accepted, so an unusable request is a 4xx/5xx with a ProviderStatus rather
    than a job that fails later. There is no degraded path: if the provider
    cannot serve the extent, the scan does not happen.
    """
    bbox = (float(body.bbox[0]), float(body.bbox[1]), float(body.bbox[2]), float(body.bbox[3]))

    provider = body.provider
    if provider not in KNOWN_PROVIDERS:
        raise _unknown_provider(provider)
    if body.product not in PROVIDER_PRODUCTS[provider]:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="UNSUPPORTED_PRODUCT",
            status_value=ProviderStatus.NOT_CONFIGURED.value,
            message=f"Provider {provider} does not serve product {body.product!r}.",
            provider=provider,
            detail={"supported": sorted(PROVIDER_PRODUCTS[provider])},
        )
    assets = _search_provider(provider, body.product, bbox, body.datetime_range)
    if not assets:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="NO_SCENE_COVERAGE",
            status_value=ProviderStatus.UNAVAILABLE.value,
            message=(
                f"{provider} returned no asset for bbox {list(bbox)} "
                f"and datetime {body.datetime_range or 'any'}."
            ),
            provider=provider,
            detail={"bbox": list(bbox), "datetime": body.datetime_range},
            suggestions=["Widen the bbox or the datetime range."],
        )
    scene = _scene_from_asset(assets[0], bbox)

    spec = ScanSpec(
        runtime_mode="REAL",
        bbox=bbox,
        scene=scene,
        provider=provider,
        product=body.product,
        datetime_range=body.datetime_range,
        scene_id=body.scene_id,
        cfar_config=body.cfar_config.overrides() if body.cfar_config else None,
        data_dir=state.data_dir,
        store=state.store,
    )
    job = state.runner.submit(
        lambda: _scan_work(spec),
        runtime_mode="REAL",
        synthetic=False,
    )
    spec.bind(job.scan_id)
    return ScanAccepted(
        scan_id=job.scan_id,
        status=job.stage.value,
        runtime_mode="REAL",
        synthetic=False,
    )


@router.get("/scans", response_model=ScanCatalogueResponse)
def list_completed_scans(
    state: State,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> ScanCatalogueResponse:
    """Discover actual persisted acquisitions for comparison and restoration.

    The list is bounded and contains only independently saved REAL records. An
    unreadable or incorrectly labelled legacy document never becomes an
    operator-visible observation. Source URLs/SAS tokens stay server-side.
    """
    scans: list[ScanCatalogueEntry] = []
    for scan_id in reversed(state.store.list_ids()):
        record = _safe_store_get(state.store, scan_id)
        if not record or record.get("runtime_mode") != "REAL" or record.get("synthetic") is not False:
            continue
        raw_scene = record.get("scene")
        scene = raw_scene if isinstance(raw_scene, dict) else {}
        scans.append(
            ScanCatalogueEntry(
                scan_id=scan_id,
                created_at=str(record["created_at"]) if record.get("created_at") else None,
                scene_id=str(scene["item_id"]) if scene.get("item_id") else None,
                acquisition_time=(
                    str(scene["acquisition_time"]) if scene.get("acquisition_time") else None
                ),
                provider=str(scene["provider"]) if scene.get("provider") else None,
                product=str(scene["product"]) if scene.get("product") else None,
                polarization=(
                    str(scene["polarization"]) if scene.get("polarization") else None
                ),
            )
        )
        if len(scans) >= limit:
            break
    return ScanCatalogueResponse(scans=scans, count=len(scans))


def _job_events(job: ScanJob) -> list[StageEventOut]:
    return [
        StageEventOut(
            stage=event.stage,
            timestamp=event.timestamp,
            detail=redact(event.detail),
            terminal=event.terminal,
        )
        for event in job.history
    ]


@router.get("/scans/{scan_id}", response_model=ScanStateResponse)
def get_scan(scan_id: str, state: State) -> ScanStateResponse:
    """Job state plus its full stage history (API-002).

    A job the runner no longer knows (another process, or a restart) is served
    from the durable run store and flagged ``source="run_store"``.
    """
    job = state.runner.get(scan_id)
    record = _safe_store_get(state.store, scan_id)
    if job is None and record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No scan {scan_id!r} is known to the runner or the run store.",
            scan_id=scan_id,
        )
    if job is not None:
        return ScanStateResponse(
            scan_id=job.scan_id,
            stage=job.stage,
            terminal=is_terminal(job.stage),
            runtime_mode=job.runtime_mode.value,
            synthetic=job.synthetic,
            known=True,
            source="runner",
            started_at=job.started_at,
            finished_at=job.finished_at,
            failed_at=job.failed_at,
            error=redact(job.error) if job.error else None,
            history=_job_events(job),
            record_persisted=record is not None,
        )
    assert record is not None
    return ScanStateResponse(
        scan_id=scan_id,
        stage=ScanStage(record.get("stage", ScanStage.COMPLETE.value)),
        terminal=True,
        runtime_mode=str(record.get("runtime_mode", "REAL")),
        synthetic=bool(record.get("synthetic", False)),
        known=False,
        source="run_store",
        finished_at=_as_datetime(record.get("created_at")),
        history=[],
        record_persisted=True,
    )


def _sse(payload: Mapping[str, Any]) -> str:
    return f"event: stage\ndata: {json.dumps(redact_details(jsonable(payload)), sort_keys=True)}\n\n"


@router.get("/scans/{scan_id}/events")
def scan_events(
    scan_id: str,
    state: State,
    timeout: float = Query(
        default=900.0, gt=0.0, le=7200.0, description="Seconds before the stream gives up."
    ),
) -> Response:
    """Server-sent events of real stage transitions (API-004).

    The stream is fed straight from ``ScanRunner.subscribe``: every already
    recorded transition, then every live one. It ends when an event is terminal.
    """
    try:
        channel = state.runner.subscribe(scan_id)
    except KeyError:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No live job {scan_id!r} to stream.",
            scan_id=scan_id,
        ) from None

    return StreamingResponse(
        _event_stream(channel, scan_id, timeout),
        media_type=_SSE_MEDIA_TYPE,
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def _event_stream(
    channel: queue.Queue[StageEvent],
    scan_id: str,
    timeout: float,
) -> AsyncIterator[str]:
    """Yield SSE frames for real transitions until the terminal one.

    Nothing is invented: the only non-transition line is an SSE comment, which
    browsers ignore and event listeners never see.
    """
    loop = asyncio.get_running_loop()
    deadline = time.monotonic() + timeout
    yield ": darkfleet scan stream\n\n"
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0.0:
            yield _sse(
                {
                    "scan_id": scan_id,
                    "detail": f"no terminal stage within {timeout:.0f}s",
                    "stage": None,
                    "terminal": False,
                    "timed_out": True,
                }
            )
            return
        try:
            event = await loop.run_in_executor(
                None, functools.partial(channel.get, True, min(remaining, 1.0))
            )
        except queue.Empty:
            continue
        yield _sse(
            {
                "scan_id": scan_id,
                "stage": event.stage.value,
                "timestamp": event.timestamp.isoformat(),
                "detail": event.detail,
                "terminal": event.terminal,
            }
        )
        if event.terminal:
            return


@router.get("/scans/{scan_id}/targets", response_model=ScanTargetsResponse)
def scan_targets(scan_id: str, state: State) -> ScanTargetsResponse:
    """Persisted targets of a completed scan (API-003)."""
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        job = state.runner.get(scan_id)
        if job is not None and not is_terminal(job.stage):
            raise api_error(
                status.HTTP_409_CONFLICT,
                error="SCAN_NOT_READY",
                status_value="SCAN_NOT_READY",
                message=f"Scan {scan_id} is still {job.stage.value}; targets appear at COMPLETE.",
                scan_id=scan_id,
            )
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No persisted targets for {scan_id!r}; a completed scan is required.",
            scan_id=scan_id,
        )
    targets = list(record.get("targets") or [])
    ais_only = list(record.get("ais_only") or [])
    return ScanTargetsResponse(
        scan_id=scan_id,
        stage=ScanStage.COMPLETE.value,
        runtime_mode=str(record.get("runtime_mode", "REAL")),
        synthetic=bool(record.get("synthetic", False)),
        aoi=[float(v) for v in (record.get("aoi") or [])],
        count=len(targets),
        ais_only_count=len(ais_only),
        counts={str(k): int(v) for k, v in dict(record.get("counts") or {}).items()},
        targets=targets,
        ais_only=ais_only,
        provenance=dict(record.get("provenance") or {}),
        # Validated into ScanScene rather than passed through as a dict. The record
        # is written by the pipeline and is authoritative; if it ever stopped
        # matching the declared shape this raises here instead of shipping an
        # untyped object the timeline would then read fields from unsafely.
        scene=(
            ScanScene.model_validate(record["scene"])
            if isinstance(record.get("scene"), dict)
            else None
        ),
        acquisition_time=(
            str(record["acquisition_time"]) if record.get("acquisition_time") else None
        ),
    )


@router.get("/scenes", response_model=SceneListResponse)
def list_scenes(
    state: State,
    bbox: str | None = Query(
        default=None, description="Comma separated min_lon,min_lat,max_lon,max_lat."
    ),
    datetime: str | None = Query(default=None, description="STAC datetime interval."),
    provider: str = Query(default="planetary-computer"),
) -> SceneListResponse:
    """Scene discovery (API-005).

    Proxies the live provider search. A provider failure is an explicit error
    response: there is no synthetic catalogue and no fallback list, so every
    scene returned here is a real acquisition the provider actually holds.
    """
    if provider not in KNOWN_PROVIDERS:
        raise _unknown_provider(provider)
    box = _parse_bbox_query(bbox)
    try:
        assets = _search_provider(provider, "rtc" if provider == "planetary-computer" else "grd", box, datetime)
    except RealDataUnavailableError as exc:
        raise _unavailable(exc, provider) from exc
    scenes = [
        _scene_summary_from_asset(asset, list(box), "REAL")
        for asset in assets
        if asset.item_id
    ]
    return SceneListResponse(
        runtime_mode="REAL",
        synthetic=False,
        provider=provider,
        status=ProviderStatus.AVAILABLE if scenes else ProviderStatus.UNAVAILABLE,
        note=None if scenes else "no scene coverage for the requested area/time",
        count=len(scenes),
        scenes=scenes,
    )


def _parse_bbox_query(raw: str | None) -> tuple[float, float, float, float]:
    if not raw:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message="REAL scene discovery requires bbox=min_lon,min_lat,max_lon,max_lat.",
        )
    parts = [piece.strip() for piece in raw.split(",")]
    if len(parts) != 4:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message=f"bbox must hold exactly 4 values, got {len(parts)} in {raw!r}.",
        )
    try:
        values = [float(part) for part in parts]
    except ValueError as exc:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message=f"bbox values must be numbers: {exc}",
        ) from exc
    min_lon, min_lat, max_lon, max_lat = values
    if not all(math.isfinite(value) for value in values):
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message="bbox values must be finite.",
        )
    if not (-180.0 <= min_lon <= 180.0 and -180.0 <= max_lon <= 180.0):
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message=f"longitude out of range: {min_lon}..{max_lon}",
        )
    if not (-90.0 <= min_lat <= 90.0 and -90.0 <= max_lat <= 90.0):
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message=f"latitude out of range: {min_lat}..{max_lat}",
        )
    if min_lon >= max_lon or min_lat >= max_lat:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_REQUEST",
            status_value="INVALID_REQUEST",
            message=f"bbox must satisfy min<max, got {values}",
        )
    return (min_lon, min_lat, max_lon, max_lat)


# ------------------------------------------------------------ store lookup


def _safe_store_get(store: RunStore, scan_id: str) -> dict[str, Any] | None:
    try:
        return store.get(scan_id)
    except ValueError:
        return None  # a malformed id cannot be a stored scan


class _OwnerScan(TypedDict):
    record: dict[str, Any]
    target: dict[str, Any]


def _scan_sort_key(record: Mapping[str, Any]) -> tuple[int, str]:
    scan_id = str(record.get("scan_id", ""))
    try:
        return (int(scan_id.removeprefix("DF-")), scan_id)
    except ValueError:
        return (0, scan_id)


def _locate_target(state: ApiState, target_id: str, scan_id: str | None) -> list[_OwnerScan]:
    """Find every stored scan holding ``target_id``, newest scan first."""
    if scan_id is not None:
        record = _safe_store_get(state.store, scan_id)
        if record is None:
            raise api_error(
                status.HTTP_404_NOT_FOUND,
                error="UNKNOWN_SCAN",
                status_value="UNKNOWN_SCAN",
                message=f"No persisted scan {scan_id!r}.",
                scan_id=scan_id,
            )
        owners = [
            _OwnerScan(record=record, target=t)
            for t in (record.get("targets") or [])
            if isinstance(t, dict) and t.get("id") == target_id
        ]
        if not owners:
            raise _unknown_target(target_id, scan_id)
        return owners
    found: list[_OwnerScan] = []
    for record in sorted(state.store.list(), key=_scan_sort_key, reverse=True):
        for candidate in record.get("targets") or []:
            if isinstance(candidate, dict) and candidate.get("id") == target_id:
                found.append(_OwnerScan(record=record, target=candidate))
    if not found:
        raise _unknown_target(target_id, None)
    return found


def _unknown_target(target_id: str, scan_id: str | None) -> HTTPException:
    return api_error(
        status.HTTP_404_NOT_FOUND,
        error="UNKNOWN_TARGET",
        status_value="UNKNOWN_TARGET",
        message=(
            f"No persisted target {target_id!r}"
            + (f" in scan {scan_id!r}." if scan_id else " in any completed scan.")
        ),
        scan_id=scan_id,
        detail={"target_id": target_id},
    )


@router.get("/targets/{target_id}", response_model=TargetEvidenceResponse)
def get_target(
    target_id: str,
    state: State,
    scan_id: str | None = Query(default=None, description="Disambiguates repeated target ids."),
) -> TargetEvidenceResponse:
    """One target with its evidence slice (API-006), via ``evidence.target_evidence``."""
    owners = _locate_target(state, target_id, scan_id)
    owner = owners[0]
    record = owner["record"]
    # Validated into EvidenceDocument rather than passed through as a dict. The
    # builder is the authority on what the document contains; the model is the
    # check that the document still matches what any consumer was promised. A
    # builder key with no declaration raises here rather than shipping a field
    # the interface cannot see.
    #
    # An absent provenance block is passed through as None rather than as `{}`:
    # the builder carries null provenance out as null, so a record that cannot
    # say how it was produced renders as an absent audit trail.
    provenance = owner["record"].get("provenance") or None
    # DF-X9.4R: the real coverage state, not a hardcoded None. The ghost-vessel decision record
    # reports WHY no candidate was accepted, and "the AIS source was never configured" is a
    # materially different answer from "a source was configured and nothing was near enough".
    # Both used to arrive as NOT_ESTABLISHED, which is the DF-X7 defect in a new place.
    coverage = _ais_coverage_report(state)
    return TargetEvidenceResponse(
        scan_id=str(record.get("scan_id", "")),
        runtime_mode=str(record.get("runtime_mode", "REAL")),
        synthetic=bool(record.get("synthetic", False)),
        ambiguous=len(owners) > 1,
        candidate_scan_ids=[str(o["record"].get("scan_id", "")) for o in owners],
        evidence=EvidenceDocument.model_validate(
            jsonable(
                target_evidence(
                    owner["target"],
                    dict(provenance) if provenance else None,
                    None,
                    # KEYWORD, not a third positional. The signature is
                    # `target_evidence(target, provenance, chip, *, ais_coverage=None)`, so the
                    # positional slot is the CHIP record and `ais_coverage` is keyword-only.
                    #
                    # An earlier version of this fix passed the coverage dict as the third
                    # positional, which put a coverage report into the chip slot and left the
                    # decision still reporting NOT_ESTABLISHED. Nothing failed: `chip` accepts a
                    # loose dict, so the mistake was silent and would have shipped a fix that
                    # fixed nothing. The route-level test below is what caught it, which is the
                    # argument for testing the WIRING rather than the function it calls.
                    ais_coverage={"state": str(coverage.state)},
                )
            )
        ),
    )


@router.get("/evidence/{target_id}", response_model=EvidenceDocumentResponse)
def get_evidence(
    target_id: str,
    state: State,
    scan_id: str | None = Query(default=None, description="Disambiguates repeated target ids."),
) -> EvidenceDocumentResponse:
    """The whole persisted record of the scan that owns the target (API-008).

    Note this is the SCAN RECORD, not the per-target evidence document that
    `/targets/{id}` serves: it carries every target in the scan. The two are
    typed separately (``ScanRecordDocument`` vs ``EvidenceDocument``) so the
    difference is declared instead of being a naming coincidence.
    """
    owners = _locate_target(state, target_id, scan_id)
    record = owners[0]["record"]
    return EvidenceDocumentResponse(
        scan_id=str(record.get("scan_id", "")),
        runtime_mode=str(record.get("runtime_mode", "REAL")),
        synthetic=bool(record.get("synthetic", False)),
        ambiguous=len(owners) > 1,
        candidate_scan_ids=[str(o["record"].get("scan_id", "")) for o in owners],
        evidence=ScanRecordDocument.model_validate(jsonable(record)),
    )


# ------------------------------------------------------- provider health


class _Probe(TypedDict):
    status: ProviderStatus
    detail: str
    latency_ms: float | None
    error: str | None
    capabilities: list[str]


def _probe_json(url: str, *, timeout: float = 20.0) -> tuple[int, Any]:
    """The single outbound call site of the health probe.

    Isolated in one function so tests can stub the network in exactly one place.
    """
    response = httpx.get(url, timeout=timeout)
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, None


def _http_failure(exc: Exception) -> _Probe:
    return _Probe(
        status=ProviderStatus.UNAVAILABLE,
        detail=f"endpoint unreachable: {type(exc).__name__}",
        latency_ms=None,
        error=redact(str(exc)),
        capabilities=[],
    )


def _probe_collections(url: str, provider: str, wanted: str) -> _Probe:
    """GET <catalog>/collections and look for ``wanted``."""
    started = time.perf_counter()
    try:
        code, payload = _probe_json(url)
    except httpx.HTTPError as exc:
        return _http_failure(exc)
    latency = round((time.perf_counter() - started) * 1000.0, 3)
    if code in (401, 403):
        return _Probe(
            status=ProviderStatus.AUTH_REQUIRED,
            detail=f"{provider} refused an anonymous catalog read (HTTP {code}).",
            latency_ms=latency,
            error=None,
            capabilities=[],
        )
    if code == 429:
        return _Probe(
            status=ProviderStatus.RATE_LIMITED,
            detail=f"{provider} rate-limited the health probe (HTTP 429).",
            latency_ms=latency,
            error=None,
            capabilities=[],
        )
    if code != 200 or not isinstance(payload, dict):
        return _Probe(
            status=ProviderStatus.UNAVAILABLE,
            detail=f"{provider} catalog returned HTTP {code}.",
            latency_ms=latency,
            error=f"unexpected catalog response (HTTP {code})",
            capabilities=[],
        )
    raw_collections = payload.get("collections")
    if not isinstance(raw_collections, list):
        return _Probe(
            status=ProviderStatus.UNAVAILABLE,
            detail=f"{provider} catalog returned an invalid collections document.",
            latency_ms=latency,
            error="catalog collections must be an array",
            capabilities=[],
        )
    collections = [str(entry.get("id", "")) for entry in raw_collections if isinstance(entry, dict)]
    if wanted in collections:
        return _Probe(
            status=ProviderStatus.AVAILABLE,
            detail=f"{provider} reachable; collection {wanted} published.",
            latency_ms=latency,
            error=None,
            capabilities=[wanted],
        )
    return _Probe(
        status=ProviderStatus.DEGRADED,
        detail=(
            f"{provider} reachable but publishes no {wanted} "
            f"({len(collections)} collections: {', '.join(collections[:10]) or 'none'})."
        ),
        latency_ms=latency,
        error=None,
        capabilities=[c for c in collections if c][:10],
    )


def _probe_planetary_computer(settings: Settings) -> _Probe:
    return _probe_collections(
        f"{settings.pc.stac_url.rstrip('/')}/collections", "planetary-computer", settings.pc.rtc_collection
    )


def _probe_earthsearch(settings: Settings) -> _Probe:
    probe = _probe_collections(
        f"{settings.earthsearch.stac_url.rstrip('/')}/collections",
        "earthsearch",
        settings.earthsearch.grd_collection,
    )
    if probe["status"] is ProviderStatus.AVAILABLE:
        return _Probe(
            status=ProviderStatus.DEGRADED,
            detail=(
                f"{probe['detail']} Assets are GCP-referenced, so only the GCP warp path applies."
            ),
            latency_ms=probe["latency_ms"],
            error=probe["error"],
            capabilities=probe["capabilities"],
        )
    return probe


def _probe_cdse() -> _Probe:
    """Reuse the repository's own CDSE probe; it really calls the catalog."""
    value, detail = cdse_sentinel1_status()
    return _Probe(
        status=value,
        detail=redact(detail),
        latency_ms=None,
        error=redact(detail) if value is not ProviderStatus.AVAILABLE else None,
        capabilities=[],
    )


def _probe_ais(data_dir: Path, settings: Settings) -> _Probe:
    """Probe the local AIS archive that REAL scans correlate against."""
    coverage = AisArchive(data_dir).coverage()
    observations = int(coverage.get("observations", 0))
    if observations > 0:
        return _Probe(
            status=ProviderStatus.AVAILABLE,
            detail=(
                f"local AIS archive holds {observations} observations over "
                f"{coverage.get('days', 0)} day(s); sources: "
                f"{', '.join(coverage.get('sources') or []) or 'unknown'}."
            ),
            latency_ms=None,
            error=None,
            capabilities=["local_archive"],
        )
    configured = bool(
        settings.ais.aistream_api_key or settings.ais.aishub_username or settings.ais.gfw_api_token
    )
    return _Probe(
        status=ProviderStatus.NOT_CONFIGURED,
        detail=(
            "no AIS partitions under <data_dir>/ais"
            + (" and no live AIS credential configured." if configured else " and no AIS credential configured.")
        ),
        latency_ms=None,
        error=None,
        capabilities=["live_credential"] if configured else [],
    )


@router.get("/providers/health", response_model=HealthResponse)
def provider_health(state: State) -> HealthResponse:
    """Live probe of every provider (API-007).

    Each status comes from an actual request (or an actual archive read) made
    just now. Credentials are never echoed: only status, detail, latency and a
    redacted error leave this endpoint.
    """
    checked_at = datetime.now(UTC)
    probes: list[tuple[str, _Probe]] = [
        ("planetary-computer", _probe_planetary_computer(state.settings)),
        ("earthsearch", _probe_earthsearch(state.settings)),
        ("cdse", _probe_cdse()),
        ("ais-local", _probe_ais(state.data_dir, state.settings)),
    ]
    return HealthResponse(
        checked_at=checked_at,
        runtime_mode=state.settings.runtime_mode,
        providers=[
            ProviderHealthEntry(
                provider=name,
                status=probe["status"],
                detail=redact(probe["detail"]),
                last_check=checked_at,
                latency_ms=probe["latency_ms"],
                error=probe["error"],
                capabilities=probe["capabilities"],
            )
            for name, probe in probes
        ],
    )


# ------------------------------------------------------------ debug layers


def _array_stats(array: np.ndarray) -> LayerStats:
    flat = np.asarray(array).ravel()
    finite = flat[np.isfinite(flat)] if flat.dtype.kind in "fc" else flat
    size = int(flat.size)
    finite_count = int(finite.size)

    def quantile(values: np.ndarray, q: float) -> float | None:
        if values.size == 0:
            return None
        return round(float(np.percentile(values.astype(np.float64), q)), 6)

    return LayerStats(
        size=size,
        min=round(float(finite.min()), 6) if finite_count else None,
        max=round(float(finite.max()), 6) if finite_count else None,
        mean=round(float(finite.mean()), 6) if finite_count else None,
        std=round(float(finite.std()), 6) if finite_count else None,
        p01=quantile(finite, 1.0),
        p50=quantile(finite, 50.0),
        p99=quantile(finite, 99.0),
        nan_count=size - finite_count,
        finite_fraction=round(finite_count / size, 6) if size else 0.0,
        true_count=int(flat.astype(bool).sum()) if flat.dtype.kind == "b" else None,
    )


def _downsample(array: np.ndarray, side: int) -> list[list[float]]:
    """Block-mean down to at most ``side`` x ``side`` cells. Never upsamples."""
    height, width = array.shape
    rows = min(side, height)
    cols = min(side, width)
    y_edges = np.linspace(0, height, rows + 1).astype(int)
    x_edges = np.linspace(0, width, cols + 1).astype(int)
    grid: list[list[float]] = []
    for y0, y1 in itertools.pairwise(y_edges):
        row: list[float] = []
        for x0, x1 in itertools.pairwise(x_edges):
            block = array[y0:y1, x0:x1].astype(np.float64)
            if block.size == 0:
                row.append(0.0)
                continue
            finite = block[np.isfinite(block)]
            row.append(round(float(finite.mean()), 6) if finite.size else 0.0)
        grid.append(row)
    return grid


@router.get("/debug/{scan_id}/{layer}", response_model=DebugLayerResponse)
def debug_layer(
    scan_id: str,
    layer: str,
    state: State,
    grid: int | None = Query(
        default=None, ge=2, le=_MAX_GRID, description="Side length of an optional block-mean grid."
    ),
    limit: int = Query(
        default=_MAX_TABLE_ROWS, ge=1, le=_MAX_TABLE_ROWS, description="Rows returned for table layers."
    ),
) -> DebugLayerResponse:
    """Compact summary of one debug layer (API-009, EVD-005).

    Arrays come back as statistics plus an optional downsampled grid; tables come
    back as a bounded row window. A giant raster is never serialised.
    """
    if layer not in DEBUG_LAYERS:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_DEBUG_LAYER",
            status_value="UNKNOWN_DEBUG_LAYER",
            message=f"Unknown debug layer {layer!r}. Known layers: {', '.join(DEBUG_LAYERS)}.",
            scan_id=scan_id,
            detail={"layers": list(DEBUG_LAYERS)},
        )
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No completed scan {scan_id!r}; debug layers are written at COMPLETE.",
            scan_id=scan_id,
        )
    if layer in _TARGET_TABLE_COLUMNS:
        return _target_table_layer(record, scan_id=scan_id, layer=layer, limit=limit)
    if layer in _CORRELATION_COLUMNS:
        return _correlation_debug_layer(record, scan_id=scan_id, layer=layer, limit=limit)
    key = _debug_cache_key(record)
    if key is None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="LAYERS_NOT_AVAILABLE",
            status_value="LAYERS_NOT_AVAILABLE",
            message=f"Scan {scan_id} carries no debug layer index.",
            scan_id=scan_id,
        )
    array = state.cache().get(key, layer)
    if array is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="LAYER_NOT_STORED",
            status_value="LAYER_NOT_STORED",
            message=f"Debug layer {layer!r} was not stored for {scan_id}.",
            scan_id=scan_id,
            detail={"available": list((record.get("debug") or {}).get("layers", []))},
        )
    notes: list[str] = []
    if layer == "normalized":
        notes.append(
            "normalized reports the calibrated dB grid (raw_db); the pipeline emits no "
            "separate radiometric-normalisation artifact."
        )
    if array.dtype.kind == "f":
        notes.append("non-finite pixels are excluded from the statistics and counted in nan_count.")
    return DebugLayerResponse(
        scan_id=scan_id,
        layer=layer,
        kind="array",
        source=_LAYER_SOURCE.get(layer),
        shape=[int(value) for value in array.shape],
        dtype=str(array.dtype),
        stats=_array_stats(array),
        grid_size=grid if array.ndim == 2 else None,
        grid=_downsample(array, grid) if grid and array.ndim == 2 else None,
        notes=notes,
    )


# ------------------------------------------------------------------ export


def _feature_properties(target: Mapping[str, Any], record: Mapping[str, Any]) -> dict[str, Any]:
    corr = target.get("corr") or {}
    return {
        "id": target.get("id"),
        "classification": target.get("cls"),
        "sar_confidence": target.get("sarConf"),
        "ais_confidence": target.get("aisConf"),
        "length_m": target.get("lenM"),
        "width_m": target.get("widM"),
        "length_uncertainty_m": target.get("lenUncM"),
        "heading_deg": target.get("hdg"),
        "mean_backscatter_db": target.get("meanDb"),
        "max_backscatter_db": target.get("maxDb"),
        "area_px": target.get("area"),
        "wake_evident": target.get("wake"),
        "mmsi": corr.get("mmsi"),
        "vessel_name": corr.get("vesselName"),
        "distance_offset_m": corr.get("distanceOffsetMeters"),
        "time_delta_s": corr.get("timeDeltaSeconds"),
        "assessment": target.get("assessment"),
        "tags": target.get("tags", []),
        "scan_id": record.get("scan_id"),
        "runtime_mode": record.get("runtime_mode"),
        "synthetic": bool(record.get("synthetic", False)),
    }


def _export_features(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    for target in record.get("targets") or []:
        if not isinstance(target, dict):
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    # GeoJSON is lon,lat -- the reverse of the internal ordering.
                    "coordinates": [float(target["lon"]), float(target["lat"])],
                },
                "properties": _feature_properties(target, record),
            }
        )
    return features


def _export_bbox(record: Mapping[str, Any], features: list[dict[str, Any]]) -> list[float]:
    aoi = record.get("aoi")
    if isinstance(aoi, list) and len(aoi) == 4:
        return [float(value) for value in aoi]
    lons = [f["geometry"]["coordinates"][0] for f in features]
    lats = [f["geometry"]["coordinates"][1] for f in features]
    if not lons:
        return []
    return [min(lons), min(lats), max(lons), max(lats)]


def _geojson_document(record: Mapping[str, Any]) -> dict[str, Any]:
    features = _export_features(record)
    return {
        "type": "FeatureCollection",
        "name": str(record.get("scan_id", "")),
        "bbox": _export_bbox(record, features),
        "generated_at": datetime.now(UTC).isoformat(),
        "runtime_mode": str(record.get("runtime_mode", "REAL")),
        "synthetic": bool(record.get("synthetic", False)),
        # RFC 7946 permits foreign members; provenance must travel with the file.
        "provenance": jsonable(record.get("provenance") or {}),
        "features": features,
    }


def _kml_document(record: Mapping[str, Any]) -> str:
    kml_ns = "http://www.opengis.net/kml/2.2"
    root = ElementTree.Element("kml", {"xmlns": kml_ns})
    document = ElementTree.SubElement(root, "Document")
    scan_id = str(record.get("scan_id", ""))
    ElementTree.SubElement(document, "name").text = (
        f"{scan_id} ({record.get('runtime_mode', 'REAL')}"
        f"{', SYNTHETIC' if record.get('synthetic') else ''})"
    )
    description = ElementTree.SubElement(document, "description")
    description.text = json.dumps(
        {
            "scan_id": scan_id,
            "runtime_mode": record.get("runtime_mode"),
            "synthetic": bool(record.get("synthetic", False)),
            "provenance": jsonable(record.get("provenance") or {}),
        },
        sort_keys=True,
    )
    for style_id, colour in (("matched", "ff00c853"), ("unmatched", "ffff9800")):
        style = ElementTree.SubElement(document, "Style", {"id": style_id})
        icon = ElementTree.SubElement(style, "IconStyle")
        ElementTree.SubElement(icon, "color").text = colour
    folder = ElementTree.SubElement(document, "Folder")
    ElementTree.SubElement(folder, "name").text = "targets"
    for feature in _export_features(record):
        properties = feature["properties"]
        style_id = (
            "matched" if properties.get("classification") == "SAR_MATCHED_AIS" else "unmatched"
        )
        placemark = ElementTree.SubElement(folder, "Placemark")
        ElementTree.SubElement(placemark, "name").text = (
            f"{properties['id']} {properties['classification']}"
        )
        ElementTree.SubElement(placemark, "styleUrl").text = f"#{style_id}"
        point = ElementTree.SubElement(placemark, "Point")
        coords = ElementTree.SubElement(point, "coordinates")
        lon, lat = feature["geometry"]["coordinates"]
        coords.text = f"{lon:.6f},{lat:.6f},0"
        extended = ElementTree.SubElement(placemark, "ExtendedData")
        for key, value in properties.items():
            data = ElementTree.SubElement(
                extended, "Data", {"name": str(key)}
            )
            ElementTree.SubElement(data, "value").text = json.dumps(value)
    return ElementTree.tostring(root, encoding="unicode", xml_declaration=True)


@router.get("/scans/{scan_id}/export/{fmt}")
def export_scan(scan_id: str, fmt: str, state: State) -> Response:
    """Export a completed scan (API-010).

    ``geojson``, ``kml`` and ``json`` are served with full provenance. ``png`` and
    ``pdf`` are rendered SERVER-SIDE from the persisted record and the stored
    raster layers, so an exported artefact carries the same provenance as the
    API response -- never a browser screenshot.
    """
    requested = fmt.strip().lower()
    if requested in DEFERRED_EXPORT_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=ExportFormatNotImplemented(
                message=(
                    f"{requested.upper()} export is not implemented. "
                    f"Use one of: {', '.join(SUPPORTED_EXPORT_FORMATS)}."
                ),
                requested_format=requested,
            ).model_dump(),
        )
    if requested not in SUPPORTED_EXPORT_FORMATS:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="BAD_EXPORT_FORMAT",
            status_value="BAD_EXPORT_FORMAT",
            message=f"Unknown export format {fmt!r}. Supported: {', '.join(SUPPORTED_EXPORT_FORMATS)}.",
            scan_id=scan_id,
            detail={"supported": list(SUPPORTED_EXPORT_FORMATS)},
        )
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        job = state.runner.get(scan_id)
        if job is not None and not is_terminal(job.stage):
            raise api_error(
                status.HTTP_409_CONFLICT,
                error="SCAN_NOT_READY",
                status_value="SCAN_NOT_READY",
                message=f"Scan {scan_id} is still {job.stage.value}; export needs a completed scan.",
                scan_id=scan_id,
            )
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No persisted scan {scan_id!r} to export.",
            scan_id=scan_id,
        )
    filename = f"{scan_id}.{requested}"
    if requested == "geojson":
        body = json.dumps(_geojson_document(record), indent=2, sort_keys=True, default=str)
        return Response(
            content=body,
            media_type=_GEOJSON_MEDIA_TYPE,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    if requested == "kml":
        return Response(
            content=_kml_document(record),
            media_type=_KML_MEDIA_TYPE,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    if requested == "png":
        return Response(
            content=_render_png(record, scan_id=scan_id, state=state),
            media_type="image/png",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    if requested == "pdf":
        return Response(
            content=_render_pdf(record, scan_id=scan_id),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return Response(
        content=json.dumps(jsonable(record), indent=2, sort_keys=True, default=str),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _export_layers(record: Mapping[str, Any], state: State) -> tuple[np.ndarray, np.ndarray, list[tuple[float, float]]]:
    """Fetch the stored raster layers an image export needs.

    Raises 409 when the layers were not retained, because a PNG of an empty
    frame would look like a scene with no returns in it.
    """
    key = _debug_cache_key(record)
    if key is None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="LAYERS_NOT_AVAILABLE",
            status_value="LAYERS_NOT_AVAILABLE",
            message=f"Scan {record.get('scan_id')} carries no debug layer index, so it cannot be rendered.",
        )
    db = state.cache().get(key, "raw")
    land = state.cache().get(key, "landmask")
    components = state.cache().get(key, "components")
    if db is None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            error="LAYERS_NOT_AVAILABLE",
            status_value="LAYERS_NOT_AVAILABLE",
            message=f"The raster for {record.get('scan_id')} is no longer in the cache, so it cannot be rendered.",
        )
    valid = (
        np.isfinite(np.asarray(db, dtype=np.float64))
        if land is None
        else np.isfinite(np.asarray(db, dtype=np.float64)) & ~np.asarray(land, dtype=bool)
    )
    centroids: list[tuple[float, float]] = []
    if components is not None:
        for row in np.asarray(components).tolist():
            if len(row) >= 4:
                centroids.append((float(row[2]), float(row[3])))
    return np.asarray(db, dtype=np.float64), valid, centroids


def _render_png(record: Mapping[str, Any], *, scan_id: str, state: State) -> bytes:
    db, valid, centroids = _export_layers(record, state)
    return render_png(
        scan_id=scan_id,
        db=db,
        valid=valid,
        centroids=centroids,
        provenance=dict(record.get("provenance") or {}),
        title=(
            f"{record.get('scene', {}).get('provider', '?')} / "
            f"{record.get('aoi') and ', '.join(f'{v:.3f}' for v in record['aoi'])}"
        ),
    )


def _render_pdf(record: Mapping[str, Any], *, scan_id: str) -> bytes:
    return render_pdf(
        scan_id=scan_id,
        title=f"AOI {record.get('aoi')}",
        scene=dict(record.get("scene") or {}),
        provenance=dict(record.get("provenance") or {}),
        targets=[t for t in (record.get("targets") or []) if isinstance(t, dict)],
        ais_only=[t for t in (record.get("ais_only") or []) if isinstance(t, dict)],
    )


def _as_datetime(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


# -------------------------------------------------- multi-pass intelligence
#
# CP15. These surfaces read the persisted scan history and add NOTHING to the
# detection result. A track is a hypothesis; a pattern is a hypothesis; both are
# reported with their contradicting evidence intact.


def _target_table_layer(
    record: Mapping[str, Any], *, scan_id: str, layer: str, limit: int
) -> DebugLayerResponse:
    """Serve `components` / `centroids` from the scan record, one row per target.

    Read from the record rather than from the cached float array, because the link
    to a target has to be an ID. A float64 `(n, k)` array cannot hold a string,
    so the correspondence was positional -- and a positional link cannot survive a
    filter, a sort, or a different ordering on either side. A frontend handed row
    3 could only guess which target it belonged to, and the natural guess
    (nearest point) is exactly the manufactured relation this product refuses to
    invent.

    The pixel centroid is GEO-CORR's own sub-pixel measurement, carried through
    verbatim: not re-derived here, not rounded. The frontend maps these numbers
    into display space; the coordinate itself still comes from the probe route.
    """
    columns = list(_TARGET_TABLE_COLUMNS[layer])
    targets = [t for t in (record.get("targets") or []) if isinstance(t, dict)]

    data: list[dict[str, Any]] = []
    for target in targets:
        centroid = target.get("geo_pixel_centroid")
        centroid = centroid if isinstance(centroid, (list, tuple)) and len(centroid) >= 2 else None
        pixel_col = float(centroid[0]) if centroid else None
        pixel_row = float(centroid[1]) if centroid else None
        if layer == "components":
            data.append(
                {
                    "target_id": target.get("id"),
                    "classification": target.get("cls"),
                    "area_px": target.get("area"),
                    "mean_db": target.get("meanDb"),
                    "max_db": target.get("maxDb"),
                    "sar_conf": target.get("sarConf"),
                    "ais_conf": target.get("aisConf"),
                    "pixel_row": pixel_row,
                    "pixel_col": pixel_col,
                }
            )
        else:
            data.append(
                {
                    "target_id": target.get("id"),
                    "classification": target.get("cls"),
                    "pixel_row": pixel_row,
                    "pixel_col": pixel_col,
                    "lat": target.get("lat"),
                    "lon": target.get("lon"),
                    "geo_centre_offset": target.get("geo_centre_offset"),
                }
            )

    total = len(data)
    returned = min(total, limit)
    notes = [
        (
            "one row per detected component, keyed by the final target id; the link is "
            "the id, never row order"
        ),
        (
            "pixel_row/pixel_col are GEO-CORR sub-pixel centroids in the window raster; "
            "they are never rounded and never re-derived here"
        ),
        f"full values in GET /api/scans/{scan_id}/targets",
    ]
    if returned < total:
        notes.append(f"showing {returned} of {total} row(s)")
    if not total:
        notes.append(
            f"no target in this scan carries {layer!r} data; the layer is empty, "
            "which is different from unavailable"
        )

    return DebugLayerResponse(
        scan_id=scan_id,
        layer=layer,
        kind="table",
        source="targets",
        shape=[total],
        dtype="object",
        columns=columns,
        rows=total,
        row_limit=returned,
        truncated=returned < total,
        data=data[:returned],
        notes=notes,
    )


def _correlation_debug_layer(
    record: Mapping[str, Any], *, scan_id: str, layer: str, limit: int
) -> DebugLayerResponse:
    """Serve a correlation layer from the record's own score decomposition.

    A row is emitted only for a target that actually carries the field. A target
    with no AIS association contributes no row, and the count of those is stated
    in a note rather than being padded into a row of nulls -- a null position
    would be one more thing a reader could mistake for a measurement, and a
    fabricated match radius would be worse.

    Note that this function used to *count* eligible rows and return none of
    them, so ``kind="table"`` and ``limit`` were promises the payload did not
    keep. The rows are now built here.
    """
    columns = list(_CORRELATION_COLUMNS[layer])
    targets = [t for t in (record.get("targets") or []) if isinstance(t, dict)]
    notes: list[str] = [
        (
            "built from the persisted correlation result, not from a rendering; "
            f"one row per target; full values in GET /api/scans/{scan_id}/targets"
        )
    ]
    unassociated = 0
    data: list[dict[str, Any]] = []
    for target in targets:
        corr = target.get("corr")
        corr = corr if isinstance(corr, dict) else {}
        decomposition = corr.get("scoreDecomposition")
        decomposition = decomposition if isinstance(decomposition, dict) else {}
        has_mmsi = bool(corr.get("mmsi"))
        if not has_mmsi:
            unassociated += 1
        row = _correlation_row(layer, target, corr, decomposition, has_mmsi)
        if row is not None:
            data.append(row)

    total = len(data)
    if unassociated:
        notes.append(
            f"{unassociated} of {len(targets)} target(s) had no AIS association and "
            "are absent from this layer; that is a data-availability fact, not a "
            "finding about the vessel."
        )
    if not total:
        notes.append(
            f"no target in this scan carries {layer!r} data; the layer is empty, "
            "which is different from unavailable"
        )

    returned = min(total, limit)
    window = data[:returned]
    if returned < total:
        notes.append(
            f"showing {returned} of {total} row(s); the full set is in "
            f"GET /api/scans/{scan_id}/targets"
        )

    return DebugLayerResponse(
        scan_id=scan_id,
        layer=layer,
        kind="table",
        source="correlation",
        shape=[total],
        dtype="object",
        columns=columns,
        rows=total,
        row_limit=returned,
        truncated=returned < total,
        data=window,
        notes=notes,
    )


def _correlation_row(
    layer: str,
    target: Mapping[str, Any],
    corr: Mapping[str, Any],
    decomposition: Mapping[str, Any],
    has_mmsi: bool,
) -> dict[str, Any] | None:
    """One row of a correlation layer, or ``None`` when the target has no data.

    Every value is read from the persisted correlation result. A missing field
    stays ``None``: the row exists because the association was made, and an
    absent sub-score is an absent measurement, not a zero contribution.
    """
    target_id = target.get("id")
    mmsi = corr.get("mmsi")

    if layer == "ais_observations":
        if not has_mmsi:
            return None
        # The observed fix behind the association. Taken from the record's own
        # AIS delivery rather than re-derived, so this table can never disagree
        # with what the correlation actually consumed.
        observation = (target.get("ais") or {}).get("observation") if isinstance(
            target.get("ais"), dict
        ) else None
        observation = observation if isinstance(observation, dict) else {}
        return {
            "target_id": target_id,
            "mmsi": mmsi,
            "observed_lat": observation.get("lat"),
            "observed_lon": observation.get("lon"),
            "observed_at": observation.get("timestamp"),
        }

    if layer == "ais_predicted":
        if corr.get("predictedLat") is None:
            return None
        return {
            "target_id": target_id,
            "mmsi": mmsi,
            "predicted_lat": corr.get("predictedLat"),
            "predicted_lon": corr.get("predictedLon"),
        }

    if layer == "match_radius":
        if decomposition.get("matchRadiusMeters") is None:
            return None
        return {"target_id": target_id, "match_radius_m": decomposition["matchRadiusMeters"]}

    if layer == "correlation_lines":
        if not has_mmsi:
            return None
        return {
            "target_id": target_id,
            "mmsi": mmsi,
            "distance_offset_m": corr.get("distanceOffsetMeters"),
            "time_delta_s": corr.get("timeDeltaSeconds"),
        }

    if layer == "score_decomposition":
        if not decomposition:
            return None
        return {
            "target_id": target_id,
            "distance_score": decomposition.get("spatialScore"),
            "time_score": decomposition.get("temporalScore"),
            "heading_score": decomposition.get("headingScore"),
            "size_score": decomposition.get("sizeScore"),
            "total_score": decomposition.get("compositeScore"),
        }

    return None


def _observations(state: State, *, max_scans: int) -> list[dict[str, Any]]:
    """Flatten the stored scan history into the observation shape tracks use.

    Only AIS-ASSOCIATED detections can form a track, so unmatched rows are kept
    in the list (the pattern engine needs them) but the track builder refuses
    them. Nothing is invented here: every field comes straight from a record.
    """
    records = sorted(state.store.list(), key=_scan_sort_key, reverse=True)[:max_scans]
    rows: list[dict[str, Any]] = []
    for record in records:
        acq = str(record.get("acquisition_time", ""))
        scan_id = str(record.get("scan_id", ""))
        for target in record.get("targets") or []:
            if not isinstance(target, dict):
                continue
            corr = target.get("corr")
            corr = corr if isinstance(corr, dict) else {}
            rows.append(
                {
                    "scan_id": scan_id,
                    "item_id": scan_id,
                    "acquisition_time": acq,
                    "lat": target.get("lat"),
                    "lon": target.get("lon"),
                    "sar_conf": target.get("sarConf"),
                    "classification": target.get("cls"),
                    "apparent_length_m": target.get("lenM"),
                    "length_unc_m": target.get("lenUncM"),
                    "correlated_mmsi": corr.get("mmsi"),
                    "ais_confidence": target.get("aisConf"),
                }
            )
    return rows


@router.get("/revisit", response_model=RevisitPlanOut)
def revisit_plan(
    state: State,
    bbox: str = Query(description="Comma separated min_lon,min_lat,max_lon,max_lat."),
    provider: str = Query(default="planetary-computer"),
    history_days: int = Query(default=120, ge=1, le=730),
    horizon_days: int = Query(default=30, ge=0, le=180),
) -> RevisitPlanOut:
    """SAR acquisition plan for an area (GEO-002).

    Answers "when can this water actually be imaged, and where are the gaps?"
    from the provider catalogue rather than an orbit prediction, so every number
    is measured from acquisitions that genuinely exist.

    A provider failure is an explicit 5xx with the real cause. There is no
    simulated plan and no predicted pass.
    """
    if provider not in KNOWN_PROVIDERS:
        raise _unknown_provider(provider)
    box = _parse_bbox_query(bbox)
    start, end = revisit_window(history_days=history_days, horizon_days=horizon_days)
    conf = state.settings
    collection = (
        conf.pc.rtc_collection if provider == "planetary-computer" else conf.earthsearch.grd_collection
    )
    url = conf.pc.stac_url if provider == "planetary-computer" else conf.earthsearch.stac_url
    try:
        items = stac_items(url, collection, box, f"{start}/{end}", limit=200)
    except RealDataUnavailableError as exc:
        raise _unavailable(exc, provider) from exc

    plan = plan_revisit(
        acquisitions_from_items(items),
        window_start=datetime.fromisoformat(start),
        window_end=datetime.fromisoformat(end),
    )
    # Returned as a model rather than a hand-built Response so response_model
    # actually validates the payload. Wrapping in Response() skips validation
    # entirely, which is exactly how a payload drifts from its own contract
    # unnoticed.
    return RevisitPlanOut(
        **{
            **plan.to_dict(),
            "provider": provider,
            "collection": collection,
            "requested_bbox": list(box),
        }
    )


@router.get("/tracks", response_model=TracksOut)
def list_tracks(
    state: State,
    max_scans: int = Query(default=50, ge=1, le=500),
) -> TracksOut:
    """Multi-pass track HYPOTHESES across the persisted history (ADV-001..003).

    Never claims a confirmed identity, and never links a detection that had no
    AIS association. A single stored scan legitimately yields zero tracks.
    """
    observations = [r for r in _observations(state, max_scans=max_scans) if r["lat"] is not None]
    tracks = build_tracks(observations)
    return TracksOut(
        scans_considered=len({o["scan_id"] for o in observations}),
        observations_considered=len(observations),
        track_count=len(tracks),
        tracks=[TrackHypothesisOut(**t.to_dict()) for t in tracks],
        note=(
            "Tracks are hypotheses built from reported AIS identity, not from "
            "geometry alone. DarkFleet does not confirm vessel identity."
        ),
    )


@router.get("/patterns", response_model=PatternsOut)
def list_patterns(
    state: State,
    max_scans: int = Query(default=50, ge=1, le=500),
) -> PatternsOut:
    """Longitudinal behaviour PATTERNS (ADV-009/010).

    Each pattern carries its observation, a hypothesis, a bounded confidence and
    the explicit unknowns. A pattern is something to investigate, never a finding
    about intent.
    """
    observations = [r for r in _observations(state, max_scans=max_scans) if r["lat"] is not None]
    patterns = temporal_analyse(observations)
    return PatternsOut(
        scans_considered=len({o["scan_id"] for o in observations}),
        observations_considered=len(observations),
        pattern_count=len(patterns),
        patterns=[PatternOut(**p.to_dict()) for p in patterns],
        note=(
            "Patterns describe data coverage and correlation outcomes. A missing "
            "AIS association is a coverage fact and is not evidence of conduct."
        ),
    )


@router.get("/detectors", response_model=DetectorsOut)
def list_detectors() -> DetectorsOut:
    """The detector registry (ADV-007/008).

    An ML or ensemble detector without weights and validation is refused at
    registration, so it can never appear here as an available detector.
    """
    registry = DetectorRegistry()
    return DetectorsOut(
        default=registry.resolve().card.name,
        detectors=[
            DetectorCardOut(
                name=card.name,
                kind=card.kind,
                training_domain=card.training_domain,
                input_product=card.input_product,
                validation_data=card.validation_data,
                limitations=card.limitations,
                weights_digest=card.weights_digest,
            )
            for card in registry.available()
        ],
        note=(
            "CA-CFAR is the shipped baseline. No trained weights ship with "
            "DarkFleet; an adapter must declare its training domain and "
            "validation before it can be registered."
        ),
    )


@router.get("/targets/{target_id}/summary", response_model=TargetSummaryResponse)
def summarise_target(
    target_id: str,
    state: State,
    scan_id: str | None = Query(default=None),
    model_id: str | None = Query(default=None),
) -> TargetSummaryResponse:
    """Optional narrative over an existing evidence document (ADV-011/012).

    The evidence document is always returned. The narrative is additive: when it
    is unavailable the caller still has every deterministic observation, and the
    response says so explicitly instead of substituting prose.

    Typed rather than returning `dict[str, Any]` (DF-X7V section 42). An
    untyped response generates no OpenAPI schema, no TypeScript type and no
    validator keys, so a change to this payload could not be detected by any
    consumer -- the contract existed only as a convention nobody could check.

    `evidence` is the same declared document `/targets/{id}` serves, so a change
    to either route's payload is a schema change both routes inherit.
    """
    owners = _locate_target(state, target_id, scan_id)
    owner = owners[0]
    provenance = owner["record"].get("provenance") or None
    evidence = target_evidence(
        owner["target"],
        dict(provenance) if provenance else None,
        owner["target"].get("sar_chip"),
    )
    narrative = summarise(evidence, model_id=model_id)
    return TargetSummaryResponse.model_validate(
        {
            "scan_id": str(owner["record"].get("scan_id", "")),
            "target_id": target_id,
            "classification": owner["target"].get("cls"),
            "ambiguous": len(owners) > 1,
            "evidence": jsonable(evidence),
            "narrative": narrative,
        }
    )

# =====================================================================
# AIS DELIVERY (GREEN-3)
#
# The archive already existed and was queryable; nothing exposed it. These
# routes add delivery over the SAME store -- there is deliberately no second
# AIS persistence path.
#
# Every response carries a coverage block. A panel that cannot distinguish
# "no observations" from "no source covers this place and time" will
# eventually render an unobserved ocean as an empty one, which is the specific
# failure this design refuses.
# =====================================================================


def _scan_ais_window(record: dict[str, Any], fallback_iso: str | None) -> ScanAisWindow | None:
    """The acquisition window a scan correlated AIS over.

    Taken from the scan's own recorded acquisition time so the delivered
    observations and the correlation decision are drawn over the same instants.
    Falls back to `fallback_iso` (the record's scene metadata) and finally to
    None, which is reported rather than invented.
    """
    raw = record.get("acquisition_time") or fallback_iso
    if not raw:
        return None
    try:
        moment = as_utc(str(raw))
    except (ValueError, TypeError):
        return None
    if moment is None:
        return None
    delta = timedelta(seconds=AIS_WINDOW_SECONDS)
    return ScanAisWindow(start=moment - delta, end=moment + delta)


def _archive_for(state: State) -> AisArchive:
    return AisArchive(state.data_dir)


def _ais_coverage_report(state: State) -> AisCoverageOut:
    """What the local AIS archive can and cannot speak to. Probes nothing external.

    EXTRACTED (DF-X9.4R) so that the ghost-vessel decision record can carry the SAME coverage
    state the `/ais/coverage` route reports.

    It was previously computed only inside that route, and the `/targets/{id}` route passed a
    hardcoded `None` for `ais_coverage`. So `decision.ais_coverage_state` was the constant
    `"NOT_ESTABLISHED"` for every target in the product, whatever the archive actually held --
    which is the DF-X7 defect in a new place: "there is no AIS source" and "there is a source but
    no vessel near this target" both rendered as the same uninformative absence, and the operator
    could not tell a deployment with no AIS from a target with no match.

    One computation, two consumers. A second implementation of this would be free to disagree
    with the first, and the disagreement would be invisible.
    """
    archive = _archive_for(state)
    report = archive.coverage()
    observations = int(report.get("observations", 0) or 0)
    oldest = report.get("oldest")
    newest = report.get("newest")
    if observations == 0 or not oldest or not newest:
        return AisCoverageOut(
            state=AisCoverageState.NOT_CONFIGURED,
            detail=(
                "No AIS archive is present in this deployment. AIS history is "
                "unavailable, which is not the same as an empty sea."
            ),
            sources=[],
        )
    return AisCoverageOut(
        state=AisCoverageState.AVAILABLE,
        detail=(
            f"Local AIS archive holds {observations} observation(s) from "
            f"{len(report.get('sources') or [])} source(s), {oldest} to {newest}."
        ),
        observation_count=observations,
        archive_oldest=report.get("oldest"),
        archive_newest=report.get("newest"),
        sources=[str(s) for s in (report.get("sources") or [])],
    )


@router.get("/ais/coverage", response_model=AisCoverageOut)
def ais_coverage(state: State) -> AisCoverageOut:
    """What the AIS archive can and cannot speak to. Probes nothing external."""
    return _ais_coverage_report(state)


@router.get("/scans/{scan_id}/ais", response_model=ScanAisResponse)
def scan_ais(scan_id: str, state: State) -> ScanAisResponse:
    """AIS observations behind one scan: its AOI, over its correlation window."""
    record = _safe_store_get(state.store, scan_id)
    if record is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="UNKNOWN_SCAN",
            message=f"No persisted scan {scan_id!r}; a completed scan is required.",
            scan_id=scan_id,
        )

    scene = dict(record.get("scene") or {})
    window = _scan_ais_window(record, scene.get("acquisition_time"))
    bbox = record.get("aoi")
    box = tuple(float(v) for v in bbox) if isinstance(bbox, (list, tuple)) and len(bbox) == 4 else None

    archive = _archive_for(state)
    if window is None:
        return ScanAisResponse(
            scan_id=scan_id,
            coverage=AisCoverageOut(
                state=AisCoverageState.NO_COVERAGE,
                detail=(
                    "No acquisition time is recorded for this scan, so no AIS "
                    "window can be formed. No observation count is reported."
                ),
            ),
            bbox=box,  # type: ignore[arg-type]
            observations=[],
            note="No AIS window could be derived from this record.",
        )

    rows = archive.query(window.start, window.end, bbox=box)  # type: ignore[arg-type]
    delivered: list[AisObservationOut] = []
    for row in rows:
        try:
            delivered.append(to_out(row))
        except ValueError:
            continue
    return ScanAisResponse(
        scan_id=scan_id,
        coverage=coverage_for(archive, window.start, window.end, len(delivered)),
        window=window,
        bbox=box,  # type: ignore[arg-type]
        observations=delivered,
        note=(
            "Observed AIS positions only. Nothing here is a prediction: a "
            "propagated position is a hypothesis derived from speed and course, "
            "and is never returned by this endpoint."
        ),
    )


@router.get("/targets/{target_id}/ais-observations", response_model=TargetAisResponse)
def target_ais_observations(
    target_id: str,
    state: State,
    scan_id: str | None = Query(default=None, description="Disambiguates repeated target ids."),
) -> TargetAisResponse:
    """The observations behind the MMSI correlation actually associated.

    When the target has no association this returns zero observations and
    `associated: false`. It never substitutes a nearby vessel: a different
    MMSI is a different claim.
    """
    owners = _locate_target(state, target_id, scan_id)
    owner = owners[0]
    target = owner["target"]
    record = owner["record"]

    corr = dict(target.get("corr") or {})
    mmsi = corr.get("mmsi")
    window = _scan_ais_window(dict(record), dict(record.get("scene") or {}).get("acquisition_time"))

    archive = _archive_for(state)
    if not mmsi:
        return TargetAisResponse(
            target_id=target_id,
            mmsi=None,
            associated=False,
            coverage=coverage_for(archive, window.start, window.end, None) if window else AisCoverageOut(
                state=AisCoverageState.NO_COVERAGE,
                detail="No acquisition time is recorded, so no AIS window can be formed.",
            ),
            window=window,
            observations=[],
            note=(
                "This target has no AIS association. That is a measurement about "
                "correlation, not a finding about the vessel."
            ),
        )

    if window is None:
        return TargetAisResponse(
            target_id=target_id,
            mmsi=str(mmsi),
            associated=True,
            coverage=AisCoverageOut(
                state=AisCoverageState.NO_COVERAGE,
                detail="No acquisition time is recorded, so no AIS window can be formed.",
            ),
            observations=[],
            note="No acquisition window available for this target.",
        )

    rows = archive.query(window.start, window.end, mmsi=str(mmsi))
    delivered: list[AisObservationOut] = []
    for row in rows:
        try:
            delivered.append(to_out(row))
        except ValueError:
            continue
    return TargetAisResponse(
        target_id=target_id,
        mmsi=str(mmsi),
        associated=True,
        coverage=coverage_for(archive, window.start, window.end, len(delivered)),
        window=window,
        observations=delivered,
        note="Observed positions only. Association confidence is reported on the target.",
    )


@router.get("/vessels/{mmsi}/track", response_model=VesselTrackResponse)
def vessel_track(mmsi: str, state: State) -> VesselTrackResponse:
    """One vessel's observed history from the local AIS archive."""
    normalised = str(mmsi).strip()
    if len(normalised) != 9 or not normalised.isdigit():
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="INVALID_MMSI",
            status_value="INVALID_MMSI",
            message=(
                f"{mmsi!r} is not a 9-digit MMSI. No track can be looked up for an "
                "identifier that cannot exist."
            ),
            detail={"mmsi": mmsi},
        )

    archive = _archive_for(state)
    report = archive.coverage()
    oldest = as_utc(report.get("oldest"))
    newest = as_utc(report.get("newest"))
    if not report.get("observations") or oldest is None or newest is None:
        return VesselTrackResponse(
            mmsi=normalised,
            coverage=AisCoverageOut(
                state=AisCoverageState.NOT_CONFIGURED,
                detail=(
                    "No AIS archive is present in this deployment. A vessel history "
                    "is unavailable, which is not evidence that the vessel never "
                    "broadcast."
                ),
            ),
            observations=[],
            note="AIS history is unavailable in this deployment.",
        )

    # Pad by a day either side so an observation stamped exactly on the archive
    # boundary is not silently dropped by an inclusive-range edge effect.
    rows = archive.query(
        oldest - timedelta(days=1),
        newest + timedelta(days=1),
        mmsi=normalised,
    )
    delivered: list[AisObservationOut] = []
    for row in rows:
        try:
            delivered.append(to_out(row))
        except ValueError:
            continue
    identity = identity_from(delivered)
    return VesselTrackResponse(
        mmsi=normalised,
        coverage=coverage_for(archive, oldest, newest, len(delivered)),
        observations=delivered,
        note=(
            "Observed positions in archive time order. Unreported fields are null "
            "and are not inferred from adjacent observations."
        ),
        **identity,
    )
