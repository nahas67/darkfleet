"""Public HTTP and event responses must not disclose source access credentials."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.api import routes
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.jobs.models import PIPELINE, ScanStage
from darkfleet.jobs.runner import ScanJob, StageEvent
from darkfleet.providers import ProviderStatus, RealDataUnavailableError

AOI = [103.7, 1.1, 103.9, 1.3]
SECRET = "DO_NOT_EXPOSE_ACCESS_SIGNATURE"


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    conf = Settings(data_dir=str(tmp_path))
    with TestClient(create_app(conf)) as test_client:
        yield test_client


def _unavailable(*args: object, **kwargs: object) -> None:
    raise RealDataUnavailableError(
        f"Provider request failed: https://storage.invalid/a?sig={SECRET}",
        details={
            "provider": f"https://catalog.invalid/search?sig={SECRET}",
            "asset_url": f"https://storage.invalid/a?sig={SECRET}",
            "access_token": SECRET,
            "accessToken": SECRET,
            "nested": {"X-Amz-Signature": SECRET},
            "http": 403,
        },
        suggestions=[f"Retry token={SECRET}"],
    )


def test_provider_exception_handler_redacts_message_and_nested_details(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(routes, "_search_provider", _unavailable)
    response = client.post("/api/scans", json={"bbox": AOI})
    assert response.status_code == 503, response.text
    assert response.json()["status"] == "AUTH_REQUIRED"
    assert response.json()["detail"]["http"] == 403
    assert SECRET not in response.text


def test_explicit_scene_provider_error_redacts_nested_details(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(routes, "_search_provider", _unavailable)
    response = client.get("/api/scenes", params={"bbox": ",".join(str(v) for v in AOI)})
    assert response.status_code == 503, response.text
    assert response.json()["status"] == "AUTH_REQUIRED"
    assert SECRET not in response.text


def test_job_history_and_sse_redact_provider_error_details(client: TestClient) -> None:
    def failure() -> Iterator[tuple[ScanStage, str]]:
        raise RuntimeError(f"upstream signed URL https://storage.invalid/a?sig={SECRET}")
        yield  # pragma: no cover -- creates the generator

    runner = client.app.state.darkfleet_state.runner
    submitted = runner.submit(failure)
    assert runner.wait_for(submitted.scan_id, 5)
    state = client.get(f"/api/scans/{submitted.scan_id}")
    assert state.status_code == 200
    assert state.json()["stage"] == "FAILED"
    assert state.json()["history"][-1]["stage"] == "FAILED"
    assert SECRET not in state.text
    events = client.get(f"/api/scans/{submitted.scan_id}/events")
    assert events.status_code == 200
    frames = [
        json.loads(line.removeprefix("data: "))
        for line in events.text.splitlines()
        if line.startswith("data: ")
    ]
    assert frames[-1]["terminal"] is True
    assert SECRET not in events.text


def test_success_stage_details_remain_measured_but_never_expose_signed_credentials(
    client: TestClient,
) -> None:
    """A successful producer event must be safe through runner, HTTP and SSE."""
    detail = (
        f"scene selected S1A_FIXTURE_20240101T000000; resolution_m=10; "
        f"https://storage.invalid/a?sig={SECRET}&access_token={SECRET}; "
        f"Authorization: Bearer {SECRET}; body={{\"apiKey\":\"{SECRET}\"}}"
    )

    def work() -> Iterator[tuple[ScanStage, str]]:
        for stage in PIPELINE[1:]:
            yield stage, detail if stage is ScanStage.SEARCHING_SCENE else f"measured {stage.value}"

    runner = client.app.state.darkfleet_state.runner
    job = runner.submit(work)
    assert runner.wait_for(job.scan_id, 5)
    state = client.get(f"/api/scans/{job.scan_id}")
    events = client.get(f"/api/scans/{job.scan_id}/events")
    assert state.status_code == 200
    assert events.status_code == 200
    assert state.json()["stage"] == "COMPLETE"
    selected = next(h["detail"] for h in state.json()["history"] if h["stage"] == "SEARCHING_SCENE")
    assert "S1A_FIXTURE_20240101T000000" in selected
    assert "resolution_m=10" in selected
    assert "sig=<redacted>" in selected
    assert SECRET not in state.text
    assert SECRET not in events.text
    assert events.text.count("event: stage") == len(PIPELINE)


def test_legacy_raw_stage_detail_is_redacted_at_api_history_and_sse_boundaries() -> None:
    """Old persisted stage details could predate runner-side sanitization."""
    raw = (
        f"scene selected S1A; resolution_m=10; sig={SECRET}; "
        f"Authorization: Bearer {SECRET}; body={{\"apiKey\":\"{SECRET}\"}}"
    )
    event = StageEvent(ScanStage.SEARCHING_SCENE, datetime.now(UTC), raw)
    historical = ScanJob(scan_id="DF-0001", stage=ScanStage.SEARCHING_SCENE, history=[event])
    details = routes._job_events(historical)
    frame = routes._sse(
        {"stage": event.stage.value, "timestamp": event.timestamp.isoformat(), "detail": raw}
    )
    assert SECRET not in details[0].detail
    assert SECRET not in frame
    assert "scene selected S1A; resolution_m=10" in details[0].detail
    assert "scene selected S1A; resolution_m=10" in frame


@pytest.mark.parametrize("collections", [None, 0, "invalid", {"id": "sentinel-1-rtc"}])
def test_malformed_provider_collection_document_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, collections: object
) -> None:
    monkeypatch.setattr(
        routes, "_probe_json", lambda url: (200, {"collections": collections})
    )
    probe = routes._probe_collections(
        "https://catalog.invalid/collections", "planetary-computer", "sentinel-1-rtc"
    )
    assert probe["status"] is ProviderStatus.UNAVAILABLE
    assert probe["error"] == "catalog collections must be an array"
