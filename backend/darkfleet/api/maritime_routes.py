"""The scan-scoped maritime-context route.

WHY THE SCAN IS IN THE PATH
---------------------------
DF-X7 proved target ids are per-scan: ``DF-002`` exists in many different scans, and a
target-id-only route would silently resolve to whichever scan happened to be read. So the
shape is::

    GET /api/scans/{scan_id}/targets/{target_id}/maritime-context

and there is deliberately NO ``/api/targets/{target_id}/maritime-context``. Making the
ambiguous form impossible to express is stronger than documenting the ambiguous form as
unsupported.

THE POSITION COMES FROM THE STORE, NEVER THE CLIENT
---------------------------------------------------
No query parameter or body coordinate is accepted. The route reads the PERSISTED target
and uses its recorded WGS84 position. A route that accepted a client coordinate would let
a caller ask about a different vessel than the one named in the URL, and the answer would
still look authoritative.

PER-CHANNEL FAILURE IS NOT ROUTE FAILURE
----------------------------------------
A missing optional dataset must not produce a 500. GEBCO is not installed, so this route
returns 200 with ``bathymetry.status = NOT_INSTALLED`` and a full provenance record for
the dataset that would answer. One absent dataset cannot blank the zone or the coastline
that did resolve.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi import status as http_status

from darkfleet.api.maritime_models import TargetMaritimeContextResponse
from darkfleet.api.routes import State, api_error
from darkfleet.jobs.models import is_terminal
from darkfleet.maritime.service import build_context

#: The ``/api`` prefix matches the core router. Without it the route registers at the
#: application root and every request 404s -- which reads exactly like a path typo.
router = APIRouter(prefix="/api", tags=["maritime"])


def _target_from_store(state: State, scan_id: str, target_id: str) -> dict[str, object]:
    """The persisted target, or a typed 404/409.

    Reads the stored record rather than any live pipeline state, because maritime context
    describes a target that has already been detected and persisted -- asking about an
    in-flight detection would attribute a maritime zone to a position that might still
    move.
    """
    record = state.store.get(scan_id)
    if record is None:
        job = state.runner.get(scan_id)
        if job is not None and not is_terminal(job.stage):
            raise api_error(
                http_status.HTTP_409_CONFLICT,
                error="SCAN_NOT_READY",
                status_value="SCAN_NOT_READY",
                message=(
                    f"Scan {scan_id} is still running; maritime context describes a "
                    "persisted detection and appears at COMPLETE."
                ),
                scan_id=scan_id,
            )
        raise api_error(
            http_status.HTTP_404_NOT_FOUND,
            error="UNKNOWN_SCAN",
            status_value="NOT_ESTABLISHED",
            message=f"No stored scan {scan_id}.",
            scan_id=scan_id,
        )

    targets = record.get("targets") or []
    for candidate in targets:
        if str(candidate.get("id")) == target_id:
            # Annotated rather than returned bare: `store.get()` is typed Any, and
            # returning Any into a declared dict defeats the annotation entirely.
            found: dict[str, object] = candidate
            return found

    raise api_error(
        http_status.HTTP_404_NOT_FOUND,
        error="UNKNOWN_TARGET",
        status_value="NOT_ESTABLISHED",
        message=(
            f"Scan {scan_id} has no target {target_id}. Target ids are scoped to a scan, "
            "so the scan id is part of this target's identity."
        ),
        scan_id=scan_id,
        detail={"target_id": target_id},
    )


@router.get(
    "/scans/{scan_id}/targets/{target_id}/maritime-context",
    response_model=TargetMaritimeContextResponse,
)
def target_maritime_context(
    scan_id: str, target_id: str, request: Request
) -> TargetMaritimeContextResponse:
    """Maritime context for one scan-scoped target (DF-X8.4)."""
    state: State = request.app.state.darkfleet_state
    target = _target_from_store(state, scan_id, target_id)

    latitude = target.get("lat")
    longitude = target.get("lon")
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        # A target without a position cannot be given a maritime context, and inventing
        # one would be worse than saying so.
        raise api_error(
            http_status.HTTP_409_CONFLICT,
            error="TARGET_HAS_NO_POSITION",
            status_value="NOT_ESTABLISHED",
            message=(
                f"Target {target_id} of scan {scan_id} carries no WGS84 position, so no "
                "maritime context can be computed for it."
            ),
            scan_id=scan_id,
            detail={"target_id": target_id},
        )

    return build_context(
        state.data_dir,
        scan_id=scan_id,
        target_id=target_id,
        latitude=float(latitude),
        longitude=float(longitude),
    )