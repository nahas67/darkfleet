"""Live proof: SAR acquisition planning against the real provider catalogue.

Not part of the default suite (it needs the network). Run explicitly:

    & ".venv\\Scripts\\python.exe" -m pytest tests/test_revisit_live.py -q -m live
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from darkfleet.providers import RealDataUnavailableError
from darkfleet.providers.stac import stac_items
from darkfleet.revisit import acquisitions_from_items, plan_revisit, window_for

pytestmark = pytest.mark.live

# The Malacca / Singapore Strait AOI the live REAL scans use.
BBOX = (103.80, 1.24, 103.86, 1.28)
PC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
COLLECTION = "sentinel-1-rtc"


def _pc_items() -> list[dict]:
    start, end = window_for(datetime.now(UTC), history_days=150, horizon_days=21)
    return stac_items(PC_URL, COLLECTION, BBOX, f"{start}/{end}", limit=200)


def test_provider_really_is_reachable() -> None:
    try:
        items = _pc_items()
    except RealDataUnavailableError as exc:
        pytest.fail(f"provider unreachable, cannot prove the feature: {exc}")
    assert isinstance(items, list)


def test_real_catalogue_yields_a_measured_revisit_plan() -> None:
    try:
        items = _pc_items()
    except RealDataUnavailableError as exc:
        pytest.skip(f"provider unavailable: {exc}")

    acqs = acquisitions_from_items(items)
    assert acqs, "the live catalogue must return real acquisitions for this AOI"

    plan = plan_revisit(acqs)
    stats = plan.statistics()

    # Every reported acquisition is real, with a real Sentinel-1 item id.
    for a in plan.acquisitions:
        assert a.item_id.startswith("S1")
        assert "IW_GRDH" in a.item_id

    assert plan.count >= 3, f"expected several passes, got {plan.count}"
    assert stats["interior_gap_count"] == plan.count - 1
    assert stats["median_revisit_days"] is not None
    assert stats["min_revisit_days"] is not None
    assert stats["max_revisit_days"] is not None
    assert stats["platform_count"] >= 1
    assert plan.limitations, "statistics must always travel with their bounds"

    print("\n--- measured SAR acquisition plan (live) ---")
    print(f"  acquisitions : {plan.count}")
    print(f"  platforms    : {stats['acquisitions_per_platform']}")
    print(f"  median gap   : {stats['median_revisit_days']} d")
    print(f"  min / max    : {stats['min_revisit_days']} / {stats['max_revisit_days']} d")
    print(f"  flagged gaps : {stats['flagged_gap_count']}")
    for g in plan.gaps:
        flag = "  <-- LONGER THAN NOMINAL" if g.exceeds_nominal else ""
        print(f"    {g.start.date()} -> {g.end.date()}  {g.days:6.2f} d{flag}")
    print(json.dumps(plan.to_dict()["limitations"], indent=2))


def test_the_measured_repeat_is_physically_plausible() -> None:
    """Sanity bound on real data: no measured gap may be hours.

    A sub-hour interval would mean duplicate items or a catalogue quirk, and it
    would be visible to an operator as a false 'instant revisit'.
    """
    try:
        items = _pc_items()
    except RealDataUnavailableError:
        pytest.skip("provider unavailable")
    plan = plan_revisit(acquisitions_from_items(items))
    for gap in plan.gaps:
        assert gap.days > 0.05, f"implausibly short interval {gap.days:.4f} d"
        assert gap.days < 400, f"implausibly long interval {gap.days:.1f} d"