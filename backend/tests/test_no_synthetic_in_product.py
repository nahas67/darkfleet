"""Synthetic scenes must be unreachable in the shipped configuration.

The synthetic scene catalogue used to be a user-facing runtime mode. It is now a
test harness behind ``Settings.allow_synthetic_scenes``, which is OFF by default
and which no client can turn on. These tests pin that, because a regression here
would let a user ask this API for fabricated observations and not be able to tell
them from measurements.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings

BBOX = [103.65, 1.1, 104.05, 1.4]


@pytest.fixture(scope="module")
def shipped(settings_factory: Any) -> Iterator[TestClient]:
    """Exactly the shipped configuration: no overrides beyond a temp data dir."""
    conf: Settings = settings_factory()
    conf.allow_synthetic_scenes = False
    with TestClient(create_app(conf)) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def harness(settings_factory: Any) -> Iterator[TestClient]:
    conf: Settings = settings_factory()
    conf.allow_synthetic_scenes = True
    with TestClient(create_app(conf)) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def settings_factory(tmp_path_factory: pytest.TempPathFactory) -> Any:
    counter = {"n": 0}

    def build() -> Settings:
        counter["n"] += 1
        conf = Settings(data_dir=str(tmp_path_factory.mktemp(f"df-{counter['n']}")))
        conf.log_level = "WARNING"
        return conf

    return build


# ------------------------------------------------------------- configuration


def test_synthetic_scenes_are_off_by_default() -> None:
    """The most important assertion: a default Settings cannot synthesise."""
    assert Settings().allow_synthetic_scenes is False


def test_runtime_mode_has_no_demo_variant() -> None:
    assert Settings().runtime_mode == "REAL"
    with pytest.raises(Exception):  # noqa: B017 - pydantic ValidationError
        Settings(runtime_mode="DEMO")


def test_env_cannot_silently_enable_synthetic_scenes(monkeypatch: pytest.MonkeyPatch) -> None:
    """It IS an env var, but it is opt-in and defaults off. Pinned deliberately."""
    monkeypatch.setenv("DARKFLEET_ALLOW_SYNTHETIC_SCENES", "true")
    assert Settings().allow_synthetic_scenes is True


# ------------------------------------------------------------------- the API


def test_runtime_mode_is_rejected_in_a_scan_request(shipped: TestClient) -> None:
    """A client cannot ask for a mode, because there is only one."""
    response = shipped.post(
        "/api/scans", json={"bbox": BBOX, "runtime_mode": "DEMO"}
    )
    assert response.status_code == 422
    body = response.text
    assert "runtime_mode" in body
    assert "extra_forbidden" in body


def test_scenes_request_for_demo_is_refused_not_upgraded(shipped: TestClient) -> None:
    """Refused loudly, so a caller is never handed live data believing it is not."""
    response = shipped.get("/api/scenes", params={"runtime_mode": "DEMO"})
    assert response.status_code == 404
    body = response.json()
    assert body["error"] == "SYNTHETIC_SCENES_DISABLED"
    assert "demo-synthesizer" not in response.text
    assert "SIM-" not in response.text


def test_shipped_scenes_endpoint_never_lists_synthetic(shipped: TestClient) -> None:
    """Whatever it answers, no synthetic scene is present in a shipped deployment."""
    response = shipped.get(
        "/api/scenes", params={"bbox": ",".join(str(v) for v in BBOX)}
    )
    assert response.status_code in (200, 404, 503)
    text = response.text
    assert "demo-synthesizer" not in text
    assert "SIM-S1" not in text


def test_shipped_scenes_requires_a_bbox(shipped: TestClient) -> None:
    """Scene discovery never falls back to a default extent."""
    response = shipped.get("/api/scenes")
    assert response.status_code == 400
    assert response.json()["error"] == "INVALID_REQUEST"


def test_shipped_health_does_not_advertise_a_demo_mode(shipped: TestClient) -> None:
    response = shipped.get("/api/providers/health")
    assert response.status_code == 200
    body = response.json()
    assert body["runtime_mode"] == "REAL"


# ------------------------------------------------------- liveness vs readiness


def test_liveness_is_served_outside_the_api_prefix(shipped: TestClient) -> None:
    """So an orchestrator probe is never mistaken for an analysis request."""
    response = shipped.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "darkfleet-api"
    assert body["version"]
    assert shipped.get("/api/health").status_code == 404


def test_liveness_touches_no_provider(shipped: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The regression this endpoint exists to prevent.

    The container healthcheck used to point at /api/providers/health, which
    performs a live provider probe. A slow third party therefore exceeded the 5s
    healthcheck timeout and Docker restarted a perfectly healthy API in a loop.
    Liveness must answer even when every provider is unreachable.
    """

    def explode(*args: object, **kwargs: object) -> None:
        raise AssertionError("liveness must not perform a network probe")

    monkeypatch.setattr(httpx, "get", explode)
    monkeypatch.setattr(httpx, "post", explode)

    response = shipped.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_provider_readiness_is_still_available_separately(shipped: TestClient) -> None:
    """The dependency-status surface is not lost, only separated from liveness."""
    response = shipped.get("/api/providers/health")
    assert response.status_code == 200
    assert "providers" in response.json()


# ------------------------------------------------------- the gate is real


def test_the_harness_setting_does_enable_synthetic_scenes(harness: TestClient) -> None:
    """Proves the gate is a live switch, not a hardcoded refusal."""
    response = harness.get("/api/scenes")
    assert response.status_code == 200
    body = response.json()
    assert body["synthetic"] is True
    assert body["provider"] == "demo-synthesizer"
    assert body["count"] >= 1


def test_synthetic_scan_is_still_marked_synthetic(harness: TestClient) -> None:
    """Even when enabled, synthetic output is labelled. Never passed off as real."""
    started = harness.post("/api/scans", json={"bbox": BBOX})
    assert started.status_code == 202
    accepted = started.json()
    assert accepted["runtime_mode"] == "DEMO"
    assert accepted["synthetic"] is True


def test_openapi_no_longer_advertises_a_demo_runtime_mode(shipped: TestClient) -> None:
    """The schema itself must not offer a synthetic mode to a client."""
    schema = json.loads(shipped.get("/openapi.json").text)
    body = (
        schema["components"]["schemas"]["ScanCreateRequest"]["properties"]
    )
    assert "runtime_mode" not in body, f"schema still advertises {sorted(body)}"