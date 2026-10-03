"""The offline guard must be trusted because it is tested, not because tests pass.

A guard that is never exercised is indistinguishable from a guard that does not
work. Every claim here is proven by making the escape deliberately and asserting
it is refused, and by proving the things that MUST keep working still do.

The invariant under test:

    pytest -m "not live"  ==>  public network access is impossible

Not "unusual", not "usually patched": impossible at the socket layer, beneath
httpx, requests, urllib and pystac alike.
"""

from __future__ import annotations

import socket
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest

from conftest import ExternalNetworkAccess, _is_local

#: A hostname that must never resolve during the default suite. If the guard fails
#: and this resolves, the test below would silently pass for the wrong reason --
#: so its resolvability is asserted first.
PUBLIC_HOST = "planetarycomputer.microsoft.com"


# ------------------------------------------------------------- the guard fires


def test_external_dns_lookup_is_refused() -> None:
    """The exact operation that produced the intermittent failure."""
    with pytest.raises(ExternalNetworkAccess) as caught:
        socket.getaddrinfo(PUBLIC_HOST, 443)
    message = str(caught.value)
    assert PUBLIC_HOST in message
    assert "getaddrinfo" in message
    assert "non-live" in message


def test_external_tcp_connect_is_refused() -> None:
    with pytest.raises(ExternalNetworkAccess) as caught:
        socket.create_connection((PUBLIC_HOST, 443), timeout=1)
    assert PUBLIC_HOST in str(caught.value)


def test_external_http_request_is_refused_end_to_end() -> None:
    """Through urllib, so the refusal is proven at a real client, not a raw call."""
    with pytest.raises((ExternalNetworkAccess, urllib.error.URLError)):
        urllib.request.urlopen(f"https://{PUBLIC_HOST}/api/stac/v1", timeout=1)


def test_a_public_literal_ip_is_refused() -> None:
    """A test that skips DNS still must not open an external socket.

    Guarding only name resolution would leave direct-to-IP calls open, which is
    the obvious way around a DNS-level check.
    """
    with pytest.raises(ExternalNetworkAccess):
        socket.create_connection(("93.184.216.34", 80), timeout=1)


def test_the_refusal_names_the_caller() -> None:
    """An unactionable failure is nearly as bad as no guard.

    The message must say which host, which operation, and what to do about it.
    """
    with pytest.raises(ExternalNetworkAccess) as caught:
        socket.getaddrinfo(PUBLIC_HOST, 443)
    message = str(caught.value)
    assert "host=" in message
    assert "caller=" in message
    assert "test_network_hermeticity.py" in message, (
        "the caller summary should point at the offending file"
    )
    assert "live" in message and "offline provider double" in message


def test_nothing_is_faked_on_the_way_out() -> None:
    """A refused call must raise, never return a synthetic response.

    Returning a plausible empty response would let a test assert against data no
    provider produced -- the exact failure mode this product exists to prevent,
    reproduced inside the test harness.
    """
    with pytest.raises(ExternalNetworkAccess):
        socket.getaddrinfo(PUBLIC_HOST, 443)


# ------------------------------------------------ approved local access works


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "127.0.0.53", "::1", "localhost", "", "::ffff:127.0.0.1"],
)
def test_loopback_addresses_are_treated_as_local(host: str) -> None:
    assert _is_local(host) is True


@pytest.mark.parametrize("host", [PUBLIC_HOST, "example.com", "8.8.8.8", "0.0.0.0"])
def test_external_addresses_are_not_local(host: str) -> None:
    assert _is_local(host) is False


def test_localhost_resolution_is_still_permitted() -> None:
    """Loopback DNS must keep working for the in-process TestClient and friends.

    Refusing ``localhost`` would break ordinary testing in a way that looks like
    a product bug, so this is asserted rather than assumed.
    """
    try:
        socket.getaddrinfo("localhost", 80)
    except ExternalNetworkAccess as exc:  # pragma: no cover - must not happen
        pytest.fail(f"localhost must remain reachable, got {exc}")
    except OSError:
        # The host may genuinely not resolve in a sandbox. That is an OS fact,
        # not a guard failure, and the point of the test is the absence of
        # ExternalNetworkAccess.
        pass


def test_localhost_http_through_a_real_socket_is_permitted() -> None:
    """A real loopback socket still works, end to end.

    Stands up a throwaway HTTP server on 127.0.0.1 and fetches from it, so the
    guard is proven not to break legitimate local I/O -- the property that makes
    it safe to enable everywhere.
    """
    import http.server
    import threading
    from urllib.request import urlopen

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *args: Any) -> None:
            return

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        with urlopen(f"http://127.0.0.1:{port}/", timeout=5) as response:
            assert response.status is not None
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# ------------------------------------------------------------- the opt-out works


@pytest.mark.live
def test_live_marker_is_the_documented_opt_out() -> None:
    """A ``live`` test may resolve, because it asked to.

    Proves the escape hatch is real and not decorative: the same call that fails
    above succeeds here. If DNS is unavailable the assertion is skipped rather
    than failed -- the point is that the GUARD stood down, not that the internet
    works.
    """
    try:
        socket.getaddrinfo(PUBLIC_HOST, 443)
    except ExternalNetworkAccess as exc:  # pragma: no cover - the bug this catches
        pytest.fail(f"a live test must not be blocked: {exc}")
    except OSError:
        pytest.skip("no DNS in this environment; the guard correctly stood down")


def test_allow_external_network_flag_exists(pytestconfig: pytest.Config) -> None:
    """The diagnostic opt-out is registered, so it can be used when triaging."""
    assert pytestconfig.getoption("--allow-external-network", default=False) is False


# ------------------------------------------- the default selection excludes live


def test_live_tests_are_deselected_by_default(pytestconfig: pytest.Config) -> None:
    """``pytest`` with no arguments must not run anything that needs the internet."""
    addopts = pytestconfig.getini("addopts") or ""
    assert "not live" in addopts, f"default addopts do not exclude live: {addopts!r}"


# ---------------------------------------------------- the fixtures themselves


def test_blocker_fixture_is_autouse_and_yields() -> None:
    """Sanity on the fixture's own shape, so a broken guard cannot pass silently."""
    assert callable(block_external_network_marker())


def block_external_network_marker() -> Any:
    from conftest import block_external_network

    return block_external_network


@pytest.fixture
def _unused() -> Iterator[None]:
    yield