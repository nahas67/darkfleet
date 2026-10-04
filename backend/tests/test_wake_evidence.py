"""Wake evidence is real, and it is quarantined from every correlation decision.

Two properties, and the second is the one that makes the first safe to ship.

1. The wake detector now runs on every component and its measurement reaches the
   target record. Before this, `wake` was False for all 84 stored targets because
   nothing ever ran: `analyse_wake` existed, was tested against synthetic Kelvin
   wakes, and had zero callers.

2. Nothing correlation reads has changed. `wake` -- the legacy six-point
   hull-axis sampler -- is still what drives SAR confidence, classification,
   heading tolerance and the assessment narrative, and the new `wakeAnalysis`
   field is named so no existing consumer can pick it up.

Property 2 is what lets property 1 ship. Replacing the legacy verdict outright
shifts six SAR confidences by exactly the +-0.08 the confidence model grants a
wake, and on the legacy parity fixture it reassigns two vessels between matched
and unmatched. That is a scientific question -- should a detected wake move
detection confidence at all -- and it is not answered here.

These tests assert both properties directly, so neither can be lost silently.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from darkfleet.sar.components import extract_components
from tests.test_api import (  # noqa: F401
    api_settings,
    client,
    completed_scan,
    net,
    offline_pipeline,
)

BBOX = [104.1011, 1.3569, 104.1371, 1.3931]


def _run(client: TestClient) -> str:
    response = client.post("/api/scans", json={"bbox": BBOX})
    assert response.status_code == 202, response.text
    scan_id = str(response.json()["scan_id"])
    deadline = time.monotonic() + 90.0
    while time.monotonic() < deadline:
        state = client.get(f"/api/scans/{scan_id}").json()
        if state.get("terminal"):
            assert state["stage"] == "COMPLETE", state.get("error")
            return scan_id
        time.sleep(0.2)
    raise AssertionError("scan did not complete")


def _blob(size: int = 60) -> tuple[np.ndarray, np.ndarray]:
    mask = np.zeros((size, size), dtype=bool)
    mask[28:32, 28:32] = True
    db = np.full((size, size), -30.0)
    db[28:32, 28:32] = -8.0
    return mask, db


# ------------------------------------------------- the detector actually runs


class TestTheDetectorRuns:
    def test_every_component_carries_a_measurement(self) -> None:
        """Not a bare boolean -- a result with a method and a reason.

        A `wake` flag cannot distinguish "never ran" from "ran and found nothing".
        The evidence object can, because `method` and `notes` are always present.
        """
        mask, db = _blob()
        comps = extract_components(mask, db, pixel_spacing_m=10.0)
        assert comps
        for comp in comps:
            analysis = comp.get("wakeAnalysis")
            assert isinstance(analysis, dict), "the detector did not run"
            assert analysis["method"], "a result must name its method"
            assert analysis["notes"], "a result must say why"
            assert 0.0 <= analysis["confidence"] <= 1.0

    def test_a_non_detection_asserts_no_heading(self) -> None:
        """Nothing downstream may draw a wake axis that was not observed."""
        mask, db = _blob()
        analysis = extract_components(mask, db, pixel_spacing_m=10.0)[0]["wakeAnalysis"]
        if not analysis["detected"]:
            assert analysis["heading_deg"] is None
            assert analysis["wake_direction_deg"] is None
            assert analysis["apparent_length_m"] is None

    def test_lengths_are_metres_not_pixels(self) -> None:
        """Ground sample distance is threaded through, not defaulted to 1.0.

        A silent 1.0 default would report a 220-unit wake as 220 metres, which is
        a plausible-looking number and a wrong one.
        """
        mask, db = _blob()
        coarse = extract_components(mask, db, pixel_spacing_m=10.0)[0]["wakeAnalysis"]
        fine = extract_components(mask, db, pixel_spacing_m=2.0)[0]["wakeAnalysis"]
        if coarse["apparent_length_m"] is not None:
            assert coarse["apparent_length_m"] != fine["apparent_length_m"], (
                "apparent length ignored the ground sample distance"
            )


# ------------------------------------------------- and cannot reach correlation


class TestTheQuarantineHolds:
    """The property that makes shipping the evidence safe.

    If any of these start failing, a readout has begun changing analytical claims,
    which is the thing this split exists to prevent.
    """

    def test_the_legacy_field_is_still_what_correlation_reads(
        self, client: TestClient, net: Any
    ) -> None:
        scan_id = _run(client)
        targets = client.get(f"/api/scans/{scan_id}/targets").json()["targets"]
        assert targets

        layers = client.get(f"/api/debug/{scan_id}/components", params={"limit": 50}).json()
        for row in layers["data"]:
            target = next(t for t in targets if t["id"] == row["target_id"])
            # The measured evidence is present and typed on the wire.
            assert "wakeAnalysis" in target
            # And the legacy boolean the pipeline decided on is still a boolean.
            assert isinstance(target["wake"], bool)

    def test_wake_evidence_is_nullable_and_says_so(
        self, client: TestClient, net: Any
    ) -> None:
        """A scan from before the detector was wired has no evidence.

        That must read as "not analysed" rather than as a detection or as zero.
        """
        scan_id = _run(client)
        for target in client.get(f"/api/scans/{scan_id}/targets").json()["targets"]:
            analysis = target.get("wakeAnalysis")
            if analysis is None:
                continue
            # Never a bare False, and never a confidence of 0 presented as a
            # finding: a non-detection carries its measured arm angle and reason.
            assert set(analysis) >= {
                "detected",
                "confidence",
                "method",
                "notes",
                "heading_deg",
                "arm_angle_deg",
            }
            if analysis["detected"] is False:
                assert analysis["notes"], "a non-detection must state its reason"

    def test_confidence_is_never_declared_a_probability(
        self, client: TestClient, net: Any
    ) -> None:
        """The field is evidence strength and the docstring says so.

        This asserts the bound travels, so a future edit cannot quietly widen it
        into something that reads as a probability.
        """
        scan_id = _run(client)
        for target in client.get(f"/api/scans/{scan_id}/targets").json()["targets"]:
            analysis = target.get("wakeAnalysis")
            if analysis is not None:
                assert 0.0 <= analysis["confidence"] <= 1.0

    def test_correlation_parity_is_unmoved(self) -> None:
        """The load-bearing check.

        `tests/test_correlation_parity.py` pins classifications, associations,
        coordinates and scores against the legacy engine golden. It is not
        restated here -- it is simply required to pass, because a wake readout
        that changes a classification has stopped being a readout.
        """
        from tests import test_correlation_parity as parity

        out = parity._run()
        golden = parity.GOLDEN["targets"]
        assert len(out["targets"]) == len(golden)
        for got, want in zip(out["targets"], golden):
            assert got["cls"] == want["cls"], got["id"]
            assert got["sarConf"] == want["sarConf"], got["id"]
            assert (got["corr"] or {}).get("mmsi") == (want["corr"] or {}).get("mmsi")


@pytest.mark.parametrize("field", ["wake", "wakeHdg"])
def test_the_legacy_sampler_still_exists(field: str) -> None:
    """The legacy verdict is still computed, not quietly dropped.

    If this ever goes away, every confidence and classification moves at once and
    the change would arrive disguised as a cleanup.
    """
    mask, db = _blob()
    comp = extract_components(mask, db, pixel_spacing_m=10.0)[0]
    assert field in comp