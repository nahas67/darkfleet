"""AIS ingest dedup must reflect committed data, including retry and restart."""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from darkfleet.ais.archive import AisArchive
from darkfleet.ais.models import AisObservation


def _ob(timestamp: datetime) -> AisObservation:
    return AisObservation(
        timestamp=timestamp, mmsi="257000001", lat=1.0, lon=103.0,
        source="file-import",
    )


def test_failed_write_is_retryable_in_same_instance(tmp_path, monkeypatch) -> None:
    from darkfleet.ais import archive as mod

    archive = AisArchive(tmp_path)
    row = _ob(datetime(2026, 10, 1, tzinfo=UTC))
    actual_write = mod.pq.write_table
    attempts = 0

    def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("disk temporarily unavailable")
        return actual_write(*args, **kwargs)

    monkeypatch.setattr(mod.pq, "write_table", fail_once)
    with pytest.raises(OSError, match="disk temporarily unavailable"):
        archive.append([row])
    assert archive.append([row]) == {"written": 1, "duplicates": 0}
    assert len(AisArchive(tmp_path).query(row.timestamp - timedelta(minutes=1), row.timestamp + timedelta(minutes=1))) == 1


def test_dedup_normalizes_naive_and_aware_equal_instants_across_restart(tmp_path) -> None:
    stamp = datetime(2026, 10, 1, 12, 0, tzinfo=UTC).replace(tzinfo=None)
    archive = AisArchive(tmp_path)
    assert archive.append([_ob(stamp)])["written"] == 1
    restarted = AisArchive(tmp_path)
    assert restarted.append([_ob(stamp.replace(tzinfo=UTC))]) == {
        "written": 0, "duplicates": 1
    }


def test_dedup_equal_instant_across_different_timezones_same_instance(tmp_path) -> None:
    archive = AisArchive(tmp_path)
    utc_stamp = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    other_zone = utc_stamp.astimezone(timezone(timedelta(hours=5, minutes=30)))
    assert archive.append([_ob(utc_stamp)])["written"] == 1
    assert archive.append([_ob(other_zone)]) == {"written": 0, "duplicates": 1}


def test_source_is_data_not_archive_path(tmp_path) -> None:
    source = "x/../../../../../escaped"
    row = _ob(datetime(2026, 10, 1, tzinfo=UTC)).model_copy(update={"source": source})
    archive = AisArchive(tmp_path)
    assert archive.append([row]) == {"written": 1, "duplicates": 0}
    parts = list(archive.root.rglob("part-*.parquet"))
    assert len(parts) == 1
    assert parts[0].parent == archive.root / "2026" / "10" / "01"
    assert not (tmp_path / "escaped.parquet").exists()
    assert archive.query(row.timestamp, row.timestamp)[0]["source"] == source
    assert AisArchive(tmp_path).append([row]) == {"written": 0, "duplicates": 1}


def test_regular_source_keeps_historical_partition_name(tmp_path) -> None:
    archive = AisArchive(tmp_path)
    row = _ob(datetime(2026, 10, 1, tzinfo=UTC))
    assert archive.append([row])["written"] == 1
    assert (archive.root / "2026" / "10" / "01" / "part-file-import.parquet").exists()


def test_failed_update_cannot_destroy_existing_part(tmp_path, monkeypatch) -> None:
    from darkfleet.ais import archive as mod

    archive = AisArchive(tmp_path)
    t0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    assert archive.append([_ob(t0)])["written"] == 1

    def corrupt_then_fail(table, path, **kwargs):
        # Reproduce a partial write; only an atomic temp-file publish protects
        # the previously committed partition from corruption.
        path.write_bytes(b"truncated parquet")
        raise OSError("write interrupted")

    monkeypatch.setattr(mod.pq, "write_table", corrupt_then_fail)
    with pytest.raises(OSError, match="write interrupted"):
        archive.append([_ob(t0 + timedelta(minutes=1))])
    assert AisArchive(tmp_path).query(t0, t0 + timedelta(minutes=1))[0]["mmsi"] == "257000001"
