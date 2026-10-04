"""Multi-polarization features where the data permits them (ADV-006).

Sentinel-1 IW ships dual polarization over most coastal scenes (VV+VH), single
polarization over some, and only occasionally HH. Everything here therefore has
to degrade honestly: a feature computed from one polarization is labelled as
such, and a feature that needs two polarizations reports NOT_AVAILABLE with the
reason rather than substituting a default.

Provenance is not optional. Any caller that mixes polarizations without
recording which ones were actually read has produced an unreproducible number.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

NOT_AVAILABLE = "NOT_AVAILABLE"

# A statistic is a float, or the NOT_AVAILABLE string. Never a zero standing in
# for a measurement that was not made.
Stat = float | str
Stats = dict[str, Stat]

# VV/VH separation is the maritime convention: open water has a low ratio,
# man-made targets sit higher. A threshold is NOT a probability and is not
# calibrated; it is a flag that the ordering held in the measured chip.
VH_VV_RATIO_SHIP_FLAG_DB = -3.0


@dataclass(frozen=True)
class PolarizationProvenance:
    """Exactly which polarizations were read, and why the others were not."""

    available: tuple[str, ...]
    requested: tuple[str, ...]
    unavailable: tuple[str, ...]
    reasons: dict[str, str] = field(default_factory=dict)
    domain: str = "sigma0"  # sigma0 (GRD) | gamma0 (RTC) | unknown

    @property
    def single_pol(self) -> bool:
        return len(self.available) <= 1

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["single_pol"] = self.single_pol
        return d


@dataclass
class PolarizationFeatures:
    """Per-polarization statistics plus the dual-pol discriminators."""

    provenance: PolarizationProvenance
    per_pol: dict[str, Stats]
    ratio_db: dict[str, float] | None
    vh_over_vv_db: float | None
    dual_pol_flags: dict[str, Any]
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _stats(arr: np.ndarray, mask: np.ndarray | None) -> Stats:
    if mask is not None:
        arr = arr[mask]
    if arr.size == 0:
        return {"mean_db": NOT_AVAILABLE, "max_db": NOT_AVAILABLE, "p95_db": NOT_AVAILABLE}
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return {"mean_db": NOT_AVAILABLE, "max_db": NOT_AVAILABLE, "p95_db": NOT_AVAILABLE}
    return {
        "mean_db": round(float(finite.mean()), 3),
        "max_db": round(float(finite.max()), 3),
        "p95_db": round(float(np.percentile(finite, 95)), 3),
    }


def pol_ratio_db(
    numerator: np.ndarray,
    denominator: np.ndarray,
    mask: np.ndarray | None = None,
) -> float | None:
    """dB ratio of two co-registered polarizations over the SAME pixels.

    Pixels where the denominator is not meaningfully bright are excluded: their
    ratio is an artefact of dividing by noise, not a measurement.

    `mask` selects the target the ratio is about. It is a parameter rather than an
    internal detail because omitting it is a real failure mode: a ratio taken over
    an entire scene is dominated by open water and reads as though it described one
    vessel. On a 400x400 window that is a statistic about the sea, wearing a
    vessel's name. Callers measuring a target must pass that target's mask.
    """
    num, den = numerator, denominator
    if mask is not None:
        if mask.shape != num.shape or mask.shape != den.shape:
            return None
        num, den = num[mask], den[mask]
        if num.size == 0:
            return None
    finite = np.isfinite(num) & np.isfinite(den)
    if not finite.any():
        return None
    num, den = num[finite], den[finite]
    keep = den > -25.0  # below this the ratio is dominated by speckle noise
    if not keep.any():
        return None
    value = float(np.median(num[keep] - den[keep]))
    return None if math.isnan(value) else round(value, 3)


def extract_features(
    pols: dict[str, np.ndarray],
    *,
    mask: np.ndarray | None = None,
    requested: tuple[str, ...] = ("VV", "VH"),
    domain: str = "sigma0",
    product_id: str = "",
) -> PolarizationFeatures:
    """Compute polarization features over `mask` from whatever is present.

    `pols` maps polarization name to a co-registered dB array. Any requested
    polarization absent from `pols` is recorded in provenance as unavailable;
    nothing is imputed.
    """
    available = tuple(p for p in ("VV", "VH", "HH", "HV") if p in pols)
    # A channel that is entirely non-finite yields no statistic worth the name.
    # Reporting FEATURES for it would tell a consumer that holds a measurement
    # while every field it reads is a NOT_AVAILABLE marker.
    measurable = tuple(
        p for p in available if bool(np.isfinite(pols[p]).any())
    )
    wanted = tuple(p for p in requested if p not in available)
    notes: list[str] = []
    if available and not measurable:
        notes.append("every polarization present is entirely non-finite")
        measurable = ()
    reasons = {p: "not present in this acquisition" for p in wanted}
    reasons.update(
        {p: "present but entirely non-finite" for p in set(available) - set(measurable)}
    )

    per_pol: dict[str, Stats] = {p: _stats(pols[p], mask) for p in available}
    if not available:
        notes.append("no polarization data in scope; all features NOT_AVAILABLE")

    ratio: dict[str, float] = {}
    vh_over_vv: float | None = None
    flags: dict[str, Any] = {}

    if "VV" in available and "VH" in available:
        # The mask is applied to the ratio as well as to the per-pol statistics.
        # Applying it to only one of the two would make the pair describe different
        # areas of the scene, which is worse than applying it to neither.
        vh_over_vv = pol_ratio_db(pols["VH"], pols["VV"], mask)
    else:
        notes.append("VH/VV requires dual-pol; reported NOT_AVAILABLE")
        flags["vh_over_vv"] = NOT_AVAILABLE

    if "HH" in available and "HV" in available:
        hv_over_hh = pol_ratio_db(pols["HV"], pols["HH"])
        if hv_over_hh is not None:
            ratio["hv_over_hh_db"] = hv_over_hh
    else:
        for missing in ("HH", "HV"):
            if missing not in available:
                reasons.setdefault(missing, "dual-pol unavailable")
        notes.append("HV/HH requires dual-pol; reported NOT_AVAILABLE")
        flags["hv_over_hh"] = NOT_AVAILABLE

    if vh_over_vv is not None:
        flags["vh_over_vv_above_ship_flag"] = vh_over_vv > VH_VV_RATIO_SHIP_FLAG_DB
        flags["vh_over_vv_threshold_db"] = VH_VV_RATIO_SHIP_FLAG_DB
        flags["interpretation"] = (
            "VH/VV ordering consistent with a man-made target. This is a flag, "
            "not a probability, and is not calibrated for this product."
        )
    else:
        flags["vh_over_vv"] = NOT_AVAILABLE

    if len(available) == 1:
        notes.append(
            f"single polarization ({available[0]}); dual-pol discriminators "
            "unavailable and no combined statistic is reported"
        )

    prov = PolarizationProvenance(
        available=available,
        requested=tuple(requested),
        unavailable=wanted,
        reasons=reasons,
        domain=domain,
    )
    _ = product_id  # carried by the scene provenance, not the per-chip feature
    return PolarizationFeatures(
        provenance=prov,
        per_pol=per_pol,
        ratio_db=ratio or None,
        vh_over_vv_db=vh_over_vv,
        dual_pol_flags=flags,
        notes=notes,
    )


def combine_pol_pols(pols: dict[str, np.ndarray]) -> np.ndarray:
    """Mean of the available polarizations, for single-channel detection paths.

    Refuses to run with no data at all: a zero array would read as "very dark
    water" and silently suppress every detection.
    """
    if not pols:
        raise ValueError("no polarization data to combine")
    stack = np.stack([pols[p] for p in sorted(pols)], axis=0)
    return stack.mean(axis=0)