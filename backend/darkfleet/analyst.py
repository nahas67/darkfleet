"""Offline, deterministic, evidence-cited investigation analyst (DF-X20).

This is *not* an LLM. Only whitelisted, validated values from persisted REAL
scan records and saved SQLite investigation rows can become factual claims.
Freeform operator notes, SAR narrative fields, provider URLs, and external
prompts are never read into claim construction or executed as instructions.
No providers, network calls, credentials, model prompts, or writes.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from darkfleet.storage.runs import RunStore

AnalystIntent = Literal["SUMMARY", "WATCHLIST", "SAR_AIS", "GAPS"]
SourceStatus = Literal["PERSISTED_REAL", "NO_SCAN_LINKED", "SOURCE_MISSING", "SOURCE_UNVERIFIED"]
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
# Keep in sync with api.targets.CLASSIFICATION_VALUES. Importing that module
# from this domain reader causes the `api.__init__ -> app -> analyst_routes`
# circular import during standalone/offline analysis.
_CLASSIFICATIONS = frozenset((
    "SAR_MATCHED_AIS", "SAR_UNMATCHED", "AIS_ONLY",
    "STATIONARY_OR_INFRASTRUCTURE", "SEA_CLUTTER", "LOW_CONFIDENCE", "UNRESOLVED",
))
_MAX_WATCHES = 30
_MAX_TARGETS = 20


class UnknownInvestigation(ValueError):
    """The requested saved case is absent (or its read-only DB is unavailable)."""


class AnalystSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["PERSISTED_REAL_SCAN", "OPERATOR_CASE", "OPERATOR_WATCHLIST"]
    source_id: str
    record_path: str
    field_path: str


class AnalystClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    statement: str
    value: str | float | int | bool
    classification: Literal["SENSOR_RECORD", "OPERATOR_RECORD"]
    uncertainty: str
    sources: list[AnalystSource] = Field(min_length=1)


class AnalystUnknown(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str
    explanation: str
    source_id: str | None
    expected_field_path: str | None
    next_check: str


class GroundedAnalystOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["DARKFLEET_GROUNDED_ANALYST"] = "DARKFLEET_GROUNDED_ANALYST"
    case_id: str
    case_title: str
    linked_scan_id: str | None
    source_status: SourceStatus
    intent: AnalystIntent
    focused_target_id: str | None
    model_status: Literal["NO_MODEL_DETERMINISTIC_OFFLINE"] = "NO_MODEL_DETERMINISTIC_OFFLINE"
    claims: list[AnalystClaim]
    unknowns: list[AnalystUnknown]
    operator_note_count: int = Field(ge=0)
    operator_watch_count: int = Field(ge=0)
    source_canonical_sha256: str | None
    disclaimer: str = (
        "Only saved local records are described. This is not a live feed, "
        "a model opinion, a verified vessel identity, or evidence of illicit "
        "conduct. Operator annotations are not sensor evidence."
    )


class AnalystCaseBrief(BaseModel):
    model_config = ConfigDict(extra="forbid")
    case_id: str
    title: str
    linked_scan_id: str | None
    created_at: str


class AnalystCaseListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cases: list[AnalystCaseBrief]
    total: int = Field(ge=0)
    note: str = (
        "Saved local investigation cases, not generated hypotheses. "
        "A scan link does not guarantee the source still exists."
    )


def _db(data_dir: Path) -> sqlite3.Connection:
    db = data_dir / "investigations.sqlite3"
    if not db.is_file():
        raise UnknownInvestigation("No persisted investigation database is available.")
    # URI mode=ro: no SQLite schema migration, implicit DB creation, or writes.
    connection = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def _label(value: object, *, max_length: int = 120) -> str | None:
    """Finite safe source labels only. Never interpret untrusted prose as instructions."""
    if (
        isinstance(value, str)
        and 0 < len(value) <= max_length
        and all(32 <= ord(ch) < 127 for ch in value)
        and "://" not in value
        and "\\" not in value
        and "<" not in value
        and ">" not in value
    ):
        return value
    return None


def _number(value: object, *, minimum: float, maximum: float) -> float | None:
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number) and minimum <= number <= maximum:
            return number
    return None


def _scan(store: RunStore, scan_id: str | None) -> tuple[dict[str, Any] | None, SourceStatus]:
    if not scan_id:
        return None, "NO_SCAN_LINKED"
    if _ID.fullmatch(scan_id) is None:
        return None, "SOURCE_UNVERIFIED"
    try:
        raw = store.get(scan_id)
    except (ValueError, OSError):
        raw = None
    if raw is None:
        return None, "SOURCE_MISSING"
    if (
        raw.get("scan_id") != scan_id
        or raw.get("runtime_mode") != "REAL"
        or raw.get("synthetic") is not False
        or raw.get("stage") not in (None, "COMPLETE")
    ):
        return None, "SOURCE_UNVERIFIED"
    return raw, "PERSISTED_REAL"


def _hash(record: dict[str, Any]) -> str | None:
    try:
        return hashlib.sha256(json.dumps(
            record, sort_keys=True, ensure_ascii=False, allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
    except (TypeError, ValueError, OverflowError):
        # A corrupted/legacy record containing nonfinite fields is NOT
        # admissible as complete, fingerprintable evidence.
        return None


def list_analyst_cases(data_dir: Path, *, limit: int = 100) -> AnalystCaseListOut:
    """Read durable case identities only; no notes or source scans loaded."""
    try:
        with _db(data_dir) as db:
            count = db.execute("SELECT COUNT(*) FROM investigations").fetchone()[0]
            rows = db.execute(
                "SELECT id,title,scan_id,created_at FROM investigations "
                "ORDER BY created_at DESC,id DESC LIMIT ?", (limit,),
            ).fetchall()
    except sqlite3.Error as exc:
        raise UnknownInvestigation("Investigation records are unreadable.") from exc
    return AnalystCaseListOut(
        cases=[
            AnalystCaseBrief(case_id=row["id"], title=row["title"],
                             linked_scan_id=row["scan_id"], created_at=row["created_at"])
            for row in rows
        ], total=count,
    )


def analyze_case(
    data_dir: Path, store: RunStore, case_id: str, *,
    intent: AnalystIntent = "SUMMARY", target_id: str | None = None,
) -> GroundedAnalystOut:
    """Always recompute from current persisted case+scan; never store conclusions.

    Annotations are counted with SQL COUNT only. Their untrusted content is not
    SELECTed, transmitted to a model, or inserted into any generated sentence.
    """
    try:
        with _db(data_dir) as db:
            case = db.execute(
                "SELECT id,title,scan_id FROM investigations WHERE id=?", (case_id,),
            ).fetchone()
            if case is None:
                raise UnknownInvestigation("Investigation does not exist.")
            note_count = db.execute(
                "SELECT COUNT(*) FROM investigation_annotations WHERE investigation_id=?",
                (case_id,),
            ).fetchone()[0]
            watch_count = db.execute(
                "SELECT COUNT(*) FROM investigation_watchlist WHERE investigation_id=?",
                (case_id,),
            ).fetchone()[0]
            watches = db.execute(
                "SELECT id,target_id FROM investigation_watchlist WHERE investigation_id=? "
                "ORDER BY created_at,id LIMIT ?", (case_id, _MAX_WATCHES),
            ).fetchall()
            case_title = str(case["title"])
            scan_id: str | None = case["scan_id"]
    except sqlite3.Error as exc:
        raise UnknownInvestigation("Investigation database schema is unavailable.") from exc

    record, status = _scan(store, scan_id)
    digest = _hash(record) if record is not None else None
    if record is not None and digest is None:
        record, status = None, "SOURCE_UNVERIFIED"

    claims: list[AnalystClaim] = []
    unknowns: list[AnalystUnknown] = []
    scan_ref = f"scans/{scan_id}.json" if scan_id else None

    def claim(
        statement: str, value: str | float | bool, kind: Literal["SENSOR_RECORD", "OPERATOR_RECORD"],
        source_kind: Literal["PERSISTED_REAL_SCAN", "OPERATOR_CASE", "OPERATOR_WATCHLIST"],
        source_id: str, record_path: str, field_path: str, uncertainty: str,
    ) -> None:
        claims.append(AnalystClaim(
            id=f"fact-{len(claims) + 1:03d}", statement=statement, value=value,
            classification=kind, uncertainty=uncertainty,
            sources=[AnalystSource(
                kind=source_kind, source_id=source_id,
                record_path=record_path, field_path=field_path,
            )],
        ))

    def unknown(code: str, explanation: str, field_path: str | None, check: str) -> None:
        unknowns.append(AnalystUnknown(
            code=code, explanation=explanation, source_id=scan_id,
            expected_field_path=field_path, next_check=check,
        ))

    if intent in ("SUMMARY", "WATCHLIST"):
        claim(
            f"This investigation contains {watch_count} operator watchlist entries.",
            watch_count, "OPERATOR_RECORD", "OPERATOR_CASE", case_id,
            "investigations.sqlite3",
            f"investigation_watchlist[investigation_id={case_id}].COUNT",
            "Operator-created entries; not independent sensor observations.",
        )
        if intent == "WATCHLIST":
            for row in watches:
                watch_id = row["id"]
                watched = _label(row["target_id"], max_length=100)
                if watched is None:
                    unknown(
                        "INVALID_WATCH_ENTRY", "An operator watch entry has an invalid target identifier.",
                        None, "Review and repair the stored watchlist entry.",
                    )
                    continue
                claim(
                    f"An operator saved target {watched} on this case's watchlist.",
                    watched, "OPERATOR_RECORD", "OPERATOR_WATCHLIST",
                    watch_id, "investigations.sqlite3",
                    f"investigation_watchlist[id={watch_id}].target_id",
                    "An operator selection, not evidence of vessel identity or risk.",
                )
            if watch_count > len(watches):
                unknown(
                    "WATCHLIST_TRUNCATED",
                    f"Only the first {_MAX_WATCHES} of {watch_count} saved watch entries were inspected.",
                    None, "Review remaining entries in the investigation notebook.",
                )

    if intent == "SUMMARY":
        claim(
            f"The saved investigation has {note_count} operator annotations.",
            note_count, "OPERATOR_RECORD", "OPERATOR_CASE", case_id,
            "investigations.sqlite3",
            f"investigation_annotations[investigation_id={case_id}].COUNT",
            "Annotation text is untrusted and deliberately excluded from analysis.",
        )

    if record is None:
        reason = {
            "NO_SCAN_LINKED": "This investigation has no linked persisted scan.",
            "SOURCE_MISSING": "The linked scan document is no longer available.",
            "SOURCE_UNVERIFIED": "The linked scan lacks a valid persisted REAL/synthetic-false evidence assertion.",
        }[status]
        unknown(
            status, reason, "$.runtime_mode" if scan_id else None,
            "Link or restore an independently verified persisted REAL acquisition.",
        )
        if intent == "GAPS":
            unknown(
                "AIS_COVERAGE_NOT_ESTABLISHED",
                "Independent AIS archive coverage has not been checked for this case.",
                None, "Inspect archived AIS coverage for the acquisition's time and AOI.",
            )
    else:
        scene = record.get("scene")
        scene = scene if isinstance(scene, dict) else {}
        if intent in ("SUMMARY", "SAR_AIS"):
            item_id = _label(scene.get("item_id"))
            if item_id is not None:
                claim(
                    f"The saved REAL scan names acquisition item {item_id}.",
                    item_id, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                    scan_id or "", scan_ref or "", "$.scene.item_id",
                    "Source item identifier as recorded; not proof of acquisition quality.",
                )
            else:
                unknown(
                    "SCENE_ITEM_NOT_RECORDED", "A verified acquisition item identifier is unavailable.",
                    "$.scene.item_id", "Inspect the source scene provenance.",
                )
            acquisition = _label(scene.get("acquisition_time"))
            if acquisition is not None:
                claim(
                    f"The saved scan records acquisition time {acquisition}.",
                    acquisition, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                    scan_id or "", scan_ref or "", "$.scene.acquisition_time",
                    "Recorded timestamp; no claim that this is a live observation.",
                )
            else:
                unknown(
                    "ACQUISITION_TIME_NOT_RECORDED",
                    "A usable recorded SAR acquisition timestamp is unavailable.",
                    "$.scene.acquisition_time", "Inspect source metadata.",
                )

        raw_targets = record.get("targets")
        targets = raw_targets if isinstance(raw_targets, list) else None
        if targets is None:
            unknown(
                "SAR_TARGETS_NOT_RECORDED",
                "The scan has no usable stored targets array; detector output is unknown.",
                "$.targets", "Inspect the persisted scan's detection stage.",
            )
        elif intent in ("SUMMARY", "SAR_AIS"):
            claim(
                f"The scan stores {len(targets)} target entries (not a count of all vessels at sea).",
                len(targets), "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                scan_id or "", scan_ref or "", "$.targets",
                "Recorded detector entries; absence is not proof of absence of vessels.",
            )

        selected: list[tuple[int, dict[str, Any]]] = []
        if targets is not None and intent in ("SAR_AIS", "WATCHLIST"):
            watched_ids = {
                row["target_id"] for row in watches if _label(row["target_id"], max_length=100)
            }
            for i, item in enumerate(targets):
                if not isinstance(item, dict):
                    continue
                tid = _label(item.get("id"), max_length=100)
                if tid is None:
                    continue
                if target_id is not None:
                    if tid != target_id:
                        continue
                elif intent == "WATCHLIST" and tid not in watched_ids:
                    continue
                selected.append((i, item))
                if len(selected) >= _MAX_TARGETS:
                    break
            if target_id is not None and not selected:
                unknown(
                    "FOCUSED_TARGET_NOT_IN_SOURCE",
                    "The requested target ID does not appear in the saved scan target array.",
                    "$.targets", "Check that the selected target belongs to this linked scan.",
                )
            if intent == "WATCHLIST" and not watched_ids:
                unknown(
                    "NO_WATCHED_TARGETS",
                    "No valid case watchlist entries are available for a watched-target assessment.",
                    None, "Add an existing recorded SAR target to the case watchlist.",
                )
            if target_id is None and len(selected) >= _MAX_TARGETS:
                unknown(
                    "TARGET_DETAILS_BOUNDED",
                    f"Details are limited to {_MAX_TARGETS} source targets per analysis.",
                    "$.targets", "Choose a specific target ID to inspect.",
                )
            for index, item in selected:
                tid = str(item["id"])
                root = f"$.targets[{index}]"
                confidence = _number(item.get("sarConf"), minimum=0, maximum=1)
                if confidence is not None:
                    claim(
                        f"Saved SAR detector confidence for target {tid} is {confidence:.4f}.",
                        confidence, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                        scan_id or "", scan_ref or "", f"{root}.sarConf",
                        "Algorithmic detection score, not vessel identity or illicit-activity probability.",
                    )
                else:
                    unknown(
                        "SAR_CONFIDENCE_NOT_ESTABLISHED",
                        f"Recorded SAR confidence is unavailable for target {tid}.",
                        f"{root}.sarConf", "Inspect detector provenance for this target.",
                    )
                if intent == "SAR_AIS":
                    ais_score = _number(item.get("aisConf"), minimum=0, maximum=1)
                    if ais_score is not None:
                        claim(
                            f"Saved AIS association confidence for target {tid} is {ais_score:.4f}.",
                            ais_score, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                            scan_id or "", scan_ref or "", f"{root}.aisConf",
                            "Algorithmic association score, not proof of AIS reception or identity.",
                        )
                # Real persisted scan targets serialize the canonical API field as
                # `classification`; older scan fixtures retain `cls`. Never cite a
                # field that is absent, silently drop SEA_CLUTTER, or choose between
                # contradictory stored classifications.
                has_canonical = "classification" in item
                class_field = "classification" if has_canonical else "cls"
                classification = item.get(class_field)
                legacy = item.get("cls")
                if has_canonical and "cls" in item and legacy != classification:
                    unknown(
                        "CLASSIFICATION_INCONSISTENT",
                        f"Conflicting stored class fields for target {tid}; no processing class asserted.",
                        f"{root}.classification",
                        "Inspect original persisted source and processing contract.",
                    )
                elif isinstance(classification, str) and classification in _CLASSIFICATIONS:
                    claim(
                        f"Stored processing class for target {tid} is {classification}.",
                        str(classification), "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                        scan_id or "", scan_ref or "", f"{root}.{class_field}",
                        "A processing label only; SAR_UNMATCHED never establishes intentional AIS non-reporting.",
                    )
                else:
                    unknown(
                        "CLASSIFICATION_NOT_ESTABLISHED",
                        f"A recognized processing class is not recorded for target {tid}.",
                        f"{root}.{class_field}", "Review the processing classification schema.",
                    )
                if intent == "SAR_AIS":
                    corr = item.get("corr")
                    if not isinstance(corr, dict) or type(corr.get("matched")) is not bool:
                        unknown(
                            "AIS_CORRELATION_NOT_ESTABLISHED",
                            f"Saved AIS association outcome for target {tid} is not established.",
                            f"{root}.corr.matched",
                            "Review persisted AIS correlation and coverage before interpreting missing matches.",
                        )
                    else:
                        matched = corr["matched"]
                        claim(
                            f"Saved AIS correlation for SAR target {tid} records matched={str(matched).lower()}.",
                            matched, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                            scan_id or "", scan_ref or "", f"{root}.corr.matched",
                            "This records algorithmic association, not verified vessel identity or AIS reception completeness.",
                        )
                        mmsi = corr.get("mmsi")
                        if matched and isinstance(mmsi, str) and re.fullmatch(r"[0-9]{9}", mmsi):
                            claim(
                                f"The saved association references MMSI {mmsi} for target {tid}.",
                                mmsi, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                                scan_id or "", scan_ref or "", f"{root}.corr.mmsi",
                                "Correlated identifier only; not an independently confirmed vessel identity.",
                            )
                        if not matched:
                            unknown(
                                "AIS_NONMATCH_NOT_NONREPORTING",
                                f"Target {tid} has no stored AIS correlation match; AIS transmission/coverage is not determined.",
                                f"{root}.corr.matched",
                                "Check acquisition time, archived AIS coverage and correlation parameters.",
                            )
        if intent in ("GAPS", "SAR_AIS"):
            coverage_field = (
                "ais_coverage" if isinstance(record.get("ais_coverage"), dict)
                else "coverage"
            )
            coverage = record.get(coverage_field)
            status_value = coverage.get("status") if isinstance(coverage, dict) else None
            if isinstance(status_value, str) and status_value in (
                "AVAILABLE", "UNAVAILABLE", "PARTIAL", "COMPLETE", "DEGRADED",
                "NOT_AVAILABLE", "NO_DATA",
            ):
                claim(
                    f"Saved AIS coverage metadata reports status {status_value}.",
                    status_value, "SENSOR_RECORD", "PERSISTED_REAL_SCAN",
                    scan_id or "", scan_ref or "", f"$.{coverage_field}.status",
                    "Recorded coverage status only; underlying AIS reception has not been reverified.",
                )
            else:
                unknown(
                    "AIS_COVERAGE_NOT_ESTABLISHED",
                    "The saved scan does not contain authoritative AIS coverage metadata.",
                    f"$.{coverage_field}.status",
                    "Consult the real AIS archive and time-scoped coverage diagnostics.",
                )
        if intent == "GAPS":
            provenance = record.get("provenance")
            sar = provenance.get("sar") if isinstance(provenance, dict) else None
            if not isinstance(sar, dict) or not sar.get("crs") or not sar.get("transform"):
                unknown(
                    "SAR_GEOREFERENCE_NOT_ESTABLISHED",
                    "Source CRS/window affine georeferencing has not been established.",
                    "$.provenance.sar.transform",
                    "Inspect the original raster's CRS, affine and window metadata.",
                )
            unknown(
                "CROSS_PASS_IDENTITY_UNVERIFIED",
                "A persisted single-scan case cannot verify identity across SAR acquisitions.",
                None, "Use independently measured cross-pass geometry and uncertainty bounds.",
            )

    return GroundedAnalystOut(
        case_id=case_id, case_title=case_title, linked_scan_id=scan_id,
        source_status=status, intent=intent, focused_target_id=target_id,
        claims=claims, unknowns=unknowns,
        operator_note_count=note_count, operator_watch_count=watch_count,
        source_canonical_sha256=digest,
    )
