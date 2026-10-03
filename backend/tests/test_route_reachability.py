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


def test_known_orphan_stays_orphaned_until_it_has_a_surface() -> None:
    """`/ais/coverage` currently has no caller.

    This test exists so that closing the gap flips it, and re-opening it flips it
    back. If the endpoint is removed instead, this fails and the removal has to
    be a deliberate edit to this test rather than a silent drift.
    """
    import ast as _ast

    from route_reachability import _template_paths

    literals: set[str] = set()
    for path in (Path(__file__).resolve().parents[2] / "src").rglob("*"):
        if path.suffix in (".ts", ".tsx"):
            literals |= _template_paths(path.read_text(encoding="utf-8"))
    del _ast

    reached = any(_matches("/ais/coverage", x) for x in literals)
    assert reached is False, (
        "/ais/coverage now has a frontend caller; update this test and the "
        "CURRENT_STATE orphan count."
    )