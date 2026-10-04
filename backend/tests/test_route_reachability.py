"""Tests for the route reachability gate itself.

A gate that silently under-reports is worse than no gate: it would certify the
product as fully wired while routes sat unreachable. These tests pin the matcher's
behaviour on both the cases it must find and the near-misses it must not.

The literal strings are written with explicit escaping because PowerShell
interpolates ``${...}`` inside a here-string.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from route_reachability import _matches, _segments, declared_routes

DOLLAR = "$"


def lit(template: str) -> str:
    """Build a TypeScript template literal without shell interpolation."""
    return template.replace("§", DOLLAR)


# ------------------------------------------------------------------- segments


def test_query_string_is_not_a_path_segment() -> None:
    assert _segments("/api/revisit?bbox=1,2") == ["api", "revisit"]
    assert _segments("/api/x#frag") == ["api", "x"]


def test_segment_split_drops_empty_parts() -> None:
    assert _segments("/api//scans/") == ["api", "scans"]


# --------------------------------------------------------------------- match


@pytest.mark.parametrize(
    ("route", "literal"),
    [
        # The shape that matters most: a FastAPI hole against a TS hole.
        ("/scans/{scan_id}/targets", "/api/scans/" + lit("${scanId}/targets")),
        ("/vessels/{mmsi}/track", "/api/vessels/" + lit("${mmsi}/track")),
        # A query string must not hide the call.
        ("/revisit", "/api/revisit?bbox=" + lit("${q}")),
        # A literal call with no hole.
        ("/detectors", "/api/detectors"),
        # Multi-segment holes.
        (
            "/scans/{scan_id}/raster/{layer}",
            "/api/scans/" + lit("${scanId}/raster/${layer}"),
        ),
    ],
)
def test_real_calls_match(route: str, literal: str) -> None:
    assert _matches(route, literal) is True


@pytest.mark.parametrize(
    ("route", "literal"),
    [
        # A prefix route must not be credited for a deeper call.
        ("/scans/{scan_id}/raster/{layer}", "/api/scans/" + lit("${scanId}/raster")),
        # Different resource entirely.
        ("/targets/{target_id}", "/api/scenes?bbox=" + lit("${b}")),
        # Right resource, wrong verb path shape.
        ("/ais/coverage", "/api/ais/observations"),
        # A literal shorter than the route cannot address it.
        ("/scans/{scan_id}/raster/{layer}/image", "/api/detectors"),
    ],
)
def test_near_misses_do_not_match(route: str, literal: str) -> None:
    assert _matches(route, literal) is False


def test_holes_match_any_segment() -> None:
    assert _matches("/targets/{target_id}", "/api/targets/anything-at-all") is True
    assert _matches("/targets/{target_id}", "/api/targets/DF-014") is True


def test_similar_names_are_not_confused() -> None:
    """/tracks and /patterns are different resources."""
    assert _matches("/tracks", "/api/patterns") is False
    assert _matches("/patterns", "/api/tracks") is False


# ------------------------------------------------------------------ the routes


def test_routes_are_discovered_from_the_source() -> None:
    routes = declared_routes()
    assert routes, "no routes discovered -- the decorator regex is stale"
    labels = {r.label for r in routes}
    assert "POST /scans" in labels
    assert "GET /detectors" in labels


def test_ais_coverage_is_called_from_the_system_panel() -> None:
    """`/ais/coverage` now has a caller, and the assertion was INVERTED on purpose.

    This test began as `assert reached is False` -- a standing pin that the route had
    no frontend caller, so that giving it one would have to be a deliberate edit
    rather than silent drift. DF-X7.6 gave it one and the pin flipped, which is the
    mechanism working.

    Why it was given a surface: the route is a DEPLOYMENT-level probe -- does this
    installation have an AIS archive at all -- whereas the target-scoped
    `/targets/{id}/ais-observations` coverage block answers whether a receiver
    covered THAT window. Those disagree routinely: a healthy archive still yields
    NO_COVERAGE for a target over unmonitored water. It was therefore classified
    neither REDUNDANT nor INTERNAL_SUPPORT, and placed on the SYSTEM panel where
    the deployment scope is unambiguous, rather than on the dossier AIS tab where it
    would sit beside a window-scoped fact and invite the reader to conflate them.

    The assertion now pins that placement: the route must stay called, so a later
    refactor that drops the probe fails here instead of silently degrading the
    system panel.
    """
    from route_reachability import _template_paths

    literals: set[str] = set()
    for path in (Path(__file__).resolve().parents[2] / "src").rglob("*"):
        if path.suffix in (".ts", ".tsx"):
            literals |= _template_paths(path.read_text(encoding="utf-8"))

    reached = any(_matches("/ais/coverage", x) for x in literals)
    assert reached is True, (
        "/ais/coverage has lost its only caller. Either the SYSTEM panel's "
        "deployment-level AIS archive probe was removed, or its URL stopped being a "
        "legible literal the reachability gate can read. Both are regressions worth "
        "a deliberate fix rather than a silent acceptance."
    )