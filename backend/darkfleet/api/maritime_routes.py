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

from collections.abc import Callable

from fastapi import APIRouter, Query, Request
from fastapi import status as http_status

from darkfleet.api.maritime_geometry_models import (
    CoastlineGeometryResponse,
    DatasetHealthResponse,
    ZoneGeometryResponse,
)
from darkfleet.api.maritime_models import TargetMaritimeContextResponse
from darkfleet.api.routes import State, api_error
from darkfleet.jobs.models import is_terminal
from darkfleet.maritime.display_service import coastline_layer, dataset_health, zone_layer
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


# ===========================================================================
# Display geometry and dataset health
# ===========================================================================
#
# NOT scan-scoped, and deliberately so: these describe the WORLD, not a target. A
# coastline is the same whether or not a vessel was detected in it, and making the globe
# wait for a scan before it can draw the sea would be backwards.
#
# They carry no target identity because they have none, and adding one would imply they
# were computed for a vessel when they were not.


@router.get("/maritime/datasets", response_model=DatasetHealthResponse)
def maritime_datasets(request: Request) -> DatasetHealthResponse:
    """Local reference-dataset state (DF-X8.5).

    Separate from `/api/providers/health` on purpose: those are remote HTTP sources with a
    live-uptime meaning, these are files on this disk. Merging them would let a healthy
    basemap imply healthy reference data.
    """
    state: State = request.app.state.darkfleet_state
    return dataset_health(state.data_dir)


@router.get(
    "/maritime/layers/REFERENCE_COASTLINE",
    response_model=CoastlineGeometryResponse,
    tags=["maritime"],
)
def maritime_coastline_layer(
    request: Request,
    tolerance_deg: float = Query(
        default=0.02, ge=0.001, le=1.0,
        description="Simplification tolerance in degrees. Non-zero means the drawing is "
                    "not the data; the backend's analytical authority is unaffected.",
    ),
) -> CoastlineGeometryResponse:
    """Simplified Natural Earth coastline for the globe (DF-X8.5).

    LITERAL PATH SEGMENT, NOT A PATH PARAMETER
    -------------------------------------------
    `/maritime/layers/{layer}` with one response model would force a union: a coastline
    request returns ``lines`` and an EEZ request returns ``polygons``, and the generated
    TypeScript would then have to model "either shape or neither". Three literal paths
    give each layer its OWN strict model, so the generated contract cannot describe a
    response that mixes the two -- and a wrong layer name is a 404 naming the right path
    instead of a confusing shape mismatch in the client.
    """
    state: State = request.app.state.darkfleet_state
    return coastline_layer(state.data_dir, tolerance_deg=tolerance_deg)


def _zone_route(layer: str, doc: str) -> Callable[..., ZoneGeometryResponse]:
    """Build one zone-layer route with its own strict response model.

    A factory rather than two hand-written near-identical functions, because the two
    routes differ only in the layer name and the documentation -- and a hand-copied pair
    is exactly where the second one drifts.
    """

    @router.get(
        f"/maritime/layers/{layer}",
        response_model=ZoneGeometryResponse,
        tags=["maritime"],
        name=f"maritime_{layer.lower()}_layer",
    )
    def handler(
        request: Request,
        tolerance_deg: float = Query(default=0.02, ge=0.001, le=1.0),
    ) -> ZoneGeometryResponse:
        state: State = request.app.state.darkfleet_state
        return zone_layer(state.data_dir, layer, tolerance_deg=tolerance_deg)

    handler.__doc__ = doc
    return handler


#: EEZ boundaries: DISPUTED and overlapping claims are rendered as the dataset records
#: them. Fifty-six of the 285 installed features carry multiple sovereigns or territories.
_register_eez_layer = _zone_route(
    "EEZ_BOUNDARIES",
    "Simplified Marine Regions EEZ boundaries for the globe (DF-X8.5).\n\n"
    "Multi-part features keep every part and interior rings are preserved, because "
    "flattening a MultiPolygon would drop detached island blocks and dropping a hole "
    "would draw land the dataset calls sea.",
)

#: Explicit high-seas geometry. Rendered separately from the EEZ so an operator can see
#: that HIGH_SEAS was MEASURED against a polygon rather than inferred from an absent
#: EEZ -- which is the distinction the whole zone rule exists to protect.
_register_high_seas_layer = _zone_route(
    "HIGH_SEAS",
    "Simplified Marine Regions high-seas geometry for the globe (DF-X8.5).\n\n"
    "This layer exists because of a rule. DarkFleet refuses to infer HIGH_SEAS from the "
    "absence of an EEZ match, so the publisher's explicit high-seas polygons are what "
    "make the question answerable by measurement.",
)