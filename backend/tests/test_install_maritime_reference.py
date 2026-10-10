"""Offline, synthetic UNIT fixtures; never proof of publisher dataset availability."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from darkfleet.maritime.context import ContextStatus, classify_zone, coast_distance
from darkfleet.maritime.datasets import InstallStatus
from darkfleet.maritime.provenance import MaritimeZone
from darkfleet.maritime.store import dataset_dir, load_prepared, status_of
from tools import install_maritime_reference as cli

COAST_URL = "https://www.naturalearthdata.com/downloads/10m-physical-vectors/"
EEZ_URL = "https://geo.vliz.be/geoserver/MarineRegions/wfs"
COAST_ID = "natural_earth_coastline"
EEZ_ID = "marine_regions_eez_wfs"


def coast() -> dict:
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {
            "type": "LineString", "coordinates": [[179, 5], [-179, 5]]}},
    ]}


def eez() -> dict:
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {
            "mrgid": 321, "pol_type": "200NM", "sovereign1": "UNIT TEST",
            "territory1": "TEST TERRITORY", "geoname": "TEST ZONE",
            "mrgid_sov2": 22,
        }, "geometry": {"type": "Polygon", "coordinates": [[
            [179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1],
        ], [
            [179.3, -.5], [179.7, -.5], [179.7, .5], [179.3, .5], [179.3, -.5],
        ]]}}
    ]}


def write_json(directory: Path, payload: dict, name: str = "input.geojson") -> Path:
    path = directory / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def do_install(tmp_path: Path, source: Path, *, dataset_id: str = COAST_ID,
               replace: bool = False, **kwargs: object) -> dict:
    args = {
        "data_dir": tmp_path / "data", "source": source, "dataset_id": dataset_id,
        "source_url": COAST_URL if dataset_id == COAST_ID else EEZ_URL,
        "source_version": "4.1.0" if dataset_id == COAST_ID else None,
        "retrieved_at": None if dataset_id == COAST_ID else "2026-10-04T12:30:00+00:00",
        "source_feature_count": None if dataset_id == COAST_ID else 1,
        "expected_source_sha256": None, "terms_confirmed": True, "replace": replace,
    }
    args.update(kwargs)
    return cli.install_local(**args)


def test_coastline_install_restarts_and_local_hash_is_not_publisher_hash(tmp_path):
    source = write_json(tmp_path, coast())
    result = do_install(tmp_path, source)
    assert result["status"] == "CHECKSUM_UNRECORDED"
    assert result["features"] == 1 and result["vertices"] == 2
    data_dir = tmp_path / "data"
    assert status_of(data_dir, COAST_ID).status is InstallStatus.CHECKSUM_UNRECORDED
    assert coast_distance(data_dir, lon=179.9, lat=5).status is ContextStatus.AVAILABLE
    assert load_prepared(data_dir, COAST_ID)["features"][0]["properties"]["id"] == (
        "local-index-0"
    )
    receipt = json.loads((dataset_dir(data_dir, COAST_ID, "4.1.0") /
                          "ingestion.json").read_text(encoding="utf-8"))
    assert receipt["source_sha256_observed"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert receipt["source_sha256_observed"] != receipt["prepared_sha256_observed"]
    assert receipt["publisher_source_verified"] is False


def test_eez_antimeridian_holes_and_source_labels_survive(tmp_path):
    source = write_json(tmp_path, eez())
    outcome = do_install(tmp_path, source, dataset_id=EEZ_ID)
    assert outcome["status"] == "CHECKSUM_UNRECORDED"
    payload = load_prepared(tmp_path / "data", EEZ_ID)
    assert payload is not None
    feature = payload["features"][0]
    assert feature["sovereign_names"] == ["UNIT TEST"]
    assert feature["territory_names"] == ["TEST TERRITORY"]
    assert "mrgid_sov2=22" in feature["dispute_note"]
    assert len(feature["holes"]) == 1
    assert classify_zone(tmp_path / "data", lon=-179.5, lat=0).zone is (
        MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
    )
    assert classify_zone(tmp_path / "data", lon=179.5, lat=0).zone is not (
        MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
    )
    assert status_of(tmp_path / "data", EEZ_ID).retrieved_at is not None


def test_prepared_install_is_not_overwritten_without_explicit_flag(tmp_path):
    first = write_json(tmp_path, coast(), "first.geojson")
    do_install(tmp_path, first)
    digest = status_of(tmp_path / "data", COAST_ID).computed_sha256
    second_payload = coast()
    second_payload["features"][0]["geometry"]["coordinates"][0][0] = 160
    second = write_json(tmp_path, second_payload, "second.geojson")
    with pytest.raises(cli.InputError, match="exists"):
        do_install(tmp_path, second)
    assert status_of(tmp_path / "data", COAST_ID).computed_sha256 == digest
    do_install(tmp_path, second, replace=True)
    assert status_of(tmp_path / "data", COAST_ID).computed_sha256 != digest
    assert list((tmp_path / "data" / "reference" / COAST_ID).glob(".dfx14-backup-*")) == []


def test_mismatched_input_checksum_rejects_without_creating_install(tmp_path):
    source = write_json(tmp_path, coast())
    with pytest.raises(cli.InputError, match="SHA-256 mismatch"):
        do_install(tmp_path, source, expected_source_sha256="0" * 64)
    assert status_of(tmp_path / "data", COAST_ID).status is InstallStatus.NOT_INSTALLED


@pytest.mark.parametrize("bad", [
    {"type": "FeatureCollection", "features": []},
    {"type": "FeatureCollection", "features": [{}]},
    {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {},
     "geometry": {"type": "Point", "coordinates": [5, 5]}}]},
])
def test_malformed_or_unusable_geojson_rejected(tmp_path, bad):
    with pytest.raises(cli.InputError):
        do_install(tmp_path, write_json(tmp_path, bad))
    assert status_of(tmp_path / "data", COAST_ID).status is InstallStatus.NOT_INSTALLED


def test_malformed_json_or_duplicate_json_keys_rejected(tmp_path):
    source = tmp_path / "source.geojson"
    for body in ('{not json}', '{"type":"FeatureCollection","type":"FeatureCollection"}'):
        source.write_text(body, encoding="utf-8")
        with pytest.raises(cli.InputError):
            do_install(tmp_path, source)


@pytest.mark.parametrize("coordinates", [
    [[181, 0], [179, 0]], [[0, 95], [1, 1]],
    [[float("nan"), 0], [1, 0]],
])
def test_invalid_crs_coordinate_bounds(tmp_path, coordinates):
    payload = coast()
    payload["features"][0]["geometry"]["coordinates"] = coordinates
    with pytest.raises(cli.InputError):
        do_install(tmp_path, write_json(tmp_path, payload))


def test_projected_crs_rejected(tmp_path):
    payload = coast()
    payload["crs"] = {"type": "name", "properties": {"name": "EPSG:3857"}}
    with pytest.raises(cli.InputError, match="CRS"):
        do_install(tmp_path, write_json(tmp_path, payload))


def test_3d_source_is_rejected_not_silently_truncated(tmp_path):
    payload = coast()
    payload["features"][0]["geometry"]["coordinates"][0] = [179, 5, 100]
    with pytest.raises(cli.InputError, match="3D"):
        do_install(tmp_path, write_json(tmp_path, payload))


def test_duplicate_geographic_features_rejected(tmp_path):
    payload = coast()
    payload["features"] = [dict(payload["features"][0], id="same") for _ in range(2)]
    with pytest.raises(cli.InputError, match="duplicate feature id"):
        do_install(tmp_path, write_json(tmp_path, payload))


def test_eez_rejects_missing_semantics_and_partial_feature_count(tmp_path):
    source = write_json(tmp_path, eez())
    with pytest.raises(cli.InputError, match="count mismatch"):
        do_install(tmp_path, source, dataset_id=EEZ_ID, source_feature_count=2)
    payload = eez()
    payload["features"][0]["properties"]["pol_type"] = "12NM"
    with pytest.raises(cli.InputError, match="200NM"):
        do_install(tmp_path, write_json(tmp_path, payload), dataset_id=EEZ_ID)


def test_wfs_requires_real_retrieval_metadata_and_never_claims_v12(tmp_path):
    source = write_json(tmp_path, eez())
    with pytest.raises(cli.InputError, match="requires"):
        do_install(tmp_path, source, dataset_id=EEZ_ID, retrieved_at=None)
    with pytest.raises(cli.InputError, match="unestablished"):
        do_install(tmp_path, source, dataset_id=EEZ_ID, source_version="12")
    with pytest.raises(cli.InputError, match="registered version"):
        do_install(tmp_path, write_json(tmp_path, coast()), source_version="4.0.0")


def test_source_url_requires_declared_publisher_host_and_rights_ack(tmp_path):
    source = write_json(tmp_path, coast())
    with pytest.raises(cli.InputError, match="host list"):
        do_install(tmp_path, source, source_url="https://untrusted.example/anything")
    with pytest.raises(cli.InputError, match="terms-confirmed"):
        do_install(tmp_path, source, terms_confirmed=False)
    with pytest.raises(cli.InputError, match="query"):
        do_install(tmp_path, source, source_url=COAST_URL + "?token=secret")


def test_zip_geojson_without_path_extraction(tmp_path):
    source = tmp_path / "payload.zip"
    with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("publisher/data.geojson", json.dumps(coast()))
    result = do_install(tmp_path, source)
    assert result["status"] == "CHECKSUM_UNRECORDED"
    assert not (tmp_path / "publisher").exists()


@pytest.mark.parametrize("members", [
    {"../outside.geojson": "{}"},
    {"safe.geojson": "{}", "other.geojson": "{}"},
    {"C:/evil.geojson": "{}"},
])
def test_zip_traversal_or_multiple_inputs_rejected(tmp_path, members):
    source = tmp_path / "payload.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for name, body in members.items():
            archive.writestr(name, body)
    with pytest.raises(cli.InputError, match="ZIP|unsafe"):
        do_install(tmp_path, source)


def test_zip_expansion_ratio_rejected_before_decompression(tmp_path):
    source = tmp_path / "payload.zip"
    with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("payload.geojson", " " * 100_000)
    with pytest.raises(cli.InputError, match="ratio"):
        do_install(tmp_path, source)


def test_corruption_on_restart_is_detected(tmp_path):
    source = write_json(tmp_path, coast())
    do_install(tmp_path, source)
    payload_file = dataset_dir(tmp_path / "data", COAST_ID, "4.1.0") / "coastline.json"
    payload_file.write_text("{}", encoding="utf-8")
    assert status_of(tmp_path / "data", COAST_ID).status is InstallStatus.CHECKSUM_MISMATCH


def test_interrupted_replace_recovers_original(tmp_path, monkeypatch):
    first = write_json(tmp_path, coast(), "first.geojson")
    do_install(tmp_path, first)
    digest = status_of(tmp_path / "data", COAST_ID).computed_sha256
    second_payload = coast()
    second_payload["features"][0]["geometry"]["coordinates"][0][0] = 160
    second = write_json(tmp_path, second_payload, "second.geojson")
    original = Path.rename

    def fail_staged_rename(path, target):
        if path.name == "4.1.0" and ".dfx14-stage-" in str(path):
            raise OSError("simulated commit interruption")
        return original(path, target)

    monkeypatch.setattr(Path, "rename", fail_staged_rename)
    with pytest.raises(OSError, match="simulated"):
        do_install(tmp_path, second, replace=True)
    assert status_of(tmp_path / "data", COAST_ID).computed_sha256 == digest
    assert not (tmp_path / "data" / "reference" / COAST_ID / ".dfx14-install.lock").exists()


def test_backup_restored_after_process_crash_before_next_install(tmp_path):
    source = write_json(tmp_path, coast())
    do_install(tmp_path, source)
    target = dataset_dir(tmp_path / "data", COAST_ID, "4.1.0")
    backup = target.parent / ".dfx14-backup-4.1.0-crashed"
    target.rename(backup)
    with pytest.raises(cli.InputError, match="exists"):
        do_install(tmp_path, source)
    assert target.exists() and not backup.exists()
    assert status_of(tmp_path / "data", COAST_ID).usable


def test_cli_help_and_no_operational_data(tmp_path, capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    data_dir = tmp_path / "data"
    assert status_of(data_dir, COAST_ID).status is InstallStatus.NOT_INSTALLED
    source = write_json(tmp_path, coast())
    assert cli.main(["--dataset", COAST_ID, "--input", str(source),
                     "--data-dir", str(data_dir), "--source-url", COAST_URL,
                     "--source-version", "4.1.0"]) == 2
    assert "terms-confirmed" in capsys.readouterr().err
