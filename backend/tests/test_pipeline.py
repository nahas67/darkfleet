"""CP6 gate: end-to-end pipeline + DEMO/REAL isolation (TST-003, TST-004, OPS-014)."""

from __future__ import annotations

import pytest

from darkfleet.pipeline import run_scan
from darkfleet.providers import RealDataUnavailableError
from darkfleet.storage.runs import RunStore

SCENE = {
    "id": "SIM-S1C-MALACCA-001",
    "platform": "Sentinel-1C",
    "polarization": "VV+VH",
    "acquisitionTime": "2026-09-18T14:32:18Z",
    "resolutionMeters": 10,
    "bbox": [103.65, 1.10, 104.05, 1.40],
    "seaClutterLevel": "MODERATE",
}
STAGES = [
    "QUEUED", "SEARCHING_SCENE", "READING_SAR", "PREPROCESSING", "MASKING",
    "FILTERING", "DETECTING", "EXTRACTING", "LOADING_AIS", "ALIGNING",
    "CORRELATING", "SCORING", "PERSISTING", "COMPLETE",
]


def _run(tmp_path, **kw) -> tuple[list[tuple[str, str]], dict]:
    seen: list[tuple[str, str]] = []
    result = run_scan(
        runtime_mode=kw.pop("runtime_mode", "DEMO"),
        bbox=kw.pop("bbox", SCENE["bbox"]),
        data_dir=str(tmp_path),
        scene=kw.pop("scene", SCENE),
        on_stage=lambda s, d: seen.append((s, d)),
        **kw,
    )
    return seen, result


def test_demo_scan_walks_every_stage_in_order(tmp_path) -> None:
    seen, result = _run(tmp_path)
    assert [s for s, _ in seen] == STAGES
    assert seen[0][1].startswith("scan DF-0000 queued mode=DEMO")
    assert result["runtime_mode"] == "DEMO"


def test_demo_evidence_marked_synthetic_everywhere(tmp_path) -> None:
    _, result = _run(tmp_path)
    assert result["synthetic"] is True
    assert result["provenance"]["synthetic"] is True
    assert result["provenance"]["runtime_mode"] == "DEMO"
    assert "demo-synthesizer" in result["provenance"]["sar"]["provider"]


def test_provenance_covers_every_required_field(tmp_path) -> None:
    _, result = _run(tmp_path)
    sar = result["provenance"]["sar"]
    for key in ("provider", "collection", "item_id", "platform", "acquisition_time",
                "product", "polarization", "asset_href", "crs", "resolution_m"):
        assert key in sar, key
    proc = result["provenance"]["processing"]
    for key in ("config_hash", "land_mask", "speckle", "cfar"):
        assert key in proc, key
    assert result["provenance"]["software_version"]
    assert result["provenance"]["classification_schema"]


def test_real_mode_without_provider_raises_no_synthetic_data(tmp_path) -> None:
    """OPS-014: REAL never silently degrades to DEMO."""
    with pytest.raises(RealDataUnavailableError):
        run_scan(
            runtime_mode="REAL", bbox=SCENE["bbox"], data_dir=str(tmp_path),
            scene=None, provider="does-not-exist",
        )
    assert RunStore(tmp_path).list() == []


def test_demo_scan_persists_and_survives_restart(tmp_path) -> None:
    _seen, result = _run(tmp_path)
    store = RunStore(tmp_path)
    scan_id = result["scan_id"]
    saved = store.save({**result, "scan_id": scan_id})
    assert saved
    fresh = RunStore(tmp_path)
    got = fresh.get(scan_id)
    assert got is not None
    assert got["runtime_mode"] == "DEMO" and got["synthetic"] is True
    assert got["counts"] == result["counts"]


def test_scan_is_deterministic(tmp_path) -> None:
    _sa, a = _run(tmp_path)
    _sb, b = _run(tmp_path)
    assert a["counts"] == b["counts"]
    assert [t["id"] for t in a["targets"]] == [t["id"] for t in b["targets"]]
    assert [t["cls"] for t in a["targets"]] == [t["cls"] for t in b["targets"]]


def test_targets_carry_confidence_and_uncertainty(tmp_path) -> None:
    _, result = _run(tmp_path)
    assert result["targets"]
    for t in result["targets"]:
        assert 0.0 < t["sarConf"] <= 1.0
        assert t["lenUncM"] > 0
        assert t["cls"] in {
            "SAR_MATCHED_AIS", "SAR_UNMATCHED", "AIS_ONLY",
            "STATIONARY_OR_INFRASTRUCTURE", "SEA_CLUTTER", "LOW_CONFIDENCE", "UNRESOLVED",
        }