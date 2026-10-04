"""Offline wake validation.

Evaluation machinery only. Nothing in this package is imported by the default
test suite, and nothing here touches the network.
"""

from .corpus import (
    COMPATIBLE,
    CalibrationDomain,
    DatasetAdapter,
    DetectorVersion,
    Label,
    Metrics,
    SampleProvenance,
    Stratum,
    WakeClass,
    WakeValidationSample,
    angular_errors,
    checksum,
    confidence_distribution,
    evaluate,
    load_manifest,
    write_report,
)

__all__ = [
    "COMPATIBLE",
    "CalibrationDomain",
    "DatasetAdapter",
    "DetectorVersion",
    "Label",
    "Metrics",
    "SampleProvenance",
    "Stratum",
    "WakeClass",
    "WakeValidationSample",
    "angular_errors",
    "checksum",
    "confidence_distribution",
    "evaluate",
    "load_manifest",
    "write_report",
]