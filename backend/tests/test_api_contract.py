"""Contract tests (IR1 / Checkpoint B).

Two hand-written mirrors of one shape drifted: the backend emitted ``cls`` where
the frontend declared ``classification``, and a detection's class was ``undefined``
in every live render path with no failing test. These pin the three layers that
now prevent it:

1. the backend validates every target (Pydantic, ``additionalProperties=False``);
2. ``src/api/contract.ts`` is GENERATED from that OpenAPI schema;
3. the browser re-validates the payload on arrival.

Layer 2 is covered here because it is the one that can silently rot: a developer
edits the backend, forgets to regenerate, and the frontend keeps building against
a shape the server no longer serves. Nothing else would notice.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from darkfleet.api.targets import (
    CLASSIFICATION_VALUES,
    AisAssociation,
    AisOnlyTarget,
    ScanScene,
    ScoreDecomposition,
    VesselTarget,
)

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
CONTRACT_TS = ROOT / "src" / "api" / "contract.ts"


# --------------------------------------------------------------- generation


def test_generated_contract_is_current() -> None:
    """`contract.ts` must match the OpenAPI schema the server actually serves.

    This is the drift guard. If it fails, run:

        python -m tools.export_contract

    and commit the result. A stale contract.ts is not a style problem: it means
    the frontend is typed against a shape the backend no longer sends, which is
    precisely how `cls` versus `classification` shipped unnoticed.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "tools.export_contract", "--check"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert proc.returncode == 0, (
        f"src/api/contract.ts is stale.\n{proc.stdout}\n{proc.stderr}\n"
        f"Regenerate with: python -m tools.export_contract"
    )


def test_generated_contract_uses_the_canonical_classification_field() -> None:
    text = CONTRACT_TS.read_text(encoding="utf-8")
    assert "readonly classification:" in text, (
        "the generated contract must expose `classification`, not `cls`"
    )
    target_block = text.split("export interface VesselTarget", 1)[1].split("\n}", 1)[0]
    assert "readonly cls" not in target_block, (
        "`cls` must not reappear on the wire type; it was the original defect"
    )


def test_generated_contract_declares_provider_status_as_a_union() -> None:
    """A `string` here is what let the frontend invent a seventh provider state."""
    text = CONTRACT_TS.read_text(encoding="utf-8")
    assert "export type ProviderStatus =" in text
    block = text.split("export type ProviderStatus =", 1)[1].split("\n", 1)[0]
    assert '"NO_COVERAGE"' not in block, (
        "NO_COVERAGE was a frontend invention; the backend never emits it"
    )
    for value in ("AVAILABLE", "DEGRADED", "UNAVAILABLE", "AUTH_REQUIRED"):
        assert f'"{value}"' in block


# ------------------------------------------------------ backend validation


def _wire_target(cls: str = "SAR_UNMATCHED") -> dict[str, object]:
    """A target shaped exactly as the pipeline writes it into the record."""
    return {
        "id": "DF-001",
        "cls": cls,
        "lat": 1.267269,
        "lon": 103.85533,
        "sarConf": 0.54,
        "aisConf": 0.0,
        "lenM": 15,
        "widM": 12,
        "lenUncM": 10,
        "hdg": 89,
        "wake": False,
        "meanDb": -10.3,
        "maxDb": -9.4,
        "area": 5,
        "corr": {
            "matched": False,
            "mmsi": None,
            "vesselName": None,
            "distanceOffsetMeters": None,
            "timeDeltaSeconds": None,
            "predictedLat": None,
            "predictedLon": None,
            "aisAssociationConfidence": 0,
            "scoreDecomposition": None,
        },
        "assessment": "Unmatched surface radar return (~15m).",
        "tags": ["SAR_UNMATCHED", "AIS_UNASSOCIATED"],
    }


def test_backend_accepts_the_record_shape_and_emits_classification() -> None:
    """`cls` in, `classification` out. The record format is unchanged."""
    model = VesselTarget.model_validate(_wire_target())
    assert model.classification == "SAR_UNMATCHED"
    wire = model.model_dump(by_alias=True)
    assert "classification" in wire
    assert "cls" not in wire
    # Every other camelCase wire name survives unchanged.
    for key in ("sarConf", "lenM", "widM", "lenUncM", "meanDb", "maxDb", "aisConf"):
        assert key in wire, f"{key} must not be renamed by this change"


def test_backend_rejects_an_unknown_classification() -> None:
    with pytest.raises(ValidationError):
        VesselTarget.model_validate(_wire_target(cls="DARK_VESSEL"))


def test_backend_rejects_an_unknown_field() -> None:
    target = _wire_target()
    target["surprise"] = 1
    with pytest.raises(ValidationError):
        VesselTarget.model_validate(target)


def test_backend_rejects_a_missing_measurement() -> None:
    """`lenUncM` carries the footprint uncertainty; a default would invent one."""
    target = _wire_target()
    del target["lenUncM"]
    with pytest.raises(ValidationError):
        VesselTarget.model_validate(target)


def test_backend_rejects_an_out_of_range_position() -> None:
    target = _wire_target()
    target["lat"] = 120.0
    with pytest.raises(ValidationError):
        VesselTarget.model_validate(target)


def test_heading_none_is_accepted_and_is_not_zero() -> None:
    """No heading measured must be representable. 0 degrees true is north."""
    target = _wire_target()
    target["hdg"] = None
    model = VesselTarget.model_validate(target)
    assert model.hdg is None
    assert model.hdg != 0


def test_matched_association_requires_a_position() -> None:
    assoc = AisAssociation.model_validate(
        {
            "matched": True,
            "mmsi": "565123456",
            "vesselName": "STRAIT VOYAGER",
            "predictedLat": 1.267511,
            "predictedLon": 103.855401,
            "aisAssociationConfidence": 0.88,
            "scoreDecomposition": {
                "spatialScore": 0.9,
                "temporalScore": 0.85,
                "headingScore": 0.72,
                "sizeScore": 0.8,
                "compositeScore": 0.84,
                "matchRadiusMeters": 400,
                "distanceOffsetMeters": 14.2,
                "timeDeltaSeconds": 3.1,
            },
        }
    )
    assert assoc.matched is True
    assert isinstance(assoc.score_decomposition, ScoreDecomposition)
    assert assoc.score_decomposition is not None
    assert assoc.score_decomposition.composite_score == pytest.approx(0.84)


def test_blank_provider_name_becomes_absent_not_an_empty_name() -> None:
    assoc = AisAssociation.model_validate({"matched": False, "mmsi": None, "vesselName": ""})
    assert assoc.vessel_name is None


def test_ais_only_contact_requires_an_mmsi() -> None:
    with pytest.raises(ValidationError):
        AisOnlyTarget.model_validate(
            {"lat": 1.25, "lon": 103.83, "timestamp": "2026-09-27T11:20:00Z"}
        )


def test_scene_is_typed_not_an_untyped_dict() -> None:
    """The timeline reads scene.item_id; it must not read it off a dict."""
    scene = ScanScene.model_validate(
        {
            "provider": "planetary-computer",
            "collection": "sentinel-1-rtc",
            "item_id": "S1D_IW_GRDH_1SDV_20260927T112445_20260927T112510_004762_008EC4_rtc",
            "platform": "sentinel-1d",
            "acquisition_time": "2026-09-27T11:24:58.180786Z",
            "product": "RTC",
            "polarization": "VV",
            "crs": "EPSG:32648",
            "resolution_m": 10.0,
        }
    )
    assert scene.item_id.startswith("S1")
    assert scene.resolution_m == pytest.approx(10.0)


def test_the_seven_classes_are_exactly_the_schema() -> None:
    assert CLASSIFICATION_VALUES == (
        "SAR_MATCHED_AIS",
        "SAR_UNMATCHED",
        "AIS_ONLY",
        "STATIONARY_OR_INFRASTRUCTURE",
        "SEA_CLUTTER",
        "LOW_CONFIDENCE",
        "UNRESOLVED",
    )


def test_the_openapi_schema_exposes_validated_targets() -> None:
    """The response schema must reference the models, not `dict[str, Any]`."""
    from darkfleet.api.app import create_app
    from darkfleet.config.settings import Settings

    settings = Settings()
    settings.log_level = "WARNING"
    schemas = create_app(settings).openapi()["components"]["schemas"]

    targets = schemas["ScanTargetsResponse"]["properties"]["targets"]
    ref = targets.get("items", {}).get("$ref", "")
    assert ref.endswith("/VesselTarget"), (
        f"targets must be typed, got {json.dumps(targets)[:200]}"
    )
    assert "VesselTarget" in schemas
    assert schemas["VesselTarget"]["additionalProperties"] is False
