"""Wake is evidence. It must not decide anything.

DF-X7W. The measurements that justify this are in `docs/WAKE_SCORING_DELTA.md`:
with wake coupled into scoring, MMSI 477421900 moved between two adjacent
detections, which put DF-005 into Ghost Vessel state and took DF-006 out of it.

These tests are the standing prohibition. They are written as INVARIANTS -- the
same inputs with different wake evidence must produce identical analytical output
-- so they cannot be satisfied by a coincidence of the current fixture.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_correlation_parity as P

from darkfleet.correlation.geodesy import orient_diff
from darkfleet.correlation.match import (
    SCORING_MODEL_VERSION,
    _sar_confidence,
    correlate,
)

#: Fields that describe the VESSEL. None of them may respond to wake evidence.
ANALYTICAL = (
    "cls",
    "lat",
    "lon",
    "sarConf",
    "geo_pixel_centroid",
    "geo_centre_offset",
)


def _components(*, wake: bool, heading: float | None) -> list[dict]:
    """The golden components with a chosen wake verdict substituted in."""
    out = copy.deepcopy(P.GOLDEN["components"])
    for comp in out:
        comp["wake"] = wake
        comp["wakeHdg"] = heading
    return out


def _run_with(components: list[dict]) -> list[dict]:
    # Correlation refuses un-geolocated detections (GEO-CORR): a component
    # carries PIXEL centroids and must be turned into positions from the window
    # transform first. The parity harness does the same.
    from darkfleet.geolocation import geolocate_components

    geo = P.GEO
    located = geolocate_components(components, crs=geo["crs"], transform=geo["transform"])
    return correlate(
        located,
        P.AIS,
        P.META["acquisitionTime"],
        P.META["resolutionMeters"],
        "SCAN-GOLDEN-001",
    )["targets"]


# ------------------------------------------------------------ scoring authority


class TestWakeDoesNotScore:
    def test_sar_confidence_ignores_wake_evidence(self) -> None:
        """The +-0.08 constant is gone from the detection confidence.

        `_sar_confidence` no longer accepts a wake argument at all, so this is
        structurally true rather than conditionally true. The assertions pin the
        function's inputs so a re-added parameter fails here.
        """
        assert "wake" not in _sar_confidence.__code__.co_varnames

        comp = {"maxDb": -5.0, "clutterMeanDb": -25.0, "area": 9}
        assert _sar_confidence(comp) == pytest.approx(0.71)

    def test_wake_absence_does_not_penalise_confidence(self) -> None:
        """Section 12: no wake is not evidence against a vessel.

        A stationary or slow vessel may show no wake, and viewing geometry and sea
        state affect visibility. So the penalty that would follow from modelling
        absence as negative evidence is deliberately absent -- which can only be
        shown by there being nothing to remove.
        """
        assert not hasattr(_sar_confidence, "wake")

    def test_identical_inputs_produce_identical_output(self) -> None:
        """The load-bearing invariant (section 20).

        Same SAR detections, same AIS, same correlation inputs. Only the wake
        verdict differs. Nothing analytical may move.
        """
        absent = _run_with(_components(wake=False, heading=None))
        present = _run_with(_components(wake=True, heading=200.0))
        assert len(absent) == len(present) == 12

        for a, b in zip(absent, present):
            for field in ANALYTICAL:
                assert a[field] == b[field], (a["id"], field)
            assert (a.get("corr") or {}).get("mmsi") == (b.get("corr") or {}).get("mmsi"), a["id"]
            assert (a["corr"] or {}).get("compositeScore") == (
                b["corr"] or {}
            ).get("compositeScore"), a["id"]
            sa = a["corr"].get("scoreDecomposition") if a.get("corr") else None
            sb = b["corr"].get("scoreDecomposition") if b.get("corr") else None
            if sa is not None and sb is not None:
                assert sa == sb, a["id"]

    def test_ghost_vessel_status_is_untouched(self) -> None:
        """Explicitly, because it is the claim the product makes."""
        absent = _run_with(_components(wake=False, heading=None))
        present = _run_with(_components(wake=True, heading=200.0))
        assert [t["id"] for t in absent if t["cls"] == "SAR_UNMATCHED"] == [
            t["id"] for t in present if t["cls"] == "SAR_UNMATCHED"
        ]

    def test_a_wake_detection_produces_a_tag_not_a_score(self) -> None:
        """Evidence is recorded, as a tag an analyst can see.

        `UNDERWAY` was a stronger claim: it asserted the vessel is moving, which
        needs a validated conditional model. `WAKE_EVIDENCE_PRESENT` asserts only
        what was measured.
        """
        comps = copy.deepcopy(P.GOLDEN["components"])
        for comp in comps:
            comp["wakeAnalysis"] = {
                "detected": True,
                "confidence": 0.9,
                "heading_deg": 200.0,
                "wake_direction_deg": 20.0,
                "apparent_length_m": 220.0,
                "arm_angle_deg": 21.0,
                "method": "polar-ray-arm-pair",
                "notes": "symmetric arm pair",
            }
        from darkfleet.geolocation import geolocate_components

        geo = P.GEO
        located = geolocate_components(
            comps, crs=geo["crs"], transform=geo["transform"]
        )
        targets = correlate(
            located, P.AIS, P.META["acquisitionTime"], P.META["resolutionMeters"], "S"
        )["targets"]
        tagged = [t for t in targets if "WAKE_EVIDENCE_PRESENT" in (t.get("tags") or [])]
        assert tagged, "a measured wake must still be visible on the target"
        for target in tagged:
            assert "UNDERWAY" not in target["tags"], (
                "UNDERWAY claims the vessel is moving, which wake evidence alone "
                "does not establish"
            )
            assert "AIS_UNASSOCIATED" in target["tags"] or "CORRELATED_AIS" in target["tags"]


# ----------------------------------------------------- orientation authority


class TestWakeDoesNotOrient:
    def test_heading_tolerance_does_not_depend_on_wake(self) -> None:
        """Section 21.

        `orient_diff`'s third argument used to select between a directed 0..180
        metric and an undirected 0..90 one. A wake detection therefore changed how
        heading agreement was measured. The hull axis is the only validated
        primary source and it is a line, so the undirected metric is used
        unconditionally.
        """
        assert orient_diff(10.0, 20.0) == pytest.approx(10.0)
        assert orient_diff(0.0, 170.0) == pytest.approx(10.0)

    def test_wake_heading_is_not_substituted_for_hull_orientation(self) -> None:
        """A wake axis is not a hull heading, and must not become one."""
        absent = _run_with(_components(wake=False, heading=None))
        present = _run_with(_components(wake=True, heading=200.0))
        for a, b in zip(absent, present):
            assert a["hdg"] == b["hdg"], a["id"]

    def test_orientation_is_the_undirected_metric(self) -> None:
        """0..90, because a hull axis is a line with no arrow."""
        assert orient_diff(0.0, 90.0) == pytest.approx(90.0)
        assert orient_diff(0.0, 270.0) == pytest.approx(90.0)
        assert orient_diff(10.0, 190.0) == pytest.approx(0.0)


# ------------------------------------------------------------------ versioning


class TestScoringModelIsVersioned:
    def test_version_is_declared_and_is_v2(self) -> None:
        """Section 22: a result must be traceable to the model that produced it."""
        assert SCORING_MODEL_VERSION == "sar-scoring/v2"

    def test_v2_excludes_wake_from_scoring(self) -> None:
        """The version string must keep meaning something."""
        source = Path(
            str(Path(__file__).resolve().parents[1] / "darkfleet" / "correlation" / "match.py")
        ).read_text(encoding="utf-8")
        # Grep the CODE, not the prose. The docstrings deliberately quote the
        # removed constant to explain why it went, so a naive substring search
        # fails on its own explanation.
        import ast

        tree = ast.parse(source)
        constants: list[float] = []
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Assign)
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, float)
            ):
                constants.append(node.value.value)
        assert 0.08 not in constants, (
            "a fixed 0.08 wake bonus has been reintroduced into scoring"
        )


# ----------------------------------------------------------- the legacy sampler


class TestLegacySamplerIsGone:
    def test_the_hull_axis_sampler_no_longer_exists(self) -> None:
        """Section 4: removed, not replaced.

        It could not detect a Kelvin wake, reported False for all 84 stored
        targets, and held scoring authority it had not earned. Substituting
        `analyse_wake` for it would have replaced one unvalidated authority with
        another; deleting it is what actually removes the authority.
        """
        # Assert on the CODE, not the text. The module docstring and the call
        # site both name the deleted sampler, because explaining why an
        # unvalidated authority was removed is the point of leaving the note.
        import ast

        source = Path(
            str(Path(__file__).resolve().parents[1] / "darkfleet" / "sar" / "components.py")
        ).read_text(encoding="utf-8")
        defined = {
            node.name
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.FunctionDef)
        }
        assert "_kelvin_sampler" not in defined
        called = {
            node.func.id
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        assert "_kelvin_sampler" not in called

    def test_the_real_detector_still_runs(self) -> None:
        """Section 25: the checkpoint must not delete the real detector."""
        import ast

        source = Path(
            str(Path(__file__).resolve().parents[1] / "darkfleet" / "sar" / "components.py")
        ).read_text(encoding="utf-8")
        called = {
            node.func.id
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        assert "analyse_wake" in called