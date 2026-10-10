"""Durable local operator *presentation* preferences, never runtime configuration.

This router does not read or write pydantic Settings, credentials, providers,
network permissions, detection thresholds, or risk controls. Its complete and
exclusive schema is three display-only booleans. SQLite BEGIN IMMEDIATE gives
atomic writes and cross-process optimistic revision checks on the owning data root.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from darkfleet.api.routes import State

router = APIRouter(prefix="/api/operator-settings", tags=["operator-settings"])

_DB_NAME = "operator_settings.sqlite3"


class PresentationPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    show_provider_details: StrictBool = True
    show_keyboard_reference: StrictBool = True
    show_provenance_summary: StrictBool = True


class OperatorSettingsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=0)
    preferences: PresentationPreferences


class ReplaceOperatorSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: StrictInt = Field(ge=0)
    preferences: PresentationPreferences


class ResetOperatorSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: StrictInt = Field(ge=0)


def _connection(directory: Path) -> sqlite3.Connection:
    # Uses ApiState's bound data_dir; never an arbitrary path from the request.
    directory.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(directory / _DB_NAME, timeout=15)
    try:
        connection.execute("PRAGMA busy_timeout=15000")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS operator_presentation_settings (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              revision INTEGER NOT NULL CHECK(revision >= 1),
              preferences_json TEXT NOT NULL
            )
        """)
    except BaseException:
        connection.close()
        raise
    return connection


def _current(connection: sqlite3.Connection) -> OperatorSettingsOut:
    row = connection.execute(
        "SELECT revision, preferences_json FROM operator_presentation_settings WHERE singleton=1"
    ).fetchone()
    if row is None:
        return OperatorSettingsOut(revision=0, preferences=PresentationPreferences())
    # A corrupt record is not silently replaced with defaults (which would hide
    # operator intent or allow clobbering an earlier revision).
    return OperatorSettingsOut(
        revision=row[0],
        preferences=PresentationPreferences.model_validate(json.loads(row[1])),
    )


def _conflict(current: int) -> HTTPException:
    return HTTPException(status_code=409, detail={
        "error": "OPERATOR_SETTINGS_REVISION_CONFLICT",
        "status": "OPERATOR_SETTINGS_REVISION_CONFLICT",
        "message": "Operator settings changed in another session. Reload before saving.",
        "current_revision": current,
    })


@router.get("", response_model=OperatorSettingsOut)
def get_operator_settings(state: State) -> OperatorSettingsOut:
    connection = _connection(state.data_dir)
    try:
        return _current(connection)
    finally:
        connection.close()


def _replace(directory: Path, expected_revision: int,
             preferences: PresentationPreferences) -> OperatorSettingsOut:
    connection = _connection(directory)
    try:
        # SQLite serializes writers across processes. Read+compare+write occur
        # in ONE write transaction; a stale second writer gets 409, not last-wins.
        connection.execute("BEGIN IMMEDIATE")
        current = _current(connection)
        if current.revision != expected_revision:
            raise _conflict(current.revision)
        new_revision = current.revision + 1
        connection.execute("""
            INSERT INTO operator_presentation_settings
                (singleton, revision, preferences_json) VALUES (1, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                revision=excluded.revision,
                preferences_json=excluded.preferences_json
        """, (new_revision, preferences.model_dump_json()))
        connection.commit()
        return OperatorSettingsOut(revision=new_revision, preferences=preferences)
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


@router.put("", response_model=OperatorSettingsOut)
def replace_operator_settings(body: ReplaceOperatorSettings, state: State) -> OperatorSettingsOut:
    return _replace(state.data_dir, body.expected_revision, body.preferences)


@router.post("/reset", response_model=OperatorSettingsOut)
def reset_operator_settings(body: ResetOperatorSettings, state: State) -> OperatorSettingsOut:
    # Reset is a true persisted revision, not a local-only checkbox re-render.
    return _replace(state.data_dir, body.expected_revision, PresentationPreferences())
