"""Persisted scan discovery for local acquisition comparison.

These minimal documents are isolated API contract fixtures, not operational SAR
observations. No fixture data are installed into the user's runtime store.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.storage.runs import run_store_for_data_dir


def test_catalogue_is_restart_safe_bounded_and_exposes_no_signed_urls(tmp_path) -> None:
    config = Settings(data_dir=str(tmp_path))
    store = run_store_for_data_dir(tmp_path)
    store.save(
        {
            "scan_id": "DF-1001",
            "runtime_mode": "REAL",
            "synthetic": False,
            "scene": {
                "item_id": "fixture-acquisition-one",
                "acquisition_time": "2026-05-12T08:00:00Z",
                "provider": "test-fixture",
                "product": "RTC",
                "polarization": "VV",
                "asset_href": "https://example.invalid/fixture.tif?sig=SECRET-CANARY",
            },
        }
    )
    store.save(
        {
            "scan_id": "DF-1002",
            "runtime_mode": "REAL",
            "synthetic": False,
            "scene": {
                "item_id": "fixture-acquisition-two",
                "acquisition_time": "2026-05-13T08:00:00Z",
                "provider": "test-fixture",
                "product": "RTC",
                "polarization": "VH",
            },
        }
    )
    # Simulate historical damage: an unreadable record and an invalidly labelled
    # document must not show as an observation in the operator's saved catalogue.
    store.scans_dir.joinpath("DF-1003.json").write_text("{broken", encoding="utf-8")
    store.scans_dir.joinpath("DF-1004.json").write_text(
        json.dumps({"scan_id": "DF-1004", "runtime_mode": "DEMO", "synthetic": True}),
        encoding="utf-8",
    )

    with TestClient(create_app(config)) as client:
        response = client.get("/api/scans")
        assert response.status_code == 200
        payload = response.json()
        assert payload["count"] == 2
        assert [entry["scan_id"] for entry in payload["scans"]] == ["DF-1002", "DF-1001"]
        assert payload["scans"][0]["polarization"] == "VH"
        assert all(entry["runtime_mode"] == "REAL" and entry["synthetic"] is False for entry in payload["scans"])
        assert "SECRET-CANARY" not in response.text
        assert "asset_href" not in response.text
        assert client.get("/api/scans?limit=1").json()["count"] == 1
        assert client.get("/api/scans?limit=0").status_code == 422
        assert client.get("/api/scans?limit=201").status_code == 422

    # A new app instance over the same directory discovers the same two scans.
    with TestClient(create_app(config)) as client:
        assert client.get("/api/scans").json()["count"] == 2
