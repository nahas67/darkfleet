"""AIS feed resilience: failure classification and backoff policy (AIS-016/017).

Policy ported from `gods-eye-view` (MIT, Copyright (c) 2026 Bilawal Sidhu).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from darkfleet.ais.resilience import (
    MAX_FRAME_BYTES,
    AistreamWatchdog,
    BackoffPolicy,
    Failure,
    FailureKind,
    classify_failure,
    frame_is_oversized,
    now_delay,
    parse_retry_after_ms,
)

# ------------------------------------------------------------------ classification


@pytest.mark.parametrize("status", [401, 403])
def test_credential_rejection_is_terminal(status: int) -> None:
    failure = classify_failure(http_status=status)
    assert failure.kind is FailureKind.AUTH
    assert not failure.retryable, "a rejected key must never take the fast ladder"


def test_rate_limit_is_classified_and_carries_retry_after() -> None:
    failure = classify_failure(http_status=429, retry_after="30")
    assert failure.kind is FailureKind.RATE_LIMIT
    assert failure.retry_after_ms == 30_000
    assert not failure.retryable


def test_other_http_failures_are_transport() -> None:
    assert classify_failure(http_status=500).kind is FailureKind.TRANSPORT
    assert classify_failure(http_status=503).kind is FailureKind.TRANSPORT


def test_upgrade_failure_is_recovered_from_the_message() -> None:
    """websockets hides the status in the text when no hook consumed it."""
    failure = classify_failure(message="unexpected server response: 401")
    assert failure.kind is FailureKind.AUTH
    assert failure.http_status == 401


@pytest.mark.parametrize(
    "text",
    [
        "Unauthorized",
        "invalid api key",
        "bad api_key",
        "Forbidden",
        "api key is missing",
    ],
)
def test_auth_text_is_recognised_without_a_status(text: str) -> None:
    assert classify_failure(message=text).kind is FailureKind.AUTH


@pytest.mark.parametrize(
    "text",
    ["rate limit exceeded", "Too Many Connections", "quota exceeded", "HTTP 429"],
)
def test_rate_text_is_recognised_without_a_status(text: str) -> None:
    assert classify_failure(message=text).kind is FailureKind.RATE_LIMIT


def test_unrecognised_error_defaults_to_transport() -> None:
    failure = classify_failure(message="connection reset by peer")
    assert failure.kind is FailureKind.TRANSPORT
    assert failure.retryable


def test_empty_input_still_classifies() -> None:
    failure = classify_failure()
    assert failure.kind is FailureKind.TRANSPORT
    assert failure.message


# ---------------------------------------------------------------- retry-after


def test_retry_after_accepts_delta_seconds() -> None:
    assert parse_retry_after_ms("120") == 120_000
    assert parse_retry_after_ms(45) == 45_000


def test_retry_after_accepts_an_http_date() -> None:
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after_ms("Wed, 01 Jan 2026 12:00:30 GMT", now) == 30_000


def test_retry_after_in_the_past_is_zero() -> None:
    now = datetime(2026, 1, 1, 12, 0, 30, tzinfo=UTC)
    assert parse_retry_after_ms("Wed, 01 Jan 2026 12:00:00 GMT", now) == 0


@pytest.mark.parametrize("raw", [None, "", "   ", "not-a-date", "12.5"])
def test_unparseable_retry_after_is_zero_not_a_long_wait(raw: object) -> None:
    assert parse_retry_after_ms(raw) == 0  # type: ignore[arg-type]


# ---------------------------------------------------------------- frame bound


def test_oversized_frames_are_refused() -> None:
    assert not frame_is_oversized(2048)
    assert not frame_is_oversized(MAX_FRAME_BYTES)
    assert frame_is_oversized(MAX_FRAME_BYTES + 1)


# ---------------------------------------------------------------- backoff ladder


def test_transport_walks_the_ladder_in_order() -> None:
    watchdog = AistreamWatchdog()
    delays = [watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x")) for _ in range(4)]
    assert delays == [5.0, 15.0, 60.0, 300.0]


def test_transport_beyond_the_ladder_slows_to_the_down_cadence() -> None:
    """The ladder length IS the attempt budget: down once the final rung is used."""
    watchdog = AistreamWatchdog()
    for _ in range(3):
        watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x"))
    assert not watchdog.down, "still working through the ladder"
    watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x"))
    assert watchdog.down
    assert watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x")) == 900.0


def test_success_resets_the_ladder() -> None:
    watchdog = AistreamWatchdog()
    watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x"))
    watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x"))
    watchdog.record_success()
    assert watchdog.consecutive_transport_failures == 0
    assert watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x")) == 5.0


def test_auth_failure_schedules_no_fast_retry() -> None:
    """The core rule: a rejected key must not be retried in a loop."""
    watchdog = AistreamWatchdog()
    assert watchdog.record_failure(Failure(FailureKind.AUTH, "invalid key")) == 0.0
    assert watchdog.auth_rejected
    assert watchdog.status() == "auth_rejected"
    assert watchdog.next_auth_probe_delay() == 3600.0


def test_auth_after_transport_still_clears_the_ladder() -> None:
    watchdog = AistreamWatchdog()
    watchdog.record_failure(Failure(FailureKind.TRANSPORT, "x"))
    watchdog.record_failure(Failure(FailureKind.AUTH, "invalid key"))
    assert watchdog.consecutive_transport_failures == 0


def test_rate_limit_honours_the_servers_pacing() -> None:
    watchdog = AistreamWatchdog()
    delay = watchdog.record_failure(Failure(FailureKind.RATE_LIMIT, "slow down", retry_after_ms=30_000))
    assert delay == 30.0
    assert watchdog.down


def test_rate_limit_without_retry_after_falls_back_to_the_down_cadence() -> None:
    watchdog = AistreamWatchdog()
    assert watchdog.record_failure(Failure(FailureKind.RATE_LIMIT, "slow down")) == 900.0


def test_hostile_retry_after_cannot_park_the_collector_forever() -> None:
    watchdog = AistreamWatchdog(BackoffPolicy(max_retry_after_s=900.0))
    delay = watchdog.record_failure(
        Failure(FailureKind.RATE_LIMIT, "wait", retry_after_ms=86_400_000)
    )
    assert delay == 900.0


def test_protocol_failure_advances_the_ladder() -> None:
    watchdog = AistreamWatchdog()
    watchdog.record_failure(Failure(FailureKind.PROTOCOL, "not JSON"))
    assert watchdog.consecutive_transport_failures == 1


# ------------------------------------------------- the property this exists for


@pytest.mark.parametrize("kind", list(FailureKind))
def test_persistent_failure_costs_single_digit_attempts_in_the_first_hour(
    kind: FailureKind,
) -> None:
    """Stated in the source as the invariant. Asserted here so it cannot regress.

    This includes the initial burst through the ladder, which is the number that
    actually protects a provider. Steady-state rate alone would hide it.
    """
    attempts = BackoffPolicy().attempts_in_first_hour(kind)
    assert attempts <= 9, (kind, attempts)


@pytest.mark.parametrize("kind", list(FailureKind))
def test_steady_state_rate_is_low(kind: FailureKind) -> None:
    assert BackoffPolicy().steady_state_attempts_per_hour(kind) <= 4.0, kind


def test_auth_is_the_cheapest_class_to_retry() -> None:
    policy = BackoffPolicy()
    assert policy.attempts_in_first_hour(FailureKind.AUTH) == 1
    assert policy.steady_state_attempts_per_hour(FailureKind.AUTH) < policy.steady_state_attempts_per_hour(
        FailureKind.TRANSPORT
    )


def test_protocol_failure_does_not_spin() -> None:
    """Regression: an undecodable payload once returned rung 0 forever.

    That was an unbounded 5-second loop - the exact hammer the policy exists to
    prevent - so the class is paced identically to a transport fault.
    """
    policy = BackoffPolicy()
    assert policy.attempts_in_first_hour(FailureKind.PROTOCOL) <= 9

    watchdog = AistreamWatchdog()
    delays = [
        watchdog.record_failure(Failure(FailureKind.PROTOCOL, "not JSON")) for _ in range(5)
    ]
    assert delays[:4] == [5.0, 15.0, 60.0, 300.0]
    assert delays[4] == 900.0


def test_a_longer_ladder_reduces_attempt_rate() -> None:
    """More rungs means MORE attempts in the first hour, so a short fast ladder
    is the aggressive choice; what protects the provider is the slow cadence
    after it, which both policies share."""
    short_fast = BackoffPolicy(ladder_s=(1.0,) * 8)
    patient = BackoffPolicy(ladder_s=(30.0, 120.0, 600.0, 1800.0))
    assert patient.attempts_in_first_hour(FailureKind.TRANSPORT) < short_fast.attempts_in_first_hour(
        FailureKind.TRANSPORT
    )


# ---------------------------------------------------------------- snapshot


def test_snapshot_never_claims_liveness_it_has_not_observed() -> None:
    watchdog = AistreamWatchdog()
    fresh = watchdog.snapshot()
    assert fresh["status"] == "live"
    assert fresh["last_kind"] is None

    watchdog.record_failure(classify_failure(http_status=401))
    after = watchdog.snapshot()
    assert after["status"] == "auth_rejected"
    assert after["last_kind"] == "AUTH"
    assert after["attempts_per_hour"] < 2.0


def test_now_delay_is_absolute_and_clock_injectable() -> None:
    base = datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)
    assert now_delay(30.0, base) == base + timedelta(seconds=30)
    assert now_delay(-5.0, base) == base, "a negative delay must not go backwards"