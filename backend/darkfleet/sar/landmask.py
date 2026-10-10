"""Real land/water masking from ESA WorldCover 10 m (SAR-204..210).

Water = class 80 only. Mangroves (95) and wetlands (90) count as land:
a vessel cannot be distinguished from canopy there, and the coastline buffer
covers the ambiguity honestly.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.warp import reproject
from scipy.ndimage import binary_dilation, distance_transform_cdt

WORLDCOVER_VERSION = "ESA WorldCover v200 2021 (10 m, EPSG:4326)"
WORLDCOVER_TILE_BASE = "https://esa-worldcover.s3.amazonaws.com/v200/2021/map"
WATER_CLASS = 80
NODATA_CLASS = 0
# The original iterative implementation is faster and uses far less memory for
# a small coastline buffer on multi-million-pixel grids. A fixed upper bound
# keeps that fast path O(pixels), regardless of the caller's requested radius.
_MAX_ITERATIVE_BUFFER_PX = 32


def tile_name_for(lon: float, lat: float) -> str:
    """3°x3° tile SW-corner naming: N00E102 covers 102–105E, 0–3N."""
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"{ns}{abs(int(lat // 3 * 3)):02d}{ew}{abs(int(lon // 3 * 3)):03d}"


def tile_url(lon: float, lat: float) -> str:
    name = tile_name_for(lon, lat)
    return f"{WORLDCOVER_TILE_BASE}/ESA_WorldCover_10m_2021_v200_{name}_Map.tif"


def fetch_tile_clip(
    tile_href: str,
    bbox_wgs84: tuple[float, float, float, float],
    out_path: str,
) -> dict[str, Any]:
    """Range-read the water-class window for an AOI and store it as a clip."""
    with rasterio.open(f"/vsicurl/{tile_href}") as src:
        assert src.crs == CRS.from_epsg(4326), src.crs
        from rasterio.windows import from_bounds

        win = from_bounds(*bbox_wgs84, transform=src.transform).round_offsets().round_lengths()
        arr = src.read(1, window=win)
        profile = {
            "driver": "GTiff",
            "dtype": arr.dtype.name,
            "count": 1,
            "width": win.width,
            "height": win.height,
            "crs": src.crs,
            "transform": src.window_transform(win),
            "compress": "deflate",
        }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(arr, 1)
    return {"tile_href": tile_href, "window": (win.row_off, win.col_off, win.height, win.width)}


def _dilate_land_bounded(land: np.ndarray, radius: int) -> np.ndarray:
    """Match ``binary_dilation(land, iterations=radius)`` with bounded work.

    SciPy's default two-dimensional footprint is a *four-neighbour cross*.
    Repeating it ``radius`` times includes precisely those pixels whose
    Manhattan (taxicab) distance to classified land is at most ``radius``.
    For small radii, keep the exact original morphology (at most 32 passes).
    For larger radii, ``distance_transform_cdt`` computes this once in
    O(pixels) time with one int32 distance field, independent of ``radius``.

    A single land pixel can reach any point within ``height+width-2`` steps.
    Saturating this computational radius preserves the old answer for even an
    astronomically large finite requested buffer. An all-water mask must remain
    empty (SciPy's CDT uses -1 when no source land pixel exists).
    """
    if radius <= 0 or land.size == 0 or not land.any():
        return land.copy()
    height, width = land.shape
    if radius >= height + width - 2:
        return np.ones_like(land, dtype=bool)
    if radius <= _MAX_ITERATIVE_BUFFER_PX:
        return binary_dilation(land, iterations=radius)
    return distance_transform_cdt(~land, metric="taxicab") <= radius


def build_land_mask(
    water_src_href: str,
    target_transform: Any,
    target_shape: tuple[int, int],
    target_crs: CRS,
    coastline_buffer_m: int = 150,
    pixel_spacing_m: float = 10.0,
    port_polys_wgs84: list[list[tuple[float, float]]] | None = None,
) -> dict[str, Any]:
    """Reproject water class onto the SAR grid; dilate land by the buffer.

    Returns `excluded` (True = do not detect here) plus provenance.
    Port/coastal exceptions carve navigable water back out of the exclusion.
    """
    height, width = target_shape
    water = np.zeros((height, width), dtype=np.uint8)
    with rasterio.open(water_src_href) as src:
        reproject(
            rasterio.band(src, 1),
            water,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=target_transform,
            dst_crs=target_crs,
            resampling=Resampling.nearest,
        )
    # A source without coverage is unknown, never surveyed open water. GDAL
    # initializes destinations outside the source footprint to class 0, so
    # treating 0 as water silently admits targets where no WorldCover data was
    # available to justify a maritime detection.
    unknown = water == NODATA_CLASS
    land = (water != WATER_CLASS) & ~unknown

    if not math.isfinite(pixel_spacing_m) or pixel_spacing_m <= 0:
        raise ValueError("pixel_spacing_m must be positive and finite")
    radius = coastline_buffer_m / pixel_spacing_m
    if not math.isfinite(radius):
        raise ValueError("coastline buffer radius must be finite")
    # Preserve the existing nearest-integer rounding, including tie behaviour.
    # The requested radius remains in provenance even if its computational
    # effect has saturated the entire finite source window.
    buf_px = max(0, round(radius))
    if buf_px > 0:
        land = _dilate_land_bounded(land, buf_px)

    if port_polys_wgs84:
        from rasterio.features import rasterize

        back = Transformer.from_crs(CRS.from_epsg(4326), target_crs, always_xy=True)
        reproj = []
        for poly in port_polys_wgs84:
            xs, ys = back.transform([p[0] for p in poly], [p[1] for p in poly])
            reproj.append(list(zip(xs, ys)))
        carved = rasterize(
            [({"type": "Polygon", "coordinates": [g]}, 1) for g in reproj],
            out_shape=(height, width),
            transform=target_transform,
            fill=0,
            dtype=np.uint8,
        ).astype(bool)
        land &= ~carved

    excluded = land | unknown
    land_frac = float(land.mean())
    return {
        "excluded": excluded,
        "land_fraction": land_frac,
        "unknown_fraction": float(unknown.mean()),
        "excluded_fraction": float(excluded.mean()),
        "buffer_px": buf_px,
        "provenance": {
            "source": WORLDCOVER_VERSION,
            "water_href": water_src_href,
            "water_class": WATER_CLASS,
            "nodata_policy": "EXCLUDED_UNKNOWN_NOT_WATER",
            "unknown_fraction": float(unknown.mean()),
            "coastline_buffer_m": coastline_buffer_m,
            "port_exceptions": len(port_polys_wgs84 or []),
        },
    }
