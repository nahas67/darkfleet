"""Pixel-spacing regression for CRS-aware coastline masks.

Source CRS affine coefficients describe degrees, feet or meters; the mask
buffer is always configured in real meters.
"""

from __future__ import annotations

import pytest
from pyproj import CRS
from rasterio.transform import Affine

from darkfleet.pipeline import rasterio_res
from darkfleet.providers import RealDataUnavailableError


def _window(crs: CRS, transform: Affine) -> dict:
    return {"crs": crs, "window_transform": transform, "window": (0, 0, 100, 100)}


def test_wgs84_degree_pixels_measure_meters_without_unbounded_dilation() -> None:
    spacing = rasterio_res(_window(CRS.from_epsg(4326), Affine(0.0001, 0, 103.80, 0, -0.0001, 1.3)))
    assert 10.5 < spacing < 11.5
    assert 10 <= round(150.0 / spacing) <= 15


def test_utm_metre_pixels_and_rotated_affine_keep_measured_scale() -> None:
    assert rasterio_res(_window(CRS.from_epsg(32648), Affine(10, 0, 400000, 0, -10, 150000))) == pytest.approx(10.0, abs=0.03)
    rotated = rasterio_res(_window(CRS.from_epsg(32648), Affine(0, 10, 400000, -10, 0, 150000)))
    assert rotated == pytest.approx(10.0, abs=0.03)


def test_invalid_affine_never_yields_zero_or_unbounded_scale() -> None:
    with pytest.raises(RealDataUnavailableError, match="pixel spacing"):
        rasterio_res(_window(CRS.from_epsg(4326), Affine(0, 0, 103.80, 0, 0, 1.3)))
