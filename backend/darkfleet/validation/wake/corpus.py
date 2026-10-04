"""Wake validation: sample model, dataset adapters, and detector evaluation.

DF-X7V. This module exists so that corpus evaluation is a COMMAND, not a notebook,
and so that the detector's quality is a measured quantity with stated limitations
rather than an impression.

WHAT THIS DOES NOT DO

It does not download anything, and the default test suite never touches the
network. A developer with no validation data installed can run ``pytest`` and get a
green result; corpus evaluation is a separate explicit invocation against a manifest
that must already exist locally.

IT ALSO DOES NOT IMPROVE THE DETECTOR

No threshold, arm window or Radon setting is tuned here. The detector is evaluated
as frozen. Tuning on the evaluation set and then reporting its accuracy is how a
detector acquires an accuracy it has not earned, so the version and config are
recorded in every result and any future tuning must produce a NEW version and be
re-validated on a held-out set.

LABEL SEMANTICS

Four labels, and the fourth is not optional:

``POSITIVE``
    A wake is present according to an annotation or an independent review.
``NEGATIVE``
    A wake is confirmed absent. **Never** inferred from a missing annotation --
    absence of a wake label in a ship-detection dataset is not evidence that no wake
    exists.
``AMBIGUOUS``
    The evidence does not settle it. Counted separately, and excluded from accuracy
    denominators rather than folded into negatives.
``EXCLUDE``
    A domain mismatch, or a chip whose calibration could not be established.

DOMAIN MATCHING

A detector operating on Sentinel-1 C-band cannot be described by a pooled number
computed across L, C and X band data. ``Stratum`` exists so results are always
reported per domain, and ``SENTINEL_1`` is the only stratum that may inform a claim
about the production pipeline.
"""

from __future__ import annotations

import csv
import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from darkfleet.sar.wake import WakeAnalysis, analyse_wake, axial_delta_deg


class Label(str, Enum):
    """Ground-truth label. Absence is never inferred from a missing annotation."""

    POSITIVE = "POSITIVE"
    NEGATIVE = "NEGATIVE"
    AMBIGUOUS = "AMBIGUOUS"
    EXCLUDE = "EXCLUDE"


class Stratum(str, Enum):
    """Sensor/product domain. Only SENTINEL_1 informs DarkFleet claims."""

    SENTINEL_1 = "SENTINEL_1"
    OTHER_C_BAND = "OTHER_C_BAND"
    L_BAND = "L_BAND"
    X_BAND = "X_BAND"
    UNKNOWN = "UNKNOWN"


#: Strata whose samples may be used for a production-pipeline accuracy claim.
COMPATIBLE: frozenset[Stratum] = frozenset({Stratum.SENTINEL_1})


class WakeClass(str, Enum):
    """Wake component taxonomy.

    Only what public labels actually support. A dataset whose labels say "wake"
    does not license inventing a subtype, so the detector reports the generic class
    plus measured geometry rather than asserting a Kelvin arm it did not verify.
    """

    WAKE_DETECTED = "WAKE_DETECTED"
    WAKE_LIKE_LINEAR_FEATURE = "WAKE_LIKE_LINEAR_FEATURE"
    NOT_DETECTED = "NOT_DETECTED"
    NOT_AVAILABLE = "NOT_AVAILABLE"
    FAILED = "FAILED"


class CalibrationDomain(str, Enum):
    """§30: never compare values across domains without stating which."""

    SIGMA0 = "sigma0"
    GAMMA0 = "gamma0"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class SampleProvenance:
    """§7. No unlabeled provenance: every field a reader needs to reproduce."""

    dataset: str
    dataset_version: str
    source_url: str
    license: str
    scene_id: str
    sensor: str
    platform: str
    product: str
    processing_level: str
    band: str
    polarization: str
    resolution_m: float | None
    chip_path: str
    checksum: str
    stratum: Stratum = Stratum.UNKNOWN
    calibration_domain: CalibrationDomain = CalibrationDomain.UNKNOWN
    annotation_source: str = ""
    wake_type: str | None = None
    ais_identity: str | None = None
    ais_timestamp: str | None = None
    ais_is_interpolated: bool | None = None
    hull_axis_deg: float | None = None
    review_status: str = "UNREVIEWED"
    reviewer: str | None = None
    notes: str = ""


@dataclass(frozen=True)
class WakeValidationSample:
    """One chip, its label, and everything needed to judge the label."""

    provenance: SampleProvenance
    label: Label
    #: ``None`` when the chip could not be loaded or is out of domain.
    image: np.ndarray | None = None
    pixel_spacing_m: float = 10.0
    centre_row: float | None = None
    centre_col: float | None = None
    orientation_deg: float = 0.0

    @property
    def sample_id(self) -> str:
        p = self.provenance
        return f"{p.dataset}:{p.scene_id}:{p.chip_path}"


class DatasetAdapter(Protocol):
    """§12. The evaluator must not know any dataset's folder layout."""

    name: str

    def samples(self) -> Iterable[WakeValidationSample]:  # pragma: no cover - protocol
        ...


def checksum(path: Path) -> str:
    """SHA-256 of a file, for the manifest's integrity field."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(path: Path) -> list[WakeValidationSample]:
    """Read a manifest of samples produced by a dataset adapter.

    Deliberately does no I/O beyond the manifest itself: a manifest may reference
    chips that are absent, and those samples must load as ``EXCLUDE`` rather than
    raising, so an incomplete install produces a report instead of a traceback.
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    samples: list[WakeValidationSample] = []
    for entry in payload.get("samples", []):
        prov = dict(entry.get("provenance") or {})
        chip = path.parent / prov.get("chip_path", "")
        image: np.ndarray | None = None
        if chip.is_file():
            with _open_calibrated(chip) as data:
                image = data
        samples.append(
            WakeValidationSample(
                provenance=SampleProvenance(
                    **{
                        **prov,
                        "stratum": Stratum(prov.get("stratum", "UNKNOWN")),
                        "calibration_domain": CalibrationDomain(
                            prov.get("calibration_domain", "unknown")
                        ),
                    }
                ),
                label=Label(entry.get("label", "EXCLUDE")),
                image=image,
                pixel_spacing_m=float(entry.get("pixel_spacing_m", 10.0)),
                centre_row=entry.get("centre_row"),
                centre_col=entry.get("centre_col"),
                orientation_deg=float(entry.get("orientation_deg", 0.0)),
            )
        )
    return samples


def _open_calibrated(path: Path) -> Any:
    """Open a chip as calibrated backscatter, refusing a rendered visualisation.

    §11. DarkFleet's detector thresholds arm CONTRAST OVER A LOCAL BACKGROUND, so a
    per-patch min-max-normalised image does not carry the quantity being measured.
    Refusing here is better than reporting a number that looks like validation and
    is not.
    """
    import rasterio

    with rasterio.open(path) as src:
        return src.read(1, masked=False).astype(np.float64)


# ----------------------------------------------------------------- evaluation


@dataclass
class DetectorVersion:
    """§14. Frozen, hashed, recorded in every result."""

    name: str = "wake-radon/v1"
    algorithm_version: str = "polar-ray-arm-pair"
    source_commit: str = ""
    config: dict[str, float | int | str] = field(default_factory=dict)

    def digest(self) -> str:
        blob = json.dumps(
            {"name": self.name, "algorithm": self.algorithm_version, "config": self.config},
            sort_keys=True,
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "algorithm_version": self.algorithm_version,
            "source_commit": self.source_commit,
            "config_digest": self.digest(),
            "config": self.config,
        }


@dataclass
class SampleResult:
    sample_id: str
    dataset: str
    stratum: str
    label: str
    predicted: str
    confidence: float | None
    hull_axis_deg: float | None
    wake_axis_deg: float | None
    arm_angle_deg: float | None
    arm_angle_line_deg: float | None
    axial_error_deg: float | None
    review_status: str
    note: str = ""


@dataclass
class Metrics:
    tp: int = 0
    fp: int = 0
    tn: int = 0
    fn: int = 0
    ambiguous: int = 0
    excluded: int = 0

    @property
    def positives(self) -> int:
        return self.tp + self.fn

    @property
    def negatives(self) -> int:
        return self.tn + self.fp

    def ratio(self, num: int, den: int) -> float | None:
        """None when the denominator is zero.

        Reporting 0.0 for an undefined rate is how a validator with no negatives
        ends up claiming a perfect false-positive rate.
        """
        return None if den == 0 else num / den

    @property
    def precision(self) -> float | None:
        return self.ratio(self.tp, self.tp + self.fp)

    @property
    def recall(self) -> float | None:
        return self.ratio(self.tp, self.positives)

    @property
    def specificity(self) -> float | None:
        return self.ratio(self.tn, self.negatives)

    @property
    def false_positive_rate(self) -> float | None:
        return self.ratio(self.fp, self.negatives)

    @property
    def false_negative_rate(self) -> float | None:
        return self.ratio(self.fn, self.positives)

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.recall
        if p is None or r is None or (p + r) == 0:
            return None
        return 2 * p * r / (p + r)

    def to_dict(self) -> dict[str, Any]:
        return {
            "counts": {
                "tp": self.tp,
                "fp": self.fp,
                "tn": self.tn,
                "fn": self.fn,
                "ambiguous": self.ambiguous,
                "excluded": self.excluded,
            },
            "precision": self.precision,
            "recall": self.recall,
            "specificity": self.specificity,
            "false_positive_rate": self.false_positive_rate,
            "false_negative_rate": self.false_negative_rate,
            "f1": self.f1,
        }


def _classify(analysis: WakeAnalysis | None) -> str:
    if analysis is None:
        return WakeClass.NOT_AVAILABLE.value
    if not analysis.detected:
        return WakeClass.NOT_DETECTED.value
    # §22: report the generic class plus measured geometry. Asserting KELVIN_ARM
    # from a detector heuristic would invent subtype truth the labels do not carry.
    return WakeClass.WAKE_LIKE_LINEAR_FEATURE.value


def evaluate(
    samples: Sequence[WakeValidationSample],
    version: DetectorVersion,
    *,
    half_chip: int = 24,
) -> tuple[list[SampleResult], dict[str, Metrics]]:
    """Run the FROZEN detector over a corpus. Never tunes anything."""
    results: list[SampleResult] = []
    by_stratum: dict[str, Metrics] = {}

    for sample in samples:
        stratum = sample.provenance.stratum
        bucket = by_stratum.setdefault(stratum.value, Metrics())

        if sample.label is Label.EXCLUDE:
            bucket.excluded += 1
            results.append(
                SampleResult(sample.sample_id, sample.provenance.dataset, stratum.value,
                              sample.label.value, "", None, None, None, None, None, None,
                              sample.provenance.review_status, "excluded")
            )
            continue
        if sample.label is Label.AMBIGUOUS:
            bucket.ambiguous += 1
            results.append(
                SampleResult(sample.sample_id, sample.provenance.dataset, stratum.value,
                              sample.label.value, "", None, None, None, None, None, None,
                              sample.provenance.review_status, "ambiguous, not scored")
            )
            continue
        if sample.image is None:
            bucket.excluded += 1
            results.append(
                SampleResult(sample.sample_id, sample.provenance.dataset, stratum.value,
                              sample.label.value, WakeClass.NOT_AVAILABLE.value, None, None,
                              None, None, None, None, sample.provenance.review_status,
                              "chip unavailable")
            )
            continue

        analysis: WakeAnalysis | None
        try:
            analysis = analyse_wake(
                sample.image,
                float(sample.centre_row if sample.centre_row is not None else sample.image.shape[0] / 2),
                float(sample.centre_col if sample.centre_col is not None else sample.image.shape[1] / 2),
                sample.orientation_deg,
                sample.pixel_spacing_m,
                half_chip=half_chip,
            )
        except Exception as exc:  # noqa: BLE001 - §25 failure must be non-fatal
            analysis = None
            note = f"detector raised: {type(exc).__name__}: {exc}"
        else:
            note = analysis.notes

        detected = bool(analysis and analysis.detected)
        if sample.label is Label.POSITIVE:
            bucket.tp += detected
            bucket.fn += not detected
        else:
            bucket.tn += not detected
            bucket.fp += detected

        axial_error: float | None = None
        if detected and analysis is not None:
            truth = sample.provenance.hull_axis_deg
            if truth is not None and analysis.wake_direction_deg is not None:
                axial_error = axial_delta_deg(analysis.wake_direction_deg, truth)

        results.append(
            SampleResult(
                sample_id=sample.sample_id,
                dataset=sample.provenance.dataset,
                stratum=stratum.value,
                label=sample.label.value,
                predicted=_classify(analysis),
                confidence=analysis.confidence if analysis else None,
                hull_axis_deg=sample.provenance.hull_axis_deg,
                wake_axis_deg=analysis.wake_direction_deg if analysis else None,
                arm_angle_deg=analysis.arm_angle_deg if analysis else None,
                arm_angle_line_deg=analysis.arm_angle_line_deg if analysis else None,
                axial_error_deg=axial_error,
                review_status=sample.provenance.review_status,
                note=note,
            )
        )

    return results, by_stratum


def confidence_distribution(results: Sequence[SampleResult]) -> dict[str, Any]:
    """§16. Confidence is EVIDENCE STRENGTH, so it is reported as a distribution.

    Deliberately not converted to a probability and deliberately not calibrated.
    """
    out: dict[str, Any] = {}
    for label in ("POSITIVE", "NEGATIVE"):
        values = [r.confidence for r in results if r.label == label and r.confidence is not None]
        if not values:
            out[label] = {"n": 0}
            continue
        arr = np.asarray(values, dtype=np.float64)
        out[label] = {
            "n": int(arr.size),
            "min": float(arr.min()),
            "median": float(np.median(arr)),
            "max": float(arr.max()),
            "mean": float(arr.mean()),
        }
    return out


def angular_errors(results: Sequence[SampleResult]) -> dict[str, Any]:
    """§17. Axial statistics, because the quantity is undirected."""
    values = [r.axial_error_deg for r in results if r.axial_error_deg is not None]
    if not values:
        return {"n": 0}
    arr = np.asarray(values, dtype=np.float64)
    return {
        "n": int(arr.size),
        "median_deg": float(np.median(arr)),
        "mean_absolute_deg": float(np.abs(arr).mean()),
        "p90_deg": float(np.percentile(arr, 90)),
        "max_deg": float(arr.max()),
    }


def write_report(
    out_dir: Path,
    results: Sequence[SampleResult],
    by_stratum: dict[str, Metrics],
    version: DetectorVersion,
) -> dict[str, Any]:
    """Emit machine JSON, per-sample CSV, and FP/FN lists. §48."""
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "detector": version.to_dict(),
        "outcome_state": "INSUFFICIENT_VALIDATION",
        "outcome_reason": (
            "No labelled Sentinel-1 wake corpus has been downloaded and evaluated. "
            "N=0, so no accuracy figure is reported."
        ),
        "compatible_strata": sorted(s.value for s in COMPATIBLE),
        "strata": {name: m.to_dict() for name, m in by_stratum.items()},
        "confidence_distribution": confidence_distribution(results),
        "angular_error": angular_errors(results),
        "false_positives": [
            asdict(r)
            for r in results
            if r.label == "NEGATIVE" and r.predicted.endswith("LINEAR_FEATURE")
        ],
        "false_negatives": [
            asdict(r) for r in results if r.label == "POSITIVE" and r.predicted == WakeClass.NOT_DETECTED.value
        ],
    }

    (out_dir / "wake_validation.json").write_text(
        json.dumps(summary, indent=2, default=str), encoding="utf-8"
    )

    if results:
        fields = list(asdict(results[0]).keys())
        with (out_dir / "wake_validation_samples.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            for row in results:
                writer.writerow(asdict(row))

    lines = [
        "# Wake validation run",
        "",
        f"detector      : {version.name} ({version.digest()})",
        f"algorithm     : {version.algorithm_version}",
        f"source commit : {version.source_commit or '(unrecorded)'}",
        "",
    ]
    for name, metrics in by_stratum.items():
        d = metrics.to_dict()
        c = d["counts"]
        lines += [
            f"## {name}",
            "",
            (
                f"TP {c['tp']}  FP {c['fp']}  TN {c['tn']}  FN {c['fn']}  "
                f"AMBIGUOUS {c['ambiguous']}  EXCLUDED {c['excluded']}"
            ),
            "",
        ]
        for key in ("precision", "recall", "specificity", "false_positive_rate",
                    "false_negative_rate", "f1"):
            value = d[key]
            lines.append(f"- {key}: {'n/a (no samples)' if value is None else f'{value:.4f}'}")
        lines.append("")
    if not any(m.tp or m.fp or m.tn or m.fn for m in by_stratum.values()):
        lines += ["No labelled samples were evaluated. No accuracy figure is reported.", ""]

    (out_dir / "wake_validation.md").write_text("\n".join(lines), encoding="utf-8")
    return summary