"""Read-only stdio MCP access to locally persisted REAL maritime evidence.

This adapter never invokes scan submission, providers, model APIs, RunStore.save,
or AisArchive.append. The caller supplies an explicit local data directory and
all scan/target identities are resolved against stored observations.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

import duckdb
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from darkfleet.storage.runs import RunStore, run_store_for_data_dir

__all__ = ["EvidenceReader", "create_server"]

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
_MMSI = re.compile(r"^[0-9]{9}$")
_SCENE_FIELDS = (
    "item_id", "platform", "provider", "product", "polarization", "acquisition_time",
    "crs", "resolution_meters", "georeferencing",
)
_PROVENANCE_FIELDS = (
    "processing_version", "software_version", "classification_schema",
    "algorithm_version", "acquisition_time", "provider", "product",
)
_TARGET_FIELDS = (
    "id", "cls", "lat", "lon", "sarConf", "aisConf", "area", "lenM", "widM",
    "lenUncM", "hdg", "wake", "meanDb", "maxDb", "geo_pixel_centroid",
    "geo_centre_offset", "geolocationUncertaintyM",
)
_CORRELATION_FIELDS = (
    "matched", "mmsi", "vesselName", "distanceOffsetMeters", "timeDeltaSeconds",
    "predictedLat", "predictedLon", "candidatesConsidered", "acceptanceThreshold",
)
_SCORE_FIELDS = (
    "spatialScore", "temporalScore", "headingScore", "sizeScore",
    "compositeScore", "matchRadiusMeters", "distanceOffsetMeters",
    "timeDeltaSeconds",
)
_REJECTED_FIELDS = (
    "mmsi", "vesselName", "score", "distanceMeters",
    "timeDeltaSeconds", "shortfall",
)
_AIS_FIELDS = (
    "timestamp", "mmsi", "lat", "lon", "sog", "cog", "heading", "nav_status",
    "name", "callsign", "imo", "ship_type", "length_m", "width_m", "source",
)
_MAX_AIS_PARTITIONS = 10_000


def _identity(value: str, label: str) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise ValueError(f"{label} must be 1-100 ASCII letters, digits, dots, underscores or dashes")
    return value


def _page(limit: int, offset: int, *, maximum: int = 100) -> None:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError(f"limit must be an integer from 1 through {maximum}")
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 10_000:
        raise ValueError("offset must be an integer from 0 through 10000")


def _selected(record: object, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(record, dict):
        return {}
    return {key: record[key] for key in fields if key in record}


def _safe_metadata(record: object, fields: tuple[str, ...]) -> dict[str, Any]:
    """Only bounded scalar catalog fields; never unreviewed nested provider data."""
    values = _selected(record, fields)
    return {
        key: value for key, value in values.items()
        if (value is None or (
            isinstance(value, (str, int, float, bool))
            and (not isinstance(value, str) or len(value) <= 300)
            and (not isinstance(value, float) or math.isfinite(value))
        ))
    }


def _instant(raw: str, label: str) -> datetime:
    if not isinstance(raw, str):
        raise TypeError(f"{label} must be a timezone-aware ISO 8601 timestamp")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{label} must be a timezone-aware ISO 8601 timestamp") from exc
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError(f"{label} must include a timezone (UTC recommended)")
    return dt.astimezone(UTC)


def _target_result(target: dict[str, Any]) -> dict[str, Any]:
    result = _selected(target, _TARGET_FIELDS)
    corr = target.get("corr")
    if not isinstance(corr, dict):
        result["correlation"] = None
    else:
        selected = _selected(corr, _CORRELATION_FIELDS)
        selected["scoreDecomposition"] = (
            _selected(corr["scoreDecomposition"], _SCORE_FIELDS)
            if isinstance(corr.get("scoreDecomposition"), dict) else None
        )
        selected["closestRejected"] = (
            _selected(corr["closestRejected"], _REJECTED_FIELDS)
            if isinstance(corr.get("closestRejected"), dict) else None
        )
        result["correlation"] = selected
    return result


class EvidenceReader:
    """Explicit reader over an existing data_dir. No filesystem initialization."""

    def __init__(self, data_dir: Path | str) -> None:
        self.data_dir = Path(data_dir).resolve()
        self.run_store: RunStore = run_store_for_data_dir(self.data_dir)

    def _real_scan(self, scan_id: str) -> dict[str, Any] | None:
        _identity(scan_id, "scan_id")
        record = self.run_store.get(scan_id)
        if (
            not isinstance(record, dict)
            or record.get("scan_id") != scan_id
            or record.get("runtime_mode") != "REAL"
            or record.get("synthetic") is not False
        ):
            return None
        return record

    def _provenance(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "source": "local_persisted_run_store",
            "record_path": f"scans/{record['scan_id']}.json",
            "runtime_mode": "REAL",
            "synthetic": False,
            "created_at": record.get("created_at"),
            "scene": _safe_metadata(record.get("scene"), _SCENE_FIELDS),
            "processing": _safe_metadata(record.get("provenance"), _PROVENANCE_FIELDS),
        }

    def list_scans(self, limit: int = 30, offset: int = 0) -> dict[str, Any]:
        _page(limit, offset)
        # Iterate available identifiers and inspect each record's REAL guard.
        page: list[dict[str, Any]] = []
        total = 0
        for scan_id in reversed(self.run_store.list_ids()):
            if _ID.fullmatch(scan_id) is None:
                continue
            record = self._real_scan(scan_id)
            if record is not None:
                if total >= offset and len(page) < limit:
                    page.append({
                        "scan_id": scan_id,
                        "target_count": len(record.get("targets") or []),
                        "provenance": self._provenance(record),
                    })
                total += 1
        return {
            "status": "AVAILABLE" if total else "NO_PERSISTED_REAL_SCANS",
            "total": total, "limit": limit, "offset": offset, "scans": page,
        }

    def get_scan(self, scan_id: str) -> dict[str, Any]:
        record = self._real_scan(scan_id)
        if record is None:
            return {"status": "MISSING_EVIDENCE", "scan_id": scan_id, "reason": "NO_PERSISTED_REAL_SCAN"}
        return {
            "status": "AVAILABLE", "scan_id": scan_id,
            "stage": record.get("stage"),
            "aoi": record.get("aoi"),
            "counts": record.get("counts"),
            "target_count": len(record.get("targets") or []),
            "ais_only_count": len(record.get("ais_only") or []),
            "acquisition_time": record.get("acquisition_time"),
            "provenance": self._provenance(record),
        }

    def list_scan_targets(
        self, scan_id: str, limit: int = 30, offset: int = 0,
    ) -> dict[str, Any]:
        _page(limit, offset)
        record = self._real_scan(scan_id)
        if record is None:
            return {"status": "MISSING_EVIDENCE", "scan_id": scan_id, "reason": "NO_PERSISTED_REAL_SCAN"}
        targets = [t for t in (record.get("targets") or []) if isinstance(t, dict)]
        return {
            "status": "AVAILABLE", "scan_id": scan_id,
            "total": len(targets), "offset": offset, "limit": limit,
            "targets": [_target_result(t) for t in targets[offset:offset + limit]],
            "provenance": self._provenance(record),
        }

    def get_target_evidence(self, scan_id: str, target_id: str) -> dict[str, Any]:
        _identity(target_id, "target_id")
        record = self._real_scan(scan_id)
        if record is None:
            return {
                "status": "MISSING_EVIDENCE", "scan_id": scan_id,
                "target_id": target_id, "reason": "NO_PERSISTED_REAL_SCAN",
            }
        target = next(
            (t for t in record.get("targets") or []
             if isinstance(t, dict) and t.get("id") == target_id), None,
        )
        if target is None:
            return {
                "status": "MISSING_EVIDENCE", "scan_id": scan_id,
                "target_id": target_id, "reason": "TARGET_ABSENT_FROM_SCAN",
                "provenance": self._provenance(record),
            }
        # The recorded AIS observation behind an association is distinct from
        # any independent archive query; if missing, do not imply one existed.
        ais = target.get("ais")
        observed = ais.get("observation") if isinstance(ais, dict) else None
        return {
            "status": "AVAILABLE", "scan_id": scan_id, "target_id": target_id,
            "target": _target_result(target),
            "associated_ais_observation": _selected(observed, _AIS_FIELDS) if observed else None,
            "provenance": self._provenance(record),
        }

    def query_scan_ais(
        self,
        scan_id: str, start_utc: str, end_utc: str, mmsi: str | None = None,
        limit: int = 100, offset: int = 0,
    ) -> dict[str, Any]:
        _page(limit, offset, maximum=200)
        record = self._real_scan(scan_id)
        if record is None:
            return {"status": "MISSING_EVIDENCE", "scan_id": scan_id, "reason": "NO_PERSISTED_REAL_SCAN"}
        if mmsi is not None and _MMSI.fullmatch(mmsi) is None:
            raise ValueError("mmsi must be exactly nine ASCII digits")
        start, end = _instant(start_utc, "start_utc"), _instant(end_utc, "end_utc")
        if end < start or end - start > timedelta(days=7):
            raise ValueError("AIS query requires start <= end and an interval <= 7 days")
        archive_root = self.data_dir / "ais"
        parts = sorted(archive_root.rglob("part-*.parquet")) if archive_root.is_dir() else []
        base = {
            "scan_id": scan_id, "query_interval": {"start_utc": start.isoformat(), "end_utc": end.isoformat()},
            "mmsi_filter": mmsi, "limit": limit, "offset": offset,
            "provenance": {
                **self._provenance(record),
                "ais_source": "local_archive_parquet",
                "interpretation": "Archive observations for requested interval; not an inferred scan association",
            },
        }
        if not parts:
            return {**base, "status": "MISSING_EVIDENCE", "reason": "AIS_ARCHIVE_NOT_PRESENT",
                    "observations": []}
        if len(parts) > _MAX_AIS_PARTITIONS:
            return {**base, "status": "UNAVAILABLE", "reason": "AIS_PARTITION_LIMIT_EXCEEDED",
                    "observations": []}
        sql = (
            "SELECT timestamp, mmsi, lat, lon, sog, cog, heading, nav_status, "
            "name, callsign, imo, ship_type, length_m, width_m, source "
            "FROM read_parquet(?) WHERE timestamp >= ? AND timestamp <= ?"
        )
        params: list[Any] = [[str(p) for p in parts], start, end]
        if mmsi is not None:
            sql += " AND mmsi = ?"
            params.append(mmsi)
        sql += " ORDER BY timestamp, mmsi, source LIMIT ? OFFSET ?"
        params.extend([limit + 1, offset])
        connection = duckdb.connect(":memory:")
        try:
            connection.execute("SET TimeZone='UTC'")
            relation = connection.execute(sql, params)
            names = [column[0] for column in relation.description]
            rows = [dict(zip(names, entry)) for entry in relation.fetchall()]
        except (duckdb.Error, OSError, ValueError) as exc:
            return {**base, "status": "UNAVAILABLE", "reason": "AIS_ARCHIVE_READ_FAILED",
                    "detail": type(exc).__name__, "observations": []}
        finally:
            connection.close()
        observed = [
            {
                key: value.isoformat() if isinstance(value, datetime) else value
                for key, value in row.items()
            }
            for row in rows[:limit]
        ]
        return {
            **base,
            "status": (
                "AVAILABLE" if observed
                else "PAGE_EMPTY" if offset > 0
                else "NO_OBSERVATIONS_IN_WINDOW"
            ),
            "observations": observed,
            "has_more": len(rows) > limit,
        }

    def get_maritime_context(self, scan_id: str, target_id: str) -> dict[str, Any]:
        _identity(target_id, "target_id")
        record = self._real_scan(scan_id)
        if record is None:
            return {
                "status": "MISSING_EVIDENCE", "scan_id": scan_id,
                "target_id": target_id, "reason": "NO_PERSISTED_REAL_SCAN",
            }
        target = next(
            (t for t in record.get("targets") or []
             if isinstance(t, dict) and t.get("id") == target_id), None,
        )
        if target is None:
            return {
                "status": "MISSING_EVIDENCE", "scan_id": scan_id,
                "target_id": target_id, "reason": "TARGET_ABSENT_FROM_SCAN",
            }
        lat, lon = target.get("lat"), target.get("lon")
        if (
            isinstance(lat, bool) or isinstance(lon, bool)
            or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float))
            or not math.isfinite(lat) or not math.isfinite(lon)
            or not -90 <= lat <= 90 or not -180 <= lon <= 180
        ):
            return {
                "status": "MISSING_EVIDENCE", "scan_id": scan_id,
                "target_id": target_id, "reason": "TARGET_POSITION_UNAVAILABLE",
            }
        # api.__init__ imports app, which imports maritime_routes ->
        # display_service -> service. Load that established dependency chain first
        # to avoid trying to initialise service while display_service requires
        # its COAST_ID constant. Importing app constructs no API lifespan or jobs.
        from darkfleet.api import app as _unused_app
        from darkfleet.maritime.service import build_context

        del _unused_app
        context = build_context(
            self.data_dir, scan_id=scan_id, target_id=target_id,
            latitude=float(lat), longitude=float(lon),
        )
        return {
            "status": "AVAILABLE", "scan_id": scan_id, "target_id": target_id,
            "maritime_context": context.model_dump(mode="json"),
            "provenance": self._provenance(record),
        }


def create_server(data_dir: Path | str) -> FastMCP:
    """Create the installed official MCP SDK server, with exactly six read tools."""
    reader = EvidenceReader(data_dir)
    server = FastMCP(
        "DarkFleet Evidence (local/read-only)",
        instructions=(
            "Read-only local persisted REAL scans, AIS observations and maritime reference context. "
            "A missing observation is never evidence of a vessel's absence. "
            "Target IDs are scoped to a scan. No tools submit scans, mutate sources or contact providers."
        ),
        log_level="ERROR",
    )

    def list_real_scans(
        limit: Annotated[int, Field(ge=1, le=100)] = 30,
        offset: Annotated[int, Field(ge=0, le=10000)] = 0,
    ) -> dict[str, Any]:
        """Page persisted REAL scan records (not a live provider catalogue)."""
        return reader.list_scans(limit, offset)

    def get_real_scan(scan_id: str) -> dict[str, Any]:
        """Read evidence counts, original AOI and whitelisted source provenance."""
        return reader.get_scan(scan_id)

    def list_real_scan_targets(
        scan_id: str,
        limit: Annotated[int, Field(ge=1, le=100)] = 30,
        offset: Annotated[int, Field(ge=0, le=10000)] = 0,
    ) -> dict[str, Any]:
        """Page recorded SAR classifications and correlation evidence for one scan."""
        return reader.list_scan_targets(scan_id, limit, offset)

    def get_real_target_evidence(scan_id: str, target_id: str) -> dict[str, Any]:
        """Get one scan-specific SAR target, recorded correlation and AIS evidence."""
        return reader.get_target_evidence(scan_id, target_id)

    def query_persisted_ais(
        scan_id: str,
        start_utc: str,
        end_utc: str,
        mmsi: str | None = None,
        limit: Annotated[int, Field(ge=1, le=200)] = 100,
        offset: Annotated[int, Field(ge=0, le=10000)] = 0,
    ) -> dict[str, Any]:
        """Bounded UTC time-window query over local AIS Parquet; no live collection."""
        return reader.query_scan_ais(scan_id, start_utc, end_utc, mmsi, limit, offset)

    def get_real_target_maritime_context(scan_id: str, target_id: str) -> dict[str, Any]:
        """Resolve local reference-dataset status and provenance from a stored WGS84 position."""
        return reader.get_maritime_context(scan_id, target_id)

    readonly = ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
    server.add_tool(list_real_scans, annotations=readonly)
    server.add_tool(get_real_scan, annotations=readonly)
    server.add_tool(list_real_scan_targets, annotations=readonly)
    server.add_tool(get_real_target_evidence, annotations=readonly)
    server.add_tool(query_persisted_ais, annotations=readonly)
    server.add_tool(get_real_target_maritime_context, annotations=readonly)
    return server
