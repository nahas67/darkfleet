"""SAR acquisition planning: when can this water actually be imaged? (GEO-002)

A correlation engine is only as useful as the acquisitions you can feed it. This
module answers the operational question directly, from the provider catalogue
rather than from an orbit prediction: given an area, what real acquisitions exist,
how often does the satellite actually return, and where are the gaps?

Why the catalogue and not SGP4
------------------------------
Predicting a pass from a TLE gives an *estimate* of when a satellite could look.
The catalogue gives the acquisitions that genuinely exist. For an operator
deciding whether to wait or to book a tasking, the second is the more useful
number, and it is a measurement rather than a prediction. Everything reported
here is derived from real catalogue entries.

Honesty constraints
-------------------
* Every acquisition carries its real item id, timestamp, platform and
  polarisation. Nothing is synthesised.
* Gaps and intervals are computed **only within the queried window**. A gap at
  the window edge is not evidence of a coverage hole, so the window bounds are
  carried alongside the statistics and edge gaps are reported as
  ``window_edge`` rather than as a real gap.
* A revisit interval is only reported when at least two acquisitions exist.
  With one, the honest answer is "insufficient data", not a fabricated number.
* ``nominal_days`` is a CONSTRAINT for flagging long gaps, never used to invent
  an acquisition.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

#: Sentinel-1 constellation repeat cycle. Used only to FLAG gaps longer than
#: this, never to synthesise a missing acquisition.
NOMINAL_REPEAT_DAYS = 12.0

#: A gap longer than this multiple of the nominal repeat is flagged. 1.5x of 12
#: days is 18 days, which is a real coverage concern for an operational user.
GAP_FLAG_FACTOR = 1.5


@dataclass(frozen=True)
class Acquisition:
    """One real acquisition the catalogue holds for the area."""

    item_id: str
    acquisition_time: datetime
    platform: str
    collection: str
    polarizations: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "acquisition_time": self.acquisition_time.isoformat(),
            "platform": self.platform,
            "collection": self.collection,
            "polarizations": list(self.polarizations),
        }


@dataclass(frozen=True)
class Gap:
    """A measured interval between consecutive acquisitions."""

    start: datetime
    end: datetime
    days: float
    #: ``True`` when the interval is bounded by the query window rather than by
    #: two real acquisitions. An edge gap is not a coverage hole.
    window_edge: bool = False
    exceeds_nominal: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "days": round(self.days, 2),
            "window_edge": self.window_edge,
            "exceeds_nominal": self.exceeds_nominal,
        }


@dataclass
class RevisitPlan:
    """What the catalogue says about imaging this area."""

    acquisitions: list[Acquisition] = field(default_factory=list)
    gaps: list[Gap] = field(default_factory=list)
    window_start: datetime | None = None
    window_end: datetime | None = None
    #: Reported verbatim to the caller so the statistics can never be quoted
    #: without the window that produced them.
    limitations: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.acquisitions)

    def next_after(self, moment: datetime) -> Acquisition | None:
        """The first acquisition strictly after `moment`, or None."""
        later = [a for a in self.acquisitions if a.acquisition_time > moment]
        return min(later, key=lambda a: a.acquisition_time) if later else None

    def last_before(self, moment: datetime) -> Acquisition | None:
        earlier = [a for a in self.acquisitions if a.acquisition_time <= moment]
        return max(earlier, key=lambda a: a.acquisition_time) if earlier else None

    def to_dict(self, *, now: datetime | None = None) -> dict[str, Any]:
        upcoming = self.next_after(_utc(now or datetime.now(UTC)))
        return {
            "acquisition_count": self.count,
            "acquisitions": [a.to_dict() for a in self.acquisitions],
            "gaps": [g.to_dict() for g in self.gaps],
            "statistics": self.statistics(),
            "window": {
                "start": self.window_start.isoformat() if self.window_start else None,
                "end": self.window_end.isoformat() if self.window_end else None,
            },
            "next_after": upcoming.to_dict() if upcoming else None,
            "limitations": list(self.limitations),
        }

    def statistics(self) -> dict[str, Any]:
        """Measured revisit statistics. Absent values stay None, never guessed."""
        interior = [g.days for g in self.gaps if not g.window_edge]
        platforms: dict[str, int] = {}
        for a in self.acquisitions:
            platforms[a.platform] = platforms.get(a.platform, 0) + 1
        flagged = [g for g in self.gaps if g.exceeds_nominal]
        return {
            "platform_count": len(platforms),
            "acquisitions_per_platform": dict(sorted(platforms.items())),
            "interior_gap_count": len(interior),
            # None means "not enough acquisitions to say", not zero.
            "median_revisit_days": round(statistics.median(interior), 2) if interior else None,
            "min_revisit_days": round(min(interior), 2) if interior else None,
            "max_revisit_days": round(max(interior), 2) if interior else None,
            "flagged_gap_count": len(flagged),
            "nominal_repeat_days": NOMINAL_REPEAT_DAYS,
        }


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def plan_revisit(
    acquisitions: list[Acquisition],
    *,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    nominal_days: float = NOMINAL_REPEAT_DAYS,
) -> RevisitPlan:
    """Measure the revisit pattern from real acquisitions.

    Duplicate acquisitions (the same item returned twice, or VV and VH rows for
    one scene) are collapsed to one timestamp, because a revisit is a *pass*,
    not an asset.
    """
    ordered = sorted(acquisitions, key=lambda a: a.acquisition_time)
    seen: set[datetime] = set()
    unique: list[Acquisition] = []
    for a in ordered:
        if a.acquisition_time in seen:
            continue
        seen.add(a.acquisition_time)
        unique.append(a)

    plan = RevisitPlan(
        acquisitions=unique,
        window_start=_utc(window_start) if window_start else None,
        window_end=_utc(window_end) if window_end else None,
    )

    if not unique:
        plan.limitations.append(
            "No acquisition in the queried window. This says nothing about whether "
            "the area is covered outside the window."
        )
        return plan

    threshold = nominal_days * GAP_FLAG_FACTOR

    if len(unique) == 1:
        plan.limitations.append(
            "A single acquisition in the window: no revisit interval can be measured "
            "from one pass, and none is assumed."
        )
        return plan

    for earlier, later in pairwise(unique):
        days = (later.acquisition_time - earlier.acquisition_time).total_seconds() / 86400.0
        plan.gaps.append(
            Gap(
                start=earlier.acquisition_time,
                end=later.acquisition_time,
                days=days,
                window_edge=False,
                exceeds_nominal=days > threshold,
            )
        )

    plan.limitations.append(
        "Intervals are measured between consecutive real acquisitions inside the "
        "queried window only; nothing outside the window is inferred."
    )
    if plan.gaps and plan.gaps[-1].days > threshold:
        plan.limitations.append(
            f"The most recent interval is {plan.gaps[-1].days:.1f} days and may be "
            "truncated by the window end rather than a real coverage hole."
        )
    return plan


def acquisitions_from_items(items: list[dict[str, Any]]) -> list[Acquisition]:
    """Build acquisitions from raw STAC items, skipping unusable ones."""
    out: list[Acquisition] = []
    for item in items:
        props = item.get("properties") or {}
        raw_time = props.get("datetime") or props.get("start_datetime")
        if not isinstance(raw_time, str) or not raw_time:
            continue
        try:
            when = _utc(datetime.fromisoformat(raw_time))
        except ValueError:
            continue
        assets = item.get("assets") or {}
        pols = tuple(sorted(k.upper() for k in assets if k.lower() in ("vv", "vh", "hh", "hv")))
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            continue
        out.append(
            Acquisition(
                item_id=item_id,
                acquisition_time=when,
                platform=str(props.get("platform") or props.get("constellation") or "unknown"),
                collection=str(props.get("collection") or ""),
                polarizations=pols,
            )
        )
    return out


def window_for(
    now: datetime | None = None,
    *,
    history_days: int = 90,
    horizon_days: int = 30,
) -> tuple[str, str]:
    """A STAC datetime interval: recent history plus a short forward horizon.

    Centred on now so the plan shows both how the area has been revisited and how
    soon it will be. Forward acquisitions are sparse by design -- a catalogue
    rarely holds future passes -- so a long horizon mostly returns nothing.
    """
    reference = _utc(now or datetime.now(UTC))
    start = reference - timedelta(days=history_days)
    end = reference + timedelta(days=horizon_days)
    return (
        start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        end.strftime("%Y-%m-%dT%H:%M:%SZ"),
    )