"""DF-X18 missions: real RunStore authority, deterministic alert idempotency and restart."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
from pytest import approx

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.mission_alerts import evaluate_sar_watch
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _app(root: Path):
    return create_app(Settings(data_dir=str(root), log_level="WARNING"))


def _seed(root: Path, scan_id: str = "REAL-001", *, confidence: float | None = 0.92):
    target = {"id": "DF-001", "cls": "SAR_UNMATCHED"}
    if confidence is not None:
        target["sarConf"] = confidence
    store = run_store_for_data_dir(root)
    store.save(mark_synthetic({
        "scan_id": scan_id, "stage": "COMPLETE",
        "created_at": "2026-09-18T12:00:00Z",
        "aoi": [103, 1, 104, 2],
        "scene": {
            "item_id": "S1-REAL-ITEM",
            "acquisition_time": "2026-09-18T11:00:00Z",
            "asset_url": "https://private.example?token=TOP_SECRET",
        },
        "provenance": {"processing_version": "algorithm-1", "token": "SECRET"},
        "targets": [target, {"id": "DF-002", "sarConf": 0.2}],
    }))
    return root / "scans" / f"{scan_id}.json"


def test_watch_evidence_does_not_echo_secret_query_or_native_path(tmp_path: Path):
    source = _seed(tmp_path)
    record = run_store_for_data_dir(tmp_path).get("REAL-001")
    assert record is not None
    record["scene"]["item_id"] = "SCENE?token=INTERNAL_SECRET"
    record["scene"]["acquisition_time"] = "C:\\private\\metadata.txt"
    record["created_at"] = "2026-09-18?signature=INTERNAL_SECRET"
    run_store_for_data_dir(tmp_path).save(record)
    finding = evaluate_sar_watch("REAL-001", record, "DF-001", 0.8)
    assert finding.status == "TRIGGERED"
    assert finding.evidence is not None
    assert finding.evidence["scene_item_id"] is None
    assert finding.evidence["acquisition_time"] is None
    assert finding.evidence["scan_created_at"] is None
    assert "INTERNAL_SECRET" not in finding.model_dump_json()
    assert source.exists()


def _mission(client: TestClient, *, status: str = "ACTIVE") -> dict:
    response = client.post("/api/missions", json={
        "title": "Operator-defined coastal watch",
        "aoi": [103.0, 1.0, 104.0, 2.0],
        "status": status,
    })
    assert response.status_code == 201, response.text
    return response.json()


def _rule(client: TestClient, mission_id: str, scan_id: str = "REAL-001",
          *, threshold: float = 0.8, target_id: str = "DF-001") -> dict:
    case = client.post("/api/investigations", json={
        "title": "Ground-truth review", "scan_id": scan_id,
    })
    assert case.status_code == 201, case.text
    case_id = case.json()["id"]
    assert client.post(f"/api/investigations/{case_id}/watchlist",
                       json={"target_id": target_id}).status_code == 201
    linked = client.post(f"/api/missions/{mission_id}/scans", json={"scan_id": scan_id})
    assert linked.status_code == 200, linked.text
    created = client.post(f"/api/missions/{mission_id}/rules", json={
        "investigation_id": case_id, "target_id": target_id,
        "minimum_sar_confidence": threshold,
    })
    assert created.status_code == 201, created.text
    return created.json()


def test_mission_alert_creation_restart_rerun_ack_idempotent_and_evidence_immutable(tmp_path: Path):
    source = _seed(tmp_path)
    source_bytes = source.read_bytes()
    with TestClient(_app(tmp_path)) as client:
        mission = _mission(client)
        mid = mission["id"]
        assert mission["scan_ids"] == mission["rules"] == mission["alerts"] == []
        rule = _rule(client, mid)
        assert rule["scan_id"] == "REAL-001"
        assert rule["minimum_sar_confidence"] == 0.8
        assert rule["kind"] == "WATCHED_TARGET_SAR_CONFIDENCE"
        first = client.post(f"/api/missions/{mid}/evaluate")
        assert first.status_code == 200, first.text
        evaluated = first.json()
        assert evaluated["alerts_created"] == 1
        assert evaluated["existing_alerts"] == 0
        assert evaluated["not_evaluated"] == 0
        assert evaluated["evaluations"][0]["status"] == "TRIGGERED"
        assert "not a determination" in evaluated["evaluations"][0]["reason"]
        saved = client.get(f"/api/missions/{mid}").json()
        alert = saved["alerts"][0]
        aid = alert["id"]
        assert alert["status"] == "OPEN"
        assert alert["sar_confidence"] == approx(0.92)
        assert alert["minimum_sar_confidence"] == 0.8
        assert alert["evidence"]["scene_item_id"] == "S1-REAL-ITEM"
        assert alert["evidence"]["source"] == "PERSISTED_REAL_SAR_SCAN"
        assert alert["evidence"]["runtime_mode"] == "REAL"
        assert "TOP_SECRET" not in json.dumps(alert)
        assert "https://" not in json.dumps(alert)
        assert alert["classification"] == "SAR_UNMATCHED"
        assert "illicit" not in alert["rationale"]
        second = client.post(f"/api/missions/{mid}/evaluate").json()
        assert second["alerts_created"] == 0
        assert second["existing_alerts"] == 1
        acknowledged = client.post(f"/api/missions/{mid}/alerts/{aid}/ack")
        assert acknowledged.status_code == 200
        assert acknowledged.json()["status"] == "ACKNOWLEDGED"
        timestamp = acknowledged.json()["acknowledged_at"]
        assert timestamp
        assert client.post(f"/api/missions/{mid}/alerts/{aid}/ack").json()["acknowledged_at"] == timestamp

    # Full application restart: no in-process alert/cache state.
    with TestClient(_app(tmp_path)) as client:
        listed = client.get("/api/missions").json()["missions"]
        assert len(listed) == 1 and listed[0]["id"] == mid
        assert listed[0]["rules"][0]["id"] == rule["id"]
        assert listed[0]["alerts"][0]["status"] == "ACKNOWLEDGED"
        assert listed[0]["evaluations"][0]["status"] == "TRIGGERED"
        replay = client.post(f"/api/missions/{mid}/evaluate").json()
        assert replay["existing_alerts"] == 1
        assert replay["alerts_created"] == 0
        alert = client.get(f"/api/missions/{mid}").json()["alerts"][0]
        assert alert["id"] == aid and alert["acknowledged_at"] == timestamp
        # Active rules cannot have their source scan silently unlinked.
        assert client.delete(f"/api/missions/{mid}/scans/REAL-001").status_code == 409
        assert client.delete(f"/api/missions/{mid}/rules/{rule['id']}").status_code == 204
        assert client.delete(f"/api/missions/{mid}/scans/REAL-001").status_code == 200
        assert client.get(f"/api/missions/{mid}").json()["alerts"][0]["id"] == aid
        assert client.delete(f"/api/missions/{mid}").status_code == 204
        assert client.get(f"/api/missions/{mid}").status_code == 404
    assert source.read_bytes() == source_bytes
    with sqlite3.connect(tmp_path / "missions.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM mission_alerts").fetchone()[0] == 0


def test_missing_evidence_is_not_evaluated_and_never_an_alert(tmp_path: Path):
    _seed(tmp_path, confidence=None)
    with TestClient(_app(tmp_path)) as client:
        mid = _mission(client)["id"]
        _rule(client, mid)
        first = client.post(f"/api/missions/{mid}/evaluate").json()
        assert first["not_evaluated"] == 1
        assert first["alerts_created"] == 0
        assert first["evaluations"][0]["reason"] == "SAR_CONFIDENCE_NOT_RECORDED"
        assert client.get(f"/api/missions/{mid}").json()["alerts"] == []
        assert client.get(f"/api/missions/{mid}").json()["evaluations"][0]["status"] == "NOT_EVALUATED"
        # Deletion of source evidence is explicitly NOT_EVALUATED, not zero detections.
        assert run_store_for_data_dir(tmp_path).delete("REAL-001")
        second = client.post(f"/api/missions/{mid}/evaluate").json()
        assert second["not_evaluated"] == 1
        assert second["evaluations"][0]["reason"] == "PERSISTED_REAL_SCAN_UNAVAILABLE"
        assert second["alerts_created"] == 0
        assert client.get(f"/api/missions/{mid}").json()["alerts"] == []

    # Poisoned legacy metadata never becomes a REAL scan.
    fake = {"scan_id": "LEGACY", "runtime_mode": "REAL", "synthetic": True,
            "stage": "COMPLETE", "targets": [{"id": "DF-001", "sarConf": 1}]}
    (tmp_path / "scans" / "LEGACY.json").write_text(json.dumps(fake), encoding="utf-8")
    with TestClient(_app(tmp_path)) as client:
        assert client.post(f"/api/missions/{mid}/scans",
                           json={"scan_id": "LEGACY"}).status_code == 404


def test_below_threshold_and_revoked_watch_never_create_alert(tmp_path: Path):
    _seed(tmp_path, confidence=0.65)
    with TestClient(_app(tmp_path)) as client:
        mid = _mission(client)["id"]
        rule = _rule(client, mid, threshold=0.8)
        below = client.post(f"/api/missions/{mid}/evaluate").json()
        assert below["evaluations"][0]["status"] == "BELOW_THRESHOLD"
        assert below["alerts_created"] == 0
        case_id = rule["investigation_id"]
        entry_id = client.get(f"/api/investigations/{case_id}").json()["watchlist"][0]["id"]
        assert client.delete(f"/api/investigations/{case_id}/watchlist/{entry_id}").status_code == 204
        unavailable = client.post(f"/api/missions/{mid}/evaluate").json()
        assert unavailable["evaluations"][0]["reason"] == "WATCHLIST_EVIDENCE_UNAVAILABLE"
        assert unavailable["not_evaluated"] == 1
        assert client.get(f"/api/missions/{mid}").json()["alerts"] == []


def test_replaced_source_never_masquerades_as_same_alert_replay(tmp_path: Path):
    _seed(tmp_path)
    with TestClient(_app(tmp_path)) as client:
        mid = _mission(client)["id"]
        _rule(client, mid)
        assert client.post(f"/api/missions/{mid}/evaluate").json()["alerts_created"] == 1
        prior = client.get(f"/api/missions/{mid}").json()["alerts"][0]
    # Simulate out-of-band unexpected mutation to the source record.
    store = run_store_for_data_dir(tmp_path)
    record = store.get("REAL-001")
    assert record is not None
    record["targets"][0]["sarConf"] = 0.94
    store.save(record)
    with TestClient(_app(tmp_path)) as client:
        rerun = client.post(f"/api/missions/{mid}/evaluate").json()
        assert rerun["alerts_created"] == 0
        assert rerun["existing_alerts"] == 0
        assert rerun["not_evaluated"] == 1
        assert rerun["evaluations"][0]["status"] == "NOT_EVALUATED"
        assert rerun["evaluations"][0]["reason"] == "SOURCE_EVIDENCE_CHANGED_AFTER_ALERT"
        stored = client.get(f"/api/missions/{mid}").json()["alerts"]
        assert len(stored) == 1
        assert stored[0]["id"] == prior["id"]
        assert stored[0]["evidence_fingerprint"] == prior["evidence_fingerprint"]
        assert stored[0]["sar_confidence"] == 0.92


def test_validation_status_gates_case_scopes_and_atomic_errors(tmp_path: Path):
    _seed(tmp_path)
    with TestClient(_app(tmp_path)) as client:
        for aoi in [[180, -1, -180, 1], [1, 91, 2, 92], [1, 1, 1, 2], [1, 1, 2]]:
            assert client.post("/api/missions", json={
                "title": "Invalid AOI", "aoi": aoi,
            }).status_code == 422
        assert client.post("/api/missions", json={
            "title": "No fake fields", "aoi": [103, 1, 104, 2],
            "claim": "ILLICIT",
        }).status_code == 422
        mission = _mission(client, status="PLANNED")
        mid = mission["id"]
        assert client.post(f"/api/missions/{mid}/evaluate").status_code == 409
        assert client.post(f"/api/missions/{mid}/scans",
                           json={"scan_id": "NO_SCAN"}).status_code == 404
        assert client.put(f"/api/missions/{mid}", json={
            "title": "Nearby AOI", "aoi": [0, 0, 1, 1], "status": "PLANNED",
        }).status_code == 200
        rejected = client.post(f"/api/missions/{mid}/scans", json={"scan_id": "REAL-001"})
        assert rejected.status_code == 409
        assert rejected.json()["error"] == "AOI_NOT_OVERLAPPING"
        assert client.get(f"/api/missions/{mid}").json()["scan_ids"] == []
        assert client.put(f"/api/missions/{mid}", json={
            "title": "Back to scan AOI", "aoi": [103, 1, 104, 2], "status": "PLANNED",
        }).status_code == 200
        assert client.post(f"/api/missions/{mid}/rules", json={
            "investigation_id": "FAKE", "target_id": "FAKE",
            "minimum_sar_confidence": 0.75,
        }).status_code == 409
        assert client.post(f"/api/missions/{mid}/rules", json={
            "investigation_id": "FAKE", "target_id": "FAKE",
            "minimum_sar_confidence": 1.1,
        }).status_code == 422
        rule = _rule(client, mid)
        rejected_update = client.put(f"/api/missions/{mid}", json={
            "title": "Not overlapping", "aoi": [0, 0, 1, 1], "status": "ACTIVE",
        })
        assert rejected_update.status_code == 409
        assert client.get(f"/api/missions/{mid}").json()["aoi"] == [103, 1, 104, 2]
        assert client.post(f"/api/missions/{mid}/rules", json={
            "investigation_id": rule["investigation_id"],
            "target_id": "DF-001", "minimum_sar_confidence": 0.8,
        }).status_code == 409
        assert client.get(f"/api/missions/{mid}").json()["alerts"] == []
        assert client.put(f"/api/missions/{mid}", json={
            "title": "Now active", "aoi": [102, 0, 105, 3], "status": "ACTIVE",
        }).json()["status"] == "ACTIVE"
        assert client.post(f"/api/missions/{mid}/evaluate").status_code == 200
        aid = client.get(f"/api/missions/{mid}").json()["alerts"][0]["id"]
        other = _mission(client)
        other_id = other["id"]
        assert client.post(f"/api/missions/{other_id}/alerts/{aid}/ack").status_code == 404
        assert client.delete(f"/api/missions/{other_id}/rules/{rule['id']}").status_code == 404
        assert client.put(f"/api/missions/{mid}", json={
            "title": "Closed", "aoi": [102, 0, 105, 3], "status": "CLOSED",
        }).json()["status"] == "CLOSED"
        assert client.post(f"/api/missions/{mid}/evaluate").status_code == 409
        assert client.post(f"/api/missions/{mid}/scans",
                           json={"scan_id": "REAL-001"}).status_code == 409


def test_rule_evaluation_is_pure_and_missingness_is_first_class() -> None:
    assert evaluate_sar_watch("REAL-001", None, "DF-001", 0.1).status == "NOT_EVALUATED"
    assert evaluate_sar_watch("REAL-001", {
        "scan_id": "REAL-001", "runtime_mode": "REAL", "synthetic": False,
        "stage": "COMPLETE", "targets": [{"id": "DF-001", "sarConf": 0.0}],
    }, "DF-001", 0.0).status == "TRIGGERED"
    duplicate = {
        "scan_id": "REAL-001", "runtime_mode": "REAL", "synthetic": False,
        "stage": "COMPLETE",
        "targets": [{"id": "DF-001", "sarConf": 0.9},
                    {"id": "DF-001", "sarConf": 0.9}],
    }
    assert evaluate_sar_watch("REAL-001", duplicate, "DF-001", 0.8).reason == (
        "WATCHED_TARGET_NOT_UNIQUELY_PRESENT"
    )
