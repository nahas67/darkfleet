"""Local versioned storage for reference datasets, with integrity checking.

LOCAL-FIRST, EXPLICITLY

A static EEZ or port table does not need a network request to answer a question about
the same water twice. So datasets are installed once into a versioned local directory
and read from there thereafter (§43).

Layout, under the deployment data directory::

    <data_dir>/reference/<dataset_id>/<version>/
        manifest.json          installed_at + computed checksum
        <payload files>

The version is part of the PATH, which is what makes historical reproducibility
structural rather than aspirational (§8, §47 of the DF-X8 brief): installing v13
creates a new directory and leaves v12 byte-identical on disk, so a report generated
against v12 still says v12.

NO NETWORK IN THIS MODULE

Installation reads bytes the caller already has, or delegates to a fetcher injected by
``tools/data_install.py``. The default test suite never reaches the network: pytest
blocks it at the socket layer, and this module adds nothing that could reopen the hole
(§74).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from .datasets import (
    DatasetAvailability,
    DatasetManifest,
    InstalledDataset,
    InstallStatus,
    LocalRepresentation,
    utc_now_iso,
)
from .provenance import DatasetCoverage
from .registry import DATASET_LABELS, known_manifest

#: Files that must exist for a directory to count as an installation.
MANIFEST_FILE = "manifest.json"

_CHUNK = 1 << 20


def sha256_of(path: Path) -> str:
    """Streaming digest, so a multi-gigabyte grid is not read into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def reference_root(data_dir: Path) -> Path:
    """Where reference datasets live for a deployment."""
    return Path(data_dir) / "reference"


def dataset_dir(data_dir: Path, dataset_id: str, version: str) -> Path:
    return reference_root(data_dir) / dataset_id / version


def _primary_payload(directory: Path, manifest: DatasetManifest) -> Path | None:
    """The file whose checksum represents the dataset.

    The FIRST declared payload file. Recorded explicitly in the manifest rather than
    inferred from a glob, because "which file is the dataset" must be a recorded fact
    and not a directory listing that changes when someone drops a note in the folder.
    """
    for name in manifest.payload_files:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def _status_for(
    directory: Path, manifest: DatasetManifest
) -> tuple[InstallStatus, str | None, str]:
    """Assess one directory. Returns (status, computed checksum, detail).

    The ordering is deliberate. An unreadable directory is INVALID and nothing is
    computed; a missing payload is INVALID too. Only once the bytes are readable does
    checksum comparison happen -- comparing a hash of nothing against a recorded hash
    would report a spurious mismatch.
    """
    recorded_path = directory / MANIFEST_FILE
    if not recorded_path.is_file():
        return InstallStatus.NOT_INSTALLED, None, "no manifest on disk"

    try:
        recorded = json.loads(recorded_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        return InstallStatus.INVALID, None, f"manifest unreadable: {exc}"

    installed_version = recorded.get("version")
    if installed_version != manifest.version:
        return (
            InstallStatus.VERSION_UNKNOWN,
            None,
            (f"manifest reports version {installed_version!r}, "
            f"this build expects {manifest.version!r}"),
        )

    missing = [
            name for name in manifest.payload_files if not (directory / name).is_file()
        ]
    if missing:
        return (
            InstallStatus.INVALID,
            None,
            f"missing payload file(s): {', '.join(missing)}",
        )

    payload = _primary_payload(directory, manifest)
    if payload is None:
        return InstallStatus.INVALID, None, "no declared payload file found"

    try:
        computed = sha256_of(payload)
    except OSError as exc:
        return InstallStatus.INVALID, None, f"payload unreadable: {exc}"

    # TWO CHECKSUMS, TWO JOBS. Conflating them is a bug.
    #
    #   computed_sha256 -- recorded when the payload was installed. Detects LOCAL
    #                      CORRUPTION, and always applies, because the store re-hashes
    #                      the same bytes it wrote.
    #   expected_sha256 -- a publisher checksum, when one is known. Stronger: it also
    #                      proves the CONTENT matches what the publisher shipped.
    #
    # The first is the baseline and is unconditional; the second is a bonus. Comparing
    # only against the publisher checksum would leave a dataset with no recorded
    # publisher hash completely unprotected against on-disk corruption, which is the
    # failure that actually happens.
    baseline = recorded.get("computed_sha256")
    if baseline is not None and computed != baseline:
        return (
            InstallStatus.CHECKSUM_MISMATCH,
            computed,
            f"local corruption: installed digest was {baseline}, now {computed}",
        )

    # The EXPECTED checksum is the one recorded AT INSTALL TIME, not the registry
    # default.
    #
    # This was a live integrity bug caught by the test suite. `install()` accepts an
    # `expected_sha256` and wrote it into the on-disk manifest, but verification re-read
    # the REGISTRY manifest, where the field is None. So a tampered payload reported
    # CHECKSUM_UNRECORDED -- and therefore `usable` -- instead of CHECKSUM_MISMATCH.
    expected = recorded.get("expected_sha256") or manifest.expected_sha256

    if expected is None:
        # NOT READY. The data parsed and is internally consistent, but there is no
        # publisher checksum to check it against, and "unverified" must never be
        # rendered as "verified" (§57).
        return (
            InstallStatus.CHECKSUM_UNRECORDED,
            computed,
            "installed and parsed; no publisher checksum recorded to verify against",
        )

    if computed != expected:
        return (
            InstallStatus.CHECKSUM_MISMATCH,
            computed,
            f"checksum mismatch: expected {expected}, got {computed}",
        )

    return InstallStatus.READY, computed, "checksum verified"


def status_of(data_dir: Path, dataset_id: str) -> InstalledDataset:
    """Assess a dataset without loading its payload.

    Cheap enough for a startup check: existence plus one streaming hash.
    """
    manifest = known_manifest(dataset_id)
    if manifest is None:
        return InstalledDataset(
            manifest=_unknown_manifest(dataset_id),
            status=InstallStatus.VERSION_UNKNOWN,
            detail="no manifest is registered for this dataset id",
        )

    directory = dataset_dir(data_dir, dataset_id, manifest.version)
    state, computed, detail = _status_for(directory, manifest)
    installed_at: str | None = None
    retrieved_at: str | None = None
    recorded_path = directory / MANIFEST_FILE
    if recorded_path.is_file():
        try:
            recorded = json.loads(recorded_path.read_text(encoding="utf-8"))
            installed_at = recorded.get("installed_at")
            # Absent for a store written before retrieval times were recorded. Left None
            # rather than defaulted to `installed_at`: the two are different events, and a
            # snapshot whose true retrieval moment is unknown should say so.
            retrieved_at = recorded.get("retrieved_at")
        except (OSError, ValueError):
            installed_at = None
            retrieved_at = None

    return InstalledDataset(
        manifest=manifest,
        status=state,
        path=str(directory) if directory.is_dir() else None,
        installed_at=installed_at,
        retrieved_at=retrieved_at,
        computed_sha256=computed,
        detail=detail,
    )


def _unknown_manifest(dataset_id: str) -> DatasetManifest:
    """A manifest shell for an unrecognised id.

    Strict models forbid extra fields but require these, so a placeholder is built
    honestly: it says UNKNOWN rather than inventing a provider or a licence.
    """
    from .provenance import LicenseKind

    return DatasetManifest(
        id=dataset_id,
        provider="UNKNOWN",
        dataset="UNKNOWN",
        version="UNKNOWN",
        license=LicenseKind.UNDETERMINED,
        attribution="UNKNOWN",
        terms_notes="No manifest is registered for this dataset id.",
        representation=LocalRepresentation.PREPPED_ROWS,
        payload_files=("data.json",),
    )


def all_statuses(data_dir: Path) -> list[InstalledDataset]:
    """Every registered dataset, installed or not.

    A fresh deployment reports four NOT_INSTALLED entries, which is the honest state
    and what the layer console must show rather than an empty list (§55).
    """
    return [status_of(data_dir, dataset_id) for dataset_id in DATASET_LABELS]


def availability(data_dir: Path, dataset_id: str) -> DatasetAvailability:
    """Install state plus a COVERAGE value, kept as separate axes.

    Coverage defaults to UNKNOWN here because whether a dataset covers a given point is
    a question only a query can answer. Reporting COVERED before asking would be an
    assumption presented as a measurement (§47).
    """
    installed = status_of(data_dir, dataset_id)
    manifest = installed.manifest
    return DatasetAvailability(
        id=dataset_id,
        label=DATASET_LABELS.get(dataset_id, dataset_id),
        install_status=installed.status,
        coverage=DatasetCoverage.UNKNOWN,
        version=None if installed.status is InstallStatus.NOT_INSTALLED else manifest.version,
        attribution=manifest.attribution,
        license=manifest.license.value,
        limitations=manifest.limitations,
        detail=installed.detail,
    )


def install(
    data_dir: Path,
    dataset_id: str,
    payload: dict[str, Any],
    *,
    expected_sha256: str | None = None,
    recorded_at: str | None = None,
    retrieved_at: str | None = None,
) -> InstalledDataset:
    """Write a PREPARED payload and its manifest.

    Takes already-prepared Python data, not a publisher archive. The publisher formats
    (shapefile, GeoPackage, netCDF) are converted by ``tools/data_install.py``, which
    owns the publisher-specific parsing; this function owns the versioned store so the
    two concerns stay separable and the store is testable with no network.

    ``expected_sha256`` overrides the registry value. A checksum computed from a
    publisher-supplied sidecar belongs here rather than in source.

    ``retrieved_at`` is WHEN THE PUBLISHER WAS READ, which is what a service snapshot's
    provenance rests on when the service publishes no version of its own. It is recorded
    separately from ``recorded_at`` (when the file was written here) because those two
    diverge the moment a ``update`` refreshes data without rewriting the directory, and
    because a snapshot restored from backup was retrieved at some earlier unknown moment.
    A caller that genuinely does not know must pass None -- silently substituting the
    install time would date the publisher's data to this machine's filesystem.
    """
    manifest = known_manifest(dataset_id)
    if manifest is None:
        raise ValueError(f"unknown dataset id: {dataset_id}")
    if expected_sha256 is not None:
        manifest = manifest.model_copy(update={"expected_sha256": expected_sha256.lower()})

    directory = dataset_dir(data_dir, dataset_id, manifest.version)
    directory.mkdir(parents=True, exist_ok=True)

    primary = manifest.payload_files[0]
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    (directory / primary).write_bytes(body)

    # Any additional declared payload files are written from the same prepared dict,
    # so a manifest declaring two files cannot half-exist.
    for name in manifest.payload_files[1:]:
        (directory / name).write_bytes(body)

    (directory / MANIFEST_FILE).write_text(
        json.dumps(
            {
                "id": manifest.id,
                "version": manifest.version,
                "installed_at": recorded_at or utc_now_iso(),
                "retrieved_at": retrieved_at,
                "computed_sha256": hashlib.sha256(body).hexdigest(),
                # Recorded so verification compares against what was EXPECTED at
                # install time rather than re-reading the registry default.
                "expected_sha256": manifest.expected_sha256,
                "payload_files": list(manifest.payload_files),
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return status_of(data_dir, dataset_id)


def verify_all(data_dir: Path) -> list[InstalledDataset]:
    """Assess every registered dataset. Read-only."""
    return all_statuses(data_dir)


def require_usable(data_dir: Path, dataset_id: str) -> InstalledDataset | None:
    """Return the dataset only if a query may read it, else None.

    ``CHECKSUM_UNRECORDED`` passes: the payload parsed and is internally consistent, so
    refusing to serve it would be a false alarm. The weaker guarantee stays visible in
    the reported status (§57).
    """
    installed = status_of(data_dir, dataset_id)
    return installed if installed.usable else None


def load_prepared(data_dir: Path, dataset_id: str) -> dict[str, Any] | None:
    """Read a prepared payload, or None when the dataset is not usable.

    The single read path for every consumer, so no caller can accidentally read a
    dataset the integrity check rejected.
    """
    installed = require_usable(data_dir, dataset_id)
    if installed is None or installed.path is None:
        return None
    payload = _primary_payload(Path(installed.path), installed.manifest)
    if payload is None:
        return None
    try:
        # utf-8-sig: a prepared payload written by a Windows tool carries a BOM, and a
        # bare utf-8 decode turns that into a spurious parse failure. Local-first means
        # Windows tooling is a normal path, not an edge case.
        decoded: dict[str, Any] = json.loads(
            payload.read_text(encoding="utf-8-sig")
        )
    except (OSError, ValueError):
        return None
    return decoded


#: Injected fetch signature: (dataset_id, manifest) -> raw publisher bytes | None.
Fetcher = Callable[[str, DatasetManifest], "bytes | None"]


def install_from_fetcher(
    data_dir: Path,
    dataset_id: str,
    fetcher: Fetcher,
    *,
    expected_sha256: str | None = None,
) -> InstalledDataset:
    """Fetch raw publisher bytes and delegate preparation to the fetcher.

    The default test suite supplies a fetcher backed by a fixture file, so
    installation is exercised end to end without touching the network.
    """
    manifest = known_manifest(dataset_id)
    if manifest is None:
        raise ValueError(f"unknown dataset id: {dataset_id}")
    raw = fetcher(dataset_id, manifest)
    if raw is None:
        raise RuntimeError(f"fetch failed for {dataset_id}")
    return install(
        data_dir,
        dataset_id,
        json.loads(raw.decode("utf-8")),
        expected_sha256=expected_sha256 or hashlib.sha256(raw).hexdigest(),
    )


def installed_versions(data_dir: Path) -> dict[str, str]:
    """Dataset id to installed version, for diagnostics.

    Used by tests that assert the version SHOWN to an operator equals the version ON
    DISK (§77).
    """
    out: dict[str, str] = {}
    for installed in all_statuses(data_dir):
        if installed.status is not InstallStatus.NOT_INSTALLED:
            out[installed.manifest.id] = installed.manifest.version
    return out


def iter_usable(data_dir: Path) -> Iterable[InstalledDataset]:
    for installed in all_statuses(data_dir):
        if installed.usable:
            yield installed