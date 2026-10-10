"""Abrupt *real process* scan-job ownership recovery, with no sensor activity.

Unlike a copied-state simulation, this test starts a distinct interpreter whose
ScanRunner holds the actual kernel owner byte lock on the exact durable root.
It terminates only that verified Popen child by its owned process handle, then
checks restart recovery and the HTTP history from the same on-disk state.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.jobs.models import ScanStage
from darkfleet.jobs.runner import JobNotOwnedError, ScanRunner

# The worker is a pure generator for testing durability, NOT a real scan.
# No provider, pipeline or sensor component is imported or invoked here.
_CHILD = """
import json
import os
import socket
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

root = Path(sys.argv[1])
egress_attempts = root / "child-egress-attempts.txt"
real_resolve = socket.getaddrinfo
real_connect = socket.socket.connect
real_connect_ex = socket.socket.connect_ex
real_create = socket.create_connection

def local_address(host):
    value = str(host).lower().strip("[]")
    return value in ("", "localhost", "localhost.localdomain", "::1") or value.startswith("127.")

def refuse(operation, host):
    with egress_attempts.open("a", encoding="utf-8") as record:
        record.write(f"{operation}: {host!r}\\n")
    raise RuntimeError("external network prohibited in isolated crash owner")

def guarded_resolve(host, port, *args, **kwargs):
    if not local_address(host):
        refuse("getaddrinfo", host)
    return real_resolve(host, port, *args, **kwargs)

def guarded_connect(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if not local_address(host):
        refuse("connect", host)
    return real_connect(self, address)

def guarded_connect_ex(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if not local_address(host):
        refuse("connect_ex", host)
    return real_connect_ex(self, address)

def guarded_create(address, *args, **kwargs):
    host = address[0] if isinstance(address, tuple) else address
    if not local_address(host):
        refuse("create_connection", host)
    return real_create(address, *args, **kwargs)

socket.getaddrinfo = guarded_resolve
socket.socket.connect = guarded_connect
socket.socket.connect_ex = guarded_connect_ex
socket.create_connection = guarded_create

from darkfleet.jobs.models import ScanStage
from darkfleet.jobs.runner import ScanRunner

signal = root / "owner-ready.json"
advanced = threading.Event()
park_forever = threading.Event()

def pure_state_machine_work():
    yield ScanStage.SEARCHING_SCENE, "test-only stage, no source acquired"
    advanced.set()  # Resumption proves the stage yield was persisted.
    park_forever.wait(300)
    raise RuntimeError("test-only process should have been killed")

runner = ScanRunner(root / "state")
created = runner.submit(pure_state_machine_work)
if not advanced.wait(12):
    raise RuntimeError("owned worker failed to reach the persisted test stage")
job = runner.get(created.scan_id)
if job is None or job.stage is not ScanStage.SEARCHING_SCENE:
    raise RuntimeError("job did not persist its expected nonterminal stage")
signal.write_text(json.dumps({
    "pid": os.getpid(),
    "scan_id": created.scan_id,
    "stage": job.stage.value,
    "ready_utc": datetime.now(UTC).isoformat(),
}), encoding="utf-8")
park_forever.wait(300)
raise RuntimeError("owner process not terminated by the acceptance harness")
"""


def _utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    assert parsed.tzinfo is not None and parsed.utcoffset() is not None
    return parsed.astimezone(UTC)


def _read_owner_signal(child: subprocess.Popen[bytes], marker: Path) -> dict:
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if marker.is_file():
            return json.loads(marker.read_text(encoding="utf-8"))
        assert child.poll() is None, (
            "owned child exited before publishing its live worker PID; "
            f"returncode={child.returncode}"
        )
        time.sleep(0.025)
    pytest.fail("test-owned child did not publish its durable stage and PID within 20 seconds")


def test_actual_killed_owner_process_recovers_as_interrupted_on_same_windows_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "crashed-process-only"
    root.mkdir()
    marker = root / "owner-ready.json"
    log_file = root / "child-stderr.txt"
    env = dict(os.environ)
    # Disable inherited Python startup overrides; explicitly use this repo's
    # package root and the uniquely owned temp root. No network client is used.
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    env["PYTHONUNBUFFERED"] = "1"
    started_utc = datetime.now(UTC)
    killed_utc: datetime | None = None
    child: subprocess.Popen[bytes] | None = None
    with log_file.open("wb") as stderr:
        try:
            child = subprocess.Popen(
                [sys.executable, "-c", _CHILD, str(root)],
                cwd=str(Path(__file__).resolve().parents[1]),
                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=stderr, creationflags=(
                    getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
                ),
            )
            assert child.pid > 0
            signal = _read_owner_signal(child, marker)
            assert signal["pid"] == child.pid
            assert signal["stage"] == "SEARCHING_SCENE"
            scan_id = signal["scan_id"]
            assert scan_id == "DF-0001"
            ready_utc = _utc(signal["ready_utc"])
            assert started_utc <= ready_utc <= datetime.now(UTC)
            assert child.poll() is None, "cannot kill a child which is no longer alive"

            state_root = root / "state"
            job_file = state_root / "jobs" / f"{scan_id}.json"
            owner_marker = state_root / "jobs" / f"{scan_id}.lock"
            assert owner_marker.is_file(), "the owning process must create its actual lock"
            original = job_file.read_bytes()
            recorded = json.loads(original)
            assert recorded["stage"] == "SEARCHING_SCENE"
            assert [event["stage"] for event in recorded["history"]] == [
                "QUEUED", "SEARCHING_SCENE",
            ]
            assert recorded["finished_at"] is None
            assert recorded["synthetic"] is False  # runner metadata, NOT sensor data
            queued_utc = _utc(recorded["history"][0]["timestamp"])
            stage_utc = _utc(recorded["history"][1]["timestamp"])
            assert started_utc <= queued_utc <= stage_utc <= ready_utc

            # A separate process is still alive and holding this exact kernel
            # lock. Constructing another ScanRunner must not fail it spuriously.
            concurrent = ScanRunner(state_root)
            active = concurrent.get(scan_id)
            assert active is not None and active.stage is ScanStage.SEARCHING_SCENE
            assert "ACTIVE_ELSEWHERE" in (active.error or "")
            assert concurrent.wait_for(scan_id, timeout=0.0) is False
            with pytest.raises(JobNotOwnedError, match="ACTIVE_ELSEWHERE"):
                concurrent.subscribe(scan_id)
            assert job_file.read_bytes() == original

            # Kill ONLY our own Popen process: no PID enumeration, process-group
            # kill, service, container or shared port is touched.
            assert signal["pid"] == child.pid and child.poll() is None
            killed_utc = datetime.now(UTC)
            child.kill()  # Windows: TerminateProcess on this owned handle.
            child.wait(timeout=10)
            assert child.poll() is not None
            assert child.returncode != 0
            assert job_file.read_bytes() == original, (
                "child termination cannot itself append a graceful terminal state"
            )

            # Fresh API state is built on the *original* root (never a copied
            # JSON or manufactured .lock). OS releases the byte lock on death.
            with TestClient(create_app(Settings(
                data_dir=str(root), api_host="127.0.0.1", log_level="WARNING",
            ))) as client:
                response = client.get(f"/api/scans/{scan_id}")
                assert response.status_code == 200, response.text
                recovered = response.json()
                assert recovered["source"] == "runner"
                assert recovered["stage"] == "FAILED"
                assert recovered["terminal"] is True
                assert recovered["failed_at"] == "READING_SAR"
                assert recovered["record_persisted"] is False
                assert "interrupted" in (recovered["error"] or "").lower()
                assert "execution was not resumed" in recovered["error"].lower()
                assert [event["stage"] for event in recovered["history"]] == [
                    "QUEUED", "SEARCHING_SCENE", "FAILED",
                ]
                assert recovered["history"][1]["detail"] == (
                    "test-only stage, no source acquired"
                )
                assert "aborted" in recovered["history"][-1]["detail"]
                assert client.app.state.darkfleet_state.runner.wait_for(scan_id, 0)

                sse = client.get(
                    f"/api/scans/{scan_id}/events", params={"timeout": 1},
                )
                assert sse.status_code == 200, sse.text
                frames = [
                    json.loads(line[len("data: "):])
                    for line in sse.text.splitlines() if line.startswith("data: ")
                ]
                assert [frame["stage"] for frame in frames] == [
                    "QUEUED", "SEARCHING_SCENE", "FAILED",
                ]
                assert frames[-1]["terminal"] is True
                assert not any(frame.get("timed_out") for frame in frames)

            disk_after = json.loads(job_file.read_text(encoding="utf-8"))
            assert disk_after["stage"] == "FAILED"
            assert disk_after["failed_at"] == "READING_SAR"
            assert len(disk_after["history"]) == 3
            assert disk_after["error"] == recovered["error"]
            assert disk_after["finished_at"] is not None
            failure_utc = _utc(disk_after["finished_at"])
            assert killed_utc is not None
            assert ready_utc <= killed_utc <= failure_utc <= datetime.now(UTC)
            assert owner_marker.is_file(), "lock marker persists after OS lock release"

            with TestClient(create_app(Settings(
                data_dir=str(root), api_host="127.0.0.1", log_level="WARNING",
            ))) as reopened:
                repeat = reopened.get(f"/api/scans/{scan_id}")
                assert repeat.status_code == 200, repeat.text
                assert repeat.json() == recovered
                assert reopened.app.state.darkfleet_state.runner.wait_for(scan_id, 0)
            assert json.loads(job_file.read_text(encoding="utf-8")) == disk_after
            assert not (root / "scans" / f"{scan_id}.json").exists(), (
                "mechanical crash test must not create a SAR observation"
            )
            assert not (root / "child-egress-attempts.txt").exists(), (
                "the test-owned job process attempted forbidden external network access"
            )
            print("REAL_JOB_CRASH_RECEIPT " + json.dumps({
                "child_pid": signal["pid"],
                "scan_id": scan_id,
                "child_started_after_utc": started_utc.isoformat(),
                "queued_event_utc": queued_utc.isoformat(),
                "searching_scene_event_utc": stage_utc.isoformat(),
                "child_ready_utc": ready_utc.isoformat(),
                "child_killed_at_utc": killed_utc.isoformat(),
                "recovered_failure_utc": failure_utc.isoformat(),
                "child_exit_code": child.returncode,
                "lock_marker_retained": owner_marker.is_file(),
                "state_history_stages": [entry["stage"] for entry in disk_after["history"]],
                "source_scan_created": False,
                "external_network_attempts": 0,
            }, sort_keys=True))
        finally:
            # Never terminate any PID other than the child launched above.
            if child is not None and child.poll() is None:
                child.kill()
                child.wait(timeout=10)
