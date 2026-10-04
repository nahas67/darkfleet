"""The 149-158 deg band, permanently pinned (DF-X7V section 18).

A previous checkpoint reported `arm_angle_deg` values between 149 and 158 degrees,
which reads like a detector measuring near-perpendicular arm geometry. It is not.
The reported value is a DIRECTED difference folded into 0..180, while the physical
quantity -- the angle between the hull axis and the arm axis -- is UNDIRECTED and
lies in 0..90. The two conventions were being mixed in prose, which made a
consistent result look contradictory.

`arm_angle_deg` keeps its name and its directed meaning. Renaming it would
invalidate every stored record that carries it, and a stored number whose meaning
silently changes is worse than a number that is merely surprising. So the
convention is documented and tested instead, and `arm_angle_line_deg` carries the
undirected value alongside it.

These tests exist because the resolution was analytical prose. Prose does not fail
a build. If a future change alters the folding, the reported band moves, or the two
conventions are conflated again, these fail.

The final test parses the AST rather than grepping for a number. A substring search
for "149" also matches this module's own explanation of 149, so a text search
cannot distinguish a live constant from a comment about it.
"""

from __future__ import annotations

import ast
from pathlib import Path

import numpy as np
import pytest

from darkfleet.correlation.geodesy import orient_diff
from darkfleet.sar.wake import ARM_MAX_DEG, ARM_MIN_DEG, axial_delta_deg

BACKEND = Path(__file__).resolve().parents[1]
WAKE_SRC = BACKEND / "darkfleet" / "sar" / "wake.py"


class TestAxialFoldingIsMod180:
    """`axial_delta_deg` folds a directed difference into 0..90."""

    @pytest.mark.parametrize(
        ("directed", "axial"),
        [
            (149.0, 31.0),
            (154.0, 26.0),
            (158.0, 22.0),
            (160.5, 19.5),
        ],
    )
    def test_the_reported_band_folds_as_documented(
        self, directed: float, axial: float
    ) -> None:
        assert axial_delta_deg(directed, 0.0) == pytest.approx(axial)

    def test_every_reported_band_value_falls_inside_the_detectors_own_window(self) -> None:
        """The band is Kelvin geometry, not a contradiction.

        149..160.5 directed all land in 19.5..31.0 undirected, and the detector's
        arm acceptance window is 12..32 degrees. So the undirected values sit
        INSIDE the window the detector was built with. If that stopped being true,
        the detector would be accepting arms it does not believe in.
        """
        band = [axial_delta_deg(v, 0.0) for v in (149.0, 154.0, 158.0, 160.5)]
        assert min(band) >= ARM_MIN_DEG
        assert max(band) <= ARM_MAX_DEG

    @pytest.mark.parametrize("value", [0.0, 1.0, 44.9, 90.0, 135.1, 179.9, 180.0, 360.0])
    def test_the_result_always_lies_in_the_undirected_interval(self, value: float) -> None:
        assert 0.0 <= axial_delta_deg(value, 0.0) <= 90.0

    def test_folding_is_idempotent(self) -> None:
        once = axial_delta_deg(149.0, 0.0)
        assert axial_delta_deg(once, 0.0) == pytest.approx(once)

    def test_it_is_a_line_angle_so_it_is_symmetric_under_180(self) -> None:
        """An axis has no direction: 0 deg and 180 deg are the same axis."""
        assert axial_delta_deg(0.0, 0.0) == pytest.approx(0.0)
        assert axial_delta_deg(180.0, 0.0) == pytest.approx(0.0)

    def test_it_is_commutative(self) -> None:
        assert axial_delta_deg(37.0, 152.0) == pytest.approx(
            axial_delta_deg(152.0, 37.0)
        )


class TestTheTwoConventionsTravelTogether:
    """A directed value and an undirected value must both be reported.

    Reporting only the directed figure is what produced the apparent
    contradiction. Reporting only the undirected figure would be a different
    mistake: it would hide the convention the stored records were written with.
    """

    def test_orient_diff_is_undirected_only(self) -> None:
        """`orient_diff` lost its `wake_visible` switch and is now 0..90 only.

        It previously switched metric depending on whether a wake was seen, so the
        same pair of headings could yield 10 degrees with no wake and 170 with one.
        A function whose output meaning depends on an unrelated boolean is not a
        measurement, so the parameter was removed rather than left available.
        """
        assert orient_diff(0, 170) == pytest.approx(10.0)
        assert orient_diff(170, 0) == pytest.approx(10.0)
        for a, b in ((0, 90), (10, 100), (45, 135), (0, 179)):
            value = orient_diff(a, b)
            assert 0.0 <= value <= 90.0

    def test_orient_diff_takes_no_wake_argument(self) -> None:
        """The capability must be gone from the signature, not just unused.

        Removing only the call site would leave the switch available, and the next
        caller would reintroduce the same ambiguity.
        """
        import inspect

        params = list(inspect.signature(orient_diff).parameters)
        assert params == ["deg1", "deg2"], params
        assert "wake_visible" not in params

    def test_a_directed_reported_value_and_its_line_value_agree_after_folding(
        self,
    ) -> None:
        """The pair must be consistent for every angle the detector can emit."""
        rng = np.random.default_rng(11)
        for _ in range(200):
            directed = float(rng.uniform(0.0, 180.0))
            assert axial_delta_deg(directed, 0.0) == pytest.approx(
                min(directed, 180.0 - directed)
            )


class TestNoThresholdWasMovedToExplainTheBand:
    """The band was explained, not tuned away.

    Changing a threshold so the reported numbers stop looking large would hide
    the geometry rather than describe it. The acceptance window is pinned to the
    values the detector shipped with.
    """

    def test_the_arm_window_is_unchanged(self) -> None:
        assert (ARM_MIN_DEG, ARM_MAX_DEG) == (12.0, 32.0)

    def test_the_window_sits_inside_the_undirected_interval(self) -> None:
        """A window beyond 90 deg could not be expressed undirected at all."""
        assert 0.0 <= ARM_MIN_DEG < ARM_MAX_DEG <= 90.0


class TestMutationGuard:
    """Parse the module so a comment about 149 cannot satisfy a check about 149."""

    def test_the_folding_is_implemented_as_modulo_180(self) -> None:
        tree = ast.parse(WAKE_SRC.read_text(encoding="utf-8"))
        fn = next(
            (
                n
                for n in ast.walk(tree)
                if isinstance(n, ast.FunctionDef) and n.name == "axial_delta_deg"
            ),
            None,
        )
        assert fn is not None, "axial_delta_deg is gone"

        # Collect numeric constants appearing in the function body only. Docstrings
        # are excluded because they are where this explanation lives, and a
        # substring search over the file would match them.
        body = [n for n in ast.walk(fn) if not isinstance(n, ast.Expr)]
        text = ast.unparse(ast.Module(body=body, type_ignores=[]))
        assert "180" in text, (
            "axial_delta_deg no longer references 180; the mod-180 folding is gone"
        )
        assert "%" in text or "abs" in text, (
            "axial_delta_deg must fold by modulo or absolute value to reach 0..90"
        )

    def test_no_threshold_literal_was_introduced_into_the_folding(self) -> None:
        """A magic constant inside the fold would re-hide the geometry.

        Only the two structural constants are permitted: 180, the half-turn a line
        orientation is defined modulo, and 90, the undirected upper bound. Anything
        else -- a tuned limit, an acceptance threshold, a fudge factor -- would be
        a number chosen to make reported angles look better rather than to describe
        the geometry.
        """
        permitted = {180.0, 90.0}
        tree = ast.parse(WAKE_SRC.read_text(encoding="utf-8"))
        fn = next(
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "axial_delta_deg"
        )
        body = [n for n in ast.walk(fn) if not isinstance(n, ast.Expr)]
        found: set[float] = set()
        for node in ast.walk(ast.Module(body=body, type_ignores=[])):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                found.add(float(node.value))
        assert found <= permitted, (
            f"unexpected constant(s) in the angle fold: {sorted(found - permitted)}"
        )
        assert 180.0 in found, "the mod-180 fold is gone"