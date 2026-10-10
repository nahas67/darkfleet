"""Two historical RTC source windows: verified pixels, explicit non-availability."""

from __future__ import annotations

import copy
import io
import json
from pathlib import Path

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from darkfleet.api.routes import ApiState
from darkfleet.api.sar_imagery_routes import router
from darkfleet.config.settings import Settings
from darkfleet.sar_scene_imagery import imagery_pair, scene_image_png, scene_imagery
from darkfleet.storage.cache import ArtifactCache, CacheKey
from darkfleet.storage.runs import mark_synthetic, run_store_for_data_dir


def _save(
    root: Path, scan_id: str, data: np.ndarray, *,
    crs: str = "EPSG:4326", polar: str = "VV", product: str = "RTC",
    affine: list[float] | None = None,
) -> CacheKey:
    h, w = data.shape
    scene = {
        "item_id": f"sentinel-{scan_id}", "provider": "planetary-computer",
        "collection": "sentinel-1-rtc", "platform": "sentinel-1a",
        "acquisition_time": ("2026-09-01T00:00:00Z" if scan_id == "ONE"
                             else "2026-09-02T00:00:00Z"),
        "product": product, "polarization": polar, "crs": crs,
        "transform": affine or [0.1, 0, 100, 0, -0.1, 10],
        "raster_window": [5, 6, h, w],
    }
    key = CacheKey(scene_item_id=scene["item_id"], bbox=(99.0, 9.0, 101.0, 11.0),
                   processing_config={"kernel": 3}, algorithm_version="science-v1")
    ArtifactCache(root / "cache", "science-v1").put(key, "normalized", data.astype(np.float32))
    record = mark_synthetic({
        "scan_id": scan_id, "scene": scene,
        "stage": "COMPLETE", "provenance": {"sar": copy.deepcopy(scene)},
        "debug": {"layers": ["normalized"], "cache": {
            "scene_item_id": key.scene_item_id, "algorithm_version": key.algorithm_version,
            "bbox": list(key.bbox), "processing_config": dict(key.processing_config),
        }},
    })
    run_store_for_data_dir(root).save(record)
    return key


def _app(root: Path) -> FastAPI:
    app = FastAPI()
    app.state.darkfleet_state = ApiState.build(Settings(data_dir=str(root)))
    app.include_router(router)
    return app


def test_pixels_mask_native_metadata_fixed_display_and_restart(tmp_path: Path):
    _save(tmp_path, "ONE", np.array([[-30., 5., np.nan], [-12.5, 30., -200.]]))
    _save(tmp_path, "TWO", np.array([[-35., 3., 0.], [-10., 10., -90.]]),
          crs="EPSG:3857", polar="VH", affine=[10, 0, 1000, 0, -10, 1000])
    before = {str(p.relative_to(tmp_path)): p.read_bytes()
              for p in tmp_path.rglob("*") if p.is_file()}
    response = imagery_pair(tmp_path, "ONE", "TWO")
    assert response.status == "READY"
    assert response.first.source == "PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC"
    assert response.first.source_shape == [2, 3]
    assert response.first.raster_window == [5, 6, 2, 3]  # [row,col,height,width]
    assert response.first.preview_shape == [2, 3]
    assert response.first.valid_source_pixels == 5
    assert response.first.display_window_db == [-30, 5]
    assert response.first.crs == "EPSG:4326"
    assert response.first.wgs84_corners_lon_lat == [
        [100.0, 10.0], [100.3, 10.0], [100.3, 9.8], [100.0, 9.8],
    ]
    assert response.second.crs == "EPSG:3857"
    assert response.second.polarization == "VH"
    assert "No pixel alignment" in response.interpretation
    pixels = np.asarray(Image.open(io.BytesIO(scene_image_png(tmp_path, "ONE"))).convert("RGBA"))
    assert pixels.shape == (2, 3, 4)
    assert pixels[0, 0].tolist() == [0, 0, 0, 255]
    assert pixels[0, 1].tolist() == [255, 255, 255, 255]
    assert pixels[0, 2, 3] == 0  # real NoData is TRANSPARENT, not a black observation
    assert pixels[1, 0, 0] in (127, 128)
    assert pixels[1, 1, :3].tolist() == [255, 255, 255]
    assert scene_image_png(tmp_path, "ONE") == scene_image_png(tmp_path, "ONE")
    assert before == {str(p.relative_to(tmp_path)): p.read_bytes()
                      for p in tmp_path.rglob("*") if p.is_file()}


def test_missing_scan_false_source_no_data_and_distinct_reason(tmp_path: Path):
    _save(tmp_path, "ONE", np.full((2, 3), np.nan))
    _save(tmp_path, "TWO", np.ones((2, 3)), product="GRD")
    pair = imagery_pair(tmp_path, "ONE", "TWO")
    assert pair.status == "UNAVAILABLE"
    assert pair.first.reason == "NO_VALID_CALIBRATED_SAMPLES"
    assert pair.second.reason == "RTC_CALIBRATED_PRODUCT_REQUIRED"
    assert pair.first.image_url is None and pair.first.source is None
    assert scene_imagery(tmp_path, "UNKNOWN").reason == "PERSISTED_REAL_SCAN_MISSING"
    assert scene_imagery(tmp_path, "../ONE").reason == "INVALID_SCAN_REFERENCE"
    fake = run_store_for_data_dir(tmp_path).get("TWO")
    assert fake is not None
    fake["synthetic"] = True
    (tmp_path / "scans" / "TWO.json").write_text(json.dumps(fake), encoding="utf-8")
    assert scene_imagery(tmp_path, "TWO").reason == "PERSISTED_REAL_SCAN_MISSING"


def test_corrupt_artifact_source_mismatch_and_unsafe_bounds(tmp_path: Path):
    key = _save(tmp_path, "ONE", np.ones((2, 3)))
    entry = tmp_path / "cache" / key.shard / key.directory
    meta = entry / "normalized.meta.json"
    valid_meta = meta.read_text(encoding="utf-8")
    corrupted = json.loads(valid_meta)
    corrupted["shape"] = [50_000, 50_000]
    meta.write_text(json.dumps(corrupted), encoding="utf-8")
    assert scene_imagery(tmp_path, "ONE").reason == "SOURCE_RASTER_DIMENSIONS_INVALID_OR_OVERSIZE"
    meta.write_text(valid_meta, encoding="utf-8")
    record = run_store_for_data_dir(tmp_path).get("ONE")
    assert record is not None
    record["debug"]["cache"]["scene_item_id"] = "incorrect-source"
    run_store_for_data_dir(tmp_path).save(record)
    assert scene_imagery(tmp_path, "ONE").reason == "CACHE_SCENE_IDENTITY_MISMATCH"
    record["debug"]["cache"]["scene_item_id"] = key.scene_item_id
    record["provenance"]["sar"]["polarization"] = "VH"
    run_store_for_data_dir(tmp_path).save(record)
    assert scene_imagery(tmp_path, "ONE").reason == "SAR_SOURCE_PROVENANCE_INCONSISTENT"
    record["provenance"]["sar"]["polarization"] = "VV"
    run_store_for_data_dir(tmp_path).save(record)
    (entry / "normalized.npz").write_bytes(b"checksum invalid")
    assert scene_imagery(tmp_path, "ONE").reason == "CALIBRATED_CACHE_MISSING_OR_CORRUPT"


def test_rectangular_decimation_and_invalid_affine(tmp_path: Path):
    raster = np.full((3, 1100), -20, dtype=np.float32)
    raster[0, ::2] = np.nan
    _save(tmp_path, "ONE", raster, affine=[0.01, 0, 100, 0, -0.01, 10])
    manifest = scene_imagery(tmp_path, "ONE")
    assert manifest.status == "READY"
    assert manifest.sample_stride == 2
    assert manifest.preview_shape == [2, 550]
    assert manifest.displayed_valid_pixels == 550  # masked first row; second row valid
    with Image.open(io.BytesIO(scene_image_png(tmp_path, "ONE"))) as png:
        assert png.size == (550, 2)
    _save(tmp_path, "TWO", np.ones((2, 3)), affine=[1, 0, 0, 0, 1, 0])
    assert scene_imagery(tmp_path, "TWO").reason == (
        "GEOREFERENCE_AFFINE_UNREFERENCED_OR_SINGULAR"
    )
    _save(tmp_path, "TWO", np.ones((2, 3)), affine=[0.1, 0, 1000, 0, -0.1, 10])
    assert scene_imagery(tmp_path, "TWO").reason == "GEOREFERENCE_CORNERS_NOT_VERIFIABLE"


def test_http_valid_404_like_refusal_and_strict_body(tmp_path: Path):
    _save(tmp_path, "ONE", np.array([[1., np.nan], [2., 3.]]))
    _save(tmp_path, "TWO", np.array([[2., 3.], [4., 5.]]))
    with TestClient(_app(tmp_path)) as client:
        candidates = client.get("/api/sar/imagery/scans")
        assert candidates.status_code == 200
        assert candidates.json()["total_real_scans"] == 2
        pair = client.post("/api/sar/imagery/pair", json={
            "first_scan_id": "ONE", "second_scan_id": "TWO",
        })
        assert pair.status_code == 200
        assert pair.json()["status"] == "READY"
        assert pair.json()["first"]["image_url"] == "/api/sar/imagery/scans/ONE/image"
        image = client.get("/api/sar/imagery/scans/ONE/image")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"
        assert image.headers["cache-control"] == "private, no-store"
        assert Image.open(io.BytesIO(image.content)).mode == "RGBA"
        bad = client.get("/api/sar/imagery/scans/UNKNOWN/image")
        assert bad.status_code == 409
        assert bad.json()["detail"]["reason"] == "PERSISTED_REAL_SCAN_MISSING"
        assert client.get("/api/sar/imagery/scans/dot.scan/image").status_code == 422
        assert client.post("/api/sar/imagery/pair", json={
            "first_scan_id": "ONE", "second_scan_id": "ONE",
        }).status_code == 422
        assert client.post("/api/sar/imagery/pair", json={
            "first_scan_id": "ONE", "second_scan_id": "TWO", "remote_url": "https://example.org",
        }).status_code == 422
