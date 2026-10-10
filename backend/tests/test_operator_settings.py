"""Real isolated FastAPI/SQLite operator settings, not synthetic sensor inputs."""

from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings


DEFAULTS = {
    "show_provider_details": True,
    "show_keyboard_reference": True,
    "show_provenance_summary": True,
}


def _app(directory: Path):
    # Exercise *the actual production route registration*. The operator router
    # is now mounted by create_app; never patch it into a test-only app and
    # accidentally certify a public API path missing from the shipped product.
    # Some mounted router wrappers lack a .path attribute, so path enumeration
    # would be an invalid test of application reachability.
    return create_app(Settings(data_dir=str(directory), log_level="WARNING"))


def _save(client: TestClient, revision: int, prefs: dict) -> object:
    return client.put("/api/operator-settings", json={
        "expected_revision": revision,
        "preferences": prefs,
    })


def test_default_put_reset_process_restart_and_independent_roots(tmp_path) -> None:
    local = tmp_path / "local"
    with TestClient(_app(local)) as client:
        default = client.get("/api/operator-settings")
        assert default.status_code == 200, default.text
        assert default.json() == {"revision": 0, "preferences": DEFAULTS}
        desired = {**DEFAULTS, "show_provider_details": False,
                   "show_keyboard_reference": False}
        saved = _save(client, 0, desired)
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"revision": 1, "preferences": desired}
        assert client.get("/api/operator-settings").json() == saved.json()

    # New FastAPI instance and new underlying ApiState -- no in-memory state.
    with TestClient(_app(local)) as reopened:
        assert reopened.get("/api/operator-settings").json() == saved.json()
        conflict = _save(reopened, 0, DEFAULTS)
        assert conflict.status_code == 409
        assert conflict.json()["error"] == "OPERATOR_SETTINGS_REVISION_CONFLICT"
        assert reopened.get("/api/operator-settings").json()["revision"] == 1
        reset = reopened.post("/api/operator-settings/reset", json={"expected_revision": 1})
        assert reset.status_code == 200, reset.text
        assert reset.json() == {"revision": 2, "preferences": DEFAULTS}

    with TestClient(_app(local)) as final:
        assert final.get("/api/operator-settings").json() == reset.json()
    with TestClient(_app(tmp_path / "unrelated")) as unrelated:
        assert unrelated.get("/api/operator-settings").json() == {
            "revision": 0, "preferences": DEFAULTS,
        }


def test_strict_allowlist_no_network_credentials_or_malformed_types(tmp_path) -> None:
    with TestClient(_app(tmp_path)) as client:
        for wrong in (
            {**DEFAULTS, "pc_api_key": "FORBIDDEN"},
            {**DEFAULTS, "allow_external_network": True},
            {**DEFAULTS, "show_keyboard_reference": "false"},
            {**DEFAULTS, "show_provider_details": 0},
        ):
            assert _save(client, 0, wrong).status_code == 422
        assert client.put("/api/operator-settings", json={
            "expected_revision": 0, "preferences": DEFAULTS,
            "risk_override": True,
        }).status_code == 422
        assert client.post("/api/operator-settings/reset", json={
            "expected_revision": 0, "provider_secret": "SK-TEST",
        }).status_code == 422
        assert _save(client, -1, DEFAULTS).status_code == 422
        assert _save(client, True, DEFAULTS).status_code == 422
        assert client.get("/api/operator-settings").json()["revision"] == 0

    path = tmp_path / "operator_settings.sqlite3"
    if path.exists():
        assert b"SK-TEST" not in path.read_bytes()
        assert b"risk_override" not in path.read_bytes()


def test_two_concurrent_clients_cannot_clobber_same_revision(tmp_path) -> None:
    with TestClient(_app(tmp_path)) as first, TestClient(_app(tmp_path)) as second:
        seed = _save(first, 0, DEFAULTS)
        assert seed.status_code == 200
        left = {**DEFAULTS, "show_provider_details": False}
        right = {**DEFAULTS, "show_keyboard_reference": False}
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(_save, first, 1, left),
                pool.submit(_save, second, 1, right),
            ]
            replies = [f.result() for f in futures]
        assert sorted(reply.status_code for reply in replies) == [200, 409]
        latest = first.get("/api/operator-settings").json()
        assert latest["revision"] == 2
        assert latest["preferences"] in (left, right)
        assert sum(reply.status_code == 200 for reply in replies) == 1


def test_corrupt_persisted_settings_fail_explicitly_instead_of_resetting(tmp_path) -> None:
    with TestClient(_app(tmp_path)) as client:
        assert _save(client, 0, DEFAULTS).status_code == 200
    db_path = tmp_path / "operator_settings.sqlite3"
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE operator_presentation_settings SET preferences_json=? WHERE singleton=1",
                   (json.dumps({"unrecognized_key": True}),))
    # Test the underlying validation directly: a malformed row may not be
    # silently treated as defaults. No public HTTP 200 is implied on corruption.
    from darkfleet.api.operator_settings import _connection, _current

    connection = _connection(tmp_path)
    try:
        from pydantic import ValidationError

        import pytest

        with pytest.raises(ValidationError):
            _current(connection)
    finally:
        connection.close()
