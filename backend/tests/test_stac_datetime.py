"""Regression: a blank STAC datetime range must be OMITTED, not sent as "".

Planetary Computer answers `Datetime parameter  is invalid.` (HTTP 400) when the
key is present but empty, which broke every REAL scan that did not pin an
explicit time window. `datetime` is optional in the STAC API.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from darkfleet.providers import RealDataUnavailableError
from darkfleet.providers.stac import search_planetary_computer, stac_search

BBOX = (103.80, 1.24, 103.86, 1.28)


def _capture(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    class FakeResponse:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {"features": []}

        def raise_for_status(self) -> None:
            return None

    def fake_post(url: str, **kwargs: Any) -> FakeResponse:
        sent.append({"url": url, **kwargs})
        return FakeResponse()

    monkeypatch.setattr(httpx, "post", fake_post)
    return sent


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_datetime_is_omitted_from_the_query(
    monkeypatch: pytest.MonkeyPatch, blank: str | None
) -> None:
    sent = _capture(monkeypatch)
    stac_search("https://example.test/api/stac/v1", "sentinel-1-rtc", BBOX, blank or "")
    body = sent[0]["json"]
    assert "datetime" not in body, f"blank {blank!r} must not produce a datetime key"
    assert body["collections"] == ["sentinel-1-rtc"]
    assert body["bbox"] == list(BBOX)


def test_explicit_datetime_is_sent_verbatim(monkeypatch: pytest.MonkeyPatch) -> None:
    sent = _capture(monkeypatch)
    window = "2026-01-01T00:00:00Z/2026-01-31T00:00:00Z"
    stac_search("https://example.test/api/stac/v1", "sentinel-1-rtc", BBOX, window)
    assert sent[0]["json"]["datetime"] == window


def test_datetime_range_is_trimmed(monkeypatch: pytest.MonkeyPatch) -> None:
    sent = _capture(monkeypatch)
    window = "  2026-01-01T00:00:00Z/2026-01-31T00:00:00Z  "
    stac_search("https://example.test/api/stac/v1", "sentinel-1-rtc", BBOX, window)
    assert sent[0]["json"]["datetime"] == window.strip()


def test_blank_datetime_reaches_the_provider_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The high-level search must not re-introduce an empty string."""
    sent = _capture(monkeypatch)
    search_planetary_computer(BBOX, "", product="rtc")
    assert "datetime" not in sent[0]["json"]


def test_query_is_valid_json_and_carries_no_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent = _capture(monkeypatch)
    stac_search("https://example.test/api/stac/v1", "sentinel-1-rtc", BBOX, "")
    payload = json.dumps(sent[0]["json"])
    for secret_marker in ("token", "sig", "sas", "apikey", "api_key"):
        assert secret_marker not in payload.lower()


def test_provider_400_still_reports_the_real_cause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BadRequest:
        status_code = 400
        text = '{"code":"InvalidQueryParameter","description":"Datetime parameter  is invalid."}'

        def json(self) -> dict[str, Any]:
            return {"code": "InvalidQueryParameter"}

        def raise_for_status(self) -> None:
            raise httpx.HTTPStatusError("400", request=None, response=None)  # type: ignore[arg-type]

    monkeypatch.setattr(httpx, "post", lambda url, **kw: BadRequest())
    with pytest.raises(RealDataUnavailableError) as excinfo:
        stac_search("https://example.test/api/stac/v1", "sentinel-1-rtc", BBOX, "")
    assert "400" in str(excinfo.value.details)