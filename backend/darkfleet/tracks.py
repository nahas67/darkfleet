"""Multi-pass track hypotheses (ADV-001..003).

Associations across passes become HYPOTHESES with explicit uncertainty. A track
is never asserted to be the same vessel on geometry alone — identity strength
is reported, and a multi-pass association never claims confirmed identity.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from itertools import pairwise
from typing import Any

from pyproj import Geod

_GEO = Geod(ellps="WGS84")

# Two passes are only worth linking when the implied speed is plausible for a
# surface vessel. Beyond this the "track" is coincidence, so we refuse it.
MAX_PLAUSIBLE_SPEED_KN = 60.0
KNOTS_TO_MPS = 0.514444444


def _t(value: str) -> datetime:
    """Parse an ISO-8601 instant, assuming UTC when no offset is given."""
    dt = datetime.fromisoformat(str(value))
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _distance_m(a: TrackPoint, b: TrackPoint) -> float:
    """WGS84 geodesic separation in metres (pyproj returns Any)."""
    _az1, _az2, dist_m = _GEO.inv(a.lon, a.lat, b.lon, b.lat)
    return float(dist_m)


def _knots(a: TrackPoint, b: TrackPoint) -> float | None:
    """Implied speed in knots, or None when the interval is not positive."""
    seconds = (_t(b.acquisition_time) - _t(a.acquisition_time)).total_seconds()
    if seconds <= 0:
        return None
    return _distance_m(a, b) / seconds / KNOTS_TO_MPS


@dataclass
class TrackPoint:
    scan_id: str
    item_id: str
    acquisition_time: str
    lat: float
    lon: float
    sar_conf: float
    classification: str
    apparent_length_m: float | None
    length_unc_m: float | None


@dataclass
class Gap:
    seconds: float
    implied_speed_knots: float | None
    plausible: bool
    note: str


@dataclass
class TrackHypothesis:
    track_id: str
    points: list[TrackPoint]
    gaps: list[Gap] = field(default_factory=list)
    supporting_evidence: list[str] = field(default_factory=list)
    contradicting_evidence: list[str] = field(default_factory=list)
    identity_strength: float = 0.0
    confidence_statement: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _identity_strength(pairs: list[float]) -> float:
    """Weak evidence model: mean association confidence, damped by count.

    Deliberately conservative — geometry alone must not reach high identity
    strength, so the score is capped and grows only slowly with more passes.
    """
    if not pairs:
        return 0.0
    mean_conf = sum(pairs) / len(pairs)
    # Saturating in the number of passes; 4 independent passes is strong.
    count_factor = min(1.0, len(pairs) / 4.0)
    return round(min(0.85, mean_conf * count_factor * 0.7), 3)


def build_tracks(
    observations: list[dict[str, Any]],
    *,
    max_gap_hours: float = 48.0,
) -> list[TrackHypothesis]:
    """Link detections into track hypotheses from their AIS association.

    Each input observation is one detection with `correlated_mmsi` set (or null).
    Only AIS-ASSOCIATED detections are linked: an unmatched detection is not
    evidence of a track, and linking them would manufacture continuity.
    """
    by_mmsi: dict[str, list[dict[str, Any]]] = {}
    for obs in observations:
        mmsi = obs.get("correlated_mmsi")
        if not mmsi:
            continue
        by_mmsi.setdefault(str(mmsi), []).append(obs)

    tracks: list[TrackHypothesis] = []
    for index, (mmsi, group) in enumerate(sorted(by_mmsi.items()), start=1):
        # Offsets make ISO strings lexically nonchronological; geodesic speed
        # and cross-pass assertions must use actual instants.
        group.sort(key=lambda o: _t(str(o["acquisition_time"])))
        points = [
            TrackPoint(
                scan_id=str(o.get("scan_id", "")),
                item_id=str(o.get("item_id", "")),
                acquisition_time=str(o["acquisition_time"]),
                lat=float(o["lat"]),
                lon=float(o["lon"]),
                sar_conf=float(o.get("sar_conf", 0.0)),
                classification=str(o.get("classification", "")),
                apparent_length_m=(
                    float(o["apparent_length_m"]) if o.get("apparent_length_m") is not None else None
                ),
                length_unc_m=(
                    float(o["length_unc_m"]) if o.get("length_unc_m") is not None else None
                ),
            )
            for o in group
        ]
        gaps: list[Gap] = []
        for a, b in pairwise(points):
            seconds = (_t(b.acquisition_time) - _t(a.acquisition_time)).total_seconds()
            dist_m = _distance_m(a, b)
            speed = _knots(a, b)
            # A non-positive interval is a data problem, not an implausible
            # vessel. Saying "too fast" there would be a fabricated finding.
            measurable = seconds > 0
            plausible = measurable and speed is not None and speed <= MAX_PLAUSIBLE_SPEED_KN
            note = (
                f"{seconds / 3600:.1f} h between passes, {dist_m / 1000:.1f} km apart"
                + (f", implying {speed:.1f} kn" if measurable and speed is not None else "")
            )
            if not measurable:
                note += " — acquisition times do not increase, so no speed is implied"
            elif not plausible:
                note += " — exceeds plausible surface speed"
            gaps.append(
                Gap(
                    seconds=seconds,
                    implied_speed_knots=(
                        round(speed, 2) if measurable and speed is not None else None
                    ),
                    plausible=plausible,
                    note=note,
                )
            )
            if seconds > max_gap_hours * 3600:
                gaps[-1].note += " (beyond linkage window)"

        evidence = [f"AIS association MMSI {mmsi} on {len(points)} pass(es)"]
        contradictions = [g.note for g in gaps if not g.plausible]
        strength = _identity_strength([p.sar_conf for p in points])
        tracks.append(
            TrackHypothesis(
                track_id=f"TRK-{index:03d}",
                points=points,
                gaps=gaps,
                supporting_evidence=evidence,
                contradicting_evidence=contradictions,
                identity_strength=strength,
                confidence_statement=_statement(strength, len(points)),
            )
        )
    return tracks


def _statement(strength: float, passes: int) -> str:
    if passes < 2:
        return "Single pass; no cross-pass association is possible."
    band = "consistent" if strength >= 0.4 else "weak"
    return (
        f"{passes} passes {band} with a repeating AIS association. "
        "This is a track HYPOTHESIS based on reported identity, not on "
        "geometry alone; vessel identity is not confirmed by DarkFleet."
    )


def track_speed_knots(a: TrackPoint, b: TrackPoint) -> float | None:
    """Implied speed between two track points, in knots."""
    return _knots(a, b)


def geodesic_km(a: TrackPoint, b: TrackPoint) -> float:
    return _distance_m(a, b) / 1000.0
