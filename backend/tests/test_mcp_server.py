"""Real MCP stdio handshake and local persisted-evidence tests (offline only)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from darkfleet.ais.archive import AisArchive
from darkfleet.ais.models import AisObservation
from darkfleet.mcp_server import EvidenceReader
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _seed(data_dir: Path) -> None:
    run_store_for_data_dir(data_dir).save(mark_synthetic({
        "scan_id": "DF-EVIDENCE-001",
        "stage": "COMPLETE",
        "created_at": "2026-09-18T15:00:00Z",
        "aoi": [100.0, 1.0, 101.0, 2.0],
        "counts": {"SAR_MATCHED_AIS": 1},
        "provenance": {
            "processing_version": "measured-pipeline",
            "provider": "fixture-source",
            "private_token": "NEVER_EXPOSE_THIS_TOKEN",
        },
        "scene": {
            "item_id": "SCENE-01",
            "provider": "source-archive",
            "platform": "sentinel-1a",
            "acquisition_time": "2026-09-18T15:00:00Z",
            "signed_asset_url": "https://sensitive.invalid/secret",
        },
        "targets": [{
            "id": "DF-001", "cls": "SAR_MATCHED_AIS",
            "lat": 1.25, "lon": 100.25, "sarConf": 0.91,
            "corr": {
                "mmsi": "123456789", "distanceOffsetMeters": 235.2,
                "scoreDecomposition": {"spatialScore": 0.87, "temporalScore": None},
            },
            "ais": {
                "observation": {
                    "timestamp": "2026-09-18T15:00:00Z",
                    "mmsi": "123456789", "lat": 1.2502, "lon": 100.2502,
                },
            },
        }, {
            "id": "DF-002", "cls": "SAR_UNMATCHED",
            "lat": None, "lon": None, "corr": {"mmsi": None},
        }],
        "ais_only": [],
    }))
    AisArchive(data_dir).append([
        AisObservation(
            timestamp=datetime(2026, 9, 18, 15, tzinfo=UTC),
            mmsi="123456789", lat=1.2502, lon=100.2502,
            cog=None, heading=None, source="file-import",
        ),
        AisObservation(
            timestamp=datetime(2026, 9, 18, 15, 1, tzinfo=UTC),
            mmsi="987654321", lat=1.255, lon=100.255,
            sog=12.0, source="file-import",
        ),
    ])


def test_reader_provenance_missingness_and_output_limits(tmp_path: Path) -> None:
    _seed(tmp_path)
    reader = EvidenceReader(tmp_path)
    existing_files = {p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file()}
    scan = reader.get_scan("DF-EVIDENCE-001")
    assert scan["status"] == "AVAILABLE"
    assert scan["target_count"] == 2
    assert scan["provenance"]["scene"]["item_id"] == "SCENE-01"
    assert "NEVER_EXPOSE_THIS_TOKEN" not in json.dumps(scan)
    assert "sensitive.invalid" not in json.dumps(scan)
    assert reader.get_scan("DF-NOT-FOUND")["reason"] == "NO_PERSISTED_REAL_SCAN"
    assert reader.list_scans(limit=1)["total"] == 1
    targets = reader.list_scan_targets("DF-EVIDENCE-001", limit=1, offset=1)
    assert targets["targets"][0]["id"] == "DF-002"
    assert targets["targets"][0]["correlation"]["mmsi"] is None
    evidence = reader.get_target_evidence("DF-EVIDENCE-001", "DF-001")
    assert evidence["target"]["correlation"]["distanceOffsetMeters"] == 235.2
    assert evidence["associated_ais_observation"]["mmsi"] == "123456789"
    assert reader.get_target_evidence("DF-EVIDENCE-001", "DF-NOT-THERE")["reason"] == (
        "TARGET_ABSENT_FROM_SCAN"
    )
    assert reader.get_maritime_context("DF-EVIDENCE-001", "DF-002")["reason"] == (
        "TARGET_POSITION_UNAVAILABLE"
    )
    maritime = reader.get_maritime_context("DF-EVIDENCE-001", "DF-001")
    assert maritime["status"] == "AVAILABLE"
    assert maritime["maritime_context"]["scan_id"] == "DF-EVIDENCE-001"
    assert maritime["maritime_context"]["target_id"] == "DF-001"
    assert "provenance" in maritime["maritime_context"]["maritime_zone"]
    assert {p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file()} == existing_files


def test_mcp_does_not_surface_signed_urls_or_unbounded_nested_source_values(tmp_path: Path) -> None:
    _seed(tmp_path)
    store = run_store_for_data_dir(tmp_path)
    record = store.get("DF-EVIDENCE-001")
    assert record is not None
    record["created_at"] = "https://private.invalid/?token=INTERNAL_SECRET"
    record["acquisition_time"] = "https://private.invalid/?token=INTERNAL_SECRET"
    record["aoi"] = {"secret": "INTERNAL_SECRET"}
    record["counts"]["PRIVATE_TOKEN"] = {"secret": "INTERNAL_SECRET"}
    record["scene"]["provider"] = "https://private.invalid/?token=INTERNAL_SECRET"
    record["targets"][0]["corr"]["vesselName"] = "https://private.invalid/?token=INTERNAL_SECRET"
    record["targets"][0]["ais"]["observation"]["source"] = "https://private.invalid/?token=INTERNAL_SECRET"
    store.save(record)
    reader = EvidenceReader(tmp_path)
    outputs = [
        reader.list_scans(), reader.get_scan("DF-EVIDENCE-001"),
        reader.list_scan_targets("DF-EVIDENCE-001"),
        reader.get_target_evidence("DF-EVIDENCE-001", "DF-001"),
    ]
    serialized = json.dumps(outputs)
    assert "INTERNAL_SECRET" not in serialized
    assert "private.invalid" not in serialized
    assert reader.get_scan("DF-EVIDENCE-001")["aoi"] is None


def test_mcp_redacts_archive_observation_private_metadata(tmp_path: Path) -> None:
    _seed(tmp_path)
    AisArchive(tmp_path).append([AisObservation(
        timestamp=datetime(2026, 9, 18, 15, 2, tzinfo=UTC),
        mmsi="111222333", lat=1.25, lon=100.25, source="file-import",
        name="https://private.invalid/?token=INTERNAL_SECRET",
        callsign="VESSEL?token=INTERNAL_SECRET",
    )])
    reader = EvidenceReader(tmp_path)
    row = reader.query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T15:02:00Z", "2026-09-18T15:02:00Z",
    )
    assert row["status"] == "AVAILABLE"
    assert row["observations"][0]["mmsi"] == "111222333"
    assert "name" not in row["observations"][0]
    assert "callsign" not in row["observations"][0]
    assert "INTERNAL_SECRET" not in json.dumps(row)


def test_mcp_rejects_ais_partition_symlink_outside_archive(tmp_path: Path) -> None:
    _seed(tmp_path)
    original = next((tmp_path / "ais").rglob("part-*.parquet"))
    external = tmp_path / "external-parquet.parquet"
    external.write_bytes(original.read_bytes())
    original.unlink()
    try:
        original.symlink_to(external)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"File symlinks unavailable: {exc}")
    result = EvidenceReader(tmp_path).query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T14:00:00Z", "2026-09-18T16:00:00Z",
    )
    assert result["status"] == "UNAVAILABLE"
    assert result["reason"] == "AIS_ARCHIVE_PATH_OUTSIDE_ROOT"


@pytest.mark.skipif(os.name != "nt", reason="Windows junction boundary test")
def test_mcp_rejects_junction_redirected_ais_archive(tmp_path: Path) -> None:
    _seed(tmp_path)
    archive = tmp_path / "ais"
    outside = tmp_path / "elsewhere"
    archive.rename(outside)
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(archive), str(outside)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        pytest.skip(f"Directory junctions unavailable: {result.stderr}")
    response = EvidenceReader(tmp_path).query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T14:00:00Z", "2026-09-18T16:00:00Z",
    )
    assert response["status"] == "UNAVAILABLE"
    assert response["reason"] == "AIS_ARCHIVE_PATH_OUTSIDE_ROOT"


def test_mcp_preserves_real_serialized_processing_class_and_refuses_conflicts(tmp_path: Path) -> None:
    """RunStore uses `cls` and the API maps it to `classification`."""
    _seed(tmp_path)
    store = run_store_for_data_dir(tmp_path)
    record = store.get("DF-EVIDENCE-001")
    assert record is not None
    record["targets"][0]["cls"] = "SEA_CLUTTER"
    store.save(record)
    reader = EvidenceReader(tmp_path)
    actual = reader.get_target_evidence("DF-EVIDENCE-001", "DF-001")
    assert actual["target"]["cls"] == "SEA_CLUTTER"
    assert "classification" not in actual["target"]
    record["targets"][0].pop("cls")
    record["targets"][0]["classification"] = "SEA_CLUTTER"
    store.save(record)
    actual = reader.get_target_evidence("DF-EVIDENCE-001", "DF-001")
    assert actual["target"]["classification"] == "SEA_CLUTTER"
    assert "cls" not in actual["target"]
    assert reader.list_scan_targets("DF-EVIDENCE-001")["targets"][0]["classification"] == "SEA_CLUTTER"
    record["targets"][0]["cls"] = "SAR_UNMATCHED"
    store.save(record)
    ambiguous = reader.get_target_evidence("DF-EVIDENCE-001", "DF-001")
    assert ambiguous["target"]["classification_status"] == "INCONSISTENT_STORED_SOURCE_FIELDS"
    assert "classification" not in ambiguous["target"] and "cls" not in ambiguous["target"]


def test_mcp_missing_target_array_is_unknown_not_zero_or_absent(tmp_path: Path) -> None:
    _seed(tmp_path)
    store = run_store_for_data_dir(tmp_path)
    record = store.get("DF-EVIDENCE-001")
    assert record is not None
    del record["targets"]
    store.save(record)
    reader = EvidenceReader(tmp_path)
    assert reader.list_scans()["scans"][0]["target_count"] is None
    assert reader.get_scan("DF-EVIDENCE-001")["target_count"] is None
    target_list = reader.list_scan_targets("DF-EVIDENCE-001")
    assert target_list["status"] == "MISSING_EVIDENCE"
    assert target_list["reason"] == "TARGETS_NOT_RECORDED"
    assert reader.get_target_evidence("DF-EVIDENCE-001", "DF-001")["reason"] == "TARGETS_NOT_RECORDED"
    assert reader.get_maritime_context("DF-EVIDENCE-001", "DF-001")["reason"] == "TARGETS_NOT_RECORDED"


def test_scan_guard_and_invalid_inputs(tmp_path: Path) -> None:
    _seed(tmp_path)
    store = run_store_for_data_dir(tmp_path)
    # Poisoned legacy evidence is rejected rather than surfaced to an MCP client.
    poison = tmp_path / "scans" / "DF-NOT-REAL.json"
    poison.write_text(json.dumps({
        "scan_id": "DF-NOT-REAL", "runtime_mode": "REAL", "synthetic": True,
        "targets": [{"id": "FAKE", "lat": 0, "lon": 0}],
    }), encoding="utf-8")
    reader = EvidenceReader(tmp_path)
    assert reader.get_scan("DF-NOT-REAL")["status"] == "MISSING_EVIDENCE"
    assert reader.list_scans()["total"] == 1
    with pytest.raises(ValueError, match="scan_id"):
        reader.get_scan("../secrets")
    with pytest.raises(ValueError, match="target_id"):
        reader.get_target_evidence("DF-EVIDENCE-001", "..\\secret")
    with pytest.raises(ValueError, match="limit"):
        reader.list_scan_targets("DF-EVIDENCE-001", limit=10_000)
    with pytest.raises(ValueError, match="offset"):
        reader.list_scans(offset=-1)
    with pytest.raises(ValueError, match="mmsi"):
        reader.query_scan_ais(
            "DF-EVIDENCE-001", "2026-09-18T00:00Z", "2026-09-19T00:00Z", "1234",
        )
    with pytest.raises(ValueError, match="timezone"):
        reader.query_scan_ais(
            "DF-EVIDENCE-001", "2026-09-18T00:00:00", "2026-09-19T00:00:00Z",
        )
    with pytest.raises(ValueError, match="7 days"):
        reader.query_scan_ais(
            "DF-EVIDENCE-001", "2026-09-01T00:00Z", "2026-09-18T00:00Z",
        )
    assert store.get("DF-EVIDENCE-001") is not None


def test_archive_real_parquet_and_explicit_missing_data(tmp_path: Path) -> None:
    _seed(tmp_path)
    reader = EvidenceReader(tmp_path)
    result = reader.query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T14:00:00Z",
        "2026-09-18T16:00:00Z", limit=1,
    )
    assert result["status"] == "AVAILABLE"
    assert result["observations"][0]["mmsi"] == "123456789"
    assert result["observations"][0]["sog"] is None
    assert result["has_more"] is True
    second = reader.query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T14:00:00Z",
        "2026-09-18T16:00:00Z", limit=1, offset=1,
    )
    assert second["observations"][0]["mmsi"] == "987654321"
    assert second["has_more"] is False
    no_match = reader.query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T14:00:00Z",
        "2026-09-18T16:00:00Z", mmsi="000000000",
    )
    assert no_match["status"] == "NO_OBSERVATIONS_IN_WINDOW"
    assert no_match["observations"] == []
    beyond_last = reader.query_scan_ais(
        "DF-EVIDENCE-001", "2026-09-18T14:00:00Z",
        "2026-09-18T16:00:00Z", limit=1, offset=100,
    )
    assert beyond_last["status"] == "PAGE_EMPTY"
    empty = tmp_path / "empty"
    empty.mkdir()
    run_store_for_data_dir(empty).save(mark_synthetic({
        "scan_id": "DF-EMPTY", "targets": [], "ais_only": [],
    }))
    missing_archive = EvidenceReader(empty).query_scan_ais(
        "DF-EMPTY", "2026-09-18T14:00:00Z", "2026-09-18T16:00:00Z",
    )
    assert missing_archive["status"] == "MISSING_EVIDENCE"
    assert missing_archive["reason"] == "AIS_ARCHIVE_NOT_PRESENT"
    assert not (empty / "ais").exists()


def test_actual_sdk_stdio_integration(tmp_path: Path) -> None:
    """Spawn real Python stdio server, negotiate MCP and call all six exposed tools."""
    _seed(tmp_path)
    original_files = {p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file()}
    backend_root = Path(__file__).resolve().parents[1]
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "tools.mcp_evidence", "--data-dir", str(tmp_path)],
        env={
            **os.environ,
            "PYTHONPATH": str(backend_root),
            "PYTHONUNBUFFERED": "1",
        },
    )

    async def exercise_stdio() -> None:
        async with (
            stdio_client(params) as (reader, writer),
            ClientSession(reader, writer) as session,
        ):
                initialized = await session.initialize()
                assert initialized.protocolVersion
                tools = await session.list_tools()
                declared = {item.name for item in tools.tools}
                assert declared == {
                    "list_real_scans", "get_real_scan", "list_real_scan_targets",
                    "get_real_target_evidence", "query_persisted_ais",
                    "get_real_target_maritime_context",
                }
                assert all(tool.annotations and tool.annotations.readOnlyHint for tool in tools.tools)

                async def call(name: str, args: dict[str, Any]) -> dict[str, Any]:
                    result = await session.call_tool(name, args)
                    assert not result.isError, result
                    assert result.content, result
                    return json.loads(result.content[0].text)

                listed = await call("list_real_scans", {"limit": 10})
                assert listed["total"] == 1
                scan = await call("get_real_scan", {"scan_id": "DF-EVIDENCE-001"})
                assert scan["status"] == "AVAILABLE"
                targets = await call("list_real_scan_targets", {"scan_id": "DF-EVIDENCE-001"})
                assert targets["total"] == 2
                target = await call("get_real_target_evidence", {
                    "scan_id": "DF-EVIDENCE-001", "target_id": "DF-001",
                })
                assert target["target"]["correlation"]["mmsi"] == "123456789"
                ais = await call("query_persisted_ais", {
                    "scan_id": "DF-EVIDENCE-001",
                    "start_utc": "2026-09-18T14:00:00Z",
                    "end_utc": "2026-09-18T16:00:00Z",
                    "limit": 1,
                })
                assert ais["status"] == "AVAILABLE"
                context = await call("get_real_target_maritime_context", {
                    "scan_id": "DF-EVIDENCE-001", "target_id": "DF-002",
                })
                assert context["reason"] == "TARGET_POSITION_UNAVAILABLE"
                missing = await call("get_real_target_evidence", {
                    "scan_id": "DF-EVIDENCE-001", "target_id": "DF-MISSING",
                })
                assert missing["status"] == "MISSING_EVIDENCE"
                refused = await session.call_tool("list_real_scans", {"limit": 1000})
                assert refused.isError

    anyio.run(exercise_stdio)
    assert {p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file()} == original_files
