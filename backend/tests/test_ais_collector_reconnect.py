"""The AISStream collector now reconnects under policy (AIS-016/017).

The previous implementation opened one socket and let any failure end the run.
These tests drive the reconnect loop with a fake transport so the behaviour is
proved offline and without sleeping.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from darkfleet.ais.collector import AistreamCollector
from darkfleet.ais.resilience import FailureKind
from darkfleet.providers import RealDataUnavailableError

#: Obvious placeholder for the credential argument. Never a real credential.
DUMMY = "placeholder"


class FakeSocket:
    """Yields the given frames, or raises the given exception first."""

    def __init__(self, frames: list[Any] | None = None, error: Exception | None = None) -> None:
        self._frames = frames or []
        self._error = error
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)

    def __aiter__(self) -> FakeSocket:
        return self

    async def __anext__(self) -> str:
        if self._error is not None:
            error, self._error = self._error, None
            raise error
        if not self._frames:
            raise StopAsyncIteration
        return str(self._frames.pop(0))


class _Ctx:
    def __init__(self, socket: FakeSocket) -> None:
        self._socket = socket

    async def __aenter__(self) -> FakeSocket:
        return self._socket

    async def __aexit__(self, *args: object) -> None:
        return None


class FakeConnect:
    """Stands in for ``websockets.connect``; yields scripted sockets in order."""

    def __init__(self, sockets: list[FakeSocket]) -> None:
        self.sockets = sockets
        self.calls = 0

    def __call__(self, url: str, **kwargs: Any) -> _Ctx:
        self.calls += 1
        socket = self.sockets[min(self.calls - 1, len(self.sockets) - 1)]
        return _Ctx(socket)


class FakeArchive:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def append(self, obs: list[Any]) -> int:
        self.rows.extend(obs)
        return len(obs)


def _message(mmsi: str = "563189210", lat: float = 1.26, lon: float = 103.84) -> str:
    return json.dumps(
        {
            "MessageType": "PositionReport",
            "MetaData": {"MMSI": mmsi},
            "Message": {
                "PositionReport": {
                    "UserID": mmsi,
                    "Latitude": lat,
                    "Longitude": lon,
                    "Timestamp": "2026-09-27T11:24:58Z",
                }
            },
        }
    )


@pytest.fixture(autouse=True)
def _bounded_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Backoff waits are simulated, never real.

    Also a hard safety net: the collector reconnects in a loop, so a test whose
    scripted sockets never satisfy its limit would otherwise hang the suite.
    After 20 waits it aborts the run instead.
    """
    calls: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        calls.append(seconds)
        if len(calls) > 20:
            raise asyncio.CancelledError("test exceeded 20 simulated waits")

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)


def _run(coro: Any) -> Any:
    """Drive a coroutine to completion.

    The project has no async pytest plugin and this test does not need one, so
    the loop is run explicitly rather than adding a dependency for nine tests.
    """
    return asyncio.run(coro)


def _collector(archive: FakeArchive) -> AistreamCollector:
    return AistreamCollector(api_key=DUMMY, archive=archive)  # type: ignore[arg-type]


def test_collector_still_requires_a_credential() -> None:
    with pytest.raises(RealDataUnavailableError):
        AistreamCollector(api_key="", archive=FakeArchive())  # type: ignore[arg-type]


def test_subscribe_message_shape_is_unchanged() -> None:
    message = _collector(FakeArchive()).subscribe_message((103.8, 1.24, 103.9, 1.28))
    assert message["APIKey"] == DUMMY
    # AISStream wants [[lat, lon], [lat, lon]] inside the box list.
    assert message["BoundingBoxes"] == [[[1.24, 103.8], [1.28, 103.9]]]
    assert message["FilterMessageTypes"] == ["PositionReport", "ShipStaticData"]


def test_clean_stream_persists_observations(monkeypatch: pytest.MonkeyPatch) -> None:
    archive = FakeArchive()
    connect = FakeConnect([FakeSocket(frames=[_message(), _message(mmsi="563189211")])])
    monkeypatch.setattr("websockets.connect", connect)

    count = _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28), limit=2))
    assert count == 2
    assert len(archive.rows) == 2
    assert connect.calls == 1


def test_transport_drop_reconnects_and_keeps_collecting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression this policy exists for: a drop must not end the subscription."""
    archive = FakeArchive()
    connect = FakeConnect(
        [
            FakeSocket(error=ConnectionResetError("peer reset")),
            FakeSocket(frames=[_message()]),
        ]
    )
    monkeypatch.setattr("websockets.connect", connect)

    count = _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28), limit=1))
    assert count == 1
    assert connect.calls == 2, "the collector must have reconnected"


def test_auth_rejection_stops_immediately_instead_of_retrying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected credential must not be retried: that is the hammer."""
    archive = FakeArchive()
    connect = FakeConnect([FakeSocket(error=Exception("unexpected server response: 401"))])
    monkeypatch.setattr("websockets.connect", connect)

    with pytest.raises(RealDataUnavailableError) as excinfo:
        _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28), limit=1))

    assert "rejected" in str(excinfo.value)
    assert connect.calls == 1, "an auth rejection must not be retried at all"


def test_rate_limit_waits_before_reconnecting(monkeypatch: pytest.MonkeyPatch) -> None:
    archive = FakeArchive()
    connect = FakeConnect(
        [
            FakeSocket(error=Exception("rate limit exceeded")),
            FakeSocket(frames=[_message()]),
        ]
    )
    monkeypatch.setattr("websockets.connect", connect)

    slept: list[float] = []

    async def capture(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", capture)

    count = _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28), limit=1))
    assert count == 1
    assert slept, "a rate limit must wait before reconnecting"
    assert all(delay > 0 for delay in slept)


def test_malformed_frames_are_skipped_not_persisted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive = FakeArchive()
    connect = FakeConnect([FakeSocket(frames=["not json", "{", _message()])])
    monkeypatch.setattr("websockets.connect", connect)

    count = _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28), limit=1))
    assert count == 1
    assert len(archive.rows) == 1


def test_oversized_frame_is_refused_before_decoding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive = FakeArchive()
    huge = "x" * 2_000_000
    connect = FakeConnect([FakeSocket(frames=[huge, _message()])])
    monkeypatch.setattr("websockets.connect", connect)

    count = _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28), limit=1))
    assert count == 1, "the oversized frame must be skipped, the good one kept"
    assert all(row.mmsi for row in archive.rows), "only a real observation is kept"


def test_repeated_failures_back_off_rather_than_spin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Three consecutive drops must produce three growing waits."""
    archive = FakeArchive()
    connect = FakeConnect([FakeSocket(error=ConnectionResetError("reset"))])
    monkeypatch.setattr("websockets.connect", connect)

    slept: list[float] = []

    async def capture(seconds: float) -> None:
        slept.append(seconds)
        if len(slept) >= 3:
            raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", capture)

    with pytest.raises(asyncio.CancelledError):
        _run(_collector(archive).run((103.8, 1.24, 103.9, 1.28)))

    assert len(slept) >= 3
    assert slept[0] < slept[1] < slept[2], f"backoff must grow, got {slept}"
    assert FailureKind.TRANSPORT.value == "TRANSPORT"