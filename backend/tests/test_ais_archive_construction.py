"""DF-X9.8B: constructing an AisArchive for a READ must not ingest the archive.

The eager-index defect was measured, not assumed. On a 50,000-observation archive:

    /api/scans/{id}/ais   121.6 s
    /api/ais/coverage     no answer inside 180 s
    construction alone    0.98 - 4.89 s per call, serialised across the threadpool
    the query + delivery it waited on: 0.36 s + 0.36 s in process

Because ``routes._archive_for`` builds a fresh archive per request, a read-only endpoint was
paying a full-archive ingest and discarding the result.

These tests pin BOTH halves of the fix, because the fast path is worthless if it silently
loses restart-dedup:

  1. Construction does not read parquet at all (measured, not asserted on a comment).
  2. Dedup still survives a NEW instance over the same directory, which is the only reason
     the index exists -- see ``test_archive_roundtrip_dedup_query_restart``.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from darkfleet.ais.archive import _SCHEMA, AisArchive

T0 = datetime(2026, 5, 12, 8, 0, tzinfo=UTC)


def _write_archive(root: Path, *, vessels: int, fixes: int) -> None:
    """A real parquet part on disk, built through the same schema the product writes."""
    rows: list[dict[str, object]] = []
    for v in range(vessels):
        mmsi = f"{257000000 + v:09d}"
        for i in range(fixes):
            rows.append(
                {
                    "timestamp": T0 + timedelta(seconds=240 * i),
                    "mmsi": mmsi,
                    "lat": 1.0 + v * 1e-4 + i * 1e-5,
                    "lon": 103.0 + v * 1e-4 + i * 1e-5,
                    "sog": 10.0,
                    "cog": 45.0,
                    "heading": 45.0,
                    "nav_status": None,
                    "name": f"MV {v}",
                    "callsign": None,
                    "imo": None,
                    "ship_type": None,
                    "length_m": None,
                    "width_m": None,
                    "source": "aistream",
                }
            )
    part = root / "ais" / "2026" / "05" / "12" / "part-aistream.parquet"
    part.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=_SCHEMA), part)


def test_construction_reads_no_parquet(tmp_path: Path) -> None:
    """Construction must not open a part file. This is the regression the fix exists for."""
    _write_archive(tmp_path, vessels=2_000, fixes=5)  # 10,000 observations

    opened: list[str] = []
    real_read_table = pq.read_table

    def spy(path, *args, **kwargs):
        opened.append(str(path))
        return real_read_table(path, *args, **kwargs)

    pq.read_table = spy  # type: ignore[assignment]
    try:
        AisArchive(tmp_path)
        assert opened == [], f"construction read parquet: {opened}"
    finally:
        pq.read_table = real_read_table  # type: ignore[assignment]


def test_reads_are_fast_because_construction_is(tmp_path: Path) -> None:
    """A measured bound, generous enough not to be a flaky CI failure but far below the defect."""
    _write_archive(tmp_path, vessels=2_000, fixes=5)

    started = time.perf_counter()
    archive = AisArchive(tmp_path)
    construct_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    archive.coverage()
    coverage_ms = (time.perf_counter() - started) * 1000

    # The defect was 0.98-4.89 s per construction. Anything near a second is the bug returning.
    assert construct_ms < 250, f"construction took {construct_ms:.0f}ms; the eager index is back"
    assert coverage_ms < 2000, f"coverage took {coverage_ms:.0f}ms"


def test_restart_dedup_still_works_across_instances(tmp_path: Path) -> None:
    """The lazy index must still be built from what is on disk before the first append."""
    from darkfleet.ais.models import AisObservation

    rows = [
        AisObservation(
            timestamp=T0,
            mmsi="257000001",
            lat=1.0,
            lon=103.0,
            source="aistream",
        )
    ]

    first = AisArchive(tmp_path)
    assert first.append(rows) == {"written": 1, "duplicates": 0}
    # Same instance, second call.
    assert first.append(rows) == {"written": 0, "duplicates": 1}

    # A brand new instance over the same directory -- the restart case the index exists for.
    restarted = AisArchive(tmp_path)
    assert restarted._seen_cache is None, "index must not be built by construction"
    assert restarted.append(rows) == {"written": 0, "duplicates": 1}

    got = restarted.query(T0 - timedelta(hours=1), T0 + timedelta(hours=1))
    assert len(got) == 1


def test_corrupt_part_is_tolerated_by_the_index_but_not_by_reads(tmp_path: Path) -> None:
    """Documents a real, PRE-EXISTING asymmetry. Not a regression from the lazy index.

    The dedup index guards its own parquet reads (``except OSError/ValueError/KeyError``) and
    skips an unreadable part with a warning. The READ paths do not: ``coverage()`` and
    ``query()`` hand the file list straight to DuckDB ``read_parquet``, which raises
    ``InvalidInputException`` on a truncated part.

    So a corrupt part today means: append still works, reads raise. This test pins that actual
    behaviour rather than the behaviour one might assume, and leaves the gap visible.
    """

    _write_archive(tmp_path, vessels=1, fixes=1)
    corrupt = tmp_path / "ais" / "2026" / "05" / "12" / "part-corrupt.parquet"
    corrupt.write_bytes(b"not a parquet file at all")

    archive = AisArchive(tmp_path)

    # The index tolerates it: construction is lazy, and building the index skips the bad part.
    index = archive._seen_index()
    assert any(key.startswith("257000000") for key in index), "good part must still be indexed"

    # Reads do not tolerate it. Asserted as the current contract, not desired behaviour.
    with pytest.raises(Exception):  # noqa: B017 - DuckDB's exact type is not the subject here
        archive.coverage()