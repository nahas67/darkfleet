"""Browser-free assertions for real fixture provenance and served UI source identity."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_browser_harness_integrity as integrity  # noqa: I001


ROOT = Path(__file__).resolve().parents[1]


def test_committed_geo_fixture_matches_fixed_pin_and_git_index() -> None:
    for relative, (size, pinned_sha) in integrity.FIXTURE_PINS.items():
        result = integrity.verify_fixture(ROOT, relative)
        assert result["size"] == size
        assert result["sha256"] == pinned_sha
        assert len(str(result["gitBlobOid"])) == 40


def temporary_git_repo(tmp_path: Path, source: bytes) -> tuple[Path, str]:
    relative = "backend/tests/fixtures/cog/fixture_32648.tif"
    path = tmp_path / relative
    path.parent.mkdir(parents=True)
    path.write_bytes(source)
    for args in (
        ("init", "-q"),
        ("config", "user.email", "test@example.invalid"),
        ("config", "user.name", "Test"),
        ("add", "--", relative),
        ("commit", "-q", "-m", "fixture baseline"),
    ):
        subprocess.run(["git", *args], cwd=tmp_path, check=True,
                       capture_output=True, timeout=10)
    return path, relative


def test_fixture_modified_after_commit_fails_despite_self_consistent_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path, relative = temporary_git_repo(tmp_path, b"actual fixture bytes")
    original = path.read_bytes()
    monkeypatch.setitem(integrity.FIXTURE_PINS, relative,
                        (len(original), hashlib.sha256(original).hexdigest()))
    assert integrity.verify_fixture(tmp_path, relative)["sha256"] == hashlib.sha256(original).hexdigest()
    path.write_bytes(b"altered fixture bytes")
    # A dynamic digest of the changed source would match a similarly altered
    # temporary copy; fixed Git/pin verification must reject it.
    with pytest.raises(integrity.IntegrityError, match="pinned asset"):
        integrity.verify_fixture(tmp_path, relative)


def test_staged_fixture_drift_is_rejected_even_when_worktree_matches_pin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path, relative = temporary_git_repo(tmp_path, b"committed bytes")
    original = path.read_bytes()
    monkeypatch.setitem(integrity.FIXTURE_PINS, relative,
                        (len(original), hashlib.sha256(original).hexdigest()))
    path.write_bytes(b"staged bytes")
    subprocess.run(["git", "add", "--", relative], cwd=tmp_path,
                   check=True, capture_output=True, timeout=10)
    path.write_bytes(original)
    with pytest.raises(integrity.IntegrityError, match="HEAD, index and worktree"):
        integrity.verify_fixture(tmp_path, relative)


def test_route_source_chain_is_part_of_hashes() -> None:
    expected = {
        "index.html", "src/main.tsx", "src/command/OperationRail.tsx",
        "src/command/DarkFleetCommandApp.tsx", "src/intelligence/AdvancedWorkspace.tsx",
        "src/scenes/LocalSarImportPanel.tsx", "backend/darkfleet/api/app.py",
        "backend/darkfleet/api/local_sar_routes.py", "backend/darkfleet/local_sar_import.py",
    }
    snapshots = integrity.source_hashes(ROOT)
    assert expected.issubset(snapshots)
    assert all(len(sha) == 64 for sha in snapshots.values())

    # Source coverage needs a real route from frontend entry to the API router.
    files = {name: (ROOT / name).read_text(encoding="utf-8") for name in expected}
    assert "'/src/main.tsx'" in files["index.html"] or '/src/main.tsx' in files["index.html"]
    assert "DarkFleetCommandApp" in files["src/main.tsx"]
    assert "<OperationRail" in files["src/command/DarkFleetCommandApp.tsx"]
    assert "<AdvancedWorkspace" in files["src/command/DarkFleetCommandApp.tsx"]
    assert "'ADVANCED'" in files["src/command/OperationRail.tsx"]
    assert 'LocalSarImportPanel' in files["src/intelligence/AdvancedWorkspace.tsx"]
    assert "'/api/sar/local/import'" in files["src/scenes/LocalSarImportPanel.tsx"]
    assert 'local_sar_router' in files["backend/darkfleet/api/app.py"]
    assert 'prefix="/api/sar/local"' in files["backend/darkfleet/api/local_sar_routes.py"]


def test_source_hash_change_is_detected_in_unrelated_mount_file(tmp_path: Path) -> None:
    for name in integrity.ROUTE_SOURCES:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name, encoding="utf-8")
    captured = integrity.source_hashes(tmp_path)
    integrity.assert_stable_sources(tmp_path, captured)
    (tmp_path / "src/command/OperationRail.tsx").write_text("different", encoding="utf-8")
    with pytest.raises(integrity.IntegrityError, match="OperationRail.tsx"):
        integrity.assert_stable_sources(tmp_path, captured)


def test_vite_raw_module_must_exactly_match_source_bytes() -> None:
    path = "src/intelligence/AdvancedWorkspace.tsx"
    source = "export const x = 'α';\r\n".encode()
    valid = "export default " + json.dumps(source.decode("utf-8")) + ";"
    assert integrity.verify_vite_raw_source(path, valid, source) == hashlib.sha256(source).hexdigest()
    with pytest.raises(integrity.IntegrityError, match="stale or changed"):
        integrity.verify_vite_raw_source(path, valid, b"export const x = 'changed';")
    with pytest.raises(integrity.IntegrityError, match="raw source module"):
        integrity.verify_vite_raw_source(path, '<!doctype html>', source)
    with pytest.raises(integrity.IntegrityError, match="Unapproved"):
        integrity.verify_vite_raw_source(".env", valid, source)


def test_bundle_manifest_must_cover_every_served_file(tmp_path: Path) -> None:
    output = tmp_path / "dist"
    (output / "assets").mkdir(parents=True)
    (output / "cesium" / "Assets").mkdir(parents=True)
    (output / "index.html").write_text("<h1>real HTML</h1>", encoding="utf-8")
    (output / "assets" / "app.js").write_text("const real = 1;", encoding="utf-8")
    (output / "build-manifest.json").write_text("{}", encoding="utf-8")
    listed = ["assets/app.js", "index.html"]
    assert integrity.assert_manifest_covers_dist(output, listed) == {"listed": 2, "physical": 2}

    # Cesium copies are actually served but absent from Object.keys(bundle) in
    # the observed release. Their omission must fail even when the listed digest
    # and filenames are otherwise internally self-consistent.
    (output / "cesium" / "Assets" / "data.bin").write_bytes(b"served bytes outside manifest")
    with pytest.raises(integrity.IntegrityError, match="1 unlisted served file"):
        integrity.assert_manifest_covers_dist(output, listed)

    listed.append("cesium/Assets/data.bin")
    assert integrity.assert_manifest_covers_dist(output, listed) == {"listed": 3, "physical": 3}
    (output / "assets" / "app.js").unlink()
    with pytest.raises(integrity.IntegrityError, match="listed-but-missing"):
        integrity.assert_manifest_covers_dist(output, listed)
