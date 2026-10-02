"""Georeferencing: pixel -> source CRS -> WGS84. Never assume WGS84 input."""

from __future__ import annotations

from typing import Any, cast

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.windows import Window, from_bounds

from ..geolocation import AffineLike
from ..providers import RealDataUnavailableError
from ..providers.stac import SarAsset


def read_window(href: str, bbox_wgs84: tuple[float, float, float, float]) -> dict[str, Any]:
    """Windowed read of a georeferenced raster in its NATIVE CRS.

    Returns the array plus the window transform so every pixel stays traceable
    to a geographic coordinate. Refuses UNREFERENCED assets loudly.
    """
    with rasterio.open(href) as ds:
        if ds.crs is None or ds.transform.is_identity:
            _maybe_raise_gcp(ds)
            raise RealDataUnavailableError(
                "SAR asset has neither affine georeferencing nor usable GCPs; "
                "refusing to guess pixel locations.",
                details={"href": href[:120]},
                suggestions=["Use a GCP-referenced asset via the warp path, or another provider."],
            )
        native = _reproject_aoi(bbox_wgs84, ds.crs)
        win = from_bounds(*native, transform=ds.transform).round_offsets().round_lengths()
        win = _clamp_window(win, ds.width, ds.height)
        arr = ds.read(1, window=win)
        return {
            "array": np.asarray(arr),
            "crs": ds.crs,
            "window_transform": ds.window_transform(win),
            "window": (win.row_off, win.col_off, win.height, win.width),
            "nodata": ds.nodata,
            "dtype": ds.dtypes[0],
        }


def _maybe_raise_gcp(ds: Any) -> None:
    gcps, _ = ds.gcps
    if gcps:
        raise RealDataUnavailableError(
            "SAR asset is GCP-referenced (no affine transform). Route through the GCP warp path.",
            details={"gcp_count": len(gcps)},
            suggestions=["Warp GCP asset to an affine GeoTIFF before detection."],
        )


def _reproject_aoi(
    bbox_wgs84: tuple[float, float, float, float], crs: CRS
) -> tuple[float, float, float, float]:
    """WGS84 AOI into the raster's native CRS (densified edges)."""
    if crs == CRS.from_epsg(4326):
        return bbox_wgs84
    return aoi_to_crs_bounds(bbox_wgs84, crs)


def _clamp_window(win: Window, width: int, height: int) -> Window:
    row_off = max(0, int(win.row_off))
    col_off = max(0, int(win.col_off))
    h = max(1, min(int(win.height), height - row_off))
    w = max(1, min(int(win.width), width - col_off))
    return Window(col_off, row_off, w, h)


def pixel_to_wgs84(
    transform: Any, crs: CRS, x: float, y: float
) -> tuple[float, float]:
    """Pixel centre -> source CRS -> WGS84 lon/lat.

    GEO-CORR: thin adapter over :func:`darkfleet.geolocation.pixel_to_wgs84`, which
    is now the single implementation of pixel->ground. Two hand-written copies of
    the same arithmetic drift, and only one of them would get the pixel-centre
    convention right.

    ``x``/``y`` are expected to ALREADY be continuous pixel-centre coordinates
    (index + 0.5); existing callers pass ``200.5 - col_off`` and so on. Hence
    ``centre_offset=0.0``. New code holding a raw sample index should use
    :func:`darkfleet.geolocation.geolocate_components` and let it apply the
    convention, rather than pre-adding 0.5 here.
    """
    from ..geolocation import pixel_to_wgs84 as _pixel_to_wgs84

    return _pixel_to_wgs84(
        x,
        y,
        transform=cast("AffineLike", transform),
        to_wgs84=Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True),
        centre_offset=0.0,
    )


def aoi_to_crs_bounds(
    bbox_wgs84: tuple[float, float, float, float], crs: CRS
) -> tuple[float, float, float, float]:
    """Reproject a WGS84 AOI into a target CRS (dense-densified corners)."""
    min_lon, min_lat, max_lon, max_lat = bbox_wgs84
    transformer = Transformer.from_crs(CRS.from_epsg(4326), crs, always_xy=True)
    xs, ys = [], []
    for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
        for lon, lat in (
            (min_lon + (max_lon - min_lon) * frac, min_lat),
            (min_lon + (max_lon - min_lon) * frac, max_lat),
            (min_lon, min_lat + (max_lat - min_lat) * frac),
            (max_lon, min_lat + (max_lat - min_lat) * frac),
        ):
            x, y = transformer.transform(lon, lat)
            xs.append(x)
            ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys))


def classify_asset(asset: SarAsset, href: str) -> SarAsset:
    """Fill accessibility + georeferencing state from a live inspection."""
    from ..providers.stac import inspect_georeferencing

    state, info = inspect_georeferencing(href)
    asset.georeferencing = state
    asset.crs_wkt = info.get("crs")
    res = info.get("resolution")
    asset.resolution_meters = float(res[0]) if res else None
    asset.dtype = info.get("dtype")
    asset.extra.update(info)
    return asset
