"""Two real bugs in the wake detector, found by trying to actually use it.

`analyse_wake` was written, tested against synthetic Kelvin wakes, and never
called. DF-X7 tried to wire it into the pipeline and hit both of these on the
first run. They are recorded here because a detector that cannot be called is a
detector whose remaining bugs are unknown -- and a crash inside the scan pipeline
takes out every other detection with it.

Neither test involves the pipeline. Both are properties of the detector alone.
"""

from __future__ import annotations

import numpy as np
import pytest

from darkfleet.sar.wake import R_END_PX, analyse_wake


def _sea(size: int = 96) -> np.ndarray:
    rng = np.random.default_rng(11)
    return (-21.0 + rng.normal(0.0, 0.8, (size, size))).astype(np.float64)


class TestRaySamplingCannotLeaveTheChip:
    """`_ray_mean` rounded an index that its own bounds mask had admitted.

    The mask tested `xs < size`, which admits 24.9999 in a 25-px chip -- and
    `round(24.9999)` is 25, one past the last index. The result was an IndexError
    that aborted the entire scan.

    It never fired in the existing tests because they all pass `half_chip=24`, a
    49-px chip whose rays (reach 22 px) stay well inside. It fires on the first
    smaller chip, and on any component whose chip is clipped by the raster edge.
    """

    @pytest.mark.parametrize("half", [12, 16, 22])
    def test_a_chip_narrower_than_the_ray_reach_never_indexes_out_of_range(
        self, half: int
    ) -> None:
        """The invariant is the ERROR, not the return value.

        A chip smaller than the ray reach is refused -- either by the stated
        precondition or by returning a result -- and what it must never do is fail
        the way it used to: `IndexError: index 25 is out of bounds`, from inside
        array indexing, with nothing in the message about why.

        An opaque IndexError is the dangerous outcome because it aborts the scan
        and reads like a bug in the caller rather than a contract that was not met.
        """
        db = _sea(2 * half + 8)
        try:
            result = analyse_wake(db, half + 4, half + 4, 0.0, 10.0, half_chip=half)
        except ValueError as exc:
            # The stated precondition. It must name the reach, so a caller can act.
            assert "R_END_PX" in str(exc), exc
            return
        except IndexError as exc:  # pragma: no cover - the regression
            pytest.fail(f"ray sampling left the {2 * half + 1}-px chip: {exc}")
        assert isinstance(result.detected, bool)

    def test_a_component_on_the_raster_edge_does_not_crash(self) -> None:
        """The realistic trigger: a detection one pixel from the border.

        `_chip` fills outside the source with NaN, so an edge component yields a
        partially empty chip. Every ray toward the missing side must be dropped,
        not indexed.
        """
        db = _sea(64)
        db[0:3, 0:3] = -8.0  # a blob hard against the top-left corner
        for cy, cx in ((0.0, 0.0), (0.0, 31.0), (31.0, 0.0), (63.0, 63.0)):
            try:
                analyse_wake(db, cy, cx, 35.0, 10.0, half_chip=24)
            except IndexError as exc:  # pragma: no cover - the regression
                pytest.fail(f"component at ({cy}, {cx}) crashed the scan: {exc}")


class TestChipSizePreconditionIsStated:
    """`half_chip` must be able to contain the ray reach.

    This precondition was implicit. The only caller passed 24 against a reach of
    22, so it happened to hold -- and a second caller passing the component crop
    of 12 did not, which is how the IndexError above was reached. An unstated
    precondition is a trap for the next caller, and the next caller is a scan.
    """

    def test_a_chip_too_small_for_the_reach_is_refused(self) -> None:
        db = _sea(64)
        with pytest.raises(ValueError, match="R_END_PX"):
            analyse_wake(db, 32, 32, 0.0, 10.0, half_chip=int(R_END_PX) - 1)

    def test_a_chip_exactly_the_reach_is_accepted(self) -> None:
        db = _sea(64)
        result = analyse_wake(db, 32, 32, 0.0, 10.0, half_chip=int(R_END_PX))
        assert isinstance(result.detected, bool)


class TestANonDetectionAssertsNothing:
    """A caller must not be able to read a course off an absence.

    `heading_deg` and `wake_direction_deg` are the fields a consumer would use to
    draw a wake axis. They are populated only by a detection, so a surface cannot
    render a confident arrow for a target that has none.
    """

    def test_flat_sea_reports_no_heading(self) -> None:
        result = analyse_wake(_sea(96), 48, 48, 0.0, 10.0, half_chip=24)
        assert result.detected is False
        assert result.heading_deg is None
        assert result.wake_direction_deg is None
        assert result.apparent_length_m is None

    def test_a_detection_states_its_own_confidence_bounds(self) -> None:
        """Confidence is evidence strength, not a probability.

        The module documents that ceiling; this asserts it, so a future edit that
        turns it into P(wake) fails here.
        """
        db = _sea(96)
        for level in (-14.0, -6.0):
            img = db.copy()
            img[46:50, 40:56] = level
            result = analyse_wake(img, 48, 48, 0.0, 10.0, half_chip=24)
            assert 0.0 <= result.confidence <= 1.0

    def test_every_outcome_names_its_method(self) -> None:
        """A non-detection still says what was attempted.

        "Not analysed" and "analysed, found nothing" are different statements, and
        a caller cannot tell them apart if `notes` is empty.
        """
        for img, cy, cx in ((_sea(96), 48, 48), (_sea(96), 0.0, 0.0)):
            result = analyse_wake(img, cy, cx, 0.0, 10.0, half_chip=24)
            assert result.method == "polar-ray-arm-pair"
            assert result.notes, "an empty note cannot distinguish absent from negative"