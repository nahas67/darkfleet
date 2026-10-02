"""Full evidence/provenance record. Every detection is reproducible from this. (EVD)"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from . import __classification_schema__, __processing_version__, __version__
from .geoid import describe_datum
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
    target: dict[str, Any], provenance: dict[str, Any], chip: dict[str, Any] | None
) -> dict[str, Any]:
    """Per-target evidence slice: observation, association, confidence, uncertainty."""
    corr = target.get("corr", {})
    decomposition = corr.get("scoreDecomposition")
    lat, lon = target["lat"], target["lon"]
    return {
        "target_id": target["id"],
        "classification": target["cls"],
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
        "sar_chip": chip,
        "provenance": provenance,
    }