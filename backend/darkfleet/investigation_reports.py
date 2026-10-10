"""Reproducible, offline investigation reports assembled only from persisted evidence.

The canonical JSON object carries the independent hash of its own content.
The PDF is a presentation copy and visibly distinguishes operator statements
from measured SAR/AIS evidence; its content can be checked against the JSON.
No catalogue/provider request is made by this module.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import sqlite3
import textwrap
from pathlib import Path
from typing import Any

from darkfleet.investigation_geometry import GeometryInput, measure_geometry
from darkfleet.storage.runs import RunStore

__all__ = ["InvestigationReportNotFound", "build_report", "render_investigation_pdf"]


class InvestigationReportNotFound(LookupError):
    """The requested analyst case is not present in the local investigation ledger."""


_SOURCE_FIELDS = (
    "item_id", "collection", "provider", "platform", "product",
    "polarization", "acquisition_time", "crs", "georeferencing", "resolution_m",
)
_TARGET_FIELDS = (
    "id", "classification", "lat", "lon", "lenM", "lenUncM", "hdg",
    "meanDb", "maxDb", "sarConf", "aisConf", "assessment",
)
_SCORE_FIELDS = (
    "spatialScore", "temporalScore", "headingScore", "sizeScore",
    "compositeScore", "matchRadiusMeters",
)
_MAX_NOTES = 250
_MAX_GEOMETRIES = 150
_MAX_TARGETS = 100


def _redacted_scalar(value: Any) -> str | float | int | bool | None:
    """Only bounded plain values can leave an evidence report as metadata."""
    if isinstance(value, str):
        return value[:500]
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    return None


def _select(raw: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {
        key: _redacted_scalar(raw[key])
        for key in fields
        if key in raw
    }


def _case_db_path(data_dir: Path) -> Path:
    return data_dir / "investigations.sqlite3"


def _case_connection(data_dir: Path) -> sqlite3.Connection:
    # The shipped local app defaults to data_dir="data" (relative to its
    # launch directory). Path.as_uri requires an absolute path; tests using an
    # absolute tmp_path previously missed that the real UI's report links
    # always failed with HTTP 400 on the default local installation.
    path = _case_db_path(data_dir).resolve()
    if not path.is_file():
        raise InvestigationReportNotFound("No investigation database is installed.")
    # Explicit read-only mode is essential: exporting should never create or
    # migrate an analyst's live database just because a case ID was mistyped.
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def _scan_source(store: RunStore, scan_id: str | None) -> tuple[dict[str, Any] | None, str]:
    if not scan_id:
        return None, "NO_SCAN_LINKED"
    try:
        record = store.get(scan_id)
    except (OSError, ValueError):
        record = None
    if record is None:
        return None, "SOURCE_MISSING"
    if record.get("runtime_mode") != "REAL" or record.get("synthetic") is not False:
        return None, "SOURCE_UNVERIFIED"
    return record, "PERSISTED_REAL"


def _scan_material(record: dict[str, Any] | None, scan_id: str | None) -> dict[str, Any]:
    if record is None:
        return {"scan_id": scan_id, "metadata": None, "targets": [], "target_count": None}

    provenance = record.get("provenance")
    provenance = provenance if isinstance(provenance, dict) else {}
    sar = provenance.get("sar")
    scene = record.get("scene")
    # Source identity comes from stored authoritative provenance when present.
    # Never copy arbitrary scene blobs: signed remote raster URLs may be inside.
    meta = {
        **_select(scene, _SOURCE_FIELDS),
        **_select(sar, _SOURCE_FIELDS),
    }
    raw_targets = record.get("targets")
    raw_targets = raw_targets if isinstance(raw_targets, list) else []
    classified = [target for target in raw_targets if isinstance(target, dict)]
    ais_only_in_targets = sum(1 for target in classified if target.get("classification") == "AIS_ONLY")
    separate_ais = record.get("ais_only") or record.get("aisOnly")
    separate_ais_count = len(separate_ais) if isinstance(separate_ais, list) else 0
    targets = []
    for target in raw_targets[:_MAX_TARGETS]:
        if not isinstance(target, dict):
            continue
        item = _select(target, _TARGET_FIELDS)
        corr = target.get("corr")
        if isinstance(corr, dict):
            item["correlation"] = {
                **_select(corr, ("mmsi", "distanceOffsetMeters", "timeDeltaSeconds")),
                "score_decomposition": _select(corr.get("scoreDecomposition"), _SCORE_FIELDS),
            }
        targets.append(item)
    return {
        "scan_id": scan_id,
        "metadata": meta,
        "processing_config_hash": _redacted_scalar(
            (provenance.get("processing") or {}).get("config_hash")
            if isinstance(provenance.get("processing"), dict) else None
        ),
        "processing_version": _redacted_scalar(provenance.get("processing_version")),
        "target_count": len(raw_targets),
        "sar_target_count": len(classified) - ais_only_in_targets,
        "ais_only_count": max(ais_only_in_targets, separate_ais_count),
        "target_list_truncated": len(raw_targets) > _MAX_TARGETS,
        "targets": targets,
        "ais_coverage": _select(
            record.get("ais_coverage") or record.get("coverage"),
            ("status", "source", "freshness", "observation_count", "provider"),
        ),
    }


def build_report(
    *, data_dir: Path, store: RunStore, case_id: str
) -> dict[str, Any]:
    """Read an investigation without modifying it or contacting any provider."""
    connection = _case_connection(data_dir)
    try:
        case = connection.execute(
            "SELECT id,title,scan_id,created_at FROM investigations WHERE id=?",
            (case_id,),
        ).fetchone()
        if case is None:
            raise InvestigationReportNotFound("Investigation does not exist.")
        notes = connection.execute(
            "SELECT id,content,target_id,created_at FROM investigation_annotations "
            "WHERE investigation_id=? ORDER BY created_at,id LIMIT ?",
            (case_id, _MAX_NOTES + 1),
        ).fetchall()
        watched = connection.execute(
            "SELECT id,target_id,created_at FROM investigation_watchlist "
            "WHERE investigation_id=? ORDER BY created_at,id",
            (case_id,),
        ).fetchall()
        geom_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='investigation_geometries'"
        ).fetchone() is not None
        geom_rows = (connection.execute(
            "SELECT id,label,notes,geometry_json,created_at,updated_at "
            "FROM investigation_geometries WHERE investigation_id=? "
            "ORDER BY created_at,id LIMIT ?",
            (case_id, _MAX_GEOMETRIES + 1),
        ).fetchall() if geom_table else [])
        geometry: list[dict[str, Any]] = []
        warnings: list[str] = []
        for row in geom_rows[:_MAX_GEOMETRIES]:
            item = {
                "id": row["id"],
                "label": row["label"],
                "notes": row["notes"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "provenance": "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE",
            }
            try:
                parsed = GeometryInput.model_validate_json(row["geometry_json"])
                item["geometry"] = parsed.model_dump(mode="json")
                item["measurements"] = measure_geometry(parsed).model_dump(mode="json")
                item["status"] = "VALID"
            except (ValueError, TypeError):
                item["geometry"] = None
                item["measurements"] = None
                item["status"] = "INVALID_STORED_GEOMETRY"
                warnings.append(f"CORRUPT_OPERATOR_GEOMETRY:{row['id']}")
            geometry.append(item)

        if len(notes) > _MAX_NOTES:
            warnings.append(f"ANNOTATIONS_TRUNCATED:only first {_MAX_NOTES} included")
        if len(geom_rows) > _MAX_GEOMETRIES:
            warnings.append(f"GEOMETRIES_TRUNCATED:only first {_MAX_GEOMETRIES} included")
        record, source_status = _scan_source(store, case["scan_id"])
        if source_status != "PERSISTED_REAL":
            warnings.append(source_status)
        sensor = _scan_material(record, case["scan_id"])
        if sensor.get("target_list_truncated"):
            warnings.append(f"SAR_TARGETS_TRUNCATED:only first {_MAX_TARGETS} included")

        raw_watchlist = [
            {"id": row["id"], "target_id": row["target_id"],
             "created_at": row["created_at"], "provenance": "OPERATOR_WATCHLIST_ENTRY"}
            for row in watched
        ]
        if record:
            ids = {
                target.get("id") for target in record.get("targets") or []
                if isinstance(target, dict)
            }
            for item in raw_watchlist:
                if item["target_id"] not in ids:
                    warnings.append(f"WATCHED_TARGET_NOT_IN_SCAN:{item['target_id']}")

        report = {
            "schema_version": 1,
            "kind": "DARKFLEET_INVESTIGATION_EVIDENCE",
            "investigation": {
                "id": case["id"], "title": case["title"],
                "created_at": case["created_at"], "linked_scan_id": case["scan_id"],
            },
            "source_status": source_status,
            "sensor_evidence": sensor,
            "operator_material": {
                "disclaimer": "Analyst annotations and drawings are operator assertions, not SAR/AIS observations.",
                "annotations": [
                    {"id": row["id"], "content": row["content"],
                     "target_id": row["target_id"], "created_at": row["created_at"],
                     "provenance": "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE"}
                    for row in notes[:_MAX_NOTES]
                ],
                "watchlist": raw_watchlist,
                "geometries": geometry,
            },
            "scientific_limits": [
                "Historical SAR acquisition and recorded AIS context only; this is not a live feed.",
                "SAR_UNMATCHED is not proof of AIS disabling, criminality, or deliberate concealment.",
                "Unknown sensor size, AIS coverage or unavailable evidence must not be inferred.",
                "Wake evidence remains experimental and uncalibrated unless independently validated.",
            ],
            "warnings": sorted(set(warnings)),
        }
        canonical = json.dumps(
            report, sort_keys=True, ensure_ascii=False,
            separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
        report["content_sha256"] = hashlib.sha256(canonical).hexdigest()
        report["hash_algorithm"] = "SHA-256 over canonical JSON excluding content_sha256/hash_algorithm"
        return report
    finally:
        connection.close()


def render_investigation_pdf(report: dict[str, Any]) -> bytes:
    """Readable PDF presentation of canonical evidence; full data remain in JSON."""
    from fpdf import FPDF

    pdf = FPDF(unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=19)
    pdf.set_compression(False)
    pdf.set_title("DarkFleet Investigation Evidence")
    pdf.set_author("DarkFleet local evidence service")
    pdf.add_page()

    def plain(value: Any) -> str:
        # Standard embedded Helvetica cannot represent arbitrary Unicode. JSON
        # retains the original full-text operator record with no replacement.
        return str(value).encode("latin-1", errors="replace").decode("latin-1")

    def heading(value: str) -> None:
        pdf.ln(4)
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(20, 84, 103)
        pdf.multi_cell(177, 6, plain(value))
        pdf.set_font("Helvetica", size=9)
        pdf.set_text_color(36, 52, 61)

    def line(label: str, value: Any) -> None:
        words = textwrap.wrap(
            f"{label}: {plain(value)}", width=90, break_long_words=True,
            break_on_hyphens=False,
        ) or [f"{label}: —"]
        for row in words:
            pdf.cell(0, 5, row, new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "B", 18)
    pdf.set_text_color(20, 84, 103)
    pdf.cell(0, 11, "DARKFLEET / INVESTIGATION", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 11)
    status = report["source_status"]
    pdf.set_text_color(93, 102, 113)
    pdf.cell(0, 7, plain(f"SOURCE STATUS: {status}"), new_x="LMARGIN", new_y="NEXT")
    heading("Investigation and integrity")
    case = report["investigation"]
    line("Case ID", case["id"])
    line("Title", case["title"])
    line("Created", case["created_at"])
    line("Linked scan", case["linked_scan_id"] or "none")
    line("Content SHA-256", report["content_sha256"])
    line("Canonical record", "Download accompanying report JSON to verify full content.")
    heading("Sensor evidence (historical, as recorded)")
    sensor = report["sensor_evidence"]
    if status != "PERSISTED_REAL":
        line("Evidence", "NO VERIFIED PERSISTED SOURCE AVAILABLE")
    else:
        metadata = sensor.get("metadata") or {}
        for key in _SOURCE_FIELDS:
            if key in metadata:
                line(key.replace("_", " ").title(), metadata[key])
        line("Stored target/classification records", sensor.get("target_count", 0))
        line("SAR target records", sensor.get("sar_target_count", 0))
        line("AIS-only contact records", sensor.get("ais_only_count", 0))
        line("Analysis config hash", sensor.get("processing_config_hash") or "not available")
        for target in sensor.get("targets", []):
            source_kind = "AIS-only contact" if target.get("classification") == "AIS_ONLY" else "SAR target"
            heading(f"{source_kind} {target.get('id', 'unknown')}")
            line("Classification", target.get("classification") or "not established")
            for key in ("lat", "lon", "lenM", "lenUncM", "hdg", "sarConf", "aisConf"):
                line(key, target.get(key) if target.get(key) is not None else "not established")
            line("Assessment", target.get("assessment") or "not established")
            corr = target.get("correlation") or {}
            if corr:
                line("Candidate MMSI", corr.get("mmsi") or "none established")
                line("Score decomposition", corr.get("score_decomposition") or "unavailable")

    material = report["operator_material"]
    heading("OPERATOR-ADDED material (not satellite or AIS evidence)")
    line("Disclaimer", material["disclaimer"])
    line("Notes", len(material["annotations"]))
    for note in material["annotations"]:
        line(f"Note {note['id']}", note["content"])
        if note["target_id"]:
            line("Operator-linked target", note["target_id"])
    line("Watched targets", len(material["watchlist"]))
    for watched in material["watchlist"]:
        line("Watch entry", watched["target_id"])
    line("Saved geometries", len(material["geometries"]))
    for geometry in material["geometries"]:
        line("Operator geometry", f"{geometry['label']} ({geometry['status']})")
        measurements = geometry.get("measurements") or {}
        for field in ("length_km", "perimeter_km", "area_km2", "radius_km", "initial_bearing_deg"):
            if measurements.get(field) is not None:
                line(field, measurements[field])

    heading("Scientific limits and incomplete evidence")
    for note in report["scientific_limits"]:
        line("Limit", note)
    for warning in report["warnings"]:
        line("Missing / incomplete", warning)
    line("Text fidelity", "JSON is authoritative; unsupported PDF font glyphs appear as '?'.")
    pdf.set_font("Helvetica", size=8)
    pdf.set_text_color(93, 102, 113)
    pdf.multi_cell(
        175, 5,
        "DarkFleet local report. Reproduction requires the same persisted sensor record "
        "and analyst SQLite database. PDF appearance may vary across renderer versions.",
    )
    out = io.BytesIO()
    pdf.output(out)
    return out.getvalue()
