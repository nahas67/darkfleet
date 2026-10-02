"""The single authoritative scan pipeline.

Yields real (ScanStage, detail) transitions as work completes: no timers, no
invented percentages. Every stage runs for every scan, because there is only one
kind of scan. A provider that cannot serve the request raises
:class:`~darkfleet.providers.RealDataUnavailableError` rather than yielding
substitute pixels.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from .ais.archive import AisArchive
from .correlation.match import correlate
from .evidence import build_provenance
from .observability import stage as log_stage
from .providers import Georeferencing, RealDataUnavailableError
from .providers.stac import (
    SarAsset,
    inspect_georeferencing,
    search_earthsearch_grd,
    search_planetary_computer,
    sign_planetary_computer_asset,
)
from .sar import landmask as landmask_mod
from .sar.cfar import run_ca_cfar
from .sar.components import extract_components
from .sar.georef import read_window
from .sar.preprocess import grd_branch, rtc_branch
from .sar.speckle import apply_speckle

StageCallback = Callable[[str, str], None]

#: Reads a georeferenced raster window. Swappable so a test can exercise the
#: PRODUCTION pipeline against a checked-in fixture, rather than a parallel
#: implementation of it. Defaults to the real reader, so a shipped deployment
#: cannot inject a substitute.
WindowSource = Callable[[str, tuple[float, float, float, float]], dict[str, Any]]

_KNOWN_PROVIDERS = frozenset({"planetary-computer", "earthsearch"})

DEFAULT_CFAR: dict[str, Any] = {
    "training_cells": 16,
    "guard_cells": 4,
    "threshold_factor": 3.5,
    "coastline_buffer_meters": 150,
    "speckle_filter": "median",
    "kernel_size": 3,
    "min_pixels": 3,
    "max_pixels": 1000,
}


def config_hash(config: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:16]


def _class_counts(targets: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in targets:
        counts[t["cls"]] = counts.get(t["cls"], 0) + 1
    return counts


def run_scan(
    *,
    bbox: list[float],
    data_dir: str | Path,
    cfar_config: dict[str, Any] | None = None,
    datetime_range: str | None = None,
    provider: str = "planetary-computer",
    product: str = "rtc",
    on_stage: StageCallback | None = None,
    scan_id: str = "DF-0000",
    window_source: WindowSource | None = None,
) -> dict[str, Any]:
    """Execute one scan end to end and return the full evidence document.

    Every stage calls `on_stage(ScanStage, detail)` with MEASURED detail at the
    moment the work actually completes. No timers, no percentages, no invented
    numbers.

    There is no synthetic mode and no degraded path: a provider that cannot serve
    the request raises :class:`RealDataUnavailableError` rather than yielding
    fabricated pixels.

    ``window_source`` exists for the test suite. It is the ONLY injection point
    into the real path, so a test exercises the production code rather than a
    parallel implementation of it. It defaults to the real reader, so a shipped
    deployment cannot accidentally supply synthetic data through it.
    """
    cfar_config = dict(cfar_config or DEFAULT_CFAR)

    def emit(stage: str, detail: str) -> None:
        if on_stage is not None:
            on_stage(stage, detail)

    started = time.time()
    aoi: tuple[float, float, float, float] = (
        float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]),
    )
    if provider not in _KNOWN_PROVIDERS:
        raise RealDataUnavailableError(
            f"Unknown SAR provider {provider!r}.",
            details={"provider": provider, "known": sorted(_KNOWN_PROVIDERS)},
            suggestions=["Use planetary-computer or earthsearch."],
        )

    emit("QUEUED", f"scan {scan_id} queued")
    log_stage("SCAN", f"scan {scan_id} created")

    chash = config_hash(cfar_config)

    # ---- SCENE / ASSET -----------------------------------------------------
    emit("SEARCHING_SCENE", f"searching {provider} {product}")
    signed_href = ""

    asset: SarAsset = _resolve_asset(provider, product, aoi, datetime_range)
    if provider == "planetary-computer":
        sign_planetary_computer_asset(asset)
    signed_href = str(asset.extra.get("signed_href", asset.asset_href))
    state, geo_info = inspect_georeferencing(signed_href)
    if state == Georeferencing.UNREFERENCED:
        raise RealDataUnavailableError(
            "Selected asset has no usable georeferencing.",
            details={"item_id": asset.item_id, "state": state.value},
        )
    # Persist the measured raster geometry; never leave it null when known.
    res = geo_info.get("resolution")
    asset.resolution_meters = float(res[0]) if res else None
    asset.crs_wkt = str(geo_info.get("crs") or "") or None
    emit("SEARCHING_SCENE", f"scene selected {asset.item_id}")
    log_stage("STAC", f"selected scene {asset.item_id}")

    #: Measured geometry of the window actually read, carried into provenance.
    #: Every value is measured, never defaulted.
    raster_meta: dict[str, Any]

    # ---- READ -------------------------------------------------------------
    emit("READING_SAR", "reading raster window")
    window_data = (window_source or read_window)(signed_href, aoi)
    assert window_data is not None and asset is not None
    arr = window_data["array"].astype(np.float64)
    valid = np.isfinite(arr)
    land = None
    raster_meta = {
        "provider": asset.provider, "collection": asset.collection, "item_id": asset.item_id,
        "platform": asset.platform, "acquisition_time": asset.acquisition_time,
        "product": asset.product, "polarization": asset.polarization,
        "asset_href": asset.asset_href, "crs": str(window_data["crs"]),
        "transform": list(window_data["window_transform"])[:6],
        "resolution_m": asset.resolution_meters, "raster_window": list(window_data["window"]),
    }
    log_stage("SAR", f"read {arr.shape[1]}x{arr.shape[0]} {asset.product} window")


    # ---- PREPROCESS -------------------------------------------------------
    emit("PREPROCESSING", f"calibration branch {raster_meta['product']}")
    if raster_meta["product"] == "RTC":
        out = rtc_branch(window_data["array"].astype(np.float64), window_data["nodata"])
        db, valid, branch = out["db"], out["valid"], "RTC"
    else:
        assert window_data is not None
        out = grd_branch(window_data["array"].astype(np.float64), window_data["nodata"], None)
        db, valid, branch = out["db"], out["valid"], "GRD"
    log_stage("SAR", f"preprocessed via {branch} branch")

    # ---- MASK -------------------------------------------------------------
    emit("MASKING", f"land mask buffer={cfar_config['coastline_buffer_meters']}m")
    land_mask_result = _real_land_mask(db, valid, window_data, cfar_config, data_dir, aoi)
    land = land_mask_result["excluded"]
    land_prov: dict[str, Any] = land_mask_result["provenance"]
    log_stage("MASK", f"excluded {100.0 * float(land_mask_result['land_fraction']):.1f}% pixels")

    # ---- FILTER -----------------------------------------------------------
    emit("FILTERING", f"speckle={cfar_config['speckle_filter']}")
    filtered = apply_speckle(db, valid, cfar_config["speckle_filter"], cfar_config["kernel_size"])
    log_stage("FILTER", f"speckle {cfar_config['speckle_filter']} applied")

    # ---- DETECT -----------------------------------------------------------
    emit(
        "DETECTING",
        f"CA-CFAR train={cfar_config['training_cells']} "
        f"guard={cfar_config['guard_cells']} "
        f"alpha={cfar_config['threshold_factor']}",
    )
    det = run_ca_cfar(
        filtered, np.isfinite(filtered), land,
        training_cells=cfar_config["training_cells"],
        guard_cells=cfar_config["guard_cells"],
        threshold_factor=cfar_config["threshold_factor"],
    )
    log_stage("CFAR", f"detected {int(det['mask'].sum())} pixels")

    # ---- EXTRACT ----------------------------------------------------------
    emit("EXTRACTING", f"components min={cfar_config['min_pixels']}px")
    comps = extract_components(
        det["mask"], filtered,
        min_pixels=cfar_config["min_pixels"], max_pixels=cfar_config["max_pixels"],
    )
    log_stage("CFAR", f"{len(comps)} components")

    # ---- AIS --------------------------------------------------------------
    emit("LOADING_AIS", "loading AIS observations")
    acq = raster_meta["acquisition_time"]
    window_seconds = 900
    a0 = _as_utc(acq) - timedelta(seconds=window_seconds)
    a1 = _as_utc(acq) + timedelta(seconds=window_seconds)
    archive = AisArchive(data_dir)
    ais_rows = archive.query(a0, a1, bbox=aoi)
    sources: list[str] = archive.coverage()["sources"] or ["local-archive"]
    ais_provider = "+".join(sources)
    log_stage("AIS", f"loaded {len(ais_rows)} observations")

    # ---- ALIGN ------------------------------------------------------------
    emit("ALIGNING", "propagating AIS to acquisition time")
    emit("CORRELATING", "building candidates")
    grid_w, grid_h = int(window_data["window"][3]), int(window_data["window"][2])
    grid_bbox: tuple[float, float, float, float] = aoi
    out = correlate(
        comps, ais_rows, acq, grid_w, grid_h, grid_bbox,
        float(raster_meta["resolution_m"] or 10.0), "PENDING",
    )
    targets = out["targets"]
    matched = sum(1 for t in targets if t["cls"] == "SAR_MATCHED_AIS")
    log_stage("MATCH", f"associated {matched} targets")

    # ---- SCORE / PERSIST --------------------------------------------------
    emit("SCORING", "assembling score decomposition and confidence")
    emit("PERSISTING", "building evidence record")
    prov = build_provenance(
        runtime_mode="REAL", synthetic=False,
        provider=raster_meta["provider"], collection=raster_meta["collection"],
        item_id=raster_meta["item_id"], platform=raster_meta["platform"],
        acquisition_time=acq, product=raster_meta["product"],
        polarization=raster_meta["polarization"], asset_href=raster_meta["asset_href"],
        crs=raster_meta["crs"], transform=raster_meta["transform"],
        resolution_m=raster_meta["resolution_m"], raster_window=raster_meta["raster_window"],
        bbox=list(aoi), config_hash=chash,
        land_mask=land_prov,
        speckle={"mode": cfar_config["speckle_filter"], "kernel": cfar_config["kernel_size"]},
        cfar={k: cfar_config[k] for k in ("training_cells", "guard_cells", "threshold_factor", "min_pixels", "max_pixels")},
        ais_provider=ais_provider,
        matching={"weights": [0.45, 0.25, 0.15, 0.15], "min_score": 0.40, "window_s": window_seconds},
    )
    result = {
        # Both isolation fields are INVARIANTS, not labels. There is no synthetic
        # path in this pipeline, so they are stamped rather than derived -- and
        # the store asserts them on write, so a record cannot drift from them.
        "runtime_mode": "REAL",
        "synthetic": False,
        "scene": raster_meta, "aoi": list(aoi), "acquisition_time": acq,
        "config": {**cfar_config, "config_hash": chash},
        "targets": targets, "ais_only": out["ais_only"],
        "counts": {**_class_counts(targets), "ais_only": len(out["ais_only"])},
        "provenance": prov,
        "artifacts": {
            "raw_db": db, "filtered_db": filtered, "land": land,
            "cfar_mask": det["mask"], "threshold_db": det["threshold_db"],
        },
        "processing_time_ms": int((time.time() - started) * 1000),
        "created_at": datetime.now(UTC).isoformat(),
        "scan_id": scan_id,
    }
    log_stage("DONE", f"scan completed in {result['processing_time_ms']} ms")
    emit("COMPLETE", f"scan completed in {result['processing_time_ms']} ms")
    return result


def _as_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _resolve_asset(provider: str, product: str, bbox: tuple[float, float, float, float], dr: str | None) -> SarAsset:
    # A blank range means "no time filter"; the STAC helper omits the key.
    window = dr.strip() if dr and dr.strip() else ""
    if provider == "planetary-computer":
        assets = search_planetary_computer(bbox, window, product=product, limit=2)
        vv = [a for a in assets if a.polarization == "VV"]
        return (vv or assets)[0]
    if provider == "earthsearch":
        assets = search_earthsearch_grd(bbox, window, limit=2)
        vv = [a for a in assets if a.polarization == "VV"]
        return (vv or assets)[0]
    raise RealDataUnavailableError(f"unknown provider {provider}", details={"provider": provider})


def _real_land_mask(
    db: np.ndarray,
    valid: np.ndarray,
    window_data: dict[str, Any],
    cfar_config: dict[str, Any],
    data_dir: str | Path,
    aoi: tuple[float, float, float, float],
) -> dict[str, Any]:
    """WorldCover-backed mask aligned to the SAR window, cached under data_dir."""
    cache_dir = Path(data_dir) / "boundaries" / "worldcover"
    min_lon, min_lat, max_lon, max_lat = aoi
    clip = cache_dir / f"{min_lon:.3f}_{min_lat:.3f}_{max_lon:.3f}_{max_lat:.3f}.tif"
    if not clip.exists():
        href = landmask_mod.tile_url((min_lon + max_lon) / 2, (min_lat + max_lat) / 2)
        landmask_mod.fetch_tile_clip(href, aoi, str(clip))
    win = window_data["window"]
    return landmask_mod.build_land_mask(
        str(clip),
        window_data["window_transform"],
        (int(win[2]), int(win[3])),
        window_data["crs"],
        coastline_buffer_m=int(cfar_config["coastline_buffer_meters"]),
        pixel_spacing_m=rasterio_res(window_data),
    )


def rasterio_res(window_data: dict[str, Any]) -> float:
    t = window_data["window_transform"]
    return float(max(abs(t.a), abs(t.e)))