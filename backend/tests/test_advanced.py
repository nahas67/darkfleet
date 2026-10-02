"""CP15 gate: tracks, temporal intelligence, detector registry (ADV-001..010)."""

from __future__ import annotations

import numpy as np
import pytest

from darkfleet.detectors import DetectorCard, DetectorRegistry, DetectorSpec
from darkfleet.temporal import analyse, association_gap_patterns, repeated_unmatched_patterns
from darkfleet.tracks import build_tracks


def _obs(mmsi: str | None, hour: int, lat: float = 1.25, lon: float = 103.85) -> dict:
    return {
        "scan_id": f"DF-{hour:03d}",
        "item_id": f"S1_{hour}",
        "acquisition_time": f"2024-12-2{hour}T02:00:00Z",
        "lat": lat,
        "lon": lon,
        "sar_conf": 0.8,
        "classification": "SAR_MATCHED_AIS" if mmsi else "SAR_UNMATCHED",
        "apparent_length_m": 200.0,
        "length_unc_m": 44.0,
        "correlated_mmsi": mmsi,
    }


# ----------------------------------------------------------------- tracks


def test_tracks_link_only_ais_associated_observations() -> None:
    tracks = build_tracks([_obs("563189210", 0), _obs("563189210", 1), _obs(None, 2)])
    assert len(tracks) == 1
    assert len(tracks[0].points) == 2, "unmatched detections must not join a track"


def test_track_gap_records_implied_speed() -> None:
    tracks = build_tracks([_obs("563189210", 0), _obs("563189210", 1, lon=103.88)])
    gap = tracks[0].gaps[0]
    assert gap.implied_speed_knots is not None
    assert gap.implied_speed_knots > 0


def test_track_identity_never_claims_confirmed_identity() -> None:
    tracks = build_tracks([_obs("563189210", h) for h in range(4)])
    assert tracks
    statement = tracks[0].confidence_statement.lower()
    assert "hypothesis" in statement
    assert "not confirmed" in statement or "not on geometry alone" in statement
    assert tracks[0].identity_strength <= 0.85


def test_track_identity_strength_saturates_and_is_bounded() -> None:
    few = build_tracks([_obs("1", 0), _obs("1", 1)])[0]
    many = build_tracks([_obs("1", h) for h in range(6)])[0]
    assert 0.0 < few.identity_strength <= 0.85
    assert 0.0 < many.identity_strength <= 0.85


def test_no_tracks_for_pure_unmatched_history() -> None:
    assert build_tracks([_obs(None, h) for h in range(4)]) == []


# -------------------------------------------------------- temporal patterns


def test_ais_gap_pattern_detected_between_associations() -> None:
    obs = [_obs("563189210", 0), _obs(None, 1), _obs(None, 2), _obs("563189210", 3)]
    patterns = association_gap_patterns(obs)
    assert patterns
    p = patterns[0]
    assert p.kind == "AIS_ASSOCIATION_GAP"
    assert p.unknowns
    assert "coverage" in p.hypothesis.lower()


def test_leading_gap_is_not_reported_as_a_pattern() -> None:
    """A run at the archive edge is coverage, not a gap."""
    obs = [_obs(None, 0), _obs(None, 1), _obs("563189210", 2)]
    assert association_gap_patterns(obs) == []


def test_repeated_unmatched_requires_min_count() -> None:
    assert repeated_unmatched_patterns([_obs(None, 0), _obs(None, 1)]) == []
    assert repeated_unmatched_patterns([_obs(None, h) for h in range(3)])


def test_patterns_never_imply_intent() -> None:
    """Language guard: no accusation vocabulary anywhere in the output."""
    obs = [_obs("1", 0), _obs(None, 1), _obs("1", 2), _obs(None, 3), _obs(None, 4)]
    forbidden = ("sanction", "evad", "illegal", "smuggl", "criminal", "dark vessel", "threat")
    for p in analyse(obs):
        blob = f"{p.observed} {p.hypothesis}".lower()
        for word in forbidden:
            assert word not in blob, (word, p.pattern_id)
        assert 0.0 <= p.confidence <= 1.0
        assert p.unknowns


def test_analyse_returns_stable_ids() -> None:
    obs = [_obs("1", 0), _obs(None, 1), _obs("1", 2), _obs(None, 3)]
    first = [p.pattern_id for p in analyse(obs)]
    second = [p.pattern_id for p in analyse(obs)]
    assert first == second


# ------------------------------------------------------- detector registry


def test_cfar_baseline_is_always_usable() -> None:
    card = DetectorCard(
        name="cfar", kind="CFAR", training_domain="deterministic",
        input_product="Sentinel-1 GRD/RTC", validation_data="golden parity suite",
        limitations="assumes locally stationary clutter",
    )
    assert card.is_usable()


def test_ml_detector_without_weights_is_refused() -> None:
    card = DetectorCard(
        name="yolo-anything", kind="ML", training_domain="unknown",
        input_product="aerial RGB", validation_data="", limitations="unvalidated",
        weights_digest=None,
    )
    assert not card.is_usable()
    reg = DetectorRegistry()
    with pytest.raises(ValueError, match="refused"):
        reg.register(DetectorSpec(card=card, run=lambda *a, **k: []))


def test_ml_detector_with_provenance_is_accepted() -> None:
    card = DetectorCard(
        name="sar-vessel-v1", kind="ML", training_domain="Sentinel-1 IW GRD",
        input_product="Sentinel-1 GRD", validation_data="xView3-SAR split",
        limitations="near-shore label noise", weights_digest="sha256:abc123",
    )
    reg = DetectorRegistry()
    reg.register(
        DetectorSpec(card=card, run=lambda *a, **k: []), make_default=True
    )
    assert "sar-vessel-v1" in [c.name for c in reg.available()]
    assert reg.resolve().card.name == "sar-vessel-v1"


def test_unknown_detector_raises() -> None:
    with pytest.raises(KeyError):
        DetectorRegistry().resolve("nope")


def test_cfar_baseline_is_registered_and_runs() -> None:
    reg = DetectorRegistry()
    assert [c.name for c in reg.available()] == ["cfar"]
    spec = reg.resolve("cfar")
    assert spec.card.kind == "CFAR"

    # A real bright cluster in speckle must be found by the baseline path.
    rng = np.random.default_rng(3)
    db = (-21.0 + rng.normal(0.0, 1.5, (64, 64))).astype(np.float64)
    db[30:34, 28:32] = 6.0
    found = spec.run(db, np.ones_like(db, dtype=bool), None, {})
    assert found
    assert abs(found[0].cy - 31.5) <= 3 and abs(found[0].cx - 29.5) <= 3


def test_empty_registry_resolves_nothing() -> None:
    reg = DetectorRegistry(with_baseline=False)
    assert reg.available() == []
    with pytest.raises(KeyError):
        reg.resolve()