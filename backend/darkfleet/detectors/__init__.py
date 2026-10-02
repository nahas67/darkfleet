"""Detector interface with CA-CFAR as the shipped baseline (ADV-007, SAR-313).

The ML slot is an ADAPTER CONTRACT only. No weights ship with DarkFleet: no
maintained open Sentinel-1 GRD vessel-detection weight set exists (verified in
docs/RESEARCH_REGISTRY.md), and an unvalidated model must never be presented as
a SAR detector. An adapter must declare its training domain and validation, and
the registry refuses one that does not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np


@dataclass(frozen=True)
class DetectionResult:
    """One detector candidate in pixel space."""

    cy: float
    cx: float
    area: int
    mean_db: float
    max_db: float


@dataclass(frozen=True)
class DetectorCard:
    """Provenance a detector must declare before it can be used."""

    name: str
    kind: str  # CFAR | ML | ENSEMBLE
    training_domain: str
    input_product: str
    validation_data: str
    limitations: str
    weights_digest: str | None = None

    def is_usable(self) -> bool:
        """An ML/ensemble detector without weights and validation is refused."""
        if self.kind == "CFAR":
            return True
        return bool(self.weights_digest) and bool(self.validation_data)


@dataclass
class DetectorSpec:
    card: DetectorCard
    run: Any  # callable(array, valid, land, config) -> list[DetectionResult]
    extra: dict[str, Any] = field(default_factory=dict)


class Detector(Protocol):
    card: DetectorCard

    def detect(
        self, db: np.ndarray, valid: np.ndarray, land: np.ndarray | None, config: dict[str, Any]
    ) -> list[DetectionResult]: ...


def _run_cfar(
    db: np.ndarray,
    valid: np.ndarray,
    land: np.ndarray | None,
    config: dict[str, Any],
) -> list[DetectionResult]:
    """The shipped baseline: CA-CFAR + connected components."""
    from ..sar.cfar import run_ca_cfar
    from ..sar.components import extract_components

    det = run_ca_cfar(
        db,
        valid,
        land,
        training_cells=int(config.get("training_cells", 16)),
        guard_cells=int(config.get("guard_cells", 4)),
        threshold_factor=float(config.get("threshold_factor", 3.5)),
    )
    comps = extract_components(
        det["mask"],
        db,
        min_pixels=int(config.get("min_pixels", 3)),
        max_pixels=int(config.get("max_pixels", 1000)),
    )
    return [
        DetectionResult(
            cy=c["cy"], cx=c["cx"], area=c["area"], mean_db=c["meanDb"], max_db=c["maxDb"]
        )
        for c in comps
    ]


CFAR_CARD = DetectorCard(
    name="cfar",
    kind="CFAR",
    training_domain="deterministic (no training)",
    input_product="Sentinel-1 GRD (DN->sigma0) or RTC (linear gamma0)",
    validation_data="golden parity fixture vs the verified legacy engine",
    limitations=(
        "Assumes locally stationary clutter. Threshold is a multiplier, not a "
        "calibrated Pfa. Misses small vessels near the detection threshold."
    ),
)


class DetectorRegistry:
    """Holds the baseline plus any adapter. Refuses unvalidated ML detectors."""

    def __init__(self, *, with_baseline: bool = True) -> None:
        self._specs: dict[str, DetectorSpec] = {}
        self._default = "cfar"
        if with_baseline:
            self.register(DetectorSpec(card=CFAR_CARD, run=_run_cfar))

    def register(self, spec: DetectorSpec, *, make_default: bool = False) -> None:
        if not spec.card.is_usable():
            raise ValueError(
                f"detector {spec.card.name!r} refused: ML/ensemble detectors must "
                "declare weights_digest and validation_data "
                f"(domain={spec.card.training_domain!r})"
            )
        self._specs[spec.card.name] = spec
        if make_default:
            self._default = spec.card.name

    def available(self) -> list[DetectorCard]:
        return [s.card for s in self._specs.values()]

    def resolve(self, name: str | None = None) -> DetectorSpec:
        key = name or self._default
        if key not in self._specs:
            raise KeyError(f"unknown detector {key!r}; have {sorted(self._specs)}")
        return self._specs[key]