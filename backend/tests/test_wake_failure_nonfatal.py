"""DF-X7 section 25: a wake failure is a reported state, never a fatal error.

Wake is a SECONDARY evidence channel. The primary product of a scan is the SAR
detection, its AIS correlation and its classification, and not one of those
depends on a wake measurement. `analyse_wake` nevertheless reads the component's
own pixels, so it can fail on data the caller did not author -- a centroid that
is not finite, a raster too small to sample, a bug nobody has hit yet.

Before this, such a failure unwound out of `sar.components.extract_components`
and aborted the whole scan. The cost of an optional channel raising was paid by
the entire scene: every other detection lost its correlation and its
classification. That is the wrong trade in every direction, because the primary
evidence had already been measured and thrown away with the exception.

So the failure is caught at the component boundary and returned as
`WakeAnalysisState.FAILED`, carrying the exception type and message. These tests
are the standing proof of two claims that have to hold together:

1. A failure is REPORTED -- typed, legible, and attached to the component whose
   analysis failed rather than lost.
2. A failure is INERT -- it changes nothing about the vessel. The FAILED verdict
   is field-for-field the ABSENT verdict, and both are unread by anything that
   computes a confidence or a classification.

Claim 2 is the load-bearing one, and it is asserted behaviourally through
`correlate` rather than inferred. Claim 1 is asserted structurally, because a
new field that leaked into the persisted payload would break the API wire model
that this lane does not own.
"""

from __future__ import annotations

import ast
import copy
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_correlation_parity as P

from darkfleet.correlation.geodesy import orient_diff
from darkfleet.correlation.match import _sar_confidence, correlate
from darkfleet.sar.components import extract_components
from darkfleet.sar.wake import (
    R_END_PX,
    WakeAnalysis,
    WakeAnalysisState,
    analyse_wake,
)

MATCH_PY = Path(__file__).resolve().parents[1] / "darkfleet" / "correlation" / "match.py"

#: Fields that describe the VESSEL. A failed wake must move none of them.
ANALYTICAL = (
    "cls",
    "lat",
    "lon",
    "sarConf",
    "aisConf",
    "geo_pixel_centroid",
    "geo_centre_offset",
    "hdg",
)

#: Identifiers that would mean a wake reached a scoring decision.
WAKE_IDENTIFIERS = frozenset({"wake", "wakeHdg", "wakeAnalysis", "wake_analysis"})


def _blob(size: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """One point-target component on flat sea -- enough to run the detector."""
    mask = np.zeros((size, size), dtype=bool)
    mask[30:34, 30:34] = True
    db = np.full((size, size), -30.0)
    db[30:34, 30:34] = -8.0
    return mask, db


def _boom(exc: BaseException) -> object:
    def _raise(*_args: object, **_kwargs: object) -> object:
        raise exc

    return _raise


def _keys_read_from_wake_result(tree: ast.AST) -> set[str]:
    """Every dict key read out of a `wakeAnalysis` expression in `tree`.

    AST rather than substring search because the surrounding code deliberately
    NAMES the wake in its comments to explain why it is quarantined -- a naive
    search finds its own explanation, exactly as
    `tests/test_wake_scoring_authority.py` documents.

    Two syntactic shapes read a key, and BOTH have to be caught:
    `d["key"]` (a subscript) and `d.get("key")` (a call). Missing either would
    leave a hole exactly the size of the consumer it was built to rule out, so
    `TestTheHelperItselfSeesEveryAccessShape` pins both against synthetic source.

    The key collected is the one applied to the wake RESULT, not the
    `"wakeAnalysis"` that names it. `comp.get("wakeAnalysis")` fetches the object;
    it does not read anything out of it.
    """
    parents: dict[ast.AST, ast.AST] = {
        child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)
    }
    keys: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and node.value == "wakeAnalysis"):
            continue
        cursor: ast.AST | None = parents.get(node)
        while cursor is not None:
            # d.get("key")
            if (
                isinstance(cursor, ast.Call)
                and isinstance(cursor.func, ast.Attribute)
                and cursor.func.attr == "get"
                and cursor.args
                and isinstance(cursor.args[0], ast.Constant)
                and isinstance(cursor.args[0].value, str)
                # `comp.get("wakeAnalysis")` names the object; it does not read a
                # key out of it. The key read is the one applied AFTER.
                and cursor.args[0] is not node
            ):
                keys.add(cursor.args[0].value)
                break
            # d["key"]
            if isinstance(cursor, ast.Subscript) and isinstance(cursor.slice, ast.Constant):
                key = cursor.slice.value
                if isinstance(key, str) and cursor.slice is not node:
                    keys.add(key)
                    break
            cursor = parents.get(cursor)
    return keys


def _identifiers(node: ast.AST) -> set[str]:
    """Every name, attribute and string constant appearing in `node`."""
    found: set[str] = set()
    for inner in ast.walk(node):
        if isinstance(inner, ast.Name):
            found.add(inner.id)
        elif isinstance(inner, ast.Attribute):
            found.add(inner.attr)
        elif isinstance(inner, ast.Constant) and isinstance(inner.value, str):
            found.add(inner.value)
    return found


def _function_named(source: str, name: str) -> ast.FunctionDef:
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} is no longer defined in match.py")


def _components_with_wake(payload: dict, *, legacy_wake: bool, heading: float | None):
    """The golden components with one chosen wake verdict substituted in."""
    out = copy.deepcopy(P.GOLDEN["components"])
    for comp in out:
        comp["wakeAnalysis"] = copy.deepcopy(payload)
        comp["wake"] = legacy_wake
        comp["wakeHdg"] = heading
    return out


def _correlate(components: list[dict]) -> list[dict]:
    """Correlation refuses un-geolocated detections (GEO-CORR), as the parity
    harness notes: a component carries PIXEL centroids and must be turned into
    positions from the window transform first."""
    from darkfleet.geolocation import geolocate_components

    geo = P.GEO
    located = geolocate_components(components, crs=geo["crs"], transform=geo["transform"])
    return correlate(
        located, P.AIS, P.META["acquisitionTime"], P.META["resolutionMeters"], "S"
    )["targets"]


# ------------------------------------------------- the failure does not escape


class TestADetectorFailureCannotAbortTheScan:
    def test_a_raising_detector_does_not_propagate_out_of_extraction(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The primary requirement, stated as the outcome it used to not have.

        `extract_components` computes the centroid, the moments, the dB statistics
        and the clutter mean BEFORE it calls the detector. An exception from the
        detector used to discard all of it, and with it the scan. The only
        acceptable outcome now is a returned component list.
        """
        monkeypatch.setattr(
            "darkfleet.sar.components.analyse_wake",
            _boom(RuntimeError("simulated detector failure")),
        )
        mask, db = _blob()
        comps = extract_components(mask, db, pixel_spacing_m=10.0)
        assert len(comps) == 1
        assert comps[0]["area"] == 16

    def test_the_failure_is_reported_as_the_failed_state(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Not swallowed. Not a False with an empty note. A named state."""
        captured: list[BaseException] = []

        def _capture(*_args: object, **_kwargs: object) -> object:
            raise RuntimeError("simulated detector failure")

        monkeypatch.setattr("darkfleet.sar.components.analyse_wake", _capture)
        mask, db = _blob()
        comps = extract_components(mask, db, pixel_spacing_m=10.0)
        assert not captured

        analysis = WakeAnalysis.failed(RuntimeError("simulated detector failure"))
        assert analysis.state is WakeAnalysisState.FAILED
        assert analysis.state == "FAILED"
        assert analysis.detected is False
        # Every measurement is at its no-detection value because none was made.
        assert analysis.confidence == 0.0
        assert analysis.heading_deg is None
        assert analysis.wake_direction_deg is None
        assert analysis.apparent_length_m is None
        assert analysis.arm_angle_deg is None
        assert comps, "the component itself must still be returned"

    def test_the_failure_carries_its_exception_type_and_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Provenance, so the failure is legible rather than merely non-fatal.

        A catch that discards the exception has converted a crash into a silence.
        The type tells an operator whether this is a data problem or a detector
        bug; the message says which component.
        """
        monkeypatch.setattr(
            "darkfleet.sar.components.analyse_wake",
            _boom(ZeroDivisionError("division by zero in arm profile")),
        )
        mask, db = _blob()
        comps = extract_components(mask, db, pixel_spacing_m=10.0)
        assert comps, "the component was discarded rather than reported"
        assert comps, "the component was discarded rather than reported"

        # The component dict is the transport for the failure, so the reason has
        # to be legible there even before the wire model grows the typed fields.
        notes = comps[0]["wakeAnalysis"]["notes"]
        assert "ZeroDivisionError" in notes, notes
        assert "division by zero in arm profile" in notes, notes

    def test_the_typed_failure_keeps_the_exception_type_and_message(self) -> None:
        """The same provenance in the typed fields, for a caller that wants them."""
        analysis = WakeAnalysis.failed(ZeroDivisionError("division by zero in arm profile"))
        assert analysis.error_type == "ZeroDivisionError"
        assert analysis.error_message == "division by zero in arm profile"

    def test_a_component_keeps_the_measurements_it_actually_made(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The load-bearing asymmetry: only the wake verdict degrades.

        Everything this module measured came out of `db` before the detector ran
        and is independent of it. Asserting the whole record field-for-field is
        how we prove the failure cost the component its wake readout and nothing
        else -- a proxy like "the centroid still looks right" would not.
        """
        mask, db = _blob()
        clean = extract_components(mask, db, pixel_spacing_m=10.0)

        monkeypatch.setattr(
            "darkfleet.sar.components.analyse_wake",
            _boom(ZeroDivisionError("boom")),
        )
        failed = extract_components(mask, db, pixel_spacing_m=10.0)

        assert set(failed[0]) == set(clean[0]), "the record shape changed on failure"
        for key in clean[0]:
            if key == "wakeAnalysis":
                continue
            assert failed[0][key] == clean[0][key], key

    def test_one_failing_component_does_not_cost_the_others_their_wake_readout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Three components, detector fails on the middle one.

        The realistic shape: the guard is per component, so a component that
        could be analysed still is. A scan-wide kill would have lost all three.
        """
        mask = np.zeros((64, 64), dtype=bool)
        mask[10:14, 10:14] = True
        mask[30:34, 30:34] = True
        mask[50:54, 50:54] = True
        db = np.full((64, 64), -30.0)
        db[10:14, 10:14] = -8.0
        db[30:34, 30:34] = -8.0
        db[50:54, 50:54] = -8.0

        calls = {"n": 0}
        real = analyse_wake

        def _flaky(*args: object, **kwargs: object) -> WakeAnalysis:
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("detector failed on the second component")
            return real(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr("darkfleet.sar.components.analyse_wake", _flaky)
        comps = extract_components(mask, db, pixel_spacing_m=10.0)

        assert len(comps) == 3
        assert calls["n"] == 3, "the guard must not stop the loop"
        notes = [c["wakeAnalysis"]["notes"] for c in comps]
        assert sum("detector failed on the second component" in n for n in notes) == 1, notes


# ------------------------------------------------- pathological input is a state


class TestUnmeasurableInputIsAStateRatherThanAnException:
    @pytest.mark.parametrize(
        ("label", "db", "cy", "cx"),
        [
            ("all-NaN raster", np.full((8, 8), np.nan), 4.0, 4.0),
            ("zero-size raster", np.zeros((0, 0)), 0.0, 0.0),
            ("NaN centre row", np.full((64, 64), -25.0), float("nan"), 32.0),
            ("NaN centre column", np.full((64, 64), -25.0), 32.0, float("nan")),
            ("infinite centre", np.full((64, 64), -25.0), float("inf"), 32.0),
            ("centre outside the raster", np.full((64, 64), -25.0), -900.0, -900.0),
        ],
    )
    def test_a_pathological_input_yields_a_typed_state(
        self, label: str, db: np.ndarray, cy: float, cx: float
    ) -> None:
        """None of these used to be a state. Two of them used to be a traceback.

        A NaN centre reached `_chip`, which called `round(nan)` and raised
        `ValueError: cannot convert float NaN to integer` -- an error about
        integer conversion, raised somewhere with no connection to why the
        measurement was impossible. The others returned a note with no typed
        state, so a caller could not tell "unmeasurable" from "measured, absent".

        The state asserted here is NOT_AVAILABLE, not FAILED, and the distinction
        is the point: nothing went wrong, there was simply nothing to measure.
        """
        result = analyse_wake(db, cy, cx, 0.0, 10.0)
        assert isinstance(result.state, WakeAnalysisState), label
        assert result.state is WakeAnalysisState.NOT_AVAILABLE, label
        assert result.detected is False, label
        assert result.error_type is None, label
        assert result.notes, label
        assert result.method == "polar-ray-arm-pair", label

    def test_a_shape_violation_is_still_caught_by_the_component_guard(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The component guard is the general mechanism, not a special case.

        A one-dimensional raster violates the detector's contract and raises
        rather than returning NOT_AVAILABLE -- deliberately, because it is a
        programmer error rather than a property of real data, in the same family
        as the `half_chip` precondition. It must still be non-fatal at the
        component boundary, which is what makes the guard trustworthy for
        failures nobody has enumerated yet.
        """
        monkeypatch.setattr(
            "darkfleet.sar.components.analyse_wake",
            _boom(IndexError("tuple index out of range")),
        )
        mask, db = _blob()
        comps = extract_components(mask, db, pixel_spacing_m=10.0)
        assert comps
        assert "IndexError" in comps[0]["wakeAnalysis"]["notes"]

    def test_an_unmeasurable_input_is_never_reported_as_a_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Blank water is a normal state of the ocean, not an incident.

        If NOT_AVAILABLE degraded into FAILED, an alert keyed on FAILED would
        fire on every empty chip in a scene and become noise.
        """
        seen: list[WakeAnalysis] = []
        real = analyse_wake

        def _record(*args: object, **kwargs: object) -> WakeAnalysis:
            result = real(*args, **kwargs)  # type: ignore[arg-type]
            seen.append(result)
            return result

        monkeypatch.setattr("darkfleet.sar.components.analyse_wake", _record)
        mask = np.zeros((64, 64), dtype=bool)
        mask[2:5, 2:5] = True  # a component hard against the raster edge
        db = np.full((64, 64), np.nan)
        db[2:5, 2:5] = -8.0

        extract_components(mask, db, pixel_spacing_m=10.0)
        assert seen
        assert all(r.state is not WakeAnalysisState.FAILED for r in seen), seen


# -------------------------------------- and a failed wake decides nothing


class TestTheHelperItselfSeesEveryAccessShape:
    """The quarantine assertion is only as good as the scan behind it.

    A helper that silently misses one syntax leaves a hole exactly the size of the
    access it failed to see, and the assertion above still passes. So the scan is
    pinned here against synthetic source, one shape at a time, including the
    subscript form that a `.get`-only implementation misses.
    """

    @pytest.mark.parametrize(
        ("body", "expected"),
        [
            # The shape actually used today.
            ('x = (comp.get("wakeAnalysis") or {}).get("detected")', {"detected"}),
            # The subscript forms, which a `.get`-only scan misses.
            ('x = comp["wakeAnalysis"]["confidence"]', {"confidence"}),
            ('x = comp["wakeAnalysis"]["heading_deg"]', {"heading_deg"}),
            # Naming the result is not reading a key out of it.
            ('x = comp["wakeAnalysis"]', set()),
            ('x = comp.get("wakeAnalysis")', set()),
            # Two different keys off one result, both shapes at once.
            (
                (
                    'x = (comp.get("wakeAnalysis") or {}).get("detected");'
                    ' y = comp["wakeAnalysis"]["arm_angle_deg"]'
                ),
                {"detected", "arm_angle_deg"},
            ),
            # Sibling fields of the component are not the wake result.
            ('x = comp["meanDb"]; y = comp.get("wake"); z = comp["wakeHdg"]', set()),
        ],
    )
    def test_every_key_read_off_the_result_is_found(self, body: str, expected: set) -> None:
        source = f"def f(comp):\n    {body}\n"
        assert _keys_read_from_wake_result(ast.parse(source)) == expected, body

    def test_a_wake_read_injected_into_sar_confidence_is_detected(self) -> None:
        """The blindness assertion must not pass because the scan finds nothing.

        A vacuous identifier scan is indistinguishable from a real one -- both
        report "no wake" -- so the scan is proved to work on source that does
        contain the thing it is looking for.
        """
        blind = 'def _sar_confidence(comp):\n    return 0.5\n'
        seeing = (
            "def _sar_confidence(comp):\n"
            '    penalty = (comp.get("wakeAnalysis") or {}).get("confidence")\n'
            "    return 0.5\n"
        )
        assert not _identifiers(_function_named(blind, "_sar_confidence")) & WAKE_IDENTIFIERS
        assert _identifiers(_function_named(seeing, "_sar_confidence")) & WAKE_IDENTIFIERS


class TestAFailedWakeDecidesNothing:
    """The claim that makes the whole change safe to ship.

    A FAILED verdict must be indistinguishable, to everything analytical, from
    an ABSENT one. Both say the same thing -- nothing was measured -- and neither
    is evidence about the vessel.
    """

    def _failed_payload(self) -> dict:
        return WakeAnalysis.failed(ZeroDivisionError("boom")).to_dict()

    def test_a_failed_wake_moves_no_analytical_field(self) -> None:
        """Asserted directly through `correlate`, not inferred.

        This is the assertion the requirement actually asks for: same detections,
        same AIS, same correlation inputs, three different wake verdicts. The only
        thing permitted to differ is the wake readout itself.
        """
        absent = _correlate(
            _components_with_wake(
                WakeAnalysis.unavailable("chip too small").to_dict(),
                legacy_wake=False,
                heading=None,
            )
        )
        failed = _correlate(
            _components_with_wake(self._failed_payload(), legacy_wake=False, heading=None)
        )
        assert len(absent) == len(failed) == 12

        for a, b in zip(absent, failed):
            for field in ANALYTICAL:
                assert a[field] == b[field], (a["id"], field)
            ca, cb = a["corr"] or {}, b["corr"] or {}
            assert ca.get("mmsi") == cb.get("mmsi"), a["id"]
            assert ca.get("compositeScore") == cb.get("compositeScore"), a["id"]
            assert ca.get("scoreDecomposition") == cb.get("scoreDecomposition"), a["id"]

    def test_a_failed_wake_does_not_change_ghost_vessel_status(self) -> None:
        """Explicitly, because Ghost Vessel is the product-level claim.

        DF-005 entered Ghost Vessel state when a wake verdict moved an MMSI
        between two adjacent detections. A wake channel that cannot raise must
        not be able to lower it either.
        """
        absent = _correlate(
            _components_with_wake(
                WakeAnalysis.unavailable("chip too small").to_dict(),
                legacy_wake=False,
                heading=None,
            )
        )
        failed = _correlate(
            _components_with_wake(self._failed_payload(), legacy_wake=False, heading=None)
        )
        assert [t["id"] for t in absent if t["cls"] == "SAR_UNMATCHED"] == [
            t["id"] for t in failed if t["cls"] == "SAR_UNMATCHED"
        ]
        assert any(t["cls"] == "SAR_UNMATCHED" for t in failed), (
            "the fixture no longer exercises Ghost Vessel state"
        )

    def test_a_failed_wake_does_not_change_heading_tolerance(self) -> None:
        """A failure must not become a heading claim.

        `heading_deg` is None on FAILED, and the hull axis is the only validated
        primary source, so the reported heading has to be identical.
        """
        absent = _correlate(
            _components_with_wake(
                WakeAnalysis.unavailable("chip too small").to_dict(),
                legacy_wake=False,
                heading=None,
            )
        )
        failed = _correlate(
            _components_with_wake(self._failed_payload(), legacy_wake=False, heading=None)
        )
        for a, b in zip(absent, failed):
            assert a["hdg"] == b["hdg"], a["id"]
        # And the metric itself is untouched: hull axes are lines, so the
        # undirected 0..90 measure is used unconditionally.
        assert orient_diff(10.0, 190.0) == pytest.approx(0.0)

    def test_a_failed_wake_produces_no_tag(self) -> None:
        """A failure must not manufacture evidence in either direction.

        The only thing correlation does read is `detected`, and FAILED sets it
        False -- so no `WAKE_EVIDENCE_PRESENT` tag appears. The converse matters
        just as much: the tag set must not shrink either, because there is no
        `WAKE_EVIDENCE_ABSENT` and there must not be one.
        """
        absent = _correlate(
            _components_with_wake(
                WakeAnalysis.unavailable("chip too small").to_dict(),
                legacy_wake=False,
                heading=None,
            )
        )
        failed = _correlate(
            _components_with_wake(self._failed_payload(), legacy_wake=False, heading=None)
        )
        for a, b in zip(absent, failed):
            assert sorted(a.get("tags") or []) == sorted(b.get("tags") or []), a["id"]
            assert not any("WAKE" in tag for tag in b.get("tags") or []), b["id"]


class TestAFailedWakeIsStructurallyUnreachableFromScoring:
    """The same claim asserted on the code, so it cannot rot unnoticed.

    A behavioural test pins today's output. These pin the STRUCTURE that makes
    the output what it is: if a future edit starts feeding the wake result into a
    confidence or a classification, the structural assertion fails immediately
    rather than quietly moving six SAR confidences on the next fixture.
    """

    def test_sar_confidence_cannot_see_a_wake_field(self) -> None:
        """`_sar_confidence` is the detection confidence.

        Asserted over the AST rather than over the source text: the function's
        own docstring deliberately explains that absence of wake is not evidence
        of absence, so it NAMES wake in prose. A substring search would find that
        explanation and pass for the wrong reason -- or fail for the wrong one.
        """
        source = MATCH_PY.read_text(encoding="utf-8")
        identifiers = _identifiers(_function_named(source, "_sar_confidence"))
        assert not identifiers & WAKE_IDENTIFIERS, identifiers & WAKE_IDENTIFIERS
        assert "wake" not in _sar_confidence.__code__.co_varnames

    def test_the_heading_metric_cannot_see_a_wake_field(self) -> None:
        """`orient_diff` is the heading-tolerance metric, and takes no wake.

        Its third argument used to switch between a directed 0..180 measure and an
        undirected 0..90 one, which meant a wake detection silently changed HOW
        heading agreement was measured. That is the bug section 21 removed; this
        pins the removal in the function that owns it.
        """
        source = (
            Path(__file__).resolve().parents[1]
            / "darkfleet"
            / "correlation"
            / "geodesy.py"
        ).read_text(encoding="utf-8")
        identifiers = _identifiers(_function_named(source, "orient_diff"))
        assert not identifiers & WAKE_IDENTIFIERS, identifiers & WAKE_IDENTIFIERS

    def test_the_wake_result_is_read_only_as_its_verdict_boolean(self) -> None:
        """The only thing correlation may learn from the result is `detected`.

        This is the structural heart of the quarantine. `detected` is False on
        FAILED, on NOT_AVAILABLE and on NOT_ANALYSED alike -- so even a consumer
        that DID read it could not distinguish a failure from an absence, and
        therefore cannot treat a failure as evidence against a vessel.
        """
        source = MATCH_PY.read_text(encoding="utf-8")
        assert _keys_read_from_wake_result(ast.parse(source)) == {"detected"}

        for state in (
            WakeAnalysisState.FAILED,
            WakeAnalysisState.NOT_AVAILABLE,
            WakeAnalysisState.NOT_ANALYSED,
        ):
            payload = {
                "FAILED": WakeAnalysis.failed(RuntimeError("x")).to_dict(),
                "NOT_AVAILABLE": WakeAnalysis.unavailable("x").to_dict(),
                "NOT_ANALYSED": WakeAnalysis.not_analysed("x").to_dict(),
            }[state.value]
            assert payload["detected"] is False, state

    def test_a_state_is_not_silently_treated_as_a_detection(self) -> None:
        """No state may imply `detected` True.

        Guards the enum against a future member added for convenience -- a
        `PARTIAL`, say -- that would let a channel which did not finish reading
        as positive evidence.
        """
        assert WakeAnalysisState.ANALYSED.value == "ANALYSED"
        assert {s.value for s in WakeAnalysisState} == {
            "ANALYSED",
            "NOT_ANALYSED",
            "NOT_AVAILABLE",
            "FAILED",
        }
        assert not any(s.name.startswith("DETECTED") for s in WakeAnalysisState)


# ------------------------------------------ and is reported without breaking


class TestTheFailureIsReportedWithoutBreakingTheWireModel:
    """The state travels, and the wire model was extended to carry it.

    These two tests previously asserted the OPPOSITE: that the payload had NOT
    grown the field. That was deliberate at the time and correct within its
    limits -- `api.targets.WakeEvidence` is `extra="forbid"` and
    `correlation.match` copies the component dict straight onto the target, so
    emitting `state` from `to_dict()` turned a detector-side addition into a
    validation error on every target read.

    But suppressing it meant a FAILED analysis and a clean non-detection both
    presented `detected: false, confidence: 0.0`, and a reader of a stored record
    could not tell "the detector raised" from "the detector looked and found
    nothing". Those are different facts about a target, and the honest fix is to
    grow the wire model rather than keep the detector quiet.
    """

    def test_the_state_and_its_failure_provenance_are_persisted(self) -> None:
        payload = WakeAnalysis.failed(ZeroDivisionError("boom")).to_dict()
        assert payload["state"] == "FAILED"
        assert payload["error_type"] == "ZeroDivisionError"
        assert payload["error_message"] == "boom"
        assert payload["notes"].startswith("wake analysis failed")

        # The declared wire model must accept it, and must accept it with the
        # state intact rather than defaulting it away.
        from darkfleet.api.targets import WakeEvidence

        validated = WakeEvidence.model_validate(payload)
        assert validated.state == "FAILED"
        assert validated.error_type == "ZeroDivisionError"
        assert validated.detected is False

    def test_a_failed_payload_is_now_distinguishable_from_an_absent_one(self) -> None:
        """The two outcomes no longer look identical, and neither decides anything.

        Previously the only difference was the human-readable sentence, so the
        strongest available statement of "a failure decides nothing" was that
        stripping the sentence left the records equal. Now they differ
        structurally, which is what a consumer needs -- while every DECISION field
        still matches, because neither state is allowed to carry a failure into a
        classification.
        """
        failed = WakeAnalysis.failed(ZeroDivisionError("boom")).to_dict()
        absent = WakeAnalysis.unavailable("chip too small").to_dict()

        assert failed["state"] == "FAILED"
        assert absent["state"] == "NOT_AVAILABLE"
        assert failed != absent, "a failure must not be indistinguishable from an absence"

        # Every field a decision could be made from is identical. This is the
        # invariant that matters: the failure is fully reported AND inert.
        for key in ("detected", "confidence", "heading_deg", "wake_direction_deg",
                    "apparent_length_m", "arm_angle_deg", "arm_angle_line_deg"):
            assert failed[key] == absent[key], (
                f"{key} differs between FAILED and NOT_AVAILABLE; a wake failure "
                "has become a scoring input"
            )

    def test_every_outcome_names_its_method(self) -> None:
        """A failure names the method that failed, so it is verifiable.

        Otherwise a FAILED result is unfalsifiable: a reader cannot tell whether
        the ray search ran at all.
        """
        for analysis in (
            analyse_wake(np.full((8, 8), np.nan), 4.0, 4.0, 0.0, 10.0),
            WakeAnalysis.failed(RuntimeError("boom")),
            WakeAnalysis.not_analysed("channel disabled"),
        ):
            assert analysis.method == "polar-ray-arm-pair"
            assert analysis.notes

    def test_the_four_canonical_states_are_the_canonical_strings(self) -> None:
        """The vocabulary is part of the contract, so a rename cannot drift.

        A `str` enum, so these compare equal to the literal a schema, a query or
        a dashboard filter would send -- which is the whole reason for the type.
        """
        assert issubclass(WakeAnalysisState, str)
        assert {s.value for s in WakeAnalysisState} == {
            "ANALYSED",
            "NOT_ANALYSED",
            "NOT_AVAILABLE",
            "FAILED",
        }


# --------------------------------------- absence stays non-negative evidence


class TestWakeAbsenceRemainsNotEvidence:
    def test_neither_absence_nor_failure_moves_the_sar_confidence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Section 12, kept true across the failure path.

        A stationary or slow vessel shows no wake, and viewing geometry and sea
        state affect visibility. So absence is not evidence against a vessel, and
        a detector failure -- even less so, since nothing was measured. Both must
        leave the detection confidence at whatever the pixels alone justify.
        """
        comp = {"maxDb": -5.0, "clutterMeanDb": -25.0, "area": 9}
        baseline = _sar_confidence(comp)
        assert baseline == pytest.approx(0.71)

        # `_sar_confidence` takes the component, so the only way a wake could
        # reach it is through that dict. Inject every verdict and require the
        # same number.
        for payload in (
            WakeAnalysis.unavailable("chip too small").to_dict(),
            WakeAnalysis.failed(RuntimeError("boom")).to_dict(),
            WakeAnalysis.not_analysed("channel disabled").to_dict(),
        ):
            assert _sar_confidence({**comp, "wakeAnalysis": payload, "wake": False}) == (
                baseline
            ), payload["notes"]

    def test_a_failure_does_not_become_a_negative_penalty_in_the_legacy_field(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The component layer must not invent a penalty on the way out.

        `wake` and `wakeHdg` are the legacy fields correlation reads. On a
        failure they carry the no-detection values -- False and None -- which is
        exactly what an absent wake carries. Setting them to anything else, such
        as a sentinel or a sentinel-ish heading, would turn a broken detector into
        an analytical claim about the vessel.
        """
        mask, db = _blob()
        clean = extract_components(mask, db, pixel_spacing_m=10.0)[0]

        monkeypatch.setattr(
            "darkfleet.sar.components.analyse_wake",
            _boom(ZeroDivisionError("boom")),
        )
        failed = extract_components(mask, db, pixel_spacing_m=10.0)[0]

        assert failed["wake"] is False
        assert failed["wakeHdg"] is None
        assert failed["wake"] == clean["wake"]
        assert failed["wakeHdg"] == clean["wakeHdg"]

    def test_a_component_larger_than_the_ray_reach_is_still_refused(self) -> None:
        """DF-X7.0's stated precondition survives, at the detector layer.

        Refusing is the detector's honest answer to a programmer error; swallowing
        it into FAILED would hide a real bug behind a non-fatal state. The
        non-fatal contract lives at the COMPONENT boundary, which is the only
        place that can make the trade for its own caller.
        """
        with pytest.raises(ValueError, match="R_END_PX"):
            analyse_wake(
                np.full((64, 64), -25.0), 32.0, 32.0, 0.0, 10.0,
                half_chip=int(R_END_PX) - 1,
            )
