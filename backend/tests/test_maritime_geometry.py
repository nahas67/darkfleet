"""Maritime geometry: axis order, antimeridian, honest distances.

These are the calculations DF-X8 §24 makes a single authority. If they are wrong
every contextual statement about a vessel is wrong in a way that looks plausible, so
each is pinned. Synthetic and deterministic: no network (DF-X8 §59).
"""

from __future__ import annotations

import math

import pytest

from darkfleet.maritime.geometry import (
    DistanceMethod,
    DistanceResult,
    LonLat,
    bounding_box_of,
    geodesic_m,
    nearest_point,
    normalize_span,
    planar_degree_distance,
    unwrap_lon,
    within_span,
)


class TestLonLatOrderIsEnforced:
    """GeoJSON is (lon, lat). The type validates, so a swap fails loudly."""

    def test_a_transposed_pair_is_rejected(self) -> None:
        # Singapore is 103E, 1N. Passing them the other way gives latitude 103,
        # which is not a latitude. Silently accepting that puts a vessel in the
        # Gulf of Guinea.
        with pytest.raises(ValueError, match="latitude"):
            LonLat(lon=1.3343, lat=103.9314).validate()

    def test_a_mid_longitude_transposition_is_NOT_caught_by_range(self) -> None:
        """
        The honest limit of a range check, pinned rather than glossed.

        Swapping the axes makes the original LONGITUDE land in the latitude field, so
        a range check catches the transposition exactly when ``|lon| > 90``:

            Singapore (lon 103.9, lat 1.3)  -> transposed lat 103.9  -> RAISES
            London    (lon -0.12, lat 51.5) -> transposed lat -0.12  -> accepted

        No range check can do better without a second source of truth for which axis
        is which, which is precisely what the parameter NAMES are for. This test
        exists so nobody later claims the type makes transposition impossible; it
        narrows the claim to "loud for eastern and western longitudes, silent near
        Greenwich".
        """
        # Singapore: longitude 103.9 becomes latitude 103.9, out of range.
        with pytest.raises(ValueError, match="latitude"):
            LonLat(lon=1.3343, lat=103.9314).validate()

        # London: transposed latitude is -0.12, entirely in range, and accepted.
        # That is the documented gap, not an oversight.
        assert LonLat(lon=-0.1276, lat=51.5072).validate() is None
        assert LonLat(lon=51.5072, lat=-0.1276).validate() is None

    def test_a_correct_pair_and_the_extremes_validate(self) -> None:
        LonLat(lon=103.9314, lat=1.3343).validate()
        LonLat(lon=180.0, lat=90.0).validate()
        LonLat(lon=-180.0, lat=-90.0).validate()


class TestAntimeridian:
    """DF-X8 §50: `west < east` is false across much of the ocean."""

    def test_unwrap_pulls_a_far_pacific_pair_together(self) -> None:
        # Samoa 172W and Fiji 178E are ~10 degrees apart, not 350.
        assert abs(abs(unwrap_lon(-172.0, 178.0) - 178.0) - 10.0) < 1e-9

    def test_a_crossing_span_contains_both_sides_and_not_the_far_world(self) -> None:
        span = normalize_span(170.0, -170.0)
        assert span.crosses_antimeridian is True
        assert span.contains(175.0) and span.contains(-175.0)
        assert span.contains(0.0) is False

    def test_a_normal_span_is_not_marked_crossing(self) -> None:
        span = normalize_span(100.0, 110.0)
        assert span.crosses_antimeridian is False
        assert span.contains(105.0) and not span.contains(95.0)

    def test_nearest_across_the_antimeridian_is_found(self) -> None:
        # 179E is 1.5 degrees from 179.5W, which at the equator is ~167 km. The
        # naive reading treats them as 358.5 degrees apart, which is ~39,900 km --
        # so without unwrapping the port would be out of range entirely.
        result = nearest_point(
            LonLat(lon=-179.5, lat=0.0), [("PORT_FAR", 179.0, 0.0, None)], max_radius_m=500_000
        )
        assert result.result is DistanceResult.MEASURED
        assert result.feature_id == "PORT_FAR"
        assert result.meters is not None
        # 1.5 deg * 111_320 m/deg = 166_980 m, within a kilometre.
        assert 166_000 < result.meters < 168_000, result.meters

    def test_a_point_on_the_far_side_is_out_of_range_not_far(self) -> None:
        result = nearest_point(
            LonLat(lon=-179.5, lat=0.0), [("PORT_OPPOSITE", -1.0, 0.0, None)], max_radius_m=500_000
        )
        assert result.result is DistanceResult.OUT_OF_RANGE
        assert result.meters is None

    def test_bounding_box_tightens_across_the_antimeridian(self) -> None:
        # Naive min/max gives a 358-degree box; correct is 4 degrees.
        span = bounding_box_of([(179.0, 10.0), (-179.0, 10.0)])
        assert span.crosses_antimeridian is True
        assert span.contains(179.5) and span.contains(-179.5)
        assert not span.contains(0.0)


class TestDistanceHonesty:
    def test_a_measured_distance_names_its_method(self) -> None:
        result = nearest_point(
            LonLat(lon=103.9, lat=1.3), [("PORT", 104.0, 1.3, None)], max_radius_m=200_000
        )
        assert result.method is DistanceMethod.GEODESIC_METER
        assert result.measured is True

    def test_out_of_range_is_null_not_a_big_number(self) -> None:
        # "nothing within 200 km" and "nearest is 43,000 km away" support opposite
        # conclusions, so they must not render the same.
        result = nearest_point(
            LonLat(lon=0.0, lat=0.0), [("PORT", 100.0, 0.0, None)], max_radius_m=200_000
        )
        assert result.result is DistanceResult.OUT_OF_RANGE
        assert result.meters is None
        assert result.searched_radius_m == 200_000

    def test_an_empty_candidate_set_is_out_of_range(self) -> None:
        assert nearest_point(LonLat(lon=0.0, lat=0.0), [], max_radius_m=1000).measured is False

    def test_malformed_candidates_are_skipped_not_fatal(self) -> None:
        # A corrupt row in a port table must not take the query down.
        result = nearest_point(
            LonLat(lon=0.0, lat=0.0),
            [("BAD", "not-a-number", 0.0, None), ("GOOD", 0.01, 0.0, None)],
            max_radius_m=200_000,
        )
        assert result.feature_id == "GOOD"

    def test_planar_and_geodesic_are_different_numbers(self) -> None:
        # The reason the method is reported: presenting degrees as metres is wrong.
        planar = planar_degree_distance(103.9, 1.3, 104.2, 1.3)
        exact = geodesic_m(103.9, 1.3, 104.2, 1.3)
        assert planar > 0 and exact > 0
        assert abs(planar - exact) > 1.0

    def test_geodesic_is_zero_for_the_same_point_and_symmetric(self) -> None:
        assert geodesic_m(103.9, 1.3, 103.9, 1.3) == pytest.approx(0.0, abs=0.5)
        assert geodesic_m(103.9, 1.3, 104.2, 1.4) == pytest.approx(
            geodesic_m(104.2, 1.4, 103.9, 1.3), rel=1e-9
        )


class TestPolarRegions:
    """DF-X8 §51: high latitudes must not crash, and must not be quietly wrong."""

    def test_it_does_not_crash_near_the_pole(self) -> None:
        result = nearest_point(
            LonLat(lon=0.0, lat=89.9), [("P", 1.0, 89.9, None)], max_radius_m=500_000
        )
        assert result.result in (DistanceResult.MEASURED, DistanceResult.OUT_OF_RANGE)

    def test_one_degree_of_longitude_shrinks_toward_the_pole(self) -> None:
        # A planar distance ignoring latitude would return the same number at 80N as
        # at the equator.
        at_equator = planar_degree_distance(0.0, 0.0, 1.0, 0.0)
        at_pole = planar_degree_distance(0.0, 80.0, 1.0, 80.0)
        assert at_pole < at_equator * 0.5
        assert at_pole == pytest.approx(math.cos(math.radians(80.0)), rel=1e-6)

    def test_the_pole_itself_is_a_valid_position(self) -> None:
        LonLat(lon=0.0, lat=90.0).validate()
        assert geodesic_m(0.0, 90.0, 0.0, 89.0) == pytest.approx(111_195, rel=0.01)


class TestCombinedSpan:
    def test_within_span_checks_both_axes(self) -> None:
        span = normalize_span(100.0, 110.0)
        assert within_span(105.0, 1.0, (0.0, 10.0), span) is True
        assert within_span(105.0, 20.0, (0.0, 10.0), span) is False
        assert within_span(95.0, 1.0, (0.0, 10.0), span) is False
