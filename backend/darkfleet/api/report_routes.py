"""Read-only, locally reproducible investigation exports."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from darkfleet.api.routes import State
from darkfleet.investigation_reports import (
    InvestigationReportNotFound,
    build_report,
    render_investigation_pdf,
)

__all__ = ["router"]

router = APIRouter(prefix="/api/investigation-reports", tags=["investigation-reports"])

CaseId = Annotated[str, Path(pattern=r"^[0-9a-fA-F-]{36}$")]


class InvestigationReportOut(BaseModel):
    """Documented file contract for a canonical integrity-checked case report."""

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1]
    kind: Literal["DARKFLEET_INVESTIGATION_EVIDENCE"]
    investigation: dict[str, str | None]
    source_status: Literal[
        "PERSISTED_REAL", "NO_SCAN_LINKED", "SOURCE_MISSING", "SOURCE_UNVERIFIED"
    ]
    sensor_evidence: dict[str, Any]
    operator_material: dict[str, Any]
    scientific_limits: list[str]
    warnings: list[str]
    content_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    hash_algorithm: str

    @model_validator(mode="after")
    def verify_content_hash(self) -> InvestigationReportOut:
        from hashlib import sha256

        original = self.model_dump(exclude={"content_sha256", "hash_algorithm"})
        canonical = json.dumps(
            original, sort_keys=True, ensure_ascii=False,
            separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
        if sha256(canonical).hexdigest() != self.content_sha256:
            raise ValueError("Report content digest does not match its payload.")
        return self


def _report(case_id: str, state: State) -> dict:
    try:
        return build_report(data_dir=state.data_dir, store=state.store, case_id=case_id)
    except InvestigationReportNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "UNKNOWN_INVESTIGATION",
                "status": "UNKNOWN_INVESTIGATION",
                "message": str(exc),
            },
        ) from exc


@router.get("/{case_id}/json", response_model=InvestigationReportOut)
def download_case_json(case_id: CaseId, state: State) -> Response:
    report = InvestigationReportOut.model_validate(_report(case_id, state))
    body = report.model_dump_json(indent=2)
    return Response(
        content=body.encode("utf-8"),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="darkfleet-{case_id}-evidence.json"',
            "ETag": f'"{report.content_sha256}"',
            "Cache-Control": "no-store",
        },
    )


@router.get(
    "/{case_id}/pdf",
    responses={200: {"content": {"application/pdf": {
        "schema": {"type": "string", "format": "binary"},
    }}}},
)
def download_case_pdf(case_id: CaseId, state: State) -> Response:
    report = InvestigationReportOut.model_validate(_report(case_id, state))
    return Response(
        content=render_investigation_pdf(report.model_dump()),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="darkfleet-{case_id}-evidence.pdf"',
            "X-DarkFleet-Content-SHA256": report.content_sha256,
            "Cache-Control": "no-store",
        },
    )
