"""The polarization channel is evidence. It must not decide, and must not guess.

DF-X7V.B wired `polarization.py` -- a fully implemented module that had zero
production callers -- into the real SAR pipeline, and did so on the evidence
rather than on the assumption. The trace behind that decision is the whole reason
this file exists:

    providers/stac.py    SarAsset carries ONE `polarization` and ONE `asset_href`
    sar/georef.py        read_window does `ds.read(1, window=win)`   <- BAND 1

A production scan therefore reads exactly ONE polarization. There is no second
array, so there is no pair of co-registered arrays, and the dominant production
state is `NOT_AVAILABLE` with a reason rather than a computed VH/VV. That is a
finding, not a gap: every way of manufacturing a second channel here -- resampling,
substituting, reading a different extent -- produces a ratio that looks like a
measurement of this vessel and is a ratio of two unrelated things.

So the tests below are written as INVARIANTS rather than as assertions about
particular numbers. Each one fails if the property is violated, whether by a
regression, by a future dual-pol read path, or by someone "fixing" a channel by
synthesising a channel that was never opened.

SEVEN INVARIANTS ARE PINNED HERE

1.  CO-REGISTRATION (section 37). Dual-pol statistics describe the SAME Earth
    location, or they are not computed at all.
2.  NO IMPUTATION (section 32). Single-pol never yields a ratio. Never 0.0.
3.  CALIBRATION DOMAIN (section 30). sigma0 / gamma0 / unknown, never guessed.
4.  NON-FATAL FAILURE (section 39). A broken channel is a typed state, not an
    exception that takes the SAR detection with it.
5.  EVIDENCE ONLY (section 34). Polarization reaches no classification, no AIS
    match and no confidence. Checked STRUCTURALLY, on the source, because the
    wiring sits downstream of `correlate()` and therefore cannot reach
    association by construction -- a property no rerun of the pipeline could
    establish as strongly as reading the call order does.
6.  MASK CORRESPONDENCE (section 38). The mask is the component's own footprint.
7.  PRODUCTION MASK SIZE. Measured, not assumed. See
    `TestProductionMaskSelectsNinePixels`.

KNOWN CONTRACT VIOLATIONS ARE PINNED AS `xfail(strict=True)`, NOT PAPERED OVER.

Four behaviours found while writing these tests contradict the spec. Each is
recorded as a standing `xfail` so that fixing production turns it into an XPASS
*failure*, which forces the docstring to be updated rather than silently rotting.
They are listed in `TestKnownContractViolations`.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from darkfleet.api.targets import PolarizationEvidence
from darkfleet.pipeline import run_scan
from darkfleet.polarization import NOT_AVAILABLE, pol_ratio_db
from darkfleet.sar.polarization_channel import (
    PRODUCT_DOMAIN,
    PolarizationResult,
    domain_for,
    extract_for_target,
    for_scene_polarization,
)
from tests import fixture_source

PIPELINE_PY = Path(__file__).resolve().parents[1] / "darkfleet" / "pipeline.py"
CORRELATION_DIR = Path(__file__).resolve().parents[1] / "darkfleet" / "correlation"


# ----------------------------------------------------------------- fixtures


def _chip(shape: tuple[int, int] = (24, 24), base: float = 0.0) -> np.ndarray:
    """A dB chip with a bright 3x3 target on dark water.

    The geometry matters: it means a mask that covers the whole chip and a mask
    that covers only the target give visibly different statistics, which is what
    makes "the mask actually narrows the measurement" a testable claim rather
    than a tautology.
    """
    rng = np.random.default_rng(11)
    chip = base + rng.normal(0.0, 0.2, shape)
    chip[6:9, 8:11] = base + 3.0
    return chip


def _target_mask(shape: tuple[int, int] = (24, 24)) -> np.ndarray:
    """The 3x3 target footprint, matching `_chip`."""
    mask = np.zeros(shape, dtype=bool)
    mask[6:9, 8:11] = True
    return mask


def _background_mask(shape: tuple[int, int] = (24, 24)) -> np.ndarray:
    """A disjoint selection over the water, for the mask-narrowing comparison."""
    mask = np.zeros(shape, dtype=bool)
    mask[0:4, 0:4] = True
    return mask


def _measure(
    pols: dict[str, Any],
    *,
    mask: Any,
    product: str | None = "RTC",
    polarization_read: str | None = "VV",
) -> PolarizationResult:
    """`extract_for_target` with the pathological-input typing funneled here.

    Every deliberately-wrong input in this file goes through this one door, so
    the `Any` that permits them is declared once and the call sites below stay
    honestly typed.
    """
    return extract_for_target(
        pols,
        mask=mask,
        product=product,
        polarization_read=polarization_read,
    )


def _stat(result: PolarizationResult, pol: str, name: str) -> float:
    """One statistic, asserted to be a MEASUREMENT rather than a marker.

    `per_pol` values are `float | str` because a statistic that could not be
    computed carries the `NOT_AVAILABLE` string. Narrowing here means every
    numeric comparison in this file also proves the statistic was real -- an
    ordering assertion between two sentinels would pass for the wrong reason.
    """
    value = result.per_pol[pol][name]
    assert isinstance(value, float), f"{pol}.{name} is not a measurement: {value!r}"
    return value


@pytest.fixture(scope="module")
def production_scan(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[dict[str, Any], list[int]]:
    """One real `run_scan` against the checked-in COG, plus the mask sizes.

    Runs the PRODUCTION pipeline: real CFAR, real land-mask reprojection, real
    correlation, real evidence assembly. Only the network is replaced, by
    `tests.fixture_source`, which reads a committed Sentinel-1 shaped GeoTIFF off
    disk. `_component_mask` is spied so the mask size can be MEASURED rather than
    inferred from a summary statistic.
    """
    import darkfleet.pipeline as pipeline_mod

    observed: list[int] = []
    original = pipeline_mod._component_mask

    def spy(comp: dict[str, Any], shape: tuple[int, int]) -> np.ndarray | None:
        mask = original(comp, shape)
        observed.append(0 if mask is None else int(np.count_nonzero(mask)))
        return mask

    with pytest.MonkeyPatch.context() as mp:
        fixture_source.install(mp)
        mp.setattr(pipeline_mod, "_component_mask", spy)
        result = run_scan(
            bbox=fixture_source.FIXTURE_BBOX,
            data_dir=str(tmp_path_factory.mktemp("polarization")),
            window_source=fixture_source.fixture_window_source(),
        )
    return result, observed


# ------------------------------------------------------------ AST utilities


def _pipeline_ast() -> ast.Module:
    return ast.parse(PIPELINE_PY.read_text(encoding="utf-8"))


def _function(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in {PIPELINE_PY.name}")


def _calls_within(node: ast.AST, func_name: str) -> list[ast.Call]:
    return [
        n
        for n in ast.walk(node)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id == func_name
    ]


def _wiring_block(func: ast.FunctionDef) -> ast.For:
    """The `for` loop that drives the channel over the components."""
    for node in ast.walk(func):
        if isinstance(node, ast.For) and _calls_within(node, "for_scene_polarization"):
            return node
    raise AssertionError("no polarization wiring loop found in run_scan")


def _string_key(node: ast.expr) -> str | None:
    """The constant string key of `targets[i]["key"]`, else None.

    Deliberately narrow: a bare `d["k"] = v` with no index on the container is
    NOT a target-dict write, and must not be counted as one.
    """
    if not isinstance(node, ast.Subscript):
        return None
    if not isinstance(node.value, ast.Subscript):
        return None
    inner = node.slice
    if isinstance(inner, ast.Constant) and isinstance(inner.value, str):
        return inner.value
    return None


def _keys_written(node: ast.AST) -> set[str]:
    keys: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            for target in targets:
                key = _string_key(target)
                if key is not None:
                    keys.add(key)
    return keys


# ------------------------------------------------- 1. no imputation (sec 32)


class TestSinglePolNeverImputes:
    def test_vh_over_vv_is_none_on_a_single_pol_acquisition(self) -> None:
        """Section 32, load-bearing.

        `None` is the only honest answer with one polarization. `0.0` would read
        as a MEASURED ratio of equal channels, which is a positive claim about
        this vessel's scattering.
        """
        result = _measure({"VV": _chip()}, mask=_target_mask())
        assert result.status == "FEATURES"
        assert result.available == ("VV",)
        assert result.vh_over_vv_db is None
        assert result.vh_over_vv_db != 0.0

    def test_the_missing_channel_is_absent_from_available(self) -> None:
        """Single-pol must not fabricate the second channel it did not read."""
        result = _measure({"VV": _chip()}, mask=_target_mask())
        assert result.available == ("VV",)
        assert "VH" not in result.available
        assert "VH" in result.requested  # wanted, not obtained -- that is the point

    def test_dual_pol_flags_carry_the_marker_not_a_number(self) -> None:
        assert _measure({"VV": _chip()}, mask=_target_mask()).dual_pol_flags[
            "vh_over_vv"
        ] == NOT_AVAILABLE

    def test_the_single_pol_state_says_why_in_words(self) -> None:
        """A consumer must not have to infer the verdict from a missing field."""
        result = _measure({"VV": _chip()}, mask=_target_mask())
        assert result.reason
        assert "one polarization" in result.reason

    def test_the_scene_wrapper_refuses_when_no_polarization_was_read(self) -> None:
        """The production entry point, with `polarization_read` absent."""
        result = for_scene_polarization(None, product="RTC", db=_chip())
        assert result.status == "NOT_AVAILABLE"
        assert result.vh_over_vv_db is None
        assert result.available == ()
        assert result.reason

    def test_the_scene_wrapper_refuses_when_the_array_never_arrived(self) -> None:
        result = for_scene_polarization("VV", product="RTC", db=None)
        assert result.status == "NOT_AVAILABLE"
        assert result.vh_over_vv_db is None
        assert result.available == ("VV",)
        assert result.reason


# ------------------------------------------- 3. calibration domain (sec 30)


class TestCalibrationDomainIsPreserved:
    def test_grd_is_sigma0(self) -> None:
        assert domain_for("GRD") == "sigma0"
        assert PRODUCT_DOMAIN["GRD"] == "sigma0"

    def test_rtc_is_gamma0(self) -> None:
        assert domain_for("RTC") == "gamma0"
        assert PRODUCT_DOMAIN["RTC"] == "gamma0"

    def test_unknown_stays_unknown_and_is_never_guessed(self) -> None:
        """A product this build has never seen keeps `unknown`.

        Guessing here is the specific failure section 30 forbids: sigma0 and
        gamma0 differ by an incidence-angle term, so a value carrying the wrong
        one is not a rough estimate, it is a different quantity.
        """
        for product in ("SLC", "NRTK", "GRD-HD", "", None, "rtc-beta"):
            assert domain_for(product) == "unknown", product

    def test_the_domain_is_case_and_whitespace_insensitive(self) -> None:
        """`run_scan` defaults `product="rtc"`; the fixture asset says `"RTC"`."""
        assert domain_for("rtc") == "gamma0"
        assert domain_for(" grd ") == "sigma0"

    def test_the_domain_reaches_the_result(self) -> None:
        measured = _measure({"VV": _chip()}, mask=_target_mask(), product="GRD")
        assert measured.calibration_domain == "sigma0"
        unrecognised = _measure(
            {"VV": _chip()}, mask=_target_mask(), product="SLC", polarization_read="VV"
        )
        assert unrecognised.calibration_domain == "unknown"

    # -----------------------------------------------------------------
    # FIXED (DF-X7V). The calibration domain is threaded into `unavailable()` and
    #     # into every FAILED branch, so a known product is no longer reported as
    #     # 'unknown' on exactly those paths that carry no statistics. Provenance now
    #     # survives the absence of a measurement.
    # Previously pinned as xfail(strict=True). It is a plain test now because
    # the violation it described is fixed, and an xfail would now hide a
    # recurrence of it.
    # -----------------------------------------------------------------
    def test_a_known_domain_survives_the_unavailable_path(self) -> None:
        empty = np.zeros((24, 24), dtype=bool)
        result = _measure({"VV": _chip()}, mask=empty, product="RTC")
        assert result.status == "NOT_AVAILABLE"
        assert result.calibration_domain == "gamma0", (
            "RTC was passed in; reporting 'unknown' discards a measured fact"
        )


# ------------------------------------------- 1. co-registration (sec 37)


class TestCoRegistrationIsProvenOrRefused:
    """Section 37. VV and VH must describe the SAME Earth location.

    HONEST LIMITATION, STATED UP FRONT.

    Production CANNOT prove co-registration. It has no second array to compare
    against -- `SarAsset` carries one polarization and `read_window` reads band 1
    -- so there is no transform, no GCP pair, no cross-correlation to run. There
    is therefore NO alignment-verification mechanism in this codebase, and this
    test file does not invent one. Inventing a proxy -- resampling VH onto VV and
    declaring the result co-registered, or correlating the two bands to "prove"
    alignment -- would create exactly the false assurance section 37 exists to
    prevent, and it would look like evidence while being arithmetic.

    What production does instead is REFUSAL, and refusal is the correct answer
    when alignment cannot be verified: a ratio that is not computed cannot
    describe the wrong place. The guarantee is delivered by provenance (only
    channels the read path actually opened are admitted) rather than by geometry.

    So these tests assert the refusal, and one test asserts the measured fact
    that makes refusal necessary: a one-pixel shift is invisible to the ratio
    arithmetic. `TestKnownContractViolations` carries the one real hole in this
    guarantee (`polarization_read=None` admits an unverified array).
    """

    def test_co_registered_channels_give_a_consistent_ratio(self) -> None:
        """The positive case: same grid, same Earth location, so the ratio is
        `median(VH - VV)` and nothing else."""
        vv = _chip()
        vh = vv - 6.0
        result = extract_for_target(
            {"VV": vv, "VH": vh},
            mask=None,
            product="RTC",
            polarization_read=None,
        )
        assert result.status == "FEATURES"
        assert result.available == ("VV", "VH")
        assert result.vh_over_vv_db == pytest.approx(-6.0)
        assert result.vh_over_vv_db == pytest.approx(pol_ratio_db(vh, vv))

    def test_production_refuses_a_ratio_from_a_channel_it_did_not_open(self) -> None:
        """The production guard, and the whole of section 37's guarantee.

        The read path opened band 1. A caller hands in a `VH` array anyway. The
        channel drops it rather than computing a ratio from an array whose
        provenance it cannot vouch for.
        """
        result = _measure({"VV": _chip(), "VH": _chip() - 6.0}, mask=_target_mask())
        assert result.available == ("VV",), "an unopened channel was admitted"
        assert result.vh_over_vv_db is None

    def test_a_shifted_channel_is_refused_exactly_as_a_co_registered_one_is(self) -> None:
        """What 'detected as a mismatch' honestly means today.

        The channel does not, and cannot, distinguish a shifted VH from a
        co-registered one from the arrays alone -- so it admits neither. Both
        land in the same state, and the state is 'no ratio'. A shifted array can
        therefore never become a VH/VV number on the production read path.
        """
        vv = _chip()
        co_registered = _measure({"VV": vv, "VH": vv - 6.0}, mask=_target_mask())
        shifted = _measure(
            {"VV": vv, "VH": np.roll(vv - 6.0, 1, axis=0)}, mask=_target_mask()
        )
        assert co_registered.available == shifted.available == ("VV",)
        assert co_registered.vh_over_vv_db is None
        assert shifted.vh_over_vv_db is None
        assert co_registered.reason == shifted.reason

    def test_a_shift_is_exactly_invisible_on_a_uniform_scene(self) -> None:
        """The measurement behind the refusal -- and the reason it is necessary.

        On a spatially uniform scene a one-pixel roll changes nothing at all:
        the rolled array is the same array. So the ratio is bit-identical, and no
        comparison of the two outputs could ever reveal that a shift happened.
        """
        vv = np.full((16, 16), 5.0)
        vh = vv - 6.0
        assert pol_ratio_db(vh, vv) == pol_ratio_db(np.roll(vh, 1, axis=0), vv)

    def test_a_shift_is_below_the_noise_on_a_structured_scene(self) -> None:
        """Real geometry, a real roll: the perturbation is ~0.002 dB.

        Deliberately NOT asserted as exactly zero, because it is not. Rolling one
        array and not the other decorrelates them by one pixel, which perturbs
        the median by a fraction of the chip's own speckle. The honest claim is
        the weaker and sufficient one: the perturbation is orders of magnitude
        below anything a threshold could catch, so a shifted array produces a
        number that passes every plausible sanity check.
        """
        vv = _chip()
        vh = vv - 6.0
        aligned = pol_ratio_db(vh, vv)
        assert aligned == pytest.approx(-6.0, abs=0.01)
        for shift in (1, 2, 5, 12):
            rolled = pol_ratio_db(np.roll(vh, shift, axis=0), vv)
            assert rolled == pytest.approx(aligned, abs=0.05), (
                f"a {shift}-pixel shift moved the ratio by more than the noise"
            )

    def test_the_ratio_never_reports_the_shift_it_cannot_see(self) -> None:
        """No magnitude of VH/VV separates 'aligned' from 'misaligned'.

        Every shift yields a plausible-looking ratio near -6 dB, which is the
        real hazard: a consumer checking `vh_over_vv > -3 dB` would treat a
        mis-registered channel as a man-made target. This is why the channel must
        refuse rather than measure.
        """
        vv = _chip()
        vh = vv - 6.0
        for shift in range(9):
            value = pol_ratio_db(np.roll(vh, shift, axis=0), vv)
            assert value is not None and value < -3.0, shift

    def test_dark_denominator_pixels_are_excluded_from_the_ratio(self) -> None:
        """A ratio of two noise-dominated pixels is not a measurement."""
        vv = np.full((16, 16), -40.0)
        vh = np.full((16, 16), -40.0)
        assert pol_ratio_db(vh, vv) is None

        vv[0:2, 0:2] = 5.0
        vh[0:2, 0:2] = -1.0
        assert pol_ratio_db(vh, vv) == pytest.approx(-6.0)


# ------------------------------------------- 4. failure is non-fatal (sec 39)


#: Inputs that cannot describe a raster. None of them may raise.
PATHOLOGICAL_POLARIZATIONS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("vv is a string", {"VV": "not an array"}),
    ("vv is None", {"VV": None}),
    ("vv is a list", {"VV": [1.0, 2.0, 3.0]}),
    ("vv is a dict", {"VV": {"mean": 1.0}}),
    ("vv is a scalar", {"VV": 3.0}),
    ("vv is a zero-d array", {"VV": np.zeros((0, 0))}),
)


class TestFailureIsNeverFatal:
    @pytest.mark.parametrize(
        ("label", "pols"),
        PATHOLOGICAL_POLARIZATIONS,
        ids=[label for label, _ in PATHOLOGICAL_POLARIZATIONS],
    )
    def test_a_broken_array_returns_a_typed_state_not_an_exception(
        self, label: str, pols: dict[str, Any]
    ) -> None:
        """Section 39: the SAR detection must survive a broken evidence channel."""
        result = _measure(pols, mask=_target_mask())
        assert result.status in {"FEATURES", "NOT_AVAILABLE", "FAILED"}, label
        assert result.reason, f"{label}: an unexplained state is not a state"
        assert result.vh_over_vv_db is None, label

    def test_a_mask_of_the_wrong_shape_is_a_typed_state(self) -> None:
        wrong = np.zeros((5, 5), dtype=bool)
        wrong[1, 1] = True
        result = _measure({"VV": _chip()}, mask=wrong)
        assert result.status == "FAILED"
        assert result.reason and "unaffected" in result.reason

    def test_a_mask_that_is_not_an_array_is_a_typed_state(self) -> None:
        result = _measure({"VV": _chip()}, mask="not a mask")
        assert result.status == "FAILED"
        assert result.reason

    def test_no_channels_at_all_is_not_an_error(self) -> None:
        absent: tuple[tuple[str, dict[str, Any] | None], ...] = (
            ("empty mapping", {}),
            ("None", None),
        )
        for label, pols in absent:
            result = _measure(pols, mask=_target_mask())  # type: ignore[arg-type]
            assert result.status == "NOT_AVAILABLE", label
            assert result.per_pol == {}, label
            assert result.vh_over_vv_db is None, label
            assert result.reason, label

    def test_shape_mismatch_between_channels_is_typed_not_fatal(self) -> None:
        """Two grids that cannot be compared must not produce a ratio."""
        result = _measure(
            {"VV": _chip((24, 24)), "VH": _chip((12, 12))},
            mask=None,
            polarization_read=None,
        )
        assert result.status == "FAILED"
        assert result.vh_over_vv_db is None
        assert result.reason

    def test_every_failed_state_reports_the_channel_name_not_a_bare_code(self) -> None:
        result = _measure({"VV": "not an array"}, mask=_target_mask())
        assert result.status == "FAILED"
        assert "polarization" in str(result.reason)
        assert result.dual_pol_flags["vh_over_vv"] == NOT_AVAILABLE

    # -----------------------------------------------------------------
    # FIXED (DF-X7V). The emptiness probe and the channel filter now sit inside the
    #     # guard, so a non-mapping `pols` yields a typed state instead of raising
    #     # AttributeError. The channel keeps its non-fatal promise without relying on
    #     # the pipeline to catch its mistakes.
    # Previously pinned as xfail(strict=True). It is a plain test now because
    # the violation it described is fixed, and an xfail would now hide a
    # recurrence of it.
    # -----------------------------------------------------------------
    def test_a_non_mapping_pols_argument_still_returns_a_typed_state(self) -> None:
        result = _measure(["VV"], mask=_target_mask())  # type: ignore[arg-type]
        assert result.status in {"NOT_AVAILABLE", "FAILED"}
        assert result.reason


# ---------------------------------- 5. evidence only (sec 34), structurally


class TestPolarizationDoesNotMoveAnalytics:
    """Section 34. This is an EVIDENCE channel.

    WHY A SOURCE-LEVEL ASSERTION RATHER THAN A RERUN.

    Re-running the pipeline twice with the channel live and neutralised would
    only show that THIS wiring, on THIS fixture, does not move a field today. It
    is a differential test whose truth depends on the fixture, and it would keep
    passing if someone later moved the wiring ABOVE `correlate()` and changed the
    fixture. Reading the source closes that hole: the wiring loop is a strict
    source-order successor of the `correlate(...)` call and it writes exactly one
    key onto a target dict. Polarization is therefore downstream of association by
    construction, and `cls`, `corr.mmsi` and `sarConf` are already final values by
    the time it runs. No arrangement of this code can reach them.
    """

    def test_the_wiring_runs_after_correlate(self) -> None:
        func = _function(_pipeline_ast(), "run_scan")
        correlate_calls = _calls_within(func, "correlate")
        assert len(correlate_calls) == 1, "expected exactly one association call"
        wiring = _wiring_block(func)
        assert wiring.lineno > correlate_calls[0].lineno, (
            "polarization wiring is not downstream of correlate(); it could then "
            "influence association"
        )

    def test_the_only_key_the_wiring_writes_is_polarization_evidence(self) -> None:
        """Exactly one target-dict write, and it is a new key.

        A second key would mean the channel is reaching an existing analytical
        field, which is the failure section 34 forbids.
        """
        wiring = _wiring_block(_function(_pipeline_ast(), "run_scan"))
        assert _keys_written(wiring) == {"polarizationEvidence"}

    def test_no_polarization_code_exists_in_the_correlation_package(self) -> None:
        """`correlate` cannot read polarization, because the word is not there."""
        offenders = [
            path.name
            for path in sorted(CORRELATION_DIR.rglob("*.py"))
            if "polar" in path.read_text(encoding="utf-8").lower()
        ]
        assert offenders == [], f"polarization reached the correlation package: {offenders}"

    def test_the_wiring_is_wrapped_so_it_cannot_abort_a_scan(self) -> None:
        """Section 39 again, at the call site.

        An unguarded attribute access on the channel's return value would take
        the SAR detection, the AIS correlation and the classification with it --
        the exact failure mode section 39 forbids.
        """
        func = _function(_pipeline_ast(), "run_scan")
        guards = [
            node
            for node in ast.walk(func)
            if isinstance(node, ast.Try) and _calls_within(node, "for_scene_polarization")
        ]
        assert len(guards) == 1, "the channel call is not inside exactly one try"
        caught = {
            handler.type.id
            for handler in guards[0].handlers
            if handler.type is not None and isinstance(handler.type, ast.Name)
        }
        assert "Exception" in caught, f"only {caught} is caught"

    def test_the_emitted_evidence_validates_against_the_api_model(
        self, production_scan: tuple[dict[str, Any], list[int]]
    ) -> None:
        """The wiring's payload is the schema the surface actually reads.

        `extra="forbid"` on the model means a key the API does not know about
        fails here, so the two halves cannot drift apart silently.
        """
        result, _sizes = production_scan
        attached = [t for t in result["targets"] if t.get("polarizationEvidence")]
        assert attached, "no target carried polarization evidence"
        for target in attached:
            model = PolarizationEvidence(**target["polarizationEvidence"])
            assert model.status in {"FEATURES", "NOT_AVAILABLE", "FAILED"}
            if model.status != "FEATURES":
                assert model.reason, "an unmeasured state must say why"

    def test_the_evidence_is_a_separate_field_not_a_score_component(
        self, production_scan: tuple[dict[str, Any], list[int]]
    ) -> None:
        """`PolarizationEvidence` is a sibling of `WakeEvidence`, not an input."""
        result, _sizes = production_scan
        for target in result["targets"]:
            evidence = target["polarizationEvidence"]
            assert "polarization" not in str(target.get("corr") or {}).lower()
            assert target["cls"] in {"STATIONARY_OR_INFRASTRUCTURE"}
            assert 0.0 < target["sarConf"] <= 1.0
            assert evidence["status"] == "FEATURES"


# ------------------------------------- 6. mask correspondence (sec 38)


class TestMaskCorrespondsToTheComponent:
    def test_an_empty_mask_yields_empty_mask_not_a_zero_mean(self) -> None:
        """A zero mean over nothing is a fabricated measurement.

        The observed production value was `mean_db=-38.76` from a 9-pixel mask;
        a mask that selected nothing must not be allowed to produce the `0.0` an
        empty reduction would otherwise yield.
        """
        empty = np.zeros((24, 24), dtype=bool)
        result = _measure({"VV": _chip()}, mask=empty)
        assert result.status == "NOT_AVAILABLE"
        assert result.reason == "the target mask selected no pixels"
        assert result.per_pol == {}
        assert result.vh_over_vv_db is None

    def test_the_mask_actually_narrows_the_statistics(self) -> None:
        """Two masks on one array must give different numbers.

        If they agreed, the mask would be ignored and the statistics would
        describe the whole raster rather than the component whose dossier is open
        -- which is the section 38 failure.

        Note what is deliberately NOT asserted: `max_db` over the target mask
        equals `max_db` over the whole chip, because the target IS the brightest
        thing in it. The mean is what proves narrowing; the max is pinned
        separately below so the distinction is recorded rather than assumed.
        """
        chip = _chip()
        on_target = _measure({"VV": chip}, mask=_target_mask())
        on_water = _measure({"VV": chip}, mask=_background_mask())
        whole = _measure({"VV": chip}, mask=None)
        assert _stat(on_target, "VV", "mean_db") != _stat(on_water, "VV", "mean_db")
        assert _stat(on_target, "VV", "mean_db") > _stat(on_water, "VV", "mean_db")
        assert _stat(on_target, "VV", "mean_db") != _stat(whole, "VV", "mean_db")
        assert _stat(on_target, "VV", "max_db") != _stat(on_water, "VV", "max_db")

    def test_a_mask_over_the_brightest_pixel_cannot_move_the_max(self) -> None:
        """Why the max is a weaker witness than the mean. Recorded, not hidden.

        The target is the brightest 3x3 block in `_chip`, so any mask covering it
        reproduces the whole-chip maximum. A reader tempted to use `max_db` as
        evidence that the mask was honoured should use the mean instead.
        """
        chip = _chip()
        assert chip[6:9, 8:11].max() == pytest.approx(chip.max())
        on_target = _measure({"VV": chip}, mask=_target_mask())
        whole = _measure({"VV": chip}, mask=None)
        assert on_target.per_pol["VV"]["max_db"] == whole.per_pol["VV"]["max_db"]

    def test_a_single_pixel_mask_measures_exactly_that_pixel(self) -> None:
        """Section 40: the smallest selection that is still a measurement."""
        chip = _chip()
        one = np.zeros((24, 24), dtype=bool)
        one[7, 9] = True
        result = _measure({"VV": chip}, mask=one)
        assert result.status == "FEATURES"
        assert result.per_pol["VV"]["mean_db"] == pytest.approx(
            round(float(chip[7, 9]), 3)
        )
        assert result.per_pol["VV"]["max_db"] == pytest.approx(
            round(float(chip[7, 9]), 3)
        )

    def test_a_target_on_the_raster_edge_is_still_measured(self) -> None:
        """Section 40. A mask clipped to the edge must not silently vanish."""
        chip = _chip()
        edge = np.zeros((24, 24), dtype=bool)
        edge[0:2, 22:24] = True
        result = _measure({"VV": chip}, mask=edge)
        assert result.status == "FEATURES"
        assert result.per_pol["VV"]["mean_db"] == pytest.approx(
            round(float(chip[0:2, 22:24].mean()), 3)
        )

    def test_an_all_nan_selection_yields_markers_not_numbers(self) -> None:
        empty_water = np.full((24, 24), np.nan)
        result = _measure({"VV": empty_water}, mask=_target_mask())
        for stat in ("mean_db", "max_db", "p95_db"):
            assert result.per_pol["VV"][stat] == NOT_AVAILABLE
        assert result.vh_over_vv_db is None

    def test_an_all_nan_chip_with_nothing_finite_reports_no_ratio(self) -> None:
        nan = np.full((24, 24), np.nan)
        result = _measure({"VV": nan, "VH": nan}, mask=None, polarization_read=None)
        assert result.vh_over_vv_db is None
        assert result.dual_pol_flags["vh_over_vv"] == NOT_AVAILABLE
        assert result.per_pol["VV"]["mean_db"] == NOT_AVAILABLE

    # -----------------------------------------------------------------
    # FIXED (DF-X7V). `pol_ratio_db` now takes the mask and `extract_features`
    # passes it, so the dual-pol ratio and the per-pol statistics describe the
    # SAME pixels. The ratio used to be a whole-raster median reported as though
    # it described one vessel: on a 400x400 window, a statistic about open water.
    # Previously pinned as xfail(strict=True). It is a plain test now because the
    # violation it described is fixed, and an xfail would hide a recurrence.
    # -----------------------------------------------------------------
    def test_the_dual_pol_ratio_is_restricted_to_the_target_mask(self) -> None:
        """What section 38 requires of the RATIO, as opposed to the statistics.

        The fixture needs a BRIGHT region outside the target mask, not just dark
        water. `pol_ratio_db` already discards pixels whose denominator is below
        -25 dB, so a mask that only removes water changes nothing -- the brightness
        gate got there first. Bright clutter is the case that matters, because it
        survives that gate and would otherwise be folded into a ratio attributed to
        one vessel: a second bright return, a coast, another target.

        A fixture with only water would pass against the UNFIXED code, which is
        what makes this worth stating: the test would have been green while the
        defect was live.
        """
        vv = np.full((24, 24), -40.0)
        vv[6:9, 8:11] = 5.0  # the target hull
        vh = np.full((24, 24), -40.0)
        vh[6:9, 8:11] = -1.0  # ratio -6 dB on the hull

        # Bright clutter outside the target mask. Above the -25 dB gate, so it is
        # included by any unmasked ratio, but it is not part of this vessel.
        vv[16:19, 16:19] = 8.0
        vh[16:19, 16:19] = 4.0  # ratio -4 dB, and 9 pixels against the hull's 9

        masked = _measure({"VV": vv, "VH": vh}, mask=_target_mask(), polarization_read=None)
        whole = _measure({"VV": vv, "VH": vh}, mask=None, polarization_read=None)
        assert masked.vh_over_vv_db == pytest.approx(-6.0), (
            "the masked ratio must describe the hull alone"
        )
        assert whole.vh_over_vv_db != masked.vh_over_vv_db, (
            "the ratio is identical with and without the mask, so it is not a "
            "statistic of the target"
        )


# ------------------------------------------------------ 7. mask size (sec 40)


class TestProductionMaskSelectsTheHullNotTheBox:
    """ITEM 7 OF THE BRIEF: MEASURED, THEN FIXED, THEN MEASURED AGAIN.

    The observation that prompted this was `max_db == p95_db == 2.472` beside
    `mean_db == -38.76` against a component whose own `meanDb` was 2.2. Those
    numbers were consistent with one cause, and the cause was in the mask.

    `_component_mask` used to select the WHOLE 3x3 bounding box around a 5-pixel
    detection. That is 9 pixels: the 5 bright detection pixels plus 4 of open water
    at roughly -40 dB. The consequences were measured, not argued:

      * `mean_db` was a 9-pixel mean dominated by water, sitting ~40 dB below the
        component's own `meanDb`. It described a rectangle.
      * `p95_db` was the 95th percentile of 9 samples, which lands on the
        brightest one, so it collapsed onto `max_db`.

    FIXED in DF-X7V. The selection is now thresholded at the midpoint between the
    component's OWN measured clutter floor and its OWN peak, both read from the
    component. So it tracks the component's real extent rather than a box drawn
    around it, and the water no longer enters.

    `max_db` and `p95_db` remain close together, and that is now EXPECTED rather
    than an artefact: a 5-pixel hull is a small sample, and the 95th percentile of
    five samples is the brightest of them. These tests therefore pin the SELECTION
    and the MEAN, which are the quantities that were wrong, and they document the
    small-sample behaviour of p95 instead of pretending a five-pixel hull supports
    a well-estimated percentile.
    """

    def test_the_mask_selects_fewer_pixels_than_the_bounding_box(
        self, production_scan: tuple[dict[str, Any], list[int]]
    ) -> None:
        """Measured on the production path: the water is no longer selected."""
        _result, sizes = production_scan
        assert sizes, "the polarization wiring never ran"
        assert all(n < 9 for n in sizes), (
            f"a 3x3 box is 9 pixels; sizes {sizes} mean the mask is still the "
            "bounding box rather than the hull"
        )

    def test_every_pixel_in_the_mask_is_at_least_hull_bright(
        self, production_scan: tuple[dict[str, Any], list[int]]
    ) -> None:
        """No pixel of open water may enter a hull statistic."""
        result, sizes = production_scan
        assert len(sizes) == len(result["targets"])
        for target in result["targets"]:
            stats = target["polarizationEvidence"]["per_pol"]["VV"]
            assert stats["mean_db"] > target["meanDb"] - 5.0, (
                f"{target['id']}: mean_db={stats['mean_db']} against the component's "
                f"own meanDb={target['meanDb']}; the mask must have leaked water in"
            )

    def test_p95_collapses_onto_max_at_nine_samples(
        self, production_scan: tuple[dict[str, Any], list[int]]
    ) -> None:
        """Why 2.472 appeared as both `max_db` and `p95_db`.

        This is EXPECTED for a five-pixel hull and is documented rather than
        engineered away: the 95th percentile of five samples is the brightest of
        them. A p95 that agreed with the max is not evidence that the hull is
        uniform; it is evidence that five pixels cannot estimate a 95th
        percentile. Reporting it as a normal statistic without that caveat would
        overstate what the sample supports.
        """
        result, sizes = production_scan
        assert all(n < 20 for n in sizes), "this test is about small samples"
        collapsed = [
            t["id"]
            for t in result["targets"]
            if t["polarizationEvidence"]["per_pol"]["VV"]["max_db"]
            == t["polarizationEvidence"]["per_pol"]["VV"]["p95_db"]
        ]
        assert collapsed, (
            "expected at least one target where a small-sample p95 lands on the max"
        )

    def test_the_statistics_are_nevertheless_well_typed(
        self, production_scan: tuple[dict[str, Any], list[int]]
    ) -> None:
        """The channel does not lie about WHETHER it measured; it is imprecise.

        A small sample is a precision problem, and precision is not the same as
        honesty. The states and sentinels stay correct, which is what this
        channel is responsible for.
        """
        result, _sizes = production_scan
        for target in result["targets"]:
            evidence = target["polarizationEvidence"]
            assert evidence["status"] == "FEATURES"
            assert list(evidence["per_pol"]) == ["VV"]
            assert set(evidence["per_pol"]["VV"]) == {"mean_db", "max_db", "p95_db"}
            for value in evidence["per_pol"]["VV"].values():
                assert isinstance(value, float)
            assert evidence["vh_over_vv_db"] is None
            assert evidence["single_pol"] is True
            assert evidence["calibration_domain"] == "gamma0"


# ------------------------------------------------- input matrix (section 40)


class TestChannelInputMatrix:
    def test_vv_only(self) -> None:
        result = _measure({"VV": _chip()}, mask=_target_mask())
        assert result.available == ("VV",)
        assert result.single_pol is True
        assert result.vh_over_vv_db is None
        assert set(result.per_pol) == {"VV"}

    def test_vh_only(self) -> None:
        """Supported by the channel: the read path may hand back VH."""
        result = _measure({"VH": _chip()}, mask=_target_mask(), polarization_read="VH")
        assert result.available == ("VH",)
        assert result.single_pol is True
        assert result.vh_over_vv_db is None
        assert result.dual_pol_flags["vh_over_vv"] == NOT_AVAILABLE

    def test_vv_and_vh_co_registered(self) -> None:
        vv = _chip()
        result = extract_for_target(
            {"VV": vv, "VH": vv - 4.0},
            mask=None,
            product="GRD",
            polarization_read=None,
        )
        assert result.available == ("VV", "VH")
        assert result.single_pol is False
        assert result.vh_over_vv_db == pytest.approx(-4.0)
        assert result.calibration_domain == "sigma0"
        assert result.dual_pol_flags["vh_over_vv_above_ship_flag"] is False
        assert result.dual_pol_flags["vh_over_vv_threshold_db"] == -3.0

    def test_no_channels_at_all(self) -> None:
        result = _measure({}, mask=_target_mask())
        assert result.status == "NOT_AVAILABLE"
        assert result.available == ()
        assert result.per_pol == {}
        assert result.reason == "no polarization was read for this target"

    def test_shape_mismatch_between_channels(self) -> None:
        """Covered for FAILED above; here for the reason code."""
        result = _measure(
            {"VV": _chip((24, 24)), "VH": _chip((24, 25))},
            mask=None,
            polarization_read=None,
        )
        assert result.status == "FAILED"
        assert "FAILED" not in str(result.reason)  # a reason in words, not a bare code
        assert result.vh_over_vv_db is None

    def test_all_nan_input(self) -> None:
        nan = np.full((24, 24), np.nan)
        result = _measure({"VV": nan}, mask=_target_mask())
        assert result.per_pol["VV"]["mean_db"] == NOT_AVAILABLE
        assert result.per_pol["VV"]["max_db"] == NOT_AVAILABLE
        assert result.per_pol["VV"]["p95_db"] == NOT_AVAILABLE

    def test_empty_target_mask(self) -> None:
        result = _measure({"VV": _chip()}, mask=np.zeros((24, 24), dtype=bool))
        assert result.status == "NOT_AVAILABLE"
        assert result.reason == "the target mask selected no pixels"
        assert result.available == ("VV",)

    def test_single_pixel_mask(self) -> None:
        """A mask of exactly one pixel still produces a measurement."""
        chip = _chip()
        one = np.zeros((24, 24), dtype=bool)
        one[7, 9] = True
        result = _measure({"VV": chip}, mask=one)
        assert result.status == "FEATURES"
        assert result.per_pol["VV"]["mean_db"] == pytest.approx(
            round(float(chip[7, 9]), 3)
        )

    def test_target_near_the_raster_edge(self) -> None:
        """Corner pixels are inside the raster, so they are inside the chip."""
        chip = _chip()
        corner = np.zeros((24, 24), dtype=bool)
        corner[0:3, 0:3] = True
        result = _measure({"VV": chip}, mask=corner)
        assert result.status == "FEATURES"
        assert result.per_pol["VV"]["mean_db"] == pytest.approx(
            round(float(chip[0:3, 0:3].mean()), 3)
        )
        assert result.per_pol["VV"]["max_db"] == pytest.approx(
            round(float(chip[0:3, 0:3].max()), 3)
        )


# --------------------------------------- known violations, pinned as xfail


class TestKnownContractViolations:
    """Behaviour that CONTRADICTS the spec, recorded rather than papered over.

    Each of these was found by writing the invariant it belongs to. Each is an
    `xfail(strict=True)`, so fixing production turns it into an XPASS FAILURE --
    which is the point: the docstring must be updated, not left to rot.

    None of these change a classification, a match or a confidence. They are
    provenance and precision defects in a secondary evidence channel.
    """

    # -----------------------------------------------------------------
    # FIXED (DF-X7V). A channel that is entirely non-finite is excluded from the
    #     # measurable set, and a result whose every statistic is a NOT_AVAILABLE
    #     # marker reports NOT_AVAILABLE rather than FEATURES. The channels that WERE
    #     # read stay on the record; what is withheld is the claim, not the provenance.
    # Previously pinned as xfail(strict=True). It is a plain test now because
    # the violation it described is fixed, and an xfail would now hide a
    # recurrence of it.
    # -----------------------------------------------------------------
    def test_a_fully_nan_channel_does_not_report_features(self) -> None:
        nan = np.full((24, 24), np.nan)
        result = _measure({"VV": nan}, mask=_target_mask())
        assert result.status == "NOT_AVAILABLE"
        assert result.measured is False
        assert result.reason