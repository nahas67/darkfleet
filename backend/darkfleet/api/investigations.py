"""Durable analyst investigations attached to real, persisted scan evidence.

Investigations and analyst assertions are separate from measured scan records:
the former can be edited, while the latter remains the original immutable evidence.
SQLite transactions make case/annotation/watch operations restart-safe.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, cast
from uuid import uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, StringConstraints

from darkfleet.api.routes import State
from darkfleet.investigation_geometry import GeometryInput, Measurements, measure_geometry

__all__ = ["router"]

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class InvestigationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title
    scan_id: Identifier | None = None


class AnnotationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: Note
    target_id: Identifier | None = None


class WatchEntryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_id: Identifier


class AnnotationOut(BaseModel):
    id: str
    investigation_id: str
    content: str
    target_id: str | None
    created_at: str


class WatchEntryOut(BaseModel):
    id: str
    investigation_id: str
    target_id: str
    created_at: str


class InvestigationOut(BaseModel):
    id: str
    title: str
    scan_id: str | None
    aoi: list[float] | None
    created_at: str
    annotations: list[AnnotationOut]
    watchlist: list[WatchEntryOut]


class InvestigationListOut(BaseModel):
    investigations: list[InvestigationOut]


class GeometryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: Title
    notes: Annotated[str, StringConstraints(max_length=4000)] = ""
    geometry: GeometryInput


class GeometryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    investigation_id: str
    scan_id: str | None
    provenance: str = "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE"
    label: str
    notes: str
    geometry: GeometryInput
    measurements: Measurements
    created_at: str
    updated_at: str


class GeometryListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    geometries: list[GeometryOut]


router = APIRouter(prefix="/api/investigations", tags=["investigations"])

_SCHEMA = """
CREATE TABLE IF NOT EXISTS investigations (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 scan_id TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS investigation_annotations (
 id TEXT PRIMARY KEY,
 investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
 content TEXT NOT NULL,
 target_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS investigation_annotations_case
 ON investigation_annotations (investigation_id, created_at, id);
CREATE TABLE IF NOT EXISTS investigation_watchlist (
 id TEXT PRIMARY KEY,
 investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(investigation_id, target_id)
);
-- DF-X16 additive migration: no changes to existing notes, watchlist or cases.
CREATE TABLE IF NOT EXISTS investigation_geometries (
 id TEXT PRIMARY KEY,
 investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
 label TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 geometry_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS investigation_geometries_case
 ON investigation_geometries (investigation_id, created_at, id);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


@contextmanager
def _database(data_dir: Path) -> Iterator[sqlite3.Connection]:
    path = data_dir / "investigations.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(_SCHEMA)
        # The pre-DF-X16 database has user_version=0. This idempotent additive
        # migration runs even for databases created by the original notebook.
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version < 2:
            connection.execute("PRAGMA user_version=2")
        with connection:
            yield connection
    finally:
        connection.close()


def _missing() -> HTTPException:
    return HTTPException(status_code=404, detail={
        "error": "UNKNOWN_INVESTIGATION",
        "status": "UNKNOWN_INVESTIGATION",
        "message": "Investigation record does not exist.",
    })


def _case(connection: sqlite3.Connection, case_id: str) -> sqlite3.Row:
    case = connection.execute(
        "SELECT * FROM investigations WHERE id=?", (case_id,)
    ).fetchone()
    if case is None:
        raise _missing()
    return cast(sqlite3.Row, case)


def _real_scan(state: State, scan_id: str) -> dict[str, Any]:
    try:
        record = state.store.get(scan_id)
    except ValueError:
        record = None
    if record is None or record.get("runtime_mode") != "REAL" or record.get("synthetic") is not False:
        raise HTTPException(status_code=404, detail={
            "error": "UNKNOWN_SCAN", "status": "UNKNOWN_SCAN",
            "message": "A completed, persisted REAL scan is required.",
        })
    return record


def _real_target(record: dict[str, Any], target_id: str) -> None:
    if not any(
        isinstance(item, dict) and item.get("id") == target_id
        for item in record.get("targets") or []
    ):
        raise HTTPException(status_code=404, detail={
            "error": "UNKNOWN_TARGET", "status": "UNKNOWN_TARGET",
            "message": "The selected target is absent from this persisted scan.",
        })


def _detail(connection: sqlite3.Connection, case: sqlite3.Row, state: State) -> InvestigationOut:
    notes = connection.execute(
        "SELECT * FROM investigation_annotations WHERE investigation_id=? "
        "ORDER BY created_at, id", (case["id"],)
    ).fetchall()
    watched = connection.execute(
        "SELECT * FROM investigation_watchlist WHERE investigation_id=? "
        "ORDER BY created_at, id", (case["id"],)
    ).fetchall()
    scan_id: str | None = case["scan_id"]
    aoi: list[float] | None = None
    if scan_id:
        try:
            record = state.store.get(scan_id)
        except ValueError:
            record = None
        if record is not None and record.get("runtime_mode") == "REAL" and record.get("synthetic") is False:
            values = record.get("aoi")
            if (isinstance(values, list) and len(values) == 4
                    and all(isinstance(v, (int, float)) for v in values)):
                aoi = [float(v) for v in values]
    return InvestigationOut(
        id=case["id"], title=case["title"], scan_id=scan_id,
        aoi=aoi, created_at=case["created_at"],
        annotations=[AnnotationOut(**dict(row)) for row in notes],
        watchlist=[WatchEntryOut(**dict(row)) for row in watched],
    )


@router.get("", response_model=InvestigationListOut)
def list_investigations(state: State) -> InvestigationListOut:
    with _database(state.data_dir) as connection:
        rows = connection.execute(
            "SELECT * FROM investigations ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return InvestigationListOut(
            investigations=[_detail(connection, row, state) for row in rows]
        )


@router.post("", response_model=InvestigationOut, status_code=status.HTTP_201_CREATED)
def create_investigation(body: InvestigationCreate, state: State) -> InvestigationOut:
    if body.scan_id:
        _real_scan(state, body.scan_id)
    with _database(state.data_dir) as connection:
        case_id = str(uuid4())
        connection.execute(
            "INSERT INTO investigations (id, title, scan_id, created_at) VALUES (?, ?, ?, ?)",
            (case_id, body.title, body.scan_id, _now()),
        )
        return _detail(connection, _case(connection, case_id), state)


@router.get("/{case_id}", response_model=InvestigationOut)
def get_investigation(case_id: str, state: State) -> InvestigationOut:
    with _database(state.data_dir) as connection:
        return _detail(connection, _case(connection, case_id), state)


@router.delete("/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_investigation(case_id: str, state: State) -> None:
    with _database(state.data_dir) as connection:
        _case(connection, case_id)
        connection.execute("DELETE FROM investigations WHERE id=?", (case_id,))


@router.post("/{case_id}/annotations", response_model=AnnotationOut,
             status_code=status.HTTP_201_CREATED)
def add_annotation(case_id: str, body: AnnotationCreate, state: State) -> AnnotationOut:
    with _database(state.data_dir) as connection:
        case = _case(connection, case_id)
        if body.target_id:
            if case["scan_id"] is None:
                raise HTTPException(status_code=409, detail={
                    "error": "SCAN_REQUIRED", "status": "SCAN_REQUIRED",
                    "message": "Target-specific annotations require a linked scan.",
                })
            _real_target(_real_scan(state, case["scan_id"]), body.target_id)
        note_id, created = str(uuid4()), _now()
        connection.execute(
            "INSERT INTO investigation_annotations VALUES (?, ?, ?, ?, ?)",
            (note_id, case_id, body.content, body.target_id, created),
        )
        return AnnotationOut(id=note_id, investigation_id=case_id,
                             content=body.content, target_id=body.target_id,
                             created_at=created)


@router.delete("/{case_id}/annotations/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(case_id: str, note_id: str, state: State) -> None:
    with _database(state.data_dir) as connection:
        _case(connection, case_id)
        cursor = connection.execute(
            "DELETE FROM investigation_annotations WHERE investigation_id=? AND id=?",
            (case_id, note_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail={
                "error": "UNKNOWN_ANNOTATION", "status": "UNKNOWN_ANNOTATION",
                "message": "Annotation does not exist in this investigation.",
            })


@router.post("/{case_id}/watchlist", response_model=WatchEntryOut,
             status_code=status.HTTP_201_CREATED)
def add_watch_entry(case_id: str, body: WatchEntryCreate, state: State) -> WatchEntryOut:
    with _database(state.data_dir) as connection:
        case = _case(connection, case_id)
        if case["scan_id"] is None:
            raise HTTPException(status_code=409, detail={
                "error": "SCAN_REQUIRED", "status": "SCAN_REQUIRED",
                "message": "Watch entries require a linked, persisted scan.",
            })
        _real_target(_real_scan(state, case["scan_id"]), body.target_id)
        entry_id, created = str(uuid4()), _now()
        try:
            connection.execute(
                "INSERT INTO investigation_watchlist VALUES (?, ?, ?, ?)",
                (entry_id, case_id, body.target_id, created),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail={
                "error": "ALREADY_WATCHED", "status": "ALREADY_WATCHED",
                "message": "This target is already on the investigation watchlist.",
            }) from exc
        return WatchEntryOut(id=entry_id, investigation_id=case_id,
                             target_id=body.target_id, created_at=created)


@router.delete("/{case_id}/watchlist/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_watch_entry(case_id: str, entry_id: str, state: State) -> None:
    with _database(state.data_dir) as connection:
        _case(connection, case_id)
        cursor = connection.execute(
            "DELETE FROM investigation_watchlist WHERE investigation_id=? AND id=?",
            (case_id, entry_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail={
                "error": "UNKNOWN_WATCH_ENTRY", "status": "UNKNOWN_WATCH_ENTRY",
                "message": "Watchlist entry does not exist in this investigation.",
            })


def _geo_missing() -> HTTPException:
    return HTTPException(status_code=404, detail={
        "error": "UNKNOWN_GEOMETRY", "status": "UNKNOWN_GEOMETRY",
        "message": "Geometry does not exist in this investigation.",
    })


def _geometry_row(connection: sqlite3.Connection, case_id: str, geo_id: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM investigation_geometries WHERE investigation_id=? AND id=?",
        (case_id, geo_id),
    ).fetchone()
    if row is None:
        raise _geo_missing()
    return cast(sqlite3.Row, row)


def _geometry_out(row: sqlite3.Row, case: sqlite3.Row) -> GeometryOut:
    geometry = GeometryInput.model_validate(json.loads(row["geometry_json"]))
    return GeometryOut(
        id=row["id"], investigation_id=case["id"], scan_id=case["scan_id"],
        label=row["label"], notes=row["notes"], geometry=geometry,
        measurements=measure_geometry(geometry), created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.get("/{case_id}/geometries", response_model=GeometryListOut)
def list_case_geometries(case_id: str, state: State) -> GeometryListOut:
    with _database(state.data_dir) as connection:
        case = _case(connection, case_id)
        rows = connection.execute(
            "SELECT * FROM investigation_geometries WHERE investigation_id=? "
            "ORDER BY created_at, id", (case_id,),
        ).fetchall()
        return GeometryListOut(geometries=[_geometry_out(row, case) for row in rows])


@router.post("/{case_id}/geometries", response_model=GeometryOut,
             status_code=status.HTTP_201_CREATED)
def create_case_geometry(case_id: str, body: GeometryCreate, state: State) -> GeometryOut:
    # Source scan is fixed at CASE creation; no arbitrary scan_id or coordinate
    # can be supplied as measured SAR evidence. An unlinked case is permitted.
    measure_geometry(body.geometry)  # Validate physical metrics before persistence.
    with _database(state.data_dir) as connection:
        case = _case(connection, case_id)
        if case["scan_id"] is not None:
            _real_scan(state, case["scan_id"])
        geo_id, created = str(uuid4()), _now()
        connection.execute(
            "INSERT INTO investigation_geometries "
            "(id, investigation_id, label, notes, geometry_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (geo_id, case_id, body.label, body.notes,
             body.geometry.model_dump_json(), created, created),
        )
        return _geometry_out(_geometry_row(connection, case_id, geo_id), case)


@router.get("/{case_id}/geometries/{geo_id}", response_model=GeometryOut)
def get_case_geometry(case_id: str, geo_id: str, state: State) -> GeometryOut:
    with _database(state.data_dir) as connection:
        case = _case(connection, case_id)
        return _geometry_out(_geometry_row(connection, case_id, geo_id), case)


@router.put("/{case_id}/geometries/{geo_id}", response_model=GeometryOut)
def replace_case_geometry(
    case_id: str, geo_id: str, body: GeometryCreate, state: State,
) -> GeometryOut:
    measure_geometry(body.geometry)
    with _database(state.data_dir) as connection:
        case = _case(connection, case_id)
        _geometry_row(connection, case_id, geo_id)
        if case["scan_id"] is not None:
            _real_scan(state, case["scan_id"])
        connection.execute(
            "UPDATE investigation_geometries "
            "SET label=?, notes=?, geometry_json=?, updated_at=? WHERE id=? AND investigation_id=?",
            (body.label, body.notes, body.geometry.model_dump_json(), _now(), geo_id, case_id),
        )
        return _geometry_out(_geometry_row(connection, case_id, geo_id), case)


@router.delete("/{case_id}/geometries/{geo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_case_geometry(case_id: str, geo_id: str, state: State) -> None:
    with _database(state.data_dir) as connection:
        _case(connection, case_id)
        cursor = connection.execute(
            "DELETE FROM investigation_geometries WHERE id=? AND investigation_id=?",
            (geo_id, case_id),
        )
        if cursor.rowcount == 0:
            raise _geo_missing()
