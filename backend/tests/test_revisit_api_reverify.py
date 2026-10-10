"""Revisit HTTP truth tests with deterministic provider responses; no network calls."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from darkfleet.api import routes
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.providers import RealDataUnavailableError


def test_api_transmits_measured_plan_and_original_catalogue_identity(tmp_path, monkeypatch) -> None:
    calls: list[tuple] = []
    now = datetime.now(UTC).replace(microsecond=0)

    def catalogue(url, collection, bbox, window, *, limit):
        calls.append((url, collection, bbox, window, limit))
        return [
            {
                "id": f"scene-{i}", "collection": collection,
                "properties": {"datetime": (now - timedelta(days=2 - i)).isoformat(), "platform": "sentinel-1a"},
                "assets": {"vv": {}},
            }
            for i in range(2)
        ] + [{
            "id": "scene-0", "collection": collection,
            "properties": {"datetime": (now - timedelta(days=2)).isoformat(), "platform": "sentinel-1a"},
            "assets": {"vh": {}},
        }]

    monkeypatch.setattr(routes, "stac_items", catalogue)
    with TestClient(create_app(Settings(data_dir=str(tmp_path)))) as client:
        response = client.get("/api/revisit", params={
            "bbox": "103.8,1.24,103.86,1.28", "history_days": 30, "horizon_days": 0,
        })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["acquisition_count"] == 2
    assert len(body["gaps"]) == 1
    assert body["statistics"]["median_revisit_days"] == 1
    assert body["statistics"]["nominal_repeat_days"] == 12
    assert [a["item_id"] for a in body["acquisitions"]] == ["scene-0", "scene-1"]
    assert set(body["acquisitions"][0]["polarizations"]) == {"VV", "VH"}
    assert body["acquisitions"][0]["collection"] == calls[0][1]
    assert body["requested_bbox"] == [103.8, 1.24, 103.86, 1.28]
    assert calls[0][4] == 200


def test_api_unavailable_catalogue_stays_failed_and_does_not_invent_plan(tmp_path, monkeypatch) -> None:
    def unavailable(*args, **kwargs):
        raise RealDataUnavailableError("catalogue offline", details={"provider": "offline"})

    monkeypatch.setattr(routes, "stac_items", unavailable)
    with TestClient(create_app(Settings(data_dir=str(tmp_path)))) as client:
        response = client.get("/api/revisit", params={"bbox": "103.8,1.24,103.86,1.28"})
    assert response.status_code >= 500
    assert response.json().get("acquisitions") is None


def test_api_dateline_queries_both_halves_then_deduplicates_real_scene_ids(tmp_path, monkeypatch) -> None:
    calls: list[tuple[float, float, float, float]] = []
    now = datetime.now(UTC).replace(microsecond=0)

    def catalogue(url, collection, bbox, window, *, limit):
        calls.append(bbox)
        # Both catalogues return the same scene; it must be counted once.
        return [{
            "id": "overlap-scene", "collection": collection,
            "properties": {"datetime": (now - timedelta(days=2)).isoformat(), "platform": "sentinel-1a"},
            "assets": {"vv": {}},
        }] + ([{
            "id": "western-scene", "collection": collection,
            "properties": {"datetime": (now - timedelta(days=1)).isoformat(), "platform": "sentinel-1a"},
            "assets": {"vh": {}},
        }] if bbox[0] == -180.0 else [])

    monkeypatch.setattr(routes, "stac_items", catalogue)
    with TestClient(create_app(Settings(data_dir=str(tmp_path)))) as client:
        response = client.get("/api/revisit", params={
            "bbox": "179.985,1.24,-179.995,1.26", "history_days": 30, "horizon_days": 0,
        })
    assert response.status_code == 200, response.text
    body = response.json()
    assert calls == [(179.985, 1.24, 180.0, 1.26), (-180.0, 1.24, -179.995, 1.26)]
    assert body["requested_bbox"] == [179.985, 1.24, -179.995, 1.26]
    assert body["acquisition_count"] == 2
    assert body["statistics"]["median_revisit_days"] == 1
    assert any("antimeridian" in line for line in body["limitations"])


def test_api_dateline_failure_on_one_half_never_returns_partial_as_complete(tmp_path, monkeypatch) -> None:
    def catalogue(url, collection, bbox, window, *, limit):
        if bbox[0] == -180.0:
            raise RealDataUnavailableError("west half unavailable")
        return [{
            "id": "east-scene", "collection": collection,
            "properties": {"datetime": datetime.now(UTC).isoformat()},
        }]

    monkeypatch.setattr(routes, "stac_items", catalogue)
    with TestClient(create_app(Settings(data_dir=str(tmp_path)))) as client:
        response = client.get("/api/revisit", params={"bbox": "179.985,1.24,-179.995,1.26"})
    assert response.status_code >= 500
    assert "acquisitions" not in response.json()
