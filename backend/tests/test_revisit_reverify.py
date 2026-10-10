"""Adversarial revisit tests: source scene identity, UTC time, and bounded windows."""

from datetime import UTC, datetime, timedelta, timezone

from darkfleet.revisit import Acquisition, acquisitions_from_items, plan_revisit, window_for


def _acq(item_id: str, when: datetime, *, collection: str = "sentinel-1-rtc") -> Acquisition:
    return Acquisition(
        item_id=item_id, acquisition_time=when, platform="sentinel-1a",
        collection=collection, polarizations=("VV",),
    )


def test_dedup_scene_id_across_provider_repetitions_and_offset_variants() -> None:
    t0 = datetime(2026, 10, 1, 12, tzinfo=UTC)
    same_scene = _acq("scene-a", t0.astimezone(timezone(timedelta(hours=5, minutes=30))))
    plan = plan_revisit([_acq("scene-a", t0), same_scene])
    assert plan.count == 1
    assert plan.statistics()["median_revisit_days"] is None


def test_distinct_scenes_with_exact_same_acquisition_time_are_preserved_without_zero_revisit() -> None:
    t0 = datetime(2026, 10, 1, 12, tzinfo=UTC)
    plan = plan_revisit([_acq("scene-a", t0), _acq("scene-b", t0)])
    assert {a.item_id for a in plan.acquisitions} == {"scene-a", "scene-b"}
    assert plan.count == 2
    assert plan.statistics()["median_revisit_days"] is None
    assert not plan.gaps


def test_window_bounds_actually_filter_acquisitions_including_edges() -> None:
    t0 = datetime(2026, 10, 1, 12, tzinfo=UTC)
    plan = plan_revisit(
        [_acq("before", t0 - timedelta(seconds=1)), _acq("start", t0),
         _acq("end", t0 + timedelta(days=1)), _acq("after", t0 + timedelta(days=1, seconds=1))],
        window_start=t0, window_end=t0 + timedelta(days=1),
    )
    assert [a.item_id for a in plan.acquisitions] == ["start", "end"]
    assert plan.statistics()["interior_gap_count"] == 1
    assert plan.gaps[0].days == 1.0


def test_plan_handles_naive_and_offset_timestamps_in_one_result() -> None:
    t0 = datetime(2026, 10, 1, 12, tzinfo=UTC)
    next_day = (t0 + timedelta(days=1)).astimezone(timezone(timedelta(hours=-4)))
    plan = plan_revisit([_acq("b", next_day), _acq("a", t0.replace(tzinfo=None))])
    assert [a.item_id for a in plan.acquisitions] == ["a", "b"]
    assert plan.gaps[0].days == 1
    assert plan.next_after(t0.replace(tzinfo=None)).item_id == "b"


def test_window_for_offset_timezone_reports_actual_utc_bounds() -> None:
    local = datetime(2026, 10, 1, 17, 30, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    start, end = window_for(local, history_days=1, horizon_days=1)
    assert (start, end) == ("2026-09-30T12:00:00Z", "2026-10-02T12:00:00Z")


def test_parses_collection_and_does_not_invent_polarization_from_missing_assets() -> None:
    items = [{
        "id": "scene-a", "collection": "sentinel-1-rtc",
        "properties": {"datetime": "2026-10-01T12:00:00Z", "platform": "sentinel-1a"},
        "assets": {"visual": {}},
    }]
    parsed = acquisitions_from_items(items)
    assert len(parsed) == 1
    assert parsed[0].collection == "sentinel-1-rtc"
    assert parsed[0].polarizations == ()


def test_duplicate_scene_merges_known_polarizations_without_inventing_other_channels() -> None:
    t0 = datetime(2026, 10, 1, 12, tzinfo=UTC)
    scene_vv = _acq("scene-a", t0)
    scene_vh = Acquisition(
        item_id="scene-a", acquisition_time=t0, platform="sentinel-1a",
        collection="sentinel-1-rtc", polarizations=("VH",),
    )
    plan = plan_revisit([scene_vh, scene_vv])
    assert plan.count == 1
    assert set(plan.acquisitions[0].polarizations) == {"VV", "VH"}
