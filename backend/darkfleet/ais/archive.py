"""Local AIS archive: Parquet partitions + DuckDB queries. (AIS-010..013)

Layout: <data_dir>/ais/YYYY/MM/DD/part-<source>.parquet
The archive is the authority; memory never is. Restart-safe by construction.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import threading
from datetime import datetime
from functools import wraps
from hashlib import sha256
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from .models import AisObservation

logger = logging.getLogger(__name__)

# Read and append calls usually construct separate AisArchive instances.
# Keep the lock at the root level so a Windows reader cannot retain an open
# Parquet handle while another thread tries to atomically replace that part.
# This coordinates processes' threads only; external writers require an
# interprocess lock and are not covered by this in-process guarantee.
_LOCK_REGISTRY_GUARD = threading.Lock()
_ROOT_LOCKS: dict[Path, threading.RLock] = {}
_ROOT_REVISIONS: dict[Path, int] = {}


def _root_lock(root: Path) -> threading.RLock:
    with _LOCK_REGISTRY_GUARD:
        if root not in _ROOT_LOCKS:
            _ROOT_LOCKS[root] = threading.RLock()
        return _ROOT_LOCKS[root]


def _synchronized(method: Any) -> Any:
    @wraps(method)
    def locked(self: AisArchive, *args: Any, **kwargs: Any) -> Any:
        with _root_lock(self._root_key):
            return method(self, *args, **kwargs)
    return locked

_SCHEMA = pa.schema(
    [
        ("timestamp", pa.timestamp("us", tz="UTC")),
        ("mmsi", pa.string()),
        ("lat", pa.float64()),
        ("lon", pa.float64()),
        ("sog", pa.float64()),
        ("cog", pa.float64()),
        ("heading", pa.float64()),
        ("nav_status", pa.string()),
        ("name", pa.string()),
        ("callsign", pa.string()),
        ("imo", pa.string()),
        ("ship_type", pa.string()),
        ("length_m", pa.float64()),
        ("width_m", pa.float64()),
        ("source", pa.string()),
    ]
)


def _connect_utc() -> Any:
    """A DuckDB connection whose session timezone is pinned to UTC.

    Parquet stores these timestamps as ``timestamp[us, tz=UTC]``, but DuckDB
    renders a ``TIMESTAMP WITH TIME ZONE`` in the SESSION timezone. Without this,
    the same archive read on two machines returns two different offsets for the
    same row -- observed returning ``17:30+05:30`` for an observation recorded at
    ``12:00Z``. The instant is preserved, so nothing is corrupted, but the
    serialised value stops being UTC and every downstream display shifts.

    Worse, range filters compare a tz-aware column against query parameters. If
    the session is not UTC, a bound built from a UTC datetime can silently
    exclude rows at the window edge -- a wrong answer rather than a wrong label.
    Pinning the session makes reads reproducible and keeps ``>= start`` meaning
    what it says.
    """
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    return con


def _part_path(root: Path, day: datetime, source: str) -> Path:
    # Source is provider metadata, not a filesystem path. Preserve common
    # historical names verbatim; use a deterministic safe name for arbitrary
    # external labels (including slashes, Unicode, and Windows separators).
    # Retain the original source in the Parquet column for provenance.
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", source):
        filename_source = source
    else:
        prefix = re.sub(r"[^A-Za-z0-9_-]", "_", source)[:24]
        filename_source = f"{prefix}-{sha256(source.encode('utf-8')).hexdigest()[:20]}"
    return root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / f"part-{filename_source}.parquet"


def _to_table(obs: list[AisObservation]) -> pa.Table:
    rows = [
        {
            "timestamp": o.timestamp,
            "mmsi": o.mmsi,
            "lat": o.lat,
            "lon": o.lon,
            "sog": o.sog,
            "cog": o.cog,
            "heading": o.heading,
            "nav_status": o.nav_status,
            "name": o.name,
            "callsign": o.callsign,
            "imo": o.imo,
            "ship_type": o.ship_type,
            "length_m": o.length_m,
            "width_m": o.width_m,
            "source": o.source,
        }
        for o in obs
    ]
    return pa.Table.from_pylist(rows, schema=_SCHEMA)


class AisArchive:
    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir) / "ais"
        self.root.mkdir(parents=True, exist_ok=True)
        self._root_key = self.root.resolve()
        # LAZY (DF-X9.8B). Built on first append(), never at construction. See _seen_index.
        self._seen_cache: set[str] | None = None
        self._indexed_revision: int | None = None

    def _seen_index(self) -> set[str]:
        """The mmsi|timestamp dedup index, built from what is ALREADY on disk.

        WHY THIS IS LAZY, AND WHY IT WAS NOT A COSMETIC CHANGE.

        The index used to be built eagerly in ``__init__``. Because every API request builds a
        fresh ``AisArchive`` (``routes._archive_for``), that meant **every request re-read every
        parquet part in full and materialised one Python string per observation** -- on paths
        that never append anything, so the result was discarded unread.

        Measured on a 50,000-observation archive (DF-X9.8B): ``/api/scans/{id}/ais`` took
        **121.6 s** and ``/api/ais/coverage`` did not answer inside **180 s**, while the query
        and serialisation it was waiting on cost 0.36 s + 0.36 s in process. Construction alone
        took 0.98-4.89 s per call and serialised across FastAPI's threadpool. A read-only
        endpoint was paying a full-archive ingest to answer a question about file metadata.

        Deferring the scan to the first ``append()`` keeps the behaviour this index exists for,
        which is restart-dedup: a NEW instance over the same directory must still reject rows it
        already holds (``test_archive_roundtrip_dedup_query_restart``). That test is the reason
        this is lazy and not removed -- and it still passes, because the index is built from the
        same files before the first append either way.
        """
        if self._seen_cache is None:
            seen: set[str] = set()
            for f in self.root.rglob("part-*.parquet"):
                try:
                    t = pq.read_table(f, columns=["mmsi", "timestamp"])
                    for mmsi, ts in zip(t.column("mmsi").to_pylist(), t.column("timestamp").to_pylist()):
                        seen.add(f"{mmsi}|{ts.isoformat()}")
                except (OSError, ValueError, KeyError) as exc:
                    logger.warning("skipping unreadable archive part %s: %s", f, exc)
                    continue
            self._seen_cache = seen
        return self._seen_cache

    @_synchronized
    def append(self, obs: list[AisObservation]) -> dict[str, int]:
        """Dedup by mmsi|timestamp; returns {written, duplicates}."""
        written = duplicates = 0
        by_part: dict[Path, list[AisObservation]] = {}
        # Built here, and only here, so that constructing an archive for a READ costs nothing.
        revision = _ROOT_REVISIONS.get(self._root_key, 0)
        # Another archive instance may have appended since this instance was
        # last used. Rebuild only on such a change; live single-writer streams
        # retain the one-time-index cost instead of rereading on every frame.
        if self._indexed_revision != revision:
            self._seen_cache = None
        seen = self._seen_index()
        self._indexed_revision = revision
        pending: set[str] = set()
        for o in obs:
            key = o.dedup_key()
            if key in seen or key in pending:
                duplicates += 1
                continue
            pending.add(key)
            p = _part_path(self.root, o.timestamp, o.source or "unknown")
            by_part.setdefault(p, []).append(o)
        for path, rows in by_part.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            new = _to_table(rows)
            if path.exists():
                old = pq.read_table(path, schema=_SCHEMA)
                new = pa.concat_tables([old, new])
            # Never publish half-written Parquet or mark a failed write as seen.
            # Readers keep using the previous complete part until replacement.
            fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
            os.close(fd)
            temp_path = Path(tmp_name)
            try:
                pq.write_table(new, temp_path, compression="snappy")
                temp_path.replace(path)
            finally:
                temp_path.unlink(missing_ok=True)
            seen.update(o.dedup_key() for o in rows)
            _ROOT_REVISIONS[self._root_key] = _ROOT_REVISIONS.get(self._root_key, 0) + 1
            self._indexed_revision = _ROOT_REVISIONS[self._root_key]
            written += len(rows)
        return {"written": written, "duplicates": duplicates}

    @_synchronized
    def query(
        self,
        start: datetime,
        end: datetime,
        bbox: tuple[float, float, float, float] | None = None,
        mmsi: str | None = None,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        """Time-range query with AOI/MMSI/source filters. Empty archive -> []."""
        files = sorted(self.root.rglob("part-*.parquet"))
        if not files:
            return []
        clauses = ["timestamp >= ? AND timestamp <= ?"]
        params: list[Any] = [start, end]
        if bbox:
            clauses.append("lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?")
            params.extend([bbox[0], bbox[2], bbox[1], bbox[3]])
        if mmsi:
            clauses.append("mmsi = ?")
            params.append(mmsi)
        if source:
            clauses.append("source = ?")
            params.append(source)
        where = " AND ".join(clauses)
        con = _connect_utc()
        try:
            rel = con.execute(
                f"SELECT * FROM read_parquet({[str(f) for f in files]!r}) WHERE {where} "
                "ORDER BY timestamp",
                params,
            )
            cols = [d[0] for d in rel.description]
            return [dict(zip(cols, row)) for row in rel.fetchall()]
        finally:
            con.close()

    @_synchronized
    def coverage(self) -> dict[str, Any]:
        """Freshness + coverage report. (AIS-012)"""
        files = sorted(self.root.rglob("part-*.parquet"))
        if not files:
            return {"days": 0, "observations": 0, "sources": [], "newest": None, "oldest": None}
        con = _connect_utc()
        try:
            row = con.execute(
                f"SELECT COUNT(*), MIN(timestamp), MAX(timestamp) "
                f"FROM read_parquet({[str(f) for f in files]!r})"
            ).fetchone()
            srcs = con.execute(
                f"SELECT DISTINCT source FROM read_parquet({[str(f) for f in files]!r})"
            ).fetchall()
            days = con.execute(
                f"SELECT COUNT(DISTINCT CAST(timestamp AS DATE)) "
                f"FROM read_parquet({[str(f) for f in files]!r})"
            ).fetchone()
        finally:
            con.close()
        assert row is not None and days is not None
        return {
            "days": days[0],
            "observations": row[0],
            "sources": sorted(s[0] for s in srcs),
            "newest": row[2].isoformat() if row[2] else None,
            "oldest": row[1].isoformat() if row[1] else None,
        }
