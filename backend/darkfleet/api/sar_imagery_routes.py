"""Isolated mountable endpoints for real-source-gated two-scene SAR imagery."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator

from darkfleet.api.routes import State
from darkfleet.sar_scene_compare import SceneCandidatesOut, scene_candidates
from darkfleet.sar_scene_imagery import (
    ImageryPair,
    ImageryUnavailable,
    imagery_pair,
    scene_image_png,
)

ScanId = Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")]


class ImageryPairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_scan_id: ScanId
    second_scan_id: ScanId

    @model_validator(mode="after")
    def distinct(self) -> ImageryPairRequest:
        if self.first_scan_id == self.second_scan_id:
            raise ValueError("Select two distinct scan records for two-scene viewing.")
        return self


router = APIRouter(prefix="/api/sar/imagery", tags=["sar-imagery"])


@router.get("/scans", response_model=SceneCandidatesOut)
def list_scans(state: State) -> SceneCandidatesOut:
    return scene_candidates(state.data_dir, limit=100)


@router.post("/pair", response_model=ImageryPair)
def read_imagery_pair(body: ImageryPairRequest, state: State) -> ImageryPair:
    return imagery_pair(state.data_dir, body.first_scan_id, body.second_scan_id)


@router.get("/scans/{scan_id}/image")
def read_scene_image(scan_id: ScanId, state: State) -> Response:
    try:
        png = scene_image_png(state.data_dir, scan_id)
    except ImageryUnavailable as exc:
        raise HTTPException(status_code=409, detail={
            "error": "SAR_IMAGERY_UNAVAILABLE", "reason": exc.code,
        }) from exc
    return Response(content=png, media_type="image/png", headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })
