"""Saved investigation view snapshots with durable, evidence-scoped restoration.

The snapshot contains operator presentation choices only. It cannot alter the
stored SAR/AIS evidence or supply credentials, arbitrary URLs or provider data.
Missing scans and annotations are retained as explicit restoration diagnostics.
"""

from __future__ import annotations

import math
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal, cast
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

from darkfleet.api.routes import State

__all__ = ["router"]

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
SourceId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.-]{1,64}$")]


class CameraPosition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def plausible_world_position(self) -> CameraPosition:
        radius = math.hypot(self.x, self.y, self.z)
        if radius < 6_000_000 or radius > 2_000_000_000:
            raise ValueError("Camera must be a plausible Earth-centered position.")
        return self


class CameraSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: CameraPosition
    heading: float = Field(ge=-7, le=7, allow_inf_nan=False)
    pitch: float = Field(ge=-7, le=7, allow_inf_nan=False)
    roll: float = Field(ge=-7, le=7, allow_inf_nan=False)


class LayerChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visible: bool
    opacity: float = Field(ge=0, le=1, allow_inf_nan=False)


class TargetChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_id: Identifier
    target_id: Identifier


class ContactChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mmsi: str = Field(pattern=r"^[0-9]{9}$")
    observation_at: datetime | None = None


class Snapshot(BaseModel):
    """Strict allowlist: secrets, tokens, and entire scene records cannot be serialized."""

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    camera: CameraSnapshot | None = None
    map_source_id: SourceId | None = None
    layers: dict[str, LayerChoice] = Field(default_factory=dict, max_length=40)
    scan_id: Identifier | None = None
    target: TargetChoice | None = None
    contact: ContactChoice | None = None
    playback_at: datetime | None = None
    playback_speed: float = Field(default=1, ge=0.25, le=10, allow_inf_nan=False)
    workspace: Literal[
        "TACTICAL", "SEARCH", "INTELLIGENCE", "TASKING", "LAYERS",
        "ANALYTICS", "ADVANCED", "REPORTS", "SYSTEM", "VIEWS",
    ] = "TACTICAL"
    aoi: tuple[float, float, float, float] | None = None
    investigation_id: Identifier | None = None

    @field_validator("playback_speed")
    @classmethod
    def supported_playback_speed(cls, value: float) -> float:
        if value not in (0.25, 0.5, 1, 2, 5, 10):
            raise ValueError("Playback speed must be one of the supported transport rates.")
        return value

    @model_validator(mode="after")
    def coherent(self) -> Snapshot:
        for name in self.layers:
            if not name.isascii() or not name.replace("_", "").isalnum() or len(name) > 64:
                raise ValueError("A layer key must be a short alphanumeric registry name.")
        if self.target and self.target.scan_id != self.scan_id:
            raise ValueError("Selected SAR target must belong to the saved scan.")
        if self.target and self.scan_id is None:
            raise ValueError("A SAR target requires its source scan.")
        if self.aoi is not None:
            west, south, east, north = self.aoi
            if not all(math.isfinite(v) for v in self.aoi):
                raise ValueError("AOI must have finite numeric corners.")
            if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
                raise ValueError("AOI bounds must be ordered WGS84 coordinates.")
        return self


class ViewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title
    snapshot: Snapshot


class ViewReplace(ViewCreate):
    expected_revision: int = Field(ge=1)


class SavedViewOut(BaseModel):
    id: str
    title: str
    revision: int
    created_at: str
    updated_at: str
    snapshot: Snapshot | None
    status: Literal["OK", "CORRUPT"]
    missing_resources: list[str]


class SavedViewsOut(BaseModel):
    views: list[SavedViewOut]
    count: int


router = APIRouter(prefix="/api/views", tags=["saved-views"])

_SCHEMA = """
CREATE TABLE IF NOT EXISTS saved_views (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 state_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_views_recent ON saved_views(updated_at DESC, id DESC);
"""


@contextmanager
def _db(directory: Path) -> Iterator[sqlite3.Connection]:
    directory.mkdir(parents=True, exist_ok=True)
    # Deliberately share the durable analyst SQLite database with investigations,
    # so backing up a workspace cannot omit views while retaining its annotations.
    connection = sqlite3.connect(directory / "investigations.sqlite3", timeout=30)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(_SCHEMA)
        with connection:
            yield connection
    finally:
        connection.close()


def _not_found() -> HTTPException:
    return HTTPException(404, detail={
        "error": "UNKNOWN_VIEW", "status": "UNKNOWN_VIEW",
        "message": "This saved view does not exist.",
    })


def _row(conn: sqlite3.Connection, view_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM saved_views WHERE id=?", (view_id,)).fetchone()
    if row is None:
        raise _not_found()
    return cast(sqlite3.Row, row)


def _check_source(state: State, snapshot: Snapshot) -> None:
    if snapshot.scan_id is None:
        return
    try:
        scan = state.store.get(snapshot.scan_id)
    except ValueError:
        scan = None
    if scan is None or scan.get("runtime_mode") != "REAL" or scan.get("synthetic") is not False:
        raise HTTPException(404, detail={
            "error": "UNKNOWN_SCAN", "status": "UNKNOWN_SCAN",
            "message": "A saved view cannot claim an unavailable or unverified scan.",
        })
    if snapshot.target is not None and not any(
        isinstance(target, dict) and target.get("id") == snapshot.target.target_id
        for target in scan.get("targets") or []
    ):
        raise HTTPException(404, detail={
            "error": "UNKNOWN_TARGET", "status": "UNKNOWN_TARGET",
            "message": "The SAR target is not present in this persisted scan.",
        })


def _missing_resources(state: State, snapshot: Snapshot, conn: sqlite3.Connection) -> list[str]:
    missing: list[str] = []
    if snapshot.scan_id:
        try:
            source = state.store.get(snapshot.scan_id)
        except ValueError:
            source = None
        if source is None or source.get("runtime_mode") != "REAL" or source.get("synthetic") is not False:
            missing.append("SCAN_MISSING")
        elif snapshot.target and not any(
            isinstance(target, dict) and target.get("id") == snapshot.target.target_id
            for target in source.get("targets") or []
        ):
            missing.append("TARGET_MISSING")
    if snapshot.investigation_id:
        has_cases = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='investigations'"
        ).fetchone() is not None
        if not has_cases or conn.execute(
            "SELECT 1 FROM investigations WHERE id=?", (snapshot.investigation_id,)
        ).fetchone() is None:
            missing.append("INVESTIGATION_MISSING")
    return missing


def _out(state: State, conn: sqlite3.Connection, row: sqlite3.Row) -> SavedViewOut:
    try:
        snapshot = Snapshot.model_validate_json(row["state_json"])
    except (ValidationError, ValueError):
        return SavedViewOut(
            id=row["id"], title=row["title"], revision=row["revision"],
            created_at=row["created_at"], updated_at=row["updated_at"],
            snapshot=None, status="CORRUPT", missing_resources=["INVALID_VIEW_RECORD"],
        )
    return SavedViewOut(
        id=row["id"], title=row["title"], revision=row["revision"],
        created_at=row["created_at"], updated_at=row["updated_at"],
        snapshot=snapshot, status="OK",
        missing_resources=_missing_resources(state, snapshot, conn),
    )


@router.get("", response_model=SavedViewsOut)
def list_views(state: State, limit: Annotated[int, Query(ge=1, le=200)] = 100) -> SavedViewsOut:
    with _db(state.data_dir) as conn:
        rows = conn.execute(
            "SELECT * FROM saved_views ORDER BY updated_at DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
        views = [_out(state, conn, row) for row in rows]
        return SavedViewsOut(views=views, count=len(views))


@router.post("", response_model=SavedViewOut, status_code=201)
def create_view(body: ViewCreate, state: State) -> SavedViewOut:
    _check_source(state, body.snapshot)
    view_id = str(uuid4())
    now = datetime.now(UTC).isoformat()
    with _db(state.data_dir) as conn:
        conn.execute(
            "INSERT INTO saved_views (id,title,revision,state_json,created_at,updated_at) "
            "VALUES (?,?,1,?,?,?)",
            (view_id, body.title, body.snapshot.model_dump_json(), now, now),
        )
        return _out(state, conn, _row(conn, view_id))


@router.get("/{view_id}", response_model=SavedViewOut)
def get_view(view_id: str, state: State) -> SavedViewOut:
    with _db(state.data_dir) as conn:
        return _out(state, conn, _row(conn, view_id))


@router.put("/{view_id}", response_model=SavedViewOut)
def replace_view(view_id: str, body: ViewReplace, state: State) -> SavedViewOut:
    _check_source(state, body.snapshot)
    with _db(state.data_dir) as conn:
        current = _row(conn, view_id)
        if current["revision"] != body.expected_revision:
            raise HTTPException(409, detail={
                "error": "VIEW_REVISION_CONFLICT", "status": "VIEW_REVISION_CONFLICT",
                "message": "This view was updated elsewhere. Reload before saving.",
            })
        now = datetime.now(UTC).isoformat()
        cursor = conn.execute(
            "UPDATE saved_views SET title=?, state_json=?, revision=revision+1, updated_at=? "
            "WHERE id=? AND revision=?",
            (body.title, body.snapshot.model_dump_json(), now, view_id, body.expected_revision),
        )
        if cursor.rowcount != 1:
            raise HTTPException(409, detail={
                "error": "VIEW_REVISION_CONFLICT", "status": "VIEW_REVISION_CONFLICT",
                "message": "This view was updated concurrently. Reload before saving.",
            })
        return _out(state, conn, _row(conn, view_id))


@router.delete("/{view_id}", status_code=204)
def delete_view(view_id: str, state: State) -> None:
    with _db(state.data_dir) as conn:
        _row(conn, view_id)
        conn.execute("DELETE FROM saved_views WHERE id=?", (view_id,))
