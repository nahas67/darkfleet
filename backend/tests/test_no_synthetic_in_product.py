"""No synthetic code path may remain reachable in the shipped product.

The synthetic scene catalogue is gone. It was a user-facing runtime mode, then a
test harness behind ``Settings.allow_synthetic_scenes``, and now it does not exist
at all: there is no module, no catalogue, no setting, no request field and no
fallback. These tests pin that, because the regression they guard against is a
user asking this API for fabricated observations and not being able to tell them
from measurements they relied on.
"""

from __future__ import annotations

import importlib
import importlib.resources
import json
from collections.abc import Iterator
from typing import Any, Literal

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from darkfleet.api.app import create_app
from darkfleet.api.routes import __all__ as ROUTE_EXPORTS
from darkfleet.config.settings import Settings

BBOX = [104.1011, 1.3569, 104.1371, 1.3931]


@pytest.fixture(scope="module")
def settings_factory(tmp_path_factory: pytest.TempPathFactory) -> Any:
    counter = {"n": 0}

    def build() -> Settings:
        counter["n"] += 1
        conf = Settings(data_dir=str(tmp_path_factory.mktemp(f"df-{counter['n']}")))
        conf.log_level = "WARNING"
        return conf

    return build


@pytest.fixture(scope="module")
def shipped(settings_factory: Any) -> Iterator[TestClient]:
    """Exactly the shipped configuration: no overrides beyond a temp data dir."""
    with TestClient(create_app(settings_factory())) as test_client:
        yield test_client


# ------------------------------------------------------------- configuration


def test_settings_expose_no_synthetic_switch() -> None:
    """The gate is not "off by default" -- it is gone."""
    assert "allow_synthetic_scenes" not in Settings.model_fields
    assert not hasattr(Settings(), "allow_synthetic_scenes")
    assert "runtime_mode" in Settings.model_fields
    assert Settings.model_fields["runtime_mode"].annotation == Literal["REAL"]


def test_the_env_cannot_reach_a_synthetic_mode_either(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """There is no env var to switch it back on, and a DEMO env var is fatal.

    ``DARKFLEET_ALLOW_SYNTHETIC_SCENES`` is simply not read any more, and a
    deployment that still exports it fails loudly at startup rather than booting
    into a mode nobody can reach.
    """
    monkeypatch.setenv("DARKFLEET_ALLOW_SYNTHETIC_SCENES", "true")
    assert "allow_synthetic_scenes" not in Settings().model_dump()
    monkeypatch.setenv("DARKFLEET_RUNTIME_MODE", "DEMO")
    with pytest.raises(ValidationError):
        Settings()


def test_assigning_the_removed_setting_is_an_error_not_a_silent_no_op() -> None:
    """A stale caller must fail loudly rather than think it enabled something."""
    conf = Settings()
    with pytest.raises(ValueError):
        conf.allow_synthetic_scenes = True  # type: ignore[attr-defined]


def test_runtime_mode_has_no_demo_variant() -> None:
    assert Settings().runtime_mode == "REAL"
    with pytest.raises(ValidationError):
        Settings(runtime_mode="DEMO")


# ------------------------------------------------- the synthesiser is gone


def test_the_scene_synthesiser_module_does_not_exist() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("darkfleet.demo")


def test_no_synthetic_catalogue_is_exported_by_the_routes() -> None:
    """``DEMO_SCENES`` was the catalogue; it must not reappear under any name."""
    assert "DEMO_SCENES" not in ROUTE_EXPORTS
    from darkfleet.api import routes

    assert not [name for name in dir(routes) if "SCENE" in name.upper() and "SYNTH" in name.upper()]


def test_no_product_module_imports_the_synthesiser() -> None:
    """A dead import is still an import: it would fail the moment it returned."""
    import darkfleet

    root = importlib.resources.files(darkfleet)
    offenders = [
        path.name
        for path in root.rglob("*.py")
        if "darkfleet.demo" in path.read_text(encoding="utf-8")
    ]
    assert offenders == [], f"still imports the removed synthesiser: {offenders}"


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


def test_synthetic_is_rejected_in_a_scan_request(shipped: TestClient) -> None:
    response = shipped.post(
        "/api/scans", json={"bbox": BBOX, "synthetic": True}
    )
    assert response.status_code == 422
    assert "extra_forbidden" in response.text


def test_scenes_endpoint_ignores_a_demo_query_and_proxies_the_provider(
    shipped: TestClient,
) -> None:
    """A DEMO query is not an error and not an upgrade: it is simply not a field.

    The endpoint asks the real provider and reports whatever it gets. Whatever
    that is, it is never a synthetic scene.
    """
    response = shipped.get("/api/scenes", params={"runtime_mode": "DEMO"})
    assert response.status_code == 400
    assert response.json()["error"] == "INVALID_REQUEST"
    assert "SYNTHETIC_SCENES_DISABLED" not in response.text


def test_scenes_requires_a_bbox_and_never_falls_back_to_a_default_extent(
    shipped: TestClient,
) -> None:
    response = shipped.get("/api/scenes")
    assert response.status_code == 400
    assert response.json()["error"] == "INVALID_REQUEST"


@pytest.fixture
def providers_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every provider call fail, without touching the network.

    ``/api/providers/health`` performs a live provider probe by design, so a test
    that calls it against real settings reaches the public internet. That is the
    second genuine escape found by the socket blocker in ``backend/conftest.py``.

    These assertions are about the RESPONSE SHAPE -- that health never advertises
    a demo mode, and that the dependency surface still exists -- and none of that
    depends on a provider being up. Marking them ``live`` would have tested the
    provider instead of the contract, and would have made ordinary green CI
    require internet.
    """

    def explode(*args: Any, **kwargs: Any) -> Any:
        raise httpx.ConnectError("provider unreachable (test double)")

    monkeypatch.setattr(httpx, "get", explode)
    monkeypatch.setattr(httpx, "post", explode)


def test_shipped_health_does_not_advertise_a_demo_mode(
    shipped: TestClient, providers_unreachable: None
) -> None:
    response = shipped.get("/api/providers/health")
    assert response.status_code == 200
    body = response.json()
    assert body["runtime_mode"] == "REAL"


def test_openapi_no_longer_advertises_a_demo_runtime_mode(shipped: TestClient) -> None:
    """The schema itself must not offer a synthetic mode to a client."""
    schema = json.loads(shipped.get("/openapi.json").text)
    body = schema["components"]["schemas"]["ScanCreateRequest"]["properties"]
    assert "runtime_mode" not in body, f"schema still advertises {sorted(body)}"
    assert "synthetic" not in body


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


def test_provider_readiness_is_still_available_separately(
    shipped: TestClient, providers_unreachable: None
) -> None:
    """The dependency-status surface is not lost, only separated from liveness."""
    response = shipped.get("/api/providers/health")
    assert response.status_code == 200
    assert "providers" in response.json()