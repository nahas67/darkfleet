"""Bounded, read-only visualization of independently persisted REAL RTC SAR windows.

The only pixel source is the checksum-verified normalized artifact referenced by a
persisted scan. This does not align acquisitions, infer change, or fetch imagery.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np
from numpy.lib import format as npy_format
from PIL import Image
from pydantic import BaseModel, ConfigDict
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError

from darkfleet.sar_scene_compare import (
    _cache_key,
    _real_record,
    _scene,
    _verified_rtc_provenance,
)
from darkfleet.storage.runs import run_store_for_data_dir

MAX_SOURCE_PIXELS = 8_000_000
MAX_PNG_EDGE = 1024
MAX_CACHE_BYTES = 96 * 1024 * 1024
MAX_META_BYTES = 16 * 1024
MAX_NPY_HEADER_BYTES = 4096
DB_WINDOW = (-30.0, 5.0)  # fixed for BOTH scenes; never independently stretched
SCAN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")


class ImageryUnavailable(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ImageryScene(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_id: str
    status: Literal["READY", "UNAVAILABLE"]
    reason: str
    item_id: str | None = None
    acquisition_time: str | None = None
    product: str | None = None
    polarization: str | None = None
    platform: str | None = None
    provider: str | None = None
    crs: str | None = None
    transform: list[float] | None = None
    wgs84_corners_lon_lat: list[list[float]] | None = None
    raster_window: list[int] | None = None
    source_shape: list[int] | None = None
    preview_shape: list[int] | None = None
    sample_stride: int | None = None
    valid_source_pixels: int | None = None
    total_source_pixels: int | None = None
    displayed_valid_pixels: int | None = None
    image_url: str | None = None
    display_window_db: list[float] | None = None
    source: Literal["PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC"] | None = None


class ImageryPair(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first: ImageryScene
    second: ImageryScene
    status: Literal["READY", "PARTIAL", "UNAVAILABLE"]
    interpretation: str = (
        "Two independent RTC gamma0 dB visualizations using the same fixed grayscale "
        "window. No pixel alignment, image differencing, change classification, "
        "radiometric normalization, or identity continuity is asserted. "
        "Invalid source pixels are transparent."
    )


def _valid_text(value: Any, max_length: int = 256) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= max_length else None


def _fixed_affine(value: Any) -> list[float]:
    if (
        not isinstance(value, list) or len(value) != 6
        or not all(type(x) in (int, float) and math.isfinite(x) for x in value)
    ):
        raise ImageryUnavailable("GEOREFERENCE_AFFINE_MISSING_OR_INVALID")
    a, b, c, d, e, f = (float(x) for x in value)
    scale = max(abs(a), abs(b), abs(d), abs(e))
    determinant = a * e - b * d
    if (a, b, c, d, e, f) == (1., 0., 0., 0., 1., 0.) or (
        scale == 0 or not math.isfinite(determinant)
        or abs(determinant) <= scale * scale * 1e-12
    ):
        raise ImageryUnavailable("GEOREFERENCE_AFFINE_UNREFERENCED_OR_SINGULAR")
    return [a, b, c, d, e, f]


def _scan_record(data_dir: Path, scan_id: str) -> dict[str, Any]:
    if not SCAN_ID_RE.fullmatch(scan_id):
        raise ImageryUnavailable("INVALID_SCAN_REFERENCE")
    record = _real_record(run_store_for_data_dir(data_dir), scan_id)
    if record is None:
        raise ImageryUnavailable("PERSISTED_REAL_SCAN_MISSING")
    return record


def _read_bounded_calibrated_array(data_dir: Path, record: dict[str, Any]) -> np.ndarray:
    """Verify one immutable cache snapshot before materializing its NPY member.

    ArtifactCache.get validates the NPZ checksum but checks shape/dtype only
    AFTER numpy materializes the array. A forged, properly re-hashed archive
    could otherwise allocate well beyond the preview's declared safety cap.
    Use the cache's *same sha256* authority; preflight ZIP sizes and NPY header
    from the exact bytes subsequently decoded (no check/open race).
    """
    debug = record.get("debug")
    layers = debug.get("layers") if isinstance(debug, dict) else None
    if not isinstance(layers, list) or "normalized" not in layers:
        raise ImageryUnavailable("CALIBRATED_CACHE_MISSING_OR_CORRUPT")
    key = _cache_key(record)
    if key is None:
        raise ImageryUnavailable("CACHE_REFERENCE_MISSING_OR_INVALID")
    if key.scene_item_id != _scene(record).get("item_id"):
        raise ImageryUnavailable("CACHE_SCENE_IDENTITY_MISMATCH")
    entry = data_dir / "cache" / key.shard / key.directory
    payload = entry / "normalized.npz"
    meta_path = entry / "normalized.meta.json"
    try:
        # Never rely on stat alone: bound the actual bytes read even if the file
        # changes between opening and reading it.
        with payload.open("rb") as stream:
            raw = stream.read(MAX_CACHE_BYTES + 1)
        with meta_path.open("rb") as stream:
            meta_raw = stream.read(MAX_META_BYTES + 1)
        if len(raw) > MAX_CACHE_BYTES or len(meta_raw) > MAX_META_BYTES:
            raise ImageryUnavailable("CACHE_EXCEEDS_SAFE_READ_BOUNDS")
        meta = json.loads(meta_raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeError):
        raise ImageryUnavailable("CALIBRATED_CACHE_MISSING_OR_CORRUPT") from None
    shape = meta.get("shape") if isinstance(meta, dict) else None
    if (
        not isinstance(shape, list) or len(shape) != 2
        or any(type(n) is not int or n <= 0 for n in shape)
        or shape[0] * shape[1] > MAX_SOURCE_PIXELS
    ):
        raise ImageryUnavailable("SOURCE_RASTER_DIMENSIONS_INVALID_OR_OVERSIZE")

    # The cache writer uses np.savez (one named .npy member, not a raw TIFF) and
    # persists the dtype and SHA of the exact outer archive in a sidecar.
    # Reject invalid sidecars before opening the ZIP or parsing an NPY header.
    dtype_string = meta.get("dtype")
    if not isinstance(dtype_string, str) or not re.fullmatch(r"[<>=|]f[248]", dtype_string):
        raise ImageryUnavailable("CACHE_NPY_DTYPE_UNSUPPORTED")
    try:
        expected_dtype = np.dtype(dtype_string)
    except (TypeError, ValueError):
        raise ImageryUnavailable("CACHE_NPY_DTYPE_UNSUPPORTED") from None
    if (
        expected_dtype.kind != "f" or expected_dtype.itemsize not in (2, 4, 8)
        or not isinstance(meta, dict)
        or meta.get("artifact_name") != "normalized"
        or meta.get("storage_version") != 1
        or meta.get("digest") != key.digest
        or meta.get("algorithm_version") != key.algorithm_version
        or meta.get("scene_item_id") != key.scene_item_id
    ):
        raise ImageryUnavailable("CALIBRATED_CACHE_MISSING_OR_CORRUPT")
    if not isinstance(meta.get("sha256"), str) or (
        hashlib.sha256(raw).hexdigest() != meta["sha256"]
    ):
        raise ImageryUnavailable("CALIBRATED_CACHE_MISSING_OR_CORRUPT")

    expected_bytes = shape[0] * shape[1] * expected_dtype.itemsize
    # ZipInfo.file_size is the *uncompressed* length from the central directory;
    # verify it before even opening the member stream. A tiny compressed archive
    # with a huge claimed member is refused without inflating its body.
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            if (
                len(members) != 1 or members[0].filename != "normalized.npy"
                or members[0].is_dir()
                or members[0].compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            ):
                raise ImageryUnavailable("CACHE_NPY_MEMBER_INVALID")
            member = members[0]
            if member.file_size > expected_bytes + MAX_NPY_HEADER_BYTES + 16:
                raise ImageryUnavailable("CACHE_NPY_MEMBER_EXCEEDS_SAFE_BOUNDS")
            with archive.open(member) as stream:
                version = npy_format.read_magic(stream)
                if version == (1, 0):
                    header = npy_format.read_array_header_1_0(
                        stream, max_header_size=MAX_NPY_HEADER_BYTES,
                    )
                elif version == (2, 0):
                    header = npy_format.read_array_header_2_0(
                        stream, max_header_size=MAX_NPY_HEADER_BYTES,
                    )
                else:
                    raise ImageryUnavailable("CACHE_NPY_HEADER_INVALID")
                inner_shape, _fortran_order, inner_dtype = header
                if (
                    tuple(inner_shape) != tuple(shape)
                    or inner_dtype != expected_dtype
                    or inner_dtype.str != dtype_string
                    or member.file_size != stream.tell() + expected_bytes
                ):
                    raise ImageryUnavailable("CACHE_NPY_HEADER_MISMATCH")
            # The bytes are identical to those checked above, so no modification
            # can introduce a larger ZIP member between validation and decode.
            with archive.open(member) as stream:
                array = npy_format.read_array(
                    stream, allow_pickle=False, max_header_size=MAX_NPY_HEADER_BYTES,
                )
    except ImageryUnavailable:
        raise
    except (OSError, ValueError, EOFError, TypeError, RuntimeError, zipfile.BadZipFile):
        raise ImageryUnavailable("CALIBRATED_CACHE_MISSING_OR_CORRUPT") from None
    if array.ndim != 2 or list(array.shape) != shape or array.dtype.str != dtype_string:
        raise ImageryUnavailable("CACHE_NPY_HEADER_MISMATCH")
    return array


def _load_scene(data_dir: Path, scan_id: str) -> tuple[ImageryScene, np.ndarray]:
    record = _scan_record(data_dir, scan_id)
    scene = _scene(record)
    if scene.get("product") != "RTC":
        raise ImageryUnavailable("RTC_CALIBRATED_PRODUCT_REQUIRED")
    if not _verified_rtc_provenance(record):
        raise ImageryUnavailable("SAR_SOURCE_PROVENANCE_INCONSISTENT")
    for field in ("item_id", "acquisition_time", "polarization", "platform", "provider"):
        if _valid_text(scene.get(field)) is None:
            raise ImageryUnavailable("SOURCE_IDENTITY_OR_ACQUISITION_METADATA_MISSING")
    try:
        timestamp = datetime.fromisoformat(scene["acquisition_time"])
        if timestamp.tzinfo is None:
            raise ValueError("naive timestamp")
    except (ValueError, TypeError, OverflowError):
        raise ImageryUnavailable("ACQUISITION_TIME_NOT_VERIFIABLE") from None
    crs = _valid_text(scene.get("crs"), 4096)
    if crs is None:
        raise ImageryUnavailable("CRS_MISSING_OR_INVALID")
    try:
        CRS.from_user_input(crs)
    except (CRSError, TypeError, ValueError):
        raise ImageryUnavailable("CRS_MISSING_OR_INVALID") from None
    transform = _fixed_affine(scene.get("transform"))
    array = _read_bounded_calibrated_array(data_dir, record)
    if array.size > MAX_SOURCE_PIXELS or array.ndim != 2:
        raise ImageryUnavailable("SOURCE_RASTER_DIMENSIONS_INVALID_OR_OVERSIZE")
    height, width = array.shape
    window = scene.get("raster_window")
    # The SAR reader persists [row_offset, column_offset, height, width].
    if (
        not isinstance(window, list) or len(window) != 4
        or any(type(x) is not int or x < 0 for x in window)
        or window[2:] != [height, width]
    ):
        raise ImageryUnavailable("RECORDED_WINDOW_DOES_NOT_MATCH_CACHED_PIXELS")
    a, b, c, d, e, f = transform
    corners_native = [
        (c, f), (a * width + c, d * width + f),
        (a * width + b * height + c, d * width + e * height + f),
        (b * height + c, e * height + f),
    ]
    try:
        project = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        corners = [[float(lon), float(lat)] for lon, lat in (
            project.transform(x, y) for x, y in corners_native
        )]
    except (CRSError, ValueError, OverflowError):
        raise ImageryUnavailable("GEOREFERENCE_CORNERS_NOT_VERIFIABLE") from None
    if any(
        not all(math.isfinite(v) for v in pair)
        or not (-180 <= pair[0] <= 180 and -90 <= pair[1] <= 90)
        for pair in corners
    ):
        raise ImageryUnavailable("GEOREFERENCE_CORNERS_NOT_VERIFIABLE")
    valid = np.isfinite(array)
    count = int(np.count_nonzero(valid))
    if count == 0:
        raise ImageryUnavailable("NO_VALID_CALIBRATED_SAMPLES")
    if np.any(np.abs(array[valid]) > 200.0):
        raise ImageryUnavailable("CALIBRATED_VALUES_OUTSIDE_PLAUSIBLE_DB_RANGE")
    stride = max(1, math.ceil(max(height, width) / MAX_PNG_EDGE))
    preview = array[::stride, ::stride]
    return ImageryScene(
        scan_id=scan_id, status="READY", reason="CHECKSUM_VERIFIED_REAL_RTC_SOURCE",
        item_id=scene["item_id"], acquisition_time=scene["acquisition_time"],
        product="RTC", polarization=scene["polarization"], platform=scene["platform"],
        provider=scene["provider"], crs=crs, transform=transform,
        wgs84_corners_lon_lat=corners,
        raster_window=window, source_shape=[height, width],
        preview_shape=list(preview.shape), sample_stride=stride,
        valid_source_pixels=count, total_source_pixels=int(array.size),
        displayed_valid_pixels=int(np.count_nonzero(np.isfinite(preview))),
        image_url=f"/api/sar/imagery/scans/{scan_id}/image",
        display_window_db=list(DB_WINDOW),
        source="PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC",
    ), array


def scene_imagery(data_dir: Path, scan_id: str) -> ImageryScene:
    try:
        manifest, _ = _load_scene(data_dir, scan_id)
        return manifest
    except ImageryUnavailable as exc:
        return ImageryScene(scan_id=scan_id, status="UNAVAILABLE", reason=exc.code)


def imagery_pair(data_dir: Path, first_scan_id: str, second_scan_id: str) -> ImageryPair:
    first = scene_imagery(data_dir, first_scan_id)
    second = scene_imagery(data_dir, second_scan_id)
    ready = int(first.status == "READY") + int(second.status == "READY")
    return ImageryPair(first=first, second=second,
                       status=("READY" if ready == 2 else "PARTIAL" if ready else "UNAVAILABLE"))


def scene_image_png(data_dir: Path, scan_id: str) -> bytes:
    """Nearest-neighbour decimation, fixed absolute dB scale and transparent NoData."""
    manifest, array = _load_scene(data_dir, scan_id)
    assert manifest.sample_stride is not None
    sampled = array[::manifest.sample_stride, ::manifest.sample_stride]
    valid = np.isfinite(sampled)
    lo, hi = DB_WINDOW
    normalized = np.zeros(sampled.shape, dtype=np.uint8)
    normalized[valid] = np.rint(
        np.clip((sampled[valid].astype(np.float64) - lo) / (hi - lo), 0, 1) * 255
    ).astype(np.uint8)
    rgba = np.empty((*sampled.shape, 4), dtype=np.uint8)
    rgba[:, :, :3] = normalized[:, :, None]
    rgba[:, :, 3] = np.where(valid, 255, 0).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(rgba).save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()
