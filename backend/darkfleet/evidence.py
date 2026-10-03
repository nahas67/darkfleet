"""Full evidence/provenance record. Every detection is reproducible from this. (EVD)"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from . import __classification_schema__, __processing_version__, __version__
from .geoid import describe_datum
from .ghost_vessel import assess, display_label
from .marine import describe_position
from .marine import provenance as marine_provenance


def build_provenance(
    *,
    runtime_mode: str,
    synthetic: bool,
    provider: str,
    collection: str,
    item_id: str,
    platform: str,
    acquisition_time: str,
    product: str,
    polarization: str,
    asset_href: str,
    crs: str | None,
    transform: list[float] | None,
    resolution_m: float | None,
    raster_window: tuple[int, int, int, int] | None,
    bbox: list[float],
    config_hash: str,
    land_mask: dict[str, Any],
    speckle: dict[str, Any],
    cfar: dict[str, Any],
    ais_provider: str,
    matching: dict[str, Any],
) -> dict[str, Any]:
    """Assemble the complete provenance block. Missing values are None, never invented."""
    return {
        "software_version": __version__,
        "processing_version": __processing_version__,
        "classification_schema": __classification_schema__,
        "recorded_at": datetime.now(UTC).isoformat(),
        "runtime_mode": runtime_mode,
        "synthetic": synthetic,
        # GEO-001 provenance. Public domain, so it carries no attribution duty,
        # but the source commit is recorded so the answer is reproducible.
        "marine_regions": marine_provenance(),
        "sar": {
            "provider": provider,
            "collection": collection,
            "item_id": item_id,
            "platform": platform,
            "acquisition_time": acquisition_time,
            "product": product,
            "polarization": polarization,
            "asset_href": asset_href,
            "crs": crs,
            "transform": transform,
            "resolution_m": resolution_m,
            "raster_window": list(raster_window) if raster_window else None,
        },
        "aoi": bbox,
        "processing": {
            "config_hash": config_hash,
            "land_mask": land_mask,
            "speckle": speckle,
            "cfar": cfar,
        },
        "ais": {"provider": ais_provider},
        "matching": matching,
    }


def target_evidence(
    target: dict[str, Any],
    provenance: dict[str, Any],
    chip: dict[str, Any] | None,
    *,
    ais_coverage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Per-target evidence slice: observation, association, confidence, uncertainty.

    Structurally separates OBSERVED / HYPOTHESES / UNKNOWNS. They are never merged
    into one paragraph, because a reader who skims prose cannot tell which clause
    was measured and which was suggested. An empty block still renders, so
    "nothing found" is never mistaken for "not examined".
    """
    corr = target.get("corr", {})
    decomposition = corr.get("scoreDecomposition")
    lat, lon = target["lat"], target["lon"]
    designation = display_label(target["cls"])[0]
    region = _region_text(describe_position(lat, lon))
    ghost = assess(
        target,
        ais_coverage=ais_coverage,
        wake_detected=target.get("wake"),
        region=region,
    )
    return {
        "target_id": target["id"],
        "classification": target["cls"],
        # Product designation sits ABOVE the analytical class, never replaces it.
        "designation": designation,
        "ghost_vessel": ghost,
        "observed": {
            "position": {
                "lat": lat,
                "lon": lon,
                # GEO-001: the named water body, so evidence reads as geography
                # rather than as a bare coordinate pair. Never invented: an
                # unmatched position reports kind/primary explicitly.
                "marine_region": describe_position(lat, lon),
                # GEO-003: SAR does not measure height. Declared so no consumer
                # infers an altitude from the apparent footprint.
                "vertical_datum": describe_datum(lat, lon),
            },
            "apparent_footprint_m": {"length": target["lenM"], "width": target["widM"]},
            "orientation_deg": target["hdg"],
            "mean_backscatter_db": target["meanDb"],
            "max_backscatter_db": target["maxDb"],
            "pixel_area": target["area"],
            "wake_evident": target["wake"],
            "sar_detection_confidence": target["sarConf"],
        },
        "uncertainty": {
            "length_uncertainty_m": target["lenUncM"],
            "match_radius_m": decomposition["matchRadiusMeters"] if decomposition else None,
            "propagation_note": (
                "AIS position propagated to acquisition time by dead reckoning; "
                "no gyro/IMU correction available."
            ),
        },
        "association": {
            "mmsi": corr.get("mmsi"),
            "vessel_name": corr.get("vesselName"),
            "distance_offset_m": corr.get("distanceOffsetMeters"),
            "time_delta_s": corr.get("timeDeltaSeconds"),
            "predicted_position": (
                {"lat": corr.get("predictedLat"), "lon": corr.get("predictedLon")}
                if corr.get("predictedLat") is not None
                else None
            ),
            "ais_association_confidence": target["aisConf"],
            "score_decomposition": decomposition,
        },
        "summary": target.get("assessment"),
        "tags": target.get("tags", []),
        # The two remaining evidence blocks. `ghost` carries the Ghost Vessel
        # variant of both; for every other class they state plainly that the
        # blocks are not applicable, rather than being omitted (omission reads as
        # "not examined").
        "hypotheses": ghost.get("hypotheses")
        or [{"text": "No hypotheses are raised for this classification; the association "
                     "either cleared the threshold or the target is not an association "
                     "question."}],
        "unknowns": ghost.get("unknowns") or _GENERIC_UNKNOWNS,
        "sar_chip": chip,
        "provenance": provenance,
    }


def _region_text(ctx: dict[str, Any]) -> str | None:
    """A readable region phrase, or ``None`` when no name is established.

    Never a fallback name for open water. "Open ocean" is a real answer; inventing
    a nearby landfall would be a fabricated location.
    """
    kind = ctx.get("kind")
    primary = ctx.get("primary")
    if primary:
        return str(primary)
    if kind == "open_ocean":
        return "Open ocean (no marine region name established)"
    return None


#: Applies to any target that is not a Ghost Vessel candidate. Stated, not omitted.
_GENERIC_UNKNOWNS: list[dict[str, str]] = [
    {"text": "Intent"},
    {"text": "Destination"},
    {"text": "Behaviour between observations"},
]