"""Regression: simplification must not collapse a CLOSED RING.

THE DEFECT THIS PINS
--------------------
Marine Regions delivers every polygon as a closed ring -- first vertex identical to the last --
and all 3,113 parts of the installed snapshot are closed. Ramer-Douglas-Peucker's outermost
span is `points[0]` to `points[-1]`, which for a closed ring is a ZERO-LENGTH segment, so the
algorithm measured every vertex against a degenerate line and collapsed the ring to its two
identical endpoints.

Measured on the installed snapshot at tolerance 0.02:

    total parts                   3,113
    collapsed to two vertices     2,744   <- 88% of the world's maritime boundaries
    surviving with >= 3             369

The renderer skips any part with fewer than three positions, so the globe drew 325 entities
instead of 3,113 -- a sparse, wrong world rather than an error.

WHY NO EXISTING TEST CAUGHT IT
-----------------------------
`classify_zone` and `coast_distance` read the FULL prepared geometry and never the simplified
one. That separation is deliberate and it is exactly why the analytical delta measured zero
differences and the whole backend suite stayed green while the display geometry was destroyed.
The coastline was unaffected too -- Natural Earth's features are open `LineString`s -- so a
working coastline hid a broken layer.

Only a test that inspects the RING SIZES of the simplified output can see this class of defect.
The counts below are therefore the assertion, not "the output looks right".
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from darkfleet.maritime.display import coast_display_geometry, simplify, zone_display_geometry

#: The live fixture archive from DF-X8.4H, present in this environment. The test SKIPS rather
#: than inventing data if it is not, because the failure mode being pinned is a property of a
#: real ring's shape, and a synthetic ring chosen to reproduce it would prove less.
ARCHIVE = Path(
    os.environ.get("DF_SERVE_DATA_DIR", r"C:\Users\nahas\AppData\Local\Temp\df-serve-56jd6e55")
)
EEZ_PAYLOAD = (
    ARCHIVE / "reference" / "marine_regions_eez_wfs" / "CURRENT-SERVICE-SNAPSHOT" / "eez.json"
)
COAST_PAYLOAD = (
    ARCHIVE / "reference" / "natural_earth_coastline" / "4.1.0" / "coastline.json"
)


def _ring_sizes(entries: list[dict]) -> list[int]:
    return [len(part) for entry in entries for part in entry["geometry"].parts]


class TestClosedRingSimplification:
    def test_a_closed_square_keeps_all_four_corners(self) -> None:
        # A square with the closing vertex repeated, as every GeoJSON polygon ring has it.
        square = [(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0), (0.0, 0.0)]
        result = simplify(square, tolerance_deg=0.01)
        # Every corner is 10 degrees from its neighbours, far beyond the tolerance, so all
        # must survive. The pre-fix behaviour returned exactly two identical points.
        assert len(result) >= 4, f"a closed square simplified to {len(result)} points: {result}"
        assert result[0] == result[-1], "the ring must still be closed after simplification"
        # And the ring must still enclose something.
        assert len({(round(x, 6), round(y, 6)) for x, y in result}) >= 4

    def test_a_closed_triangle_keeps_three_distinct_points(self) -> None:
        triangle = [(0.0, 0.0), (0.0, 5.0), (5.0, 0.0), (0.0, 0.0)]
        result = simplify(triangle, tolerance_deg=0.01)
        assert len({(round(x, 6), round(y, 6)) for x, y in result}) >= 3, (
            f"a closed triangle collapsed to {result}"
        )
        assert result[0] == result[-1], "the ring must still be closed"

    def test_an_open_polyline_is_unaffected(self) -> None:
        # The coastline case, which WORKED, pinned here so the fix cannot regress it.
        line = [(float(i), 0.0) for i in range(20)]
        result = simplify(line, tolerance_deg=0.01)
        assert len(result) == 2, "a straight open run should still collapse to its endpoints"
        assert result[0] == (0.0, 0.0)
        assert result[-1] == (19.0, 0.0)

    def test_a_ring_below_tolerance_is_returned_unsimplified(self) -> None:
        """
        The degenerate-output guard, which matters because the alternative is a ring that
        encloses nothing.

        A closed path whose open form simplifies below three points cannot bound an area, so
        the ring is returned whole. Emitting it would draw a zero-area polygon whose outline
        is a visible speck at a scale where it should be nothing.
        """
        tiny = [(0.0, 0.0), (0.0001, 0.0001), (0.0, 0.0)]
        result = simplify(tiny, tolerance_deg=0.01)
        assert len(result) == len(tiny), "a sub-tolerance ring must not be emitted degenerate"


@pytest.mark.skipif(not EEZ_PAYLOAD.is_file(), reason="the installed EEZ snapshot is not present")
class TestAgainstTheInstalledSnapshot:
    @staticmethod
    def _payload() -> dict:
        return json.loads(EEZ_PAYLOAD.read_text(encoding="utf-8"))

    def test_no_ring_collapses_below_three_vertices(self) -> None:
        entries = zone_display_geometry(self._payload(), tolerance_deg=0.02)
        sizes = _ring_sizes(entries)
        assert sizes, "no zone geometry was produced -- the check would be vacuous"

        collapsed = [size for size in sizes if size < 3]
        # THE assertion. 2,744 of 3,113 rings failed this before the fix.
        assert collapsed == [], (
            f"{len(collapsed)} of {len(sizes)} rings simplified below three vertices and "
            "would be skipped by the renderer"
        )

    def test_every_ring_is_still_closed(self) -> None:
        # A ring left open would be read as unbounded by Cesium and by `point_in_polygon`,
        # which is a different and worse corruption than a dropped vertex.
        entries = zone_display_geometry(self._payload(), tolerance_deg=0.05)
        open_rings = [
            part
            for entry in entries
            for part in entry["geometry"].parts
            if part[0][0] != part[-1][0] or part[0][1] != part[-1][1]
        ]
        assert open_rings == [], f"{len(open_rings)} rings were left open"

    def test_simplification_still_removes_the_bulk_of_the_vertices(self) -> None:
        """
        The fix must not have degenerated into "keep everything".

        A ring-by-ring guard that returns the input unchanged would satisfy the two checks
        above while defeating the purpose, so the reduction is asserted as well.
        """
        entries = zone_display_geometry(self._payload(), tolerance_deg=0.05)
        before = sum(entry["geometry"].source_vertex_count for entry in entries)
        after = sum(size for size in _ring_sizes(entries))
        assert before > 1_000_000, f"expected a multi-million-vertex snapshot, got {before:,}"
        assert after < before / 10, (
            f"only reduced {before:,} -> {after:,}; simplification is not doing its job"
        )

    def test_simplification_is_still_deterministic(self) -> None:
        payload = self._payload()
        first = zone_display_geometry(payload, tolerance_deg=0.05)
        second = zone_display_geometry(payload, tolerance_deg=0.05)
        assert [entry["geometry"].parts for entry in first] == [
            entry["geometry"].parts for entry in second
        ]


@pytest.mark.skipif(not COAST_PAYLOAD.is_file(), reason="the installed coastline is not present")
class TestCoastlineIsUnaffected:
    def test_line_features_still_simplify(self) -> None:
        payload = json.loads(COAST_PAYLOAD.read_text(encoding="utf-8"))
        geometries = coast_display_geometry(payload, tolerance_deg=0.05)
        sizes = [len(part) for geometry in geometries for part in geometry.parts]
        assert sizes, "no coastline geometry was produced -- the check would be vacuous"
        # Natural Earth features are open LineStrings, so the closed-ring bug never applied.
        # Pinned so the ring fix cannot accidentally start collapsing them instead.
        assert sum(1 for size in sizes if size < 2) == 0, "a line lost both its endpoints"
        total_before = sum(geometry.source_vertex_count for geometry in geometries)
        total_after = sum(sizes)
        assert total_after < total_before / 5, (
            f"only reduced {total_before:,} -> {total_after:,}"
        )
