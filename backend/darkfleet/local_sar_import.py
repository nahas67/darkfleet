"""Local-only, operator-supplied GeoTIFF intake, independent of the scan pipeline.

An accepted file is copied byte-for-byte into a checksum-verifiable local archive.
The receipt is append-only; no import creates a SAR observation or completed scan.
Operator declarations about calibration, product and time are never independently
verified by this module.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import stat
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import rasterio  # type: ignore[import-untyped]
from PIL import Image
from pyproj import Transformer
from rasterio.windows import Window  # type: ignore[import-untyped]

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 8_000_000
MAX_EDGE = 8192
MAX_PREVIEW_EDGE = 768
MAX_RECEIPT_BYTES = 32 * 1024
_BASENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,126}\.(?:tif|tiff)", re.IGNORECASE)
_IMPORT_ID = re.compile(r"[a-f0-9]{32}")
_CHUNK = 1024 * 1024
_LOCK = threading.RLock()

LIMITATIONS = [
    "IMPORTED_NOT_ANALYZED: no detection, target, AIS match or completed scan was created.",
    ("Product, polarization, acquisition time and calibration are operator declarations; "
     "GeoTIFF metadata does not establish radar calibration or acquisition provenance."),
    ("The preview uses a percentile stretch of actual sampled values for display only; "
     "it does not assert backscatter units, pixel alignment or spatial resolution in meters."),
    "Raster affine and CRS are read from this file; no sensor or terrain correction is inferred.",
]


class LocalSarError(ValueError):
    """Safe externally reportable error, never embedding host filesystem paths."""

    def __init__(self, code: str, http_status: int = 422):
        super().__init__(code)
        self.code = code
        self.http_status = http_status


def _safe_dir(path: Path, *, create: bool) -> Path:
    if create:
        path.mkdir(parents=True, exist_ok=True)
    try:
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise LocalSarError("DIRECTORY_LINK_NOT_ALLOWED", 403)
        resolved = path.resolve(strict=True)
        if not resolved.is_dir():
            raise LocalSarError("NOT_A_DIRECTORY", 409)
        return resolved
    except (OSError, RuntimeError):
        raise LocalSarError("DIRECTORY_UNAVAILABLE", 503) from None


def inbox_dir(data_dir: Path) -> Path:
    """Only trusted process configuration can select a nondefault inbox."""
    override = os.environ.get("DARKFLEET_LOCAL_SAR_ROOT", "").strip()
    if override:
        configured = Path(override)
        if not configured.is_absolute():
            raise LocalSarError("CONFIGURED_INBOX_MUST_BE_ABSOLUTE", 503)
        return _safe_dir(configured, create=False)
    return _safe_dir(Path(data_dir) / "local-sar-inbox", create=True)


def _archive_dir(data_dir: Path) -> Path:
    return _safe_dir(Path(data_dir) / "local-sar-imports", create=True)


def _valid_name(name: str) -> str:
    if not isinstance(name, str) or not _BASENAME.fullmatch(name) or ".." in name:
        raise LocalSarError("INVALID_RELATIVE_TIFF_BASENAME")
    return name


def _safe_input_file(root: Path, basename: str) -> Path:
    candidate = root / _valid_name(basename)
    try:
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise LocalSarError("SOURCE_LINK_NOT_ALLOWED", 403)
        resolved = candidate.resolve(strict=True)
        if resolved.parent != root or not resolved.is_file():
            raise LocalSarError("SOURCE_OUTSIDE_INBOX", 403)
        return candidate
    except FileNotFoundError:
        raise LocalSarError("SOURCE_NOT_FOUND", 404) from None
    except (OSError, RuntimeError):
        raise LocalSarError("SOURCE_UNAVAILABLE", 409) from None


def _source_stat(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise LocalSarError("SOURCE_NOT_REGULAR", 403)
    if info.st_nlink > 1:
        raise LocalSarError("SOURCE_HARDLINK_NOT_ALLOWED", 403)
    if info.st_size <= 0 or info.st_size > MAX_FILE_BYTES:
        raise LocalSarError("SOURCE_EMPTY_OR_EXCEEDS_SIZE_LIMIT")
    return info


def _same_file(a: os.stat_result, b: os.stat_result) -> bool:
    return (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns) == (
        b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns
    )


def _copy_verified_source(source: Path, archive: Path) -> tuple[Path, str]:
    """Use a non-following source descriptor, enforce length while copying."""
    before = _source_stat(source)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(source, flags)
    tmp_path: Path | None = None
    try:
        if not _same_file(before, os.fstat(fd)):
            raise LocalSarError("SOURCE_CHANGED_DURING_READ", 409)
        digest = hashlib.sha256()
        amount = 0
        with (os.fdopen(fd, "rb", closefd=False) as reader,
              tempfile.NamedTemporaryFile(dir=archive, prefix=".ingest-", suffix=".tif",
                                         delete=False) as writer):
            tmp_path = Path(writer.name)
            while True:
                chunk = reader.read(_CHUNK)
                if not chunk:
                    break
                amount += len(chunk)
                if amount > MAX_FILE_BYTES:
                    raise LocalSarError("SOURCE_EXCEEDS_SIZE_LIMIT")
                writer.write(chunk)
                digest.update(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        if amount != before.st_size or not _same_file(before, source.lstat()):
            raise LocalSarError("SOURCE_CHANGED_DURING_READ", 409)
        if amount == 0:
            raise LocalSarError("SOURCE_EMPTY")
        return tmp_path, digest.hexdigest()
    except OSError:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise LocalSarError("SOURCE_READ_FAILED", 409) from None
    except BaseException:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise
    finally:
        os.close(fd)


def _copy_hash(path: Path, max_bytes: int) -> str:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes
            or info.st_nlink > 1):
        raise LocalSarError("ARCHIVE_UNAVAILABLE", 409)
    digest = hashlib.sha256()
    size = 0
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        if not _same_file(info, os.fstat(stream.fileno())):
            raise LocalSarError("ARCHIVE_UNAVAILABLE", 409)
        while chunk := stream.read(_CHUNK):
            size += len(chunk)
            if size > max_bytes:
                raise LocalSarError("ARCHIVE_UNAVAILABLE", 409)
            digest.update(chunk)
    return digest.hexdigest()


def _valid_affine(ds: Any) -> list[float]:
    transform = [float(value) for value in tuple(ds.transform)[:6]]
    a, b, c, d, e, f = transform
    size = max(abs(a), abs(b), abs(d), abs(e))
    determinant = a * e - b * d
    if (not all(map(math.isfinite, transform)) or size == 0
            or abs(determinant) <= size * size * 1e-12 or ds.transform.is_identity):
        raise LocalSarError("GEOREFERENCE_AFFINE_INVALID")
    return [a, b, c, d, e, f]


def _geography(ds: Any, transform: list[float]) -> tuple[list[list[float]], list[float]]:
    if ds.crs is None:
        raise LocalSarError("GEOREFERENCE_CRS_MISSING")
    try:
        projector = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)
        def project(col: float, row: float) -> list[float]:
            a, b, c, d, e, f = transform
            x, y = (a * col + b * row + c, d * col + e * row + f)
            lon, lat = projector.transform(x, y, errcheck=True)
            if not (math.isfinite(lon) and math.isfinite(lat)
                    and -180 <= lon <= 180 and -90 <= lat <= 90):
                raise LocalSarError("GEOREFERENCE_OUTSIDE_WGS84")
            return [float(lon), float(lat)]
        corners = [project(0, 0), project(ds.width, 0),
                   project(ds.width, ds.height), project(0, ds.height)]
        first_pixel_center = project(.5, .5)
    except LocalSarError:
        raise
    except (ValueError, RuntimeError, TypeError):
        raise LocalSarError("GEOREFERENCE_CANNOT_TRANSFORM_TO_WGS84") from None
    return corners, first_pixel_center


def _inspect_raster(path: Path, declarations: dict[str, Any]) -> dict[str, Any]:
    try:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_PAM_ENABLED="NO",
                          PROJ_NETWORK="OFF"), rasterio.open(path, driver="GTiff") as ds:
                if ds.driver != "GTiff" or ds.count != 1:
                    raise LocalSarError("SINGLE_BAND_GEOTIFF_REQUIRED")
                if (ds.width < 1 or ds.height < 1 or ds.width > MAX_EDGE or ds.height > MAX_EDGE
                        or ds.width * ds.height > MAX_PIXELS):
                    raise LocalSarError("RASTER_DIMENSIONS_EXCEED_LIMIT")
                if np.dtype(ds.dtypes[0]).kind not in "iuf":
                    raise LocalSarError("RASTER_DTYPE_UNSUPPORTED")
                transform = _valid_affine(ds)
                corners, first_center = _geography(ds, transform)
                valid = 0
                for row in range(0, ds.height, 512):
                    for col in range(0, ds.width, 512):
                        window = Window(col, row, min(512, ds.width-col),
                                        min(512, ds.height-row))
                        sample = ds.read(1, window=window, masked=True)
                        usable = ~np.ma.getmaskarray(sample) & np.isfinite(sample.data)
                        valid += int(np.count_nonzero(usable))
                if valid == 0:
                    raise LocalSarError("RASTER_HAS_NO_VALID_PIXELS")
                stride = max(1, math.ceil(max(ds.width, ds.height) / MAX_PREVIEW_EDGE))
                return {
                    **declarations,
                    "width": ds.width, "height": ds.height, "dtype": ds.dtypes[0],
                    "crs": str(ds.crs), "transform": transform, "nodata": (
                        float(ds.nodata) if ds.nodata is not None and math.isfinite(ds.nodata)
                        else None
                    ),
                    "wgs84_corners_lon_lat": corners,
                    "pixel_center_wgs84_lon_lat": first_center,
                    "valid_pixels": valid, "total_pixels": ds.width * ds.height,
                    "preview_shape": [math.ceil(ds.height / stride), math.ceil(ds.width / stride)],
                    "preview_sample_stride": stride,
                    "georeferencing": "AFFINE_CRS_OBSERVED_FROM_FILE",
                    "calibration_verified": False,
                    "acquisition_verified": False,
                }
    except LocalSarError:
        raise
    except (rasterio.errors.RasterioError, OSError, ValueError, TypeError):
        raise LocalSarError("GEOTIFF_UNREADABLE_OR_UNSUPPORTED") from None


def _validate_id(import_id: str) -> str:
    if not _IMPORT_ID.fullmatch(import_id):
        raise LocalSarError("INVALID_IMPORT_ID", 404)
    return import_id


def _receipt(data_dir: Path, import_id: str) -> dict[str, Any]:
    path = _archive_dir(data_dir) / f"{_validate_id(import_id)}.json"
    if path.is_symlink():
        raise LocalSarError("RECEIPT_UNAVAILABLE", 409)
    try:
        if path.stat().st_size > MAX_RECEIPT_BYTES:
            raise LocalSarError("RECEIPT_UNAVAILABLE", 409)
        doc = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(doc, dict) or doc.get("import_id") != import_id
                or not isinstance(doc.get("sha256"), str)
                or not re.fullmatch("[0-9a-f]{64}", doc["sha256"])):
            raise LocalSarError("RECEIPT_UNAVAILABLE", 409)
        return doc
    except FileNotFoundError:
        raise LocalSarError("IMPORT_NOT_FOUND", 404) from None
    except (OSError, UnicodeError, ValueError, TypeError):
        raise LocalSarError("RECEIPT_UNAVAILABLE", 409) from None


def _archive_integrity(data_dir: Path, record: dict[str, Any]) -> str:
    candidate = _archive_dir(data_dir) / f"{_validate_id(record['import_id'])}.tif"
    try:
        if candidate.is_symlink() or candidate.resolve(strict=True).parent != _archive_dir(data_dir):
            return "UNAVAILABLE"
        return "VERIFIED" if _copy_hash(candidate, MAX_FILE_BYTES) == record["sha256"] else "CHANGED"
    except (OSError, ValueError, LocalSarError):
        return "MISSING" if not candidate.exists() else "UNAVAILABLE"


def _source_integrity(data_dir: Path, record: dict[str, Any]) -> str:
    try:
        path = _safe_input_file(inbox_dir(data_dir), record["source"]["relative_path"])
        return "VERIFIED" if _copy_hash(path, MAX_FILE_BYTES) == record["sha256"] else "CHANGED"
    except LocalSarError as exc:
        return "MISSING" if exc.code == "SOURCE_NOT_FOUND" else "UNAVAILABLE"
    except (OSError, KeyError, TypeError, ValueError):
        return "UNAVAILABLE"


def _output(data_dir: Path, record: dict[str, Any]) -> dict[str, Any]:
    result = dict(record)
    result["source_integrity"] = _source_integrity(data_dir, record)
    result["snapshot_integrity"] = _archive_integrity(data_dir, record)
    result["image_url"] = f"/api/sar/local/imports/{record['import_id']}/image"
    return result


def import_local_geotiff(
    data_dir: Path, *, relative_path: str, product: str,
    polarization: str | None = None, acquisition_time: str | None = None,
    calibration: str | None = None,
) -> dict[str, Any]:
    """Persist a bounded pixel snapshot and receipt; deterministic repeat import ID."""
    declarations = {
        "product": product, "polarization": polarization,
        "acquisition_time": acquisition_time, "calibration": calibration or "UNKNOWN",
    }
    source = _safe_input_file(inbox_dir(data_dir), relative_path)
    archive = _archive_dir(data_dir)
    with _LOCK:
        temporary: Path | None = None
        try:
            temporary, sha = _copy_verified_source(source, archive)
            metadata = _inspect_raster(temporary, declarations)
            identity = json.dumps({"relative_path": relative_path, "sha256": sha,
                                   **declarations}, sort_keys=True, separators=(",", ":"))
            import_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
            receipt = archive / f"{import_id}.json"
            saved_raster = archive / f"{import_id}.tif"
            if receipt.exists():
                previous = _receipt(data_dir, import_id)
                if previous["sha256"] != sha:
                    raise LocalSarError("RECEIPT_IDENTITY_CONFLICT", 409)
                return _output(data_dir, previous)
            if saved_raster.exists():
                if saved_raster.is_symlink() or _copy_hash(saved_raster, MAX_FILE_BYTES) != sha:
                    raise LocalSarError("SNAPSHOT_IDENTITY_CONFLICT", 409)
            else:
                # Atomic exclusive creation: another process cannot replace a saved snapshot.
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
                fd = os.open(saved_raster, flags, 0o600)
                try:
                    with os.fdopen(fd, "wb") as writer, temporary.open("rb") as reader:
                        for chunk in iter(lambda: reader.read(_CHUNK), b""):
                            writer.write(chunk)
                        writer.flush()
                        os.fsync(writer.fileno())
                except BaseException:
                    saved_raster.unlink(missing_ok=True)
                    raise
            record = {
                "import_id": import_id, "status": "IMPORTED_NOT_ANALYZED", "sha256": sha,
                "created_at": datetime.now(UTC).isoformat(),
                "source": {"relative_path": relative_path, "sha256": sha,
                           "origin": "OPERATOR_LOCAL_INBOX"},
                "metadata": metadata, "limitations": LIMITATIONS.copy(),
            }
            try:
                with receipt.open("x", encoding="utf-8") as stream:
                    json.dump(record, stream, sort_keys=True, allow_nan=False)
                    stream.flush()
                    os.fsync(stream.fileno())
            except FileExistsError:
                return _output(data_dir, _receipt(data_dir, import_id))
            return _output(data_dir, record)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def get_local_import(data_dir: Path, import_id: str) -> dict[str, Any]:
    return _output(data_dir, _receipt(data_dir, import_id))


def list_local_imports(data_dir: Path, *, limit: int = 100) -> dict[str, Any]:
    root = _archive_dir(data_dir)
    names = sorted((p.name for p in root.glob("*.json") if _IMPORT_ID.fullmatch(p.stem)),
                   reverse=True)
    records = [_output(data_dir, _receipt(data_dir, name[:-5])) for name in names[:limit]]
    return {"status": "READY", "total": len(names), "imports": records}


def local_import_status(data_dir: Path) -> dict[str, Any]:
    inbox = inbox_dir(data_dir)
    _archive_dir(data_dir)
    return {
        "status": "READY", "enabled": True, "inbox_name": inbox.name,
        "max_file_bytes": MAX_FILE_BYTES, "max_pixels": MAX_PIXELS,
        "scope": "LOOPBACK_ONLY", "analysis": "IMPORT_ONLY",
        "extensions": [".tif", ".tiff"],
    }


def local_import_image(data_dir: Path, import_id: str) -> bytes:
    record = _receipt(data_dir, import_id)
    path = _archive_dir(data_dir) / f"{import_id}.tif"
    meta = record.get("metadata", {})
    try:
        # Parse precisely the bytes that were hashed, excluding rename/swap races
        # between path hashing and GDAL's later file open.
        if path.is_symlink() or path.lstat().st_nlink > 1:
            raise LocalSarError("SNAPSHOT_MISSING_OR_CHANGED", 409)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            fileinfo = os.fstat(stream.fileno())
            if not stat.S_ISREG(fileinfo.st_mode) or fileinfo.st_size > MAX_FILE_BYTES:
                raise LocalSarError("SNAPSHOT_MISSING_OR_CHANGED", 409)
            content = stream.read(MAX_FILE_BYTES + 1)
        if (len(content) != fileinfo.st_size or len(content) > MAX_FILE_BYTES
                or hashlib.sha256(content).hexdigest() != record["sha256"]):
            raise LocalSarError("SNAPSHOT_MISSING_OR_CHANGED", 409)
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_PAM_ENABLED="NO",
                          PROJ_NETWORK="OFF"), rasterio.MemoryFile(content) as mem, \
                mem.open(driver="GTiff") as ds:
                # The geometry is revalidated even though the archive checksum matched.
                if ds.count != 1 or [ds.height, ds.width] != [meta["height"], meta["width"]]:
                    raise LocalSarError("SNAPSHOT_METADATA_MISMATCH", 409)
                stride = meta["preview_sample_stride"]
                height, width = meta["preview_shape"]
                if (not isinstance(stride, int) or stride < 1 or not isinstance(height, int)
                        or not isinstance(width, int) or height < 1 or width < 1
                        or height > MAX_PREVIEW_EDGE or width > MAX_PREVIEW_EDGE):
                    raise LocalSarError("INVALID_PREVIEW_GEOMETRY", 409)
                # Exactly one measured pixel per preview cell (no inferred interpolated pixels).
                sample = ds.read(1, out_shape=(height, width), masked=True,
                                 resampling=rasterio.enums.Resampling.nearest)
                values = np.asarray(sample.data, dtype=np.float64)
                mask = ~np.ma.getmaskarray(sample) & np.isfinite(values)
                if not mask.any():
                    raise LocalSarError("PREVIEW_NO_VALID_PIXELS", 409)
                low, high = np.percentile(values[mask], [2, 98])
                grey = np.zeros(values.shape, dtype=np.uint8)
                if high > low:
                    grey[mask] = np.clip((values[mask] - low) / (high - low) * 255,
                                         0, 255).astype(np.uint8)
                elif math.isfinite(low):
                    grey[mask] = 127
                rgba = np.stack((grey, grey, grey, mask.astype(np.uint8) * 255), axis=-1)
                buffer = io.BytesIO()
                Image.fromarray(rgba, "RGBA").save(buffer, format="PNG")
                return buffer.getvalue()
    except LocalSarError:
        raise
    except (rasterio.errors.RasterioError, OSError, ValueError, KeyError, TypeError):
        raise LocalSarError("PREVIEW_UNAVAILABLE", 409) from None
