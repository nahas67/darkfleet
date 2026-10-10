"""Bounded operator-authored case binary evidence; never sensor provenance.

Store bytes inside SQLite, in the *same transaction* as their metadata. There
are no user-derived disk paths, no symlinks to follow, no URL fetches, and no
partial file / receipt pairs to reconcile after an interrupted write. SQLite's
BEGIN IMMEDIATE serializes per-case quotas across independent API processes.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi import Path as ApiPath
from pydantic import BaseModel, ConfigDict, Field

from darkfleet.api.routes import State

MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
MAX_ATTACHMENTS_PER_CASE = 32
MAX_CASE_BYTES = 64 * 1024 * 1024
PROVENANCE = "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE"

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,119}$", re.ASCII)
_ID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_MIME: dict[str, str] = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
}


class AttachmentOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    investigation_id: str
    filename: str
    media_type: str
    size_bytes: int = Field(gt=0, le=MAX_ATTACHMENT_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: str
    provenance: Literal["OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE"] = PROVENANCE
    download_url: str


class AttachmentsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attachments: list[AttachmentOut]
    count: int


router = APIRouter(prefix="/{case_id}/attachments", tags=["investigation-attachments"])


def _error(code: int, name: str, description: str) -> HTTPException:
    return HTTPException(status_code=code, detail={
        "error": name, "status": name, "message": description,
    })


def _valid_name(name: str) -> tuple[str, str]:
    if (
        not _NAME.fullmatch(name) or ".." in name or
        name.endswith((".", " ")) or
        Path(name).stem.upper() in {"CON", "PRN", "NUL", "AUX", "COM1", "LPT1"}
    ):
        raise _error(
            422, "INVALID_ATTACHMENT_FILENAME",
            "Use a safe ASCII filename (1–120 characters) with an allowed extension.",
        )
    suffix = Path(name).suffix.lower()
    if suffix not in _MIME:
        raise _error(
            415, "ATTACHMENT_TYPE_UNSUPPORTED",
            "Allowed types: PDF, PNG, JPEG, TXT, CSV, JSON.",
        )
    return name, _MIME[suffix]


def _content_type(filename: str, declared: str) -> str:
    _, expected = _valid_name(filename)
    reported = declared.partition(";")[0].strip().lower()
    if reported not in (expected, "application/octet-stream"):
        raise _error(
            415, "ATTACHMENT_TYPE_MISMATCH",
            "Declared media type does not match the safe filename extension.",
        )
    return expected


def _check_magic(contents: bytes, media_type: str) -> None:
    magic: dict[str, bytes] = {
        "application/pdf": b"%PDF-",
        "image/png": b"\x89PNG\r\n\x1a\n",
        "image/jpeg": b"\xff\xd8\xff",
    }
    prefix = magic.get(media_type)
    if prefix is not None and not contents.startswith(prefix):
        raise _error(
            422, "ATTACHMENT_CONTENT_INVALID",
            "The binary signature does not match the claimed format.",
        )
    if media_type in {"text/plain", "text/csv", "application/json"}:
        try:
            decoded = contents.decode("utf-8")
            if "\x00" in decoded:
                raise ValueError("NUL bytes")
            if media_type == "application/json":
                json.loads(decoded)
        except (UnicodeDecodeError, ValueError) as exc:
            raise _error(
                422, "ATTACHMENT_CONTENT_INVALID",
                "Text/JSON attachment is not valid UTF-8 content.",
            ) from exc


def _out(case_id: str, row: sqlite3.Row) -> AttachmentOut:
    attachment_id = str(row["id"])
    return AttachmentOut(
        id=attachment_id,
        investigation_id=case_id,
        filename=str(row["filename"]),
        media_type=str(row["media_type"]),
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
        created_at=str(row["created_at"]),
        download_url=f"/api/investigations/{case_id}/attachments/{attachment_id}/content",
    )


def _case_lookup(connection: sqlite3.Connection, case_id: str) -> None:
    # Use the same error and authoritative case ledger as notebook operations.
    from darkfleet.api.investigations import _case

    _case(connection, case_id)


def _database(data_dir: Path):
    from darkfleet.api.investigations import _database

    return _database(data_dir)


def _entry(connection: sqlite3.Connection, case_id: str, aid: str, *, blob: bool = False) -> sqlite3.Row:
    fields = "*" if blob else "id,investigation_id,filename,media_type,size_bytes,sha256,created_at"
    row = connection.execute(
        f"SELECT {fields} FROM investigation_attachments WHERE investigation_id=? AND id=?",
        (case_id, aid),
    ).fetchone()
    if row is None:
        raise _error(404, "UNKNOWN_ATTACHMENT", "Attachment is absent from this investigation.")
    return row


@router.post("", response_model=AttachmentOut, status_code=201)
async def upload_attachment(
    case_id: str,
    request: Request,
    state: State,
    filename: Annotated[str, Header(alias="X-Attachment-Filename", max_length=120)],
) -> AttachmentOut:
    """Upload a raw file body (not multipart), with filename in a required header."""
    name, expected_type = _valid_name(filename)
    media_type = _content_type(name, request.headers.get("content-type", ""))
    assert media_type == expected_type
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            length = int(declared_length)
        except ValueError as exc:
            raise _error(400, "INVALID_CONTENT_LENGTH", "Content-Length is not numeric.") from exc
        if length < 0:
            raise _error(400, "INVALID_CONTENT_LENGTH", "Content-Length cannot be negative.")
        if length > MAX_ATTACHMENT_BYTES:
            raise _error(413, "ATTACHMENT_TOO_LARGE", "Maximum attachment size is 8 MiB.")

    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > MAX_ATTACHMENT_BYTES:
            raise _error(413, "ATTACHMENT_TOO_LARGE", "Maximum attachment size is 8 MiB.")
        payload.extend(chunk)
    if not payload:
        raise _error(422, "EMPTY_ATTACHMENT", "An empty attachment cannot be archived.")
    _check_magic(payload, media_type)
    checksum = hashlib.sha256(payload).hexdigest()
    attachment_id = str(uuid4())
    created_at = datetime.now(UTC).isoformat()
    with _database(state.data_dir) as connection:
        # Acquire a cross-process write lock BEFORE reading limits/case state.
        connection.execute("BEGIN IMMEDIATE")
        _case_lookup(connection, case_id)
        if connection.execute(
            "SELECT 1 FROM investigation_attachments WHERE investigation_id=? AND sha256=?",
            (case_id, checksum),
        ).fetchone():
            raise _error(
                409, "ATTACHMENT_ALREADY_EXISTS",
                "This case already holds identical bytes. Existing evidence is unchanged.",
            )
        count, total = connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes),0) FROM investigation_attachments "
            "WHERE investigation_id=?", (case_id,),
        ).fetchone()
        if count >= MAX_ATTACHMENTS_PER_CASE or total + len(payload) > MAX_CASE_BYTES:
            raise _error(
                409, "ATTACHMENT_QUOTA_REACHED",
                "Maximum 32 attachments and 64 MiB of binary operator evidence per case.",
            )
        connection.execute(
            "INSERT INTO investigation_attachments "
            "(id,investigation_id,filename,media_type,size_bytes,sha256,data,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (attachment_id, case_id, name, media_type, len(payload),
             checksum, sqlite3.Binary(payload), created_at),
        )
    return AttachmentOut(
        id=attachment_id, investigation_id=case_id, filename=name,
        media_type=media_type, size_bytes=len(payload), sha256=checksum,
        created_at=created_at,
        download_url=f"/api/investigations/{case_id}/attachments/{attachment_id}/content",
    )


@router.get("", response_model=AttachmentsOut)
def list_attachments(case_id: str, state: State) -> AttachmentsOut:
    with _database(state.data_dir) as connection:
        _case_lookup(connection, case_id)
        rows = connection.execute(
            "SELECT id,investigation_id,filename,media_type,size_bytes,sha256,created_at "
            "FROM investigation_attachments WHERE investigation_id=? "
            "ORDER BY created_at,id", (case_id,),
        ).fetchall()
        attachments = [_out(case_id, row) for row in rows]
    return AttachmentsOut(attachments=attachments, count=len(attachments))


@router.get("/{attachment_id}", response_model=AttachmentOut)
def get_attachment(
    case_id: str,
    attachment_id: Annotated[str, ApiPath(pattern=_ID)],
    state: State,
) -> AttachmentOut:
    with _database(state.data_dir) as connection:
        _case_lookup(connection, case_id)
        return _out(case_id, _entry(connection, case_id, attachment_id))


@router.get("/{attachment_id}/content")
def download_attachment(
    case_id: str,
    attachment_id: Annotated[str, ApiPath(pattern=_ID)],
    state: State,
) -> Response:
    with _database(state.data_dir) as connection:
        _case_lookup(connection, case_id)
        row = _entry(connection, case_id, attachment_id, blob=True)
        contents = bytes(row["data"])
        if (
            len(contents) != row["size_bytes"] or
            hashlib.sha256(contents).hexdigest() != row["sha256"]
        ):
            raise _error(
                409, "ATTACHMENT_INTEGRITY_FAILURE",
                "Stored content differs from its recorded byte count or SHA-256.",
            )
        filename = str(row["filename"])
        checksum = str(row["sha256"])
    return Response(
        content=contents,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "no-store",
            "X-DarkFleet-Content-SHA256": checksum,
        },
    )


@router.delete("/{attachment_id}", status_code=204)
def delete_attachment(
    case_id: str,
    attachment_id: Annotated[str, ApiPath(pattern=_ID)],
    state: State,
) -> Response:
    with _database(state.data_dir) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _case_lookup(connection, case_id)
        cursor = connection.execute(
            "DELETE FROM investigation_attachments WHERE investigation_id=? AND id=?",
            (case_id, attachment_id),
        )
        if cursor.rowcount == 0:
            raise _error(404, "UNKNOWN_ATTACHMENT", "Attachment is absent from this investigation.")
    return Response(status_code=204)
