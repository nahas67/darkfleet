"""DF-X10/X11: actual persisted scan+checksum cache, exact WGS84 grid science."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from darkfleet.api.routes import ApiState
from darkfleet.api.sar_compare_routes import router
from darkfleet.config.settings import Settings
from darkfleet.sar_scene_compare import compare_scenes, scene_candidates
from darkfleet.storage.cache import ArtifactCache, CacheKey
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir

VERSION = "science-v1"
ORIGIN = [0.1, 0.0, 100.0, 0.0, -0.1, 10.0]
SOURCE_ARRAY = np.array([[1.0, 2.0, 3.0], [4.0, np.nan, 6.0], [7.0, 8.0, 9.0]])


def _write_scan(
    root: Path, scan_id: str, array: np.ndarray, *,
    transform: list[float] | None = None, product: str = "RTC",
    polarization: str = "VV", crs: str = "EPSG:4326", time: str | None = None,
    item_id: str | None = None,
) -> None:
    item = item_id or f"sentinel1-{scan_id}"
    affine = transform or ORIGIN
    if time is None:
        time = "2026-09-02T00:00:00Z" if scan_id == "B" else "2026-09-01T00:00:00Z"
    scene = {
        "item_id": item, "provider": "planetary-computer", "collection": "sentinel-1-rtc",
        "platform": "sentinel-1a", "acquisition_time": time,
        "product": product, "polarization": polarization,
        "crs": crs, "transform": affine, "raster_window": [0, 0, 3, 3],
    }
    key = CacheKey(
        scene_item_id=item, bbox=(99.0, 9.0, 101.0, 11.0),
        processing_config={"kernel": 3}, algorithm_version=VERSION,
    )
    ArtifactCache(root / "cache", VERSION).put(key, "normalized", array.astype(np.float32))
    record = mark_synthetic({
        "scan_id": scan_id, "scene": scene, "aoi": [99, 9, 101, 11],
        "stage": "COMPLETE", "provenance": {"sar": copy.deepcopy(scene)},
        "debug": {
            "layers": ["normalized"],
            "cache": {
                "scene_item_id": item, "bbox": [99, 9, 101, 11],
                "processing_config": {"kernel": 3},
                "algorithm_version": VERSION,
            },
        },
    })
    run_store_for_data_dir(root).save(record)


def _app(root: Path) -> FastAPI:
    app = FastAPI()
    app.state.darkfleet_state = ApiState.build(Settings(data_dir=str(root)))
    app.include_router(router)
    return app


def test_exact_grid_measured_stats_masks_and_restart_read_only(tmp_path: Path):
    _write_scan(tmp_path, "A", SOURCE_ARRAY)
    # B starts at A (row=1,col=1), so B[0,0] corresponds to A[1,1] (NaN).
    # Three non-null overlap pairs: A[1,2]=6, A[2,1]=8, A[2,2]=9.
    b = np.array([[100, 7, 99], [9, 11, 11], [10, 10, 10]], dtype=float)
    transform_b = [0.1, 0, 100.1, 0, -0.1, 9.9]
    _write_scan(
        tmp_path, "B", b, transform=transform_b, time="2026-09-02T00:00:00Z",
    )
    before = {
        str(f.relative_to(tmp_path)): f.read_bytes() for f in tmp_path.rglob("*") if f.is_file()
    }
    value = compare_scenes(tmp_path, "A", "B")
    assert value.status == "MEASURED", value.reason
    assert value.reason == "EXACT_SAME_AFFINE_PIXEL_LATTICE_RTC_GAMMA0_DB"
    assert value.acquisition_interval_hours == 24
    metrics = value.metrics
    assert metrics is not None
    assert metrics.offset_b_in_a_pixels == [1, 1]
    assert metrics.overlap_shape == [2, 2]
    assert metrics.overlap_pixels == 4
    assert metrics.valid_pair_pixels == 3
    assert metrics.valid_pair_fraction == 0.75
    # Overlap B-values at (A[1,2],A[2,1],A[2,2]) -> (7,9,11), so deltas 1,1,2.
    expected = np.array([1.0, 1.0, 2.0])
    assert metrics.mean_b_minus_a_db == pytest.approx(float(np.mean(expected)))
    assert metrics.median_b_minus_a_db == pytest.approx(1.0)
    assert metrics.root_mean_square_difference_db == pytest.approx(np.sqrt(2.0))
    assert metrics.brighter_b_pixels == 3
    assert metrics.darker_b_pixels == metrics.equal_pixels == 0
    assert value.first.raster_shape == [3, 3]
    assert value.second.raster_shape == [3, 3]
    assert value.metrics.metric == "SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE"
    assert "not demonstrated sub-pixel" in value.caveat
    assert compare_scenes(tmp_path, "A", "B").metrics == value.metrics
    after = {
        str(f.relative_to(tmp_path)): f.read_bytes() for f in tmp_path.rglob("*") if f.is_file()
    }
    assert after == before  # No writes, including no silently persisted derived arrays.


@pytest.mark.parametrize(("change", "reason"), [
    ({"crs": "EPSG:3857"}, "CRS_MISMATCH_NO_WARP"),
    ({"crs": "NOT_A_REAL_CRS"}, "CRS_INVALID"),
    ({"transform": [0.1, 0, 100.05, 0, -0.1, 10]}, "AFFINE_GRIDS_NOT_IDENTICAL_NO_COREGISTRATION"),
    ({"transform": [1, 0, 0, 0, 1, 0]}, "AFFINE_GRIDS_NOT_IDENTICAL_NO_COREGISTRATION"),
    ({"transform": [0.2, 0, 100, 0, -0.1, 10]}, "AFFINE_GRIDS_NOT_IDENTICAL_NO_COREGISTRATION"),
    ({"transform": [0.1, 0, 110.0, 0, -0.1, 10]}, "NO_OVERLAPPING_MEASURED_PIXELS"),
    ({"product": "GRD"}, "RTC_GAMMA0_CALIBRATION_REQUIRED"),
    ({"polarization": "VH"}, "POLARIZATION_MISMATCH_OR_MISSING"),
    ({"time": "2026-09-01T00:00:00Z"}, "DISTINCT_ACQUISITION_TIMES_REQUIRED"),
    ({"item_id": "sentinel1-A"}, "DISTINCT_REAL_ACQUISITIONS_REQUIRED"),
])
def test_incompatible_windows_never_return_pixel_measurements(
    tmp_path: Path, change: dict, reason: str,
):
    _write_scan(tmp_path, "A", SOURCE_ARRAY)
    _write_scan(tmp_path, "B", SOURCE_ARRAY + 1, **change)
    result = compare_scenes(tmp_path, "A", "B")
    assert result.status == "NOT_COMPARABLE"
    assert result.reason == reason
    assert result.metrics is None


def test_missing_corrupt_cache_untrusted_record_and_invalid_pixels(tmp_path: Path):
    _write_scan(tmp_path, "A", SOURCE_ARRAY)
    _write_scan(tmp_path, "B", np.full((3, 3), np.nan),
                time="2026-09-02T00:00:00Z")
    assert compare_scenes(tmp_path, "A", "B").reason == "NO_SHARED_VALID_RTC_SAMPLES"
    assert compare_scenes(tmp_path, "A", "UNKNOWN").reason == "PERSISTED_REAL_SCAN_MISSING"
    # A legacy fake cannot become evidence even when its SAR scene looks plausible.
    fake = run_store_for_data_dir(tmp_path).get("A")
    assert fake is not None
    fake["scan_id"] = "FAKE"
    fake["synthetic"] = True
    (tmp_path / "scans" / "FAKE.json").write_text(json.dumps(fake), encoding="utf-8")
    assert compare_scenes(tmp_path, "A", "FAKE").reason == "PERSISTED_REAL_SCAN_MISSING"
    record = run_store_for_data_dir(tmp_path).get("B")
    assert record is not None
    record["provenance"]["sar"]["transform"] = [1, 0, 0, 0, -1, 0]
    run_store_for_data_dir(tmp_path).save(record)
    assert compare_scenes(tmp_path, "A", "B").reason == (
        "SAR_CALIBRATION_OR_GEOREFERENCE_PROVENANCE_MISSING"
    )
    record["provenance"]["sar"]["transform"] = ORIGIN
    run_store_for_data_dir(tmp_path).save(record)
    # Corrupt a checksum-protected .npz; reader must not return anything.
    blobs = sorted((tmp_path / "cache").rglob("normalized.npz"))
    assert len(blobs) == 2
    blobs[0].write_bytes(b"corrupted")
    assert compare_scenes(tmp_path, "A", "B").reason in (
        "CALIBRATED_CACHE_MISSING_OR_CORRUPT", "NO_SHARED_VALID_RTC_SAMPLES",
    )


def test_api_real_candidates_validation_and_unmounted_router(tmp_path: Path):
    _write_scan(tmp_path, "A", SOURCE_ARRAY)
    _write_scan(tmp_path, "B", SOURCE_ARRAY + 2,
                time="2026-09-02T00:00:00Z")
    assert scene_candidates(tmp_path).total_real_scans == 2
    with TestClient(_app(tmp_path)) as client:
        listing = client.get("/api/sar/compare/scans")
        assert listing.status_code == 200
        assert listing.json()["total_real_scans"] == 2
        assert {s["scan_id"] for s in listing.json()["scenes"]} == {"A", "B"}
        assert all(s["georeference_present"] for s in listing.json()["scenes"])
        compare = client.post("/api/sar/compare", json={
            "first_scan_id": "A", "second_scan_id": "B",
        })
        assert compare.status_code == 200
        assert compare.json()["status"] == "MEASURED"
        assert compare.json()["metrics"]["mean_b_minus_a_db"] == pytest.approx(2.0)
        assert compare.json()["metrics"]["valid_pair_pixels"] == 8
        assert client.get("/api/sar/compare/scans?limit=0").status_code == 422
        assert client.post("/api/sar/compare", json={
            "first_scan_id": "A", "second_scan_id": "A",
        }).status_code == 422
        assert client.post("/api/sar/compare", json={
            "first_scan_id": "../A", "second_scan_id": "B",
        }).status_code == 422
        assert client.post("/api/sar/compare", json={
            "first_scan_id": "A", "second_scan_id": "B", "simulate": True,
        }).status_code == 422
