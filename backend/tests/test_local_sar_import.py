"""Local SAR intake contracts: actual GeoTIFF pixels, isolation and durable provenance."""

from __future__ import annotations

import errno
import hashlib
import io
import os
from pathlib import Path

import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from PIL import Image
from rasterio.transform import Affine, from_origin

from darkfleet import local_sar_import as sar_import
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.local_sar_import import MAX_FILE_BYTES, MAX_PIXELS, import_local_geotiff


def app_for(root: Path):
    return create_app(Settings(data_dir=str(root), log_level="WARNING"))


def tiff(
    root: Path, name: str = "satellite.tif", *, data: np.ndarray | None = None,
    crs: str | None = "EPSG:4326", transform: Affine | None = None,
    nodata: float | None = -9999,
) -> Path:
    inbox = root / "local-sar-inbox"
    inbox.mkdir(exist_ok=True, parents=True)
    if data is None:
        data = np.array([[3., -9999., 5.], [6., 8., 12.]], dtype=np.float32)
    outfile = inbox / name
    with rasterio.open(outfile, "w", driver="GTiff", width=data.shape[1],
                       height=data.shape[0], count=1, dtype=str(data.dtype), crs=crs,
                       transform=transform or from_origin(72., 19., .25, .5),
                       nodata=nodata) as ds:
        ds.write(data, 1)
    return outfile


def request(path: str = "satellite.tif", **fields: object) -> dict:
    return {"relative_path": path, "product": "RTC", "polarization": "VV", **fields}


def test_real_pixels_persist_and_replay_with_verified_archive(tmp_path: Path):
    source = tiff(tmp_path)
    original_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    with TestClient(app_for(tmp_path)) as client:
        status = client.get("/api/sar/local/status")
        assert status.status_code == 200
        assert status.json()["analysis"] == "IMPORT_ONLY"
        resp = client.post("/api/sar/local/import", json=request(
            calibration="GAMMA0_LINEAR", acquisition_time="2026-09-12T06:00:00+00:00"))
        assert resp.status_code == 201, resp.text
        result = resp.json()
        assert result["sha256"] == original_sha
        assert result["status"] == "IMPORTED_NOT_ANALYZED"
        assert result["metadata"]["calibration_verified"] is False
        assert result["metadata"]["valid_pixels"] == 5
        assert result["metadata"]["total_pixels"] == 6
        assert result["metadata"]["wgs84_corners_lon_lat"][0] == [72., 19.]
        assert result["metadata"]["pixel_center_wgs84_lon_lat"] == [72.125, 18.75]
        assert result["source_integrity"] == "VERIFIED"
        assert result["snapshot_integrity"] == "VERIFIED"
        png = client.get(result["image_url"])
        assert png.status_code == 200
        assert png.headers["cache-control"] == "private, no-store"
        with Image.open(io.BytesIO(png.content)) as image:
            assert image.size == (3, 2)
            assert image.mode == "RGBA"
            assert image.getpixel((1, 0))[3] == 0
            assert image.getpixel((2, 1))[3] == 255
            assert image.getpixel((0, 0)) != image.getpixel((2, 1))
        again = client.post("/api/sar/local/import", json=request(
            calibration="GAMMA0_LINEAR", acquisition_time="2026-09-12T06:00:00Z"))
        # ISO 8601 representations are input declarations; unnormalized strings produce
        # different declaration identities unless they normalize to the same ISO form.
        assert again.status_code == 201
        assert again.json()["import_id"] == result["import_id"]
        assert len(list((tmp_path / "local-sar-imports").glob("*.json"))) == 1
        assert client.get("/api/sar/local/imports").json()["total"] == 1
    source.unlink()
    with TestClient(app_for(tmp_path)) as client:
        detail = client.get(f"/api/sar/local/imports/{result['import_id']}")
        assert detail.status_code == 200
        assert detail.json()["source_integrity"] == "MISSING"
        assert detail.json()["snapshot_integrity"] == "VERIFIED"
        assert client.get(result["image_url"]).status_code == 200
        assert list((tmp_path / "local-sar-imports").glob("*.json"))
        # The authoritative scan store must never gain an invented COMPLETE scan.
        assert not (tmp_path / "scans").exists() or not list((tmp_path / "scans").glob("*.json"))


@pytest.mark.parametrize("unsafe", [
    "../satellite.tif", "subdir/satellite.tif", r"subdir\satellite.tif",
    "C:/temp/satellite.tif", "https://example.invalid/a.tif", ".hidden.tif",
    "aaa..tif", "satellite.tif:stream", "satellite.jpg", "/tmp/a.tif", "a%2fb.tif",
])
def test_path_injection_rejected_without_path_leak(tmp_path: Path, unsafe: str):
    with TestClient(app_for(tmp_path)) as client:
        r = client.post("/api/sar/local/import", json=request(unsafe))
    assert r.status_code == 422
    assert str(tmp_path) not in r.text


def test_external_remote_peer_blocked_even_with_forwarded_loopback_headers(tmp_path: Path):
    tiff(tmp_path)
    app = app_for(tmp_path)
    with TestClient(app, client=("198.51.100.33", 4321)) as client:
        headers = {"Host": "localhost", "Origin": "http://localhost:5173",
                   "X-Forwarded-For": "127.0.0.1"}
        for method, path in [("get", "/api/sar/local/status"),
                             ("get", "/api/sar/local/imports"),
                             ("post", "/api/sar/local/import")]:
            resp = getattr(client, method)(path, headers=headers,
                                           **({"json": request()} if method == "post" else {}))
            assert resp.status_code == 403


def test_symlink_source_rejected(tmp_path: Path):
    source = tiff(tmp_path)
    linked = source.parent / "link.tif"
    try:
        linked.symlink_to(source)
    except (OSError, NotImplementedError):
        pytest.skip("Insufficient privileges to create a file symlink")
    with TestClient(app_for(tmp_path)) as client:
        bad = client.post("/api/sar/local/import", json=request("link.tif"))
        assert bad.status_code == 403
        assert bad.json()["status"] == "SOURCE_LINK_NOT_ALLOWED"


def test_hardlink_to_file_outside_inbox_rejected(tmp_path: Path):
    original = tiff(tmp_path)
    external = tmp_path / "external.tif"
    original.rename(external)
    linked = tmp_path / "local-sar-inbox" / "linked.tif"
    try:
        linked.hardlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("Filesystem does not support hardlinks")
    with TestClient(app_for(tmp_path)) as client:
        rejected = client.post("/api/sar/local/import", json=request("linked.tif"))
    assert rejected.status_code == 403
    assert rejected.json()["status"] == "SOURCE_HARDLINK_NOT_ALLOWED"


@pytest.mark.parametrize(("crs", "transform", "data", "code"), [
    (None, from_origin(72, 19, .5, .5), np.ones((4, 4), dtype="float32"),
     "GEOREFERENCE_CRS_MISSING"),
    ("EPSG:4326", Affine.identity(), np.ones((4, 4), dtype="float32"),
     "GEOREFERENCE_AFFINE_INVALID"),
    ("EPSG:4326", from_origin(72, 19, .5, .5), np.full((4, 4), -9999., dtype="float32"),
     "RASTER_HAS_NO_VALID_PIXELS"),
    ("EPSG:4326", from_origin(999, 999, .5, .5), np.ones((4, 4), dtype="float32"),
     "GEOREFERENCE_OUTSIDE_WGS84"),
])
def test_ungeoreferenced_empty_or_impossible_raster_rejected(
    tmp_path: Path, crs: str | None, transform: Affine,
    data: np.ndarray, code: str,
):
    tiff(tmp_path, crs=crs, transform=transform, data=data)
    with TestClient(app_for(tmp_path)) as client:
        result = client.post("/api/sar/local/import", json=request())
    assert result.status_code == 422, result.text
    assert result.json()["status"] == code
    assert not list((tmp_path / "local-sar-imports").glob("*.json"))
    assert not list((tmp_path / "local-sar-imports").glob(".ingest-*.tif"))


def test_oversize_rejected_before_raster_open(tmp_path: Path):
    inbox = tmp_path / "local-sar-inbox"
    inbox.mkdir()
    with (inbox / "big.tif").open("wb") as outfile:
        outfile.seek(MAX_FILE_BYTES)
        outfile.write(b"x")
    with TestClient(app_for(tmp_path)) as client:
        resp = client.post("/api/sar/local/import", json=request("big.tif"))
    assert resp.status_code == 422
    assert resp.json()["status"] == "SOURCE_EMPTY_OR_EXCEEDS_SIZE_LIMIT"


def test_declared_large_raster_rejected_before_pixel_allocation(tmp_path: Path):
    path = tmp_path / "local-sar-inbox" / "large.tif"
    path.parent.mkdir(parents=True)
    with rasterio.open(path, "w", driver="GTiff", width=4000, height=3000,
                       dtype="float32", count=1, crs="EPSG:4326",
                       transform=from_origin(75, 18, .001, .001)):
        pass
    assert 4000 * 3000 > MAX_PIXELS
    with TestClient(app_for(tmp_path)) as client:
        resp = client.post("/api/sar/local/import", json=request("large.tif"))
    assert resp.status_code == 422
    assert resp.json()["status"] == "RASTER_DIMENSIONS_EXCEED_LIMIT"


def test_source_changed_snapshot_integrity_and_calibration_declared_only(tmp_path: Path):
    tiff(tmp_path)
    with TestClient(app_for(tmp_path)) as client:
        doc = client.post("/api/sar/local/import", json=request(
            product="GRD", calibration="RAW_DN", polarization="VH")).json()
        assert doc["metadata"]["product"] == "GRD"
        assert doc["metadata"]["calibration_verified"] is False
        assert doc["status"] == "IMPORTED_NOT_ANALYZED"
        tiff(tmp_path, data=np.full((2, 3), 30., dtype="float32"))
        detail = client.get(f"/api/sar/local/imports/{doc['import_id']}").json()
        assert detail["source_integrity"] == "CHANGED"
        assert detail["snapshot_integrity"] == "VERIFIED"
        assert client.get(doc["image_url"]).status_code == 200
        snapshot = tmp_path / "local-sar-imports" / f"{doc['import_id']}.tif"
        with snapshot.open("ab") as file:
            file.write(b"tampered")
        assert client.get(doc["image_url"]).status_code == 409
        assert client.get(f"/api/sar/local/imports/{doc['import_id']}").json()[
            "snapshot_integrity"] == "CHANGED"


@pytest.mark.parametrize(("race_point", "error_number", "expected_http", "expected_code"), [
    ("open", errno.ENOENT, 404, "SOURCE_NOT_FOUND"),
    ("stat", errno.ENOENT, 404, "SOURCE_NOT_FOUND"),
    ("open", errno.EACCES, 409, "SOURCE_UNAVAILABLE"),
])
def test_source_disappears_or_becomes_unavailable_between_validation_and_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    race_point: str, error_number: int, expected_http: int, expected_code: str,
):
    source = tiff(tmp_path)
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    with TestClient(app_for(tmp_path)) as client:
        first = client.post("/api/sar/local/import", json=request())
        assert first.status_code == 201, first.text
        original = first.json()
        import_id = original["import_id"]
        receipt_path = tmp_path / "local-sar-imports" / f"{import_id}.json"
        receipt_bytes = receipt_path.read_bytes()
        attempts: list[Path] = []
        original_open = os.open
        original_stat = sar_import._source_stat

        def raced_open(path: str | bytes | os.PathLike, flags: int, *args: object,
                       **kwargs: object) -> int:
            if Path(path) == source:
                attempts.append(source)
                raise OSError(error_number, "source changed after validation", str(source))
            return original_open(path, flags, *args, **kwargs)

        def raced_stat(path: Path) -> os.stat_result:
            if path == source:
                attempts.append(source)
                raise FileNotFoundError(errno.ENOENT, "source disappeared", str(source))
            return original_stat(path)

        with monkeypatch.context() as patch:
            if race_point == "open":
                patch.setattr(sar_import.os, "open", raced_open)
            else:
                patch.setattr(sar_import, "_source_stat", raced_stat)
            response = client.post("/api/sar/local/import", json=request())

        assert attempts == [source]  # Fail exactly after the earlier safe-path validation.
        assert response.status_code == expected_http, response.text
        assert response.json()["status"] == expected_code
        assert response.json()["error"] == "LOCAL_SAR_IMPORT_ERROR"
        assert str(tmp_path) not in response.text
        assert source.exists()  # Deterministic injected race does not mutate operator data.
        assert hashlib.sha256(source.read_bytes()).hexdigest() == source_sha
        assert receipt_path.read_bytes() == receipt_bytes
        assert len(list(receipt_path.parent.glob("*.json"))) == 1
        assert not list(receipt_path.parent.glob(".ingest-*.tif"))
        detail = client.get(f"/api/sar/local/imports/{import_id}")
        assert detail.status_code == 200
        assert detail.json()["source_integrity"] == "VERIFIED"
        assert detail.json()["snapshot_integrity"] == "VERIFIED"
        assert detail.json()["status"] == "IMPORTED_NOT_ANALYZED"


def test_invalid_declarations_and_missing_import(tmp_path: Path):
    tiff(tmp_path)
    with TestClient(app_for(tmp_path)) as client:
        for body in [request(product="NOT_A_PRODUCT"), request(calibration="CALIBRATED"),
                     request(acquisition_time="2026-09-01T12:00:00"),
                     request(provider_url="https://example.invalid"),
                     request(polarization="HH")]:
            assert client.post("/api/sar/local/import", json=body).status_code == 422
        assert client.get("/api/sar/local/imports/" + "0" * 32).status_code == 404
        assert client.get("/api/sar/local/imports/invalid").status_code == 422


def test_preview_declares_actual_downsampling(tmp_path: Path):
    data = np.arange(810 * 5, dtype=np.float32).reshape(810, 5)
    tiff(tmp_path, data=data, nodata=None, transform=from_origin(72, 19, .25, .005))
    record = import_local_geotiff(tmp_path, relative_path="satellite.tif", product="RTC")
    assert record["metadata"]["preview_sample_stride"] == 2
    assert record["metadata"]["preview_shape"] == [405, 3]


def test_rotated_raster_reports_measured_center_without_alignment_claim(tmp_path: Path):
    transform = Affine(.1, .02, 72., .02, -.1, 19.)
    tiff(tmp_path, data=np.ones((2, 3), dtype=np.float32), transform=transform)
    first = import_local_geotiff(tmp_path, relative_path="satellite.tif", product="RTC")
    assert first["metadata"]["pixel_center_wgs84_lon_lat"] == pytest.approx(
        [72.06, 18.96])
    assert first["metadata"]["transform"] == pytest.approx(list(transform)[:6])
    tiff(tmp_path, "unaligned.tif", transform=from_origin(72., 19., .21, .48))
    second = import_local_geotiff(tmp_path, relative_path="unaligned.tif", product="RTC")
    assert first["metadata"]["transform"] != second["metadata"]["transform"]
    assert first["status"] == second["status"] == "IMPORTED_NOT_ANALYZED"
    assert any("pixel alignment" in limitation for limitation in first["limitations"])
