"""Fast, browser-free identity assertions for the local GeoTIFF acceptance harness.

Git HEAD, index and working bytes are separate trust surfaces. A runtime SHA
computed solely from the working file cannot establish fixture provenance.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path


class IntegrityError(AssertionError):
    """The source, fixture or served-module evidence is not trustworthy."""


# The fixture generator is seeded, but these pins refer to the *committed* test
# assets. Regeneration is a deliberate review operation, never a harness action.
FIXTURE_PINS: dict[str, tuple[int, str]] = {
    "backend/tests/fixtures/cog/fixture_32648.tif": (
        703707, "c1b231e9b398a285eaa76637078fbcd73db7f18cf5c84e904ccabe75a872b3e4"
    ),
    "backend/tests/fixtures/cog/fixture_unreferenced.tif": (
        703279, "13dc98dfcc7fc2e655a1928aae8882bb6865f14aa5a4fded51d83964c8f0d428"
    ),
}

# The production import chain has to be covered even if unrelated workers move
# HEAD while the browser runs. Files consumed by Vite ?raw probes are a subset.
ROUTE_SOURCES = (
    "index.html",
    "src/main.tsx",
    "src/command/DarkFleetCommandApp.tsx",
    "src/command/OperationRail.tsx",
    "src/intelligence/AdvancedWorkspace.tsx",
    "src/scenes/LocalSarImportPanel.tsx",
    "src/api/errors.ts",
    "backend/darkfleet/api/app.py",
    "backend/darkfleet/api/local_sar_routes.py",
    "backend/darkfleet/local_sar_import.py",
    "vite.config.ts",
)
VITE_RAW_SOURCES = (
    "src/main.tsx",
    "src/command/DarkFleetCommandApp.tsx",
    "src/command/OperationRail.tsx",
    "src/intelligence/AdvancedWorkspace.tsx",
    "src/scenes/LocalSarImportPanel.tsx",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_oid(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=root, capture_output=True, text=True,
        check=False, timeout=10,
    )
    oid = result.stdout.strip()
    if result.returncode != 0 or re.fullmatch(r"[0-9a-f]{40,64}", oid) is None:
        raise IntegrityError(f"Cannot establish fixture Git identity for {arguments!r}")
    return oid


def verify_fixture(root: Path, relative: str) -> dict[str, str | int]:
    """Require the pinned bytes to match disk, index and HEAD exactly."""
    if relative not in FIXTURE_PINS:
        raise IntegrityError(f"Unpinned fixture: {relative}")
    path = root / relative
    if not path.is_file() or path.is_symlink():
        raise IntegrityError(f"Unavailable or linked fixture: {relative}")
    expected_size, expected_sha = FIXTURE_PINS[relative]
    content = path.read_bytes()
    current_sha = sha256(content)
    if len(content) != expected_size or current_sha != expected_sha:
        raise IntegrityError(f"Fixture bytes differ from pinned asset: {relative}")
    committed = git_oid(root, "rev-parse", "--verify", f"HEAD:{relative}")
    staged = git_oid(root, "rev-parse", "--verify", f":{relative}")
    working = git_oid(root, "hash-object", "--", relative)
    if committed != staged or committed != working:
        raise IntegrityError(f"Fixture differs between HEAD, index and worktree: {relative}")
    return {"path": relative, "size": expected_size, "sha256": current_sha, "gitBlobOid": working}


def source_hashes(root: Path) -> dict[str, str]:
    """Capture the entire Local GeoTIFF UI entry chain and backend route."""
    return {relative: sha256((root / relative).read_bytes()) for relative in ROUTE_SOURCES}


def assert_stable_sources(root: Path, captured: dict[str, str]) -> None:
    observed = source_hashes(root)
    if observed != captured:
        changed = sorted(name for name in set(observed) | set(captured)
                         if observed.get(name) != captured.get(name))
        raise IntegrityError(f"Local GeoTIFF route source changed during acceptance: {changed}")


def verify_vite_raw_source(relative: str, module_body: str, expected_source: bytes) -> str:
    """Validate Vite's ?raw JS wrapper and compare decoded source *bytes*."""
    if relative not in VITE_RAW_SOURCES:
        raise IntegrityError(f"Unapproved Vite source probe: {relative}")
    prefix = "export default "
    if not module_body.startswith(prefix):
        raise IntegrityError(f"Vite did not return a raw source module: {relative}")
    encoded = module_body[len(prefix):].strip()
    if not encoded.endswith(";"):
        raise IntegrityError(f"Vite raw module missing terminator: {relative}")
    try:
        decoded = json.loads(encoded[:-1])
    except ValueError as exc:
        raise IntegrityError(f"Invalid raw source module: {relative}") from exc
    if not isinstance(decoded, str) or decoded.encode("utf-8") != expected_source:
        raise IntegrityError(f"Vite served stale or changed source: {relative}")
    return sha256(expected_source)


def assert_manifest_covers_dist(dist: Path, manifest_files: list[str]) -> dict[str, int]:
    """Refuse an incomplete manifest, including copied/public Cesium assets.

    A matching digest over the manifest's own limited list cannot prove that
    arbitrary additional files served from dist were covered by that digest.
    """
    listed = set(manifest_files)
    if len(listed) != len(manifest_files) or not all(isinstance(n, str) and n for n in listed):
        raise IntegrityError("Manifest file names are duplicated or malformed")
    physical = {
        path.relative_to(dist).as_posix() for path in dist.rglob("*")
        if path.is_file() and path.relative_to(dist).as_posix() != "build-manifest.json"
    }
    unlisted = sorted(physical - listed)
    missing = sorted(listed - physical)
    if unlisted or missing:
        raise IntegrityError(
            f"Incomplete bundle manifest: {len(unlisted)} unlisted served file(s), "
            f"{len(missing)} listed-but-missing file(s); examples "
            f"unlisted={unlisted[:3]}, missing={missing[:3]}"
        )
    return {"listed": len(listed), "physical": len(physical)}
