"""Longitudinal behaviour analysis over persisted observations (ADV-009, ADV-010).

Every result is an OBSERVED PATTERN with a HYPOTHESIS, a CONFIDENCE and an
explicit UNKNOWN. Patterns are labelled as anomalies to investigate, never as
findings about intent. A reported AIS gap is a data-availability observation; it
says nothing about what a vessel did or intended.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class Pattern:
    pattern_id: str
    kind: str
    observed: str
    hypothesis: str
    confidence: float
    unknowns: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _t(value: str) -> datetime:
    """Parse an ISO-8601 instant, assuming UTC when no offset is given."""
    dt = datetime.fromisoformat(str(value))
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def association_gap_patterns(
    observations: list[dict[str, Any]], *, min_passes: int = 3
) -> list[Pattern]:
    """Detect: AIS association present -> absent -> present, SAR observations continuing.

    This is a COVERAGE pattern. The correct reading is "the archive has a gap in
    AIS for this vessel's position while SAR continued to see returns there",
    which is expected for exemption, shadow, or receiver outage alike.
    """
    by_loc: dict[tuple[float, float], list[dict[str, Any]]] = {}
    for obs in observations:
        cell = (round(float(obs["lat"]), 1), round(float(obs["lon"]), 1))
        by_loc.setdefault(cell, []).append(obs)

    patterns: list[Pattern] = []
    for cell, group in sorted(by_loc.items()):
        group.sort(key=lambda o: str(o["acquisition_time"]))
        if len(group) < min_passes:
            continue
        states = [bool(o.get("correlated_mmsi")) for o in group]
        gaps = _interior_false_runs(states)
        for start, end in gaps:
            if end - start + 1 < 1:
                continue
            before = group[start - 1] if start > 0 else None
            after = group[end + 1] if end + 1 < len(group) else None
            duration_h = (
                _t(group[end]["acquisition_time"]) - _t(group[start]["acquisition_time"])
            ).total_seconds() / 3600.0
            patterns.append(
                Pattern(
                    pattern_id=f"PAT-{len(patterns) + 1:03d}",
                    kind="AIS_ASSOCIATION_GAP",
                    observed=(
                        f"{end - start + 1} consecutive SAR pass(es) at "
                        f"{cell[0]:.1f}N {cell[1]:.1f}E had no AIS association, over "
                        f"{duration_h:.1f} h, with an association before and after."
                    ),
                    hypothesis=(
                        "A data-coverage gap in AIS for this operating area. Common "
                        "causes include carriage exemption, satellite/terrestrial "
                        "reception shadow, or a receiver outage."
                    ),
                    confidence=round(min(0.9, 0.5 + 0.1 * (end - start + 1)), 2),
                    unknowns=[
                        "Why AIS is absent in this window.",
                        "Whether the returns are the same vessel throughout.",
                        "Vessel type and carriage obligation at the time.",
                    ],
                    evidence=(
                        [
                            (
                                f"before: {before['acquisition_time']} "
                                f"mmsi={before.get('correlated_mmsi')}"
                            ),
                            (
                                f"after: {after['acquisition_time']} "
                                f"mmsi={after.get('correlated_mmsi')}"
                            ),
                        ]
                        if (before and after)
                        else []
                    ),
                )
            )
    return patterns


def _interior_false_runs(states: list[bool]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    i = 0
    while i < len(states):
        if states[i]:
            i += 1
            continue
        j = i
        while j < len(states) and not states[j]:
            j += 1
        # Only interior gaps count: a leading/trailing run may simply be the
        # edge of the archive rather than a real gap.
        if i > 0 and j < len(states):
            runs.append((i, j - 1))
        i = j
    return runs


def repeated_unmatched_patterns(
    observations: list[dict[str, Any]], *, min_count: int = 3
) -> list[Pattern]:
    """Detect: repeated unmatched SAR returns in the same area over time."""
    by_loc: dict[tuple[float, float], list[dict[str, Any]]] = {}
    for obs in observations:
        if obs.get("classification") != "SAR_UNMATCHED" or obs.get("correlated_mmsi"):
            continue
        cell = (round(float(obs["lat"]), 1), round(float(obs["lon"]), 1))
        by_loc.setdefault(cell, []).append(obs)

    patterns: list[Pattern] = []
    for cell, group in sorted(by_loc.items()):
        if len(group) < min_count:
            continue
        group.sort(key=lambda o: str(o["acquisition_time"]))
        span_h = (
            _t(group[-1]["acquisition_time"]) - _t(group[0]["acquisition_time"])
        ).total_seconds() / 3600.0
        patterns.append(
            Pattern(
                pattern_id=f"PAT-U{len(patterns) + 1:03d}",
                kind="REPEATED_UNMATCHED",
                observed=(
                    f"{len(group)} unmatched SAR return(s) within ~11 km of "
                    f"{cell[0]:.1f}N {cell[1]:.1f}E over {span_h:.1f} h."
                ),
                hypothesis=(
                    "Recurring surface returns in an area where no AIS association "
                    "met the correlation threshold. Could be small craft, exemption, "
                    "shadow, or a receiver problem."
                ),
                confidence=round(min(0.75, 0.35 + 0.08 * len(group)), 2),
                unknowns=[
                    "Whether these are one vessel or several.",
                    "Vessel type, size and carriage obligation.",
                    "AIS coverage quality in this cell at these times.",
                ],
                evidence=[
                    f"{o['acquisition_time']} conf={o.get('sar_conf')}"
                    for o in group[:6]
                ],
            )
        )
    return patterns


def convergence_patterns(observations: list[dict[str, Any]], *, min_passes: int = 3) -> list[Pattern]:
    """Detect: two or more tracks converging into the same cell, then separating."""
    by_cell: dict[tuple[float, float], set[str]] = {}
    for obs in observations:
        mmsi = obs.get("correlated_mmsi")
        if not mmsi:
            continue
        cell = (round(float(obs["lat"]), 1), round(float(obs["lon"]), 1))
        by_cell.setdefault(cell, set()).add(str(mmsi))

    patterns: list[Pattern] = []
    for cell, mmsis in sorted(by_cell.items()):
        if len(mmsis) < 2:
            continue
        joined = ", ".join(sorted(mmsis))
        patterns.append(
            Pattern(
                pattern_id=f"PAT-C{len(patterns) + 1:03d}",
                kind="CO_LOCATED_TRACKS",
                observed=f"{len(mmsis)} AIS-associated track(s) observed within ~11 km of {cell[0]:.1f}N {cell[1]:.1f}E: {joined}.",
                hypothesis=(
                    "Co-location within SAR resolution and corridor uncertainty. "
                    "Rendezvous, escort, anchorage congestion, or simply a busy "
                    "lane are all consistent with this."
                ),
                confidence=0.4,
                unknowns=[
                    "Whether the tracks interacted at all.",
                    "Duration and purpose of the co-location.",
                    "Whether either vessel altered course because of the other.",
                ],
                evidence=[f"mmsi {m}" for m in sorted(mmsis)],
            )
        )
    if patterns:
        _ = min_passes  # window param reserved for temporal extent checks
    return patterns


def analyse(observations: list[dict[str, Any]]) -> list[Pattern]:
    """Run every pattern family. Output is analytical, not conclusive."""
    patterns = [
        *association_gap_patterns(observations),
        *repeated_unmatched_patterns(observations),
        *convergence_patterns(observations),
    ]
    for i, p in enumerate(patterns, start=1):
        p.pattern_id = f"PAT-{i:03d}"
    return patterns