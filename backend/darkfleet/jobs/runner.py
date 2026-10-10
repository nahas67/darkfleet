"""Scan job runner (OPS-001, OPS-002, OPS-003, OPS-013).

A job is a **generator** supplied by the caller. The generator yields
``(ScanStage, detail)`` each time a stage's real work finishes; the runner
records that yield as a state transition, logs it, and appends it to the job's
history and to every subscriber queue. There is no timer, no ``sleep``, and no
progress arithmetic here: a state changes because work reported it.

Yield convention: ``yield (stage, detail)`` means *this stage just finished and
here is what it measured*. A worker that raises is therefore in the successor of
its last yield, and the runner recovers that stage from ``NEXT_STAGE`` and
records it as ``ScanJob.failed_at`` rather than guessing.

Rules this module enforces:

* a transition must be in ``LEGAL_TRANSITIONS`` or it raises;
* a worker that raises becomes ``FAILED`` with the error text preserved and the
  stage that was in flight identified from the canonical machine;
* a worker that returns without reaching ``COMPLETE`` becomes ``FAILED`` -- the
  runner will not invent a terminal state on the worker's behalf;
* ``detail`` preserves measured progress after credential-shaped values are
  redacted before logging, persistence and subscriber delivery;
* when a state directory is configured, every transition is written to disk so
  a fresh ``ScanRunner`` over the same directory sees prior jobs (OPS-013).
* in-progress durable jobs hold an OS-level file lock. On restart, only a job
  with a released owner lock is classified as interrupted; an active owner or
  legacy job without ownership evidence is not overwritten.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO, Final, NamedTuple

from darkfleet.jobs.models import (
    STAGE_TAGS,
    IllegalTransitionError,
    RuntimeMode,
    ScanStage,
    is_terminal,
    next_stage,
    validate_transition,
)

__all__ = [
    "JobNotOwnedError",
    "ScanJob",
    "ScanRunner",
    "ScanWork",
    "StageEvent",
    "default_state_dir",
    "redact_stage_detail",
]

logger = logging.getLogger("darkfleet")

#: A work function: a generator yielding one (stage, detail) per completed stage.
ScanWork = Callable[[], Iterator[tuple[ScanStage, str]]]

_STATE_DIR_ENV: Final[str] = "DARKFLEET_STATE_DIR"
_ID_WIDTH: Final[int] = 4
_ID_PREFIX: Final[str] = "DF-"
_AUTH_VALUE_RE: Final[re.Pattern[str]] = re.compile(
    r"(?i)\b(bearer|basic)(\s+)([^\s,;&\"']+)"
)
_SECRET_ASSIGNMENT_RE: Final[re.Pattern[str]] = re.compile(
    r"(?i)\b([a-z0-9_-]*(?:sig|signature|sas|token|key|secret|"
    r"password|passwd|credential|authorization))"
    r"[\"']?\s*[=:]\s*[\"']?([^\s,;&\"'}]+)"
)


def redact_stage_detail(detail: object) -> str:
    """Retain producer measurements, not embedded URL/authentication credentials.

    Called before storing all worker stages (including successful stages), so
    subscriber queues, durable JSON and logger messages share one safe detail.
    """
    value = str(detail)
    value = _AUTH_VALUE_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}<redacted>", value)
    def replace_assignment(match: re.Match[str]) -> str:
        # The preceding pass has already masked the bearer/basic secret. Keep
        # the harmless scheme in an Authorization header as diagnostic context.
        if match.group(1).lower() == "authorization" and match.group(2).lower() in {
            "bearer", "basic",
        }:
            return match.group(0)
        return f"{match.group(1)}=<redacted>"

    return _SECRET_ASSIGNMENT_RE.sub(
        replace_assignment, value
    )


class StageEvent(NamedTuple):
    """One real state transition: which stage, when, and what was measured.

    A NamedTuple so it *is* the ``(stage, timestamp, detail)`` tuple the contract
    asks for: it unpacks, indexes, and compares as a tuple, and still carries
    named fields for readable call sites.
    """

    stage: ScanStage
    timestamp: datetime
    detail: str

    @property
    def terminal(self) -> bool:
        """True when this event ends the job (COMPLETE or FAILED)."""
        return is_terminal(self.stage)


class JobNotOwnedError(RuntimeError):
    """A restored in-flight job has no worker or event channel on this runner."""

    def __init__(self, scan_id: str, reason: str) -> None:
        self.reason = reason
        super().__init__(f"{scan_id}: {reason}; no local worker or live event stream")


@dataclass(slots=True)
class ScanJob:
    """One scan's authoritative state, history and outcome."""

    scan_id: str
    stage: ScanStage = ScanStage.QUEUED
    history: list[StageEvent] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    error: str | None = None
    runtime_mode: RuntimeMode = RuntimeMode.REAL
    synthetic: bool = False
    # Additive: the pipeline stage that was in flight when the job failed.
    # ``stage`` becomes FAILED, so this is how the failure location survives.
    failed_at: ScanStage | None = None

    def snapshot(self) -> ScanJob:
        """A detached copy, so callers cannot mutate runner-owned state."""
        return replace(self, history=list(self.history))


def default_state_dir() -> Path:
    """State directory from ``DARKFLEET_STATE_DIR`` or ``data/state``."""
    configured = os.environ.get(_STATE_DIR_ENV)
    return Path(configured) if configured else Path("data") / "state"


class ScanRunner:
    """Submits generator jobs, runs them on background threads, records truth."""

    def __init__(self, state_dir: Path | str | None = None) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, ScanJob] = {}
        self._order: list[str] = []
        self._subscribers: dict[str, list[queue.Queue[StageEvent]]] = {}
        self._done: dict[str, threading.Event] = {}
        self._owner_locks: dict[str, BinaryIO] = {}
        self._unowned: dict[str, str] = {}
        self._next_id = 1
        if state_dir is None:
            self._state_dir: Path | None = None
        else:
            self._state_dir = Path(state_dir)
            (self._state_dir / "jobs").mkdir(parents=True, exist_ok=True)
            self._load_prior_jobs()

    # ---------------------------------------------------------------- queries

    def get(self, scan_id: str) -> ScanJob | None:
        """Current state of one job, or None if this runner never saw it."""
        with self._lock:
            job = self._jobs.get(scan_id)
            return job.snapshot() if job is not None else None

    def list(self) -> list[ScanJob]:
        """Every known job, oldest submission first."""
        with self._lock:
            return [self._jobs[scan_id].snapshot() for scan_id in self._order]

    def subscribe(self, scan_id: str) -> queue.Queue[StageEvent]:
        """A queue of this job's real transitions, oldest first.

        Seeding is honest: the queue is filled, under the runner lock, with the
        transitions already recorded, then receives live ones. No transition is
        skipped, duplicated, or invented. The last event is terminal, so an SSE
        consumer can stop on ``event.terminal`` without polling the job.
        """
        with self._lock:
            job = self._jobs.get(scan_id)
            if job is None:
                raise KeyError(f"unknown scan {scan_id!r}")
            if reason := self._unowned.get(scan_id):
                raise JobNotOwnedError(scan_id, reason)
            channel: queue.Queue[StageEvent] = queue.Queue()
            for event in job.history:
                channel.put(event)
            self._subscribers.setdefault(scan_id, []).append(channel)
            return channel

    def wait_for(self, scan_id: str, timeout: float = 10.0) -> bool:
        """Block until the job reaches a terminal state. True if it did."""
        with self._lock:
            done = self._done.get(scan_id)
            unowned = scan_id in self._unowned
        if done is None:
            raise KeyError(f"unknown scan {scan_id!r}")
        if unowned:
            return False
        return done.wait(timeout)

    # ---------------------------------------------------------------- control

    def submit(
        self,
        work: ScanWork,
        *,
        runtime_mode: RuntimeMode | str = RuntimeMode.REAL,
        synthetic: bool = False,
    ) -> ScanJob:
        """Create a QUEUED job and drive ``work`` to completion in a thread.

        The returned snapshot is the job *as created* (QUEUED, one event). Re-read
        with :meth:`get` for live state: the worker thread starts before this
        returns, so the job may already have advanced.
        """
        mode = RuntimeMode(runtime_mode)
        with self._lock:
            scan_id = self._allocate_id()
            if not self._try_acquire_owner_lock(scan_id):
                raise RuntimeError(
                    f"Job {scan_id} has an active/unavailable state-directory owner; "
                    "refusing to overwrite its durable state."
                )
            job = ScanJob(
                scan_id=scan_id,
                runtime_mode=mode,
                synthetic=synthetic,
            )
            self._jobs[scan_id] = job
            self._order.append(scan_id)
            self._done[scan_id] = threading.Event()
            self._append(job, StageEvent(ScanStage.QUEUED, _utcnow(), "created"))
            created = job.snapshot()
        logger.info("%s", self._line(job, "created"))
        thread = threading.Thread(
            target=self._drive,
            args=(scan_id, work),
            name=f"darkfleet-{scan_id}",
            daemon=True,
        )
        try:
            thread.start()
        except Exception as exc:
            # A rejected thread start must not leave a permanently QUEUED job
            # holding the owner lock with no worker and no terminal event.
            self._record_failure(scan_id, exc, illegal=False)
            raise
        return created

    # ------------------------------------------------------------------ worker

    def _drive(self, scan_id: str, work: ScanWork) -> None:
        """Consume the generator on this thread, one yield per real stage."""
        try:
            for stage, detail in work():
                self._advance(scan_id, stage, detail)
        except IllegalTransitionError as exc:
            if self._record_failure(scan_id, exc, illegal=True):
                return
            logger.error("SCAN   %s rejected transition: %s", scan_id, redact_stage_detail(exc))
        except Exception as exc:  # noqa: BLE001 - job outcome, not runner crash
            self._record_failure(scan_id, exc, illegal=False)
        else:
            self._record_incomplete(scan_id)

    def _advance(self, scan_id: str, stage: ScanStage, detail: str) -> None:
        """Validate and commit one yielded stage, then publish it."""
        with self._lock:
            job = self._require(scan_id)
            validate_transition(job.stage, stage)
            job.stage = stage
            safe_detail = redact_stage_detail(detail)
            self._append(job, StageEvent(stage, _utcnow(), safe_detail))
            line = self._line(job, safe_detail)
        logger.info("%s", line)
        if is_terminal(stage):
            self._close(scan_id)

    def _record_failure(self, scan_id: str, exc: BaseException, *, illegal: bool) -> bool:
        """Move a job to FAILED. False when the job was already terminal."""
        with self._lock:
            job = self._require(scan_id)
            if is_terminal(job.stage):
                return False
            failed_at = next_stage(job.stage)
            where = failed_at.value if failed_at else job.stage.value
            job.stage = ScanStage.FAILED
            job.failed_at = failed_at
            safe_cause = redact_stage_detail(exc)
            job.error = f"{type(exc).__name__}: {safe_cause}"
            detail = (
                f"{where} rejected: {safe_cause}" if illegal else f"{where} aborted: {safe_cause}"
            )
            self._append(job, StageEvent(ScanStage.FAILED, _utcnow(), detail))
            line = self._line(job, detail)
        logger.error("%s", line)
        self._close(scan_id)
        return True

    def _record_incomplete(self, scan_id: str) -> None:
        """The worker returned without a terminal state: that is a failure."""
        with self._lock:
            job = self._require(scan_id)
            if is_terminal(job.stage):
                return
            where = job.stage.value
            detail = f"work function returned in {where} without yielding a terminal stage"
            unstarted = next_stage(job.stage)
            job.stage = ScanStage.FAILED
            job.failed_at = unstarted
            job.error = detail
            self._append(job, StageEvent(ScanStage.FAILED, _utcnow(), detail))
            line = self._line(job, detail)
        logger.error("%s", line)
        self._close(scan_id)

    # ---------------------------------------------------------------- plumbing

    def _append(self, job: ScanJob, event: StageEvent) -> None:
        """Record one event, fan it out, and persist. Caller holds the lock."""
        job.history.append(event)
        if is_terminal(event.stage):
            job.finished_at = event.timestamp
        for channel in self._subscribers.get(job.scan_id, ()):
            channel.put(event)
        self._persist(job)

    def _close(self, scan_id: str) -> None:
        """Drop subscribers and release anyone in wait_for."""
        with self._lock:
            self._subscribers.pop(scan_id, None)
            done = self._done.get(scan_id)
        if done is not None:
            done.set()
        self._release_owner_lock(scan_id)

    def _owner_lock_path(self, scan_id: str) -> Path | None:
        if self._state_dir is None:
            return None
        return self._state_dir / "jobs" / f"{scan_id}.lock"

    def _try_acquire_owner_lock(self, scan_id: str) -> bool:
        """Use a kernel-held byte lock to distinguish live writers from orphans.

        Keep the lock file across restart; only the OS lock (released when a
        process exits) determines whether the previous writer is still alive.
        """
        path = self._owner_lock_path(scan_id)
        if path is None:
            return True
        try:
            handle = path.open("a+b")
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if "handle" in locals():
                handle.close()
            return False
        self._owner_locks[scan_id] = handle
        return True

    def _release_owner_lock(self, scan_id: str) -> None:
        handle = self._owner_locks.pop(scan_id, None)
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError as exc:
            logger.warning("SCAN   %s could not release state lock: %s", scan_id, exc)
        finally:
            handle.close()

    def _require(self, scan_id: str) -> ScanJob:
        job = self._jobs.get(scan_id)
        if job is None:  # pragma: no cover - threads only touch known jobs
            raise KeyError(f"unknown scan {scan_id!r}")
        return job

    def _allocate_id(self) -> str:
        """Monotonic ``DF-0001``.. ids. Caller holds the lock."""
        scan_id = f"{_ID_PREFIX}{self._next_id:0{_ID_WIDTH}d}"
        self._next_id += 1
        return scan_id

    def _line(self, job: ScanJob, detail: str) -> str:
        """``CFAR   DF-0001 detected 41 components`` -- tag, id, real detail."""
        return f"{STAGE_TAGS[job.stage]:<7}{job.scan_id} {detail}"

    # ------------------------------------------------------------- persistence

    def _persist(self, job: ScanJob) -> None:
        """Atomically write one job to the state directory. Best effort."""
        path = self._job_path(job.scan_id)
        if path is None:
            return
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(_to_json(job), indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:  # a full disk must not kill a real scan
            logger.warning("SCAN   %s could not persist state: %s", job.scan_id, exc)

    def _job_path(self, scan_id: str) -> Path | None:
        if self._state_dir is None:
            return None
        return self._state_dir / "jobs" / f"{scan_id}.json"

    def _load_prior_jobs(self) -> None:
        """Adopt jobs written by an earlier process (OPS-013 restart)."""
        assert self._state_dir is not None
        for path in sorted((self._state_dir / "jobs").glob("DF-*.json")):
            try:
                job = _from_json(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError, KeyError) as exc:
                logger.warning("SCAN   skipping unreadable state %s: %s", path.name, exc)
                continue
            self._jobs[job.scan_id] = job
            self._order.append(job.scan_id)
            self._done[job.scan_id] = threading.Event()
            if is_terminal(job.stage):
                self._done[job.scan_id].set()
            else:
                path = self._owner_lock_path(job.scan_id)
                if path is None or not path.is_file():
                    # Legacy records provide no evidence of previous ownership.
                    # Keep their last measured stage, but warn API consumers.
                    job.error = (
                        "OWNERSHIP_UNVERIFIED: no local worker is attached to "
                        "this restored job and no prior owner lock was recorded."
                    )
                    self._unowned[job.scan_id] = "OWNERSHIP_UNVERIFIED"
                    logger.warning("SCAN   %s restored without ownership proof", job.scan_id)
                elif self._try_acquire_owner_lock(job.scan_id):
                    self._record_failure(
                        job.scan_id,
                        InterruptedError(
                            "job worker interrupted before completion on restart; "
                            "execution was not resumed"
                        ),
                        illegal=False,
                    )
                else:
                    job.error = (
                        "ACTIVE_ELSEWHERE: no local worker is attached; an external "
                        "process still owns this job's durable state."
                    )
                    self._unowned[job.scan_id] = "ACTIVE_ELSEWHERE"
                    logger.warning("SCAN   %s is owned by another active runner", job.scan_id)
            try:
                self._next_id = max(self._next_id, int(job.scan_id.removeprefix(_ID_PREFIX)) + 1)
            except ValueError:  # pragma: no cover - non-numeric id on disk
                continue
        if self._order:
            logger.info("SCAN   restored %d job(s) from %s", len(self._order), self._state_dir)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _to_json(job: ScanJob) -> dict[str, Any]:
    return {
        "scan_id": job.scan_id,
        "stage": job.stage.value,
        "history": [
            {"stage": e.stage.value, "timestamp": e.timestamp.isoformat(), "detail": e.detail}
            for e in job.history
        ],
        "started_at": job.started_at.isoformat(),
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "error": job.error,
        "runtime_mode": job.runtime_mode.value,
        "synthetic": job.synthetic,
        "failed_at": job.failed_at.value if job.failed_at else None,
    }


def _parse_ts(raw: str) -> datetime:
    stamp = datetime.fromisoformat(raw)
    return stamp if stamp.tzinfo is not None else stamp.replace(tzinfo=UTC)


def _from_json(raw: dict[str, Any]) -> ScanJob:
    history = [
        StageEvent(
            ScanStage(item["stage"]),
            _parse_ts(item["timestamp"]),
            str(item["detail"]),
        )
        for item in raw["history"]
    ]
    failed_raw = raw.get("failed_at")
    return ScanJob(
        scan_id=str(raw["scan_id"]),
        stage=ScanStage(raw["stage"]),
        history=history,
        started_at=_parse_ts(raw["started_at"]),
        finished_at=_parse_ts(raw["finished_at"]) if raw.get("finished_at") else None,
        error=raw.get("error"),
        runtime_mode=RuntimeMode(raw.get("runtime_mode", RuntimeMode.REAL.value)),
        synthetic=bool(raw.get("synthetic", False)),
        failed_at=ScanStage(failed_raw) if failed_raw else None,
    )
