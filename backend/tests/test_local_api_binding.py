"""Regression: an unauthenticated local install must not be LAN-accessible by default."""

from __future__ import annotations

from pathlib import Path

from darkfleet.__main__ import _parser
from darkfleet.config.settings import Settings


def test_local_api_defaults_to_loopback(monkeypatch) -> None:
    monkeypatch.delenv("DARKFLEET_API_HOST", raising=False)
    settings = Settings()
    assert settings.api_host == "127.0.0.1"
    assert _parser().parse_args([]).host is None  # launcher uses Settings.api_host


def test_explicit_container_bind_remains_supported(monkeypatch) -> None:
    monkeypatch.setenv("DARKFLEET_API_HOST", "0.0.0.0")
    assert Settings().api_host == "0.0.0.0"


def test_compose_published_ports_are_host_loopback_only() -> None:
    compose = Path(__file__).resolve().parents[2] / "docker-compose.yml"
    content = compose.read_text(encoding="utf-8")
    assert '"127.0.0.1:8000:8000"' in content
    assert '"127.0.0.1:${DARKFLEET_WEB_PORT:-8080}:80"' in content
