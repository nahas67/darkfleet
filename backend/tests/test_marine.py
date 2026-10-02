"""Named marine regions: GEO-001.

Data is Natural Earth `ne_10m_geography_marine_polys`, public domain.

The expected geography in these tests was read OUT of the shipped pack rather
than assumed. Two corrections that came out of doing that:

  - Natural Earth marine polygons are NOT a nesting hierarchy. The Strait of
    Malacca polygon does not overlap the South China Sea polygon, so a position
    in the strait resolves to the strait alone. Expecting the enclosing sea to be
    listed too was wrong.
  - The seven oceans are themselves named regions in the pack, so the coarse
    basin fallback in `basin_at` is not the primary answer for open ocean. It
    only fires where no named polygon covers the position, such as the Antarctic
    interior.
"""

from __future__ import annotations

import pytest

from darkfleet.marine import (
    basin_at,
    describe_position,
    load_regions,
    named_region_at,
    open_ocean_basins,
    provenance,
    region_names_at,
)

STRAIT_OF_MALACCA = (2.5, 101.0)
STRAIT_OF_SINGAPORE = (1.2634, 103.8102)  # the live REAL-scan test AOI
SOUTH_CHINA_SEA = (12.0, 115.0)
BAY_OF_BENGAL = (15.0, 88.0)
MID_ATLANTIC = (30.0, -40.0)
ANTARCTIC_INTERIOR = (-85.0, 0.0)
LUZON_STRAIT_AREAL = (20.5, 121.0)
NE_PHILIPPINE_SEA = (12.0, 126.0)


def test_pack_loads_and_is_non_trivial() -> None:
    regions = load_regions()
    assert len(regions) >= 250, "pack should carry the full marine layer"
    assert all(r.rings for r in regions), "every region needs at least one ring"
    assert all(len(r.name) > 0 for r in regions)


def test_pack_is_cached_between_calls() -> None:
    assert load_regions() is load_regions()


def test_known_regions_resolve() -> None:
    assert named_region_at(*STRAIT_OF_MALACCA) == "Strait of Malacca"
    assert named_region_at(*SOUTH_CHINA_SEA) == "South China Sea"
    assert named_region_at(*BAY_OF_BENGAL) == "Bay of Bengal"


def test_marine_polygons_are_not_a_nesting_hierarchy() -> None:
    """Recorded deliberately: a strait resolves alone, not with its enclosing sea."""
    assert region_names_at(*STRAIT_OF_MALACCA) == ("Strait of Malacca",)
    assert "South China Sea" not in region_names_at(*STRAIT_OF_MALACCA)


def test_the_standard_oceans_are_themselves_named_regions() -> None:
    """So the coarse basin fallback must never be the primary open-ocean answer."""
    assert named_region_at(*MID_ATLANTIC) == "North Atlantic Ocean"
    assert named_region_at(*NE_PHILIPPINE_SEA) == "Philippine Sea"


def test_live_test_aoi_resolves_to_a_named_region() -> None:
    """The AOI used by the live REAL scan gets real geographic context."""
    result = describe_position(*STRAIT_OF_SINGAPORE)
    assert result["kind"] == "named_region"
    assert result["primary"] == "Strait of Singapore"


def test_basin_fallback_fires_only_where_no_named_polygon_covers() -> None:
    """The Antarctic interior is inside the Southern Ocean box but outside the polygon."""
    assert named_region_at(*ANTARCTIC_INTERIOR) is None
    assert basin_at(*ANTARCTIC_INTERIOR) == "Southern Ocean"
    described = describe_position(*ANTARCTIC_INTERIOR)
    assert described["kind"] == "open_ocean"
    assert described["primary"] is None, "a basin is never presented as a surveyed name"
    assert described["note"], "a fallback must state that it is a fallback"


def test_absent_luzon_strait_falls_back_to_the_enclosing_sea() -> None:
    """Luzon Strait is dropped from the pack, but its area still resolves."""
    assert named_region_at(*LUZON_STRAIT_AREAL) == "South China Sea"
    assert "Luzon Strait" not in {r.name for r in load_regions()}


def test_global_coverage_is_complete() -> None:
    """Recorded as a property: every valid on-Earth position resolves to something.

    Verified on a 4-degree grid after the eastern-Pacific hole was found and
    closed, so a future data change that reintroduces a gap fails visibly rather
    than quietly returning nothing for some positions.
    """
    for lat in range(-88, 89, 4):
        for lon in range(-180, 180, 4):
            result = describe_position(float(lat), float(lon))
            assert result["kind"] != "unresolved", (lat, lon)


@pytest.mark.parametrize(
    "lat,lon",
    [
        (0.0, 200.0),  # longitude does not wrap into the neighbouring basin
        (0.0, -200.0),
        (95.0, 0.0),  # latitude out of range
        (-95.0, 0.0),
        (0.0, float("nan")),
        (float("nan"), 0.0),
        (float("inf"), 0.0),
        (0.0, float("inf")),
    ],
)
def test_invalid_coordinates_are_refused_not_wrapped(lat: float, lon: float) -> None:
    """An out-of-range or non-finite coordinate must not yield a plausible name.

    Longitude 200.0E wrapping to 160.0W and confidently answering "North Pacific
    Ocean" is exactly the fabricated conclusion this project must never produce.
    """
    assert named_region_at(lat, lon) is None
    assert basin_at(lat, lon) is None
    result = describe_position(lat, lon)
    assert result["kind"] == "invalid_position"
    assert result["primary"] is None
    assert result["basin"] is None
    assert "data fault" in (result["note"] or "")


def test_antimeridian_basin_resolves_without_wrapping() -> None:
    """The Pacific is split into two bands at the antimeridian; both must match."""
    assert basin_at(20.0, 170.0) == "North Pacific Ocean"
    assert basin_at(20.0, -170.0) == "North Pacific Ocean"
    # 90W is the eastern Pacific (off Central America), not the Atlantic. The
    # Atlantic band's western edge is 70W.
    assert basin_at(20.0, -90.0) == "North Pacific Ocean"
    assert basin_at(20.0, -60.0) == "North Atlantic Ocean"


def test_specificity_prefers_the_smallest_containing_polygon() -> None:
    """Regions are indexed smallest-bbox-first so a narrow feature can win."""
    regions = load_regions()
    widths = [
        (r.max_lon - r.min_lon) * (r.max_lat - r.min_lat) for r in regions
    ]
    assert widths == sorted(widths), "pack must be sorted by bbox area"


def test_basin_bands_are_disjoint_and_exhaustive() -> None:
    """No longitude may match two bands or none, in the temperate belt."""
    from darkfleet.marine import _BELT_BANDS

    for lon in range(-180, 180):
        matches = [name for name, lo, hi in _BELT_BANDS if lo <= lon < hi]
        assert len(matches) == 1, (lon, matches)
        assert basin_at(20.0, float(lon)) is not None, lon


def test_polar_caps_are_resolved_by_latitude_first() -> None:
    assert basin_at(80.0, 0.0) == "Arctic Ocean"
    assert basin_at(-80.0, 0.0) == "Southern Ocean"
    assert basin_at(65.9, 0.0) in open_ocean_basins()
    assert basin_at(-59.9, 0.0) in open_ocean_basins()


def test_eastern_pacific_gap_is_now_covered() -> None:
    """16N 92W was the hole the old hand-tuned rectangles left."""
    assert basin_at(16.0, -92.0) == "North Pacific Ocean"
    assert named_region_at(16.0, -92.0) is None, "still no named polygon, as recorded"


def test_belt_splits_hemisphere_at_the_equator() -> None:
    assert basin_at(20.0, 0.0) == "North Atlantic Ocean"
    assert basin_at(-20.0, 0.0) == "South Atlantic Ocean"
    assert basin_at(20.0, 90.0) == "North Pacific Ocean"
    assert basin_at(-20.0, 90.0) == "South Pacific Ocean"
    assert basin_at(20.0, 45.0) == "Indian Ocean"
    assert basin_at(-20.0, 45.0) == "Indian Ocean"


def test_region_bounds_contain_their_own_vertices() -> None:
    for region in load_regions():
        for lon, lat in region.rings[0]:
            assert region.min_lon - 1e-9 <= lon <= region.max_lon + 1e-9
            assert region.min_lat - 1e-9 <= lat <= region.max_lat + 1e-9


def test_known_absent_features_are_documented_not_silently_missing() -> None:
    names = {r.name for r in load_regions()}
    assert "Luzon Strait" not in names, "pack drops sliver-only features"
    prov = provenance()
    assert "Luzon Strait" in prov["known_absent"]
    assert "Drake Passage" in prov["known_absent"]


def test_provenance_declares_public_domain_and_provenance() -> None:
    prov = provenance()
    assert prov["license"].startswith("Public domain")
    assert prov["attribution_required"] is False
    assert prov["credit"] == "Made with Natural Earth"
    assert prov["source_commit"] == "ca96624a56bd078437bca8184e78163e5039ad19"
    assert prov["fetched"]
    assert prov["feature_count"] >= 250


def test_point_in_ring_rejects_degenerate_rings() -> None:
    from darkfleet.marine import _point_in_ring

    assert not _point_in_ring(0.0, 0.0, ((0.0, 0.0), (1.0, 0.0)))
    assert not _point_in_ring(0.0, 0.0, ())
    assert not _point_in_ring(0.0, 0.0, ((0.0, 0.0),))


@pytest.mark.parametrize(
    "lat,lon",
    [(0.0, 0.0), (45.0, 90.0), (-30.0, -120.0), (89.0, 179.0), (-89.0, -179.0)],
)
def test_describe_position_is_always_classified(lat: float, lon: float) -> None:
    """Whatever the position, the caller gets a classified answer, never a crash."""
    result = describe_position(lat, lon)
    assert result["kind"] in {"named_region", "open_ocean", "unresolved"}
    assert isinstance(result["named_regions"], list)
    if result["named_regions"]:
        assert isinstance(result["named_regions"][0], str)