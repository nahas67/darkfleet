"""DF-X19 independent evidence exports, data confidentiality, restart and integrity."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.investigation_reports import build_report
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _client(tmp_path):
    app = create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))
    return TestClient(app)


def test_unlinked_case_reports_missing_source_and_keeps_operator_material(tmp_path) -> None:
    with _client(tmp_path) as client:
        case = client.post("/api/investigations", json={"title": "User case no sensor"}).json()
        case_id = case["id"]
        note = client.post(
            f"/api/investigations/{case_id}/annotations",
            json={"content": "Unverified analyst note—no source observation."},
        )
        assert note.status_code == 201
        geometry = client.post(
            f"/api/investigations/{case_id}/geometries",
            json={
                "label": "Hand-added line",
                "geometry": {"kind": "polyline", "coordinates": [[0.0, 0.0], [1.0, 0.0]]},
                "notes": "Operator path, no vessel claim",
            },
        )
        assert geometry.status_code == 201, geometry.text

        response = client.get(f"/api/investigation-reports/{case_id}/json")
        assert response.status_code == 200, response.text
        document = response.json()
        assert document["source_status"] == "NO_SCAN_LINKED"
        assert document["sensor_evidence"]["target_count"] is None
        assert document["sensor_evidence"]["targets"] == []
        assert document["operator_material"]["annotations"][0]["content"] == (
            "Unverified analyst note—no source observation."
        )
        first = document["operator_material"]["geometries"][0]
        assert first["provenance"] == "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE"
        assert first["measurements"]["length_m"] == pytest.approx(111_319.490793, abs=1e-4)
        assert document["warnings"] == ["NO_SCAN_LINKED"]
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-disposition"].endswith('evidence.json"')

        data = {
            key: value for key, value in document.items()
            if key not in ("content_sha256", "hash_algorithm")
        }
        packed = json.dumps(
            data, sort_keys=True, ensure_ascii=False,
            separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
        assert document["content_sha256"] == hashlib.sha256(packed).hexdigest()

        pdf = client.get(f"/api/investigation-reports/{case_id}/pdf")
        assert pdf.status_code == 200
        assert pdf.content.startswith(b"%PDF-")
        assert pdf.content.rstrip().endswith(b"%%EOF")
        assert b"SOURCE STATUS: NO_SCAN_LINKED" in pdf.content
        assert b"OPERATOR-ADDED material" in pdf.content
        assert b"NO VERIFIED PERSISTED SOURCE AVAILABLE" in pdf.content
        assert pdf.headers["x-darkfleet-content-sha256"] == document["content_sha256"]

    with _client(tmp_path) as client:
        assert client.get(f"/api/investigation-reports/{case_id}/json").json() == document
        assert client.get(f"/api/investigation-reports/{case_id}/pdf").status_code == 200
        assert client.get("/api/investigation-reports/unknown/json").status_code == 422
        assert client.get(f"/api/investigation-reports/{'a' * 36}/pdf").status_code == 404


def test_report_whitelists_source_metadata_and_refuses_unverified_history(tmp_path) -> None:
    store = run_store_for_data_dir(tmp_path)
    store.save(mark_synthetic({
        "scan_id": "DF-OBS-01",
        "scene": {
            "item_id": "sentinel-scene-1",
            "provider": "planetary-computer",
            "acquisition_time": "2026-10-01T00:00:00Z",
            "asset_href": "https://secret.invalid/cog.tif?signature=CANARY-PRIVATE",
            "password": "SECRET-PASSWORD",
        },
        "provenance": {"processing_version": "3.0.0"},
        "targets": [{
            "id": "DF-123", "classification": "SAR_UNMATCHED",
            "lat": 1.2, "lon": 103.8,
            "lenM": None, "lenUncM": None, "sarConf": 0.72,
            "assessment": "No sufficient AIS candidate in persisted analysis",
            "asset_href": "CANARY-PRIVATE",
            "corr": {"mmsi": None, "scoreDecomposition": {"sizeScore": None}},
        }, {
            "id": "AIS-ONLY-000000001", "classification": "AIS_ONLY",
            "lat": 1.3, "lon": 103.9,
        }],
    }))
    with _client(tmp_path) as client:
        case = client.post(
            "/api/investigations", json={"title": "Real-source boundary", "scan_id": "DF-OBS-01"},
        )
        assert case.status_code == 201, case.text
        case_id = case.json()["id"]
        doc = client.get(f"/api/investigation-reports/{case_id}/json").json()
        assert doc["source_status"] == "PERSISTED_REAL"
        assert doc["sensor_evidence"]["metadata"]["item_id"] == "sentinel-scene-1"
        assert doc["sensor_evidence"]["targets"][0]["lenM"] is None
        assert doc["sensor_evidence"]["targets"][0]["classification"] == "SAR_UNMATCHED"
        assert doc["sensor_evidence"]["sar_target_count"] == 1
        assert doc["sensor_evidence"]["ais_only_count"] == 1
        raw = json.dumps(doc)
        assert "CANARY-PRIVATE" not in raw
        assert "SECRET-PASSWORD" not in raw
        assert "asset_href" not in raw
        assert client.get(f"/api/investigation-reports/{case_id}/pdf").status_code == 200

    # Removing the original persisted scan changes the report's source state.
    (store.scans_dir / "DF-OBS-01.json").unlink()
    with _client(tmp_path) as client:
        doc = client.get(f"/api/investigation-reports/{case_id}/json").json()
        assert doc["source_status"] == "SOURCE_MISSING"
        assert doc["sensor_evidence"]["targets"] == []
        assert "SOURCE_MISSING" in doc["warnings"]


def test_corrupt_operator_geometry_is_explicit_without_making_up_metrics(tmp_path) -> None:
    with _client(tmp_path) as client:
        case_id = client.post("/api/investigations", json={"title": "Broken geometry"}).json()["id"]
        saved = client.post(
            f"/api/investigations/{case_id}/geometries",
            json={"label": "Initial", "geometry": {
                "kind": "point", "coordinates": [[103.7, 1.2]],
            }},
        )
        assert saved.status_code == 201
        geom_id = saved.json()["id"]

    with sqlite3.connect(tmp_path / "investigations.sqlite3") as conn:
        conn.execute(
            "UPDATE investigation_geometries SET geometry_json=? WHERE id=?",
            ('{"kind":"point","coordinates":[[999,999]]}', geom_id),
        )
    with _client(tmp_path) as client:
        report = client.get(f"/api/investigation-reports/{case_id}/json").json()
        geo = report["operator_material"]["geometries"][0]
        assert geo["status"] == "INVALID_STORED_GEOMETRY"
        assert geo["measurements"] is None
        assert any(item.startswith("CORRUPT_OPERATOR_GEOMETRY") for item in report["warnings"])


def test_local_relative_data_dir_can_open_read_only_report(tmp_path, monkeypatch) -> None:
    """Exercise production's default relative data_dir instead of absolute tmp_path."""
    monkeypatch.chdir(tmp_path)
    data_dir = tmp_path / "evidence"
    with _client(data_dir) as client:
        case_id = client.post("/api/investigations", json={"title": "relative path"}).json()["id"]
    report = build_report(
        data_dir=Path("evidence"),
        store=run_store_for_data_dir(data_dir),
        case_id=case_id,
    )
    assert report["investigation"]["id"] == case_id
    assert report["source_status"] == "NO_SCAN_LINKED"
