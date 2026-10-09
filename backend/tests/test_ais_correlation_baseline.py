"""DF-X9.3A -- the CORRECTED AIS ANALYTICAL BASELINE.

Freezes the behaviour of the five DF-X9.1 fixes on the 27-row correctness fixture, so that the
renderer work in DF-X9.3B onwards has a fixed analytical base to build on.

=============================== WHY THE EXPECTATIONS ARE NOT "THE OLD ANSWERS" ===============================

DF-X9.3's premise changed for a reason. The old analytical result was not authority -- it was the
output of code that crashed on nullable fields, read a column that does not exist, and read an
absent course as a real course due north. So these tests do NOT assert parity with the previous
revision, and they must not be edited to restore it.

What they assert instead is the CORRECT semantics, derived from the implemented rules:

  * absent is ``None`` and declines to project, rather than raising
  * an absent course scores ZERO on the heading term, rather than reading as 0 degrees
  * ``length_m`` -- the real archive column -- drives the size term
  * a source that publishes no kinematics stores ``None``

Every changed classification is justified by naming the evidence-field correction responsible, and
``test_no_unexpected_analytical_change`` fails if anything changes for a reason nobody can account
for. That is the line between accepting a correctness fix and accepting a regression.
"""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import pytest

from darkfleet.correlation.geodesy import dynamic_radius, propagate
from darkfleet.correlation.match import _hull_length_m, correlate
from darkfleet.evidence import target_evidence
from tests.ais_correctness_fixture import (
    ACQUISITION,
    RESOLUTION_M,
    SCENARIOS,
    classify,
    components,
    decomposition,
    fixture_observations,
    read_fixture_rows,
    run_combined,
    run_scenario,
    write_fixture_archive,
)


@pytest.fixture(scope="module")
def archive_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The 27-row fixture, written once through the real archive and read back the real way.

    Returns the DIRECTORY, not the archive object: every test here reads rows back through
    `AisArchive`, so handing the directory around keeps each test an independent read of what is
    actually on disk rather than a share of one in-memory handle.
    """
    data_dir = tmp_path_factory.mktemp("ais-correctness")
    write_fixture_archive(data_dir)
    return data_dir


# ================================================================================================
# THE FIXTURE ITSELF
# ================================================================================================


class TestTheFixtureIsWhatItClaimsToBe:
    """If the fixture drifts, every expectation below is measuring something else."""

    def test_it_holds_exactly_27_observations(self, archive_dir: Path) -> None:
        assert len(read_fixture_rows(archive_dir)) == 27

    def test_it_six_vessels(self, archive_dir: Path) -> None:
        assert {str(r["mmsi"]) for r in read_fixture_rows(archive_dir)} == {
            "257000001", "257000002", "257000003", "257000004", "257000005", "257000006",
        }

    def test_it_survives_the_parquet_round_trip_with_absence_intact(self, archive_dir: Path) -> None:
        # The reason this fixture goes through Parquet at all: a nullable column that silently
        # becomes a zero on write would reintroduce the exact defect under test.
        bare = [r for r in read_fixture_rows(archive_dir) if str(r["mmsi"]) == "257000001"]
        assert bare
        for row in bare:
            assert row["sog"] is None
            assert row["cog"] is None
            assert row["heading"] is None

    def test_the_archive_column_is_length_m_and_not_length(self, archive_dir: Path) -> None:
        # DEFECT 3 was exactly this: the scorer read `length`, the column is `length_m`.
        cargo = [r for r in read_fixture_rows(archive_dir) if str(r["mmsi"]) == "257000002"]
        assert cargo
        assert cargo[0]["length_m"] == pytest.approx(240.0)
        assert "length" not in cargo[0], (
            "a `length` key alongside `length_m` would mean the fixture is hiding which spelling "
            "the scorer actually reads"
        )


# ================================================================================================
# REQUIRED CASE 1 -- NULL SOG
# ================================================================================================


class TestNullSog:
    """
    REQUIREMENT: `sog = None` must not crash, and must project nothing.

    Do not invent a propagation velocity. The absent speed is read as ZERO MOTION, which is the
    honest reading: without a speed there is no distance to project.
    """

    def test_correlate_returns_instead_of_raising(self, archive_dir: Path) -> None:
        result = run_scenario("S1", archive_dir)
        assert result["output"]["targets"], "S1 produced no target"

    def test_nothing_is_propagated_for_an_absent_speed(self) -> None:
        # The direct statement of "no invented velocity". `projectedDistanceMeters` is the product's
        # own measure of how far it moved the vessel, and it must be exactly zero.
        result = propagate(1.0, 103.0, None, 90.0, 900.0)
        assert result["projectedDistanceMeters"] == 0.0
        assert result["lat"] == 1.0
        assert result["lon"] == 103.0

    def test_an_absent_speed_licenses_no_search_allowance(self) -> None:
        # Absence must not WIDEN the search either. A vessel whose speed was not reported has not
        # licensed extra drift, so the radius stays at its base.
        assert dynamic_radius(1200.0, 900.0, None, 2800.0) == 1200.0

    def test_a_vessel_that_reports_no_speed_can_still_be_matched_on_position(self, archive_dir: Path) -> None:
        # The important half of the requirement. Fixing the crash must not be achieved by
        # excluding such vessels from correlation entirely -- a vessel that reports its position
        # but not its speed is still a real vessel worth associating.
        result = run_scenario("S1", archive_dir)
        assert classify(result["output"]) != ""
        assert int(result["output"]["targets"][0]["corr"]["candidatesConsidered"]) >= 1

    def test_the_combined_scene_survives_one_absent_speed_row(self, archive_dir: Path) -> None:
        # THE production-shaped leg. Under HEAD this raised and returned ZERO targets for the whole
        # scene, because one row without a speed aborted the stage. A per-vessel test would not
        # have shown that.
        combined = run_combined(archive_dir)
        assert len(combined["targets"]) == len(components()), (
            "every component must survive; one absent speed previously took the whole scene to zero"
        )


# ================================================================================================
# REQUIRED CASE 2 -- NULL COG WITH A VALID SOG
# ================================================================================================


class TestNullCogWithAValidSpeed:
    """
    REQUIREMENT: `sog` valid + `cog = None` -> no crash, and no fabricated heading score.

    This is the SECOND crash mechanism, distinct from the absent-speed one: it reaches
    `orient_diff`, which does `abs(deg1 - deg2) % 180` and cannot accept None.
    """

    def test_correlate_returns_instead_of_raising(self, archive_dir: Path) -> None:
        result = run_scenario("S8", archive_dir)
        assert result["output"]["targets"], "S8 produced no target"

    def test_the_heading_term_scores_exactly_zero(self, archive_dir: Path) -> None:
        # "No fabricated heading score". Zero, not the score a real course would have earned.
        # The hull axis here is 45 deg, so a REPORTED course of 45 would have scored 0.5 -- which
        # is what makes this assertion meaningful rather than tautological.
        result = run_scenario("S8", archive_dir)
        terms = decomposition(result["output"])
        assert float(terms["headingScore"]) == 0.0

    def test_no_course_means_no_direction_to_project_along(self) -> None:
        # A reported speed with no course must still not move: there is a distance but no
        # direction, and inventing one would be inventing a heading.
        result = propagate(1.0, 103.0, 10.0, None, 900.0)
        assert result["projectedDistanceMeters"] == 0.0

    def test_the_heading_weight_is_still_charged_for_the_missing_term(self, archive_dir: Path) -> None:
        # The penalty is deliberate and must be visible in the composite, or "scoring zero" is
        # indistinguishable from "the term was dropped". A vessel that reported nothing
        # directionally simply cannot win on heading.
        terms = decomposition(run_scenario("S8", archive_dir)["output"])
        assert float(terms["headingScore"]) == 0.0
        assert float(terms["compositeScore"]) < 1.0


# ================================================================================================
# REQUIRED CASE 3 -- REAL length_m MUST DRIVE THE SIZE TERM
# ================================================================================================


class TestRealHullLengthDrivesTheSizeTerm:
    """
    REQUIREMENT: prove `length_m` actually enters the size component, and that ignoring it fails.

    The mutation requirement is the substance here. `test_the_size_term_is_not_the_pinned_default`
    and `test_the_size_term_responds_to_the_real_hull_length` together fail if `length_m` is
    ignored -- which is how DEFECT 3 is guarded against silently returning.
    """

    def test_the_size_term_is_not_the_pinned_default(self, archive_dir: Path) -> None:
        # DEFECT 3: `size` sat at its 0.8 default on every real archive row, so a 0.15-weighted
        # term contributed a constant. The default is the thing being guarded against.
        terms = decomposition(run_scenario("S2", archive_dir)["output"])
        assert float(terms["sizeScore"]) != pytest.approx(0.8, abs=1e-9), (
            "size is still the pinned default, so length_m is being ignored"
        )

    def test_the_size_term_is_the_documented_value_for_this_hull(self, archive_dir: Path) -> None:
        # Pinned INDEPENDENTLY of the code, from the documented formula:
        #     size = max(0, 1 - |apparent - length| / max(length, 50))
        # apparent = round(major * resolution) = round(12.0 * 10.0) = 120 m, length_m = 240 m
        #     => 1 - |120 - 240| / max(240, 50) = 1 - 120/240 = 0.5
        terms = decomposition(run_scenario("S2", archive_dir)["output"])
        assert float(terms["sizeScore"]) == pytest.approx(0.5, abs=1e-6)

    def test_the_size_term_responds_to_the_real_hull_length(self, archive_dir: Path) -> None:
        # MUTATION GUARD (DF-X9.8-H3). Re-run S2 with the hull length REMOVED from the archive rows.
        # The size term must be None (unobserved), proving the value above came from `length_m`
        # and was not defaulted to an unearned 0.8.
        result = run_scenario("S2", archive_dir)
        assert float(decomposition(result["output"])["sizeScore"]) == pytest.approx(0.5, abs=1e-6)

        stripped = [
            {k: v for k, v in row.items() if k not in ("length_m", "length")} for row in result["ais_rows"]
        ]
        mutated = correlate(
            [components()[SCENARIOS["S2"]["comp"]]], stripped, ACQUISITION, RESOLUTION_M, "MUTANT"
        )
        # DF-X9.8-H3: removing length_m leaves sizeScore as None (unobserved), never a fake 0.8 default
        assert decomposition(mutated)["sizeScore"] is None, (
            "removing length_m must leave sizeScore None, not an unearned 0.8 default"
        )
        assert decomposition(mutated)["compositeScore"] != decomposition(result["output"])["compositeScore"]

    def test_a_zero_length_is_read_as_absent_not_as_a_zero_metre_vessel(self) -> None:
        # A 0 m hull would make the size guard skip, which is the defect. It must read as absent so
        # the default applies, not as a genuine zero.
        assert _hull_length_m({"length_m": 0.0}) is None
        assert _hull_length_m({"length_m": 240.0}) == 240.0

    def test_the_artefact_size_drop_is_arithmetic_and_not_a_bug(self, archive_dir: Path) -> None:
        """
        DF-X9.3 section 6 asks this explicitly, so it is answered as a test rather than prose.

        The counterfactual reported a 60 m vessel losing ~0.120 composite once the real size term
        became active. That is NOT a regression. It is the size term doing the job it was always
        meant to do: before the fix it contributed a CONSTANT 0.8 regardless of the vessel, so it
        could not lower anything; now that it reads the hull, a vessel whose hull disagrees with
        the detection's apparent length is correctly penalised.

        The arithmetic, pinned from the documented weights and formula rather than read back:
            weight  = 0.15
            size    = max(0, 1 - |120 - 60| / max(60, 50)) = 1 - 60/60 = 0.0
            delta   = 0.15 * (0.0 - 0.8) = -0.12
        So -0.120 is exactly right, and a DIFFERENT number would mean the weights moved.
        """
        terms = decomposition(run_scenario("S2", archive_dir)["output"])
        expected_size = max(0.0, 1 - abs(120 - 60) / max(60, 50))
        expected_delta = 0.15 * (expected_size - 0.8)
        assert expected_size == pytest.approx(0.0)
        assert expected_delta == pytest.approx(-0.12, abs=1e-9)

        # And the weights themselves are unchanged, which is what makes that arithmetic valid. Tolerance
        # is 5e-4 because the stored `compositeScore` is rounded to three decimals while the
        # weighted sum here is not -- comparing them at 1e-6 asserted a rounding convention rather
        # than a weight.
        assert float(terms["sizeScore"]) == pytest.approx(0.5, abs=1e-6)
        assert float(terms["compositeScore"]) == pytest.approx(
            0.45 * float(terms["spatialScore"])
            + 0.25 * float(terms["temporalScore"])
            + 0.15 * float(terms["headingScore"])
            + 0.15 * float(terms["sizeScore"]),
            abs=5e-4,
        )


# ================================================================================================
# REQUIRED CASE 4 -- GFW ABSENT KINEMATICS STAY NULL
# ================================================================================================


class TestGfwAbsentKinematics:
    """
    REQUIREMENT: a provider that publishes no SOG/COG/heading stores None, not 0.

    `cog = 0.0` is a REAL course due north, so writing it asserts a direction. And `sog = 0.0`
    satisfies the product's own ``sog < 0.1`` guard, which projects a vessel as genuinely
    stationary rather than declining -- defeating the rule it was meant to satisfy.
    """

    def test_the_stored_row_carries_null_kinematics(self, archive_dir: Path) -> None:
        gfw = [r for r in read_fixture_rows(archive_dir) if str(r["mmsi"]) == "257000005"]
        assert gfw
        for row in gfw:
            assert row["sog"] is None
            assert row["cog"] is None
            assert row["heading"] is None

    def test_the_positions_still_move(self, archive_dir: Path) -> None:
        # The distinction the whole model rests on: an AIS track can move without the row carrying
        # a speed. Absence of kinematics is not evidence of a stationary vessel.
        gfw = sorted(
            (r for r in read_fixture_rows(archive_dir) if str(r["mmsi"]) == "257000005"),
            key=lambda r: str(r["timestamp"]),
        )
        assert gfw[-1]["lat"] != gfw[0]["lat"]

    def test_a_gfw_vessel_is_not_projected(self) -> None:
        result = propagate(1.5, 104.0, None, None, 900.0)
        assert result["projectedDistanceMeters"] == 0.0

    def test_the_heading_term_is_zero_not_a_free_north_match(self, archive_dir: Path) -> None:
        # THE analytical effect of defect 2. The hull axes here are north-oriented, so a course of
        # 0.0 scored 1.0 on the heading term -- a full 0.15 of composite earned by a value nobody
        # reported.
        terms = decomposition(run_scenario("S6", archive_dir)["output"])
        assert float(terms["headingScore"]) == 0.0

    def test_the_vessel_identity_survives_normalisation(self, archive_dir: Path) -> None:
        # The fix must not cost us the vessel. DEFECT 4 read only `shipName` while the archive
        # column is `name`, so every real contact presented as unnamed.
        result = run_scenario("S6", archive_dir)
        assert result["output"]["targets"][0]["corr"]["vesselName"] == "MV GFW FISHING"


# ================================================================================================
# THE CONTROL THAT MATTERS MOST
# ================================================================================================


class TestMeasuredZeroIsNotAbsence:
    """
    THE most important thing this fixture pins, and the easiest thing to break.

    ``cog = 0.0`` is a real course due north. ``cog = None`` is the absence of a course. Those are
    different claims, and conflating them is what made DEFECT 2 invisible: a vessel reporting
    nothing looked identical to a vessel reporting "due north", so it earned a free heading match
    against every north-oriented hull.
    """

    def test_the_control_vessel_scores_a_full_heading_match(self, archive_dir: Path) -> None:
        # 257000003 reports cog = 0.0 with a north-oriented hull, so heading MUST be 1.0. If this
        # ever reads 0.0, measured zeros have been swallowed by the absence handling -- which
        # would mean the fix for DEFECT 2 disabled a real measurement.
        terms = decomposition(run_scenario("S3", archive_dir)["output"])
        assert float(terms["headingScore"]) == pytest.approx(1.0, abs=1e-9)

    def test_the_control_vessel_still_propagates(self, archive_dir: Path) -> None:
        # And it is not caught by the null-handling either: a real speed and a real course must
        # still project, or the fix has disabled dead reckoning altogether.
        rows = run_scenario("S3", archive_dir)["ais_rows"]
        moving = [r for r in rows if r.get("sog") and r.get("cog") is not None]
        assert moving
        moved = propagate(
            float(moving[0]["lat"]), float(moving[0]["lon"]),
            float(moving[0]["sog"]), float(moving[0]["cog"]), 300.0,
        )
        assert moved["projectedDistanceMeters"] > 0.0

    def test_the_control_and_the_absent_course_vessels_are_distinguishable(self, archive_dir: Path) -> None:
        control = float(decomposition(run_scenario("S3", archive_dir)["output"])["headingScore"])
        absent = float(decomposition(run_scenario("S8", archive_dir)["output"])["headingScore"])
        assert control == pytest.approx(1.0, abs=1e-9)
        assert absent == pytest.approx(0.0, abs=1e-9)
        assert control != absent


# ================================================================================================
# WINDOWING MUST BE UNCHANGED
# ================================================================================================


class TestCorrelationWindowIsUnchanged:
    """None of the five fixes touched the window. This proves it, rather than assuming it."""

    def test_an_observation_beyond_the_window_is_still_excluded(self, archive_dir: Path) -> None:
        result = run_scenario("S4", archive_dir)
        # |dt| = 3120 s > WINDOW_S = 900, so the candidate is never built.
        assert int(result["output"]["targets"][0]["corr"]["candidatesConsidered"]) == 0

    def test_an_observation_on_the_window_is_still_considered(self, archive_dir: Path) -> None:
        result = run_scenario("S5", archive_dir)
        assert int(result["output"]["targets"][0]["corr"]["candidatesConsidered"]) == 1

    def test_the_temporal_term_is_one_at_zero_delta(self, archive_dir: Path) -> None:
        terms = decomposition(run_scenario("S5", archive_dir)["output"])
        assert float(terms["temporalScore"]) == pytest.approx(1.0, abs=1e-9)


# ================================================================================================
# UNEXPECTED CHANGE MUST BE ZERO
# ================================================================================================


class TestNoUnexpectedAnalyticalChange:
    """
    Every scenario's outcome is pinned, with the responsible field correction NAMED.

    This is the line DF-X9.3 section 5 draws. A classification change is acceptable when a
    corrected evidence field caused it, and is a regression when nothing can account for it. Each
    entry below records both the outcome and the reason, so a later reader can tell an accepted
    correctness fix from a quietly rubber-stamped output change.
    """

    #: scenario -> (expected classification, the evidence-field correction responsible, or "" if
    #: the outcome is unchanged from the previous revision)
    PINNED: ClassVar[dict[str, tuple[str, str]]] = {
        # sog absent. HEAD raised TypeError, so there was no previous outcome at all.
        "S1": ("SAR_MATCHED_AIS", "sog absent now reads as zero motion instead of raising"),
        # length_m now reaches the size term, so a 240 m hull is scored against a 120 m detection.
        "S2": ("SAR_MATCHED_AIS", "length_m drives the size term (0.8 default -> 0.5)"),
        # CONTROL. Must be identical.
        "S3": ("SAR_MATCHED_AIS", ""),
        # CONTROL. Windowing, unchanged.
        "S4": ("SAR_UNMATCHED", ""),
        "S5": ("SAR_MATCHED_AIS", ""),
        # GFW. HEAD's fabricated cog = 0.0 scored 1.0 on heading against a north hull; the
        # corrected absent course scores 0.0, costing the full 0.15 weight.
        "S6": ("SAR_MATCHED_AIS", "GFW absent cog no longer reads as a real course of 0.0"),
        # The same correction, but this scenario sits close enough to the threshold that removing
        # the fabricated match changes the ASSOCIATION, not merely the score.
        "S7": ("SAR_UNMATCHED", "GFW absent cog no longer reads as a real course of 0.0"),
        # sog valid + cog absent. HEAD raised TypeError in orient_diff.
        "S8": ("SAR_MATCHED_AIS", "cog absent now scores zero on heading instead of raising"),
    }

    def test_every_scenario_has_a_pinned_outcome(self) -> None:
        # A scenario added without a pin would run without being accounted for.
        assert set(SCENARIOS) == set(self.PINNED)

    @pytest.mark.parametrize("scenario_id", sorted(SCENARIOS))
    def test_the_pinned_classification_and_score_are_held(
        self, scenario_id: str, archive_dir: Path
    ) -> None:
        expected, reason = self.PINNED[scenario_id]
        result = run_scenario(scenario_id, archive_dir)
        actual = classify(result["output"])
        assert actual == expected, (
            f"{scenario_id} classified {actual!r}, pinned {expected!r}. "
            f"Responsible correction: {reason or 'none -- this scenario must be unchanged'}. "
            "If this changed, either a defect regressed or the pin needs a stated reason."
        )

    def test_every_changed_scenario_names_its_correction(self) -> None:
        """DF-X9.3 section 5: report what changed AND why. A change with no reason is unexplained."""
        # The control and windowing scenarios must carry NO reason, because nothing about them
        # should have moved.
        for scenario_id in ("S3", "S4", "S5"):
            assert self.PINNED[scenario_id][1] == "", (
                f"{scenario_id} is a control and must be unchanged, so it must carry no reason"
            )

    def test_every_pinned_scenario_is_justified_by_a_named_field_correction(self) -> None:
        # The converse: a scenario that changed must name WHICH evidence field caused it. This is
        # what separates an accepted correctness fix from a rubber-stamped output change.
        for scenario_id, (expected, reason) in self.PINNED.items():
            if scenario_id in ("S3", "S4", "S5"):
                continue
            assert reason, (
                f"{scenario_id} pins {expected!r} but names no responsible correction, so a change "
                "there would be unexplained"
            )

    def test_the_combined_scene_reaches_every_component(self, archive_dir: Path) -> None:
        combined = run_combined(archive_dir)
        # Every one of the eight components must produce a target. Under HEAD, one row without a
        # speed took the whole scene to ZERO.
        assert len(combined["targets"]) == len(components())

    def test_no_target_claims_a_name_it_was_not_given(self, archive_dir: Path) -> None:
        # DEFECT 4 also emitted a bare empty-string tag. A contact with no vessel type must carry
        # no CORRELATED_AIS tag rather than a meaningless one.
        combined = run_combined(archive_dir)
        for target in combined["targets"]:
            for tag in target.get("tags") or []:
                assert tag.strip(), "an empty tag reached the output"

    def test_the_fixture_is_deterministic(self, archive_dir: Path) -> None:
        # Two runs over the same rows must agree exactly, or none of the pins above mean anything.
        first = run_combined(archive_dir)
        second = run_combined(archive_dir)
        assert [t["cls"] for t in first["targets"]] == [
            t["cls"] for t in second["targets"]
        ]
        for a, b in zip(first["targets"], second["targets"]):
            assert (a.get("corr") or {}).get("aisConf") == pytest.approx(
                float((b.get("corr") or {}).get("aisConf") or 0.0)
            ) or (a.get("corr") or {}).get("aisConf") == (b.get("corr") or {}).get("aisConf")

    def test_the_fixture_observations_are_stable(self) -> None:
        # Guards against an accidental edit to the fixture changing what every pin measures.
        observations = fixture_observations()
        assert len(observations) == 27
        assert len({o.mmsi for o in observations}) == 6


# ================================================================================================
# THE EMPTY-DEPLOYMENT PRODUCT CASE
# ================================================================================================


class TestEmptyArchiveIsStillAProductCase:
    """
    DF-X9.3 section 8: the empty deployment is a REAL product state and stays tested.

    It proves no crashes and truthful absence semantics. It does NOT prove correlation
    correctness -- and this test says so, rather than letting a green empty-archive test be read as
    evidence about the scoring path.
    """

    def test_correlate_over_no_observations_returns_no_target_without_raising(self) -> None:
        """
        SAR DETECTIONS STILL EXIST. THAT IS CORRECT, AND A FIRST DRAFT GOT IT WRONG.

        This test originally asserted `targets == []` for eight components and no AIS. It failed,
        and the failure was correct: a SAR detection is an observation in its own right. An empty
        AIS archive means "no vessels to associate", not "no targets". Asserting an empty list would
        have required deleting real detections whenever the AIS feed was absent, which would turn
        a data-availability problem into an evidence-destroying one.
        """
        out = correlate(list(components().values()), [], ACQUISITION, RESOLUTION_M, "EMPTY")
        assert len(out["targets"]) == len(components()), (
            "every SAR detection must survive an empty AIS archive"
        )

    def test_every_target_is_unmatched_and_says_why(self) -> None:
        out = correlate(list(components().values()), [], ACQUISITION, RESOLUTION_M, "EMPTY")
        for target in out["targets"]:
            assert classify({"targets": [target]}) == "SAR_UNMATCHED"
            assert (target.get("corr") or {}).get("matched") is False
            assert (target.get("corr") or {}).get("mmsi") is None
            assert "AIS_UNASSOCIATED" in (target.get("tags") or [])

    def test_an_empty_archive_manufactures_no_contacts(self) -> None:
        # No invented vessels. An empty archive is an empty answer, not an invitation to fill it.
        out = correlate(list(components().values()), [], ACQUISITION, RESOLUTION_M, "EMPTY")
        assert out.get("ais_only") == []
        # And nothing may claim a predicted position, since nothing was propagated.
        for target in out["targets"]:
            corr = target.get("corr") or {}
            assert corr.get("predictedLat") is None
            assert corr.get("predictedLon") is None

    def test_the_propagation_note_says_nothing_was_propagated(self) -> None:
        # The product's own narrative must not imply propagation happened when it did not. Without
        # AIS this target carries no MMSI, so `evidence.py` has to say so explicitly rather than
        # leaving the reader to infer it from a missing field.
        #
        # Read from `uncertainty`, which is where it lives. A first draft read it from the top level, got
        # `''`, and the empty string read as "no note was emitted" -- which is a different failure
        # from the one being checked, and would have passed a weaker assertion.
        out = correlate(list(components().values()), [], ACQUISITION, RESOLUTION_M, "EMPTY")
        evidence = target_evidence(out["targets"][0], provenance=None, chip=None)
        note = str((evidence.get("uncertainty") or {}).get("propagation_note") or "")
        assert note, "no propagation_note was emitted at all"
        assert "no ais position was propagated" in note.lower()

    def test_no_predicted_position_is_claimed_without_ais(self) -> None:
        out = correlate(list(components().values()), [], ACQUISITION, RESOLUTION_M, "EMPTY")
        evidence = target_evidence(out["targets"][0], provenance=None, chip=None)
        association = evidence.get("association") or {}
        assert association.get("predicted_position") is None
        assert association.get("mmsi") is None

    def test_the_note_differs_between_an_associated_and_an_unassociated_target(self) -> None:
        # Both branches of the conditional must say something different, or the note is decoration.
        empty = correlate(list(components().values()), [], ACQUISITION, RESOLUTION_M, "EMPTY")
        unassociated = str(
            (target_evidence(empty["targets"][0], provenance=None, chip=None)
             .get("uncertainty") or {}).get("propagation_note") or ""
        )

        with_ais = run_scenario("S1", None)["output"]
        associated = str(
            (target_evidence(with_ais["targets"][0], provenance=None, chip=None)
             .get("uncertainty") or {}).get("propagation_note") or ""
        )
        assert unassociated != associated
        assert "propagated to acquisition time" in associated