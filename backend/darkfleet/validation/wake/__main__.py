"""Offline wake-validation corpus evaluation.

    python -m darkfleet.validation.wake --manifest path/to/manifest.json
    python -m darkfleet.validation.wake --report-only

Separate from the default test suite on purpose (DF-X7V section 47): a developer
with no validation data installed must still get a green ``pytest``, so nothing here
touches the network and nothing here is imported by it.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from .corpus import DetectorVersion, evaluate, load_manifest, write_report


def _config() -> dict[str, float | int | str]:
    """The detector's frozen configuration, recorded in every result.

    Read from the module rather than restated here, so a threshold change cannot
    leave the recorded config describing the previous one.
    """
    from darkfleet.sar import wake as W

    return {
        "ARM_MIN_DEG": W.ARM_MIN_DEG,
        "ARM_MAX_DEG": W.ARM_MAX_DEG,
        "ARM_TOLERANCE": W.ARM_TOLERANCE,
        "R_START_PX": W.R_START_PX,
        "R_END_PX": W.R_END_PX,
        "MIN_MARGIN_DB": W.MIN_MARGIN_DB,
        "MIN_CONF_SATURATION_DB": W.MIN_CONF_SATURATION_DB,
        "NON_ARM_MIN_DEG": W.NON_ARM_MIN_DEG,
        "NON_ARM_MAX_DEG": W.NON_ARM_MAX_DEG,
    }


def _commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Wake validation corpus evaluation.")
    parser.add_argument(
        "--manifest", type=Path, default=None, help="Manifest of labelled samples."
    )
    parser.add_argument("--out", type=Path, default=Path("wake_validation_out"))
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Emit an explicit insufficient-data report without a manifest.",
    )
    args = parser.parse_args(argv)

    version = DetectorVersion(
        algorithm_version="polar-ray-arm-pair",
        source_commit=_commit(),
        config=_config(),
    )

    if args.report_only or args.manifest is None:
        summary = write_report(args.out, [], {}, version)
        print("No manifest supplied. Emitted an explicit INSUFFICIENT_VALIDATION report.")
        print(f"  detector : {version.name} ({version.digest()})")
        print(f"  commit   : {version.source_commit or '(unrecorded)'}")
        print(f"  output   : {args.out}")
        print()
        print(summary["outcome_reason"])
        return 0

    if not args.manifest.is_file():
        print(f"manifest not found: {args.manifest}", file=sys.stderr)
        return 2

    samples = load_manifest(args.manifest)
    results, by_stratum = evaluate(samples, version)
    summary = write_report(args.out, results, by_stratum, version)

    print(f"detector : {version.name} ({version.digest()})")
    print(f"commit   : {version.source_commit or '(unrecorded)'}")
    print(f"samples  : {len(samples)}")
    for name, metrics in sorted(by_stratum.items()):
        counts = metrics.to_dict()["counts"]
        print(
            f"  {name:<16} TP {counts['tp']} FP {counts['fp']} TN {counts['tn']} "
            f"FN {counts['fn']} AMBIGUOUS {counts['ambiguous']} EXCLUDED {counts['excluded']}"
        )
    print(f"outcome  : {summary['outcome_state']}")
    print(f"output   : {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())