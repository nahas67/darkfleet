"""HTTP routers for DarkFleet (API-001..012).

This module is the adapter between the web and the engine. It owns:

* the request/response wiring for every endpoint;
* the adapter from :func:`darkfleet.pipeline.run_scan` (an ``on_stage`` callback)
  to :class:`darkfleet.jobs.runner.ScanRunner` (a generator of transitions);
* persisting completed scans through :class:`darkfleet.storage.runs.RunStore`
  before the job is allowed to report ``COMPLETE``;
* **live** provider probing for ``/api/providers/health`` -- a status is the
  result of a real request, never of reading an environment variable;
* the DEMO/REAL isolation guard: in REAL a provider failure is an explicit error
  carrying a :class:`~darkfleet.providers.ProviderStatus` value, and there is no
  code path from REAL into DEMO data.
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
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Final, TypedDict, cast
from xml.etree import ElementTree

import httpx
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from darkfleet import __processing_version__, __version__
from darkfleet.ais.archive import AisArchive
from darkfleet.api.models import (
    DEFERRED_EXPORT_FORMATS,
    SUPPORTED_EXPORT_FORMATS,
    ApiError,
    DebugLayerResponse,
    EvidenceDocumentResponse,
    ExportFormatNotImplemented,
    HealthResponse,
    LayerStats,
    ProviderHealthEntry,
    ScanAccepted,
    ScanCreateRequest,
    ScanStateResponse,
    ScanTargetsResponse,
    SceneListResponse,
    SceneSummary,
    StageEventOut,
    TargetEvidenceResponse,
    jsonable,
)
from darkfleet.config.settings import Settings
from darkfleet.detectors import DetectorRegistry
from darkfleet.evidence import target_evidence
from darkfleet.exports.render import render_pdf, render_png
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
)
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

#: Table columns for the derived (non-array) layers.
_LAYER_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    "components": ("area_px", "mean_db", "max_db", "sar_conf", "ais_conf"),
    "centroids": ("lat", "lon"),
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

_SSE_MEDIA_TYPE = "text/event-stream"
_KML_MEDIA_TYPE = "application/vnd.google-earth.kml+xml"
_GEOJSON_MEDIA_TYPE = "application/geo+json"
_MAX_TABLE_ROWS: Final[int] = 500
_MAX_GRID: Final[int] = 96

#: DEMO scene catalogue. These are the only scenes the synthetic pipeline knows;
#: each carries ``synthetic=True`` and is never mixed with REAL results.
DEMO_SCENES: Final[tuple[dict[str, Any], ...]] = (
    {
        "id": "SIM-S1C-MALACCA-001",
        "platform": "Sentinel-1C",
        "polarization": "VV+VH",
        "acquisitionTime": "2026-09-18T14:32:18Z",
        "resolutionMeters": 10,
        "bbox": [103.65, 1.10, 104.05, 1.40],
        "seaClutterLevel": "MODERATE",
    },
    {
        "id": "SIM-S1A-HORMUZ-002",
        "platform": "Sentinel-1A",
        "polarization": "VV",
        "acquisitionTime": "2026-09-18T09:14:02Z",
        "resolutionMeters": 10,
        "bbox": [56.30, 26.40, 56.90, 26.90],
        "seaClutterLevel": "HIGH",
    },
    {
        "id": "SIM-S1A-ADEN-003",
        "platform": "Sentinel-1A",
        "polarization": "VV",
        "acquisitionTime": "2026-09-17T21:47:55Z",
        "resolutionMeters": 10,
        "bbox": [47.50, 11.90, 48.30, 12.40],
        "seaClutterLevel": "LOW",
    },
)

#: Query keys whose values must never reach a response or a log line.
_SECRET_RE: Final[re.Pattern[str]] = re.compile(
    r"(?i)\b((?:sas|token|key|secret|password|passwd|credential|authorization)[a-z_]*)"
    r"\s*[=:]\s*([^\s,;&\"']+)"
)


def redact(text: str) -> str:
    """Blank out anything shaped like ``key=value`` credentials."""
    return _SECRET_RE.sub(lambda m: f"{m.group(1)}=<redacted>", str(text))


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
            provider=provider,
            scan_id=scan_id,
            detail=dict(detail or {}),
            suggestions=list(suggestions or []),
        ).model_dump(),
    )


def _unavailable(exc: RealDataUnavailableError, provider: str) -> HTTPException:
    """A provider failure, as an explicit response. Never a DEMO fallback."""
    status_value = _provider_status(exc)
    return api_error(
        _provider_http_code(status_value),
        error="REAL_DATA_UNAVAILABLE",
        status_value=status_value.value,
        message=str(exc),
        provider=provider,
        detail={key: jsonable(value) for key, value in exc.details.items()},
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
        "resolutionMeters": asset.resolution_meters or 10.0,
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
        runtime_mode="DEMO" if runtime_mode == "DEMO" else "REAL",
        synthetic=runtime_mode == "DEMO",
    )


def _demo_scene_summary(scene: Mapping[str, Any]) -> SceneSummary:
    return SceneSummary(
        id=str(scene["id"]),
        provider="demo-synthesizer",
        platform=str(scene["platform"]),
        product="SIM",
        polarization=str(scene["polarization"]),
        acquisition_time=str(scene["acquisitionTime"]),
        bbox=[float(value) for value in scene["bbox"]],
        resolution_meters=float(scene["resolutionMeters"]),
        georeferencing="DEMO_GRID",
        sea_clutter_level=str(scene.get("seaClutterLevel", "MODERATE")),
        runtime_mode="DEMO",
        synthetic=True,
    )


def _resolve_demo_scene(scene_id: str | None, bbox: tuple[float, float, float, float]) -> Mapping[str, Any]:
    """Pick the DEMO scene, refusing a bbox the synthetic scene does not cover."""
    if scene_id is None:
        scene = DEMO_SCENES[0]
    else:
        matches = [s for s in DEMO_SCENES if s["id"] == scene_id]
        if not matches:
            raise api_error(
                status.HTTP_400_BAD_REQUEST,
                error="UNKNOWN_SCENE",
                status_value="UNKNOWN_SCENE",
                message=f"Unknown DEMO scene {scene_id!r}.",
                detail={"known_scenes": [s["id"] for s in DEMO_SCENES]},
                suggestions=["List DEMO scenes with GET /api/scenes."],
            )
        scene = matches[0]
    scene_bbox = (
        float(scene["bbox"][0]),
        float(scene["bbox"][1]),
        float(scene["bbox"][2]),
        float(scene["bbox"][3]),
    )
    if tuple(round(value, 6) for value in bbox) != tuple(round(value, 6) for value in scene_bbox):
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            error="BBOX_SCENE_MISMATCH",
            status_value="INVALID_REQUEST",
            message=(
                f"DEMO scene {scene['id']} defines its own footprint "
                f"{list(scene_bbox)}; request bbox {list(bbox)} does not match. "
                "DEMO synthesis is deterministic per scene, so the bbox is not free-form."
            ),
            detail={"scene_bbox": list(scene_bbox), "request_bbox": list(bbox)},
        )
    return scene


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
                    runtime_mode=spec.runtime_mode,
                    bbox=list(spec.bbox),
                    data_dir=spec.data_dir,
                    cfar_config=spec.cfar_config,
                    datetime_range=spec.datetime_range,
                    scene=dict(spec.scene),
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
        arrays["components"] = np.zeros((0, len(_LAYER_COLUMNS["components"])), dtype=np.float64)
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
        "columns": {name: list(columns) for name, columns in _LAYER_COLUMNS.items()},
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


# ------------------------------------------------------------- endpoints


@router.post("/scans", response_model=ScanAccepted, status_code=status.HTTP_202_ACCEPTED)
def create_scan(body: ScanCreateRequest, state: State) -> ScanAccepted:
    """Queue one scan and return immediately (API-001).

    REAL validates the provider and proves AOI coverage *before* accepting the
    job, so an unusable request is a 4xx/5xx with a ProviderStatus rather than a
    job that fails later. There is no REAL -> DEMO fallback anywhere below.
    """
    bbox = (float(body.bbox[0]), float(body.bbox[1]), float(body.bbox[2]), float(body.bbox[3]))

    # A synthetic scene is reachable ONLY when the deployment explicitly enabled
    # it, which shipping configuration and Docker never do. There is no client
    # flag: a caller cannot ask for fabricated observations.
    if state.settings.allow_synthetic_scenes:
        scene = _resolve_demo_scene(body.scene_id, bbox)
        provider = "demo-synthesizer"
        synthetic = True
    else:
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
        synthetic = False

    spec = ScanSpec(
        runtime_mode="DEMO" if synthetic else "REAL",
        bbox=bbox,
        scene=scene,
        provider=provider,
        product=body.product,
        datetime_range=body.datetime_range,
        cfar_config=body.cfar_config,
        data_dir=state.data_dir,
        store=state.store,
    )
    job = state.runner.submit(
        lambda: _scan_work(spec),
        runtime_mode="DEMO" if synthetic else "REAL",
        synthetic=synthetic,
    )
    spec.bind(job.scan_id)
    return ScanAccepted(
        scan_id=job.scan_id,
        status=job.stage.value,
        runtime_mode="DEMO" if synthetic else "REAL",
        synthetic=synthetic,
    )


def _job_events(job: ScanJob) -> list[StageEventOut]:
    return [
        StageEventOut(
            stage=event.stage.value,
            timestamp=event.timestamp,
            detail=event.detail,
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
            stage=job.stage.value,
            terminal=is_terminal(job.stage),
            runtime_mode=job.runtime_mode.value,
            synthetic=job.synthetic,
            known=True,
            source="runner",
            started_at=job.started_at,
            finished_at=job.finished_at,
            failed_at=job.failed_at.value if job.failed_at else None,
            error=redact(job.error) if job.error else None,
            history=_job_events(job),
            record_persisted=record is not None,
        )
    assert record is not None
    return ScanStateResponse(
        scan_id=scan_id,
        stage=str(record.get("stage", ScanStage.COMPLETE.value)),
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
    return f"event: stage\ndata: {json.dumps(jsonable(payload), sort_keys=True)}\n\n"


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
        count=len(targets),
        ais_only_count=len(ais_only),
        counts={str(k): int(v) for k, v in dict(record.get("counts") or {}).items()},
        targets=targets,
        ais_only=ais_only,
        provenance=dict(record.get("provenance") or {}),
        scene=dict(record["scene"]) if isinstance(record.get("scene"), dict) else None,
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
    runtime_mode: str | None = Query(
        default=None,
        description=(
            "Only honoured when the deployment enabled synthetic scenes. Ignored "
            "otherwise, so it cannot be used to request fabricated data."
        ),
    ),
) -> SceneListResponse:
    """Scene discovery (API-005).

    Proxies the live provider search; a provider failure is an explicit error
    response. The synthetic catalogue is returned only when
    ``settings.allow_synthetic_scenes`` is on, which shipping configuration and
    Docker never do. When it is off, a ``runtime_mode=DEMO`` request is refused
    rather than silently upgraded, so a caller is never misled about which data
    it received.
    """
    if runtime_mode and runtime_mode.upper() == "DEMO" and not state.settings.allow_synthetic_scenes:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            error="SYNTHETIC_SCENES_DISABLED",
            status_value="INVALID_REQUEST",
            message=(
                "Synthetic scenes are not available in this deployment. Every scan is a "
                "REAL scan against a live provider."
            ),
            suggestions=["Drop runtime_mode, or request a live provider scene."],
        )
    if state.settings.allow_synthetic_scenes:
        return SceneListResponse(
            runtime_mode="DEMO",
            synthetic=True,
            provider="demo-synthesizer",
            status=ProviderStatus.AVAILABLE.value,
            note="Deterministic synthetic scenes; no provider was contacted.",
            count=len(DEMO_SCENES),
            scenes=[_demo_scene_summary(scene) for scene in DEMO_SCENES],
        )

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
        status=ProviderStatus.AVAILABLE.value if scenes else ProviderStatus.UNAVAILABLE.value,
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
    return TargetEvidenceResponse(
        scan_id=str(record.get("scan_id", "")),
        runtime_mode=str(record.get("runtime_mode", "REAL")),
        synthetic=bool(record.get("synthetic", False)),
        ambiguous=len(owners) > 1,
        candidate_scan_ids=[str(o["record"].get("scan_id", "")) for o in owners],
        evidence=jsonable(target_evidence(owner["target"], dict(record.get("provenance") or {}), None)),
    )


@router.get("/evidence/{target_id}", response_model=EvidenceDocumentResponse)
def get_evidence(
    target_id: str,
    state: State,
    scan_id: str | None = Query(default=None, description="Disambiguates repeated target ids."),
) -> EvidenceDocumentResponse:
    """The whole evidence document of the scan that owns the target (API-008)."""
    owners = _locate_target(state, target_id, scan_id)
    record = owners[0]["record"]
    return EvidenceDocumentResponse(
        scan_id=str(record.get("scan_id", "")),
        runtime_mode=str(record.get("runtime_mode", "REAL")),
        synthetic=bool(record.get("synthetic", False)),
        ambiguous=len(owners) > 1,
        candidate_scan_ids=[str(o["record"].get("scan_id", "")) for o in owners],
        evidence=jsonable(record),
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
    collections = [
        str(entry.get("id", ""))
        for entry in payload.get("collections", [])
        if isinstance(entry, dict)
    ]
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
                status=probe["status"].value,
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
    if layer in _LAYER_COLUMNS:
        columns = list(_LAYER_COLUMNS[layer])
        rows = min(int(array.shape[0]), limit)
        return DebugLayerResponse(
            scan_id=scan_id,
            layer=layer,
            kind="table",
            source="targets",
            shape=[int(value) for value in array.shape],
            dtype=str(array.dtype),
            columns=columns,
            rows=int(array.shape[0]),
            row_limit=rows,
            truncated=rows < int(array.shape[0]),
            notes=[
                f"one row per target; full values live in GET /api/scans/{scan_id}/targets"
            ],
        )
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
        runtime_mode=str(record.get("runtime_mode", "REAL")),
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
        runtime_mode=str(record.get("runtime_mode", "REAL")),
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


def _correlation_debug_layer(
    record: Mapping[str, Any], *, scan_id: str, layer: str, limit: int
) -> DebugLayerResponse:
    """Serve a correlation layer from the record's own score decomposition.

    Rows are emitted only for targets that actually carry the field. A target
    with no AIS association yields a row with nulls and an explicit note, never
    a zero position and never a fabricated match radius.
    """
    columns = list(_CORRELATION_COLUMNS[layer])
    targets = [t for t in (record.get("targets") or []) if isinstance(t, dict)]
    rows = 0
    notes: list[str] = [
        (
            "built from the persisted correlation result, not from a rendering; "
            f"one row per target; full values in GET /api/scans/{scan_id}/targets"
        )
    ]
    unassociated = 0
    for target in targets:
        corr = target.get("corr")
        corr = corr if isinstance(corr, dict) else {}
        decomposition = corr.get("scoreDecomposition")
        decomposition = decomposition if isinstance(decomposition, dict) else {}
        has_mmsi = bool(corr.get("mmsi"))
        if not has_mmsi:
            unassociated += 1
        if (
            (layer in ("ais_observations", "correlation_lines") and has_mmsi)
            or (
                layer == "ais_predicted"
                and corr.get("predictedLat") is not None
            )
            or (
                layer == "match_radius"
                and decomposition.get("matchRadiusMeters") is not None
            )
            or (layer == "score_decomposition" and bool(decomposition))
        ):
            rows += 1

    if unassociated:
        notes.append(
            f"{unassociated} of {len(targets)} target(s) had no AIS association and "
            "are absent from this layer; that is a data-availability fact, not a "
            "finding about the vessel."
        )
    if not rows:
        notes.append(
            f"no target in this scan carries {layer!r} data; the layer is empty, "
            "which is different from unavailable"
        )

    return DebugLayerResponse(
        scan_id=scan_id,
        layer=layer,
        kind="table",
        source="correlation",
        shape=[rows],
        dtype="object",
        columns=columns,
        rows=rows,
        row_limit=min(rows, limit),
        truncated=rows > min(rows, limit),
        notes=notes,
    )


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


@router.get("/tracks")
def list_tracks(
    state: State,
    max_scans: int = Query(default=50, ge=1, le=500),
) -> dict[str, Any]:
    """Multi-pass track HYPOTHESES across the persisted history (ADV-001..003).

    Never claims a confirmed identity, and never links a detection that had no
    AIS association. A single stored scan legitimately yields zero tracks.
    """
    observations = [r for r in _observations(state, max_scans=max_scans) if r["lat"] is not None]
    tracks = build_tracks(observations)
    return {
        "scans_considered": len({o["scan_id"] for o in observations}),
        "observations_considered": len(observations),
        "track_count": len(tracks),
        "tracks": [t.to_dict() for t in tracks],
        "note": (
            "Tracks are hypotheses built from reported AIS identity, not from "
            "geometry alone. DarkFleet does not confirm vessel identity."
        ),
    }


@router.get("/patterns")
def list_patterns(
    state: State,
    max_scans: int = Query(default=50, ge=1, le=500),
) -> dict[str, Any]:
    """Longitudinal behaviour PATTERNS (ADV-009/010).

    Each pattern carries its observation, a hypothesis, a bounded confidence and
    the explicit unknowns. A pattern is something to investigate, never a finding
    about intent.
    """
    observations = [r for r in _observations(state, max_scans=max_scans) if r["lat"] is not None]
    patterns = temporal_analyse(observations)
    return {
        "scans_considered": len({o["scan_id"] for o in observations}),
        "observations_considered": len(observations),
        "pattern_count": len(patterns),
        "patterns": [p.to_dict() for p in patterns],
        "note": (
            "Patterns describe data coverage and correlation outcomes. A missing "
            "AIS association is a coverage fact and is not evidence of conduct."
        ),
    }


@router.get("/detectors")
def list_detectors() -> dict[str, Any]:
    """The detector registry (ADV-007/008).

    An ML or ensemble detector without weights and validation is refused at
    registration, so it can never appear here as an available detector.
    """
    registry = DetectorRegistry()
    return {
        "default": registry.resolve().card.name,
        "detectors": [
            {
                "name": card.name,
                "kind": card.kind,
                "training_domain": card.training_domain,
                "input_product": card.input_product,
                "validation_data": card.validation_data,
                "limitations": card.limitations,
                "weights_digest": card.weights_digest,
            }
            for card in registry.available()
        ],
        "note": (
            "CA-CFAR is the shipped baseline. No trained weights ship with "
            "DarkFleet; an adapter must declare its training domain and "
            "validation before it can be registered."
        ),
    }


@router.get("/targets/{target_id}/summary")
def summarise_target(
    target_id: str,
    state: State,
    scan_id: str | None = Query(default=None),
    model_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Optional narrative over an existing evidence document (ADV-011/012).

    The evidence document is always returned. The narrative is additive: when it
    is unavailable the caller still has every deterministic observation, and the
    response says so explicitly instead of substituting prose.
    """
    owners = _locate_target(state, target_id, scan_id)
    owner = owners[0]
    evidence = target_evidence(
        owner["target"],
        owner["record"].get("provenance") or {},
        owner["target"].get("sar_chip"),
    )
    narrative = summarise(evidence, model_id=model_id)
    return {
        "scan_id": str(owner["record"].get("scan_id", "")),
        "target_id": target_id,
        "classification": owner["target"].get("cls"),
        "ambiguous": len(owners) > 1,
        "evidence": jsonable(evidence),
        "narrative": narrative,
    }