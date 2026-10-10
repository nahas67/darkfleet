"""Offline watch/alert acceptance: source-boundary and adverse event ordering.

This suite does NOT forge a completed live scan. The checked-in EPSG:32648
GeoTIFF is a TEST FIXTURE and its metadata is not authenticated Sentinel-1
provenance, even if the canonical pipeline emits internal REAL fields.
"""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.mission_alerts import evaluate_sar_watch
from darkfleet.pipeline import run_scan
from darkfleet.storage.runs import RunRecordError, run_store_for_data_dir
from tests import fixture_source


def _app(root: Path):
    return create_app(Settings(data_dir=str(root), log_level="WARNING"))


def _ok(response, code: int = 200) -> dict:
    assert response.status_code == code, response.text
    return response.json()


def _measured_unverified_fixture(
    root: Path, monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, dict]:
    """Exercise the canonical numeric pipeline, without asserting live source truth."""
    fixture_source.install(monkeypatch)
    output = run_scan(
        bbox=fixture_source.FIXTURE_BBOX,
        data_dir=str(root),
        window_source=fixture_source.fixture_window_source(),
    )
    assert output["targets"]
    assert output["provenance"]["sar"]["item_id"] == "S1A_FIXTURE_20240101T000000"
    assert output["synthetic"] is False  # internal mode; NOT an external attestation
    # Explicitly label the SOURCE as a fixture before any storage attempt.
    unverified = {
        **output,
        "stage": "COMPLETE",
        "runtime_mode": "TEST_FIXTURE_UNVERIFIED",
        "synthetic": True,
    }
    return output["scan_id"], unverified


def test_unverified_recorded_fixture_cannot_trigger_persisted_live_watch_alert(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    scan_id, unverified = _measured_unverified_fixture(tmp_path, monkeypatch)
    target = unverified["targets"][0]
    before = evaluate_sar_watch(scan_id, unverified, target["id"], 0)
    assert before.status == "NOT_EVALUATED"
    assert before.reason == "PERSISTED_REAL_SCAN_UNAVAILABLE"
    assert before.evidence is None
    with pytest.raises(RunRecordError):
        run_store_for_data_dir(tmp_path).save(unverified)
    assert run_store_for_data_dir(tmp_path).get(scan_id) is None

    # Actual FastAPI + SQLite operator boundaries: never link this test fixture
    # as authenticated production SAR evidence or create a test-sourced alert.
    with TestClient(_app(tmp_path)) as client:
        mission = _ok(client.post("/api/missions", json={
            "title": "Offline TEST FIXTURE source gate",
            "aoi": fixture_source.FIXTURE_BBOX,
            "status": "ACTIVE",
        }), 201)
        mid = mission["id"]
        assert _ok(client.post(f"/api/missions/{mid}/scans", json={
            "scan_id": scan_id,
        }), 404)["error"] == "UNKNOWN_SCAN"
        no_case = client.post("/api/investigations", json={
            "title": "No verified source", "scan_id": scan_id,
        })
        assert no_case.status_code in (404, 409), no_case.text
        empty = _ok(client.post(f"/api/missions/{mid}/evaluate"))
        assert empty["alerts_created"] == 0
        assert empty["existing_alerts"] == 0
        assert empty["evaluations"] == []
        assert _ok(client.post(f"/api/missions/{mid}/alerts/not-an-alert/ack"), 404)[
            "error"
        ] == "UNKNOWN_ALERT"
        assert _ok(client.get(f"/api/missions/{mid}"))["alerts"] == []

    with TestClient(_app(tmp_path)) as client:
        saved = _ok(client.get(f"/api/missions/{mid}"))
        assert saved["scan_ids"] == saved["alerts"] == saved["rules"] == []
        assert _ok(client.post(f"/api/missions/{mid}/evaluate"))["alerts_created"] == 0
    with sqlite3.connect(tmp_path / "missions.sqlite3") as db:
        assert db.execute("SELECT COUNT(*) FROM mission_alerts").fetchone()[0] == 0


def test_out_of_order_local_evaluate_and_ack_without_authorized_source_never_alerts(
    tmp_path: Path,
) -> None:
    """Concurrent bad/out-of-order events must not manufacture an alert."""
    with TestClient(_app(tmp_path)) as client:
        mission = _ok(client.post("/api/missions", json={
            "title": "No authenticated source",
            "aoi": [104, 1, 105, 2],
            "status": "ACTIVE",
        }), 201)
        mid = mission["id"]

    def action(kind: str) -> tuple[str, int, dict]:
        with TestClient(_app(tmp_path)) as client:
            route = (f"/api/missions/{mid}/evaluate" if kind == "evaluate"
                     else f"/api/missions/{mid}/alerts/out-of-order/ack")
            reply = client.post(route)
            return kind, reply.status_code, reply.json()

    kinds = ["ack", "evaluate", "ack", "evaluate", "evaluate", "ack"]
    with ThreadPoolExecutor(max_workers=6) as pool:
        result = list(pool.map(action, kinds))
    for kind, code, body in result:
        if kind == "evaluate":
            assert code == 200 and body["alerts_created"] == 0
            assert body["existing_alerts"] == 0 and body["evaluations"] == []
        else:
            assert code == 404 and body["error"] == "UNKNOWN_ALERT"
    with TestClient(_app(tmp_path)) as client:
        assert _ok(client.get(f"/api/missions/{mid}"))["alerts"] == []
    with sqlite3.connect(tmp_path / "missions.sqlite3") as db:
        assert db.execute("SELECT COUNT(*) FROM mission_alerts").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM mission_evaluations").fetchone()[0] == 0


def test_contaminated_upstream_scene_identifier_is_not_echoed_in_unit_finding() -> None:
    """Pure evaluator test double, not an authenticated or persisted scan."""
    canary = "WATCH_BEARER_SECRET_DO_NOT_EXPOSE"
    test_double = {
        "scan_id": "TEST_DOUBLE_ONLY", "runtime_mode": "REAL", "synthetic": False,
        "stage": "COMPLETE",
        "targets": [{"id": "TEST-TARGET", "sarConf": 0.9, "cls": "SAR_UNMATCHED"}],
        "scene": {
            "item_id": f"S1A_FIXTURE Authorization: Bearer {canary}",
            "acquisition_time": "2024-01-01T00:00:00Z",
        },
    }
    triggered = evaluate_sar_watch("TEST_DOUBLE_ONLY", test_double, "TEST-TARGET", 0.8)
    assert triggered.status == "TRIGGERED"
    assert triggered.evidence is not None
    assert triggered.evidence["scene_item_id"] is None
    assert canary not in triggered.model_dump_json()
    # This controlled object is not a source-backed run; no store/API use.
    repeated = evaluate_sar_watch("TEST_DOUBLE_ONLY", test_double, "TEST-TARGET", 0.8)
    assert repeated.evidence_fingerprint == triggered.evidence_fingerprint
    assert evaluate_sar_watch("TEST_DOUBLE_ONLY", test_double, "TEST-TARGET", 0.95).status == (
        "BELOW_THRESHOLD"
    )
    missing = {**test_double, "targets": []}
    finding = evaluate_sar_watch("TEST_DOUBLE_ONLY", missing, "TEST-TARGET", 0)
    assert finding.status == "NOT_EVALUATED"
    assert finding.reason == "WATCHED_TARGET_NOT_UNIQUELY_PRESENT"

