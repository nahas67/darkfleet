"""Offline restart acceptance for durable jobs with no surviving worker.

The interrupted state is copied from a *real* ScanRunner worker's persisted
in-flight JSON into a separate temporary app root. This models a process dying
between two stages without killing a background worker in the pytest process
or accessing the user's data/ tree. No sensor source is fabricated.
"""

from __future__ import annotations

import json
import shutil
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.jobs.models import PIPELINE, ScanStage
from darkfleet.jobs.runner import JobNotOwnedError, ScanRunner
from darkfleet.observability import logger as telemetry_logger


@pytest.fixture(autouse=True)
def _restore_test_client_logging() -> Iterator[None]:
    """App lifespan installs process-global logging; don't pollute other tests."""
    handlers = list(telemetry_logger.handlers)
    level, propagate = telemetry_logger.level, telemetry_logger.propagate
    try:
        yield
    finally:
        for handler in tuple(telemetry_logger.handlers):
            if handler not in handlers:
                telemetry_logger.removeHandler(handler)
        telemetry_logger.setLevel(level)
        telemetry_logger.propagate = propagate


def _blocked_job(state_dir: Path) -> tuple[ScanRunner, str, threading.Event]:
    """Submit a genuine job with a durably written SEARCHING_SCENE transition."""
    release = threading.Event()
    stage_yielded = threading.Event()

    def work() -> Iterator[tuple[ScanStage, str]]:
        yield ScanStage.SEARCHING_SCENE, "local test generator; 2 fixture candidates"
        stage_yielded.set()
        if not release.wait(10):
            raise RuntimeError("test-owned barrier timed out")
        for stage in PIPELINE[2:]:
            yield stage, f"measured {stage.value}"

    runner = ScanRunner(state_dir=state_dir)
    submitted = runner.submit(work)
    assert stage_yielded.wait(3), "worker did not reach the first completed stage"
    job = runner.get(submitted.scan_id)
    assert job is not None and job.stage is ScanStage.SEARCHING_SCENE
    state_file = state_dir / "jobs" / f"{submitted.scan_id}.json"
    persisted = json.loads(state_file.read_text(encoding="utf-8"))
    assert persisted["stage"] == ScanStage.SEARCHING_SCENE.value
    assert len(persisted["history"]) == 2
    return runner, submitted.scan_id, release


def test_restart_turns_orphan_persisted_job_into_truthful_terminal_api_history(tmp_path: Path) -> None:
    source_runner, scan_id, release = _blocked_job(tmp_path / "source" / "state")
    # The clone is independent. Its predecessor does not exist in that root;
    # neither state nor files in the user's production data directory are touched.
    app_root = tmp_path / "new-process-root"
    job_dir = app_root / "state" / "jobs"
    job_dir.mkdir(parents=True)
    shutil.copyfile(
        tmp_path / "source" / "state" / "jobs" / f"{scan_id}.json",
        job_dir / f"{scan_id}.json",
    )
    # Preserve the ownership-protocol marker, but not its kernel-held lock:
    # this copied root represents a crashed/replaced process.
    assert (tmp_path / "source" / "state" / "jobs" / f"{scan_id}.lock").is_file()
    # Windows does not permit opening the source byte-locked file for reading.
    # The file is only a marker; the new kernel lock in this copied root is free.
    (job_dir / f"{scan_id}.lock").touch()
    try:
        with TestClient(create_app(Settings(data_dir=str(app_root), log_level="WARNING"))) as client:
            state = client.get(f"/api/scans/{scan_id}")
            assert state.status_code == 200, state.text
            body = state.json()
            assert body["source"] == "runner"
            assert body["stage"] == "FAILED"
            assert body["terminal"] is True
            assert body["failed_at"] == "READING_SAR"
            assert "interrupted" in (body["error"] or "").lower()
            assert body["record_persisted"] is False
            assert [e["stage"] for e in body["history"]] == [
                "QUEUED", "SEARCHING_SCENE", "FAILED",
            ]
            assert body["history"][1]["detail"].endswith("2 fixture candidates")
            assert "aborted" in body["history"][-1]["detail"]

            events = client.get(f"/api/scans/{scan_id}/events", params={"timeout": 1})
            assert events.status_code == 200, events.text
            frames = [
                json.loads(line[len("data: "):])
                for line in events.text.splitlines() if line.startswith("data: ")
            ]
            assert [frame["stage"] for frame in frames] == [
                "QUEUED", "SEARCHING_SCENE", "FAILED",
            ]
            assert frames[-1]["terminal"] is True
            assert not any(frame.get("timed_out") for frame in frames)
            assert client.app.state.darkfleet_state.runner.wait_for(scan_id, timeout=0.0)

        persisted = json.loads((job_dir / f"{scan_id}.json").read_text(encoding="utf-8"))
        assert persisted["stage"] == "FAILED"
        assert persisted["failed_at"] == "READING_SAR"
        assert len(persisted["history"]) == 3

        # Second startup must not append a second fabricated interruption.
        with TestClient(create_app(Settings(data_dir=str(app_root), log_level="WARNING"))) as client:
            body = client.get(f"/api/scans/{scan_id}").json()
            assert body["stage"] == "FAILED"
            assert len(body["history"]) == 3
            assert body["error"] == persisted["error"]
    finally:
        release.set()
        assert source_runner.wait_for(scan_id, timeout=10)


def test_second_runner_does_not_falsely_fail_job_with_active_owner(tmp_path: Path) -> None:
    """An active writer still owns its job; merely reading its state is not a crash."""
    state_dir = tmp_path / "shared" / "state"
    first, scan_id, release = _blocked_job(state_dir)
    try:
        concurrent = ScanRunner(state_dir)
        ongoing = concurrent.get(scan_id)
        assert ongoing is not None
        assert ongoing.stage is ScanStage.SEARCHING_SCENE
        assert ongoing.finished_at is None
        assert not concurrent.wait_for(scan_id, timeout=0)
        assert json.loads((state_dir / "jobs" / f"{scan_id}.json").read_text())["stage"] == (
            "SEARCHING_SCENE"
        )
        with pytest.raises(JobNotOwnedError, match="ACTIVE_ELSEWHERE"):
            concurrent.subscribe(scan_id)
        with TestClient(create_app(Settings(
            data_dir=str(tmp_path / "shared"), log_level="WARNING",
        ))) as client:
            response = client.get(f"/api/scans/{scan_id}")
            assert response.status_code == 200
            assert response.json()["stage"] == "SEARCHING_SCENE"
            assert "ACTIVE_ELSEWHERE" in response.json()["error"]
            unavailable = client.get(f"/api/scans/{scan_id}/events", params={"timeout": 1})
            assert unavailable.status_code == 409
            assert unavailable.json()["error"] == "SCAN_STREAM_UNAVAILABLE"
            assert unavailable.json()["status"] == "ACTIVE_ELSEWHERE"
    finally:
        release.set()
        assert first.wait_for(scan_id, timeout=10)


def test_legacy_job_without_owner_evidence_is_not_falsely_terminal(tmp_path: Path) -> None:
    source, scan_id, release = _blocked_job(tmp_path / "source" / "state")
    app_root = tmp_path / "legacy-root"
    directory = app_root / "state" / "jobs"
    directory.mkdir(parents=True)
    snapshot = (tmp_path / "source" / "state" / "jobs" / f"{scan_id}.json").read_bytes()
    target = directory / f"{scan_id}.json"
    target.write_bytes(snapshot)  # intentionally no .lock evidence
    try:
        with TestClient(create_app(Settings(data_dir=str(app_root), log_level="WARNING"))) as client:
            response = client.get(f"/api/scans/{scan_id}")
            assert response.status_code == 200
            body = response.json()
            assert body["stage"] == "SEARCHING_SCENE"
            assert body["terminal"] is False
            assert "OWNERSHIP_UNVERIFIED" in (body["error"] or "")
            assert len(body["history"]) == 2
            assert client.app.state.darkfleet_state.runner.wait_for(scan_id, 0) is False
            stream = client.get(f"/api/scans/{scan_id}/events", params={"timeout": 1})
            assert stream.status_code == 409
            assert stream.json()["error"] == "SCAN_STREAM_UNAVAILABLE"
            assert stream.json()["status"] == "OWNERSHIP_UNVERIFIED"
        assert target.read_bytes() == snapshot
    finally:
        release.set()
        assert source.wait_for(scan_id, 10)


def test_rejected_thread_start_persists_failure_and_releases_ownership(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never strand QUEUED with a lock if creating the worker thread fails."""
    root = tmp_path / "startup-failure"
    runner = ScanRunner(root / "state")

    def reject_start(self: threading.Thread) -> None:
        raise RuntimeError("thread construction rejected locally")

    monkeypatch.setattr(threading.Thread, "start", reject_start)
    with pytest.raises(RuntimeError, match="thread construction rejected"):
        runner.submit(lambda: iter(()))
    state = runner.get("DF-0001")
    assert state is not None and state.stage is ScanStage.FAILED
    assert "thread construction rejected locally" in (state.error or "")
    assert state.failed_at is ScanStage.SEARCHING_SCENE
    assert runner.wait_for("DF-0001", timeout=0)
    assert json.loads((root / "state" / "jobs" / "DF-0001.json").read_text())["stage"] == (
        "FAILED"
    )
    restored = ScanRunner(root / "state").get("DF-0001")
    assert restored is not None and restored.stage is ScanStage.FAILED
    assert len(restored.history) == 2
