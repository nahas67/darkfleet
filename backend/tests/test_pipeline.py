"""CP6 gate: the real pipeline end to end, and the no-synthetic-data guarantee
(TST-003, TST-004, OPS-014).

Every scan here runs the PRODUCTION pipeline: real CFAR, real land-mask
reprojection, real correlation, real evidence assembly. Only the network is
replaced, by :mod:`tests.fixture_source`, which reads a checked-in Sentinel-1
shaped GeoTIFF from disk. There is no scene synthesiser in this project, so
there is nothing to switch on.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from darkfleet.jobs import PIPELINE
from darkfleet.pipeline import run_scan
from darkfleet.providers import RealDataUnavailableError
from darkfleet.storage.runs import RunStore, mark_synthetic
from tests import fixture_source

STAGES = [stage.value for stage in PIPELINE]

#: What this AOI really contains. The fixture sidecar records three vessels and
#: no AIS coverage for the extent, so every detection is a surface return.
EXPECTED_COUNTS = {"STATIONARY_OR_INFRASTRUCTURE": 3, "ais_only": 0}


@pytest.fixture(autouse=True)
def offline_pipeline(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Replace the three network touches and nothing else."""
    fixture_source.install(monkeypatch)
    yield


def _run(tmp_path, **kw) -> tuple[list[tuple[str, str]], dict[str, Any]]:
    seen: list[tuple[str, str]] = []
    result = run_scan(
        bbox=kw.pop("bbox", fixture_source.FIXTURE_BBOX),
        data_dir=str(tmp_path),
        window_source=fixture_source.fixture_window_source(),
        on_stage=lambda s, d: seen.append((s, d)),
        **kw,
    )
    return seen, result


def _collapse(seen: list[tuple[str, str]]) -> list[str]:
    """Stage names with consecutive repeats merged, as the job runner does.

    The 15-state machine has no self-loops, so a stage reported twice in a row is
    one transition carrying both measured details.
    """
    collapsed: list[str] = []
    for stage, _detail in seen:
        if not collapsed or collapsed[-1] != stage:
            collapsed.append(stage)
    return collapsed


def test_real_scan_walks_every_stage_in_order(tmp_path) -> None:
    seen, _result = _run(tmp_path)
    assert _collapse(seen) == STAGES
    assert seen[0][1] == "scan DF-0000 queued"


def test_scene_selection_reports_both_measured_facts(tmp_path) -> None:
    """SEARCHING_SCENE fires twice: what it asked for, and what it picked."""
    seen, _result = _run(tmp_path)
    scene_details = [detail for stage, detail in seen if stage == "SEARCHING_SCENE"]
    assert len(scene_details) == 2, scene_details
    assert scene_details[0] == "searching planetary-computer rtc"
    assert scene_details[1].startswith("scene selected ")
    assert "S1A_FIXTURE_20240101T000000" in scene_details[1]


def test_every_evidence_document_is_marked_real_everywhere(tmp_path) -> None:
    """TST-004: nothing this pipeline emits may claim to be synthetic."""
    _seen, result = _run(tmp_path)
    assert result["synthetic"] is False
    assert result["provenance"]["synthetic"] is False
    assert result["provenance"]["runtime_mode"] == "REAL"
    # The provenance names the real provider it read, never a synthesiser.
    assert result["provenance"]["sar"]["provider"] == "planetary-computer"
    document = {key: value for key, value in result.items() if key != "artifacts"}
    assert "demo-synthesizer" not in json.dumps(document, default=str)
    assert "DEMO" not in json.dumps(document, default=str)


def test_the_fixture_aoi_yields_the_three_vessels_its_sidecar_records(tmp_path) -> None:
    """The measured output of the real detector, pinned to the fixture record.

    No AIS covers this extent, so correlation cannot promote anything to
    SAR_MATCHED_AIS: all three returns stay surface features.
    """
    _seen, result = _run(tmp_path)
    assert result["counts"] == EXPECTED_COUNTS
    assert len(result["targets"]) == 3
    assert result["ais_only"] == []
    assert {t["cls"] for t in result["targets"]} == {"STATIONARY_OR_INFRASTRUCTURE"}
    assert result["aoi"] == fixture_source.FIXTURE_BBOX
    assert result["acquisition_time"] == "2024-01-01T00:00:00.000000Z"


def test_provenance_covers_every_required_field(tmp_path) -> None:
    _seen, result = _run(tmp_path)
    sar = result["provenance"]["sar"]
    for key in ("provider", "collection", "item_id", "platform", "acquisition_time",
                "product", "polarization", "asset_href", "crs", "resolution_m"):
        assert key in sar, key
    assert sar["crs"] == "EPSG:32648"
    assert sar["resolution_m"] == pytest.approx(10.0)
    proc = result["provenance"]["processing"]
    for key in ("config_hash", "land_mask", "speckle", "cfar"):
        assert key in proc, key
    assert result["provenance"]["software_version"]
    assert result["provenance"]["classification_schema"]


def test_unknown_provider_raises_and_writes_nothing(tmp_path) -> None:
    """OPS-014: a provider failure yields NO data at all -- not even a substitute.

    This is the stronger form of the old DEMO/REAL guard. There is no second
    world to degrade into, so the only correct outcome is an explicit error and
    an empty store.
    """
    with pytest.raises(RealDataUnavailableError):
        run_scan(
            bbox=fixture_source.FIXTURE_BBOX,
            data_dir=str(tmp_path),
            window_source=fixture_source.fixture_window_source(),
            provider="does-not-exist",
        )
    assert RunStore(tmp_path).list() == []
    assert list(tmp_path.glob("scans/*.json")) == []


def test_real_scan_persists_and_survives_restart(tmp_path) -> None:
    _seen, result = _run(tmp_path)
    scan_id = result["scan_id"]
    # mark_synthetic is the store's own stamper: it derives REAL from the
    # pipeline's measured synthetic=False rather than asserting it here.
    saved = RunStore(tmp_path).save(mark_synthetic({**result, "scan_id": scan_id}, synthetic=False))
    assert saved
    got = RunStore(tmp_path).get(scan_id)
    assert got is not None
    assert got["runtime_mode"] == "REAL" and got["synthetic"] is False
    assert got["counts"] == result["counts"]
    assert got["provenance"]["sar"]["item_id"] == "S1A_FIXTURE_20240101T000000"


def test_scan_is_deterministic(tmp_path) -> None:
    _sa, a = _run(tmp_path)
    _sb, b = _run(tmp_path)
    assert a["counts"] == b["counts"]
    assert [t["id"] for t in a["targets"]] == [t["id"] for t in b["targets"]]
    assert [t["cls"] for t in a["targets"]] == [t["cls"] for t in b["targets"]]
    assert [t["meanDb"] for t in a["targets"]] == [t["meanDb"] for t in b["targets"]]


def test_targets_carry_confidence_and_uncertainty(tmp_path) -> None:
    _seen, result = _run(tmp_path)
    assert result["targets"]
    for t in result["targets"]:
        assert 0.0 < t["sarConf"] <= 1.0
        assert t["lenUncM"] > 0
        assert t["cls"] in {
            "SAR_MATCHED_AIS", "SAR_UNMATCHED", "AIS_ONLY",
            "STATIONARY_OR_INFRASTRUCTURE", "SEA_CLUTTER", "LOW_CONFIDENCE", "UNRESOLVED",
        }