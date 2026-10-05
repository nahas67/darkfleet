"""Pin the four analytical-path defects found by the DF-X9 authority trace.

Each test names the failure it prevents and states the DEFECT, because a test that only
asserts current behaviour cannot be read later to tell whether it is guarding a real hazard or
just pinning an accident.

1. An observation that omits SOG raised ``TypeError`` inside correlation. Runtime-confirmed,
   not inferred::

       propagate(1.0, 103.0, None, 90.0, 120.0)
       TypeError: '<' not supported between instances of 'NoneType' and 'float'

   ``correlate`` passed ``ob["sog"]`` straight into ``propagate``, and ``pipeline.py`` passes
   raw archive rows straight into ``correlate``.

2. An un-reported course scored as if it were 0 degrees -- a real course, due north -- which
   let a contact that reported nothing directionally earn a free match against a
   north-oriented hull.

3. The size term was pinned at its 0.8 default on every real archive row, because it read
   ``ob["length"]`` while the archive column is ``length_m``. A 0.15-weighted term was a
   constant.

4. GFW wrote ``sog=0.0, cog=0.0, heading=0.0`` for a source that publishes none of them, which
   both defeated the ``sog < 0.1`` no-propagation guard and asserted a course north.
"""

from __future__ import annotations

import math

import pytest

from darkfleet.ais.gfw import normalize_gfw_event
from darkfleet.ais.models import AisObservation
from darkfleet.correlation.geodesy import dynamic_radius, orient_diff, propagate
from darkfleet.correlation.match import (
    _course_deg,
    _hull_length_m,
    _speed_knots,
    _vessel_name,
    _vessel_type,
)


class TestAbsentKinematicsDeclineRatherThanRaise:
    """The confirmed crash, and the refusal that replaces it."""

    @pytest.mark.parametrize(
        ("sog", "cog"),
        [(None, 90.0), (5.0, None), (None, None)],
    )
    def test_propagate_does_not_raise_on_an_absent_input(self, sog, cog) -> None:
        # This is the line that raised TypeError before the fix.
        result = propagate(1.0, 103.0, sog, cog, 120.0)
        assert result["lat"] == 1.0
        assert result["lon"] == 103.0

    def test_an_absent_speed_projects_nothing(self) -> None:
        # Not "projects a little". Nothing: without a distance there is no projection.
        assert propagate(1.0, 103.0, None, 90.0, 600.0)["projectedDistanceMeters"] == 0.0

    def test_a_real_speed_and_course_still_project(self) -> None:
        # The guard must not have swallowed the normal case.
        result = propagate(1.0, 103.0, 12.0, 90.0, 600.0)
        assert result["lat"] == pytest.approx(1.0, abs=1e-3)
        # 12 kn east for 600 s is about 1.85 km of latitude change... no: 90 degrees is EAST.
        assert result["lon"] > 103.0
        assert result["projectedDistanceMeters"] > 1000.0

    def test_dynamic_radius_treats_an_absent_speed_as_no_allowance(self) -> None:
        # Absence must not WIDEN the search either: a vessel whose speed was not reported has
        # not licensed extra drift.
        assert dynamic_radius(1200.0, 600.0, None, 2800.0) == 1200.0
        # And a real speed still widens it.
        assert dynamic_radius(1200.0, 600.0, 12.0, 2800.0) > 1200.0


class TestSpeedCoercionIsAbsenceNotMeasurement:
    def test_absent_speed_reads_as_zero_motion(self) -> None:
        assert _speed_knots({"sog": None}) == 0.0

    def test_a_real_speed_is_passed_through(self) -> None:
        assert _speed_knots({"sog": 8.5}) == 8.5

    def test_a_missing_key_reads_as_zero_motion(self) -> None:
        assert _speed_knots({}) == 0.0

    def test_a_negative_speed_is_clamped_rather_than_propagating_backwards(self) -> None:
        # The model forbids a negative sog, but a raw archive row is not the model. Clamping
        # is the conservative reading: a vessel does not move backwards through its own wake.
        assert _speed_knots({"sog": -3.0}) == 0.0

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_a_non_finite_speed_raises_rather_than_silently_scoring(self, bad) -> None:
        # NaN would otherwise poison every candidate it touched, because every comparison
        # against it is False and the score becomes silently meaningless.
        with pytest.raises(ValueError, match="non-finite sog"):
            _speed_knots({"sog": bad})


class TestUnreportedCourseIsNotZeroDegrees:
    """
    COG 0 is a real course, due north.

    Reading absence as 0 both asserted a direction the vessel never gave and let the contact
    score as agreeing with a north-oriented hull for free.
    """

    def test_an_absent_course_stays_absent(self) -> None:
        assert _course_deg({"cog": None}) is None
        assert _course_deg({}) is None

    def test_zero_cog_is_preserved_as_a_real_course(self) -> None:
        # The distinction the whole fix rests on: 0 is a value, None is absence.
        assert _course_deg({"cog": 0.0}) == 0.0
        assert _course_deg({"cog": 0.0}) is not None

    def test_a_course_is_normalised_into_range(self) -> None:
        assert _course_deg({"cog": 360.0}) == 0.0
        assert _course_deg({"cog": 370.0}) == 10.0

    def test_a_non_finite_course_reads_as_absent(self) -> None:
        assert _course_deg({"cog": float("nan")}) is None

    def test_orient_diff_still_rejects_a_missing_course_directly(self) -> None:
        # Documenting the underlying behaviour: `orient_diff` is unchanged and still raises on
        # None. The guard lives in `correlate`, which now never passes None. If this ever
        # starts returning a number, the guard has been bypassed.
        with pytest.raises(TypeError):
            orient_diff(45.0, None)  # type: ignore[arg-type]


class TestAbsentCourseWithARealSpeedIsASecondCrashPath:
    """
    THE SECOND WAY CORRELATION CRASHED, found by measurement rather than by reading.

    The obvious failure is an absent SOG reaching ``sog_knots < 0.1`` in ``propagate``. Fixing
    only that leaves a second one: ``correlate`` also called
    ``orient_diff(eff_hdg, ob["cog"])``, and ``orient_diff`` does ``abs(deg1 - deg2) % 180``, so a
    vessel that reported a SPEED but no COURSE raised there instead.

    Both halves are ordinary for real feeds. A vessel transmits position and speed readily and
    course intermittently, so "moving, direction unknown" is a common report rather than an
    exotic one. Under the old code that report aborted the whole CORRELATING stage.

    Proven against a real archive rather than asserted from inspection: a combined run over all
    components and all rows raised ``TypeError: unsupported operand type(s) for -: 'float' and
    'NoneType'`` under HEAD and returned eight targets under the fix.
    """

    @staticmethod
    def _component(lat: float, lon: float) -> dict:
        # Every key `correlate` reads, which is more than the ones the scoring path happens to
        # touch. Building the component from the reader's own list of `comp["..."]` subscripts
        # rather than from a guess -- an incomplete component fails with a KeyError that looks
        # like a product defect and is not one.
        return {
            "lat": lat,
            "lon": lon,
            "major": 12.0,
            "minor": 3.0,
            "area": 40.0,
            "maxDb": -6.0,
            "meanDb": -14.0,
            "clutterMeanDb": -22.0,
            "orient": 0.0,
            "wake": None,
        }

    def test_correlate_survives_a_speed_with_no_course(self) -> None:
        from darkfleet.correlation.match import correlate

        observation = {
            "timestamp": "2026-03-01T12:00:00Z",
            "mmsi": "257000000",
            "lat": 1.0,
            "lon": 103.0,
            "sog": 11.0,
            "cog": None,
            "heading": None,
        }
        # A detection essentially on top of the observation: close enough that the candidate is
        # certainly built, so the test exercises the heading term rather than skipping early.
        out = correlate([self._component(1.0, 103.0)], [observation], "2026-03-01T12:00:00Z", 10.0, "S1")
        assert out["targets"], "expected at least one target from a co-located detection"

    def test_the_heading_term_scores_zero_rather_than_raising(self) -> None:
        # The replacement behaviour: an un-reported course contributes nothing to the heading
        # term. Written out rather than inlined in a conditional expression, because
        # `max(0.0, 1 - orient_diff(0.0, None) / 90) if ... else 0.0` parses as
        # `max(...) if cond else (0.0 == 0.0)`, which asserts nothing about the score at all.
        cog = _course_deg({"cog": None})
        assert cog is None
        score = max(0.0, 1 - orient_diff(0.0, cog) / 90) if cog is not None else 0.0
        assert score == 0.0

    def test_a_speed_with_no_course_still_declines_propagation(self) -> None:
        # With no course there is no direction to project along, so the position must not move
        # even though a speed was reported.
        result = propagate(1.0, 103.0, _speed_knots({"sog": 11.0}), _course_deg({"cog": None}), 600.0)
        assert result["lat"] == 1.0
        assert result["lon"] == 103.0
        assert result["projectedDistanceMeters"] == 0.0


class TestFieldSpellingAcrossGoldenAndArchive:
    """
    The archive stores ``length_m`` / ``name`` / ``ship_type``; the golden fixture and the
    correlation-input shape use ``length`` / ``shipName`` / ``shipType``.

    Reading only the fixture spelling meant the size term was a constant and every real
    contact presented as unnamed.
    """

    def test_the_canonical_archive_spelling_is_read(self) -> None:
        assert _hull_length_m({"length_m": 90.0}) == 90.0
        assert _vessel_name({"name": "MV TEST"}) == "MV TEST"
        assert _vessel_type({"ship_type": "Cargo"}) == "Cargo"

    def test_the_golden_fixture_spelling_is_still_read(self) -> None:
        # Parity with the golden run is not optional, so the fixture spelling must keep working.
        assert _hull_length_m({"length": 90.0}) == 90.0
        assert _vessel_name({"shipName": "MV TEST"}) == "MV TEST"
        assert _vessel_type({"shipType": "Cargo"}) == "Cargo"

    def test_canonical_wins_when_both_are_present(self) -> None:
        # Not "either": a row carrying both must not pick by dict ordering.
        assert _hull_length_m({"length": 10.0, "length_m": 90.0}) == 90.0
        assert _vessel_name({"shipName": "WRONG", "name": "RIGHT"}) == "RIGHT"

    def test_absence_is_none_not_zero(self) -> None:
        # A length of 0 would make the size guard skip, which is the bug being fixed, so 0
        # must read as absent rather than as a genuine zero-metre vessel.
        assert _hull_length_m({"length_m": 0.0}) is None
        assert _hull_length_m({}) is None
        assert _vessel_name({"name": "   "}) is None
        assert _vessel_name({"name": None}) is None

    def test_an_unreadable_length_is_absent_not_an_exception(self) -> None:
        assert _hull_length_m({"length_m": "not a number"}) is None
        assert _hull_length_m({"length_m": None}) is None


class TestGfwInventsNoKinematics:
    """
    GFW is a fishing-activity dataset: position, vessel, time, and nothing else.

    It previously wrote three zeros, which asserted three measurements nobody made.
    """

    @staticmethod
    def _event() -> dict:
        return {
            "start": "2024-01-01T00:00:00Z",
            "type": "fishing",
            "position": {"lat": 1.5, "lon": 103.5},
            "vessel": {"mmsi": "257000000", "name": "NORTH STAR", "type": "fishing"},
        }

    def test_position_and_identity_survive(self) -> None:
        obs = normalize_gfw_event(self._event())
        assert obs is not None
        assert obs.lat == pytest.approx(1.5)
        assert obs.lon == pytest.approx(103.5)
        assert obs.mmsi == "257000000"
        assert obs.source == "gfw"

    @pytest.mark.parametrize("field", ["sog", "cog", "heading"])
    def test_no_kinematics_are_fabricated(self, field) -> None:
        obs = normalize_gfw_event(self._event())
        assert obs is not None
        # THE assertion. A 0.0 here would be a measurement nobody made.
        assert getattr(obs, field) is None

    def test_the_absent_speed_still_declines_propagation(self) -> None:
        # The guard `propagate` relies on: an un-reported speed must not license a projection.
        # With sog=0.0 the old code passed `sog < 0.1` and projected the vessel as stationary
        # rather than declining, which is the failure.
        obs = normalize_gfw_event(self._event())
        assert obs is not None
        result = propagate(obs.lat, obs.lon, _speed_knots({"sog": obs.sog}), None, 600.0)
        assert result["projectedDistanceMeters"] == 0.0

    def test_the_absent_course_scores_zero_rather_than_matching_north(self) -> None:
        # A north-oriented hull must not get a free heading match from a vessel that reported
        # no course at all.
        obs = normalize_gfw_event(self._event())
        assert obs is not None
        cog = _course_deg({"cog": obs.cog})
        score = max(0.0, 1 - orient_diff(0.0, cog) / 90) if cog is not None else 0.0
        assert score == 0.0

    def test_a_registry_only_event_is_still_skipped(self) -> None:
        # The other half of the function's contract, unchanged.
        assert normalize_gfw_event({"start": "2024-01-01T00:00:00Z", "vessel": {}}) is None


class TestModelStillForbidsFabricatedKinematics:
    """The model is the last line: absent is None, and the sentinel is not a value."""

    def test_the_model_rejects_an_out_of_range_course(self) -> None:
        with pytest.raises(ValueError):
            AisObservation(
                timestamp="2024-01-01T00:00:00Z",
                mmsi="257000000",
                lat=1.0,
                lon=103.0,
                cog=400.0,
            )

    def test_null_is_accepted_and_is_distinct_from_zero(self) -> None:
        absent = AisObservation(
            timestamp="2024-01-01T00:00:00Z", mmsi="257000000", lat=1.0, lon=103.0
        )
        measured_zero = AisObservation(
            timestamp="2024-01-01T00:00:00Z", mmsi="257000000", lat=1.0, lon=103.0, cog=0.0
        )
        assert absent.cog is None
        assert measured_zero.cog == 0.0
        assert absent.cog is not measured_zero.cog
        assert math.isnan(measured_zero.cog - measured_zero.cog) is False
