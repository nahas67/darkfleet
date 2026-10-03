"""Suite-wide hermeticity: the default test run cannot reach the public network.

Why this exists
---------------
A non-`live` test run intermittently failed with::

    REAL_DATA_UNAVAILABLE: STAC endpoint unreachable:
    https://planetarycomputer.microsoft.com/api/stac/v1
    getaddrinfo failed

and then passed on three consecutive reruns. A flaky pass is not a pass. The
default suite claims to be offline, and at the moment that claim was enforced by
convention rather than mechanically -- one un-patched call path was enough.

The blocker below makes the claim structural. It intercepts at the socket layer,
which sits beneath httpx, requests, urllib, pystac and anything else that might
be introduced later, so a new provider client cannot quietly re-open the hole.

Design constraints
------------------
- Loopback stays allowed. Starlette's TestClient runs the ASGI app in-process,
  and a future test may legitimately talk to a local fixture server.
- Real network remains possible, but only under an explicit ``@pytest.mark.live``.
- The failure names the host and the calling frame, because "getaddrinfo failed"
  is not an actionable test failure.
- Nothing is faked. A blocked call raises; it never returns a synthetic response,
  because a silent fake response is exactly how a test comes to assert against
  data no provider produced.
"""

from __future__ import annotations

import socket
import traceback
from collections.abc import Iterator
from typing import Any

import pytest

#: Addresses a test may legitimately reach. Loopback covers the in-process
#: TestClient transport and any local fixture server.
_LOCAL_HOSTNAMES = frozenset({"localhost", "localhost.localdomain", "", "::1"})


class ExternalNetworkAccess(RuntimeError):
    """Raised when a non-live test tries to reach the public network.

    Deliberately a distinct type so a test can assert on it, and so the message
    can name the offending host rather than surfacing as an opaque socket error.
    """


def _is_local(host: Any) -> bool:
    """Whether a host or address refers to this machine.

    ``::ffff:127.0.0.1`` is handled explicitly: it is the IPv4-mapped IPv6 form
    Windows produces for loopback, and a guard that rejected it would break
    legitimate local I/O on this platform. Found by the guard's own self-test.
    """
    if host is None:
        return False
    text = str(host)
    if text in _LOCAL_HOSTNAMES:
        return True
    # Strip the IPv6 bracket and scope forms before comparing.
    bare = text.strip("[]").split("%", 1)[0]
    if bare in _LOCAL_HOSTNAMES:
        return True
    if bare.startswith("::ffff:"):
        return _is_local(bare[len("::ffff:") :])
    return bare.startswith("127.") or bare == "::1"


def _caller_summary(skip: int = 2) -> str:
    """The nearest frame outside the socket machinery, for the failure message."""
    for frame in reversed(traceback.extract_stack()[:-skip]):
        name = frame.filename.replace("\\", "/")
        if "/socket.py" in name or "conftest.py" in name:
            continue
        if "pydantic" in name or "pluggy" in name:
            continue
        short = name.rsplit("/", 1)[-1]
        return f"{short}:{frame.lineno} in {frame.name}()"
    return "unknown caller"


def _blocked(host: Any, operation: str) -> ExternalNetworkAccess:
    return ExternalNetworkAccess(
        f"External network access attempted by a non-live test: "
        f"host={host!r} operation={operation} caller={_caller_summary()}. "
        f"Mark the test with @pytest.mark.live if it genuinely needs the network, "
        f"or inject an offline provider double."
    )


def _guard_installed(pytestconfig: pytest.Config) -> bool:
    return bool(pytestconfig.getoption("--allow-external-network", default=False))


@pytest.fixture(autouse=True)
def block_external_network(
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
    pytestconfig: pytest.Config,
) -> Iterator[None]:
    """Fail any non-live test that reaches a non-loopback address.

    Patches the socket module rather than a single HTTP client on purpose: httpx,
    requests, urllib and pystac all funnel through ``socket.getaddrinfo`` and
    ``socket.socket.connect``, so one pair of patches covers all of them and any
    future addition.
    """
    if request.node.get_closest_marker("live") is not None:
        yield
        return
    if _guard_installed(pytestconfig):
        yield
        return

    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_create_connection = socket.create_connection

    def guarded_getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> Any:
        if not _is_local(host):
            raise _blocked(host, "getaddrinfo")
        return real_getaddrinfo(host, port, *args, **kwargs)

    def guarded_connect(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if not _is_local(host):
            raise _blocked(host, "connect")
        return real_connect(self, address)

    def guarded_create_connection(address: Any, *args: Any, **kwargs: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if not _is_local(host):
            raise _blocked(host, "create_connection")
        return real_create_connection(address, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "create_connection", guarded_create_connection)

    yield


def pytest_addoption(parser: pytest.Parser) -> None:
    """Escape hatch, so the guard itself can be inspected rather than trusted."""
    parser.addoption(
        "--allow-external-network",
        action="store_true",
        default=False,
        help="Disable the external-network blocker (diagnostics only).",
    )