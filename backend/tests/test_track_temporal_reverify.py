"""Regression coverage for persisted nullable SAR measurements and UTC chronology."""

from darkfleet.temporal import (
    association_gap_patterns,
    convergence_patterns,
    repeated_unmatched_patterns,
)
from darkfleet.tracks import build_tracks


def _ob(when: str, mmsi: str | None, *, lon: float = 103.0) -> dict:
    return {
        "scan_id": when, "item_id": when, "acquisition_time": when,
        "lat": 1.0, "lon": lon, "sar_conf": 0.7,
        "classification": "SAR_MATCHED_AIS" if mmsi else "SAR_UNMATCHED",
        "correlated_mmsi": mmsi, "apparent_length_m": None, "length_unc_m": None,
    }


def test_track_preserves_unmeasured_sar_length_instead_of_crashing_or_inventing_zero() -> None:
    rows = [_ob("2026-10-01T10:00:00Z", "257000001"), _ob("2026-10-01T11:00:00Z", "257000001")]
    track = build_tracks(rows)[0]
    assert len(track.points) == 2
    assert track.points[0].apparent_length_m is None
    assert track.points[1].length_unc_m is None
    assert track.gaps[0].plausible


def test_tracks_order_by_utc_instant_not_timestamp_string() -> None:
    # Lexical order places 09:00Z before 14:00+05:30, although it is later.
    early = _ob("2026-10-01T14:00:00+05:30", "257000001")
    late = _ob("2026-10-01T09:00:00Z", "257000001")
    tracks = build_tracks([late, early])
    assert [p.acquisition_time for p in tracks[0].points] == [
        early["acquisition_time"], late["acquisition_time"]
    ]
    assert tracks[0].gaps[0].seconds == 1800


def test_gap_pattern_chronology_respects_offset() -> None:
    before = _ob("2026-10-01T09:00:00Z", "257000001")
    missing = _ob("2026-10-01T14:45:00+05:30", None)
    after = _ob("2026-10-01T10:00:00Z", "257000001")
    result = association_gap_patterns([after, before, missing])
    assert len(result) == 1
    assert "1 consecutive SAR pass" in result[0].observed


def test_gap_pattern_does_not_join_different_associated_vessels() -> None:
    result = association_gap_patterns([
        _ob("2026-10-01T09:00:00Z", "257000001"),
        _ob("2026-10-01T09:15:00Z", None),
        _ob("2026-10-01T09:30:00Z", "257000002"),
    ])
    assert result == []


def test_same_scan_detections_do_not_manufacture_association_gap() -> None:
    rows = [
        _ob("2026-10-01T09:00:00Z", "257000001"),
        _ob("2026-10-01T09:00:00Z", None),
        _ob("2026-10-01T09:00:00Z", "257000001"),
    ]
    assert association_gap_patterns(rows) == []


def test_repeated_unmatched_requires_distinct_sar_passes() -> None:
    one_pass = [_ob("2026-10-01T09:00:00Z", None) for _ in range(3)]
    assert repeated_unmatched_patterns(one_pass) == []
    later = [_ob(f"2026-10-0{i}T09:00:00Z", None) for i in range(1, 4)]
    assert len(repeated_unmatched_patterns(later)) == 1


def test_colocation_requires_same_scan_not_merely_same_cell() -> None:
    months_apart = [
        _ob("2026-01-01T09:00:00Z", "257000001"),
        _ob("2026-10-01T09:00:00Z", "257000002"),
    ]
    assert convergence_patterns(months_apart) == []
    same_scan = [
        _ob("2026-10-01T09:00:00Z", "257000001"),
        _ob("2026-10-01T09:00:00Z", "257000002"),
    ]
    patterns = convergence_patterns(same_scan)
    assert len(patterns) == 1
    assert "same SAR pass" in patterns[0].observed
