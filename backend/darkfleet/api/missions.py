"""Durable operator missions and evidence-grounded, repeatable alert evaluation.

Mission records, scan links, watched-target rules, alerts and evaluation outcomes
live in a separate local SQLite database. Source RunStore files are read-only.
"""

from __future__ import annotations

import json
import math
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from uuid import uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from darkfleet.api.routes import State
from darkfleet.mission_alerts import evaluate_sar_watch

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
MissionStatus = Literal["PLANNED", "ACTIVE", "PAUSED", "CLOSED"]
AlertStatus = Literal["OPEN", "ACKNOWLEDGED"]
EvaluationStatus = Literal["TRIGGERED", "BELOW_THRESHOLD", "NOT_EVALUATED"]


class MissionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title
    aoi: tuple[float, float, float, float]
    status: MissionStatus = "PLANNED"

    @model_validator(mode="after")
    def validate_aoi(self) -> MissionBody:
        west, south, east, north = self.aoi
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("AOI must be [west,south,east,north] in ordered WGS84 degrees")
        return self


class MissionReplace(MissionBody):
    """Full replacement, with explicitly chosen status and AOI."""


class MissionScanLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_id: Identifier


class WatchRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    investigation_id: Identifier
    target_id: Identifier
    minimum_sar_confidence: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)


class MissionRuleOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    mission_id: str
    investigation_id: str
    scan_id: str
    target_id: str
    kind: Literal["WATCHED_TARGET_SAR_CONFIDENCE"] = "WATCHED_TARGET_SAR_CONFIDENCE"
    minimum_sar_confidence: float
    created_at: str


class MissionAlertOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    mission_id: str
    rule_id: str
    scan_id: str
    target_id: str
    minimum_sar_confidence: float
    sar_confidence: float
    classification: str | None
    rationale: str
    evidence: dict[str, Any]
    evidence_fingerprint: str
    status: AlertStatus
    created_at: str
    acknowledged_at: str | None
    provenance: Literal["PERSISTED_REAL_SAR_OPERATOR_THRESHOLD"] = (
        "PERSISTED_REAL_SAR_OPERATOR_THRESHOLD"
    )


class MissionEvaluationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mission_id: str
    rule_id: str
    scan_id: str
    target_id: str
    status: EvaluationStatus
    reason: str
    evaluated_at: str
    evidence_fingerprint: str | None


class EvaluationRunOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mission_id: str
    evaluations: list[MissionEvaluationOut]
    alerts_created: int
    existing_alerts: int
    not_evaluated: int
    note: str = (
        "Historical persisted REAL observations only. A threshold match is "
        "not evidence of illicit activity; missing data is NOT_EVALUATED."
    )


class MissionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    title: str
    aoi: tuple[float, float, float, float]
    status: MissionStatus
    created_at: str
    updated_at: str
    scan_ids: list[str]
    rules: list[MissionRuleOut]
    alerts: list[MissionAlertOut]
    evaluations: list[MissionEvaluationOut]


class MissionListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    missions: list[MissionOut]


router = APIRouter(prefix="/api/missions", tags=["missions"])

_SCHEMA = """
CREATE TABLE IF NOT EXISTS missions (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, aoi_json TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_scans (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 scan_id TEXT NOT NULL, linked_at TEXT NOT NULL,
 PRIMARY KEY(mission_id, scan_id)
);
CREATE TABLE IF NOT EXISTS mission_rules (
 id TEXT PRIMARY KEY,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 investigation_id TEXT NOT NULL, scan_id TEXT NOT NULL,
 target_id TEXT NOT NULL, minimum_sar_confidence REAL NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(mission_id, investigation_id, target_id)
);
CREATE INDEX IF NOT EXISTS mission_rules_case ON mission_rules(mission_id, created_at, id);
CREATE TABLE IF NOT EXISTS mission_alerts (
 id TEXT PRIMARY KEY,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 rule_id TEXT NOT NULL, scan_id TEXT NOT NULL, target_id TEXT NOT NULL,
 minimum_sar_confidence REAL NOT NULL, sar_confidence REAL NOT NULL,
 classification TEXT, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL,
 evidence_fingerprint TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, acknowledged_at TEXT,
 UNIQUE(rule_id, scan_id, target_id)
);
CREATE INDEX IF NOT EXISTS mission_alerts_mission
 ON mission_alerts(mission_id, created_at, id);
CREATE TABLE IF NOT EXISTS mission_evaluations (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 rule_id TEXT NOT NULL, scan_id TEXT NOT NULL, target_id TEXT NOT NULL,
 status TEXT NOT NULL, reason TEXT NOT NULL, evaluated_at TEXT NOT NULL,
 evidence_fingerprint TEXT,
 PRIMARY KEY(rule_id, scan_id, target_id)
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _error(code: str, message: str, http_status: int = 404) -> HTTPException:
    return HTTPException(
        status_code=http_status,
        detail={"error": code, "status": code, "message": message},
    )


@contextmanager
def _db(data_dir: Path) -> Iterator[sqlite3.Connection]:
    data_dir.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(data_dir / "missions.sqlite3", timeout=30)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(_SCHEMA)
        with connection:
            yield connection
    finally:
        connection.close()


def _mission(connection: sqlite3.Connection, mission_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
    if row is None:
        raise _error("UNKNOWN_MISSION", "Mission not found.")
    return cast(sqlite3.Row, row)


def _rule(connection: sqlite3.Connection, mission_id: str, rule_id: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM mission_rules WHERE mission_id=? AND id=?", (mission_id, rule_id),
    ).fetchone()
    if row is None:
        raise _error("UNKNOWN_RULE", "Rule not found in this mission.")
    return cast(sqlite3.Row, row)


def _scan(state: State, scan_id: str) -> dict[str, Any] | None:
    try:
        record = state.store.get(scan_id)
    except ValueError:
        return None
    if (
        not isinstance(record, dict)
        or record.get("scan_id") != scan_id
        or record.get("runtime_mode") != "REAL"
        or record.get("synthetic") is not False
    ):
        return None
    return record


def _overlaps_mission_aoi(mission_aoi: list[float], record: dict[str, Any]) -> bool | None:
    """True if two defensible ordinary WGS84 bboxes have positive intersection.

    Unknown/malformed source AOIs return None instead of implying an overlap.
    Antimeridian-spanning AOIs must be split into ordinary bboxes first.
    """
    scan_aoi = record.get("aoi")
    if not isinstance(scan_aoi, list) or len(scan_aoi) != 4:
        return None
    if any(
        isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v)
        for v in scan_aoi
    ):
        return None
    west, south, east, north = scan_aoi
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        return None
    mw, ms, me, mn = mission_aoi
    return bool(min(east, me) > max(west, mw) and min(north, mn) > max(south, ms))


def _check_aoi_intersection(aoi: list[float], record: dict[str, Any]) -> None:
    overlapping = _overlaps_mission_aoi(aoi, record)
    if overlapping is None:
        raise _error(
            "SCAN_AOI_NOT_ESTABLISHED",
            "The stored scan has no validated non-wrapping WGS84 AOI.", 409,
        )
    if not overlapping:
        raise _error(
            "AOI_NOT_OVERLAPPING",
            "The stored scan AOI does not overlap this mission AOI.", 409,
        )


def _case_watch(data_dir: Path, case_id: str, target_id: str) -> tuple[str | None, bool]:
    """Read prior investigation database without writing or migrating its schema."""
    path = data_dir / "investigations.sqlite3"
    if not path.is_file():
        return None, False
    try:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            row = connection.execute(
                "SELECT scan_id FROM investigations WHERE id=?", (case_id,),
            ).fetchone()
            if row is None:
                return None, False
            watched = connection.execute(
                "SELECT 1 FROM investigation_watchlist WHERE investigation_id=? AND target_id=?",
                (case_id, target_id),
            ).fetchone() is not None
            return cast(str | None, row[0]), watched
        finally:
            connection.close()
    except sqlite3.Error:
        return None, False


def _rule_out(row: sqlite3.Row) -> MissionRuleOut:
    return MissionRuleOut(**dict(row))


def _alert_out(row: sqlite3.Row) -> MissionAlertOut:
    raw = dict(row)
    raw["evidence"] = json.loads(raw.pop("evidence_json"))
    return MissionAlertOut(**raw)


def _eval_out(row: sqlite3.Row) -> MissionEvaluationOut:
    return MissionEvaluationOut(**dict(row))


def _detail(connection: sqlite3.Connection, mission: sqlite3.Row) -> MissionOut:
    mid = mission["id"]
    scan_ids = [row["scan_id"] for row in connection.execute(
        "SELECT scan_id FROM mission_scans WHERE mission_id=? ORDER BY linked_at, scan_id",
        (mid,),
    )]
    rules = [_rule_out(row) for row in connection.execute(
        "SELECT * FROM mission_rules WHERE mission_id=? ORDER BY created_at, id", (mid,),
    )]
    alerts = [_alert_out(row) for row in connection.execute(
        "SELECT * FROM mission_alerts WHERE mission_id=? ORDER BY created_at DESC, id DESC",
        (mid,),
    )]
    evaluations = [_eval_out(row) for row in connection.execute(
        "SELECT * FROM mission_evaluations WHERE mission_id=? ORDER BY evaluated_at DESC, rule_id",
        (mid,),
    )]
    return MissionOut(
        id=mid, title=mission["title"], aoi=json.loads(mission["aoi_json"]),
        status=mission["status"], created_at=mission["created_at"],
        updated_at=mission["updated_at"], scan_ids=scan_ids, rules=rules,
        alerts=alerts, evaluations=evaluations,
    )


@router.get("", response_model=MissionListOut)
def list_missions(state: State) -> MissionListOut:
    with _db(state.data_dir) as connection:
        return MissionListOut(missions=[
            _detail(connection, row) for row in connection.execute(
                "SELECT * FROM missions ORDER BY created_at DESC, id DESC",
            )
        ])


@router.post("", response_model=MissionOut, status_code=status.HTTP_201_CREATED)
def create_mission(body: MissionBody, state: State) -> MissionOut:
    with _db(state.data_dir) as connection:
        mid, created = str(uuid4()), _now()
        connection.execute(
            "INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?)",
            (mid, body.title, json.dumps(body.aoi), body.status, created, created),
        )
        return _detail(connection, _mission(connection, mid))


@router.get("/{mission_id}", response_model=MissionOut)
def get_mission(mission_id: str, state: State) -> MissionOut:
    with _db(state.data_dir) as connection:
        return _detail(connection, _mission(connection, mission_id))


@router.put("/{mission_id}", response_model=MissionOut)
def replace_mission(mission_id: str, body: MissionReplace, state: State) -> MissionOut:
    with _db(state.data_dir) as connection:
        current = _mission(connection, mission_id)
        if tuple(json.loads(current["aoi_json"])) != body.aoi:
            for linked in connection.execute(
                "SELECT scan_id FROM mission_scans WHERE mission_id=?", (mission_id,),
            ):
                record = _scan(state, linked["scan_id"])
                if record is None:
                    raise _error(
                        "SCAN_AOI_NOT_ESTABLISHED",
                        "Cannot change AOI while a linked REAL scan is missing.", 409,
                    )
                _check_aoi_intersection(list(body.aoi), record)
        connection.execute(
            "UPDATE missions SET title=?, aoi_json=?, status=?, updated_at=? WHERE id=?",
            (body.title, json.dumps(body.aoi), body.status, _now(), mission_id),
        )
        return _detail(connection, _mission(connection, mission_id))


@router.delete("/{mission_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission(mission_id: str, state: State) -> None:
    with _db(state.data_dir) as connection:
        _mission(connection, mission_id)
        connection.execute("DELETE FROM missions WHERE id=?", (mission_id,))


@router.post("/{mission_id}/scans", response_model=MissionOut)
def link_real_scan(mission_id: str, body: MissionScanLink, state: State) -> MissionOut:
    with _db(state.data_dir) as connection:
        mission = _mission(connection, mission_id)
        if mission["status"] == "CLOSED":
            raise _error("MISSION_CLOSED", "Closed missions cannot add scans.", 409)
        record = _scan(state, body.scan_id)
        if record is None or record.get("stage") != "COMPLETE":
            raise _error("UNKNOWN_SCAN", "A completed persisted REAL scan is required.")
        _check_aoi_intersection(json.loads(mission["aoi_json"]), record)
        connection.execute(
            "INSERT OR IGNORE INTO mission_scans VALUES (?, ?, ?)",
            (mission_id, body.scan_id, _now()),
        )
        return _detail(connection, mission)


@router.delete("/{mission_id}/scans/{scan_id}", response_model=MissionOut)
def unlink_real_scan(mission_id: str, scan_id: str, state: State) -> MissionOut:
    with _db(state.data_dir) as connection:
        mission = _mission(connection, mission_id)
        if connection.execute(
            "SELECT 1 FROM mission_rules WHERE mission_id=? AND scan_id=?",
            (mission_id, scan_id),
        ).fetchone():
            raise _error("SCAN_HAS_RULES", "Remove mission rules before unlinking their scan.", 409)
        cursor = connection.execute(
            "DELETE FROM mission_scans WHERE mission_id=? AND scan_id=?",
            (mission_id, scan_id),
        )
        if cursor.rowcount == 0:
            raise _error("SCAN_NOT_LINKED", "Scan is not linked to this mission.")
        return _detail(connection, mission)


@router.post("/{mission_id}/rules", response_model=MissionRuleOut,
             status_code=status.HTTP_201_CREATED)
def add_watch_rule(mission_id: str, body: WatchRuleCreate, state: State) -> MissionRuleOut:
    with _db(state.data_dir) as connection:
        mission = _mission(connection, mission_id)
        if mission["status"] == "CLOSED":
            raise _error("MISSION_CLOSED", "Closed missions cannot add rules.", 409)
        scan_id, watched = _case_watch(
            state.data_dir, body.investigation_id, body.target_id,
        )
        if scan_id is None or not watched:
            raise _error("TARGET_NOT_WATCHED", "Rule requires a persisted investigation watch entry.", 409)
        if connection.execute(
            "SELECT 1 FROM mission_scans WHERE mission_id=? AND scan_id=?",
            (mission_id, scan_id),
        ).fetchone() is None:
            raise _error("SCAN_NOT_LINKED", "Link the investigation's scan to this mission first.", 409)
        record = _scan(state, scan_id)
        if record is None or record.get("stage") != "COMPLETE":
            raise _error("UNKNOWN_SCAN", "Linked investigation scan is not persisted REAL.")
        # Do not manufacture a target if the watch was preserved after a
        # corrupted/replaced scan: require recorded target identity.
        if not any(
            isinstance(t, dict) and t.get("id") == body.target_id
            for t in record.get("targets") or []
        ):
            raise _error("UNKNOWN_TARGET", "Watched target is absent from stored scan.")
        rule_id, created = str(uuid4()), _now()
        try:
            connection.execute(
                "INSERT INTO mission_rules VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rule_id, mission_id, body.investigation_id, scan_id,
                 body.target_id, body.minimum_sar_confidence, created),
            )
        except sqlite3.IntegrityError as exc:
            raise _error("DUPLICATE_RULE", "A rule for this case and target already exists.", 409) from exc
        return _rule_out(_rule(connection, mission_id, rule_id))


@router.delete("/{mission_id}/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_watch_rule(mission_id: str, rule_id: str, state: State) -> None:
    with _db(state.data_dir) as connection:
        _rule(connection, mission_id, rule_id)
        # Existing alerts/evaluation are retained as historical outcomes.
        connection.execute(
            "DELETE FROM mission_rules WHERE mission_id=? AND id=?", (mission_id, rule_id),
        )


@router.post("/{mission_id}/evaluate", response_model=EvaluationRunOut)
def evaluate_mission(mission_id: str, state: State) -> EvaluationRunOut:
    with _db(state.data_dir) as connection:
        mission = _mission(connection, mission_id)
        if mission["status"] != "ACTIVE":
            raise _error("MISSION_NOT_ACTIVE", "Only ACTIVE missions can evaluate historical rules.", 409)
        rules = connection.execute(
            "SELECT * FROM mission_rules WHERE mission_id=? ORDER BY created_at, id", (mission_id,),
        ).fetchall()
        outcomes: list[MissionEvaluationOut] = []
        created_count = existing_count = unavailable_count = 0
        for rule in rules:
            scan_id, watched = _case_watch(
                state.data_dir, rule["investigation_id"], rule["target_id"],
            )
            if scan_id != rule["scan_id"] or not watched:
                finding_status: EvaluationStatus = "NOT_EVALUATED"
                reason = "WATCHLIST_EVIDENCE_UNAVAILABLE"
                fingerprint = None
                finding = None
            elif connection.execute(
                "SELECT 1 FROM mission_scans WHERE mission_id=? AND scan_id=?",
                (mission_id, scan_id),
            ).fetchone() is None:
                finding_status = "NOT_EVALUATED"
                reason = "MISSION_SCAN_NOT_LINKED"
                fingerprint = None
                finding = None
            else:
                finding = evaluate_sar_watch(
                    rule["scan_id"], _scan(state, rule["scan_id"]),
                    rule["target_id"], rule["minimum_sar_confidence"],
                )
                finding_status = finding.status
                reason = finding.reason
                fingerprint = finding.evidence_fingerprint
                previous = connection.execute(
                    "SELECT evidence_fingerprint FROM mission_alerts "
                    "WHERE rule_id=? AND scan_id=? AND target_id=?",
                    (rule["id"], rule["scan_id"], rule["target_id"]),
                ).fetchone()
                if (
                    previous is not None
                    and fingerprint is not None
                    and previous["evidence_fingerprint"] != fingerprint
                ):
                    finding_status = "NOT_EVALUATED"
                    reason = "SOURCE_EVIDENCE_CHANGED_AFTER_ALERT"
                    # Preserve the old alert as historical evidence, but do
                    # not label the changed source as an idempotent repeat.
            evaluated = _now()
            connection.execute(
                "INSERT INTO mission_evaluations "
                "(mission_id, rule_id, scan_id, target_id, status, reason, "
                "evaluated_at, evidence_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(rule_id, scan_id, target_id) DO UPDATE SET "
                "status=excluded.status, reason=excluded.reason, "
                "evaluated_at=excluded.evaluated_at, "
                "evidence_fingerprint=excluded.evidence_fingerprint",
                (mission_id, rule["id"], rule["scan_id"], rule["target_id"],
                 finding_status, reason, evaluated, fingerprint),
            )
            outcomes.append(MissionEvaluationOut(
                mission_id=mission_id, rule_id=rule["id"],
                scan_id=rule["scan_id"], target_id=rule["target_id"],
                status=finding_status, reason=reason, evaluated_at=evaluated,
                evidence_fingerprint=fingerprint,
            ))
            if finding_status == "NOT_EVALUATED":
                unavailable_count += 1
                continue
            if finding_status != "TRIGGERED" or finding is None:
                continue
            assert finding.evidence is not None and finding.evidence_fingerprint is not None
            assert finding.sar_confidence is not None
            cursor = connection.execute(
                "INSERT OR IGNORE INTO mission_alerts "
                "(id, mission_id, rule_id, scan_id, target_id, minimum_sar_confidence, "
                "sar_confidence, classification, rationale, evidence_json, "
                "evidence_fingerprint, status, created_at, acknowledged_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL)",
                (str(uuid4()), mission_id, rule["id"], rule["scan_id"], rule["target_id"],
                 rule["minimum_sar_confidence"], finding.sar_confidence,
                 finding.classification, finding.reason,
                 json.dumps(finding.evidence, sort_keys=True),
                 finding.evidence_fingerprint, evaluated),
            )
            if cursor.rowcount:
                created_count += 1
            else:
                existing_count += 1
        return EvaluationRunOut(
            mission_id=mission_id, evaluations=outcomes,
            alerts_created=created_count, existing_alerts=existing_count,
            not_evaluated=unavailable_count,
        )


@router.post("/{mission_id}/alerts/{alert_id}/ack", response_model=MissionAlertOut)
def acknowledge_alert(mission_id: str, alert_id: str, state: State) -> MissionAlertOut:
    with _db(state.data_dir) as connection:
        _mission(connection, mission_id)
        row = connection.execute(
            "SELECT * FROM mission_alerts WHERE mission_id=? AND id=?",
            (mission_id, alert_id),
        ).fetchone()
        if row is None:
            raise _error("UNKNOWN_ALERT", "Alert does not exist in this mission.")
        if row["status"] == "OPEN":
            connection.execute(
                "UPDATE mission_alerts SET status='ACKNOWLEDGED', acknowledged_at=? "
                "WHERE mission_id=? AND id=? AND status='OPEN'",
                (_now(), mission_id, alert_id),
            )
        refreshed = connection.execute(
            "SELECT * FROM mission_alerts WHERE mission_id=? AND id=?",
            (mission_id, alert_id),
        ).fetchone()
        assert refreshed is not None
        return _alert_out(refreshed)
