"""CP7 gate: the HTTP API end to end (API-001..012, TST-007).

Every test runs against a temporary ``data_dir`` and a stubbed network, so the
suite can never touch a real ``data/`` directory or a live provider. Scans run
the PRODUCTION pipeline over the checked-in fixture COG (see
:mod:`tests.fixture_source`): only the network is replaced, never the detection.
What is proved here:

* a REAL scan walks all 14 pipeline stages, persists, and answers every read
  endpoint with ``runtime_mode=REAL`` / ``synthetic=false`` and real provenance;
* a completed scan is readable from a *fresh* app without rerunning anything;
* provider health comes from real probes, and no credential leaves the process;
* a provider that cannot serve the request is an explicit error and the scan
  writes NOTHING -- there is no substitute world to fall back to;
* SSE replays the real stage sequence and terminates on the terminal stage;
* bbox validation is Pydantic's job (422);
* geojson/kml/json export carries provenance; png/pdf are rendered server side;
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

from darkfleet import pipeline
from darkfleet.api.app import create_app
from darkfleet.api.routes import _CORRELATION_COLUMNS, DEBUG_LAYERS
from darkfleet.config.settings import Settings
from darkfleet.jobs.models import PIPELINE, ScanStage
from darkfleet.providers import ProviderStatus, RealDataUnavailableError
from tests import fixture_source

#: The AOI the fixture COG covers. It is what a scan must be asked for.
AOI = fixture_source.FIXTURE_BBOX
STAGES = [stage.value for stage in PIPELINE]

#: What this AOI really yields: three surface returns, no AIS coverage.
EXPECTED_COUNTS = {"STATIONARY_OR_INFRASTRUCTURE": 3, "ais_only": 0}

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


@pytest.fixture(scope="module", autouse=True)
def offline_pipeline() -> Iterator[None]:
    """Point the pipeline at the fixture COG for every test in this module.

    The app calls ``run_scan`` directly, so the same three injection points the
    pipeline tests use are all that is needed: the asset resolves to a real file
    on disk and every downstream stage is the production one.
    """
    with pytest.MonkeyPatch.context() as monkeypatch:
        fixture_source.install(monkeypatch)
        yield


@pytest.fixture(scope="module")
def api_settings(tmp_path_factory: pytest.TempPathFactory) -> Settings:
    data_dir = tmp_path_factory.mktemp("darkfleet-data")
    settings = Settings(data_dir=str(data_dir))
    settings.log_level = "WARNING"
    settings.cdse.client_secret = SECRETS[0]
    settings.ais.aistream_api_key = SECRETS[1]
    settings.ais.gfw_api_token = SECRETS[2]
    return settings


@pytest.fixture(scope="module")
def client(api_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(api_settings)) as test_client:
        yield test_client


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


def _start_scan(client: TestClient, bbox: list[float] | None = None) -> str:
    response = client.post(
        "/api/scans",
        json={"bbox": bbox or AOI},
    )
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    assert body["status"] == ScanStage.QUEUED.value
    assert body["runtime_mode"] == "REAL"
    assert body["synthetic"] is False
    assert re.fullmatch(r"DF-\d{4}", body["scan_id"])
    return str(body["scan_id"])


@pytest.fixture(scope="module")
def completed_scan(client: TestClient) -> dict[str, Any]:
    """One completed REAL scan, shared by the read-only assertions."""
    return _await_terminal(client, _start_scan(client))


# --------------------------------------------------------------------- tests


def test_scan_completes_and_every_read_endpoint_reports_real_data(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """API-001/002/003: queue -> COMPLETE -> targets -> evidence, all REAL."""
    scan_id = str(completed_scan["scan_id"])
    assert completed_scan["stage"] == ScanStage.COMPLETE.value, completed_scan.get("error")
    assert completed_scan["runtime_mode"] == "REAL"
    assert completed_scan["synthetic"] is False
    assert [event["stage"] for event in completed_scan["history"]] == STAGES
    assert completed_scan["record_persisted"] is True

    targets_response = client.get(f"/api/scans/{scan_id}/targets")
    assert targets_response.status_code == 200, targets_response.text
    targets_body = targets_response.json()
    assert targets_body["count"] == 3
    assert targets_body["counts"] == EXPECTED_COUNTS
    assert targets_body["runtime_mode"] == "REAL"
    assert targets_body["synthetic"] is False
    assert targets_body["provenance"]["synthetic"] is False
    assert targets_body["provenance"]["runtime_mode"] == "REAL"
    # Real provenance: the item id, platform and acquisition time of the asset
    # that was actually read.
    assert targets_body["provenance"]["sar"]["provider"] == "planetary-computer"
    assert targets_body["provenance"]["sar"]["item_id"] == "S1A_FIXTURE_20240101T000000"
    assert targets_body["provenance"]["sar"]["platform"] == "sentinel-1a"
    assert targets_body["acquisition_time"] == "2024-01-01T00:00:00.000000Z"
    assert targets_body["scene"]["crs"] == "EPSG:32648"

    target_id = str(targets_body["targets"][0]["id"])

    evidence = client.get(f"/api/evidence/{target_id}", params={"scan_id": scan_id})
    assert evidence.status_code == 200, evidence.text
    evidence_body = evidence.json()
    assert evidence_body["scan_id"] == scan_id
    assert evidence_body["synthetic"] is False
    assert evidence_body["evidence"]["provenance"]["synthetic"] is False
    assert evidence_body["evidence"]["targets"]
    assert evidence_body["evidence"]["config"]["config_hash"]

    slice_response = client.get(f"/api/targets/{target_id}", params={"scan_id": scan_id})
    assert slice_response.status_code == 200, slice_response.text
    slice_body = slice_response.json()
    assert slice_body["evidence"]["target_id"] == target_id
    assert slice_body["evidence"]["uncertainty"]["propagation_note"]
    assert slice_body["evidence"]["observed"]["position"]["lat"] is not None
    assert slice_body["synthetic"] is False


def test_completed_scan_survives_a_fresh_app_without_rerunning(
    api_settings: Settings, completed_scan: dict[str, Any]
) -> None:
    """The run store, not process memory, is what makes a scan readable."""
    scan_id = str(completed_scan["scan_id"])
    with TestClient(create_app(api_settings)) as fresh:
        state = fresh.get(f"/api/scans/{scan_id}")
        assert state.status_code == 200, state.text
        body = state.json()
        assert body["stage"] == ScanStage.COMPLETE.value
        assert body["record_persisted"] is True
        again = fresh.get(f"/api/scans/{scan_id}/targets")
        assert again.status_code == 200
        assert again.json()["count"] == 3


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


def test_scan_with_unknown_provider_is_explicit_and_reports_no_data(
    client: TestClient, net: FakeNetwork
) -> None:
    """API-012: a bad REAL request is a 400 with a status, and no data at all."""
    net.reset()
    response = client.post(
        "/api/scans",
        json={
            "bbox": AOI,
            "provider": "totally-unknown-provider",
            "product": "rtc",
        },
    )
    assert response.status_code == 400, response.text
    body = response.json()
    assert body["status"] == ProviderStatus.NOT_CONFIGURED.value
    assert body["error"] == "UNKNOWN_PROVIDER"
    assert body["provider"] == "totally-unknown-provider"
    # An error body never claims a world: not even a "synthetic: false" one.
    assert body.get("synthetic") is None
    assert body.get("runtime_mode") is None
    assert "DEMO" not in response.text
    assert "demo-synthesizer" not in response.text
    assert "targets" not in body
    # Rejected before anything was contacted or queued.
    assert net.calls == []


def test_provider_failure_surfaces_as_503_with_status(
    client: TestClient, net: FakeNetwork
) -> None:
    """An unauthenticated provider is AUTH_REQUIRED/503, not a fallback."""
    net.reset()
    net.search_status = 401
    try:
        response = client.get(
            "/api/scenes",
            params={
                "provider": "planetary-computer",
                "bbox": ",".join(str(value) for value in AOI),
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


def test_scene_search_returns_only_real_scenes(client: TestClient, net: FakeNetwork) -> None:
    net.reset()
    response = client.get(
        "/api/scenes",
        params={
            "provider": "planetary-computer",
            "bbox": ",".join(str(value) for value in AOI),
            "datetime": "2026-09-01T00:00:00Z/2026-09-30T00:00:00Z",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtime_mode"] == "REAL"
    assert body["synthetic"] is False
    assert body["scenes"], body
    for scene in body["scenes"]:
        assert scene["runtime_mode"] == "REAL"
        assert scene["synthetic"] is False
        assert scene["provider"] != "demo-synthesizer"
        assert scene["id"].startswith("S1A")


def test_an_aoi_the_provider_cannot_serve_is_refused_not_substituted(
    client: TestClient, net: FakeNetwork
) -> None:
    """No coverage means no scan. There is nothing to fall back to."""
    net.reset()
    net.search_features = []
    try:
        response = client.post("/api/scans", json={"bbox": [56.30, 26.40, 56.90, 26.90]})
        assert response.status_code == 404, response.text
        body = response.json()
        assert body["error"] == "NO_SCENE_COVERAGE"
        assert body["scan_id"] is None
        assert "demo-synthesizer" not in response.text
    finally:
        net.search_features = _features()


def test_a_failed_scan_persists_nothing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A scan whose provider cannot serve the AOI ends FAILED with zero data.

    This is the guarantee the old DEMO/REAL isolation made weaker: when the
    provider fails there is no synthetic world to hand back, so the answer is
    nothing at all -- not a record, not targets, not an export.
    """
    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise RealDataUnavailableError(
            "Planetary Computer returned no asset for the requested extent.",
            details={"provider": "planetary-computer"},
        )

    monkeypatch.setattr(pipeline, "_resolve_asset", refuse)

    response = client.post("/api/scans", json={"bbox": AOI, "provider": "planetary-computer"})
    assert response.status_code == 202, response.text
    scan_id = str(response.json()["scan_id"])
    state = _await_terminal(client, scan_id)
    assert state["stage"] == ScanStage.FAILED.value
    assert state["synthetic"] is False
    assert state["runtime_mode"] == "REAL"
    # The runner names the stage that was in flight: SEARCHING_SCENE reported,
    # so its successor READING_SAR is where the work aborted.
    assert state["failed_at"] == ScanStage.READING_SAR.value
    assert state["record_persisted"] is False
    assert state["error"]
    assert client.get(f"/api/scans/{scan_id}/targets").status_code == 404
    assert client.get(f"/api/scans/{scan_id}/export/geojson").status_code == 404
    for secret in SECRETS:
        assert secret not in json.dumps(state)


def test_sse_streams_the_real_stage_sequence_and_terminates(client: TestClient) -> None:
    """API-004: subscribe() is replayed live and closed on the terminal event."""
    scan_id = _start_scan(client)
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
        "/api/scans", json={"bbox": AOI, "synthetic": True}
    ).status_code == 422
    assert client.post(
        "/api/scans", json={"bbox": AOI, "runtime_mode": "DEMO"}
    ).status_code == 422


def test_exports_carry_provenance(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """API-010: three real formats, provenance in each; png/pdf are rendered."""
    scan_id = str(completed_scan["scan_id"])
    targets = client.get(f"/api/scans/{scan_id}/targets").json()

    geojson = client.get(f"/api/scans/{scan_id}/export/geojson")
    assert geojson.status_code == 200, geojson.text
    assert geojson.headers["content-type"].startswith("application/geo+json")
    assert "attachment" in geojson.headers["content-disposition"]
    geo = geojson.json()
    assert geo["type"] == "FeatureCollection"
    assert geo["synthetic"] is False
    assert geo["runtime_mode"] == "REAL"
    assert len(geo["features"]) == targets["count"]
    assert geo["provenance"]["sar"]["item_id"] == "S1A_FIXTURE_20240101T000000"
    assert geo["provenance"]["processing"]["config_hash"]
    first = geo["features"][0]
    lon, lat = first["geometry"]["coordinates"]
    assert lon == pytest.approx(targets["targets"][0]["lon"], abs=1e-9)
    assert lat == pytest.approx(targets["targets"][0]["lat"], abs=1e-9)
    assert first["properties"]["scan_id"] == scan_id
    assert first["properties"]["synthetic"] is False

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
    assert document["synthetic"] is False
    assert document["provenance"]["classification_schema"]
    assert len(document["targets"]) == targets["count"]


def test_png_and_pdf_exports_are_rendered_server_side(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """EXP-004/005: a real PNG and a real PDF, rendered from the record.

    CP12 wrote the renderers but left the route answering 501. This asserts the
    artefact is actually produced, carries the correct magic bytes, and is
    rendered from the stored raster -- a browser screenshot would satisfy none
    of these.
    """
    scan_id = str(completed_scan["scan_id"])
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
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    scan_id = str(completed_scan["scan_id"])
    for fmt in ("PNG", "PDF", "GeoJSON", "KML"):
        response = client.get(f"/api/scans/{scan_id}/export/{fmt}")
        assert response.status_code == 200, (fmt, response.text)

    bad = client.get(f"/api/scans/{scan_id}/export/shapefile")
    assert bad.status_code == 400
    assert bad.json()["error"] == "BAD_EXPORT_FORMAT"
    assert set(bad.json()["detail"]["supported"]) == {"geojson", "kml", "json", "png", "pdf"}


def test_debug_layers_return_compact_summaries(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """API-009/EVD-005: statistics plus an optional grid, never the raster."""
    scan_id = str(completed_scan["scan_id"])
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
    assert landmask["source"] == "land"
    assert landmask["stats"]["finite_fraction"] == 1.0
    # The layer covers the whole measured window, unshrunk.
    assert landmask["stats"]["size"] == 400 * 400
    # The aligned, authoritative ESA WorldCover source excludes real coastal
    # pixels. The old disjoint mask silently treated unknown coverage as water
    # and reported zero exclusions for a raster it did not cover at all.
    # The fixed checked-in clip measures 14,789 excluded pixels at this AOI.
    assert landmask["stats"]["true_count"] == 14789
    # The layer is not a stub: the production reprojection of the WorldCover
    # clip ran, and the evidence record names the dataset it used.
    provenance = client.get(f"/api/scans/{scan_id}/targets").json()["provenance"]
    land_prov = provenance["processing"]["land_mask"]
    assert land_prov["source"] == "ESA WorldCover v200 2021 (10 m, EPSG:4326)"
    assert land_prov["coastline_buffer_m"] == 150
    assert land_prov["water_class"] == 80

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
