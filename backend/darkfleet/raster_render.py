"""Georeferenced SAR raster rendering (UI-D1).

Why this module exists
---------------------
``LAYER_DEFS`` advertises ``SAR_RASTER`` as ``AVAILABLE`` but nothing ever fed it,
so a layer switch in the UI changed no Cesium object: the audit measured zero
imagery calls for ``ImageryLayer`` / ``singleTile``. A SAR correlation tool that
cannot show the SAR it correlated is missing its central surface.

Why server-side, and not a URL handed to Cesium
-----------------------------------------------
A Cesium ``SingleTileImageryProvider`` expects a PNG/JPEG it can decode. The
pipeline's assets are GeoTIFF/COG over HTTP (``*.rtc.tiff``), which a browser
cannot display. Handing that URL straight to Cesium -- the failure mode the brief
warns about -- produces a silently blank layer.

So the path is:

    cached array + affine transform  ->  reprojected bounds  ->  PNG  ->  Cesium

The array is already in the artifact cache from the scan, so this renders the
*exact* pixels the detections were computed from. That is the point: the image on
the globe is the image the CFAR threshold was applied to, not a re-fetch that
might differ.

Honesty constraints
-------------------
* The rectangle is computed from the measured affine transform and CRS in the
  record, then reprojected to WGS84. It is never an assumed or padded extent. A
  scene with no measured georeferencing returns 422 and explains, rather than
  placing an image at a guessed location.
* Every response carries the values it actually measured: shape, dtype, min,
  max, mean, std, the CRS, the transform, and the downsample factor. A resampled
  image says it was resampled.
* Stretching is a MIN/MAX percentile stretch over the MEASURED values. It never
  substitutes a constant range, so a low-contrast scene renders low-contrast
  rather than being stretched into fake detail.
* No colour here implies classification. The false-colour mode is an analytical
  contrast aid over measured dB and is labelled as such.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from PIL import Image

#: Raster layers that may be rendered, mapped to the cache artifact holding them.
#:
#: The cache stores each array under the LAYER name itself (`raw`, `filtered`, ...),
#: not under the in-memory result key that ``_LAYER_SOURCE`` names (`raw_db`,
#: `threshold_db`, ...). The first version of this table used the in-memory names
#: and therefore found only the two layers whose names happened to coincide, which
#: is how `raw` and `filtered` came back as "not stored" for a scan that had them.
RASTER_LAYERS: dict[str, str] = {
    "raw": "raw",
    "normalized": "normalized",
    "filtered": "filtered",
    "landmask": "landmask",
    "cfar_threshold": "cfar_threshold",
    "detection_mask": "detection_mask",
}

#: Rendering modes. `stretch` is the honest default; `raw` is a fixed dB window;
#: `falsecolor` is an analytical contrast aid over the measured distribution.
RasterMode = Literal["stretch", "raw", "falsecolor"]

#: Fixed display window for `raw` mode, in dB. Chosen to match the range the
#: Sentinel-1 RTC product is distributed in, NOT fitted to any scene.
RAW_DB_WINDOW = (-30.0, 5.0)

#: Longest edge of a rendered tile, in pixels. The pipeline window is typically
#: a few hundred pixels per side; this bounds a pathological AOI without making a
#: large one unreadable. The factor applied is always REPORTED.
MAX_EDGE = 2048

#: Below this, the array is displayed at 1:1 and the factor is 1.
MIN_EDGE_FOR_UPSAMPLE = 1


@dataclass(frozen=True)
class RasterBounds:
    """WGS84 bounding box plus the native geometry it was derived from."""

    west: float
    south: float
    east: float
    north: float

    def as_rectangle(self) -> dict[str, float]:
        """The shape Cesium's SingleTileImageryProvider wants."""
        return {
            "west": self.west,
            "south": self.south,
            "east": self.east,
            "north": self.north,
        }

    def as_list(self) -> list[float]:
        return [self.west, self.south, self.east, self.north]


class RasterNotRenderableError(Exception):
    """The scan holds nothing this renderer can honestly draw."""

    def __init__(self, reason: str, **detail: Any) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _transform_to_bounds(transform: list[float], crs: str, width: int, height: int) -> RasterBounds:
    """Reproject the raster's four corners into a WGS84 bounding box.

    ``transform`` is the 6-element rasterio affine (a, b, c, d, e, f) where
    ``x = a*col + b*row + c`` and ``y = d*col + e*row + f``.

    Every corner is transformed rather than assuming a north-up, axis-aligned
    raster: a rotated or sheared window would otherwise be placed wrong, and a
    detection inside it would land in the sea.
    """
    if not transform or len(transform) != 6:
        raise RasterNotRenderableError(
            "the scan record carries no affine transform, so its raster extent "
            "cannot be established; placing an image without one would put it at "
            "a guessed location",
            transform=transform,
        )
    if not crs:
        raise RasterNotRenderableError(
            "the scan record carries no CRS, so its raster extent cannot be reprojected",
            crs=crs,
        )

    a, b, c, d, e, f = (float(v) for v in transform)

    def to_map(col: float, row: float) -> tuple[float, float]:
        return (a * col + b * row + c, d * col + e * row + f)

    corners = [
        to_map(0.0, 0.0),
        to_map(float(width), 0.0),
        to_map(float(width), float(height)),
        to_map(0.0, float(height)),
    ]

    try:
        from pyproj import Transformer

        transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        lons: list[float] = []
        lats: list[float] = []
        for x, y in corners:
            lon, lat = transformer.transform(x, y)
            if not (math.isfinite(lon) and math.isfinite(lat)):
                raise RasterNotRenderableError(
                    "reprojecting a raster corner produced a non-finite coordinate",
                    corner=[x, y],
                    crs=crs,
                )
            lons.append(lon)
            lats.append(lat)
    except ImportError as exc:  # pragma: no cover - pyproj ships with the backend
        raise RasterNotRenderableError(
            "pyproj is required to reproject a raster extent but is not installed",
            crs=crs,
        ) from exc

    return RasterBounds(
        west=float(min(lons)),
        south=float(min(lats)),
        east=float(max(lons)),
        north=float(max(lats)),
    )


def _stats(array: np.ndarray) -> tuple[dict[str, float], str]:
    """Measured statistics. NaN-safe; the reported window is what was measured.

    A boolean mask is reported as a COUNT and a FRACTION rather than as
    percentiles: `np.percentile` on a bool array raises, and a "1st-99th
    percentile" over two values would be a meaningless way to describe a
    two-tone image. True/false fraction is the fact that matters.
    """
    if array.dtype == np.bool_:
        total = int(array.size)
        true_count = int(np.count_nonzero(array))
        return {
            "min": 0.0,
            "max": 1.0,
            "mean": (true_count / total) if total else 0.0,
            "std": 0.0,
            "p01": 0.0,
            "p99": 1.0,
            "finite_fraction": 1.0,
            "true_count": float(true_count),
            "false_count": float(total - true_count),
        }, "binary mask, no stretch applied"

    values = np.asarray(array, dtype=np.float64)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return (
            {"min": 0.0, "max": 0.0, "mean": 0.0, "std": 0.0, "finite_fraction": 0.0},
            "no finite samples; nothing measured",
        )
    lo, hi = float(np.percentile(finite, 1)), float(np.percentile(finite, 99))
    # A degenerate window divides by zero. Widening by one unit keeps the render
    # well defined, but the widened window is NOT a percentile measurement, so
    # `window_basis` records that. The committed fixture hits this: its water
    # background is one clamped -90 dB across >98% of pixels, so p1 == p99 and
    # the synthetic span is what actually gets rendered. Reporting that as "the
    # measured 1st-99th percentile" would be the same class of lie as a
    # mislabelled colour ramp -- the number is real, the description is not.
    basis = "measured 1st-99th percentile of this window"
    if hi <= lo:
        hi = lo + 1.0
        basis = (
            "percentile window was degenerate (one value dominates the scene); "
            "widened to a 1-unit synthetic span, which is NOT a percentile measurement"
        )
    return {
        "min": float(np.min(finite)),
        "max": float(np.max(finite)),
        "mean": float(np.mean(finite)),
        "std": float(np.std(finite)),
        "p01": lo,
        "p99": hi,
        "finite_fraction": float(finite.size / values.size),
    }, basis


def _normalise(array: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Scale measured values onto 0..1 using the MEASURED window.

    Non-finite samples are mapped to ``lo`` first. ``np.clip`` does not remove
    NaN -- it propagates it -- so a single nodata pixel reached the
    ``astype(np.uint8)`` cast and raised a RuntimeWarning, then silently became
    0. Nodata rendering as the darkest tone is the intended reading anyway, but
    it must be done deliberately rather than as a side effect of an invalid cast.

    A degenerate window (``hi <= lo``) is total by construction: it renders as a
    hard threshold at ``lo`` rather than dividing by zero. That case is
    reachable -- a scene whose background is one clamped value pushes p1 and p99
    to the same number -- and the divide produced ``0/0`` NaN, which then rode
    the same ``astype`` path described above. Undefined behaviour that happens
    to look like a plausible image is exactly what this function must not do.
    """
    clean = np.where(np.isfinite(array), array, lo)
    span = hi - lo
    if not (math.isfinite(span) and span > 0.0):
        return (clean > lo).astype(np.float64)
    scaled = (clean - lo) / span
    # Belt and braces: clip cannot remove a NaN that survived the division.
    return np.clip(np.nan_to_num(scaled, nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0)


def _grayscale(normalised: np.ndarray) -> np.ndarray:
    """A single-channel uint8 image, north-up (row 0 is north)."""
    return (normalised * 255.0).astype(np.uint8)


def _falsecolor(normalised: np.ndarray) -> np.ndarray:
    """An analytical contrast aid over the measured dB distribution.

    Deliberately NOT a rainbow ramp. A perceptual ramp applied to radar
    backscatter implies an ordering between hues that does not exist, and
    rainbow maps are the classic way to manufacture false structure. This is a
    single-hue ramp: brighter means more backscatter, which is a true statement
    about the measurement.
    """
    v = (normalised * 255.0).astype(np.uint8)
    rgb = np.zeros(v.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = v
    rgb[..., 1] = (v * 0.86).astype(np.uint8)
    rgb[..., 2] = (v * 0.55).astype(np.uint8)
    return rgb


def _binary_overlay(mask: np.ndarray) -> np.ndarray:
    """A binary layer (land mask, detection mask) as an unambiguous two-tone image.

    Masked pixels are opaque amber, unmasked are near-black. Two tones only: a
    binary measurement has no gradient, and rendering one with a gradient would
    invent intermediate states.
    """
    m = np.asarray(mask, dtype=bool)
    rgb = np.zeros(m.shape + (3,), dtype=np.uint8)
    # NaN in a mask is unknown, not False: nodata means "the land mask was not
    # evaluated here", which is a different statement from "this is water".
    unknown = np.isnan(np.asarray(mask, dtype=np.float64)) if np.asarray(mask).dtype.kind == "f" else np.zeros(m.shape, bool)
    rgb[m] = (255, 199, 107)
    rgb[unknown] = (40, 44, 48)
    rgb[~m & ~unknown] = (8, 12, 16)
    return rgb


def _resize(array: np.ndarray, factor: int) -> np.ndarray:
    """Nearest-neighbour downsample by an integer factor.

    Nearest, not averaging: averaging dB is not a physically meaningful operation
    (dB is logarithmic, so the mean of two dB values does not correspond to any
    real backscatter). Nearest preserves the actual measured sample values.
    """
    if factor <= 1:
        return array
    h, w = array.shape[0] // factor, array.shape[1] // factor
    return array[: h * factor : factor, : w * factor : factor]


def render_png(
    array: np.ndarray,
    *,
    layer: str,
    mode: RasterMode = "stretch",
) -> tuple[bytes, dict[str, Any]]:
    """Render a pipeline array to PNG bytes plus the metadata that describes it.

    Returns the encoded image and a report of exactly what was done, so the caller
    can state the scale and the display window rather than implying 1:1.
    """
    if array.ndim != 2:
        raise RasterNotRenderableError(
            f"expected a 2-D array for a raster layer, got shape {array.shape}",
            shape=list(array.shape),
        )
    if array.size == 0:
        raise RasterNotRenderableError("the stored array is empty", shape=list(array.shape))

    src_h, src_w = array.shape
    factor = max(1, math.ceil(max(src_h, src_w) / MAX_EDGE))
    work = _resize(array, factor)

    stats, measured_basis = _stats(work)
    is_binary = layer in ("landmask", "detection_mask")

    # Typed explicitly: the binary branch has no numeric window, so the dict
    # holds `None` where the measurement branches hold floats.
    window: dict[str, Any]
    if is_binary:
        image_array = _binary_overlay(work)
        window = {"lo": None, "hi": None, "basis": "binary mask, no stretch applied"}
    else:
        if mode == "raw":
            lo, hi = RAW_DB_WINDOW
            window = {
                "lo": lo,
                "hi": hi,
                "basis": "fixed display window for RTC dB products, not fitted to this scene",
            }
        else:
            lo, hi = float(stats["p01"]), float(stats["p99"])
            # `_stats` owns the degenerate-window decision and reports which
            # window it actually used, so the basis string cannot claim a
            # percentile stretch that did not happen.
            basis = measured_basis
            if mode == "falsecolor":
                basis += ", false-colour ramp"
            window = {"lo": lo, "hi": hi, "basis": basis}

        normalised = _normalise(np.asarray(work, dtype=np.float64), lo, hi)
        image_array = _grayscale(normalised) if mode != "falsecolor" else _falsecolor(normalised)

    # PIL validates the array rank against the mode: a 2-D uint8 array must be
    # mode "L". Passing mode "RGB" with a 2-D array raised "not enough image data"
    # from inside the encoder, which surfaced as an opaque 400 rather than as a
    # rendering bug. The mode now follows the array.
    pil_mode = "L" if image_array.ndim == 2 else "RGB"
    img = Image.fromarray(image_array, mode=pil_mode)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)

    report = {
        "layer": layer,
        "mode": pil_mode,
        "source_shape": [int(src_h), int(src_w)],
        "rendered_shape": [int(work.shape[0]), int(work.shape[1])],
        "downsample_factor": factor,
        "display_window": window,
        "stats": {k: round(v, 4) for k, v in stats.items()},
        "binary": is_binary,
    }
    return buf.getvalue(), report


def available_layers(record_artifacts: dict[str, Any]) -> list[str]:
    """Which layers this scan can actually render.

    Driven by what the cache holds, so the UI can never offer a raster the
    backend cannot produce for this particular scan.
    """
    return [name for name, source in RASTER_LAYERS.items() if record_artifacts.get(source) is not None]


def rectangle_for(
    array: np.ndarray,
    *,
    crs: str,
    transform: list[float],
) -> RasterBounds:
    """Bounds for an array, using the measured transform and CRS."""
    return _transform_to_bounds(transform, crs, int(array.shape[1]), int(array.shape[0]))


__all__ = [
    "MAX_EDGE",
    "RASTER_LAYERS",
    "RAW_DB_WINDOW",
    "RasterBounds",
    "RasterMode",
    "RasterNotRenderableError",
    "available_layers",
    "rectangle_for",
    "render_png",
]