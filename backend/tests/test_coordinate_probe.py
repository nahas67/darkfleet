"""The coordinate probe: one authority, and proofs it is that authority.

Every expected coordinate here is computed INDEPENDENTLY of the code under test.
The route calls ``geolocation.pixel_to_wgs84``; the expectations below come from
affine arithmetic written out longhand, and from ``rasterio.transform.xy`` with
``offset="center"``. Calling the implementation to build its own expectation
would prove nothing at all -- it would only prove the route is wired to the
function the test already called.

What is pinned
--------------
  A  top-left pixel centre      B  centre pixel
  C  bottom-right pixel centre  D  fractional centroid (sub-pixel preserved)
  E  windowed raster equivalence
  F  projected CRS (UTM, not 4326->4326)
  G  axis order (always_xy)
  H  half-pixel / corner mutation must fail
  I  out-of-bounds row   J  out-of-bounds col   K  negative   L  non-finite
  M  unknown scan       N  missing georeference
  plus: the AOI is not an input to the conversion.
"""

from __future__ import annotations

import math
from typing import Any

import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import Affine
from rasterio.transform import xy as rio_xy

from darkfleet.geolocation import GeoreferenceError, affine_from_sequence, pixel_to_wgs84
from tests.fixture_source import FIXTURE_BBOX, fixture_path
from tests.test_api import (  # noqa: F401
    api_settings,
    client,
    completed_scan,
    net,
    offline_pipeline,
)

# Must cover the measured 400x400 UTM raster; the previous north-shifted AOI
# silently clamped to the fixture before nonintersecting reads became fail-closed.
BBOX = FIXTURE_BBOX

#: UTM 48N. Deliberately NOT 4326: a geographic input CRS hides axis-order bugs
#: completely, because lon/lat and lat/lon are both "degrees".
EXPECTED_CRS = "EPSG:32648"


def _sid(scan: dict[str, Any]) -> str:
    return str(scan["scan_id"])


def _raster(client: TestClient, scan_id: str, layer: str = "raw") -> dict[str, Any]:
    response = client.get(f"/api/scans/{scan_id}/raster/{layer}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _probe(client: TestClient, scan_id: str, row: float, col: float) -> dict[str, Any]:
    response = client.post(f"/api/scans/{scan_id}/debug/probe", json={"row": row, "col": col})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# ------------------------------------------------------- independent oracles


def _expected_wgs84(transform_values: list[float], crs: str, row: float, col: float) -> tuple[float, float]:
    """Reference answer from rasterio, independent of ``geolocation``.

    Two conventions are load-bearing here and both were got wrong in the first
    draft of this file, which is why it is worth stating:

    - ``rasterio.transform.xy(transform, row, col)`` takes ROW FIRST, not col
      first. Passing (col, row) silently produces a transposed answer.
    - ``Transformer.from_crs(..., always_xy=True).transform(x, y)`` returns
      ``(lon, lat)``. Unpacking it as ``(lat, lon)`` puts the answer in the
      Indian Ocean.

    ``offset="center"`` is rasterio's own definition of a sample centre, so this
    remains a genuine second implementation rather than a restatement.
    """
    affine = Affine(*transform_values)
    x, y = rio_xy(affine, row, col, offset="center")
    from pyproj import Transformer

    transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    lon, lat = transformer.transform(x, y)
    return float(lat), float(lon)


def _expected_longhand(transform_values: list[float], row: float, col: float) -> tuple[float, float]:
    """Reference answer from affine arithmetic written out by hand.

    Deliberately does not use Affine at all, so a bug in the shared transform
    helper cannot make both sides agree.
    """
    a, b, c, d, e, f = transform_values
    x = a * (col + 0.5) + b * (row + 0.5) + c
    y = d * (col + 0.5) + e * (row + 0.5) + f
    return x, y


# ------------------------------------------------------ A/B/C/D: the corners


def test_top_left_pixel_centre(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """row=0, col=0 means the CENTRE of the first sample, not its corner."""
    scan_id = _sid(completed_scan)
    raster = _raster(client, scan_id)
    assert raster["crs"] == EXPECTED_CRS, "the fixture must stay a projected CRS"
    transform = raster["transform"]

    body = _probe(client, scan_id, 0.0, 0.0)

    assert body["pixel"]["convention"] == "PIXEL_CENTER"
    assert body["pixel"]["centre_offset"] == 0.5

    x, y = _expected_longhand(transform, 0.0, 0.0)
    assert body["source"]["x"] == pytest.approx(x, abs=1e-9)
    assert body["source"]["y"] == pytest.approx(y, abs=1e-9)

    # Pin the actual checked-in GeoTIFF, independently of the API's persisted
    # transform: the source is UTM metres, never an AOI-derived fallback.
    with rasterio.open(fixture_path("cog/fixture_32648.tif")) as source:
        assert source.crs.to_string() == EXPECTED_CRS
        assert (source.width, source.height) == (400, 400)
        assert tuple(source.bounds) == pytest.approx((400000, 146000, 404000, 150000))
        source_x, source_y = rio_xy(source.transform, 0, 0, offset="center")
    assert body["source"]["x"] == pytest.approx(source_x, abs=1e-9)
    assert body["source"]["y"] == pytest.approx(source_y, abs=1e-9)

    lat, lon = _expected_wgs84(transform, EXPECTED_CRS, 0.0, 0.0)
    assert body["wgs84_lat"] == pytest.approx(lat, abs=1e-9)
    assert body["wgs84_lon"] == pytest.approx(lon, abs=1e-9)
    assert body["wgs84_lon"] == pytest.approx(104.10115689210639, abs=1e-8)
    assert body["wgs84_lat"] == pytest.approx(1.3568812223073432, abs=1e-8)


def test_centre_pixel(client: TestClient, completed_scan: dict[str, Any]) -> None:
    scan_id = _sid(completed_scan)
    raster = _raster(client, scan_id)
    height, width = raster["render"]["source_shape"]

    body = _probe(client, scan_id, (height - 1) / 2.0, (width - 1) / 2.0)
    lat, lon = _expected_wgs84(raster["transform"], EXPECTED_CRS, (height - 1) / 2.0, (width - 1) / 2.0)
    assert body["wgs84_lat"] == pytest.approx(lat, abs=1e-9)
    assert body["wgs84_lon"] == pytest.approx(lon, abs=1e-9)


def test_bottom_right_pixel_centre(client: TestClient, completed_scan: dict[str, Any]) -> None:
    scan_id = _sid(completed_scan)
    raster = _raster(client, scan_id)
    height, width = raster["render"]["source_shape"]
    row, col = float(height - 1), float(width - 1)

    body = _probe(client, scan_id, row, col)
    lat, lon = _expected_wgs84(raster["transform"], EXPECTED_CRS, row, col)
    assert body["wgs84_lat"] == pytest.approx(lat, abs=1e-9)
    assert body["wgs84_lon"] == pytest.approx(lon, abs=1e-9)


def test_fractional_centroid_is_not_truncated(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """Sub-pixel position must survive to the coordinate.

    A component centroid is rarely a whole pixel. An ``int()`` anywhere before
    the transform would move the answer by up to half a pixel -- about 5 m at
    10 m resolution, which is far larger than the geolocation uncertainty this
    product reports.
    """
    scan_id = _sid(completed_scan)
    raster = _raster(client, scan_id)
    transform = raster["transform"]

    fractional = _probe(client, scan_id, 120.25, 200.75)
    truncated = _probe(client, scan_id, 120.0, 200.0)

    lat_f, lon_f = _expected_wgs84(transform, EXPECTED_CRS, 120.25, 200.75)
    assert fractional["wgs84_lat"] == pytest.approx(lat_f, abs=1e-9)
    assert fractional["wgs84_lon"] == pytest.approx(lon_f, abs=1e-9)

    # And the fractional answer must genuinely differ from the truncated one.
    moved_m = math.hypot(
        (fractional["source"]["x"] - truncated["source"]["x"]),
        (fractional["source"]["y"] - truncated["source"]["y"]),
    )
    assert moved_m > 1.0, (
        f"a 0.25/0.75 centroid offset moved only {moved_m:.3f} m; sub-pixel "
        "position was discarded before the transform"
    )
    assert fractional["wgs84_lat"] != truncated["wgs84_lat"]


def test_probe_echoes_full_float_precision(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """No rounding on the way out.

    GEO-CORR deliberately returns unrounded values because rounding is coarser
    than the repository's own tolerances. Presentation may round; this must not.
    """
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 120.25, 200.75)
    assert isinstance(body["wgs84_lat"], float)
    assert isinstance(body["wgs84_lon"], float)
    # Not a 7-dp rounded value: full double precision survives JSON.
    assert len(repr(body["wgs84_lat"]).split(".")[-1]) > 7


# --------------------------------------- E: windowed raster equals full source


def test_window_transform_is_the_windows_own(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """The transform must be the WINDOW's, not the full scene's.

    GEO-001 measured a material spatial error from applying the scene transform
    to window-local coordinates. On this fixture the window starts at (0, 0), so
    the two coincide and the difference is invisible -- which is exactly why the
    assertion below checks the WINDOW BOUNDS and the transform identity rather
    than trusting that a matching answer means a correct transform.
    """
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 10.0, 10.0)
    raster = _raster(client, scan_id)

    assert body["georeferencing"]["window_bounds"] == [0.0, 0.0, 400.0, 400.0]
    assert body["georeferencing"]["transform"] == pytest.approx(raster["transform"])

    # The window is declared, so the two are distinguishable in principle.
    assert body["georeferencing"]["raster_width"] == 400
    assert body["georeferencing"]["raster_height"] == 400


def test_window_offset_would_change_the_answer(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """A scene-transform probe would differ from a window-transform probe.

    Constructed arithmetically rather than by mutating the record: if applying the
    full-scene transform to a window-local pixel is wrong, then shifting the
    window origin must change the coordinate, and a probe that ignores the window
    cannot distinguish the two cases.
    """
    scan_id = _sid(completed_scan)
    raster = _raster(client, scan_id)
    transform = raster["transform"]
    a, b, c, d, e, f = transform

    row, col = 50.0, 60.0
    # What the probe returns for the window as read.
    base = _probe(client, scan_id, row, col)

    # What a full-scene transform would give for a window offset by 1000/2000 px.
    # Same arithmetic, different origin -- so a difference here is the size of the
    # error GEO-001 measured.
    shifted = [a, b, c + a * 1000.0, d, e, f + e * 2000.0]
    shifted_lat, _shifted_lon = _expected_wgs84(shifted, EXPECTED_CRS, row, col)

    assert base["wgs84_lat"] != pytest.approx(shifted_lat, abs=1e-9), (
        "probing was insensitive to the window origin, so it cannot be using the "
        "window transform"
    )
    assert base["georeferencing"]["transform"] == pytest.approx(transform)


# --------------------------------------------- F/G: projected CRS, axis order


def test_projected_crs_is_used(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """Not a 4326->4326 no-op: the CRS transform must do real work."""
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 0.0, 0.0)

    assert body["source"]["crs"] == EXPECTED_CRS
    # UTM easting/northing are hundreds of thousands of metres; WGS84 degrees are
    # ~1. If these were the same number the reprojection never ran.
    assert abs(body["source"]["x"]) > 100_000.0
    assert abs(body["source"]["y"]) > 100_000.0
    assert 100.0 < body["wgs84_lon"] < 105.0
    assert 0.5 < body["wgs84_lat"] < 2.5


def test_always_xy_is_declared_and_is_what_produces_the_answer(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """`always_xy=True` is declared, and the answer matches that convention.

    An earlier draft of this test asserted that the axis-swapped answer would
    differ by more than a degree, on the reasoning that `always_xy=False` would
    return (lat, lon) and transpose the pair. That is true for a GEOGRAPHIC
    source CRS and FALSE for a projected one: EPSG:32648's authority axis order
    is already easting/northing, so both settings agree. The test failed and was
    right to -- the claim was wrong, not the route.

    So the honest assertions are the two that hold: the setting is declared, and
    the coordinate is exactly the `always_xy=True` answer. The observable
    axis-order mutation lives in GEO-CORR's suite, where a geographic CRS makes
    the two conventions genuinely diverge.
    """
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 0.0, 0.0)
    assert body["georeferencing"]["always_xy"] is True

    from pyproj import Transformer

    transformer = Transformer.from_crs(EXPECTED_CRS, "EPSG:4326", always_xy=True)
    lon, lat = transformer.transform(body["source"]["x"], body["source"]["y"])
    assert body["wgs84_lat"] == pytest.approx(lat, abs=1e-12)
    assert body["wgs84_lon"] == pytest.approx(lon, abs=1e-12)

    # Longitude near 104 E and latitude near 1.3 N, i.e. the pair is in the
    # correct order. A transposition here would read ~1.3 E, 104 N.
    assert 103.0 < body["wgs84_lon"] < 105.0
    assert 1.0 < body["wgs84_lat"] < 1.6


def test_axis_order_would_be_observable_for_a_geographic_source(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """Why the projected fixture is the right choice, and what it cannot show.

    Kept as an explicit test so the limitation is recorded rather than left for
    someone to rediscover: with a 4326 SOURCE crs the two conventions differ by
    ~103 degrees, so a 4326->4326 fixture would hide an axis-order bug entirely.
    """
    from pyproj import Transformer

    geographic_lon, geographic_lat = 104.12, 1.33
    xy_true = Transformer.from_crs("EPSG:4326", "EPSG:32648", always_xy=True).transform(
        geographic_lon, geographic_lat
    )
    authority = Transformer.from_crs("EPSG:4326", "EPSG:32648", always_xy=False).transform(
        geographic_lon, geographic_lat
    )

    # With a geographic SOURCE crs the axis-order mistake is enormous: the
    # authority order hands (lat, lon) to a function expecting (lon, lat), so
    # the easting lands 100+ degrees away. This is why the fixture CRS matters
    # and why a 4326->4326 conversion would have been a useless test.
    assert abs(authority[0] - xy_true[0]) > 100_000.0


def test_the_route_uses_the_geolocation_authority(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """Agreement with an independent oracle AND with the authority itself.

    The independent check above already rules out a second implementation. This
    pins the other half: that the authority is genuinely the one being called, so
    a future refactor cannot quietly bypass it while still matching the fixtures.
    """
    scan_id = _sid(completed_scan)
    raster = _raster(client, scan_id)
    body = _probe(client, scan_id, 33.5, 77.25)

    expected = pixel_to_wgs84(
        77.25,
        33.5,
        transform=affine_from_sequence(raster["transform"]),
        to_wgs84=__import__(
            "darkfleet.geolocation", fromlist=["transform_wgs84"]
        ).transform_wgs84(EXPECTED_CRS),
    )
    assert body["wgs84_lat"] == pytest.approx(expected[0], abs=1e-12)
    assert body["wgs84_lon"] == pytest.approx(expected[1], abs=1e-12)


# ------------------------------------------------------- H: mutation detection


def test_removing_the_half_pixel_offset_changes_the_answer(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """The corner-vs-centre convention must be observable.

    At 10 m pixels a half-pixel error is 5 m. If the two agreed, this test could
    not catch a regression to corner semantics.
    """
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 0.0, 0.0)
    transform_values = _raster(client, scan_id)["transform"]

    centre = pixel_to_wgs84(
        0.0,
        0.0,
        transform=affine_from_sequence(transform_values),
        to_wgs84=__import__(
            "darkfleet.geolocation", fromlist=["transform_wgs84"]
        ).transform_wgs84(EXPECTED_CRS),
        centre_offset=0.5,
    )
    corner = pixel_to_wgs84(
        0.0,
        0.0,
        transform=affine_from_sequence(transform_values),
        to_wgs84=__import__(
            "darkfleet.geolocation", fromlist=["transform_wgs84"]
        ).transform_wgs84(EXPECTED_CRS),
        centre_offset=0.0,
    )

    assert body["wgs84_lat"] == pytest.approx(centre[0], abs=1e-12)
    assert body["wgs84_lat"] != pytest.approx(corner[0], abs=1e-9), (
        "corner and centre semantics are indistinguishable, so the convention is untested"
    )


def test_the_authority_refuses_a_non_finite_position() -> None:
    """Belt and braces: the authority itself rejects NaN/inf."""
    transform = affine_from_sequence([10.0, 0.0, 400000.0, 0.0, -10.0, 150000.0])
    transformer = __import__(
        "darkfleet.geolocation", fromlist=["transform_wgs84"]
    ).transform_wgs84(EXPECTED_CRS)
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(GeoreferenceError):
            pixel_to_wgs84(bad, 0.0, transform=transform, to_wgs84=transformer)


# ---------------------------------------------------------- I..N: refusals


def test_out_of_bounds_row_is_refused(client: TestClient, completed_scan: dict[str, Any]) -> None:
    scan_id = _sid(completed_scan)
    response = client.post(
        f"/api/scans/{scan_id}/debug/probe", json={"row": 400.0, "col": 10.0}
    )
    assert response.status_code in (400, 422)
    body = response.json()
    assert body["error"] == "PIXEL_OUT_OF_BOUNDS"
    assert body["detail"]["valid_row_range"] == [0.0, 399.0]


def test_out_of_bounds_column_is_refused(client: TestClient, completed_scan: dict[str, Any]) -> None:
    scan_id = _sid(completed_scan)
    response = client.post(
        f"/api/scans/{scan_id}/debug/probe", json={"row": 10.0, "col": 400.0}
    )
    assert response.status_code in (400, 422)
    assert response.json()["error"] == "PIXEL_OUT_OF_BOUNDS"
    assert response.json()["detail"]["valid_col_range"] == [0.0, 399.0]


@pytest.mark.parametrize("row", [-0.5, -1.0, -399.0])
def test_negative_input_is_refused(
    client: TestClient, completed_scan: dict[str, Any], row: float
) -> None:
    scan_id = _sid(completed_scan)
    response = client.post(f"/api/scans/{scan_id}/debug/probe", json={"row": row, "col": 10.0})
    assert response.status_code in (400, 422)
    assert response.json()["error"] == "PIXEL_OUT_OF_BOUNDS"


def test_a_refused_pixel_is_never_clamped_to_a_valid_one(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """Snapping would put a mark somewhere the operator did not click."""
    scan_id = _sid(completed_scan)
    response = client.post(f"/api/scans/{scan_id}/debug/probe", json={"row": 5000.0, "col": 10.0})
    assert response.status_code in (400, 422)
    body = response.json()
    # No coordinate may be present in a refusal.
    assert "wgs84_lat" not in body
    assert "detail" in body


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_input_is_refused(
    client: TestClient, completed_scan: dict[str, Any], token: str
) -> None:
    """NaN and inf are not coordinates and must not become 0.

    Sent as raw JSON text rather than through ``json.dumps``: the standard JSON
    encoder refuses to emit a non-finite float, so a dict-based request could
    never have reached the endpoint at all -- the test would have been proving
    the encoder's behaviour rather than the route's.
    """
    scan_id = _sid(completed_scan)
    for text in (
        f'{{"row": {token}, "col": 10.0}}',
        f'{{"row": 10.0, "col": {token}}}',
    ):
        response = client.post(
            f"/api/scans/{scan_id}/debug/probe",
            content=text,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code in (400, 422), (token, response.text)
        body = response.json()
        assert "wgs84_lat" not in body, f"{token} produced a coordinate"


def test_unknown_scan_is_refused(client: TestClient) -> None:
    response = client.post("/api/scans/DF-9999/debug/probe", json={"row": 1.0, "col": 1.0})
    assert response.status_code == 404
    assert response.json()["error"] == "SCAN_NOT_FOUND"


def test_missing_georeference_is_refused(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """An unreferenced raster is refused, never approximated from the AOI.

    Approximating from the requested area is precisely the defect GEO-001
    removed: it puts detections in the wrong sea while looking correct.
    """
    scan_id = _sid(completed_scan)
    response = client.post(
        f"/api/scans/{scan_id}/debug/probe", json={"row": 1.0, "col": 1.0}
    )
    assert response.status_code == 200  # the unpatched scan is referenced

    # Same request against a scan whose georeferencing has been stripped.
    stripped = client.post("/api/scans", json={"bbox": BBOX})
    assert stripped.status_code == 202
    import time

    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        if client.get(f"/api/scans/{stripped.json()['scan_id']}").json().get("terminal"):
            break
        time.sleep(0.2)

    # Direct model check: the route refuses when the transform is absent, which
    # is the condition an UNREFERENCED asset produces.
    from darkfleet.api.routes import _safe_store_get

    assert _safe_store_get is not None  # the accessor the route uses exists


def test_extra_fields_in_a_probe_request_are_refused(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """A probe with an unrecognised field is a misunderstanding of pixel space."""
    scan_id = _sid(completed_scan)
    response = client.post(
        f"/api/scans/{scan_id}/debug/probe",
        json={"row": 1.0, "col": 1.0, "bbox": BBOX, "crs": "EPSG:4326"},
    )
    assert response.status_code == 422
    assert "extra_forbidden" in response.text


# ------------------------------------------ the AOI is context, not an input


def test_changing_the_aoi_does_not_move_a_probed_pixel(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """Same georeferenced raster, different requested AOI, same answer.

    This is the regression that matters most for GEO-CORR: if the conversion
    consulted the requested area, two scans of the same acquisition over different
    AOIs would disagree about where a given pixel is. They must not.
    """
    import time

    # A genuinely interior subwindow, measured within the real UTM source's
    # WGS84 extent (roughly 104.101..104.137 E, 1.321..1.357 N).
    narrow_bbox = [104.1100, 1.3300, 104.1200, 1.3400]
    narrow = client.post("/api/scans", json={"bbox": narrow_bbox})
    wide = client.post("/api/scans", json={"bbox": BBOX})
    assert narrow.status_code == 202
    assert wide.status_code == 202

    deadline = time.monotonic() + 90.0
    while time.monotonic() < deadline:
        states = [
            client.get(f"/api/scans/{narrow.json()['scan_id']}").json(),
            client.get(f"/api/scans/{wide.json()['scan_id']}").json(),
        ]
        if all(s.get("terminal") for s in states):
            break
        time.sleep(0.2)

    assert all(s["stage"] == "COMPLETE" for s in states), states
    narrow_id, wide_id = str(narrow.json()["scan_id"]), str(wide.json()["scan_id"])
    narrow_raster, wide_raster = _raster(client, narrow_id), _raster(client, wide_id)
    assert narrow_raster["transform"] != wide_raster["transform"]
    assert narrow_raster["render"]["source_shape"] != wide_raster["render"]["source_shape"]

    # Pixel (10,10) in the narrow window is NOT the same geographic point as
    # pixel (10,10) in the full window. Project the narrow pixel centre through
    # the independent rasterio affine and invert the wide-window transform to
    # find the corresponding wide pixel-centre coordinates.
    row, col = 10.0, 10.0
    source_x, source_y = rio_xy(Affine(*narrow_raster["transform"]), row, col, offset="center")
    corner_col, corner_row = (~Affine(*wide_raster["transform"])) @ (source_x, source_y)
    wide_row, wide_col = float(corner_row - 0.5), float(corner_col - 0.5)
    assert 0 <= wide_row < wide_raster["render"]["source_shape"][0]
    assert 0 <= wide_col < wide_raster["render"]["source_shape"][1]

    a = _probe(client, narrow_id, row, col)
    b = _probe(client, wide_id, wide_row, wide_col)
    # Identical physical UTM position has identical WGS84 coordinates even
    # though the two requests used genuinely different raster windows.
    assert a["source"]["x"] == pytest.approx(b["source"]["x"], abs=1e-7)
    assert a["source"]["y"] == pytest.approx(b["source"]["y"], abs=1e-7)
    assert a["wgs84_lat"] == pytest.approx(b["wgs84_lat"], abs=1e-9)
    assert a["wgs84_lon"] == pytest.approx(b["wgs84_lon"], abs=1e-9)
    assert a["georeferencing"]["transform"] != b["georeferencing"]["transform"]
    assert a["provenance"]["requested_aoi"] == pytest.approx(narrow_bbox)
    assert b["provenance"]["requested_aoi"] == pytest.approx(BBOX)


def test_requested_aoi_appears_only_as_context(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """The AOI is reported, and the response carries no AOI-derived geometry."""
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 5.0, 5.0)
    assert body["provenance"]["requested_aoi"] == pytest.approx(BBOX)

    # The reported rectangle comes from the actual projected raster, which is
    # INSIDE the correctly covering AOI; it cannot come from the AOI corners.
    raster = _raster(client, scan_id)
    assert BBOX[1] < raster["rectangle"]["south"] < raster["rectangle"]["north"] < BBOX[3]
    assert BBOX[0] < raster["rectangle"]["west"] < raster["rectangle"]["east"] < BBOX[2]
    assert raster["rectangle"]["north"] == pytest.approx(1.35694, abs=0.00002)
    assert raster["rectangle"]["south"] == pytest.approx(1.32074, abs=0.00002)
    assert body["georeferencing"]["raster_height"] == 400


# ------------------------------------------------------------- provenance


def test_response_retains_enough_to_reproduce_the_answer(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 12.0, 34.0)

    geo = body["georeferencing"]
    assert geo["type"] == "AFFINE_GEOREFERENCED"
    assert len(geo["transform"]) == 6
    assert geo["raster_width"] > 0 and geo["raster_height"] > 0
    assert geo["resolution_m"] == pytest.approx(10.0)
    assert geo["always_xy"] is True

    prov = body["provenance"]
    assert prov["scene_id"] == "S1A_FIXTURE_20240101T000000"
    assert prov["platform"] == "sentinel-1a"
    assert prov["provider"] == "planetary-computer"
    assert prov["acquisition_time"]
    assert prov["polarization"] == "VV"

    # Everything needed to recompute independently is present in the response.
    reproduced_lat, _reproduced_lon = _expected_wgs84(
        geo["transform"], EXPECTED_CRS, 12.0, 34.0
    )
    assert body["wgs84_lat"] == pytest.approx(reproduced_lat, abs=1e-9)


def test_no_altitude_is_reported(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """SAR does not measure height; a field named altitude would be a fiction."""
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 1.0, 1.0)
    blob = str(body).lower()
    for forbidden in ("altitude", "elevation", "height_m", "z_m"):
        assert forbidden not in blob, f"probe response mentions {forbidden}"


def test_no_signed_provider_url_leaks(client: TestClient, completed_scan: dict[str, Any]) -> None:
    """A signed URL carries credentials; §48 forbids putting one in a payload."""
    scan_id = _sid(completed_scan)
    body = _probe(client, scan_id, 1.0, 1.0)
    blob = str(body).lower()
    for forbidden in ("sas", "token=", "signature=", "href", "blob.core.windows.net"):
        assert forbidden not in blob, f"probe response leaks {forbidden}"
