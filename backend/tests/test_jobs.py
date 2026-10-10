"""OPS-001/002/003 gate: the scan job state machine and its real-event runner.

Nothing here is timed. Workers block on each other with ``threading.Barrier``
and callers block on ``ScanRunner.wait_for`` or ``Queue.get(timeout=...)``, so a
failing job surfaces as a failing assertion instead of a flake. No percentages
appear anywhere in this file or in the logs it captures (OPS-003).
"""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from darkfleet.jobs import (
    ALL_STAGES,
    LEGAL_TRANSITIONS,
    PIPELINE,
    TERMINAL,
    IllegalTransitionError,
    ScanJob,
    ScanRunner,
    ScanStage,
    ScanWork,
    StageEvent,
    is_terminal,
    next_stage,
    validate_transition,
)

# The canonical states, in the order the machine must walk them.
#
# DERIVED from PIPELINE, not hand-written. This list used to be a literal copy,
# and GEO-CORR proved the cost: adding a stage left the copy stale and nine
# tests failed on a KeyError instead of on anything about geolocation. A mirror
# of an ordered list drifts the moment the list changes; this one cannot.
CANONICAL_STATES = [str(s) for s in ALL_STAGES]

# Real measured outcomes. The runner never edits these and never adds numbers.
DETAILS: dict[ScanStage, str] = {
    ScanStage.SEARCHING_SCENE: "scene S2B_MSIL1A_2026_07_14 found in catalog",
    ScanStage.READING_SAR: "read 3 assets, 10240x10240 window",
    ScanStage.PREPROCESSING: "calibrated, 3 looks, speckle filtered",
    ScanStage.MASKING: "masked 0 land pixels",
    ScanStage.FILTERING: "dropped 6 low-SNR components",
    ScanStage.DETECTING: "detected 41 components",
    ScanStage.EXTRACTING: "extracted 41 component polygons",
    ScanStage.GEOLOCATING: "geolocated 41 components; geolocation uncertainty 5.0 m",
    ScanStage.LOADING_AIS: "loaded 1284 AIS observations",
    ScanStage.ALIGNING: "aligned 2 candidate windows",
    ScanStage.CORRELATING: "matched 3 AIS targets within 250 m",
    ScanStage.SCORING: "scored 3 targets, 1 above threshold",
    ScanStage.PERSISTING: "persisted 1 scan and 3 targets",
    ScanStage.COMPLETE: "scan complete",
}

# DETAILS must cover every stage the machine can emit except QUEUED and FAILED,
# which the runner supplies itself. A missing entry would be a KeyError mid-walk,
# which is how a stale hand-written list failed in the first place.
_MISSING_DETAILS = [s for s in PIPELINE[1:] if s not in DETAILS]
assert not _MISSING_DETAILS, f"DETAILS is missing pipeline stages: {_MISSING_DETAILS}"

TIMEOUT = 15.0


# --------------------------------------------------------------------- workers


def _pipeline_work(details: dict[ScanStage, str] | None = None) -> Iterator[tuple[ScanStage, str]]:
    """Yields every stage after QUEUED once, in canonical order."""
    table = DETAILS if details is None else details
    for stage in PIPELINE[1:]:
        yield stage, table[stage]


def _raising_work() -> Iterator[tuple[ScanStage, str]]:
    """Finishes DETECTING, then dies during EXTRACTING."""
    for stage in PIPELINE[1:]:
        if stage is ScanStage.EXTRACTING:
            raise RuntimeError("sar window missing for tile 21/04")
        yield stage, DETAILS[stage]


def _skipping_work() -> Iterator[tuple[ScanStage, str]]:
    """Skips the whole middle of the pipeline: QUEUED -> SCORING is illegal."""
    yield ScanStage.SCORING, DETAILS[ScanStage.SCORING]
    yield ScanStage.COMPLETE, DETAILS[ScanStage.COMPLETE]


def _truncating_work() -> Iterator[tuple[ScanStage, str]]:
    """Completes PREPROCESSING, then returns without reaching a terminal state."""
    for stage in PIPELINE[1:]:
        if stage is ScanStage.MASKING:
            return
        yield stage, DETAILS[stage]


def _barrier_work(label: str, barrier: threading.Barrier) -> Iterator[tuple[ScanStage, str]]:
    """Every stage waits on a shared barrier, so two jobs genuinely overlap."""
    for stage in PIPELINE[1:]:
        barrier.wait()
        yield stage, f"{label} {DETAILS[stage]}"
    barrier.wait()


# --------------------------------------------------------------------- helpers


def _run_to_end(runner: ScanRunner, work: ScanWork, timeout: float = TIMEOUT) -> ScanJob:
    """Submit, block until terminal, and return the settled job snapshot."""
    job = runner.submit(work)
    assert runner.wait_for(job.scan_id, timeout), f"{job.scan_id} never reached a terminal state"
    settled = runner.get(job.scan_id)
    assert settled is not None
    return settled


def _drain(channel: queue.Queue[StageEvent], timeout: float = TIMEOUT) -> list[StageEvent]:
    """Block on the queue until the terminal event; never poll or sleep."""
    events: list[StageEvent] = []
    while True:
        try:
            event = channel.get(timeout=timeout)
        except queue.Empty:
            pytest.fail(f"subscriber queue stalled after {len(events)} event(s): {events}")
        events.append(event)
        if event.terminal:
            return events


# ------------------------------------------------------------------ OPS-001/003


def test_stage_machine_is_canonical() -> None:
    assert [stage.value for stage in ScanStage] == CANONICAL_STATES
    assert ALL_STAGES == tuple(ScanStage)
    # Deliberate tripwire: 16 states as of GEO-CORR, which added GEOLOCATING.
    # CANONICAL_STATES above is derived rather than hand-written, so this
    # literal is the one place a stage change has to be acknowledged by hand.
    assert len(ScanStage) == 16
    assert TERMINAL == {ScanStage.COMPLETE, ScanStage.FAILED}
    # FAILED is an exit, not a step in the pipeline.
    assert ScanStage.FAILED not in PIPELINE
    assert list(PIPELINE) == [ScanStage(name) for name in CANONICAL_STATES if name != "FAILED"]
    assert is_terminal(ScanStage.COMPLETE) and is_terminal(ScanStage.FAILED)
    assert next_stage(ScanStage.COMPLETE) is None
    assert next_stage(ScanStage.FAILED) is None


def test_legal_transitions_are_next_stage_plus_failed() -> None:
    assert set(LEGAL_TRANSITIONS) == set(ScanStage)
    for stage in ScanStage:
        assert LEGAL_TRANSITIONS[stage] <= set(ScanStage)
    for index, stage in enumerate(PIPELINE[:-1]):
        assert LEGAL_TRANSITIONS[stage] == frozenset(
            {PIPELINE[index + 1], ScanStage.FAILED}
        )
    # COMPLETE and FAILED are sinks: nothing leaves them.
    assert LEGAL_TRANSITIONS[ScanStage.COMPLETE] == frozenset()
    assert LEGAL_TRANSITIONS[ScanStage.FAILED] == frozenset()


@pytest.mark.parametrize(
    ("current", "target", "why"),
    [
        (ScanStage.QUEUED, ScanStage.SCORING, "skips forward"),
        (ScanStage.SCORING, ScanStage.SEARCHING_SCENE, "rewinds"),
        (ScanStage.DETECTING, ScanStage.DETECTING, "repeats"),
        (ScanStage.COMPLETE, ScanStage.FAILED, "leaves a terminal state"),
        (ScanStage.FAILED, ScanStage.COMPLETE, "leaves a terminal state"),
        (ScanStage.MASKING, ScanStage.QUEUED, "restarts"),
    ],
)
def test_illegal_transition_raises(current: ScanStage, target: ScanStage, why: str) -> None:
    with pytest.raises(IllegalTransitionError) as caught:
        validate_transition(current, target)
    assert current.value in str(caught.value)
    assert target.value in str(caught.value)
    assert why


def test_legal_transitions_return_the_target() -> None:
    assert validate_transition(ScanStage.SCORING, ScanStage.PERSISTING) is ScanStage.PERSISTING
    assert validate_transition(ScanStage.MASKING, ScanStage.FAILED) is ScanStage.FAILED
    assert validate_transition(ScanStage.QUEUED, ScanStage.SEARCHING_SCENE) is (
        ScanStage.SEARCHING_SCENE
    )


# --------------------------------------------------------------------- OPS-001


def test_happy_path_walks_every_stage_in_order() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _pipeline_work)

    assert job.stage is ScanStage.COMPLETE
    assert job.error is None
    assert job.failed_at is None
    assert job.finished_at is not None
    assert [event.stage for event in job.history] == [ScanStage.QUEUED, *PIPELINE[1:]]
    assert job.history[-1].stage is ScanStage.COMPLETE


def test_history_records_every_stage_with_timestamps() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _pipeline_work)

    # History is (stage, timestamp, detail) and unpacks as one.
    stage, timestamp, detail = job.history[0]
    assert stage is ScanStage.QUEUED
    assert detail == "created"
    assert timestamp.tzinfo is not None

    stamps = [event.timestamp for event in job.history]
    assert len(stamps) == len(PIPELINE)
    assert all(stamp.tzinfo is not None for stamp in stamps)
    assert stamps == sorted(stamps), "history timestamps must not go backwards"
    assert stamps[0] >= job.started_at
    assert stamps[-1] == job.finished_at

    # Every detail after QUEUED is the worker's own string, verbatim.
    assert [event.detail for event in job.history[1:]] == [
        DETAILS[stage] for stage in PIPELINE[1:]
    ]


def test_history_survives_a_returned_snapshot() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _pipeline_work)
    snapshot = runner.get(job.scan_id)
    assert snapshot is not None
    assert snapshot.history == job.history
    # Mutating a snapshot must not corrupt runner-owned state.
    snapshot.history.clear()
    fresh = runner.get(job.scan_id)
    assert fresh is not None
    assert len(fresh.history) == len(PIPELINE)


# --------------------------------------------------------------------- OPS-002


def test_worker_exception_fails_job_and_keeps_progress() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _raising_work)

    assert job.stage is ScanStage.FAILED
    assert job.error == "RuntimeError: sar window missing for tile 21/04"
    # Yields mean "stage finished", so the crash happened in EXTRACTING, the
    # successor of the last completed stage (DETECTING).
    assert job.failed_at is ScanStage.EXTRACTING
    assert job.history[-1].stage is ScanStage.FAILED
    assert job.history[-1].detail == "EXTRACTING aborted: sar window missing for tile 21/04"
    assert job.history[-1].terminal
    # Real progress is kept, not erased by the failure.
    assert [event.stage for event in job.history] == [
        ScanStage.QUEUED,
        ScanStage.SEARCHING_SCENE,
        ScanStage.READING_SAR,
        ScanStage.PREPROCESSING,
        ScanStage.MASKING,
        ScanStage.FILTERING,
        ScanStage.DETECTING,
        ScanStage.FAILED,
    ]
    assert job.history[-2].detail == DETAILS[ScanStage.DETECTING]
    assert job.finished_at is not None


def test_worker_failure_redacts_credentials_from_state_events_and_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A failing provider may include signed access details in its exception text."""
    marker = "SIGNED_SOURCE_CANARY_DO_NOT_EXPOSE"

    def failed_provider() -> Iterator[tuple[ScanStage, str]]:
        yield ScanStage.SEARCHING_SCENE, "search attempted"
        raise RuntimeError(
            f"catalog refused https://storage.invalid/blob?sig={marker}&access_token={marker}; "
            f"Authorization: Bearer {marker}; body={{\"apiKey\":\"{marker}\"}}"
        )

    caplog.set_level(logging.DEBUG, logger="darkfleet")
    runner = ScanRunner(tmp_path)
    job = _run_to_end(runner, failed_provider)

    assert job.stage is ScanStage.FAILED
    assert job.failed_at is ScanStage.READING_SAR
    assert job.error is not None and job.error.startswith("RuntimeError: catalog refused")
    assert job.history[-1].stage is ScanStage.FAILED
    assert "READING_SAR aborted: catalog refused" in job.history[-1].detail
    assert marker not in job.error
    assert marker not in job.history[-1].detail
    assert marker not in (tmp_path / "jobs" / f"{job.scan_id}.json").read_text(encoding="utf-8")
    assert marker not in "\n".join(record.getMessage() for record in caplog.records)
    assert marker not in "\n".join(event.detail for event in _drain(runner.subscribe(job.scan_id)))

    recovered = ScanRunner(tmp_path).get(job.scan_id)
    assert recovered is not None
    assert recovered.stage is ScanStage.FAILED
    assert recovered.failed_at is ScanStage.READING_SAR
    assert recovered.error == job.error


def test_successful_provider_stage_redacts_signed_tokens_before_any_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """An upstream STAC scene ID may contaminate a successful stage detail.

    Failure-only redaction cannot protect the durable job, logs or subscribers.
    Preserve scientific measurements and source identity while hiding secrets.
    """
    marker = "SUCCESS_STAGE_SIGNED_CANARY_DO_NOT_EXPOSE"
    normal = "scene selected S1A_FIXTURE_20240101T000000; resolution_m=10; 41 detections"
    provider_detail = (
        f"{normal}; https://storage.invalid/blob?sig={marker}&access_token={marker}; "
        f"Authorization: Bearer {marker}; body={{\"apiKey\":\"{marker}\"}}"
    )

    def work() -> Iterator[tuple[ScanStage, str]]:
        for stage in PIPELINE[1:]:
            yield stage, provider_detail if stage is ScanStage.SEARCHING_SCENE else DETAILS[stage]

    caplog.set_level(logging.INFO, logger="darkfleet")
    runner = ScanRunner(tmp_path)
    job = _run_to_end(runner, work)
    assert job.stage is ScanStage.COMPLETE
    assert job.error is None
    selected = job.history[1].detail
    assert normal in selected
    assert "sig=<redacted>" in selected
    assert "access_token=<redacted>" in selected
    assert "Bearer <redacted>" in selected
    assert marker not in selected
    assert marker not in (tmp_path / "jobs" / f"{job.scan_id}.json").read_text(encoding="utf-8")
    assert marker not in "\n".join(event.detail for event in _drain(runner.subscribe(job.scan_id)))
    assert marker not in "\n".join(record.getMessage() for record in caplog.records)

    restored = ScanRunner(tmp_path).get(job.scan_id)
    assert restored is not None and restored.stage is ScanStage.COMPLETE
    assert restored.history[1].detail == selected
    assert restored.history[-1].detail == DETAILS[ScanStage.COMPLETE]


def test_illegal_transition_from_worker_fails_the_job() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _skipping_work)

    assert job.stage is ScanStage.FAILED
    assert job.error is not None and job.error.startswith("IllegalTransitionError:")
    assert job.failed_at is ScanStage.SEARCHING_SCENE
    assert [event.stage for event in job.history] == [ScanStage.QUEUED, ScanStage.FAILED]
    # The skipping worker's data never reached history: it was not a legal stage.
    assert DETAILS[ScanStage.SCORING] not in [event.detail for event in job.history]


def test_worker_returning_without_a_terminal_stage_fails_the_job() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _truncating_work)

    assert job.stage is ScanStage.FAILED
    assert job.error is not None and "without yielding a terminal stage" in job.error
    # The worker returned before starting MASKING, so that is the unfinished stage.
    assert job.failed_at is ScanStage.MASKING
    assert [event.stage for event in job.history] == [
        ScanStage.QUEUED,
        ScanStage.SEARCHING_SCENE,
        ScanStage.READING_SAR,
        ScanStage.PREPROCESSING,
        ScanStage.FAILED,
    ]


def test_subscribe_receives_transitions_in_order() -> None:
    runner = ScanRunner()
    job = runner.submit(_pipeline_work)
    channel = runner.subscribe(job.scan_id)

    seen = _drain(channel)

    assert [event.stage for event in seen] == [ScanStage.QUEUED, *PIPELINE[1:]]
    assert [event.detail for event in seen[1:]] == [DETAILS[stage] for stage in PIPELINE[1:]]
    assert seen[-1].stage is ScanStage.COMPLETE
    assert seen[-1].terminal
    assert not any(event.terminal for event in seen[:-1])


def test_subscribe_after_completion_replays_recorded_history() -> None:
    runner = ScanRunner()
    job = _run_to_end(runner, _pipeline_work)
    seen = _drain(runner.subscribe(job.scan_id))

    assert [event.stage for event in seen] == [ScanStage.QUEUED, *PIPELINE[1:]]
    assert seen == job.history


def test_subscribe_to_unknown_scan_raises() -> None:
    runner = ScanRunner()
    with pytest.raises(KeyError):
        runner.subscribe("DF-9999")


def test_two_concurrent_jobs_keep_independent_state() -> None:
    runner = ScanRunner()
    barrier = threading.Barrier(2, timeout=TIMEOUT)
    first = runner.submit(lambda: _barrier_work("alpha", barrier))
    second = runner.submit(lambda: _barrier_work("bravo", barrier))

    assert runner.wait_for(first.scan_id, timeout=TIMEOUT)
    assert runner.wait_for(second.scan_id, timeout=TIMEOUT)

    assert first.scan_id == "DF-0001"
    assert second.scan_id == "DF-0002"
    assert runner.list() == [runner.get("DF-0001"), runner.get("DF-0002")]

    for job_id, label in ((first.scan_id, "alpha"), (second.scan_id, "bravo")):
        job = runner.get(job_id)
        assert job is not None
        assert job.stage is ScanStage.COMPLETE
        assert job.error is None
        assert [event.stage for event in job.history] == [ScanStage.QUEUED, *PIPELINE[1:]]
        # Each job's history carries only its own worker's measurements.
        assert all(event.detail.startswith(f"{label} ") for event in job.history[1:])


# --------------------------------------------------------------------- OPS-013


def test_restart_recovers_jobs_from_the_state_directory(tmp_path: Path) -> None:
    first_runner = ScanRunner(tmp_path)
    done = _run_to_end(first_runner, _pipeline_work)
    failed = _run_to_end(first_runner, _raising_work)
    assert done.stage is ScanStage.COMPLETE
    assert failed.stage is ScanStage.FAILED

    restarted = ScanRunner(tmp_path)

    assert [job.scan_id for job in restarted.list()] == [done.scan_id, failed.scan_id]
    recovered = restarted.get(done.scan_id)
    assert recovered is not None
    assert recovered.stage is ScanStage.COMPLETE
    assert recovered.history == done.history
    assert recovered.finished_at == done.finished_at
    recovered_failure = restarted.get(failed.scan_id)
    assert recovered_failure is not None
    assert recovered_failure.stage is ScanStage.FAILED
    assert recovered_failure.error == "RuntimeError: sar window missing for tile 21/04"
    assert recovered_failure.failed_at is ScanStage.EXTRACTING
    # A recovered terminal job is already settled: it never re-appears as running.
    assert restarted.wait_for(done.scan_id, timeout=0.0)


def test_restart_continues_the_scan_id_sequence(tmp_path: Path) -> None:
    first_runner = ScanRunner(tmp_path)
    assert _run_to_end(first_runner, _pipeline_work).scan_id == "DF-0001"
    assert _run_to_end(first_runner, _pipeline_work).scan_id == "DF-0002"

    restarted = ScanRunner(tmp_path)
    assert _run_to_end(restarted, _pipeline_work).scan_id == "DF-0003"


def test_ids_are_monotonic_and_zero_padded() -> None:
    runner = ScanRunner()
    ids = [_run_to_end(runner, _pipeline_work).scan_id for _ in range(3)]
    assert ids == ["DF-0001", "DF-0002", "DF-0003"]


# --------------------------------------------------------------------- OPS-007


def test_log_lines_are_structured_and_verbatim(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="darkfleet")
    runner = ScanRunner()
    job = _run_to_end(runner, _pipeline_work)

    lines = [record.getMessage() for record in caplog.records]
    assert f"SCAN   {job.scan_id} created" in lines
    assert f"CFAR   {job.scan_id} {DETAILS[ScanStage.DETECTING]}" in lines
    assert f"STORE  {job.scan_id} {DETAILS[ScanStage.PERSISTING]}" in lines
    assert f"SCAN   {job.scan_id} {DETAILS[ScanStage.COMPLETE]}" in lines
    # OPS-003: no invented percentages, ever.
    assert not [line for line in lines if "%" in line]


def test_failure_log_line_names_the_failing_stage(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="darkfleet")
    runner = ScanRunner()
    job = _run_to_end(runner, _raising_work)

    failures = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert failures == [f"FAIL   {job.scan_id} EXTRACTING aborted: sar window missing for tile 21/04"]
