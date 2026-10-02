"""Local AIS archive: Parquet partitions + DuckDB queries. (AIS-010..013)

Layout: <data_dir>/ais/YYYY/MM/DD/part-<source>.parquet
The archive is the authority; memory never is. Restart-safe by construction.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from .models import AisObservation

logger = logging.getLogger(__name__)

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
    return root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / f"part-{source}.parquet"


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
        self._seen: set[str] = set()
        for f in self.root.rglob("part-*.parquet"):
            try:
                t = pq.read_table(f, columns=["mmsi", "timestamp"])
                for mmsi, ts in zip(t.column("mmsi").to_pylist(), t.column("timestamp").to_pylist()):
                    self._seen.add(f"{mmsi}|{ts.isoformat()}")
            except (OSError, ValueError, KeyError) as exc:
                logger.warning("skipping unreadable archive part %s: %s", f, exc)
                continue

    def append(self, obs: list[AisObservation]) -> dict[str, int]:
        """Dedup by mmsi|timestamp; returns {written, duplicates}."""
        written = duplicates = 0
        by_part: dict[Path, list[AisObservation]] = {}
        for o in obs:
            key = o.dedup_key()
            if key in self._seen:
                duplicates += 1
                continue
            self._seen.add(key)
            p = _part_path(self.root, o.timestamp, o.source or "unknown")
            by_part.setdefault(p, []).append(o)
            written += 1
        for path, rows in by_part.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            new = _to_table(rows)
            if path.exists():
                old = pq.read_table(path, schema=_SCHEMA)
                new = pa.concat_tables([old, new])
            pq.write_table(new, path, compression="snappy")
        return {"written": written, "duplicates": duplicates}

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
