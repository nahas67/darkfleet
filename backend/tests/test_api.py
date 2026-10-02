"""CP7 gate: the HTTP API end to end (API-001..012, TST-007).

Every test runs against a temporary ``data_dir`` and a stubbed network, so the
suite can never touch a real ``data/`` directory or a live provider. What is
proved here:

* a DEMO scan walks all 14 pipeline stages, persists, and answers every read
  endpoint with ``runtime_mode=DEMO`` / ``synthetic=true``;
* a completed scan is readable from a *fresh* app without rerunning anything;
* provider health comes from real probes, and no credential leaves the process;
* REAL failures are explicit (unknown provider -> 400, auth/refused -> 503)
  and never fall back to DEMO data;
* SSE replays the real stage sequence and terminates on the terminal stage;
* bbox validation is Pydantic's job (422);
* geojson/kml/json export carries provenance; png/pdf answer 501;
* debug layers return compact summaries, never a raster blob.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from typing import Any
from xml.etree import ElementTree

import httpx
import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.api.routes import _CORRELATION_COLUMNS, DEBUG_LAYERS
from darkfleet.config.settings import Settings
from darkfleet.jobs.models import PIPELINE, ScanStage
from darkfleet.providers import ProviderStatus

DEMO_BBOX = [103.65, 1.10, 104.05, 1.40]
OTHER_BBOX = [56.30, 26.40, 56.90, 26.90]
STAGES = [stage.value for stage in PIPELINE]

#: Injected credentials: nothing the API returns may contain them.
SECRETS = ("cdse-SECRET-4f2a", "ais-SECRET-9b7c", "gfw-SECRET-1c3d")

_KML_NS = "{http://www.opengis.net/kml/2.2}"


# --------------------------------------------------------------- fake network


def _features() -> list[dict[str, Any]]:
    return [
        {
            "id": "S1A_IW_GRDH_1SDV_20260918",
            "properties": {"datetime": "2026-09-18T14:32:18Z", "platform": "sentinel-1a"},
            "assets": {
                "vv": {
                    "href": "https://pcstore.blob.core.windows.net/s1-grd/vv.tif",
                    "roles": ["data"],
                },
                "vh": {
                    "href": "https://pcstore.blob.core.windows.net/s1-grd/vh.tif",
                    "roles": ["data"],
                },
            },
        }
    ]


class FakeNetwork:
    """Deterministic stand-in for every outbound call the API can make.

    Installed over ``httpx.get``/``httpx.post`` for the whole module, so a test
    that accidentally reaches the network fails loudly instead of silently
    depending on the internet.
    """

    def __init__(self) -> None:
        self.get_calls: list[str] = []
        self.post_calls: list[str] = []
        self.catalog_status = 200
        self.sas_status = 401
        self.search_status = 200
        self.search_features = _features()

    def reset(self) -> None:
        self.get_calls.clear()
        self.post_calls.clear()

    @property
    def calls(self) -> list[str]:
        return self.get_calls + self.post_calls

    def _catalog(self, url: str) -> httpx.Response:
        if "planetarycomputer" in url:
            payload: dict[str, Any] = {
                "collections": [{"id": "sentinel-1-rtc"}, {"id": "sentinel-1-grd"}]
            }
        elif "earth-search" in url:
            payload = {"collections": [{"id": "sentinel-1-grd"}]}
        elif "dataspace" in url:
            # CDSE really publishes no Sentinel-1: the probe must say so.
            payload = {"collections": [{"id": "sentinel-2-l2a"}, {"id": "cop-dem-glo-30"}]}
        else:
            raise AssertionError(f"unexpected catalog probe: {url}")
        return self._response(self.catalog_status, payload, url)

    def _response(self, status_code: int, payload: Any, url: str) -> httpx.Response:
        # A real Response needs its request attached: raise_for_status() reads it.
        return httpx.Response(status_code, json=payload, request=httpx.Request("GET", url))

    def get(self, url: str, *args: Any, **kwargs: Any) -> httpx.Response:
        text = str(url)
        self.get_calls.append(text)
        if "/sas/v1/token" in text:
            return self._response(
                self.sas_status, {"token": "", "expires": "2026-09-19T00:00Z"}, text
            )
        if text.endswith("/collections"):
            return self._catalog(text)
        raise AssertionError(f"unexpected GET: {text}")

    def post(self, url: str, *args: Any, **kwargs: Any) -> httpx.Response:
        text = str(url)
        self.post_calls.append(text)
        if text.endswith("/search"):
            return self._response(self.search_status, {"features": self.search_features}, text)
        raise AssertionError(f"unexpected POST: {text}")


@pytest.fixture(scope="module")
def net() -> Iterator[FakeNetwork]:
    fake = FakeNetwork()
    real_get, real_post = httpx.get, httpx.post
    httpx.get = fake.get  # type: ignore[assignment]
    httpx.post = fake.post  # type: ignore[assignment]
    try:
        yield fake
    finally:
        httpx.get = real_get  # type: ignore[assignment]
        httpx.post = real_post  # type: ignore[assignment]


@pytest.fixture(scope="module")
def api_settings(tmp_path_factory: pytest.TempPathFactory) -> Settings:
    data_dir = tmp_path_factory.mktemp("darkfleet-data")
    settings = Settings(data_dir=str(data_dir))
    settings.log_level = "WARNING"
    # The synthetic scene catalogue is a TEST harness, not a product mode. It is
    # off by default everywhere else, and the API refuses it unless enabled here.
    settings.allow_synthetic_scenes = True
    settings.cdse.client_secret = SECRETS[0]
    settings.ais.aistream_api_key = SECRETS[1]
    settings.ais.gfw_api_token = SECRETS[2]
    return settings


@pytest.fixture(scope="module")
def client(api_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(api_settings)) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def real_client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    """An app with synthetic scenes DISABLED, i.e. the shipped configuration.

    This is the default the product actually runs with. The tests that assert
    REAL behaviour must use it, because with synthetic scenes enabled the API
    short-circuits before it ever contacts a provider.
    """
    conf = Settings(data_dir=str(tmp_path_factory.mktemp("darkfleet-real")))
    conf.log_level = "WARNING"
    conf.allow_synthetic_scenes = False
    with TestClient(create_app(conf)) as real_test_client:
        yield real_test_client


# ------------------------------------------------------------------ helpers


def _await_terminal(client: TestClient, scan_id: str, timeout: float = 120.0) -> dict[str, Any]:
    """Poll the job endpoint until it reaches a terminal state."""
    deadline = time.monotonic() + timeout
    while True:
        response = client.get(f"/api/scans/{scan_id}")
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        if body["terminal"]:
            return body
        if time.monotonic() > deadline:
            raise AssertionError(f"scan {scan_id} never finished; last state {body}")
        time.sleep(0.05)


def _start_demo_scan(client: TestClient, bbox: list[float] | None = None) -> str:
    response = client.post(
        "/api/scans",
        json={"bbox": bbox or DEMO_BBOX},
    )
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    assert body["status"] == ScanStage.QUEUED.value
    assert re.fullmatch(r"DF-\d{4}", body["scan_id"])
    return str(body["scan_id"])


@pytest.fixture(scope="module")
def completed_demo(client: TestClient) -> dict[str, Any]:
    """One completed DEMO scan, shared by the read-only assertions."""
    scan_id = _start_demo_scan(client)
    state = _await_terminal(client, scan_id)
    return state


# --------------------------------------------------------------------- tests


def test_demo_scan_completes_and_every_read_endpoint_is_synthetic(
    client: TestClient, completed_demo: dict[str, Any]
) -> None:
    """API-001/002/003: queue -> COMPLETE -> targets -> evidence, all DEMO."""
    scan_id = str(completed_demo["scan_id"])
    assert completed_demo["stage"] == ScanStage.COMPLETE.value
    assert completed_demo["runtime_mode"] == "DEMO"
    assert completed_demo["synthetic"] is True
    assert [event["stage"] for event in completed_demo["history"]] == STAGES
    assert completed_demo["record_persisted"] is True

    targets_response = client.get(f"/api/scans/{scan_id}/targets")
    assert targets_response.status_code == 200, targets_response.text
    targets_body = targets_response.json()
    assert targets_body["count"] > 0
    assert targets_body["targets"]
    assert targets_body["runtime_mode"] == "DEMO"
    assert targets_body["synthetic"] is True
    assert targets_body["provenance"]["synthetic"] is True
    assert targets_body["provenance"]["runtime_mode"] == "DEMO"
    assert "demo-synthesizer" in targets_body["provenance"]["sar"]["provider"]

    target_id = str(targets_body["targets"][0]["id"])

    evidence = client.get(f"/api/evidence/{target_id}", params={"scan_id": scan_id})
    assert evidence.status_code == 200, evidence.text
    evidence_body = evidence.json()
    assert evidence_body["scan_id"] == scan_id
    assert evidence_body["synthetic"] is True
    assert evidence_body["evidence"]["provenance"]["synthetic"] is True
    assert evidence_body["evidence"]["targets"]
    assert evidence_body["evidence"]["config"]["config_hash"]

    slice_response = client.get(f"/api/targets/{target_id}", params={"scan_id": scan_id})
    assert slice_response.status_code == 200, slice_response.text
    slice_body = slice_response.json()
    assert slice_body["evidence"]["target_id"] == target_id
    assert slice_body["evidence"]["uncertainty"]["propagation_note"]
    assert slice_body["evidence"]["observed"]["position"]["lat"] is not None
    assert slice_body["synthetic"] is True


def test_completed_scan_survives_a_fresh_app_without_rerunning(
    api_settings: Settings, completed_demo: dict[str, Any]
) -> None:
    """The run store, not process memory, is what makes a scan readable."""
    scan_id = str(completed_demo["scan_id"])
    with TestClient(create_app(api_settings)) as fresh:
        state = fresh.get(f"/api/scans/{scan_id}")
        assert state.status_code == 200, state.text
        body = state.json()
        assert body["stage"] == ScanStage.COMPLETE.value
        assert body["record_persisted"] is True
        again = fresh.get(f"/api/scans/{scan_id}/targets")
        assert again.status_code == 200
        assert again.json()["count"] > 0


def test_unknown_scan_is_an_explicit_404(client: TestClient) -> None:
    response = client.get("/api/scans/DF-9999")
    assert response.status_code == 404
    body = response.json()
    assert body["error"] == "UNKNOWN_SCAN"
    assert body["scan_id"] == "DF-9999"
    assert client.get("/api/scans/DF-9999/targets").status_code == 404


def test_provider_health_is_probed_and_leaks_no_secret(client: TestClient, net: FakeNetwork) -> None:
    """API-007: statuses come from requests made now, not from env vars."""
    net.reset()
    response = client.get("/api/providers/health")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["probe"] == "live"
    entries = body["providers"]
    assert {entry["provider"] for entry in entries} == {
        "planetary-computer",
        "earthsearch",
        "cdse",
        "ais-local",
    }
    valid = {value.value for value in ProviderStatus}
    for entry in entries:
        assert entry["status"] in valid, entry
        assert entry["detail"]
        assert entry["last_check"]

    by_provider = {entry["provider"]: entry for entry in entries}
    # Planetary Computer published sentinel-1-rtc in the stubbed catalog.
    assert by_provider["planetary-computer"]["status"] == ProviderStatus.AVAILABLE.value
    # EarthSearch answers, but its assets are GCP-referenced only.
    assert by_provider["earthsearch"]["status"] == ProviderStatus.DEGRADED.value
    # CDSE really carries no Sentinel-1; the probe says UNAVAILABLE.
    assert by_provider["cdse"]["status"] == ProviderStatus.UNAVAILABLE.value
    assert "Sentinel-1" in by_provider["cdse"]["detail"]
    # An empty local archive is NOT_CONFIGURED, not AVAILABLE.
    assert by_provider["ais-local"]["status"] == ProviderStatus.NOT_CONFIGURED.value

    raw = response.text
    for secret in SECRETS:
        assert secret not in raw
    for entry in entries:
        for key, value in entry.items():
            assert not re.search(r"(?i)(secret|token|password|api_?key)", key), key
            if isinstance(value, str):
                for secret in SECRETS:
                    assert secret not in value
    # The statuses above can only come from outbound calls.
    assert net.calls, "provider health answered without a single outbound request"


def test_real_scan_with_unknown_provider_is_explicit_and_synthetic_free(
    real_client: TestClient, net: FakeNetwork
) -> None:
    """API-012: a bad REAL request is a 400 with a status, never DEMO data."""
    net.reset()
    response = real_client.post(
        "/api/scans",
        json={
            "bbox": DEMO_BBOX,
            "provider": "totally-unknown-provider",
            "product": "rtc",
        },
    )
    assert response.status_code == 400, response.text
    body = response.json()
    assert body["status"] == ProviderStatus.NOT_CONFIGURED.value
    assert body["error"] == "UNKNOWN_PROVIDER"
    assert body["provider"] == "totally-unknown-provider"
    # An error body never claims a world: no synthetic/DEMO data at all.
    assert body.get("synthetic") is None
    assert body.get("runtime_mode") is None
    assert "DEMO" not in response.text
    assert "demo-synthesizer" not in response.text
    assert "targets" not in body
    # Rejected before anything was contacted or queued.
    assert net.calls == []


def test_real_provider_failure_surfaces_as_503_with_status(
    real_client: TestClient, net: FakeNetwork
) -> None:
    """An unauthenticated provider is AUTH_REQUIRED/503, not a DEMO fallback."""
    net.reset()
    net.search_status = 401
    try:
        response = real_client.get(
            "/api/scenes",
            params={
                "provider": "planetary-computer",
                "bbox": ",".join(str(value) for value in DEMO_BBOX),
                "datetime": "2026-09-01T00:00:00Z/2026-09-30T00:00:00Z",
            },
        )
        assert response.status_code == 503, response.text
        body = response.json()
        assert body["status"] == ProviderStatus.AUTH_REQUIRED.value
        assert body["provider"] == "planetary-computer"
        assert body.get("scenes") is None
        assert "demo-synthesizer" not in response.text
    finally:
        net.search_status = 200


def test_real_scene_search_never_returns_demo_scenes(
    real_client: TestClient, net: FakeNetwork
) -> None:
    net.reset()
    response = real_client.get(
        "/api/scenes",
        params={
            "provider": "planetary-computer",
            "bbox": ",".join(str(value) for value in DEMO_BBOX),
            "datetime": "2026-09-01T00:00:00Z/2026-09-30T00:00:00Z",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtime_mode"] == "REAL"
    assert body["synthetic"] is False
    assert body["scenes"], body
    for scene in body["scenes"]:
        assert scene["synthetic"] is False
        assert scene["provider"] != "demo-synthesizer"


def test_real_scan_fails_loudly_and_persists_nothing(
    real_client: TestClient, net: FakeNetwork
) -> None:
    """A REAL scan whose SAS token is refused ends FAILED with zero demo data."""
    net.reset()
    net.sas_status = 401
    try:
        response = real_client.post(
            "/api/scans",
            json={"bbox": DEMO_BBOX, "provider": "planetary-computer"},
        )
        assert response.status_code == 202, response.text
        scan_id = str(response.json()["scan_id"])
        state = _await_terminal(real_client, scan_id)
        assert state["stage"] == ScanStage.FAILED.value
        assert state["synthetic"] is False
        assert state["runtime_mode"] == "REAL"
        # The runner names the stage that was in flight: SEARCHING_SCENE reported,
        # so its successor READING_SAR is where the work aborted.
        assert state["failed_at"] == ScanStage.READING_SAR.value
        assert state["record_persisted"] is False
        assert "account" in str(state["error"])
        assert real_client.get(f"/api/scans/{scan_id}/targets").status_code == 404
        assert real_client.get(f"/api/scans/{scan_id}/export/geojson").status_code == 404
        for secret in SECRETS:
            assert secret not in json.dumps(state)
    finally:
        net.sas_status = 401


def test_sse_streams_the_real_stage_sequence_and_terminates(client: TestClient) -> None:
    """API-004: subscribe() is replayed live and closed on the terminal event."""
    scan_id = _start_demo_scan(client)
    with client.stream("GET", f"/api/scans/{scan_id}/events") as stream:
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        frames: list[dict[str, Any]] = []
        for line in stream.iter_lines():
            if line.startswith("data:"):
                frames.append(json.loads(line[len("data:") :]))
    stages = [frame["stage"] for frame in frames]
    assert stages == STAGES, stages
    assert [frame["detail"] for frame in frames][-1].startswith("scan completed")
    assert frames[-1]["terminal"] is True
    assert all(frame["terminal"] is False for frame in frames[:-1])
    assert all(frame["scan_id"] == scan_id for frame in frames)


def test_sse_for_an_unknown_scan_is_404(client: TestClient) -> None:
    assert client.get("/api/scans/DF-9999/events").status_code == 404


def test_malformed_bbox_is_rejected_by_validation(client: TestClient) -> None:
    for bad in ([1.0, 2.0, 3.0], [1.0, 2.0, 3.0, 4.0, 5.0], [10.0, 0.0, 5.0, 1.0], ["a", 0, 1, 1]):
        response = client.post("/api/scans", json={"bbox": bad})
        assert response.status_code == 422, (bad, response.text)
        assert response.json()["detail"]
    # Out-of-range and unknown fields are refused too.
    assert client.post("/api/scans", json={"bbox": [0.0, 0.0, 1.0, 999.0]}).status_code == 422
    assert client.post(
        "/api/scans", json={"bbox": DEMO_BBOX, "synthetic": True}
    ).status_code == 422


def test_demo_scan_rejects_a_bbox_the_scene_does_not_cover(client: TestClient) -> None:
    response = client.post("/api/scans", json={"bbox": OTHER_BBOX})
    assert response.status_code == 400, response.text
    assert response.json()["error"] == "BBOX_SCENE_MISMATCH"


def test_scenes_endpoint_is_demo_by_default_and_marks_synthetic(client: TestClient) -> None:
    response = client.get("/api/scenes")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtime_mode"] == "DEMO"
    assert body["synthetic"] is True
    assert body["count"] == len(body["scenes"]) >= 1
    for scene in body["scenes"]:
        assert scene["synthetic"] is True
        assert scene["provider"] == "demo-synthesizer"


def test_exports_carry_provenance(
    client: TestClient, completed_demo: dict[str, Any]
) -> None:
    """API-010: three real formats, provenance in each; png/pdf are 501."""
    scan_id = str(completed_demo["scan_id"])
    targets = client.get(f"/api/scans/{scan_id}/targets").json()

    geojson = client.get(f"/api/scans/{scan_id}/export/geojson")
    assert geojson.status_code == 200, geojson.text
    assert geojson.headers["content-type"].startswith("application/geo+json")
    assert "attachment" in geojson.headers["content-disposition"]
    geo = geojson.json()
    assert geo["type"] == "FeatureCollection"
    assert geo["synthetic"] is True
    assert geo["runtime_mode"] == "DEMO"
    assert len(geo["features"]) == targets["count"]
    assert geo["provenance"]["sar"]["item_id"]
    assert geo["provenance"]["processing"]["config_hash"]
    first = geo["features"][0]
    lon, lat = first["geometry"]["coordinates"]
    assert lon == pytest.approx(targets["targets"][0]["lon"], abs=1e-9)
    assert lat == pytest.approx(targets["targets"][0]["lat"], abs=1e-9)
    assert first["properties"]["scan_id"] == scan_id
    assert first["properties"]["synthetic"] is True

    kml = client.get(f"/api/scans/{scan_id}/export/kml")
    assert kml.status_code == 200, kml.text
    assert kml.headers["content-type"].startswith("application/vnd.google-earth.kml+xml")
    root = ElementTree.fromstring(kml.text)
    placemarks = root.iter(f"{_KML_NS}Placemark")
    assert len(list(placemarks)) == targets["count"]
    description = root.find(f".//{_KML_NS}description")
    assert description is not None and description.text
    assert "provenance" in description.text
    assert "config_hash" in description.text
    coordinates = root.find(f".//{_KML_NS}coordinates")
    assert coordinates is not None and coordinates.text
    assert coordinates.text.split(",")[0] == f"{lon:.6f}"

    raw_json = client.get(f"/api/scans/{scan_id}/export/json")
    assert raw_json.status_code == 200, raw_json.text
    document = raw_json.json()
    assert document["scan_id"] == scan_id
    assert document["synthetic"] is True
    assert document["provenance"]["classification_schema"]
    assert len(document["targets"]) == targets["count"]


def test_png_and_pdf_exports_are_rendered_server_side(
    client: TestClient, completed_demo: dict[str, Any]
) -> None:
    """EXP-004/005: a real PNG and a real PDF, rendered from the record.

    CP12 wrote the renderers but left the route answering 501. This asserts the
    artefact is actually produced, carries the correct magic bytes, and states
    the DEMO/REAL marker -- a browser screenshot would satisfy none of these.
    """
    scan_id = str(completed_demo["scan_id"])
    png = client.get(f"/api/scans/{scan_id}/export/png")
    assert png.status_code == 200, png.text
    assert png.headers["content-type"] == "image/png"
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    assert f'filename="{scan_id}.png"' in png.headers["content-disposition"]
    assert len(png.content) > 1000

    pdf = client.get(f"/api/scans/{scan_id}/export/pdf")
    assert pdf.status_code == 200, pdf.text
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.content[:5] == b"%PDF-", "not a PDF"
    assert f'filename="{scan_id}.pdf"' in pdf.headers["content-disposition"]
    assert len(pdf.content) > 1000


def test_exports_are_case_insensitive_and_unknown_formats_are_rejected(
    client: TestClient, completed_demo: dict[str, Any]
) -> None:
    scan_id = str(completed_demo["scan_id"])
    for fmt in ("PNG", "PDF", "GeoJSON", "KML"):
        response = client.get(f"/api/scans/{scan_id}/export/{fmt}")
        assert response.status_code == 200, (fmt, response.text)

    bad = client.get(f"/api/scans/{scan_id}/export/shapefile")
    assert bad.status_code == 400
    assert bad.json()["error"] == "BAD_EXPORT_FORMAT"
    assert set(bad.json()["detail"]["supported"]) == {"geojson", "kml", "json", "png", "pdf"}


def test_debug_layers_return_compact_summaries(
    client: TestClient, completed_demo: dict[str, Any]
) -> None:
    """API-009/EVD-005: statistics plus an optional grid, never the raster."""
    scan_id = str(completed_demo["scan_id"])
    targets = client.get(f"/api/scans/{scan_id}/targets").json()
    for layer in DEBUG_LAYERS:
        response = client.get(f"/api/debug/{scan_id}/{layer}")
        assert response.status_code == 200, (layer, response.text)
        body = response.json()
        assert body["scan_id"] == scan_id
        assert body["shape"]
        assert len(response.text) < 8000, (layer, len(response.text))
        if layer in ("components", "centroids"):
            assert body["kind"] == "table"
            assert body["columns"]
            assert body["rows"] == targets["count"]
        elif layer in _CORRELATION_COLUMNS:
            # Correlation layers are per-target rows built from the score
            # decomposition, never a raster and never a rendered overlay.
            assert body["kind"] == "table"
            assert body["source"] == "correlation"
            assert body["columns"] == list(_CORRELATION_COLUMNS[layer])
            assert body["rows"] <= targets["count"]
            assert body["notes"], "a correlation layer must state its provenance"
        else:
            assert body["kind"] == "array"
            assert body["stats"]["size"] == body["shape"][0] * body["shape"][1]
            assert body["stats"]["mean"] is not None

    mask = client.get(f"/api/debug/{scan_id}/detection_mask", params={"grid": 8}).json()
    assert mask["grid_size"] == 8
    assert len(mask["grid"]) == 8
    assert all(len(row) == 8 for row in mask["grid"])
    assert all(0.0 <= value <= 1.0 for row in mask["grid"] for value in row)

    landmask = client.get(f"/api/debug/{scan_id}/landmask").json()
    assert landmask["stats"]["true_count"] > 0
    assert landmask["source"] == "land"
    assert landmask["stats"]["finite_fraction"] == 1.0

    # The float layers state their NaN handling instead of hiding it.
    threshold = client.get(f"/api/debug/{scan_id}/cfar_threshold").json()
    assert any("non-finite" in note for note in threshold["notes"])
    assert threshold["stats"]["nan_count"] > 0

    assert client.get(f"/api/debug/{scan_id}/not-a-layer").status_code == 404
    assert client.get("/api/debug/DF-9999/raw").status_code == 404


def test_error_bodies_are_uniform(client: TestClient) -> None:
    missing = client.get("/api/scans/DF-9999").json()
    assert set(missing) >= {"error", "status", "message", "suggestions"}
    bad_export = client.get("/api/scans/DF-9999/export/kml")
    assert bad_export.status_code == 404
    assert bad_export.json()["error"] == "UNKNOWN_SCAN"