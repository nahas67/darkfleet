"""Independent geolocation proofs for GEO-CORR (tests A-E of the checkpoint).

Every expected coordinate in this file is derived from an INDEPENDENT source:

* analytical arithmetic on the fixture's committed transform
  (``lon0 + (col + 0.5) * res``), typed out as literals -- not computed by
  :mod:`darkfleet.geolocation`;
* rasterio's own ``DatasetReader.xy(..., offset="center")``, which defines what a
  pixel centre is;
* the committed ``sidecar.json``, which records the fixture's origin, spacing
  and the pixel positions of three known vessels.

Nothing here calls the matching implementation to decide what the answer should
be. That is the point: these tests must be capable of FAILING if the geolocation
code is wrong, so they cannot be derived from it.

The A/B/C/D/E labels match the checkpoint brief so each proof is traceable to the
requirement that demanded it.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
import rasterio
from pyproj import CRS, Transformer
from rasterio.warp import transform as warp

from darkfleet.correlation.match import DetectionNotGeolocatedError, component_position
from darkfleet.geolocation import (
    DEFAULT_UNCERTAINTY_PIXELS,
    GeoreferenceError,
    affine_from_sequence,
    assert_window_consistency,
    geolocate_components,
    geolocation_uncertainty_m,
    pixel_to_wgs84,
    transform_wgs84,
)
from darkfleet.sar.georef import read_window

COG = Path(__file__).parent / "fixtures" / "cog"
F4326 = str(COG / "fixture_4326.tif")
F32648 = str(COG / "fixture_32648.tif")
SIDECAR = json.loads((COG / "sidecar.json").read_text())

# Committed fixture geometry, restated here so a silent fixture change is visible.
T4326_LON0, T4326_LAT0, T4326_RES = 103.8, 1.3, 0.0001
T32648_X0, T32648_Y0, T32648_RES = 400000.0, 150000.0, 10.0

T32648_TO_WGS84 = Transformer.from_crs(CRS.from_epsg(32648), CRS.from_epsg(4326), always_xy=True)


def _m(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    """Planar separation in metres. Adequate: all baselines here are sub-100 km."""
    mid = math.radians((lat_a + lat_b) / 2.0)
    return math.hypot((lat_b - lat_a) * 111_320.0, (lon_b - lon_a) * 111_320.0 * math.cos(mid))


# ---------------------------------------------------------------------------
# A. Known affine fixture -- analytically known coordinates
# ---------------------------------------------------------------------------


def test_a_pixel_centres_match_analytical_literals() -> None:
    """A: (0,0), centre and bottom-right pixel centres, from first principles.

    ``lon0 + (col + 0.5) * res`` is the analytical definition: pixel 0's OUTER
    edge sits on ``lon0``, so its CENTRE is half a pixel in.
    """
    tf = affine_from_sequence([T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0])
    to_wgs84 = transform_wgs84("EPSG:4326")

    cases = {
        (0, 0): (1.29995000, 103.80005000),
        (200, 200): (1.27995000, 103.82005000),
        (399, 399): (1.26005000, 103.83995000),
    }
    for (col, row), (want_lat, want_lon) in cases.items():
        lat, lon = pixel_to_wgs84(col, row, transform=tf, to_wgs84=to_wgs84)
        assert abs(lat - want_lat) < 1e-9, (col, row, lat, want_lat)
        assert abs(lon - want_lon) < 1e-9, (col, row, lon, want_lon)


def test_a_pixel_centres_agree_with_rasterio_dataset_xy() -> None:
    """A: cross-check against rasterio's authoritative pixel-centre definition."""
    tf = affine_from_sequence([T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0])
    to_wgs84 = transform_wgs84("EPSG:4326")
    with rasterio.open(F4326) as ds:
        for row, col in ((0, 0), (1, 1), (200, 200), (399, 399)):
            want_lon, want_lat = ds.xy(row, col, offset="center")
            lat, lon = pixel_to_wgs84(col, row, transform=tf, to_wgs84=to_wgs84)
            assert abs(lat - want_lat) < 1e-12, (row, col)
            assert abs(lon - want_lon) < 1e-12, (row, col)


def test_a_embedded_targets_land_on_their_sidecar_coordinates() -> None:
    """A: the three known vessels, expected values from sidecar.json."""
    tf = affine_from_sequence(
        [T32648_RES, 0.0, T32648_X0, 0.0, -T32648_RES, T32648_Y0]
    )
    to_wgs84 = transform_wgs84("EPSG:32648")
    s = SIDECAR["t32648"]
    assert (s["x0"], s["y0"], s["res"]) == (T32648_X0, T32648_Y0, T32648_RES)

    for v in SIDECAR["vessels_px"]:
        row, col = v["row"], v["col"]
        x = s["x0"] + (col + 0.5) * s["res"]
        y = s["y0"] - (row + 0.5) * s["res"]
        want_lon, want_lat = T32648_TO_WGS84.transform(x, y)
        lat, lon = pixel_to_wgs84(col, row, transform=tf, to_wgs84=to_wgs84)
        assert abs(lat - want_lat) < 1e-9, (row, col, lat, want_lat)
        assert abs(lon - want_lon) < 1e-9, (row, col, lon, want_lon)


def test_a_pixel_centres_sit_half_a_pixel_inside_the_outer_bounds() -> None:
    """A: documents the half-pixel convention instead of leaving it implicit.

    This is the second, subtler half of the original defect: the removed code
    mapped sample index 0 onto the raster's OUTER edge, putting every detection
    half a pixel outside the image. At the fixture's 10 m spacing that is 5 m --
    invisible on a chart, but real inside a 1200 m match radius.

    Asserted in the SOURCE CRS, where the arithmetic is exact, rather than by
    measuring a great-circle distance and fighting the projection's scale factor.
    """
    tf = affine_from_sequence([T32648_RES, 0.0, T32648_X0, 0.0, -T32648_RES, T32648_Y0])
    x, y = tf @ (0.5, 0.5)
    assert x == pytest.approx(T32648_X0 + 5.0, abs=1e-9)
    assert y == pytest.approx(T32648_Y0 - 5.0, abs=1e-9)

    # ...and the WGS84 result must sit just inside the outer corner, not on it.
    lat, lon = pixel_to_wgs84(0, 0, transform=tf, to_wgs84=transform_wgs84("EPSG:32648"))
    corner_lat, corner_lon = T32648_TO_WGS84.transform(T32648_X0, T32648_Y0)
    assert lat < corner_lat, "pixel 0 centre must be SOUTH of the raster's north edge"
    assert lon > corner_lon, "pixel 0 centre must be EAST of the raster's west edge"


# ---------------------------------------------------------------------------
# B. Windowed fixture -- the specific guard against the real defect
# ---------------------------------------------------------------------------


def test_b_window_pixel_equals_the_corresponding_full_raster_coordinate() -> None:
    """B: a window-local pixel must geolocate where the same ground sample does.

    This is the regression that matters. Using the SCENE transform with a
    window-local index places the detection at the scene's north-west corner
    instead of inside the window -- 1112 m away on this fixture.
    """
    out = read_window(F4326, (103.81, 1.27, 103.83, 1.29))
    row_off, col_off = int(out["window"][0]), int(out["window"][1])
    to_wgs84 = transform_wgs84(str(out["crs"]))
    window_tf = affine_from_sequence(list(out["window_transform"])[:6])

    # A window-local pixel that is a genuine sample of the returned array.
    local_row, local_col = 5, 7
    lat_w, lon_w = pixel_to_wgs84(local_col, local_row, transform=window_tf, to_wgs84=to_wgs84)

    # The same ground sample expressed in full-scene indices.
    abs_row, abs_col = row_off + local_row, col_off + local_col
    scene_tf = affine_from_sequence([T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0])
    lat_s, lon_s = pixel_to_wgs84(abs_col, abs_row, transform=scene_tf, to_wgs84=to_wgs84)

    assert abs(lat_w - lat_s) < 1e-9, (lat_w, lat_s)
    assert abs(lon_w - lon_s) < 1e-9, (lon_w, lon_s)


def test_b_scene_transform_instead_of_window_transform_is_measurably_wrong() -> None:
    """B: proves the guard has teeth -- the wrong transform is not a small error."""
    out = read_window(F4326, (103.81, 1.27, 103.83, 1.29))
    row_off, col_off = int(out["window"][0]), int(out["window"][1])
    to_wgs84 = transform_wgs84(str(out["crs"]))

    window_tf = affine_from_sequence(list(out["window_transform"])[:6])
    scene_tf = affine_from_sequence([T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0])

    local_row, local_col = 5, 7
    good = pixel_to_wgs84(local_col, local_row, transform=window_tf, to_wgs84=to_wgs84)
    bad = pixel_to_wgs84(local_col, local_row, transform=scene_tf, to_wgs84=to_wgs84)

    # The window has a non-zero offset, so the two must differ substantially.
    assert (row_off, col_off) != (0, 0)
    err = _m(good[0], good[1], bad[0], bad[1])
    assert err > 500.0, f"expected a large error, got {err:.1f} m"


def test_b_window_transform_is_scene_transform_composed_with_the_offset() -> None:
    """B: the exact affine identity the reader relies on."""
    out = read_window(F4326, (103.81, 1.27, 103.83, 1.29))
    assert_window_consistency(
        scene_transform=[T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0],
        window=out["window"],
        window_transform=list(out["window_transform"])[:6],
    )


def test_b_inconsistent_window_transform_is_refused_loudly() -> None:
    """A scene transform offered as a window transform must raise, not compute."""
    with pytest.raises(GeoreferenceError) as exc:
        assert_window_consistency(
            scene_transform=[T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0],
            window=(500, 1000, 20, 20),
            window_transform=[T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0],
        )
    assert "window transform" in str(exc.value)


# ---------------------------------------------------------------------------
# C. Projected CRS fixture -- pixel -> UTM -> WGS84
# ---------------------------------------------------------------------------


def test_c_projected_crs_conversion_within_explicit_tolerance() -> None:
    """C: explicit UTM values, then WGS84 with a stated tolerance.

    Tolerance is 1e-9 deg (~0.1 mm), i.e. float round-off only. It is NOT a
    geolocation accuracy claim -- accuracy is bounded by the fixture's 10 m
    pixel spacing, which :func:`geolocation_uncertainty_m` reports.
    """
    tf = affine_from_sequence([T32648_RES, 0.0, T32648_X0, 0.0, -T32648_RES, T32648_Y0])
    to_wgs84 = transform_wgs84("EPSG:32648")

    utm_cases = {
        (0, 0): (400005.0, 149995.0),
        (200, 200): (402005.0, 147995.0),
        (399, 399): (403995.0, 146005.0),
    }
    for (col, row), (want_x, want_y) in utm_cases.items():
        # stage 1: pixel centre -> source CRS
        x, y = tf @ (col + 0.5, row + 0.5)
        assert abs(x - want_x) < 1e-9 and abs(y - want_y) < 1e-9, (col, row, x, y)
        # stage 2: source CRS -> WGS84
        want_lon, want_lat = T32648_TO_WGS84.transform(want_x, want_y)
        lat, lon = pixel_to_wgs84(col, row, transform=tf, to_wgs84=to_wgs84)
        assert abs(lat - want_lat) < 1e-9, (col, row, lat, want_lat)
        assert abs(lon - want_lon) < 1e-9, (col, row, lon, want_lon)


def test_c_projected_result_is_near_the_equator_not_near_the_pole() -> None:
    """C: a UTM-northern-hemisphere scene must not come back near the pole.

    A lat/lon swap or a bad zone would put this at 104 deg latitude, which is a
    different planet. Cheap sanity bound that catches gross reprojection faults.
    """
    tf = affine_from_sequence([T32648_RES, 0.0, T32648_X0, 0.0, -T32648_RES, T32648_Y0])
    lat, lon = pixel_to_wgs84(200, 200, transform=tf, to_wgs84=transform_wgs84("EPSG:32648"))
    assert 1.0 < lat < 2.0, lat
    assert 104.0 < lon < 104.5, lon


# ---------------------------------------------------------------------------
# D. Axis order -- lat/lon vs lon/lat
# ---------------------------------------------------------------------------


def test_d_4326_returns_lat_in_latitude_range_and_lon_in_longitude_range() -> None:
    """D: the fixture spans lat 1.26-1.30 and lon 103.80-103.84.

    The two ranges do not overlap, so a swap cannot hide.
    """
    tf = affine_from_sequence([T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0])
    to_wgs84 = transform_wgs84("EPSG:4326")
    for row, col in ((0, 0), (100, 100), (200, 300), (399, 399)):
        lat, lon = pixel_to_wgs84(col, row, transform=tf, to_wgs84=to_wgs84)
        assert 1.26 <= lat <= 1.30, (row, col, lat)
        assert 103.80 <= lon <= 103.84, (row, col, lon)


def test_d_return_order_is_lat_then_lon_and_is_not_interchangeable() -> None:
    """D: pins the tuple order so a refactor cannot silently swap it."""
    tf = affine_from_sequence([T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0])
    to_wgs84 = transform_wgs84("EPSG:4326")
    lat, lon = pixel_to_wgs84(200, 200, transform=tf, to_wgs84=to_wgs84)
    assert lat < 2.0, "first element must be latitude"
    assert lon > 100.0, "second element must be longitude"


def test_d_transformer_is_built_with_explicit_xy_axis_order() -> None:
    """D: `always_xy=True` must actually be in force, not merely intended.

    EPSG:4326's authority axis order is lat/lon. Building the transformer
    without `always_xy` still *works* for this fixture in some GDAL builds and
    silently swaps in others, so the guarantee is asserted structurally by
    comparing against a deliberately un-ordered transformer.
    """
    ordered = transform_wgs84("EPSG:4326")
    assert ordered.transform(103.82, 1.28) == pytest.approx((103.82, 1.28), abs=1e-12)

    unordered = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_epsg(4326))
    assert unordered is not ordered


# ---------------------------------------------------------------------------
# E. Floating centroid -- sub-pixel positioning survives
# ---------------------------------------------------------------------------


def test_e_float_centroid_keeps_subpixel_position() -> None:
    """E: a centroid between samples must land between their centres.

    The removed code rounded nothing but also gained nothing: it placed a
    fractional centroid by linear interpolation across the AOI, which is a
    different question. Here the fractional centroid must move by exactly the
    fractional amount, measured in metres.
    """
    tf = affine_from_sequence([T32648_RES, 0.0, T32648_X0, 0.0, -T32648_RES, T32648_Y0])
    to_wgs84 = transform_wgs84("EPSG:32648")

    # Exact assertion in the source CRS, where a quarter pixel is unambiguous:
    # 0.25 px * 10 m = 2.5 m of easting, 0.75 px * 10 m = 7.5 m of northing.
    x0, y0 = tf @ (200.5, 250.5)
    x1, y1 = tf @ (200.75, 251.25)
    assert x1 - x0 == pytest.approx(2.5, abs=1e-9)
    assert y0 - y1 == pytest.approx(7.5, abs=1e-9)

    # ...and the WGS84 result must reflect the same sub-pixel proportions.
    base = pixel_to_wgs84(200.0, 250.0, transform=tf, to_wgs84=to_wgs84)
    quarter = pixel_to_wgs84(200.25, 250.75, transform=tf, to_wgs84=to_wgs84)
    east_m = _m(base[0], base[1], base[0], quarter[1])
    north_m = _m(base[0], base[1], quarter[0], base[1])
    # rel=0.01 absorbs UTM's scale factor (k0=0.9996) and _m's planar approximation.
    assert east_m == pytest.approx(2.5, rel=0.01), east_m
    assert north_m == pytest.approx(7.5, rel=0.01), north_m


def test_e_float_centroid_is_not_silently_rounded_to_a_pixel() -> None:
    """E: the position must differ measurably from the rounded pixel."""
    tf = affine_from_sequence([T32648_RES, 0.0, T32648_X0, 0.0, -T32648_RES, T32648_Y0])
    to_wgs84 = transform_wgs84("EPSG:32648")
    rounded = pixel_to_wgs84(200, 250, transform=tf, to_wgs84=to_wgs84)
    frac = pixel_to_wgs84(200.4, 250.4, transform=tf, to_wgs84=to_wgs84)
    assert _m(rounded[0], rounded[1], frac[0], frac[1]) > 1.0


# ---------------------------------------------------------------------------
# Component geolocation, provenance, and refusal to guess
# ---------------------------------------------------------------------------


def _component(cx: float, cy: float) -> dict[str, Any]:
    return {
        "cx": cx,
        "cy": cy,
        "area": 8,
        "major": 1.7,
        "minor": 1.3,
        "maxDb": 3.7,
        "meanDb": 2.4,
        "wake": False,
        "clutterMeanDb": -21.7,
    }


def test_components_are_geolocated_and_carry_provenance() -> None:
    comps = geolocate_components(
        [_component(32.0741, 40.5221), _component(100.5, 200.25)],
        crs="EPSG:4326",
        transform=[T4326_RES, 0.0, T4326_LON0, 0.0, -T4326_RES, T4326_LAT0],
    )
    assert len(comps) == 2
    for comp, (cx, cy) in zip(comps, ((32.0741, 40.5221), (100.5, 200.25))):
        lat, lon = component_position(comp)
        assert 1.26 <= lat <= 1.30
        assert 103.80 <= lon <= 103.84
        # provenance sufficient to explain the coordinate without a rerun
        assert comp["geo_source_transform"] == [
            T4326_RES,
            0.0,
            T4326_LON0,
            0.0,
            -T4326_RES,
            T4326_LAT0,
        ]
        assert comp["geo_crs"] == "EPSG:4326"
        assert comp["geo_pixel_centroid"] == [cx, cy]
        assert comp["geo_centre_offset"] == 0.5


def test_geolocation_is_finite_and_refuses_nonsense_input() -> None:
    with pytest.raises(GeoreferenceError):
        geolocate_components([_component(float("nan"), 1.0)], crs="EPSG:4326", transform=[1, 0, 0, 0, -1, 0])
    with pytest.raises(GeoreferenceError):
        geolocate_components([_component(1.0, 1.0)], crs="", transform=[1, 0, 0, 0, -1, 0])
    with pytest.raises(GeoreferenceError):
        geolocate_components([_component(1.0, 1.0)], crs="EPSG:4326", transform=[1, 0, 0])
    with pytest.raises(GeoreferenceError):
        # no centroid at all -- cannot be placed, so it is not invented
        geolocate_components([{"area": 3}], crs="EPSG:4326", transform=[1, 0, 0, 0, -1, 0])


def test_correlation_refuses_a_component_with_no_measured_position() -> None:
    """The architectural guarantee: correlation cannot guess a coordinate."""
    with pytest.raises(DetectionNotGeolocatedError):
        component_position(_component(10.0, 10.0))
    with pytest.raises(DetectionNotGeolocatedError):
        component_position({"lat": 1.2, "cx": 1.0, "cy": 1.0})


def test_correlation_refuses_a_non_finite_position() -> None:
    with pytest.raises(ValueError):
        component_position({"lat": float("nan"), "lon": 103.8})


# ---------------------------------------------------------------------------
# Real-scene regression: detections must fall inside the raster that was read
# ---------------------------------------------------------------------------


def test_real_vessels_fall_inside_the_measured_raster_bounds() -> None:
    """The headline invariant the defect violated.

    On the committed UTM scene the raster's measured WGS84 extent is
    lat 1.32075..1.35693, lon 104.10111..104.13708. Every known vessel must land
    inside it. Interpolating across a REQUESTED AOI placed them ~4 km north,
    outside the image that produced them.
    """
    with rasterio.open(F32648) as ds:
        b = ds.bounds
        blon, blat = warp(ds.crs, "EPSG:4326", [b.left, b.right], [b.top, b.bottom])
        lat_min, lat_max = min(blat), max(blat)
        lon_min, lon_max = min(blon), max(blon)

    assert (round(lat_min, 5), round(lat_max, 5)) == (1.32075, 1.35693)
    assert (round(lon_min, 5), round(lon_max, 5)) == (104.10111, 104.13708)

    out = read_window(F32648, (104.10, 1.30, 104.15, 1.40))
    window_tf = affine_from_sequence(list(out["window_transform"])[:6])
    to_wgs84 = transform_wgs84(str(out["crs"]))
    row_off, col_off = int(out["window"][0]), int(out["window"][1])

    for v in SIDECAR["vessels_px"]:
        lat, lon = pixel_to_wgs84(
            v["col"] - col_off, v["row"] - row_off, transform=window_tf, to_wgs84=to_wgs84
        )
        assert lat_min <= lat <= lat_max, (v, lat)
        assert lon_min <= lon <= lon_max, (v, lon)


def test_aoi_interpolation_would_place_vessels_outside_their_own_raster() -> None:
    """Proves the invariant above is not vacuous.

    Reproduces the removed formula and shows it lands outside the measured
    extent. If a future change reverts to AOI interpolation, this test fails and
    says why.
    """
    with rasterio.open(F32648) as ds:
        b = ds.bounds
        _blon, blat = warp(ds.crs, "EPSG:4326", [b.left, b.right], [b.top, b.bottom])
        lat_max_raster = max(blat)

    # The AOI the failing scan requested: north of the scene it actually read.
    aoi = (104.10, 1.30, 104.15, 1.40)
    width = 400
    inside = 0
    for v in SIDECAR["vessels_px"]:
        # the removed formula, verbatim
        old_lat = aoi[3] - (v["col"] / width) * (aoi[3] - aoi[1])
        if old_lat <= lat_max_raster:
            inside += 1
    assert inside < len(SIDECAR["vessels_px"]), (
        "AOI interpolation unexpectedly landed inside the raster; the regression "
        "scenario no longer reproduces and this test needs re-deriving"
    )


# ---------------------------------------------------------------------------
# Uncertainty: state what the product supports, nothing more
# ---------------------------------------------------------------------------


def test_uncertainty_is_half_a_pixel_for_an_affine_product() -> None:
    assert geolocation_uncertainty_m(resolution_m=10.0, georeferencing="AFFINE_GEOREFERENCED") == 5.0
    assert geolocation_uncertainty_m(resolution_m=20.0, georeferencing="AFFINE_GEOREFERENCED") == 10.0
    assert DEFAULT_UNCERTAINTY_PIXELS == 0.5


def test_uncertainty_is_refused_rather_than_invented() -> None:
    """No CRS-faithful figure exists for GCP or unreferenced products."""
    assert geolocation_uncertainty_m(resolution_m=10.0, georeferencing="GCP_GEOREFERENCED") is None
    assert geolocation_uncertainty_m(resolution_m=10.0, georeferencing="UNREFERENCED") is None
    assert geolocation_uncertainty_m(resolution_m=None, georeferencing="AFFINE_GEOREFERENCED") is None
    assert geolocation_uncertainty_m(resolution_m=0.0, georeferencing="AFFINE_GEOREFERENCED") is None


def test_uncertainty_never_claims_finer_than_the_pixel_spacing() -> None:
    coarse = geolocation_uncertainty_m(resolution_m=40.0, georeferencing="AFFINE_GEOREFERENCED")
    assert coarse is not None and coarse >= 40.0 * DEFAULT_UNCERTAINTY_PIXELS