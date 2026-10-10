"""An independently mountable read-only router for DF-X10/X11 raster comparison."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator

from darkfleet.api.routes import State
from darkfleet.sar_scene_compare import (
    SceneCandidatesOut,
    SceneComparisonOut,
    compare_scenes,
    scene_candidates,
)

ScanId = Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")]


class SceneCompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_scan_id: ScanId
    second_scan_id: ScanId

    @model_validator(mode="after")
    def distinct(self) -> SceneCompareRequest:
        if self.first_scan_id == self.second_scan_id:
            raise ValueError("Select two different persisted scan IDs.")
        return self


router = APIRouter(prefix="/api/sar/compare", tags=["sar-compare"])


@router.get("/scans", response_model=SceneCandidatesOut)
def list_scene_candidates(
    state: State, limit: int = Query(default=100, ge=1, le=200),
) -> SceneCandidatesOut:
    return scene_candidates(state.data_dir, limit=limit)


@router.post("", response_model=SceneComparisonOut)
def compare_persisted_sar_windows(body: SceneCompareRequest, state: State) -> SceneComparisonOut:
    return compare_scenes(state.data_dir, body.first_scan_id, body.second_scan_id)
