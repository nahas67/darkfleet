"""Read-only exact-grid comparison of cached calibrated REAL SAR windows.

No warp, co-registration fit, interpolation or assumption that matching AOIs
imply aligned pixels. Only whole-pixel translations on the same affine lattice
can be numerically compared, and the result is a descriptive dB difference
between source pixels, not a verified scene-change or vessel observation.
"""

from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field
from pyproj import CRS
from pyproj.exceptions import CRSError

from darkfleet.storage.cache import ArtifactCache, CacheKey
from darkfleet.storage.runs import RunStore, run_store_for_data_dir

ComparisonStatus = Literal["MEASURED", "NOT_COMPARABLE"]


class SceneIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_id: str
    item_id: str | None
    acquisition_time: str | None
    product: str | None
    polarization: str | None
    crs: str | None
    window_transform: list[float] | None
    raster_shape: list[int] | None
    processing_version: str | None
    source: Literal["PERSISTED_REAL_SCAN_CALIBRATED_CACHE"] = (
        "PERSISTED_REAL_SCAN_CALIBRATED_CACHE"
    )


class ComparisonMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    overlap_shape: list[int]
    offset_b_in_a_pixels: list[int]
    overlap_pixels: int
    valid_pair_pixels: int
    valid_pair_fraction: float
    mean_b_minus_a_db: float
    mean_absolute_difference_db: float
    root_mean_square_difference_db: float
    median_b_minus_a_db: float
    p05_b_minus_a_db: float
    p95_b_minus_a_db: float
    brighter_b_pixels: int
    darker_b_pixels: int
    equal_pixels: int
    metric: Literal["SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE"] = (
        "SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE"
    )


class SceneComparisonOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: ComparisonStatus
    reason: str
    first: SceneIdentity
    second: SceneIdentity
    metrics: ComparisonMetrics | None
    acquisition_interval_hours: float | None
    caveat: str = (
        "Descriptive per-pixel backscatter difference from two persisted "
        "REAL RTC windows. Grid identity is not demonstrated sub-pixel "
        "co-registration, radiometric stability, vessel change, or causation."
    )


class SceneCandidateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_id: str
    item_id: str | None
    acquisition_time: str | None
    product: str | None
    polarization: str | None
    available_normalized_raster: bool
    georeference_present: bool


class SceneCandidatesOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenes: list[SceneCandidateOut]
    total_real_scans: int = Field(ge=0)
    note: str = (
        "Only persisted REAL/synthetic-false scans are listed. A listed scene "
        "is not necessarily geometrically comparable or scientifically calibrated."
    )


def _real_record(store: RunStore, scan_id: str) -> dict[str, Any] | None:
    try:
        record = store.get(scan_id)
    except ValueError:
        return None
    if (
        not isinstance(record, dict)
        or record.get("scan_id") != scan_id
        or record.get("runtime_mode") != "REAL"
        or record.get("synthetic") is not False
    ):
        return None
    return record


def _scene(record: dict[str, Any] | None) -> dict[str, Any]:
    if record is None:
        return {}
    value = record.get("scene")
    return value if isinstance(value, dict) else {}


def _safe(value: Any, max_len: int = 180) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= max_len and "://" not in value:
        return value
    return None


def _identity(scan_id: str, record: dict[str, Any] | None) -> SceneIdentity:
    scene = _scene(record)
    raw = scene.get("transform")
    transform = (
        [float(v) for v in raw]
        if isinstance(raw, list) and len(raw) == 6
        and all(type(v) in (int, float) and math.isfinite(v) for v in raw)
        else None
    )
    cache_meta = record.get("debug") if record else None
    inputs = cache_meta.get("cache") if isinstance(cache_meta, dict) else None
    return SceneIdentity(
        scan_id=scan_id,
        item_id=_safe(scene.get("item_id")),
        acquisition_time=_safe(scene.get("acquisition_time")),
        product=_safe(scene.get("product")),
        polarization=_safe(scene.get("polarization")),
        crs=_safe(scene.get("crs"), 4096),
        window_transform=transform,
        raster_shape=None,
        processing_version=_safe(inputs.get("algorithm_version"))
        if isinstance(inputs, dict) else None,
    )


def _cache_key(record: dict[str, Any]) -> CacheKey | None:
    debug = record.get("debug")
    meta = debug.get("cache") if isinstance(debug, dict) else None
    if not isinstance(meta, dict):
        return None
    try:
        scene_item_id = meta["scene_item_id"]
        version = meta["algorithm_version"]
        bbox = meta["bbox"]
        config = meta["processing_config"]
        if (
            not isinstance(scene_item_id, str)
            or not isinstance(version, str)
            or not isinstance(bbox, list)
            or len(bbox) != 4
            or not isinstance(config, dict)
        ):
            return None
        return CacheKey(
            scene_item_id=scene_item_id,
            bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
            processing_config=config,
            algorithm_version=version,
        )
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def _read_calibrated_array(
    data_dir: Path, record: dict[str, Any],
) -> np.ndarray | None:
    debug = record.get("debug")
    if not isinstance(debug, dict):
        return None
    layers = debug.get("layers")
    if not isinstance(layers, list) or "normalized" not in layers:
        return None
    key = _cache_key(record)
    if key is None:
        return None
    # The canonical normalized cache entry is the raw_db output of the RTC
    # preprocessing branch. Use the same cache integrity verifier as the API;
    # never read an arbitrary path supplied by an HTTP client.
    try:
        array = ArtifactCache(data_dir / "cache", key.algorithm_version).get(
            key, "normalized",
        )
    except (OSError, ValueError):
        return None
    if array is None or array.ndim != 2 or array.size == 0 or array.dtype.kind != "f":
        return None
    return array


def _offset_pixels(
    left: list[float], right: list[float],
) -> tuple[int, int] | None:
    """Return right raster's top-left (row,col) in left raster integer indices."""
    a, b, c, d, e, f = left
    aa, bb, cc, dd, ee, ff = right
    if (
        (a, b, c, d, e, f) == (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
        or (aa, bb, cc, dd, ee, ff) == (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
    ):
        # rasterio refuses unreferenced identity transforms upstream.
        return None
    scale = max(abs(a), abs(b), abs(d), abs(e), 1e-12)
    # Do not mistake grids of different resolution or orientation for aligned.
    if any(abs(x - y) > scale * 1e-10 for x, y in zip((a, b, d, e), (aa, bb, dd, ee))):
        return None
    determinant = a * e - b * d
    if not math.isfinite(determinant) or abs(determinant) <= scale * scale * 1e-12:
        return None
    dx, dy = cc - c, ff - f
    col = (e * dx - b * dy) / determinant
    row = (-d * dx + a * dy) / determinant
    if not all(math.isfinite(v) and abs(v) <= 1e8 for v in (row, col)):
        return None
    if abs(row - round(row)) > 1e-6 or abs(col - round(col)) > 1e-6:
        return None
    return (round(row), round(col))


def _interval_hours(first: SceneIdentity, second: SceneIdentity) -> float | None:
    try:
        if first.acquisition_time is None or second.acquisition_time is None:
            return None
        t1 = datetime.fromisoformat(first.acquisition_time)
        t2 = datetime.fromisoformat(second.acquisition_time)
        if t1.tzinfo is None or t2.tzinfo is None:
            return None
        return abs((t2 - t1).total_seconds()) / 3600
    except ValueError:
        return None


def _not_comparable(
    reason: str, left: SceneIdentity, right: SceneIdentity,
) -> SceneComparisonOut:
    return SceneComparisonOut(
        status="NOT_COMPARABLE", reason=reason, first=left, second=right,
        metrics=None, acquisition_interval_hours=_interval_hours(left, right),
    )


def _verified_rtc_provenance(record: dict[str, Any]) -> bool:
    """Require persisted SAR provenance to agree with the claimed scene."""
    scene = _scene(record)
    provenance = record.get("provenance")
    sar = provenance.get("sar") if isinstance(provenance, dict) else None
    if not isinstance(sar, dict):
        return False
    for field in (
        "item_id", "acquisition_time", "product", "polarization", "platform", "provider",
        "collection", "crs", "transform", "raster_window",
    ):
        if sar.get(field) is None or sar.get(field) != scene.get(field):
            return False
    return True


def scene_candidates(
    data_dir: Path, *, limit: int = 100,
) -> SceneCandidatesOut:
    """List persisted scan candidates without re-opening external SAR providers."""
    store = run_store_for_data_dir(data_dir)
    candidates: list[SceneCandidateOut] = []
    total = 0
    for scan_id in store.list_ids():
        record = _real_record(store, scan_id)
        if record is None:
            continue
        total += 1
        if len(candidates) >= limit:
            continue
        info = _identity(scan_id, record)
        debug = record.get("debug")
        layers = debug.get("layers") if isinstance(debug, dict) else None
        candidates.append(SceneCandidateOut(
            scan_id=scan_id, item_id=info.item_id,
            acquisition_time=info.acquisition_time, product=info.product,
            polarization=info.polarization,
            available_normalized_raster=isinstance(layers, list) and "normalized" in layers,
            georeference_present=info.crs is not None and info.window_transform is not None,
        ))
    return SceneCandidatesOut(scenes=candidates, total_real_scans=total)


def compare_scenes(
    data_dir: Path, first_scan_id: str, second_scan_id: str,
) -> SceneComparisonOut:
    """Compare overlap ONLY on a proved identical calibrated pixel lattice."""
    store = run_store_for_data_dir(data_dir)
    ra = _real_record(store, first_scan_id)
    rb = _real_record(store, second_scan_id)
    a = _identity(first_scan_id, ra)
    b = _identity(second_scan_id, rb)
    if ra is None or rb is None:
        return _not_comparable("PERSISTED_REAL_SCAN_MISSING", a, b)
    if first_scan_id == second_scan_id or (
        a.item_id is not None and a.item_id == b.item_id
    ):
        return _not_comparable("DISTINCT_REAL_ACQUISITIONS_REQUIRED", a, b)
    if a.acquisition_time is None or b.acquisition_time is None or (
        a.acquisition_time == b.acquisition_time
    ):
        return _not_comparable("DISTINCT_ACQUISITION_TIMES_REQUIRED", a, b)
    interval = _interval_hours(a, b)
    if interval is None or interval <= 0:
        return _not_comparable("ACQUISITION_TIMESTAMPS_NOT_VERIFIED", a, b)
    if a.product != "RTC" or b.product != "RTC":
        # GRD LUT/calibration + speckle/noise normalization cannot be inferred.
        return _not_comparable("RTC_GAMMA0_CALIBRATION_REQUIRED", a, b)
    if not _verified_rtc_provenance(ra) or not _verified_rtc_provenance(rb):
        return _not_comparable("SAR_CALIBRATION_OR_GEOREFERENCE_PROVENANCE_MISSING", a, b)
    if any(
        _scene(ra).get(field) != _scene(rb).get(field)
        for field in ("provider", "collection", "platform")
    ):
        return _not_comparable("DIFFERENT_SOURCE_PROCESSING_DOMAIN", a, b)
    if (
        a.processing_version is None
        or b.processing_version is None
        or a.processing_version != b.processing_version
    ):
        return _not_comparable("PROCESSING_VERSION_MISMATCH_OR_MISSING", a, b)
    if (
        a.polarization is None or a.polarization != b.polarization
    ):
        return _not_comparable("POLARIZATION_MISMATCH_OR_MISSING", a, b)
    if a.crs is None or b.crs is None or (
        a.window_transform is None or b.window_transform is None
    ):
        return _not_comparable("MEASURED_WINDOW_GEOREFERENCE_MISSING", a, b)
    try:
        ca, cb = CRS.from_user_input(a.crs), CRS.from_user_input(b.crs)
    except (ValueError, TypeError, CRSError):
        return _not_comparable("CRS_INVALID", a, b)
    if not ca.equals(cb):
        return _not_comparable("CRS_MISMATCH_NO_WARP", a, b)
    offset = _offset_pixels(a.window_transform, b.window_transform)
    if offset is None:
        return _not_comparable("AFFINE_GRIDS_NOT_IDENTICAL_NO_COREGISTRATION", a, b)
    arr_a = _read_calibrated_array(data_dir, ra)
    arr_b = _read_calibrated_array(data_dir, rb)
    if arr_a is None or arr_b is None:
        return _not_comparable("CALIBRATED_CACHE_MISSING_OR_CORRUPT", a, b)
    a.raster_shape = list(arr_a.shape)
    b.raster_shape = list(arr_b.shape)
    for record, array in ((ra, arr_a), (rb, arr_b)):
        window = _scene(record).get("raster_window")
        if (
            not isinstance(window, list)
            or len(window) != 4
            or any(type(v) is not int for v in window)
            or window[2] != array.shape[0]
            or window[3] != array.shape[1]
            or window[0] < 0
            or window[1] < 0
        ):
            return _not_comparable("RASTER_WINDOW_SHAPE_INCONSISTENT", a, b)
    row_offset, col_offset = offset
    row_start = max(0, row_offset)
    col_start = max(0, col_offset)
    row_end = min(arr_a.shape[0], row_offset + arr_b.shape[0])
    col_end = min(arr_a.shape[1], col_offset + arr_b.shape[1])
    if row_end <= row_start or col_end <= col_start:
        return _not_comparable("NO_OVERLAPPING_MEASURED_PIXELS", a, b)
    overlap_shape = [row_end - row_start, col_end - col_start]
    if overlap_shape[0] * overlap_shape[1] > 8_000_000:
        return _not_comparable("WINDOW_TOO_LARGE_FOR_BOUNDED_COMPARISON", a, b)
    # Slice exactly matching source pixel locations. No interpolation.
    wa = arr_a[row_start:row_end, col_start:col_end]
    wb = arr_b[
        row_start - row_offset:row_end - row_offset,
        col_start - col_offset:col_end - col_offset,
    ]
    valid = np.isfinite(wa) & np.isfinite(wb)
    count = int(np.count_nonzero(valid))
    if count == 0:
        return _not_comparable("NO_SHARED_VALID_RTC_SAMPLES", a, b)
    if (
        np.any(np.abs(wa[valid]) > 200.0)
        or np.any(np.abs(wb[valid]) > 200.0)
    ):
        # RTC branch clips at -90 dB for no-signal; values outside this
        # deliberately generous envelope indicate unusable/unverified units.
        return _not_comparable("RTC_DB_VALUES_OUT_OF_RANGE", a, b)
    delta = wb[valid].astype(np.float64) - wa[valid].astype(np.float64)
    # Protect a diagnostic from overflow caused by corrupted dB numerics.
    if not np.all(np.isfinite(delta)):
        return _not_comparable("NUMERIC_DIFFERENCE_INVALID", a, b)
    metrics = ComparisonMetrics(
        overlap_shape=overlap_shape, offset_b_in_a_pixels=[row_offset, col_offset],
        overlap_pixels=overlap_shape[0] * overlap_shape[1],
        valid_pair_pixels=count,
        valid_pair_fraction=count / (overlap_shape[0] * overlap_shape[1]),
        mean_b_minus_a_db=float(np.mean(delta)),
        mean_absolute_difference_db=float(np.mean(np.abs(delta))),
        root_mean_square_difference_db=float(np.sqrt(np.mean(np.square(delta)))),
        median_b_minus_a_db=float(np.median(delta)),
        p05_b_minus_a_db=float(np.percentile(delta, 5)),
        p95_b_minus_a_db=float(np.percentile(delta, 95)),
        brighter_b_pixels=int(np.count_nonzero(delta > 0)),
        darker_b_pixels=int(np.count_nonzero(delta < 0)),
        equal_pixels=int(np.count_nonzero(delta == 0)),
    )
    return SceneComparisonOut(
        status="MEASURED",
        reason="EXACT_SAME_AFFINE_PIXEL_LATTICE_RTC_GAMMA0_DB",
        first=a, second=b, metrics=metrics,
        acquisition_interval_hours=_interval_hours(a, b),
    )
