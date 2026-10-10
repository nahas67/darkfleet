"""Real land/water masking from ESA WorldCover 10 m (SAR-204..210).

Water = class 80 only. Mangroves (95) and wetlands (90) count as land:
a vessel cannot be distinguished from canopy there, and the coastline buffer
covers the ambiguity honestly.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.warp import reproject
from scipy.ndimage import binary_dilation

WORLDCOVER_VERSION = "ESA WorldCover v200 2021 (10 m, EPSG:4326)"
WORLDCOVER_TILE_BASE = "https://esa-worldcover.s3.amazonaws.com/v200/2021/map"
WATER_CLASS = 80
NODATA_CLASS = 0


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

    buf_px = max(0, round(coastline_buffer_m / pixel_spacing_m))
    if buf_px > 0:
        land = binary_dilation(land, iterations=buf_px)

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
