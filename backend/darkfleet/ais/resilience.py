"""AIS feed failure classification and backoff policy (AIS-016, AIS-017).

Policy ported from ``gods-eye-view`` (MIT, Copyright (c) 2026 Bilawal Sidhu) --
see ``docs/PLAN_DEMO_REMOVAL_AND_ADOPTION.md``. Ported as POLICY rather than
copied as code: the archive is JavaScript and this collector is Python, so the
translation is a documented reimplementation. The governing rule is unchanged:

    Only ``TRANSPORT`` walks the fast backoff ladder. An auth rejection cannot be
    fixed by retrying, and a rate limit must honour the server's own pacing.
    Treating either as a generic error is how a watchdog becomes a hammer.

The property that makes this correct, and the one asserted in the tests:

    Steady-state failure must cost single-digit connection attempts per hour in
    EVERY class.

A naive "retry with backoff" over an auth rejection produces thousands of
attempts per hour against a provider that has already said the key is invalid.
This module makes that impossible by construction rather than by convention.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from enum import StrEnum
from typing import Any


class FailureKind(StrEnum):
    """Why a feed attempt failed. Drives which recovery path is allowed."""

    #: A transient network/socket fault. The only class that retries fast.
    TRANSPORT = "TRANSPORT"
    #: The provider rejected the credentials. Retrying cannot help.
    AUTH = "AUTH"
    #: The provider is pacing us. Its own ``Retry-After`` governs.
    RATE_LIMIT = "RATE_LIMIT"
    #: Connected, but the payload is not a usable AIS message.
    PROTOCOL = "PROTOCOL"


#: Text that identifies a credential rejection in an upstream error string.
_AUTH_TEXT = re.compile(
    r"unauthoriz|unauthoris|forbidden|invalid\s*api[\s_-]*key|invalid\s*key"
    r"|bad\s*api[\s_-]*key|authentic|api\s*key\s*(is\s*)?(invalid|required|missing|not\s*valid)",
    re.IGNORECASE,
)
#: Text that identifies rate limiting or a connection cap.
_RATE_TEXT = re.compile(
    r"rate[\s_-]*limit|too\s*many\s*(requests|connections)|quota\s*exceeded|429",
    re.IGNORECASE,
)
#: ``websockets`` reports a refused upgrade in this shape when no
#: ``unexpected-response`` hook consumed it.
_UNEXPECTED_STATUS = re.compile(r"unexpected server response:\s*(\d{3})", re.IGNORECASE)

#: An AIS envelope is a couple of KB. Anything approaching this bound is not a
#: feed message, and decoding it would be wasted work on a hostile payload.
MAX_FRAME_BYTES = 1_000_000


@dataclass(frozen=True)
class Failure:
    """A classified feed failure, plus what the caller is allowed to do about it."""

    kind: FailureKind
    message: str
    http_status: int | None = None
    #: Milliseconds the SERVER asked us to wait. Only meaningful for RATE_LIMIT.
    retry_after_ms: int | None = None

    @property
    def retryable(self) -> bool:
        """Whether a fast retry is worth anything at all.

        ``AUTH`` is terminal until the key changes; ``RATE_LIMIT`` waits on the
        server's own pacing rather than ours.
        """
        return self.kind in (FailureKind.TRANSPORT, FailureKind.PROTOCOL)


def parse_retry_after_ms(raw: str | int | None, now: datetime | None = None) -> int:
    """Parse a ``Retry-After`` header into milliseconds.

    Accepts delta-seconds or an HTTP-date. Returns 0 when absent or unparseable,
    because a missing header must not become an unbounded wait.
    """
    if raw is None:
        return 0
    text = str(raw).strip()
    if not text:
        return 0
    if re.fullmatch(r"\d+", text):
        return int(text) * 1000
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return 0
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    reference = now or datetime.now(UTC)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=UTC)
    return max(0, int((when - reference).total_seconds() * 1000))


def classify_failure(
    *,
    message: str = "",
    http_status: int | str | None = None,
    retry_after: str | int | None = None,
    now: datetime | None = None,
) -> Failure:
    """Classify one feed failure. Pure, and safe to call on any input."""
    text = (message or "").strip()

    status: int | None = None
    try:
        status = int(http_status)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        match = _UNEXPECTED_STATUS.search(text)
        status = int(match.group(1)) if match else None

    retry_after_ms = parse_retry_after_ms(retry_after, now) or None

    if status in (401, 403):
        return Failure(FailureKind.AUTH, f"provider rejected the API key (HTTP {status})", status)
    if status == 429:
        return Failure(
            FailureKind.RATE_LIMIT,
            "provider rate-limited this key (HTTP 429)",
            status,
            retry_after_ms,
        )
    if status is not None and status >= 400:
        return Failure(FailureKind.TRANSPORT, f"upgrade failed (HTTP {status})", status)

    if _AUTH_TEXT.search(text):
        return Failure(FailureKind.AUTH, text)
    if _RATE_TEXT.search(text):
        return Failure(FailureKind.RATE_LIMIT, text, status, retry_after_ms)
    return Failure(FailureKind.TRANSPORT, text or "AIS websocket error")


def frame_is_oversized(size: int) -> bool:
    """Refuse a frame larger than :data:`MAX_FRAME_BYTES` before decoding it."""
    return size > MAX_FRAME_BYTES


@dataclass(frozen=True)
class BackoffPolicy:
    """The ladder and the two slow cadences.

    ``ladder`` length IS the attempt budget: once it is exhausted the feed is
    declared down and only :attr:`down_retry_s` applies.
    """

    ladder_s: tuple[float, ...] = (5.0, 15.0, 60.0, 300.0)
    down_retry_s: float = 900.0
    auth_probe_s: float = 3600.0
    #: Ceiling on a server-requested wait, so a hostile header cannot park us.
    max_retry_after_s: float = 900.0

    def steady_state_attempts_per_hour(self, kind: FailureKind) -> float:
        """Once the burst is over, how often do we still connect?

        This is the long-run rate and it is low by construction, because after
        the ladder every class sits on a slow cadence.
        """
        if kind is FailureKind.AUTH:
            return 3600.0 / self.auth_probe_s
        return 3600.0 / self.down_retry_s

    def attempts_in_first_hour(self, kind: FailureKind) -> int:
        """Connection attempts in the first hour of a persistent failure.

        This is the number that actually protects a provider, because it
        includes the initial burst through the ladder, which the steady-state
        rate hides. Simulated rather than estimated, so a changed constant
        cannot quietly push the count up.

        Schedule: an attempt happens immediately, then after each ladder rung,
        then on the slow cadence once the ladder is exhausted.
        """
        if kind is FailureKind.AUTH:
            return 1  # no fast retry at all; only the hourly probe
        attempts = 1
        clock = 0.0
        while attempts < 500:  # hard bound so a broken policy cannot hang a test
            index = attempts - 1
            clock += (
                self.ladder_s[index]
                if index < len(self.ladder_s)
                else self.down_retry_s
            )
            if clock > 3600.0:
                break
            attempts += 1
        return attempts


@dataclass
class AistreamWatchdog:
    """Decides the next action for a failing AIS feed.

    Owns policy and no I/O: it is handed failures and returns the next delay.
    That split is what makes the policy testable offline, and it is what the
    collector depends on.
    """

    policy: BackoffPolicy = field(default_factory=BackoffPolicy)
    consecutive_transport_failures: int = 0
    auth_rejected: bool = False
    down: bool = False
    last_failure: Failure | None = None

    def record_failure(self, failure: Failure) -> float:
        """Apply a failure and return seconds to wait before the next attempt.

        Returns 0 for ``AUTH``: no retry is scheduled at all, because retrying
        a rejected key is how a client becomes a hammer. The caller polls
        :attr:`auth_rejected` to know when to probe again.
        """
        self.last_failure = failure
        self.down = False

        if failure.kind is FailureKind.AUTH:
            self.auth_rejected = True
            self.consecutive_transport_failures = 0
            return 0.0

        self.auth_rejected = False
        if failure.kind is FailureKind.RATE_LIMIT:
            # The server's pacing wins, bounded so a bad header cannot park us.
            self.down = True
            self.consecutive_transport_failures = 0
            requested = (failure.retry_after_ms or 0) / 1000.0
            return min(requested, self.policy.max_retry_after_s) or self.policy.down_retry_s

        if failure.kind is FailureKind.PROTOCOL:
            # A payload that will not decode is still a fault, so it is paced
            # like one. Returning the first rung here without ever advancing the
            # counter produced an unbounded 5-second retry loop, which is
            # precisely the hammer this module exists to prevent.
            self.consecutive_transport_failures += 1
            return self._next_ladder_delay()

        self.consecutive_transport_failures += 1
        return self._next_ladder_delay()

    def _next_ladder_delay(self) -> float:
        """Return the wait for the rung matching the current failure count.

        Callers must have already incremented ``consecutive_transport_failures``,
        so the first failure lands on rung 0. The ladder length is the attempt
        budget: once the final rung has been used the feed is down and only the
        slow cadence applies.
        """
        index = self.consecutive_transport_failures - 1
        if index < len(self.policy.ladder_s):
            self.down = index == len(self.policy.ladder_s) - 1
            return self.policy.ladder_s[index]
        self.down = True
        return self.policy.down_retry_s

    def record_success(self) -> None:
        """A live frame resets the ladder. Liveness is granted only on real data."""
        self.consecutive_transport_failures = 0
        self.auth_rejected = False
        self.down = False

    def next_auth_probe_delay(self) -> float:
        """Delay before re-probing a rejected key."""
        return self.policy.auth_probe_s

    def status(self) -> str:
        """One of ``live``, ``down``, ``auth_rejected``, ``connecting``."""
        if self.auth_rejected:
            return "auth_rejected"
        if self.down:
            return "down"
        if self.consecutive_transport_failures:
            return "connecting"
        return "live"

    def snapshot(self) -> dict[str, Any]:
        """Operational readout. Never claims liveness it has not observed."""
        return {
            "status": self.status(),
            "consecutive_transport_failures": self.consecutive_transport_failures,
            "auth_rejected": self.auth_rejected,
            "down": self.down,
            "last_kind": self.last_failure.kind.value if self.last_failure else None,
            "last_message": self.last_failure.message if self.last_failure else None,
            "attempts_per_hour": (
                round(self.policy.steady_state_attempts_per_hour(self.last_failure.kind), 2)
                if self.last_failure
                else 0.0
            ),
        }


def now_delay(seconds: float, since: datetime | None = None) -> datetime:
    """Absolute wake time. Injected clock friendly, so tests never sleep."""
    base = since or datetime.now(UTC)
    if base.tzinfo is None:
        base = base.replace(tzinfo=UTC)
    return base + timedelta(seconds=max(0.0, seconds))