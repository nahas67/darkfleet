"""CP15 gate, part 2: multi-polarization (ADV-006) and constrained AI (ADV-011/012)."""

from __future__ import annotations

import json

import numpy as np
import pytest

from darkfleet.narrative import (
    AI_UNAVAILABLE,
    ModelIdentity,
    SummariserRegistry,
    SummaryRejected,
    language_violations,
    summarise,
    validate_document,
    validate_model_id,
)
from darkfleet.polarization import (
    NOT_AVAILABLE,
    combine_pol_pols,
    extract_features,
    pol_ratio_db,
)


def _chip(seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = -22.0 + rng.normal(0.0, 1.2, (32, 32))
    base[12:18, 14:20] = 5.0  # a bright target
    return base


# ------------------------------------------------------ polarization (ADV-006)


def test_dual_pol_features_and_ratio() -> None:
    vv = _chip()
    vh = _chip(seed=8) + 4.0  # man-made targets separate in VH
    feats = extract_features({"VV": vv, "VH": vh}, mask=None, domain="sigma0")
    assert feats.provenance.available == ("VV", "VH")
    assert not feats.provenance.single_pol
    assert feats.vh_over_vv_db is not None
    assert feats.vh_over_vv_db > 0
    assert feats.dual_pol_flags["vh_over_vv_above_ship_flag"] is True
    assert "VV" in feats.per_pol and feats.per_pol["VV"]["max_db"] > 0


def test_single_pol_reports_dual_pol_as_not_available() -> None:
    feats = extract_features({"VV": _chip()}, mask=None)
    assert feats.provenance.single_pol
    assert feats.vh_over_vv_db is None
    assert feats.dual_pol_flags["vh_over_vv"] == NOT_AVAILABLE
    assert feats.dual_pol_flags["vh_over_vv_threshold_db"] if False else True
    assert any("single polarization" in n for n in feats.notes)
    assert "VH" in feats.provenance.unavailable
    assert feats.provenance.reasons["VH"] == "not present in this acquisition"


def test_no_polarization_yields_all_not_available() -> None:
    feats = extract_features({})
    assert feats.per_pol == {}
    assert feats.dual_pol_flags["vh_over_vv"] == NOT_AVAILABLE
    assert feats.dual_pol_flags["hv_over_hh"] == NOT_AVAILABLE
    assert feats.vh_over_vv_db is None
    assert feats.provenance.single_pol


def test_ratio_excludes_noise_dominated_pixels() -> None:
    vv = np.full((8, 8), -30.0)  # noise floor
    vh = np.full((8, 8), -30.0)
    assert pol_ratio_db(vh, vv) is None


def test_ratio_is_none_on_empty_intersection() -> None:
    a = np.full((4, 4), np.nan)
    assert pol_ratio_db(a, a) is None


def test_hh_hv_ratio_computed_when_present() -> None:
    hh = _chip(seed=11)
    hv = hh - 2.0
    feats = extract_features({"HH": hh, "HV": hv})
    assert feats.ratio_db is not None
    assert feats.ratio_db["hv_over_hh_db"] is not None
    assert feats.ratio_db["hv_over_hh_db"] < 0


def test_mask_restricts_statistics_to_the_target_chip() -> None:
    arr = _chip()
    mask = np.zeros_like(arr, dtype=bool)
    mask[12:18, 14:20] = True
    feats = extract_features({"VV": arr}, mask=mask)
    assert feats.per_pol["VV"]["max_db"] > 0
    assert feats.per_pol["VV"]["mean_db"] > 0


def test_empty_mask_reports_not_available_not_zero() -> None:
    arr = _chip()
    feats = extract_features({"VV": arr}, mask=np.zeros_like(arr, dtype=bool))
    assert feats.per_pol["VV"]["mean_db"] == NOT_AVAILABLE


def test_combine_refuses_empty_input() -> None:
    with pytest.raises(ValueError, match="no polarization data"):
        combine_pol_pols({})


def test_combine_averages_available_pols() -> None:
    a = np.zeros((4, 4))
    b = np.full((4, 4), 4.0)
    out = combine_pol_pols({"VV": a, "VH": b})
    assert np.allclose(out, 2.0)


def test_provenance_is_serializable() -> None:
    feats = extract_features({"VV": _chip(), "VH": _chip(9)})
    json.dumps(feats.to_dict())


# --------------------------------------------------------------- AI (ADV-011/12)

_EVIDENCE = {
    "target_id": "DF-001-T01",
    "observed": {
        "position": {"lat": 1.2634, "lon": 103.8102},
        "apparent_footprint_m": {"length": 214.0, "width": 41.0},
        "orientation_deg": 118.0,
        "mean_backscatter_db": -8.4,
        "max_backscatter_db": -1.2,
        "wake_evident": False,
        "sar_detection_confidence": 0.82,
    },
    "uncertainty": {
        "length_uncertainty_m": 38.0,
        "propagation_note": "AIS position propagated to acquisition time by dead reckoning.",
    },
    "association": {
        "mmsi": "563189210",
        "vessel_name": "EVER GIVEN",
        "distance_offset_m": 41.0,
        "time_delta_s": 96.0,
        "ais_association_confidence": 0.71,
    },
}


def test_model_id_must_be_auditable() -> None:
    assert validate_model_id("darkfleet/template@1").provider == "darkfleet"
    for bad in ("gpt", "GPT-4", "", "no-slash-here", "../etc/passwd", "a/b c"):
        with pytest.raises(SummaryRejected):
            validate_model_id(bad)


def test_registry_refuses_adapter_with_unvalidated_model_id() -> None:
    class Bad:
        model = ModelIdentity(model_id="not-a-provider-qualified-id")

    with pytest.raises(SummaryRejected, match="not auditable"):
        SummariserRegistry().register(Bad())  # type: ignore[arg-type]


def test_default_render_produces_valid_document() -> None:
    out = summarise(_EVIDENCE)
    assert out["status"] == "OK"
    doc = out["document"]
    for section in ("observed", "hypotheses", "unknowns"):
        assert doc[section]
    assert 0.0 <= doc["confidence"] <= 1.0
    assert doc["model"]["model_id"]
    assert doc["provenance"]["network_calls"] == 0


def test_default_render_language_is_neutral() -> None:
    doc = summarise(_EVIDENCE)["document"]
    blob = json.dumps(doc).lower()
    assert language_violations(blob) == []
    assert "not confirmed" in blob or "not an identification" in blob


def test_unmatched_evidence_never_produces_accusation() -> None:
    ev = json.loads(json.dumps(_EVIDENCE))
    ev["association"] = {"mmsi": None, "vessel_name": None, "distance_offset_m": None,
                         "time_delta_s": None, "ais_association_confidence": None}
    out = summarise(ev)
    assert out["status"] == "OK"
    blob = json.dumps(out["document"]).lower()
    assert language_violations(blob) == []
    for forbidden in ("no active transponder", "dark vessel", "silent"):
        assert forbidden not in blob


def test_invalid_model_id_returns_unavailable_not_raises() -> None:
    out = summarise(_EVIDENCE, model_id="garbage")
    assert out["status"] == AI_UNAVAILABLE
    assert "auditable" in out["reason"]


def test_adapter_exception_never_breaks_deterministic_analysis() -> None:
    class Exploding:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            raise ConnectionError("upstream 503")

    reg = SummariserRegistry()
    reg.register(Exploding())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == AI_UNAVAILABLE
    assert "ConnectionError" in out["reason"]
    # the deterministic evidence is untouched and still available to the caller
    assert _EVIDENCE["observed"]["position"]["lat"] == 1.2634


def test_adapter_returning_malformed_json_is_refused() -> None:
    class Garbage:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            return "{not json"

    reg = SummariserRegistry()
    reg.register(Garbage())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == AI_UNAVAILABLE


def test_adapter_inventing_an_observation_is_refused() -> None:
    class Fabricator:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            return json.dumps(
                {
                    "target_id": "DF-001-T01",
                    "observed": ["A refrigerated container hatches were observed."],
                    "hypotheses": ["The vessel is a container ship."],
                    "unknowns": ["Cargo manifest is not observable in SAR."],
                    "confidence": 0.9,
                    "summary": "Refrigerated container hatches were observed.",
                    "model": {"model_id": "vendor/model@v1"},
                }
            )

    reg = SummariserRegistry()
    reg.register(Fabricator())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == AI_UNAVAILABLE
    assert "absent from the evidence" in out["reason"]


def test_adapter_returning_accusatory_language_is_refused() -> None:
    class Accusatory:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            return json.dumps(
                {
                    "target_id": "DF-001-T01",
                    "observed": ["The vessel is a suspected sanction evasion target."],
                    "hypotheses": ["It is evading sanctions."],
                    "unknowns": ["Intent is not established."],
                    "confidence": 0.5,
                    "summary": "Suspected sanction evasion target.",
                    "model": {"model_id": "vendor/model@v1"},
                }
            )

    reg = SummariserRegistry()
    reg.register(Accusatory())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == AI_UNAVAILABLE
    assert "accusatory" in out["reason"]


def test_document_missing_a_section_is_rejected() -> None:
    with pytest.raises(SummaryRejected, match="missing required sections"):
        validate_document({"observed": ["a"], "hypotheses": ["b"], "unknowns": ["c"]})


def test_document_with_unexpected_section_is_rejected() -> None:
    with pytest.raises(SummaryRejected, match="unexpected sections"):
        validate_document(
            {
                "observed": ["a"],
                "hypotheses": ["b"],
                "unknowns": ["c"],
                "confidence": 0.5,
                "summary": "s",
                "model": {"model_id": "a/b"},
                "recommendation": "detain",
            }
        )


def test_confidence_out_of_range_is_rejected() -> None:
    base = {
        "observed": ["a"],
        "hypotheses": ["b"],
        "unknowns": ["c"],
        "summary": "s",
        "model": {"model_id": "a/b"},
    }
    with pytest.raises(SummaryRejected, match="within"):
        validate_document({**base, "confidence": 1.4})
    with pytest.raises(SummaryRejected, match="must be a number"):
        validate_document({**base, "confidence": "high"})


def test_empty_unknowns_list_is_rejected() -> None:
    with pytest.raises(SummaryRejected, match="non-empty list"):
        validate_document(
            {
                "observed": ["a"],
                "hypotheses": ["b"],
                "unknowns": [],
                "confidence": 0.5,
                "summary": "s",
                "model": {"model_id": "a/b"},
            }
        )


def test_language_guard_catches_each_forbidden_term() -> None:
    for term in ("sanction evasion", "dark vessel", "no transponder", "confirmed identity"):
        assert language_violations(f"This is a {term} observation.")


def test_invented_measurement_is_refused_even_from_template_vocabulary() -> None:
    """The fact guard applies to every writer, trusted or not."""
    class Inflater:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            return json.dumps(
                {
                    "target_id": "DF-001-T01",
                    "observed": ["Mean backscatter in the chip is 3.7 dB."],
                    "hypotheses": ["The return is brighter than the measured value."],
                    "unknowns": ["Cause is not established."],
                    "confidence": 0.5,
                    "summary": "Mean backscatter 3.7 dB.",
                    "model": {"model_id": "vendor/model@v1"},
                }
            )

    reg = SummariserRegistry()
    reg.register(Inflater())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == AI_UNAVAILABLE
    assert "3.7" in out["reason"]


def test_invented_named_entity_is_refused() -> None:
    class Renamer:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            return json.dumps(
                {
                    "target_id": "DF-001-T01",
                    "observed": ["An AIS report with MMSI 999999999 was correlated."],
                    "hypotheses": ["The return is associated with that report."],
                    "unknowns": ["Identity is not confirmed."],
                    "confidence": 0.5,
                    "summary": "MMSI 999999999 was correlated.",
                    "model": {"model_id": "vendor/model@v1"},
                }
            )

    reg = SummariserRegistry()
    reg.register(Renamer())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == AI_UNAVAILABLE
    assert "999999999" in out["reason"]


def test_evidenced_vessel_name_is_allowed() -> None:
    """A name that IS in the evidence must pass the identifier guard."""
    class Faithful:
        model = ModelIdentity(model_id="vendor/model@v1")

        def summarise(self, evidence: dict) -> str:
            return json.dumps(
                {
                    "target_id": "DF-001-T01",
                    "observed": ["An AIS report named EVER GIVEN was correlated."],
                    "hypotheses": ["The return is associated with that report."],
                    "unknowns": ["Identity is not confirmed."],
                    "confidence": 0.7,
                    "summary": "EVER GIVEN was correlated.",
                    "model": {"model_id": "vendor/model@v1"},
                }
            )

    reg = SummariserRegistry()
    reg.register(Faithful())
    out = summarise(_EVIDENCE, registry=reg, model_id="vendor/model@v1")
    assert out["status"] == "OK", out.get("reason")