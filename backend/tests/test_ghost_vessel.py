"""GFST gate: Ghost Vessel semantics (GEO-CORR-independent).

The analytical classification stays ``SAR_UNMATCHED``. ``GHOST VESSEL`` is a
product designation rendered above it. These tests exist because the risk in that
designation is entirely in how it is phrased: the same words can either name an
analytical question or assert a conclusion about a vessel's intent.

Three properties are pinned:

1. A Ghost Vessel record never claims *why* there is no AIS association.
2. OBSERVED / HYPOTHESES / UNKNOWNS are structurally separate and never merged.
3. Product copy contains no forbidden inference -- asserted against the strings
   the backend actually emits, not against a comment.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from darkfleet import ghost_vessel as gv
from darkfleet.ghost_vessel import FORBIDDEN_INFERENCES, SEMANTIC_WARNING, assess, is_ghost_vessel

CONTRACT = Path(__file__).resolve().parents[2] / "src" / "api" / "contract.ts"


def _unmatched(**overrides: Any) -> dict[str, Any]:
    target: dict[str, Any] = {
        "id": "DF-001",
        "cls": "SAR_UNMATCHED",
        "lat": 1.3288,
        "lon": 104.1146,
        "sarConf": 0.94,
        "aisConf": 0.0,
        "lenM": 42.0,
        "widM": 8.0,
        "lenUncM": 9.2,
        "hdg": 271.0,
        "meanDb": -6.1,
        "maxDb": 3.8,
        "wake": True,
        "corr": {
            "matched": False,
            "mmsi": None,
            "scoreDecomposition": None,
            "candidatesConsidered": 3,
            "acceptanceThreshold": 0.4,
            "closestRejected": {
                "mmsi": "123456789",
                "vesselName": "MV EXAMPLE",
                "score": 0.31,
                "distanceMeters": 1840.0,
                "timeDeltaSeconds": -240,
                "shortfall": 0.09,
            },
        },
    }
    target.update(overrides)
    return target


# ------------------------------------------------------------------ the gate


def test_semantic_warning_disclaims_causation() -> None:
    assert "does not establish why" in SEMANTIC_WARNING
    assert "no sufficiently confident" in SEMANTIC_WARNING.lower()


def test_warning_contains_no_forbidden_inference() -> None:
    lowered = SEMANTIC_WARNING.lower()
    for phrase in FORBIDDEN_INFERENCES:
        assert phrase not in lowered, phrase


def test_hypothesis_templates_contain_no_forbidden_inference() -> None:
    """Hypotheses are where intent speculation would leak in. Checked directly."""
    blob = " ".join(gv._HYPOTHESIS_TEMPLATES).lower()
    for phrase in FORBIDDEN_INFERENCES:
        assert phrase not in blob, phrase


def test_hypotheses_are_coverage_or_detection_explanations() -> None:
    """Every hypothesis must be about observation, not about intent."""
    blob = " ".join(gv._HYPOTHESIS_TEMPLATES).lower()
    for marker in ("coverage", "not broadcasting", "clutter", "incidence", "stale"):
        assert marker in blob, marker


def test_unknowns_include_identity_and_intent() -> None:
    blob = " ".join(gv._UNKNOWN_ITEMS).lower()
    assert "identity" in blob
    assert "intent" in blob


# ------------------------------------------------------------ the derivation


def test_only_sar_unmatched_qualifies() -> None:
    assert is_ghost_vessel("SAR_UNMATCHED") is True
    for other in (
        "SAR_MATCHED_AIS",
        "AIS_ONLY",
        "SEA_CLUTTER",
        "LOW_CONFIDENCE",
        "UNRESOLVED",
        "STATIONARY_OR_INFRASTRUCTURE",
    ):
        assert is_ghost_vessel(other) is False, other


def test_matched_target_carries_no_ghost_record() -> None:
    """A matched vessel must never acquire the designation by accident."""
    record = assess(_unmatched(cls="SAR_MATCHED_AIS"))
    assert record["is_ghost_vessel"] is False
    assert record["designation"] is None


def test_designation_sits_above_the_analytical_class() -> None:
    designation, analytical = gv.display_label("SAR_UNMATCHED")
    assert designation == "GHOST VESSEL"
    assert analytical == "SAR_UNMATCHED"


def test_observed_block_carries_only_measurements() -> None:
    observed = assess(_unmatched())["observed"]
    for key in (
        "position",
        "sar_detection_confidence",
        "apparent_footprint_m",
        "length_uncertainty_m",
        "mean_backscatter_db",
        "max_backscatter_db",
    ):
        assert key in observed, key


def test_decision_block_explains_the_rejection_in_arithmetic() -> None:
    decision = assess(_unmatched())["decision"]
    assert decision["candidates_considered"] == 3
    assert decision["acceptance_threshold"] == pytest.approx(0.4)
    rejected = decision["closest_rejected_candidate"]
    assert rejected is not None
    assert rejected["mmsi"] == "123456789"
    # The reason must carry the numbers that produced it, not just a verdict.
    reason = decision["reason_no_association"]
    assert "0.31" in reason
    assert "0.4" in reason
    assert "123456789" in reason


def test_empty_search_is_distinguished_from_a_near_miss() -> None:
    """These are different findings and must not collapse into one."""
    nothing = assess(
        _unmatched(
            corr={
                "matched": False,
                "mmsi": None,
                "scoreDecomposition": None,
                "candidatesConsidered": 0,
                "acceptanceThreshold": 0.4,
                "closestRejected": None,
            }
        )
    )
    assert nothing["decision"]["closest_rejected_candidate"] is None
    assert "no ais candidate was available" in nothing["decision"]["reason_no_association"].lower()

    near_miss = assess(_unmatched())
    assert near_miss["decision"]["closest_rejected_candidate"] is not None


def test_coverage_state_is_reported_not_inferred() -> None:
    for state in ("AVAILABLE", "NO_COVERAGE", "PARTIAL", "NOT_CONFIGURED"):
        record = assess(_unmatched(), ais_coverage={"state": state})
        assert record["decision"]["ais_coverage_state"] == state


def test_absent_measurements_stay_none() -> None:
    """A Ghost Vessel dossier must not invent values it did not measure."""
    record = assess(_unmatched(hdg=None, lenUncM=None, meanDb=None))
    observed = record["observed"]
    assert observed["orientation_deg"] is None
    assert observed["length_uncertainty_m"] is None
    assert observed["mean_backscatter_db"] is None


def test_wake_is_reported_only_when_measured() -> None:
    assert assess(_unmatched())["observed"]["wake_detected"] is True
    assert assess(_unmatched(wake=False))["observed"]["wake_detected"] is False
    assert assess(_unmatched(wake=None))["observed"]["wake_detected"] is None


def test_hypotheses_and_unknowns_are_separate_blocks() -> None:
    record = assess(_unmatched())
    assert record["hypotheses"], "hypotheses must render even when empty"
    assert record["unknowns"], "unknowns must render even when empty"
    hypothesis_text = " ".join(item["text"] for item in record["hypotheses"]).lower()
    unknown_text = " ".join(item["text"] for item in record["unknowns"]).lower()
    # The two must not be the same sentences, and neither may be an observation.
    assert set(hypothesis_text) != set(unknown_text)


def test_whole_record_is_json_serialisable() -> None:
    """Evidence is exported; an unserialisable field would break every export."""
    json.dumps(assess(_unmatched(), ais_coverage={"state": "AVAILABLE"}))


# ------------------------------------------------------------- product copy


def test_contract_carries_the_decision_fields() -> None:
    text = CONTRACT.read_text(encoding="utf-8")
    for field in ("candidatesConsidered", "acceptanceThreshold", "closestRejected"):
        assert field in text, field
    assert "RejectedCandidate" in text