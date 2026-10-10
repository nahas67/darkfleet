"""Investigation workflow: HTTP validation, real-scan provenance and restart durability."""

from __future__ import annotations

from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _app(tmp_path):
    return create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))


def _real_scan(tmp_path):
    store = run_store_for_data_dir(tmp_path)
    store.save(mark_synthetic({
        "scan_id": "DF-001",
        "stage": "COMPLETE",
        "aoi": [101.0, 1.0, 102.0, 2.0],
        "targets": [{"id": "TARGET-1"}, {"id": "TARGET-2"}],
    }))


def test_investigation_persists_across_app_restart_with_original_scan_provenance(tmp_path):
    _real_scan(tmp_path)
    with TestClient(_app(tmp_path)) as client:
        created = client.post("/api/investigations", json={
            "title": "Case Alpha", "scan_id": "DF-001",
        })
        assert created.status_code == 201, created.text
        case = created.json()
        assert case["title"] == "Case Alpha"
        assert case["aoi"] == [101.0, 1.0, 102.0, 2.0]
        assert case["annotations"] == []
        case_id = case["id"]

        annotated = client.post(f"/api/investigations/{case_id}/annotations", json={
            "content": "AIS absence is not proof of stealth.", "target_id": "TARGET-1",
        })
        assert annotated.status_code == 201, annotated.text
        note_id = annotated.json()["id"]
        watched = client.post(f"/api/investigations/{case_id}/watchlist", json={
            "target_id": "TARGET-1",
        })
        assert watched.status_code == 201, watched.text
        watch_id = watched.json()["id"]

    # A second application has no process-local memory from the first.
    with TestClient(_app(tmp_path)) as client:
        rows = client.get("/api/investigations").json()["investigations"]
        assert len(rows) == 1
        persisted = client.get(f"/api/investigations/{case_id}").json()
        assert persisted["scan_id"] == "DF-001"
        assert persisted["annotations"][0]["id"] == note_id
        assert persisted["annotations"][0]["content"] == "AIS absence is not proof of stealth."
        assert persisted["watchlist"][0]["id"] == watch_id
        assert run_store_for_data_dir(tmp_path).get("DF-001")["targets"][0]["id"] == "TARGET-1"

        assert client.delete(f"/api/investigations/{case_id}/annotations/{note_id}").status_code == 204
        assert client.delete(f"/api/investigations/{case_id}/watchlist/{watch_id}").status_code == 204
        assert client.get(f"/api/investigations/{case_id}").json()["annotations"] == []
        assert client.get(f"/api/investigations/{case_id}").json()["watchlist"] == []
        assert client.delete(f"/api/investigations/{case_id}").status_code == 204
        assert client.get(f"/api/investigations/{case_id}").status_code == 404
        # Deleting case notes must not delete immutable source evidence.
        assert run_store_for_data_dir(tmp_path).get("DF-001")["targets"][0]["id"] == "TARGET-1"


def test_investigation_rejects_unverified_targets_and_duplicate_watch(tmp_path):
    _real_scan(tmp_path)
    with TestClient(_app(tmp_path)) as client:
        assert client.post("/api/investigations", json={
            "title": "Non-existent", "scan_id": "DF-NOPE",
        }).status_code == 404
        assert client.post("/api/investigations", json={
            "title": "Unbounded", "extra": "wrong",
        }).status_code == 422
        case_id = client.post("/api/investigations", json={
            "title": "Evidence scoped", "scan_id": "DF-001",
        }).json()["id"]
        prefix = f"/api/investigations/{case_id}"
        assert client.post(f"{prefix}/annotations", json={"content": "  "}).status_code == 422
        assert client.post(f"{prefix}/annotations", json={
            "content": "Invented target", "target_id": "FAKE",
        }).status_code == 404
        assert client.post(f"{prefix}/watchlist", json={"target_id": "FAKE"}).status_code == 404
        assert client.post(f"{prefix}/watchlist", json={"target_id": "TARGET-2"}).status_code == 201
        assert client.post(f"{prefix}/watchlist", json={"target_id": "TARGET-2"}).status_code == 409
        assert len(client.get(prefix).json()["watchlist"]) == 1
        assert len(client.get(prefix).json()["annotations"]) == 0
        assert client.delete(f"{prefix}/annotations/missing").status_code == 404
        assert client.delete(f"{prefix}/watchlist/missing").status_code == 404


def test_unlinked_case_accepts_general_notes_but_rejects_target_assertions(tmp_path):
    with TestClient(_app(tmp_path)) as client:
        case_id = client.post("/api/investigations", json={
            "title": "Open questions",
        }).json()["id"]
        prefix = f"/api/investigations/{case_id}"
        assert client.post(f"{prefix}/annotations", json={
            "content": "Investigate scene coverage before targeting.",
        }).status_code == 201
        assert client.post(f"{prefix}/annotations", json={
            "content": "Unsupported assertion", "target_id": "TARGET-1",
        }).status_code == 409
        assert client.post(f"{prefix}/watchlist", json={"target_id": "TARGET-1"}).status_code == 409
        assert client.get(prefix).json()["aoi"] is None
