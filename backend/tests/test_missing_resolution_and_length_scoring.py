"""DF-X9.8-H2 and DF-X9.8-H3: Correct SAR resolution and missing-length scoring.

Verifies:
1. When sensor resolution is missing (None):
   - apparent_len, apparent_wid, and len_unc are None, never fabricated from 10.0 m.
   - size compatibility score is None, and composite score renormalises across
     spatial, temporal, and heading terms rather than crashing.
   - ScoreDecomposition["sizeScore"] is None.

2. When AIS vessel length (length_m) is missing (None):
   - size score is None (unobserved), never defaulted to an unearned 0.8.
   - composite score is renormalised across spatial, temporal, and heading terms.
   - An absent length does NOT receive an arbitrary bonus over a measured vessel.

3. When resolution or length is measured:
   - Matching dimensions produce a high size score.
   - Disagreeing dimensions produce a low size score.

4. Wake analysis with missing pixel spacing (None):
   - apparent_length_m is None, never fabricated from a 1.0 m default.
"""

from __future__ import annotations

import numpy as np

from darkfleet.correlation.match import correlate
from darkfleet.sar.wake import analyse_wake

ACQ = "2026-05-12T08:12:00.000000Z"


def _comp(*, major: float = 12.0, minor: float = 4.0, orient: float = 45.0) -> dict:
    return {
        "major": major,
        "minor": minor,
        "orient": orient,
        "lat": 1.30,
        "lon": 103.80,
        "meanDb": 5.0,
        "maxDb": 12.0,
        "clutterMeanDb": 2.0,
        "area": 25,
        "wake": False,
        "lenUncPx": 2.0,
    }


def _ais_ob(*, length: float | None = None, mmsi: str = "257000001", **kwargs) -> dict:
    base = {
        "mmsi": mmsi,
        "timestamp": ACQ,
        "lat": 1.3005,
        "lon": 103.8005,
        "sog": 10.0,
        "cog": 45.0,
        "heading": 45.0,
        "length_m": length,
    }
    base.update(kwargs)
    return base


def test_correlate_with_none_resolution_does_not_fabricate_dimensions() -> None:
    """When resolution_m is None, targets must report lenM/widM/lenUncM as None."""
    comp = _comp(major=15.0, minor=5.0)
    ais = [_ais_ob(length=150.0)]
    out = correlate([comp], ais, ACQ, resolution_m=None, scan_id="SCAN-001")

    targets = out["targets"]
    assert len(targets) == 1
    t = targets[0]
    assert t["lenM"] is None
    assert t["widM"] is None
    assert t["lenUncM"] is None
    # A strong AIS association has its own spatial/directional assessment; an
    # unmatched observation must explicitly identify unavailable size evidence.
    without_ais = correlate([comp], [], ACQ, resolution_m=None, scan_id="SCAN-002")
    unmatched = without_ais["targets"][0]
    assert "apparent length not established" in unmatched["assessment"]
    assert "Nonem" not in unmatched["assessment"]

    # Size score in decomposition is None
    decomp = t["corr"].get("scoreDecomposition")
    if decomp:
        assert decomp["sizeScore"] is None


def test_correlate_with_none_length_does_not_award_0_8_bonus() -> None:
    """An unobserved AIS length must not receive size=0.8.

    Previously, match.py:321 defaulted size=0.8 for any missing length, awarding
    GFW rows or rows without length_m an unearned 0.12 composite score contribution.
    """
    comp = _comp(major=15.0, minor=5.0)
    # Target apparent length with 10m resolution: 15 * 10 = 150m
    # 1. Matching vessel (length = 150m)
    ais_matching = _ais_ob(length=150.0, mmsi="257000001")
    out_matching = correlate([comp], [ais_matching], ACQ, resolution_m=10.0, scan_id="SCAN-001")
    t_match = out_matching["targets"][0]
    dec_match = t_match["corr"]["scoreDecomposition"]
    assert dec_match["sizeScore"] == 1.0

    # 2. Vessel with missing length
    ais_missing = _ais_ob(length=None, mmsi="257000002")
    out_missing = correlate([comp], [ais_missing], ACQ, resolution_m=10.0, scan_id="SCAN-001")
    t_missing = out_missing["targets"][0]
    dec_missing = t_missing["corr"]["scoreDecomposition"]
    assert dec_missing["sizeScore"] is None


def test_missing_length_scores_neutral_not_above_evidence() -> None:
    """Candidate with missing length is renormalised over spatial/temporal/heading."""
    comp = _comp(major=10.0, minor=3.0)
    # Target apparent length = 100m.
    # Case A: ob with missing length
    ais_unreported = _ais_ob(length=None)
    out_a = correlate([comp], [ais_unreported], ACQ, resolution_m=10.0, scan_id="SCAN-001")
    t_a = out_a["targets"][0]
    dec_a = t_a["corr"].get("scoreDecomposition")
    assert dec_a is not None
    assert dec_a["sizeScore"] is None

    # Case B: ob with disagreeing length (500m vs 100m -> size agreement is max(0, 1 - 400/500) = 0.2)
    ais_bad_size = _ais_ob(length=500.0)
    out_b = correlate([comp], [ais_bad_size], ACQ, resolution_m=10.0, scan_id="SCAN-001")
    t_b = out_b["targets"][0]
    dec_b = t_b["corr"].get("scoreDecomposition")
    assert dec_b is not None
    assert dec_b["sizeScore"] == 0.2

    # The missing length candidate has no sizeScore, while bad_size has sizeScore=0.2
    # The missing length candidate should score strictly higher than a candidate with active disagreement
    assert t_a["corr"]["scoreDecomposition"]["compositeScore"] > t_b["corr"]["scoreDecomposition"]["compositeScore"]


def test_wake_analysis_missing_pixel_spacing() -> None:
    """When pixel_spacing_m is None or <=0, apparent_length_m is None, not defaulted to 1.0m."""
    chip = np.zeros((48, 48), dtype=np.float64)
    # High contrast diagonal line simulating a wake arm
    for i in range(10, 38):
        chip[i, i] = 20.0

    res_none = analyse_wake(chip, 24.0, 24.0, 45.0, pixel_spacing_m=None)
    assert res_none.apparent_length_m is None

    res_zero = analyse_wake(chip, 24.0, 24.0, 45.0, pixel_spacing_m=0.0)
    assert res_zero.apparent_length_m is None

    res_valid = analyse_wake(chip, 24.0, 24.0, 45.0, pixel_spacing_m=10.0)
    if res_valid.detected:
        assert res_valid.apparent_length_m is not None
        assert res_valid.apparent_length_m > 0
