"""Loopback-gated local GeoTIFF import router; independent of remote SAR scans."""

from __future__ import annotations

import ipaddress
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

from darkfleet.api.routes import State
from darkfleet.local_sar_import import (
    LocalSarError,
    get_local_import,
    import_local_geotiff,
    list_local_imports,
    local_import_image,
    local_import_status,
)

ImportId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
Basename = Annotated[str, StringConstraints(min_length=5, max_length=132)]


class LocalSarImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relative_path: Basename
    product: Literal["RTC", "GRD"]
    polarization: Literal["VV", "VH"] | None = None
    acquisition_time: datetime | None = None
    calibration: Literal[
        "UNKNOWN", "RAW_DN", "GAMMA0_LINEAR", "SIGMA0_LINEAR", "GAMMA0_DB", "SIGMA0_DB"
    ] | None = None

    @field_validator("acquisition_time")
    @classmethod
    def timezone_required(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Acquisition time must include a timezone; no assumed UTC.")
        return value


def _local_client(request: Request) -> None:
    """Inspect the actual ASGI peer, not Host/Origin/X-Forwarded-For headers."""
    host = request.client.host if request.client else ""
    if host == "testclient":  # Starlette TestClient's synthetic peer, never a TCP address.
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise HTTPException(status_code=403, detail={
        "error": "LOCAL_SAR_LOOPBACK_REQUIRED", "status": "FORBIDDEN",
        "message": "Local SAR import endpoints require a local loopback connection.",
    })


def _run[T](call: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    try:
        return call(*args, **kwargs)
    except LocalSarError as exc:
        raise HTTPException(status_code=exc.http_status, detail={
            "error": "LOCAL_SAR_IMPORT_ERROR", "status": exc.code, "message": exc.code,
        }) from None


router = APIRouter(prefix="/api/sar/local", tags=["local-sar-import"],
                   dependencies=[Depends(_local_client)])


@router.get("/status")
def status(state: State) -> dict:
    return _run(local_import_status, state.data_dir)


@router.get("/imports")
def imports(state: State, limit: int = Query(default=100, ge=1, le=200)) -> dict:
    return _run(list_local_imports, state.data_dir, limit=limit)


@router.post("/import", status_code=201)
def import_file(body: LocalSarImportRequest, state: State) -> dict:
    return _run(import_local_geotiff, state.data_dir,
                relative_path=body.relative_path, product=body.product,
                polarization=body.polarization,
                acquisition_time=(body.acquisition_time.isoformat() if body.acquisition_time else None),
                calibration=body.calibration)


@router.get("/imports/{import_id}")
def detail(import_id: ImportId, state: State) -> dict:
    return _run(get_local_import, state.data_dir, import_id)


@router.get("/imports/{import_id}/image")
def image(import_id: ImportId, state: State) -> Response:
    png = _run(local_import_image, state.data_dir, import_id)
    return Response(content=png, media_type="image/png", headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })
