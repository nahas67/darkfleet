"""CP2 gate: preprocessing branches + real land mask (SAR-108/109/201..210)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from pyproj import CRS

from darkfleet.providers import RealDataUnavailableError
from darkfleet.sar import landmask, preprocess
from darkfleet.sar.landmask import build_land_mask

MASK = Path(__file__).parent / "fixtures" / "mask"
CLIP = str(MASK / "worldcover_sg_clip.tif")
COG4326 = str(Path(__file__).parent / "fixtures" / "cog" / "fixture_4326.tif")

SINGAPORE_PORT = [[(103.825, 1.285), (103.835, 1.285), (103.835, 1.295), (103.825, 1.295)]]


def _grid4326() -> tuple:
    with rasterio.open(COG4326) as ds:
        return ds.transform, (ds.height, ds.width), ds.crs


def test_rtc_db_spot_values() -> None:
    db = preprocess.linear_to_db(np.array([0.5, 1.0, 0.0], dtype=np.float32))
    assert abs(float(db[0]) - (-3.0103)) < 1e-3  # 10*log10(0.5), hand-computed
    assert abs(float(db[1]) - 0.0) < 1e-6
    assert float(db[2]) == pytest.approx(-90.0)  # eps clip, never -inf


def test_valid_mask_excludes_nonnumeric_and_nodata() -> None:
    arr = np.array([[1.0, np.nan], [np.inf, -999.0]], dtype=np.float32)
    m = preprocess.valid_data_mask(arr, nodata=-999.0)
    assert m.tolist() == [[True, False], [False, False]]


def test_rtc_branch_picks_valid_only() -> None:
    out = preprocess.rtc_branch(np.array([[0.5, np.nan]], dtype=np.float32), None)
    assert out["branch"] == "RTC"
    assert out["valid"].tolist() == [[True, False]]
    assert np.isnan(out["db"][0, 1])


def test_grd_branch_requires_lut() -> None:
    dn = np.full((4, 4), 2.0, dtype=np.float32)
    with pytest.raises(RealDataUnavailableError, match="calibration LUT"):
        preprocess.grd_branch(dn, None, None)
    out = preprocess.grd_branch(dn, None, lut=np.full((4, 4), 4.0))
    assert out["branch"] == "GRD"
    assert out["denoised"] is False  # honest: no noise annotation, no fake denoise
    assert abs(float(out["db"][0, 0]) - 0.0) < 1e-6  # (2^2)/4 = 1.0 -> 0 dB


def test_tile_naming() -> None:
    assert landmask.tile_name_for(103.845, 1.27) == "N00E102"
    assert landmask.tile_name_for(-73.9, 40.7) == "N39W075"
    assert landmask.tile_url(103.845, 1.27).endswith("N00E102_Map.tif")


def test_mask_build_alignment_and_fractions() -> None:
    transform, shape, crs = _grid4326()
    assert crs == CRS.from_epsg(4326)
    out = build_land_mask(CLIP, transform, shape, crs, coastline_buffer_m=150)
    assert out["excluded"].shape == shape
    assert out["excluded"].dtype == bool
    # Fixture grid sits over Singapore island: land-dominated by real geography.
    assert 0.75 < out["land_fraction"] < 1.0
    assert out["buffer_px"] == 15  # 150 m / 10 m px
    assert "WorldCover" in out["provenance"]["source"]
    assert out["provenance"]["coastline_buffer_m"] == 150


def test_mask_open_water_grid_stays_water() -> None:
    from rasterio.transform import Affine

    # Open strait water east of Singapore: must stay overwhelmingly detectable.
    t = Affine(0.0001, 0.0, 103.90, 0.0, -0.0001, 1.24)
    out = build_land_mask(CLIP, t, (400, 400), CRS.from_epsg(4326), coastline_buffer_m=150)
    assert out["land_fraction"] < 0.5


def test_buffer_monotonic_and_port_carveback() -> None:
    transform, shape, crs = _grid4326()
    m0 = build_land_mask(CLIP, transform, shape, crs, coastline_buffer_m=0)
    m150 = build_land_mask(CLIP, transform, shape, crs, coastline_buffer_m=150)
    m500 = build_land_mask(CLIP, transform, shape, crs, coastline_buffer_m=500)
    assert m0["excluded"].sum() < m150["excluded"].sum() < m500["excluded"].sum()
    mport = build_land_mask(
        CLIP, transform, shape, crs, coastline_buffer_m=150, port_polys_wgs84=SINGAPORE_PORT
    )
    assert mport["excluded"].sum() < m150["excluded"].sum()
    assert mport["provenance"]["port_exceptions"] == 1


def test_mask_deterministic() -> None:
    transform, shape, crs = _grid4326()
    a = build_land_mask(CLIP, transform, shape, crs)["excluded"]
    b = build_land_mask(CLIP, transform, shape, crs)["excluded"]
    assert np.array_equal(a, b)


def test_clip_sidecar_provenance() -> None:
    side = json.loads((MASK / "sidecar.json").read_text())
    assert side["version"] == "ESA WorldCover v200 2021"
    assert "N00E102" in side["tile_href"]
