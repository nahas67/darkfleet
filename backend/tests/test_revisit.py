"""SAR acquisition planning (GEO-002).

Every statistic here is measured from real catalogue entries. The tests use real
Sentinel-1 item ids and timestamps taken from a live Planetary Computer query, so
a fixture change cannot make the expected numbers drift away from reality.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from darkfleet.revisit import (
    GAP_FLAG_FACTOR,
    NOMINAL_REPEAT_DAYS,
    Acquisition,
    acquisitions_from_items,
    plan_revisit,
    window_for,
)

# Real acquisitions over the Singapore Strait, as returned by Planetary Computer
# sentinel-1-rtc. The 12-day repeat and the two-satellite pairing are the real
# constellation behaviour for this orbit.
REAL_ITEM_IDS = [
    "S1D_IW_GRDH_1SDV_20260903T112445_20260903T112510_004762_008EC4_rtc",
    "S1D_IW_GRDH_1SDV_20260904T224720_20260904T224745_004762_008EC5_rtc",
    "S1D_IW_GRDH_1SDV_20260915T112445_20260915T112510_004762_008EC6_rtc",
    "S1D_IW_GRDH_1SDV_20260916T224721_20260916T224746_004762_008EC7_rtc",
    "S1D_IW_GRDH_1SDV_20260927T112445_20260927T112510_004762_008EC8_rtc",
]
REAL_TIMES = [
    "2026-09-03T11:24:57.508922Z",
    "2026-09-04T22:47:32.989268Z",
    "2026-09-15T11:24:58.143217Z",
    "2026-09-16T22:47:33.583752Z",
    "2026-09-27T11:24:58.180786Z",
]


def _acq(i: int, platform: str = "sentinel-1d") -> Acquisition:
    return Acquisition(
        item_id=REAL_ITEM_IDS[i],
        acquisition_time=datetime.fromisoformat(REAL_TIMES[i]),
        platform=platform,
        collection="sentinel-1-rtc",
        polarizations=("VH", "VV"),
    )


def _all() -> list[Acquisition]:
    return [_acq(i) for i in range(len(REAL_TIMES))]


# ------------------------------------------------------------- parsing


def test_acquisitions_parse_from_real_stac_items() -> None:
    items = [
        {
            "id": REAL_ITEM_IDS[i],
            "properties": {"datetime": REAL_TIMES[i], "platform": "sentinel-1d"},
            "assets": {"vv": {"href": "x"}, "vh": {"href": "y"}},
        }
        for i in range(len(REAL_TIMES))
    ]
    acqs = acquisitions_from_items(items)
    assert len(acqs) == 5
    assert acqs[0].item_id == REAL_ITEM_IDS[0]
    assert acqs[0].platform == "sentinel-1d"
    assert acqs[0].polarizations == ("VH", "VV")


def test_items_without_a_timestamp_are_skipped_not_guessed() -> None:
    items = [
        {"id": "a", "properties": {}, "assets": {}},
        {"id": "b", "properties": {"datetime": "not-a-date"}, "assets": {}},
        {"id": "", "properties": {"datetime": REAL_TIMES[0]}, "assets": {}},
        {
            "id": "good",
            "properties": {"datetime": REAL_TIMES[0]},
            "assets": {"vv": {}},
        },
    ]
    acqs = acquisitions_from_items(items)
    assert [a.item_id for a in acqs] == ["good"]


def test_item_without_polarization_is_still_reported() -> None:
    """Missing polarisation is unknown, not absent."""
    acqs = acquisitions_from_items(
        [{"id": "x", "properties": {"datetime": REAL_TIMES[0]}, "assets": {}}]
    )
    assert acqs[0].polarizations == ()


# ------------------------------------------------------------- planning


def test_plan_measures_the_real_12_day_repeat() -> None:
    plan = plan_revisit(_all())
    stats = plan.statistics()
    assert plan.count == 5
    # 4 interior intervals: ~1.47 d, ~10.5 d, ~1.47 d, ~10.5 d
    assert stats["interior_gap_count"] == 4
    assert stats["min_revisit_days"] == pytest.approx(1.47, abs=0.05)
    assert stats["max_revisit_days"] == pytest.approx(10.53, abs=0.05)
    assert stats["median_revisit_days"] is not None
    assert stats["nominal_repeat_days"] == NOMINAL_REPEAT_DAYS


def test_acquisitions_are_returned_in_time_order() -> None:
    shuffled = [_acq(i) for i in (3, 0, 4, 1, 2)]
    plan = plan_revisit(shuffled)
    times = [a.acquisition_time for a in plan.acquisitions]
    assert times == sorted(times)


def test_duplicate_timestamps_collapse_to_one_pass() -> None:
    """A revisit is a pass, not an asset: VV and VH of one scene is one pass."""
    duplicated = _all() + [_acq(0)]
    plan = plan_revisit(duplicated)
    assert plan.count == 5, "the duplicate pass must not be counted twice"


def test_next_after_returns_the_next_real_pass() -> None:
    plan = plan_revisit(_all())
    before = datetime(2026, 9, 10, tzinfo=UTC)
    nxt = plan.next_after(before)
    assert nxt is not None
    assert nxt.acquisition_time == datetime.fromisoformat(REAL_TIMES[2])
    assert plan.last_before(before) is not None
    assert plan.last_before(before).acquisition_time < before


def test_next_after_is_none_when_the_window_is_exhausted() -> None:
    plan = plan_revisit(_all())
    assert plan.next_after(datetime(2030, 1, 1, tzinfo=UTC)) is None


def test_a_real_coverage_hole_is_flagged() -> None:
    """A 40-day hole must be visible, not smoothed away by the nominal cycle."""
    times = [
        datetime(2026, 1, 1, tzinfo=UTC),
        datetime(2026, 1, 13, tzinfo=UTC),
        datetime(2026, 3, 1, tzinfo=UTC),  # ~47 day hole
    ]
    acqs = [
        Acquisition(
            item_id=f"S1X_{i}",
            acquisition_time=t,
            platform="sentinel-1a",
            collection="sentinel-1-rtc",
            polarizations=("VV",),
        )
        for i, t in enumerate(times)
    ]
    plan = plan_revisit(acqs)
    flagged = [g for g in plan.gaps if g.exceeds_nominal]
    assert len(flagged) == 1
    assert flagged[0].days == pytest.approx(47.0, abs=0.1)
    assert flagged[0].days > NOMINAL_REPEAT_DAYS * GAP_FLAG_FACTOR
    assert plan.statistics()["flagged_gap_count"] == 1


# ------------------------------------------------------- honesty guarantees


def test_single_acquisition_reports_insufficient_data_not_a_number() -> None:
    plan = plan_revisit([_acq(0)])
    stats = plan.statistics()
    assert stats["median_revisit_days"] is None, "one pass cannot yield a revisit"
    assert stats["min_revisit_days"] is None
    assert stats["max_revisit_days"] is None
    assert any("single acquisition" in lim.lower() for lim in plan.limitations)


def test_empty_window_says_nothing_rather_than_claiming_no_coverage() -> None:
    plan = plan_revisit([])
    assert plan.count == 0
    stats = plan.statistics()
    assert stats["median_revisit_days"] is None
    assert stats["interior_gap_count"] == 0
    assert any("nothing about whether" in lim for lim in plan.limitations)


def test_limitations_always_bound_the_statistics() -> None:
    """The window that produced the numbers must travel with them."""
    plan = plan_revisit(_all(), window_start=datetime(2026, 9, 1, tzinfo=UTC),
                        window_end=datetime(2026, 10, 1, tzinfo=UTC))
    body = plan.to_dict()
    assert body["window"]["start"].startswith("2026-09-01")
    assert body["window"]["end"].startswith("2026-10-01")
    assert body["limitations"], "statistics must never be quotable without their bounds"


def test_nominal_repeat_never_invents_an_acquisition() -> None:
    """The nominal cycle flags gaps; it must never create passes."""
    plan = plan_revisit([_acq(0), _acq(4)])
    assert plan.count == 2, "the planner reports acquisitions, never predicts them"


def test_platform_breakdown_is_reported() -> None:
    mixed = [_acq(0, "sentinel-1a"), _acq(2, "sentinel-1b"), _acq(4, "sentinel-1a")]
    stats = plan_revisit(mixed).statistics()
    assert stats["platform_count"] == 2
    assert stats["acquisitions_per_platform"] == {"sentinel-1a": 2, "sentinel-1b": 1}


# ------------------------------------------------------------------ window


def test_window_covers_history_and_a_short_horizon() -> None:
    now = datetime(2026, 10, 1, tzinfo=UTC)
    start, end = window_for(now, history_days=90, horizon_days=30)
    assert start == "2026-07-03T00:00:00Z"
    assert end == "2026-10-31T00:00:00Z"
    parsed_start = datetime.fromisoformat(start)
    parsed_end = datetime.fromisoformat(end)
    assert parsed_start < now < parsed_end


def test_window_spans_more_history_than_horizon() -> None:
    """A catalogue rarely holds future passes, so history carries the signal."""
    start, end = window_for(datetime(2026, 10, 1, tzinfo=UTC), history_days=90, horizon_days=14)
    s = datetime.fromisoformat(start)
    e = datetime.fromisoformat(end)
    assert (e - s).days > 90
