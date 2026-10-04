"""The uncertainty block must not describe work that was never done.

FOUND BY INSPECTION, NOT BY A FAILURE

`uncertainty.propagation_note` was emitted unconditionally as "AIS position
propagated to acquisition time by dead reckoning". For an UNMATCHED target the MMSI
is null, so no AIS position existed, nothing was propagated and nothing was dead
reckoned. The note asserted a computation that never happened -- inside the
uncertainty block, which is the single place in the document a reader is most likely
to accept a statement about method without checking it.

This is the same class of defect as rendering a missing AIS heading as 000 degrees:
a confident sentence standing in for a measurement that was not taken. It is worth a
test precisely because nothing else failed when it was wrong.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from darkfleet.evidence import target_evidence

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "ts_engine_golden.json"
AIS = Path(__file__).parent / "fixtures" / "golden" / "ts_ais.json"


def _stored(classification: str) -> dict[str, Any]:
    """A real stored target of the given classification, from the checked-in golden.

    Taken from the fixture rather than hand-rolled because a hand-rolled target is
    missing a required key sooner or later, and the resulting KeyError tests my
    fixture instead of the behaviour under test.
    """
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    for stored in golden["targets"]:
        if stored.get("cls") == classification:
            target = dict(stored)
            target.setdefault("sar_chip", None)
            return target
    raise AssertionError(f"golden contains no target classified {classification}")


def _target(classification: str, mmsi: str | None) -> dict[str, Any]:
    """A stored target with its correlation forced to the given association state."""
    target = _stored(classification)
    corr = dict(target.get("corr") or {})
    if mmsi is None:
        # Explicitly None, not omitted: an absent key and a null correlation block are
        # different inputs and both must render as "no association".
        target["corr"] = None
    else:
        corr["matched"] = True
        corr["mmsi"] = mmsi
        target["corr"] = corr
    return target


def _note(target: dict[str, Any]) -> str:
    evidence = target_evidence(target, {}, None)
    return str(evidence["uncertainty"]["propagation_note"])


class TestPropagationNoteDescribesRealWork:
    def test_an_unmatched_target_does_not_claim_a_propagation(self) -> None:
        # The defect. No MMSI means no position was propagated and nothing was dead
        # reckoned, so the sentence must not say that it was.
        note = _note(_target("SAR_UNMATCHED", mmsi=None))
        assert "propagated to acquisition time by dead reckoning" not in note, (
            "the note asserts a dead-reckoning propagation for a target that has no "
            "AIS position to propagate"
        )

    def test_an_unmatched_target_says_nothing_was_propagated(self) -> None:
        note = _note(_target("SAR_UNMATCHED", mmsi=None))
        assert "no dead reckoning was performed" in note.lower()

    def test_a_matched_target_does_report_the_propagation(self) -> None:
        # The fix must not over-correct into silence: when a propagation really
        # happened, the method is still worth recording.
        note = _note(_target("SAR_MATCHED_AIS", mmsi="477421900"))
        assert "propagated to acquisition time by dead reckoning" in note

    def test_the_no_correction_caveat_survives_in_both_branches(self) -> None:
        # "No gyro/IMU correction available" is a property of the DATA, not of the
        # association, so it must not be conditional on one existing.
        for mmsi in (None, "477421900"):
            note = _note(_target("SAR_MATCHED_AIS" if mmsi else "SAR_UNMATCHED", mmsi))
            assert "no gyro/imu correction available" in note.lower()

    def test_the_note_is_never_blank(self) -> None:
        # The epistemics contract requires the reason for an absence to be legible.
        # A blank note would erase the distinction the note exists to draw.
        for mmsi in (None, "477421900"):
            assert _note(_target("SAR_MATCHED_AIS" if mmsi else "SAR_UNMATCHED", mmsi)).strip()


class TestAgainstTheStoredFixture:
    """The real record, not a synthetic target."""

    def test_every_stored_unmatched_target_has_an_honest_note(self) -> None:
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        unmatched = [t for t in golden["targets"] if t.get("cls") == "SAR_UNMATCHED"]
        assert unmatched, "fixture no longer contains an unmatched target to check"

        for stored in unmatched:
            target = dict(stored)
            target.setdefault("sar_chip", None)
            corr = target.get("corr") or {}
            has_mmsi = bool(corr.get("mmsi"))
            note = _note(target)
            claims_propagation = "propagated to acquisition time by dead reckoning" in note
            assert claims_propagation is has_mmsi, (
                f"{target['id']}: mmsi={corr.get('mmsi')!r} but the note claims a "
                f"propagation: {note!r}"
            )

    def test_the_ais_fixture_is_present_so_the_matched_branch_is_exercised(self) -> None:
        # Guards against this file silently testing only the unmatched branch, where
        # the "does not claim" assertion is trivially satisfied.
        payload = json.loads(AIS.read_text(encoding="utf-8"))
        assert payload.get("aisObservations"), "AIS fixture is empty"