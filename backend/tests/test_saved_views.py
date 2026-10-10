"""Saved camera/investigation snapshots: restart persistence and evidence boundaries.

These fixture records live under pytest's tmp_path and never represent an
operational acquisition. They exist solely to verify the state machine/contract.
"""

from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _app(tmp_path):
    return create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))


def _real_scan(tmp_path):
    store = run_store_for_data_dir(tmp_path)
    store.save(mark_synthetic({
        "scan_id": "SCAN-REAL-1", "stage": "COMPLETE",
        "targets": [{"id": "DF-001"}],
    }))
    return store


def _snapshot():
    return {
        "schema_version": 1,
        "camera": {
            "position": {"x": 7600000, "y": 0, "z": 0},
            "heading": 0, "pitch": -1.2, "roll": 0,
        },
        "map_source_id": "OSM",
        "layers": {
            "SAR_DETECTIONS": {"visible": True, "opacity": 0.85},
            "AIS_CONTACTS": {"visible": False, "opacity": 1.0},
        },
        "scan_id": "SCAN-REAL-1",
        "target": {"scan_id": "SCAN-REAL-1", "target_id": "DF-001"},
        "contact": {"mmsi": "000000001", "observation_at": "2026-10-09T00:00:00Z"},
        "playback_at": "2026-10-09T00:00:00Z",
        "playback_speed": 2,
        "workspace": "INTELLIGENCE",
        "aoi": [101.0, 1.0, 102.0, 2.0],
    }


def test_saved_view_crud_restart_and_optimistic_conflict(tmp_path) -> None:
    _real_scan(tmp_path)
    with TestClient(_app(tmp_path)) as client:
        created = client.post('/api/views', json={
            "title": "Track inquiry", "snapshot": _snapshot(),
        })
        assert created.status_code == 201, created.text
        view = created.json()
        view_id = view["id"]
        assert view["revision"] == 1
        assert view["status"] == "OK"
        assert view["missing_resources"] == []
        assert view["snapshot"]["target"]["target_id"] == "DF-001"
        assert view["snapshot"]["contact"]["mmsi"] == "000000001"
        assert view["snapshot"]["camera"]["position"]["x"] == 7_600_000

    with TestClient(_app(tmp_path)) as client:
        saved = client.get(f'/api/views/{view_id}').json()
        assert saved["title"] == "Track inquiry"
        assert client.get('/api/views').json()["count"] == 1
        modified = client.put(f'/api/views/{view_id}', json={
            "title": "Renamed inquiry", "snapshot": _snapshot(), "expected_revision": 1,
        })
        assert modified.status_code == 200, modified.text
        assert modified.json()["revision"] == 2
        assert modified.json()["title"] == "Renamed inquiry"
        assert client.put(f'/api/views/{view_id}', json={
            "title": "Clobber attempt", "snapshot": _snapshot(), "expected_revision": 1,
        }).status_code == 409
        assert client.get(f'/api/views/{view_id}').json()["title"] == "Renamed inquiry"
        assert client.delete(f'/api/views/{view_id}').status_code == 204
        assert client.get(f'/api/views/{view_id}').status_code == 404


def test_saved_view_rejects_unverified_sources_and_unsafe_fields(tmp_path) -> None:
    _real_scan(tmp_path)
    snapshot = _snapshot()
    with TestClient(_app(tmp_path)) as client:
        assert client.post('/api/views', json={"title": "Without scan", "snapshot": {
            **snapshot, "scan_id": "NOT-IN-DATA",
            "target": None,
        }}).status_code == 404
        assert client.post('/api/views', json={"title": "Invented target", "snapshot": {
            **snapshot, "target": {"scan_id": "SCAN-REAL-1", "target_id": "UNKNOWN"},
        }}).status_code == 404
        assert client.post('/api/views', json={"title": "Mixed scans", "snapshot": {
            **snapshot, "target": {"scan_id": "SCAN-OTHER", "target_id": "DF-001"},
        }}).status_code == 422
        assert client.post('/api/views', json={"title": "Secret", "snapshot": {
            **snapshot, "api_key": "TOP-SECRET-CANARY",
        }}).status_code == 422
        assert client.post('/api/views', json={"title": "Bad AOI", "snapshot": {
            **snapshot, "aoi": [175, -5, -175, 5],
        }}).status_code == 422
        assert client.post('/api/views', json={"title": "Inside the Earth", "snapshot": {
            **snapshot, "camera": {
                "position": {"x": 0, "y": 0, "z": 0},
                "heading": 0, "pitch": 0, "roll": 0,
            },
        }}).status_code == 422
        assert client.get('/api/views?limit=0').status_code == 422


def test_missing_source_or_corrupt_view_is_visible_and_does_not_block_other_views(tmp_path) -> None:
    store = _real_scan(tmp_path)
    with TestClient(_app(tmp_path)) as client:
        good_id = client.post('/api/views', json={
            "title": "Pending scene", "snapshot": _snapshot(),
        }).json()["id"]
        plain_id = client.post('/api/views', json={
            "title": "Navigation bookmark", "snapshot": {
                "workspace": "TACTICAL", "investigation_id": "future-case",
            },
        }).json()["id"]
        assert client.get(f'/api/views/{plain_id}').json()["missing_resources"] == ["INVESTIGATION_MISSING"]

    # A previously valid source was moved away. The view remains discoverable,
    # preserving its operator-added state, but cannot be misreported as restored.
    (store.scans_dir / "SCAN-REAL-1.json").unlink()
    with sqlite3.connect(tmp_path / "investigations.sqlite3") as conn:
        conn.execute("UPDATE saved_views SET state_json=? WHERE id=?", ('{invalid', plain_id))
    with TestClient(_app(tmp_path)) as client:
        payload = client.get('/api/views').json()
        by_id = {view["id"]: view for view in payload["views"]}
        assert by_id[good_id]["missing_resources"] == ["SCAN_MISSING"]
        assert by_id[plain_id]["status"] == "CORRUPT"
        assert by_id[plain_id]["snapshot"] is None
        assert by_id[plain_id]["missing_resources"] == ["INVALID_VIEW_RECORD"]
        assert len(by_id) == 2
