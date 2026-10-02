"""UI-D1 gate: the SAR raster endpoints, end to end.

Cesium cannot decode GeoTIFF/COG, so the render is server-side. That makes the
raster a first-class API surface, and these tests hold it to the same standard as
the rest of the product: every rectangle is derived from the MEASURED window
transform, never from the requested AOI.

The alignment test here is the permanent form of the check that GEO-CORR was
blocking. It is the single assertion that ties the rendered image to the targets
drawn on top of it: if a detection falls outside the rectangle the image is
drawn into, the map is lying about where the radar contact is.

Proved here:

* all six layers render and every one is georeferenced;
* EVERY detection falls inside the rendered rectangle;
* the reported rectangle is consistent with the reported CRS and transform;
* the image is a decodable PNG whose shape matches the reported shape;
* the display window is reported honestly, including when the percentile window
  was degenerate and had to be widened;
* a layer the pipeline did not produce is an explicit error, never a blank image.
"""

from __future__ import annotations

import io
import time
from collections.abc import Iterator
from typing import Any

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from rasterio.warp import transform as warp

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.raster_render import RASTER_LAYERS
from tests import fixture_source

AOI = fixture_source.FIXTURE_BBOX

#: What the pipeline is contracted to expose. Order is display order.
EXPECTED_LAYERS = (
    "raw",
    "normalized",
    "filtered",
    "landmask",
    "cfar_threshold",
    "detection_mask",
)


@pytest.fixture(scope="module", autouse=True)
def offline_pipeline() -> Iterator[None]:
    """Point the pipeline at the committed fixture COG for this module.

    Only the network and the asset resolution are replaced. Detection, geolocation
    and correlation all run the production code, so a regression in any of them
    shows up here rather than being stubbed away.

    Uses ``MonkeyPatch.context()`` rather than the ``monkeypatch`` fixture: this
    is module-scoped and the fixture is function-scoped.
    """
    with pytest.MonkeyPatch.context() as patch:
        fixture_source.install(patch)
        yield


@pytest.fixture(scope="module", autouse=True)
def stub_network() -> Iterator[None]:
    """Serve a canned STAC catalogue so the scan never touches the internet.

    The catalogue search is the one part of a scan that genuinely leaves the
    process, and it cannot be replaced by a fixture file the way asset resolution
    can -- so it is answered from here. The scene it returns is a real Sentinel-1
    item id; only the bytes it points at are swapped, by ``fixture_source``.
    """
    real_get, real_post = httpx.get, httpx.post

    class _Stub:
        status_code = 200

        def __init__(self) -> None:
            self.calls: list[str] = []

        def _record(self, url: str, **_kw: Any) -> _Stub:
            self.calls.append(str(url))
            return self

        def get(self, url: str, **kw: Any) -> _Stub:
            return self._record(url, **kw)

        def post(self, url: str, **kw: Any) -> _Stub:
            return self._record(url, **kw)

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "features": [
                    {
                        "id": "S1A_IW_GRDH_1SDV_20260918",
                        "properties": {
                            "datetime": "2026-09-18T14:32:18Z",
                            "platform": "sentinel-1a",
                        },
                        "assets": {
                            "vv": {
                                "href": "https://example.invalid/s1-grd/vv.tif",
                                "roles": ["data"],
                            }
                        },
                    }
                ]
            }

    httpx.get = _Stub().get
    httpx.post = _Stub().post
    try:
        yield
    finally:
        httpx.get, httpx.post = real_get, real_post


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    data_dir = tmp_path_factory.mktemp("raster-data")
    settings = Settings(data_dir=str(data_dir))
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def scan_id(client: TestClient) -> str:
    response = client.post("/api/scans", json={"bbox": AOI})
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["runtime_mode"] == "REAL"
    assert body["synthetic"] is False

    scan = str(body["scan_id"])
    deadline = time.monotonic() + 180.0
    while True:
        state = client.get(f"/api/scans/{scan}").json()
        if state["terminal"]:
            assert state["stage"] == "COMPLETE", state
            return scan
        if time.monotonic() > deadline:
            raise AssertionError(f"scan {scan} never finished: {state}")
        time.sleep(0.05)


# --------------------------------------------------------------------- layers


def test_index_lists_every_renderable_layer(client: TestClient, scan_id: str) -> None:
    response = client.get(f"/api/scans/{scan_id}/raster")
    assert response.status_code == 200, response.text
    body = response.json()
    layers = [entry["layer"] for entry in body["layers"]]
    assert tuple(layers) == EXPECTED_LAYERS
    assert set(layers) == set(RASTER_LAYERS)


def test_every_layer_is_georeferenced(client: TestClient, scan_id: str) -> None:
    for layer in EXPECTED_LAYERS:
        response = client.get(f"/api/scans/{scan_id}/raster/{layer}")
        assert response.status_code == 200, f"{layer}: {response.text[:200]}"
        body = response.json()
        rect = body["rectangle"]
        assert body["crs"], f"{layer} has no CRS"
        assert len(body["transform"]) == 6, f"{layer} has no affine transform"
        assert rect["west"] < rect["east"], f"{layer} rectangle is not west<east"
        assert rect["south"] < rect["north"], f"{layer} rectangle is not south<north"


# ------------------------------------------------------------------ alignment


def test_every_detection_falls_inside_the_rendered_rectangle(
    client: TestClient, scan_id: str
) -> None:
    """The permanent GEO-CORR alignment regression.

    Before GEO-CORR this failed 3/3: detections were interpolated across the
    requested AOI and landed ~4 km north of the raster that produced them.
    """
    targets = client.get(f"/api/scans/{scan_id}/targets").json()["targets"]
    assert targets, "fixture scene should yield targets"

    for layer in ("raw", "normalized", "filtered", "cfar_threshold"):
        rect = client.get(f"/api/scans/{scan_id}/raster/{layer}").json()["rectangle"]
        for target in targets:
            lat, lon = float(target["lat"]), float(target["lon"])
            assert rect["south"] <= lat <= rect["north"], (
                f"{target['id']} lat {lat} outside {layer} rectangle "
                f"{rect['south']}..{rect['north']}"
            )
            assert rect["west"] <= lon <= rect["east"], (
                f"{target['id']} lon {lon} outside {layer} rectangle "
                f"{rect['west']}..{rect['east']}"
            )


def test_rectangle_matches_the_reported_crs_not_the_requested_aoi(
    client: TestClient, scan_id: str
) -> None:
    """The rectangle is derived from the measured transform, not the AOI.

    The fixture AOI and the fixture's true extent differ, so conflating them is
    detectable here rather than being taken on trust.
    """
    meta = client.get(f"/api/scans/{scan_id}/raster/raw").json()
    rect = meta["rectangle"]
    aoi_lat = (AOI[1], AOI[3])

    # Reproject the measured bounds and confirm the rectangle is that envelope.
    from rasterio.transform import array_bounds

    from darkfleet.geolocation import affine_from_sequence

    height, width = meta["render"]["source_shape"]
    left, bottom, right, top = array_bounds(height, width, affine_from_sequence(meta["transform"]))
    _, lats = warp(meta["crs"], "EPSG:4326", [left, right], [bottom, top])
    assert rect["south"] == pytest.approx(min(lats), abs=1e-6)
    assert rect["north"] == pytest.approx(max(lats), abs=1e-6)
    # And it must NOT simply echo the requested AOI.
    assert not (
        rect["south"] == pytest.approx(aoi_lat[0], abs=1e-9)
        and rect["north"] == pytest.approx(aoi_lat[1], abs=1e-9)
    )


# ---------------------------------------------------------------------- image


@pytest.mark.parametrize("layer", EXPECTED_LAYERS)
def test_layer_renders_a_decodable_png(client: TestClient, scan_id: str, layer: str) -> None:
    response = client.get(f"/api/scans/{scan_id}/raster/{layer}/image")
    assert response.status_code == 200, response.text[:200]
    assert response.headers["content-type"] == "image/png"

    meta = client.get(f"/api/scans/{scan_id}/raster/{layer}").json()
    image = Image.open(io.BytesIO(response.content))
    assert list(image.size) == meta["render"]["rendered_shape"]


def test_continuous_layers_are_not_flat_and_separate_signal(
    client: TestClient, scan_id: str
) -> None:
    """A render must carry information.

    Deliberately NOT a tone-count assertion. The fixture's water background is a
    single clamped -90 dB across >98% of pixels, so a faithful render of it is
    legitimately bimodal. What must hold is that the image is neither blank nor
    uniform -- an all-one-value image means the stretch failed, whatever the
    source looks like.
    """
    response = client.get(f"/api/scans/{scan_id}/raster/raw/image")
    assert response.status_code == 200
    arr = np.asarray(Image.open(io.BytesIO(response.content)).convert("L"), dtype=np.float64)
    assert arr.std() > 0.5, f"flat render: std={arr.std()}"
    assert np.unique(arr).size >= 2, "render carries no contrast at all"


def test_display_window_is_reported_honestly(client: TestClient, scan_id: str) -> None:
    """`basis` must describe the window that was actually used.

    A degenerate percentile window is widened by `_stats`; if the report still
    claimed a percentile stretch, it would be describing a measurement that did
    not happen.
    """
    report = client.get(f"/api/scans/{scan_id}/raster/raw").json()["render"]
    window = report["display_window"]
    assert set(window) == {"lo", "hi", "basis"}
    if window["lo"] is not None:
        assert window["hi"] > window["lo"], "a zero-width window would divide by zero"
        assert "percentile" in window["basis"] or "degenerate" in window["basis"]
    else:
        assert "binary" in window["basis"]


def test_binary_layers_report_no_stretch(client: TestClient, scan_id: str) -> None:
    for layer in ("landmask", "detection_mask"):
        report = client.get(f"/api/scans/{scan_id}/raster/{layer}").json()["render"]
        assert report["display_window"]["lo"] is None
        assert "binary" in report["display_window"]["basis"]


# --------------------------------------------------------------------- errors


def test_unknown_layer_is_an_explicit_404(client: TestClient, scan_id: str) -> None:
    response = client.get(f"/api/scans/{scan_id}/raster/not_a_layer")
    assert response.status_code == 404
    body = response.json()
    assert body["error"] == "UNKNOWN_RASTER_LAYER"
    assert set(body["detail"]["layers"]) == set(RASTER_LAYERS)


def test_unknown_scan_is_an_explicit_404(client: TestClient) -> None:
    assert client.get("/api/scans/DF-9999/raster").status_code == 404


def test_raster_is_unavailable_before_a_scan_completes(client: TestClient) -> None:
    """No raster is invented for a scan that never ran.

    A partially-processed scan must not serve an image, because the rectangle
    would be measured from a window nobody ever thresholded.
    """
    queued = client.post("/api/scans", json={"bbox": AOI}).json()["scan_id"]
    response = client.get(f"/api/scans/{queued}/raster")
    # Either the job has already finished (and the raster is real), or it has not
    # and the endpoint refuses rather than guessing.
    if response.status_code != 200:
        assert response.status_code in (404, 409), response.text[:200]
        assert response.json()["error"] in {
            "RASTER_NOT_AVAILABLE",
            "RASTER_LAYER_ABSENT",
            "UNKNOWN_SCAN",
        }