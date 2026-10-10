"""CP1 gate: georeferencing chain (SAR-105/106/107/111/112, TST-001).

Expectations are HAND-COMPUTED from the sidecar (pixel -> degrees/metres by
arithmetic), never via rasterio — so a wrong transform cannot agree with itself.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pyproj import CRS, Transformer

from darkfleet.providers import Georeferencing, RealDataUnavailableError
from darkfleet.providers.stac import inspect_georeferencing
from darkfleet.sar.georef import aoi_to_crs_bounds, pixel_to_wgs84, read_window

COG = Path(__file__).parent / "fixtures" / "cog"
SIDECAR = json.loads((COG / "sidecar.json").read_text())
F4326 = str(COG / "fixture_4326.tif")
F32648 = str(COG / "fixture_32648.tif")
FUNREF = str(COG / "fixture_unreferenced.tif")
FGCP = str(COG / "fixture_gcp.tif")


def _expected_4326(row: int, col: int) -> tuple[float, float]:
    s = SIDECAR["t4326"]
    lon = s["lon0"] + (col + 0.5) * s["res"]
    lat = s["lat0"] - (row + 0.5) * s["res"]
    return lat, lon


def test_fixtures_exist() -> None:
    for name in ("fixture_4326.tif", "fixture_32648.tif", "fixture_unreferenced.tif", "fixture_gcp.tif"):
        assert (COG / name).exists(), name


def test_window_read_4326_and_vessel_geolocation() -> None:
    out = read_window(F4326, (103.81, 1.27, 103.83, 1.29))
    assert out["array"].ndim == 2
    assert out["crs"] == CRS.from_epsg(4326)
    # Vessel 0 at px (row 120, col 200) must land on its hand-computed coordinate.
    lat, lon = pixel_to_wgs84(out["window_transform"], out["crs"], 200.5 - out["window"][1], 120.5 - out["window"][0])
    exp_lat, exp_lon = _expected_4326(120, 200)
    assert abs(lat - exp_lat) < 1e-9
    assert abs(lon - exp_lon) < 1e-9


def test_window_read_32648_pixel_to_wgs84() -> None:
    # The UTM fixture is at ~104.10 E, 1.32 N. A former AOI at 103.81 E
    # was disjoint and silently "succeeded" by moving the read onto the raster.
    out = read_window(F32648, (104.10, 1.32, 104.14, 1.36))
    assert out["crs"] == CRS.from_epsg(32648)
    # Full-raster read: vessel 1 at (row 250, col 300).
    full = read_window(F32648, (104.09, 1.31, 104.15, 1.37))
    ro, co, _, _ = full["window"]
    lat, lon = pixel_to_wgs84(full["window_transform"], full["crs"], 300.5 - co, 250.5 - ro)
    s = SIDECAR["t32648"]
    x = s["x0"] + 300.5 * s["res"]
    y = s["y0"] - 250.5 * s["res"]
    e_lon, e_lat = Transformer.from_crs(CRS.from_epsg(32648), CRS.from_epsg(4326), always_xy=True).transform(x, y)
    assert abs(lat - e_lat) < 1e-9
    assert abs(lon - e_lon) < 1e-9


def test_aoi_reprojection_contains_known_point() -> None:
    bounds = aoi_to_crs_bounds((103.81, 1.27, 103.83, 1.29), CRS.from_epsg(32648))
    x, y = Transformer.from_crs(
        CRS.from_epsg(4326), CRS.from_epsg(32648), always_xy=True
    ).transform(103.82, 1.28)
    assert bounds[0] <= x <= bounds[2]
    assert bounds[1] <= y <= bounds[3]


def test_window_clamped_to_raster() -> None:
    out = read_window(F4326, (103.0, 1.0, 104.5, 1.5))  # far larger than the 400px fixture
    assert out["array"].shape == (400, 400)


def test_window_with_partial_overlap_is_only_the_actual_intersection() -> None:
    # The AOI begins outside the scene's western edge and enters it by a few
    # pixels. Its non-intersecting width cannot be moved onto valid scene data.
    import rasterio

    with rasterio.open(F4326) as ds:
        west, north = ds.bounds.left, ds.bounds.top
        resolution = abs(ds.transform.a)
    out = read_window(F4326, (west - 20 * resolution, north - 30 * resolution,
                               west + 5 * resolution, north - 5 * resolution))
    assert out["array"].shape == (25, 5)
    assert out["window"][1] == 0


def test_nonoverlapping_aoi_refused_instead_of_reading_unrequested_pixels() -> None:
    import rasterio

    with rasterio.open(F4326) as ds:
        west, north = ds.bounds.left, ds.bounds.top
        resolution = abs(ds.transform.a)
    with pytest.raises(RealDataUnavailableError, match="does not intersect"):
        read_window(F4326, (west - 50 * resolution, north - 40 * resolution,
                            west - 5 * resolution, north - 5 * resolution))


def test_unreferenced_asset_refused_loudly() -> None:
    with pytest.raises(RealDataUnavailableError, match="neither affine"):
        read_window(FUNREF, (103.81, 1.27, 103.83, 1.29))


def test_classifier_affine_gcp_unreferenced() -> None:
    state, info = inspect_georeferencing(F4326)
    assert state == Georeferencing.AFFINE_GEOREFERENCED
    assert info["crs"] == "EPSG:4326"
    state, info = inspect_georeferencing(FGCP)
    assert state == Georeferencing.GCP_GEOREFERENCED
    assert info["gcp_count"] == 4
    state, _ = inspect_georeferencing(FUNREF)
    assert state == Georeferencing.UNREFERENCED
