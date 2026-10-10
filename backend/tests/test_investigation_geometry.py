"""DF-X16 actual WGS84 tests and HTTP/SQLite migration contract."""

from __future__ import annotations

import math
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.investigation_geometry import GeometryInput, measure_geometry
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _app(root: Path):
    return create_app(Settings(data_dir=str(root), log_level="WARNING"))


def _shape(kind: str, vertices: list[list[float]], radius: float | None = None):
    return {"kind": kind, "coordinates": vertices, "radius_m": radius}


def _payload(kind: str, vertices: list[list[float]], radius: float | None = None):
    return {
        "label": "Operator GPS boundary", "notes": "Geodesic reference measurements only.",
        "geometry": _shape(kind, vertices, radius),
    }


def test_authoritative_wgs84_known_geodesics_units_and_dateline() -> None:
    equator = measure_geometry(GeometryInput.model_validate(_shape(
        "polyline", [[0, 0], [1, 0]],
    )))
    # EPSG WGS84 inverse geodesic, not 111.2-km spherical or a screen-pixel scale.
    assert equator.length_m == pytest.approx(111_319.490793, abs=0.01)
    assert equator.initial_bearing_deg == pytest.approx(90.0, abs=1e-9)
    assert equator.length_nm == pytest.approx(equator.length_m / 1852)
    assert equator.length_km == pytest.approx(equator.length_m / 1000)
    meridian = measure_geometry(GeometryInput.model_validate(_shape(
        "polyline", [[0, 0], [0, 1]],
    )))
    assert meridian.length_m == pytest.approx(110_574.388557, abs=0.01)
    assert meridian.initial_bearing_deg == pytest.approx(0.0, abs=1e-8)
    antimeridian = measure_geometry(GeometryInput.model_validate(_shape(
        "polyline", [[179.5, 0], [-179.5, 0]],
    )))
    assert antimeridian.length_m == pytest.approx(equator.length_m, abs=0.01)
    assert antimeridian.initial_bearing_deg == pytest.approx(90.0, abs=1e-8)
    assert measure_geometry(GeometryInput.model_validate(
        _shape("point", [[12.4, -13.2]]),
    )).length_m is None


def test_polygon_area_closed_perimeter_and_range_ring_physics() -> None:
    polygon = GeometryInput.model_validate(_shape(
        "polygon", [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
    ))
    assert len(polygon.coordinates) == 4  # repeated closure canonicalized
    result = measure_geometry(polygon)
    assert result.area_m2 == pytest.approx(12_308_778_361, rel=1e-7)
    assert result.perimeter_m == pytest.approx(443_770.917, abs=0.1)
    assert result.area_km2 == pytest.approx(result.area_m2 / 1e6)
    # This polygon is only 2 degrees wide across the antimeridian, not 358°.
    crossing = measure_geometry(GeometryInput.model_validate(_shape(
        "polygon", [[179, -0.5], [-179, -0.5], [-179, 0.5], [179, 0.5]],
    )))
    assert 2e10 < crossing.area_m2 < 3e10
    assert crossing.perimeter_m < 700_000
    ring = measure_geometry(GeometryInput.model_validate(_shape(
        "range_ring", [[103.8, 1.3]], 1000.0,
    )))
    assert ring.radius_km == pytest.approx(1.0)
    assert ring.radius_nm == pytest.approx(1000 / 1852)
    assert ring.area_m2 == pytest.approx(math.pi * 1000 ** 2, rel=6e-5)
    assert ring.perimeter_m == pytest.approx(2 * math.pi * 1000, rel=6e-5)
    assert "approximated" in ring.method


@pytest.mark.parametrize("kind,vertices,radius", [
    ("point", [[181, 0]], None),
    ("point", [[0, -91]], None),
    ("point", [[float("nan"), 0]], None),
    ("point", [[0, float("inf")]], None),
    ("point", [[0, 0], [1, 1]], None),
    ("polyline", [[0, 0]], None),
    ("polyline", [[180, 0], [-180, 0]], None),
    ("polygon", [[0, 0], [2, 2], [0, 2], [2, 0]], None),  # bowtie
    ("polygon", [[0, 0], [1, 0], [2, 0]], None),  # flat
    ("range_ring", [[0, 0]], None),
    ("range_ring", [[0, 0]], -100),
    ("range_ring", [[0, 0]], 2_000_001),
    ("point", [[0, 0]], 500),
])
def test_invalid_geometries_refused(kind: str, vertices: list[list[float]], radius: float | None):
    with pytest.raises(ValidationError):
        GeometryInput.model_validate(_shape(kind, vertices, radius))


def test_api_geometry_crud_restart_scan_provenance_and_cascade(tmp_path: Path) -> None:
    run_store_for_data_dir(tmp_path).save(mark_synthetic({
        "scan_id": "REAL-SCAN-01", "stage": "COMPLETE",
        "aoi": [100, 1, 101, 2], "targets": [{"id": "DF-001"}],
    }))
    saved_path = tmp_path / "scans" / "REAL-SCAN-01.json"
    unchanged_scan = saved_path.read_bytes()
    with TestClient(_app(tmp_path)) as client:
        made = client.post("/api/investigations", json={
            "title": "WGS84 tracing", "scan_id": "REAL-SCAN-01",
        })
        assert made.status_code == 201, made.text
        case_id = made.json()["id"]
        base = f"/api/investigations/{case_id}"
        note_id = client.post(f"{base}/annotations", json={
            "content": "Maintain old note."
        }).json()["id"]
        watched_id = client.post(f"{base}/watchlist", json={
            "target_id": "DF-001",
        }).json()["id"]
        created = client.post(f"{base}/geometries", json=_payload(
            "polyline", [[179.5, 0], [-179.5, 0]],
        ))
        assert created.status_code == 201, created.text
        geo = created.json()
        geo_id = geo["id"]
        assert geo["scan_id"] == "REAL-SCAN-01"
        assert geo["provenance"] == "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE"
        assert geo["measurements"]["length_m"] == pytest.approx(111319.49, abs=1)
        assert geo["measurements"]["initial_bearing_deg"] == pytest.approx(90)
        assert geo["geometry"]["coordinates"] == [[179.5, 0], [-179.5, 0]]
        assert client.get(f"{base}/geometries/{geo_id}").status_code == 200
        assert client.get(f"{base}/geometries").json()["geometries"][0]["id"] == geo_id

    # Existing database, new application, same durable SQLite record and old notes.
    with TestClient(_app(tmp_path)) as client:
        base = f"/api/investigations/{case_id}"
        record = client.get(f"{base}/geometries/{geo_id}").json()
        assert record["label"] == "Operator GPS boundary"
        assert record["measurements"]["length_nm"] == pytest.approx(111319.49 / 1852, abs=0.1)
        original = client.get(base).json()
        assert original["annotations"][0]["id"] == note_id
        assert original["watchlist"][0]["id"] == watched_id
        updated = client.put(f"{base}/geometries/{geo_id}", json=_payload(
            "polygon", [[0, 0], [1, 0], [1, 1], [0, 1]],
        ))
        assert updated.status_code == 200, updated.text
        changed = updated.json()
        assert changed["id"] == geo_id
        assert changed["created_at"] == geo["created_at"]
        assert changed["measurements"]["area_km2"] == pytest.approx(12_308.78, abs=0.1)
        assert changed["measurements"]["length_m"] is None
        other_case_id = client.post("/api/investigations", json={"title": "Separate"}).json()["id"]
        assert client.put(f"/api/investigations/{other_case_id}/geometries/{geo_id}",
                          json=_payload("point", [[0, 0]])).status_code == 404
        assert client.delete(f"/api/investigations/{other_case_id}/geometries/{geo_id}").status_code == 404
        assert client.delete(f"{base}/geometries/{geo_id}").status_code == 204
        assert client.get(f"{base}/geometries/{geo_id}").status_code == 404
        assert client.get(base).json()["annotations"][0]["id"] == note_id
        assert client.get(base).json()["watchlist"][0]["id"] == watched_id
        second = client.post(f"{base}/geometries", json=_payload("point", [[1, 1]]))
        assert second.status_code == 201
        assert client.delete(base).status_code == 204
        assert saved_path.read_bytes() == unchanged_scan
    with sqlite3.connect(tmp_path / "investigations.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM investigation_geometries").fetchone()[0] == 0
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2


def test_additive_migration_from_pre_geo_schema(tmp_path: Path) -> None:
    db = tmp_path / "investigations.sqlite3"
    # Minimal pre-DF-X16 live case and note; migration may not replace old tables.
    with sqlite3.connect(db) as connection:
        connection.executescript("""
            CREATE TABLE investigations (id TEXT PRIMARY KEY, title TEXT NOT NULL,
              scan_id TEXT, created_at TEXT NOT NULL);
            CREATE TABLE investigation_annotations (id TEXT PRIMARY KEY,
              investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
              content TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
            CREATE TABLE investigation_watchlist (id TEXT PRIMARY KEY,
              investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
              target_id TEXT NOT NULL, created_at TEXT NOT NULL,
              UNIQUE(investigation_id, target_id));
            INSERT INTO investigations VALUES ('old-case', 'Historic', NULL, '2026-10-01');
            INSERT INTO investigation_annotations VALUES (
              'old-note', 'old-case', 'Preserve analyst work', NULL, '2026-10-01');
        """)
    with TestClient(_app(tmp_path)) as client:
        assert client.get("/api/investigations/old-case").json()["annotations"][0]["id"] == "old-note"
        created = client.post("/api/investigations/old-case/geometries",
                              json=_payload("range_ring", [[179.7, 0]], 1852))
        assert created.status_code == 201, created.text
        assert created.json()["scan_id"] is None
        assert created.json()["measurements"]["radius_nm"] == pytest.approx(1.0)
    with sqlite3.connect(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute("SELECT content FROM investigation_annotations").fetchone()[0] == (
            "Preserve analyst work"
        )


def test_api_validation_errors_no_claims_and_missing_linked_scan(tmp_path: Path) -> None:
    run_store_for_data_dir(tmp_path).save(mark_synthetic({
        "scan_id": "REAL-SCAN-02", "stage": "COMPLETE", "targets": [],
    }))
    with TestClient(_app(tmp_path)) as client:
        unknown = client.post("/api/investigations/not-real/geometries",
                              json=_payload("point", [[0, 0]]))
        assert unknown.status_code == 404
        case_id = client.post("/api/investigations", json={
            "title": "Guard", "scan_id": "REAL-SCAN-02",
        }).json()["id"]
        endpoint = f"/api/investigations/{case_id}/geometries"
        for draft in [
            _payload("polyline", [[0, 0]]),
            _payload("polygon", [[0, 0], [2, 2], [0, 2], [2, 0]]),
            _payload("point", [[181, 0]]),
            _payload("range_ring", [[0, 0]], None),
            {**_payload("point", [[0, 0]]), "synthetic": False},
            {**_payload("point", [[0, 0]]), "scan_id": "FAKE"},
        ]:
            response = client.post(endpoint, json=draft)
            assert response.status_code == 422, response.text
        assert client.get(endpoint).json()["geometries"] == []
        assert client.get(f"{endpoint}/FAKE").status_code == 404
        assert client.put(f"{endpoint}/FAKE",
                          json=_payload("point", [[0, 0]])).status_code == 404
        assert client.delete(f"{endpoint}/FAKE").status_code == 404
        run_store_for_data_dir(tmp_path).delete("REAL-SCAN-02")
        assert client.post(endpoint, json=_payload("point", [[0, 0]])).status_code == 404
