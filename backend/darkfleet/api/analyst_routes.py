"""Read-only, separately mountable DF-X20 local grounded-analyst endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, StringConstraints

from darkfleet.analyst import (
    AnalystCaseListOut,
    AnalystIntent,
    GroundedAnalystOut,
    UnknownInvestigation,
    analyze_case,
    list_analyst_cases,
)
from darkfleet.api.routes import State

CaseId = Annotated[str, Path(pattern=r"^[0-9a-fA-F-]{36}$")]
TargetId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")]


class AnalystRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent: AnalystIntent = "SUMMARY"
    target_id: TargetId | None = None


router = APIRouter(prefix="/api/analyst", tags=["grounded-analyst"])


@router.get("/cases", response_model=AnalystCaseListOut)
def analyst_case_catalogue(
    state: State, limit: int = Query(default=100, ge=1, le=200),
) -> AnalystCaseListOut:
    try:
        return list_analyst_cases(state.data_dir, limit=limit)
    except UnknownInvestigation:
        # No DB is different from an empty but established case table.
        raise HTTPException(
            status_code=404,
            detail={"error": "INVESTIGATION_STORE_UNAVAILABLE",
                    "status": "INVESTIGATION_STORE_UNAVAILABLE",
                    "message": "No readable persisted investigation database is available."},
        ) from None


@router.post("/cases/{case_id}/analyze", response_model=GroundedAnalystOut)
def analyze_persisted_case(
    case_id: CaseId, body: AnalystRequest, state: State,
) -> GroundedAnalystOut:
    try:
        return analyze_case(
            state.data_dir, state.store, case_id,
            intent=body.intent, target_id=body.target_id,
        )
    except UnknownInvestigation:
        raise HTTPException(
            status_code=404,
            detail={"error": "UNKNOWN_INVESTIGATION", "status": "UNKNOWN_INVESTIGATION",
                    "message": "The requested persisted investigation was not found."},
        ) from None
