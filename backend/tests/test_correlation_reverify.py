"""Association rejection must never report a negative shortfall."""

from darkfleet.correlation.match import correlate


def _comp(lat: float = 1.0, lon: float = 103.0) -> dict:
    return {
        "lat": lat, "lon": lon, "major": 12.0, "minor": 3.0,
        "area": 30.0, "maxDb": -6.0, "meanDb": -14.0,
        "clutterMeanDb": -22.0, "orient": 0.0, "wake": False,
    }


def test_strong_candidate_claimed_elsewhere_has_nonnegative_rejection_shortfall() -> None:
    # A single AIS fix cannot be assigned to both nearby SAR detections.
    ais = [{
        "timestamp": "2026-10-01T12:00:00Z", "mmsi": "257000001",
        "lat": 1.0, "lon": 103.0, "sog": 0.0, "cog": 0.0,
    }]
    out = correlate([_comp(), _comp()], ais, "2026-10-01T12:00:00Z", 10.0, "SCAN")
    assert sum(bool(t["corr"]["matched"]) for t in out["targets"]) == 1
    unassigned = next(t for t in out["targets"] if not t["corr"]["matched"])
    rejected = unassigned["corr"]["closestRejected"]
    assert rejected is not None
    assert rejected["shortfall"] == 0
    assert rejected["rejectionReason"] == "ONE_TO_ONE_CONFLICT"
    assert "assigned to another" in unassigned["assessment"]


def test_accepted_match_carries_rejected_alternate_and_explains_rejection() -> None:
    ais = [
        {"timestamp": "2026-10-01T12:00:00Z", "mmsi": "257000001",
         "lat": 1.0, "lon": 103.0, "sog": 0.0, "cog": 0.0},
        {"timestamp": "2026-10-01T12:00:00Z", "mmsi": "257000002",
         "lat": 1.0, "lon": 103.007, "sog": 0.0, "cog": 0.0},
    ]
    out = correlate([_comp()], ais, "2026-10-01T12:00:00Z", 10.0, "SCAN")
    target = out["targets"][0]
    assert target["corr"]["matched"]
    other = target["corr"]["closestRejected"]
    assert other is not None
    assert other["mmsi"] == "257000002"
    assert other["rejectionReason"] == "LOWER_RANKED_ALTERNATIVE"
