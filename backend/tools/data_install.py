"""Install and verify DarkFleet's static reference datasets.

    python tools/data_install.py list
    python tools/data_install.py verify [--data-dir DIR]
    python tools/data_install.py install <dataset-id> --from prepared.json
    python tools/data_install.py install <dataset-id> --url https://... --sha256 <hex>
    python tools/data_install.py update <dataset-id> --url https://... --sha256 <hex>

WHY AN EXPLICIT INSTALLER

DarkFleet is local-first. A static EEZ or port table does not need a network request to
answer a question about the same water twice, and it must not be fetched silently at
runtime for three reasons:

  * a first paint must not stall on a 122 MB download,
  * silently fetching "latest" would rewrite the dataset version underneath evidence that
    was generated against the previous one (§80), and
  * the operator has to be the one who accepts a licence.

So installation is explicit, versioned, checksummed, and reversible by installing a
different version alongside.

NOTHING LARGE IS COMMITTED (§6)

This script and the manifests live in the repository. The payloads do not: the EEZ
geodatabase is 122 MB and GEBCO is 3.7 billion cells. A fresh clone reports every
dataset NOT_INSTALLED, which is the honest state.

NOT IN THE DEFAULT TEST SUITE (§74)

No test invokes the network path. `--from` reads a local prepared file, so the whole
install/verify flow is exercisable offline, and `pytest -m "not live"` still cannot
reach the public network.

DATA DIRECTORY

Defaults to ``$DF_SERVE_DATA_DIR``, else ``./darkfleet-data``. Datasets land in
``<data-dir>/reference/<id>/<version>/`` -- the version in the path is what makes
historical reproducibility structural rather than aspirational (§8).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from darkfleet.maritime.datasets import InstallStatus
from darkfleet.maritime.registry import (
    DATASET_LABELS,
    VERIFIED_ON,
    known_dataset_ids,
    known_manifest,
)
from darkfleet.maritime.store import (
    all_statuses,
    install,
)

GREEN, AMBER, RED, DIM, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[90m", "\033[0m"

STATUS_TONE = {
    InstallStatus.READY: GREEN,
    InstallStatus.CHECKSUM_UNRECORDED: AMBER,
    InstallStatus.CHECKSUM_MISMATCH: RED,
    InstallStatus.INVALID: RED,
    InstallStatus.VERSION_UNKNOWN: RED,
    InstallStatus.NOT_INSTALLED: DIM,
}


def default_data_dir() -> Path:
    env = os.environ.get("DF_SERVE_DATA_DIR")
    return Path(env) if env else Path("darkfleet-data")


def cmd_list(_args: argparse.Namespace) -> int:
    print(f"Verified reference datasets (versions checked {VERIFIED_ON}):\n")
    for dataset_id in known_dataset_ids():
        m = known_manifest(dataset_id)
        if m is None:
            continue
        print(f"  {DATASET_LABELS.get(dataset_id, dataset_id)}  [{dataset_id}]")
        print(f"    provider   {m.provider}")
        print(f"    version    {m.version}" + (f"  ({m.release_date})" if m.release_date else ""))
        print(f"    licence    {m.license.value}")
        print(f"    resolution {m.resolution or 'n/a'}")
        if m.identifier:
            print(f"    source     {m.identifier}")
        for note in m.limitations[:2]:
            print(f"    {DIM}{note}{RESET}")
        print()
    print(f"{DIM}None of these payloads is committed. Run `install` to fetch one.{RESET}")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    print(f"Verifying reference datasets under {data_dir}\n")
    worst = 0
    absent = 0
    for s in all_statuses(data_dir):
        tone = STATUS_TONE.get(s.status, DIM)
        label = DATASET_LABELS.get(s.manifest.id, s.manifest.id)
        print(f"  {tone}{s.status.value:<22}{RESET} {label}  [{s.manifest.id} {s.manifest.version}]")
        print(f"    {DIM}{s.detail}{RESET}")
        if s.status in (InstallStatus.CHECKSUM_MISMATCH, InstallStatus.INVALID,
                        InstallStatus.VERSION_UNKNOWN):
            worst = 1
        if s.status is InstallStatus.NOT_INSTALLED:
            absent += 1
    print()
    if worst:
        print(f"{RED}At least one dataset failed verification. Do not serve it.{RESET}")
        return worst
    if absent == len(known_dataset_ids()):
        # Absence is not corruption, and saying "no integrity failures" alone would let
        # a reader mistake an empty data directory for a healthy one. Maritime context
        # is unavailable in this state, and that is a different sentence.
        print(f"{AMBER}No datasets installed. Context layers will report NOT_INSTALLED.{RESET}")
        print(f"{DIM}Corruption is not implied: nothing is present to corrupt. See `list`.{RESET}")
        return 0
    print(f"{GREEN}No integrity failures among the {len(known_dataset_ids()) - absent} "
          f"installed dataset(s).{RESET}")
    if absent:
        print(f"{DIM}{absent} dataset(s) not installed; their layers report NOT_INSTALLED.{RESET}")
    return 0


def _fetch(url: str, timeout_s: float = 120.0) -> bytes:
    # Only reachable from an explicit `install --url`. Never from the default suite.
    with urllib.request.urlopen(url, timeout=timeout_s) as response:
        return response.read()


def cmd_install(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    dataset_id = args.dataset_id
    m = known_manifest(dataset_id)
    if m is None:
        print(f"{RED}Unknown dataset id: {dataset_id}{RESET}")
        print(f"Known ids: {', '.join(known_dataset_ids())}")
        return 2

    print(f"{DATASET_LABELS.get(dataset_id, dataset_id)} -- {m.provider} {m.dataset} {m.version}")
    print(f"  licence   {m.license.value}")
    if m.terms_notes:
        print(f"  {DIM}terms    {m.terms_notes}{RESET}")
    for note in m.limitations:
        print(f"  {AMBER}{note}{RESET}")
    print()

    raw: bytes
    if args.from_file:
        raw = Path(args.from_file).read_bytes()
        source = f"file {args.from_file}"
    elif args.url:
        raw = _fetch(args.url)
        source = args.url
    else:
        print(f"{RED}Provide --from or --url.{RESET}")
        return 2

    if args.sha256:
        actual = sha256_of_bytes(raw)
        if actual != args.sha256.lower():
            print(f"{RED}Downloaded bytes do not match --sha256.{RESET}")
            print(f"  expected {args.sha256.lower()}")
            print(f"  actual   {actual}")
            return 1
        print(f"  {GREEN}download verified against the publisher checksum{RESET}")
    else:
        print(f"  {AMBER}no --sha256 supplied: no publisher checksum to verify the download{RESET}")

    # NOTE: `--sha256` verifies the DOWNLOAD, not the stored file.
    #
    # The store re-serialises the payload canonically, so the stored bytes are not the
    # downloaded bytes and a publisher hash of the archive can never match them. Two
    # separate checks: this one proves the transfer was intact, and the store's own
    # install-time digest proves the local copy has not been corrupted since. Passing
    # the download hash through as a store expectation was a real bug -- it reported a
    # permanent CHECKSUM_MISMATCH on every install.
    expected = None

    try:
        # `utf-8-sig` rather than `utf-8`: a prepared payload produced by a Windows tool
        # carries a BOM, and a bare `utf-8` decode turns that into a JSON parse error
        # that reads as "corrupt file" when the file is fine. Local-first means Windows
        # tooling is a first-class path, not an edge case.
        payload = json.loads(raw.decode("utf-8-sig"))
    except ValueError as exc:
        print(f"{RED}Payload is not valid JSON: {exc}{RESET}")
        print("This script installs PREPARED payloads. Publisher archives (shapefile,")
        print("GeoPackage, netCDF) must be converted first.")
        return 2

    installed = install(data_dir, dataset_id, payload, expected_sha256=expected)
    tone = STATUS_TONE.get(installed.status, DIM)
    print(f"\n  {tone}{installed.status.value}{RESET}  {installed.path}")
    print(f"  {DIM}{installed.detail}{RESET}")
    print(f"  source {source}")
    return 0 if installed.usable else 1


def sha256_of_bytes(raw: bytes) -> str:
    import hashlib

    return hashlib.sha256(raw).hexdigest()


def cmd_update(args: argparse.Namespace) -> int:
    # Deliberately not automatic. An update installs a NEW version directory and leaves
    # existing evidence's version intact; forcing it would rewrite history (§80).
    print("Update installs alongside the existing version; nothing is overwritten.")
    print("Re-run `install` with a newer verified manifest version to add one.")
    print(f"Current verified version for {args.dataset_id}: ", end="")
    m = known_manifest(args.dataset_id)
    print(m.version if m else "unknown")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="data_install", description=__doc__.split("\n")[0])
    parser.add_argument("--data-dir", default=None, help="Deployment data directory.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="Show verified datasets and their terms.").set_defaults(
        func=cmd_list
    )
    sub.add_parser("verify", help="Check installed datasets for integrity.").set_defaults(
        func=cmd_verify
    )

    p_install = sub.add_parser("install", help="Install a prepared payload.")
    p_install.add_argument("dataset_id")
    p_install.add_argument("--from", dest="from_file", default=None)
    p_install.add_argument("--url", default=None)
    p_install.add_argument("--sha256", default=None)
    p_install.set_defaults(func=cmd_install)

    p_update = sub.add_parser("update", help="Explain the update policy.")
    p_update.add_argument("dataset_id")
    p_update.set_defaults(func=cmd_update)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())