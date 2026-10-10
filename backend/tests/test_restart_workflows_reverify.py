"""Local operator-workflow restart and offline egress re-verification.

Uses fresh FastAPI lifespans and SQLite files under pytest's temporary data_dir.
No scan is created, forged, imported or transmitted. A corrupt JSON file is an
explicitly unusable source, never a substitute for satellite observations.
"""

from __future__ import annotations

import hashlib
import json
import socket
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import CfarSettings, Settings


def _client(directory: Path) -> TestClient:
    # Explicitly bound to the unique pytest directory, never user-level data/.
    return TestClient(create_app(Settings(
        data_dir=str(directory), api_host="127.0.0.1", log_level="WARNING",
    )))


def _ok(response: httpx.Response, status: int = 200) -> dict[str, Any]:
    assert response.status_code == status, response.text
    return response.json()


def _report(client: TestClient, case_id: str) -> dict[str, Any]:
    report = client.get(f"/api/investigation-reports/{case_id}/json")
    document = _ok(report)
    assert document["source_status"] == "NO_SCAN_LINKED"
    assert document["sensor_evidence"]["target_count"] is None
    assert document["sensor_evidence"]["targets"] == []
    assert document["warnings"] == ["NO_SCAN_LINKED"]
    canonical = json.dumps(
        {k: v for k, v in document.items() if k not in ("hash_algorithm", "content_sha256")},
        sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
    ).encode("utf-8")
    assert hashlib.sha256(canonical).hexdigest() == document["content_sha256"]
    assert report.headers["cache-control"] == "no-store"
    return document


@contextmanager
def _offline_attempts(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[tuple[str, str]]]:
    """Collect attempted public HTTP/socket egress and block before transport.

    In-process Starlette TestClient uses ASGITransport, so HTTPTransport guards
    observe production outbound HTTP only. The socket layer catches direct
    requests, urllib, and other network clients, including hostname resolution.
    The separate pytest suite-level guard remains installed as a second layer.
    """
    attempts: list[tuple[str, str]] = []
    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_create_connection = socket.create_connection

    def record(kind: str, dest: Any) -> None:
        attempts.append((kind, str(dest)))

    def _local(host: Any) -> bool:
        value = str(host).lower().strip("[]")
        return value in {"", "localhost", "localhost.localdomain", "::1"} or value.startswith("127.")

    def dns(host: Any, port: Any, *args: Any, **kwargs: Any) -> Any:
        if not _local(host):
            record("dns", host)
            raise AssertionError(f"offline DNS attempt to {host!r}")
        return real_getaddrinfo(host, port, *args, **kwargs)

    def connect(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if not _local(host):
            record("tcp", host)
            raise AssertionError(f"offline socket attempt to {host!r}")
        return real_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if not _local(host):
            record("tcp-ex", host)
            raise AssertionError(f"offline socket attempt to {host!r}")
        return real_connect_ex(self, address)

    def create_connection(address: Any, *args: Any, **kwargs: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if not _local(host):
            record("tcp-create", host)
            raise AssertionError(f"offline socket attempt to {host!r}")
        return real_create_connection(address, *args, **kwargs)

    def httpx_get(url: Any, *args: Any, **kwargs: Any) -> Any:
        record("httpx.get", url)
        raise httpx.ConnectError("Offline: outbound probe intercepted before transport")

    def httpx_post(url: Any, *args: Any, **kwargs: Any) -> Any:
        record("httpx.post", url)
        raise httpx.ConnectError("Offline: outbound probe intercepted before transport")

    def sync_http(self: httpx.HTTPTransport, request: httpx.Request) -> Any:
        record("httpx.transport", request.url)
        raise httpx.ConnectError("Offline: HTTP transport intercepted", request=request)

    async def async_http(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> Any:
        record("httpx.async_transport", request.url)
        raise httpx.ConnectError("Offline: async HTTP transport intercepted", request=request)

    with monkeypatch.context() as patch:
        patch.setattr(socket, "getaddrinfo", dns)
        patch.setattr(socket.socket, "connect", connect)
        patch.setattr(socket.socket, "connect_ex", connect_ex)
        patch.setattr(socket, "create_connection", create_connection)
        patch.setattr(httpx, "get", httpx_get)
        patch.setattr(httpx, "post", httpx_post)
        patch.setattr(httpx.HTTPTransport, "handle_request", sync_http)
        patch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_http)
        yield attempts


def test_operator_lifecycle_survives_two_restarts_without_sensor_fabrication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert not any(tmp_path.iterdir())
    shape = {"kind": "polyline", "coordinates": [[103.8, 1.25], [103.81, 1.25]]}
    with _offline_attempts(monkeypatch) as attempts:
        with _client(tmp_path) as first:
            case = _ok(first.post("/api/investigations", json={
                "title": "Operator questions without observation",
            }), 201)
            cid = case["id"]
            assert case["scan_id"] is None and case["aoi"] is None
            prefix = f"/api/investigations/{cid}"
            note = _ok(first.post(f"{prefix}/annotations", json={
                "content": "No verified satellite observation is linked.",
            }), 201)
            geometry = _ok(first.post(f"{prefix}/geometries", json={
                "label": "Provisional operator polyline", "geometry": shape,
                "notes": "Manual annotation, not measured SAR evidence",
            }), 201)
            gid = geometry["id"]
            assert geometry["provenance"] == "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE"
            assert geometry["measurements"]["length_m"] > 0
            assert _ok(first.put(f"{prefix}/geometries/{gid}", json={
                "label": "First-session revised path", "geometry": shape,
                "notes": "First revision before restart",
            }))["notes"] == "First revision before restart"

            snapshot = {
                "schema_version": 1, "workspace": "INTELLIGENCE",
                "map_source_id": "OSM", "investigation_id": cid,
                "layers": {"AIS_CONTACTS": {"visible": False, "opacity": 0.7}},
                "playback_speed": 1,
            }
            view = _ok(first.post("/api/views", json={
                "title": "Investigation workspace", "snapshot": snapshot,
            }), 201)
            vid = view["id"]
            assert view["missing_resources"] == [] and view["revision"] == 1
            assert _ok(first.put(f"/api/views/{vid}", json={
                "title": "First-session saved workspace",
                "snapshot": snapshot, "expected_revision": 1,
            }))["revision"] == 2

            mission = _ok(first.post("/api/missions", json={
                "title": "Operator area", "aoi": [103.7, 1.1, 104.0, 1.5],
                "status": "PLANNED",
            }), 201)
            mid = mission["id"]
            assert mission["scan_ids"] == mission["rules"] == mission["alerts"] == []
            assert _ok(first.put(f"/api/missions/{mid}", json={
                "title": "First-session revised operator area",
                "aoi": [103.7, 1.1, 104.0, 1.5], "status": "PLANNED",
            }))["title"] == "First-session revised operator area"
            assert first.post(f"{prefix}/watchlist", json={"target_id": "DF-NOT-OBSERVED"}).status_code == 409
            assert first.post(f"{prefix}/annotations", json={
                "content": "No source", "target_id": "DF-NOT-OBSERVED",
            }).status_code == 409
            assert first.post(f"/api/missions/{mid}/scans", json={
                "scan_id": "DF-NOT-OBSERVED",
            }).status_code == 404
            assert first.post(f"/api/missions/{mid}/rules", json={
                "investigation_id": cid, "target_id": "DF-NOT-OBSERVED",
                "minimum_sar_confidence": 0.8,
            }).status_code == 409
            assert first.post(f"/api/missions/{mid}/evaluate").status_code == 409
            assert _report(first, cid)["operator_material"]["annotations"][0]["id"] == note["id"]
            analysis = _ok(first.post(f"/api/analyst/cases/{cid}/analyze", json={
                "intent": "SUMMARY",
            }))
            assert analysis["source_status"] == "NO_SCAN_LINKED"
            assert all(c["classification"] == "OPERATOR_RECORD" for c in analysis["claims"])
            assert _ok(first.get("/api/analyst/cases"))["total"] == 1

        # A closed TestClient and entirely newly built app/lifespan reuse only SQLite.
        with _client(tmp_path) as second:
            persisted = _ok(second.get(prefix))
            assert persisted["annotations"][0]["id"] == note["id"]
            assert persisted["annotations"][0]["content"] == note["content"]
            assert len(_ok(second.get(f"{prefix}/geometries"))["geometries"]) == 1
            assert _ok(second.get(f"{prefix}/geometries/{gid}"))["notes"] == "First revision before restart"
            saved_before_update = _ok(second.get(f"/api/views/{vid}"))
            assert saved_before_update["snapshot"]["investigation_id"] == cid
            assert saved_before_update["revision"] == 2
            mission_before_update = _ok(second.get(f"/api/missions/{mid}"))
            assert mission_before_update["status"] == "PLANNED"
            assert mission_before_update["title"] == "First-session revised operator area"
            assert _report(second, cid)["operator_material"]["annotations"][0]["id"] == note["id"]

            changed = _ok(second.put(f"{prefix}/geometries/{gid}", json={
                "label": "Updated operator path", "geometry": shape, "notes": "Reviewed manually",
            }))
            assert changed["label"] == "Updated operator path"
            updated_view = _ok(second.put(f"/api/views/{vid}", json={
                "title": "Revised workspace", "snapshot": {
                    **snapshot, "workspace": "REPORTS", "map_source_id": "ESRI",
                },
                "expected_revision": 2,
            }))
            assert updated_view["revision"] == 3
            assert second.put(f"/api/views/{vid}", json={
                "title": "Overwriting stale view", "snapshot": snapshot, "expected_revision": 2,
            }).status_code == 409
            assert _ok(second.put(f"/api/missions/{mid}", json={
                "title": "Area review active", "aoi": [103.7, 1.1, 104.0, 1.5],
                "status": "ACTIVE",
            }))["status"] == "ACTIVE"
            evaluated = _ok(second.post(f"/api/missions/{mid}/evaluate"))
            assert evaluated["evaluations"] == []
            assert evaluated["alerts_created"] == evaluated["existing_alerts"] == 0
            assert second.post(f"/api/missions/{mid}/alerts/not-real/ack").status_code == 404
            assert second.delete(f"{prefix}/annotations/{note['id']}").status_code == 204
            fresh_note = _ok(second.post(f"{prefix}/annotations", json={
                "content": "Second session, still no source",
            }), 201)
            assert fresh_note["id"] != note["id"]
            assert _report(second, cid)["operator_material"]["annotations"][0]["id"] == fresh_note["id"]

        with _client(tmp_path) as third:
            assert _ok(third.get(f"{prefix}/geometries/{gid}"))["notes"] == "Reviewed manually"
            saved = _ok(third.get(f"/api/views/{vid}"))
            assert saved["revision"] == 3
            assert saved["snapshot"]["map_source_id"] == "ESRI"
            assert saved["snapshot"]["workspace"] == "REPORTS"
            mission = _ok(third.get(f"/api/missions/{mid}"))
            assert mission["title"] == "Area review active"
            assert mission["status"] == "ACTIVE"
            assert mission["alerts"] == mission["rules"] == []
            assert _ok(third.get(prefix))["annotations"][0]["id"] == fresh_note["id"]
            assert _ok(third.get("/api/investigations"))["investigations"][0]["id"] == cid
            assert _report(third, cid)["operator_material"]["annotations"][0]["id"] == fresh_note["id"]
            pdf = third.get(f"/api/investigation-reports/{cid}/pdf")
            assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")

            assert third.delete(f"{prefix}/geometries/{gid}").status_code == 204
            assert third.delete(f"/api/missions/{mid}").status_code == 204
            assert third.delete(prefix).status_code == 204
            # The saved snapshot remains, with a truthful dangling-case status.
            after_delete = _ok(third.get(f"/api/views/{vid}"))
            assert after_delete["missing_resources"] == ["INVESTIGATION_MISSING"]
            assert third.delete(f"/api/views/{vid}").status_code == 204

        with _client(tmp_path) as fourth:
            assert _ok(fourth.get("/api/investigations"))["investigations"] == []
            assert _ok(fourth.get("/api/missions"))["missions"] == []
            assert _ok(fourth.get("/api/views"))["views"] == []
            assert fourth.get(f"/api/investigation-reports/{cid}/json").status_code == 404
            assert fourth.get(f"/api/missions/{mid}").status_code == 404
            assert fourth.get(f"/api/views/{vid}").status_code == 404
        assert attempts == [], f"unexpected backend egress: {attempts}"
    assert not (tmp_path / "scans").exists(), "workflow must not invent sensor scans"
    assert (tmp_path / "investigations.sqlite3").is_file()
    assert (tmp_path / "missions.sqlite3").is_file()


def test_corrupt_scan_and_saved_view_remain_explicit_after_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _offline_attempts(monkeypatch) as attempts:
        with _client(tmp_path) as first:
            cid = _ok(first.post("/api/investigations", json={"title": "Unlinked operator log"}), 201)["id"]
            vid = _ok(first.post("/api/views", json={
                "title": "Operator bookmark",
                "snapshot": {"workspace": "TACTICAL", "investigation_id": cid},
            }), 201)["id"]
        # Explicitly corrupt one operator record and create only invalid JSON
        # under scans: never label this file REAL or create an observed target.
        scans_dir = tmp_path / "scans"
        scans_dir.mkdir(exist_ok=True)
        (scans_dir / "INVALID-SOURCE.json").write_bytes(b"{not-json")
        with sqlite3.connect(tmp_path / "investigations.sqlite3") as db:
            db.execute("UPDATE saved_views SET state_json=? WHERE id=?", ("{not-json", vid))
        with _client(tmp_path) as second:
            view = _ok(second.get(f"/api/views/{vid}"))
            assert view["status"] == "CORRUPT"
            assert view["snapshot"] is None
            assert view["missing_resources"] == ["INVALID_VIEW_RECORD"]
            assert second.post("/api/investigations", json={
                "title": "Must refuse corrupt source", "scan_id": "INVALID-SOURCE",
            }).status_code == 404
            assert second.post("/api/missions", json={
                "title": "No trusted scan", "aoi": [100, 1, 101, 2],
            }).status_code == 201
            mission_id = _ok(second.get("/api/missions"))["missions"][0]["id"]
            assert second.post(f"/api/missions/{mission_id}/scans", json={
                "scan_id": "INVALID-SOURCE",
            }).status_code == 404
            assert _report(second, cid)["source_status"] == "NO_SCAN_LINKED"
        with _client(tmp_path) as third:
            assert _ok(third.get(f"/api/views/{vid}"))["status"] == "CORRUPT"
            assert third.get(f"/api/investigation-reports/{cid}/json").status_code == 200
            assert third.delete(f"/api/views/{vid}").status_code == 204
            assert third.delete(f"/api/missions/{mission_id}").status_code == 204
            assert third.delete(f"/api/investigations/{cid}").status_code == 204
        assert attempts == []


def test_provider_health_declares_attempts_but_transmits_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Actual provider-health path, with outbound HTTP stopped before transport.

    UNAVAILABLE is the correct result for intercepted probes, not AVAILABLE.
    This establishes attempted endpoints only, never real provider uptime.
    """
    with _offline_attempts(monkeypatch) as attempts:
        with _client(tmp_path) as client:
            data = _ok(client.get("/api/providers/health"))
            assert data["runtime_mode"] == "REAL"
            providers = {p["provider"]: p for p in data["providers"]}
            assert {"planetary-computer", "earthsearch", "cdse", "ais-local"} <= providers.keys()
            assert providers["planetary-computer"]["status"] == "UNAVAILABLE"
            assert providers["earthsearch"]["status"] == "UNAVAILABLE"
            assert providers["cdse"]["status"] != "AVAILABLE"
            assert providers["ais-local"]["status"] == "NOT_CONFIGURED"
        network_targets = [(kind, str(url)) for kind, url in attempts]
        assert network_targets, "provider-health stopped attempting declared remote probes"
        assert len(network_targets) == 3, network_targets
        assert all(kind.startswith("httpx.") for kind, _ in network_targets), network_targets
        hostnames = {urlsplit(url).hostname for _, url in network_targets}
        assert "planetarycomputer.microsoft.com" in hostnames
        assert "earth-search.aws.element84.com" in hostnames
        assert "stac.dataspace.copernicus.eu" in hostnames
        assert not (tmp_path / "scans").exists(), "health probes cannot create scan evidence"


def test_network_instrumentation_blocks_before_hostname_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _offline_attempts(monkeypatch) as attempts:
        with pytest.raises(AssertionError, match="offline DNS attempt"):
            socket.getaddrinfo("blocked.invalid", 443)
        assert attempts == [("dns", "blocked.invalid")]


def test_runtime_settings_are_explicit_across_restarts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Configuration is injected per process, not written as operator prefs."""
    first_config = Settings(
        data_dir=str(tmp_path), log_level="WARNING", api_host="127.0.0.1",
        cfar=CfarSettings(threshold_factor=3.25),
    )
    second_config = Settings(
        data_dir=str(tmp_path), log_level="WARNING", api_host="127.0.0.1",
        cfar=CfarSettings(threshold_factor=4.25),
    )
    with _offline_attempts(monkeypatch) as attempts:
        with TestClient(create_app(first_config)) as first:
            assert first.app.state.darkfleet_state.settings.cfar.threshold_factor == 3.25
            cid = _ok(first.post("/api/investigations", json={
                "title": "Independent of processing configuration",
            }), 201)["id"]
        with TestClient(create_app(second_config)) as second:
            assert second.app.state.darkfleet_state.settings.cfar.threshold_factor == 4.25
            assert _ok(second.get(f"/api/investigations/{cid}"))["id"] == cid
        with TestClient(create_app(first_config)) as third:
            assert third.app.state.darkfleet_state.settings.cfar.threshold_factor == 3.25
            assert _ok(third.get(f"/api/investigations/{cid}"))["title"] == (
                "Independent of processing configuration"
            )
        assert attempts == []
