"""Polarization extraction on the PRODUCTION SAR path.

DF-X7V.B. `polarization.py` has existed, fully implemented, with zero callers. This
module connects it to the pipeline -- and, on the evidence, connects it honestly
rather than optimistically.

WHAT THE PIPELINE ACTUALLY READS

Traced rather than assumed from scene metadata (DF-X7V section 28):

    providers/stac.py    SarAsset carries ONE `polarization` and ONE `asset_href`
    sar/georef.py        read_window does `ds.read(1, window=win)` -- BAND 1

So a production scan reads exactly ONE polarization. There is no second channel,
and therefore no pair of co-registered arrays. That is the single most important
finding in this module, and it is why the dominant production state here is
``NOT_AVAILABLE`` with a reason rather than a computed ratio.

WHY THAT IS THE RIGHT ANSWER

It would have been easy to synthesise a second channel, resample it, or read VH
from a different extent. Every one of those produces a VH/VV ratio that looks like
a measurement of this vessel and is actually a ratio of two unrelated things. A
dual-pol discriminator computed that way is worse than no discriminator, because
it looks like evidence.

So: where only one polarization exists, the channel reports the measured
statistics for that polarization and marks every dual-pol quantity NOT_AVAILABLE.
No imputation, no substitution, and no failure of the SAR scan.

CALIBRATION DOMAIN

Preserved and never crossed (section 30). The production RTC product is gamma0; GRD
is sigma0. A ratio is only computed between arrays that share a domain, because
sigma0/gamma0 differ by an incidence-angle term and comparing across them yields
a number with no interpretation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..polarization import NOT_AVAILABLE, extract_features

#: Product type -> calibration domain. RTC is ground-referenced gamma0; GRD is
#: terrain-corrected sigma0. Comparing across the two divides by an incidence
#: angle term that has nothing to do with the vessel.
PRODUCT_DOMAIN: dict[str, str] = {
    "GRD": "sigma0",
    "RTC": "gamma0",
    "SLC": "unknown",
}

#: Why the channel is unavailable, as a canonical code rather than prose.
NOT_AVAILABLE_REASONS: dict[str, str] = {
    "SINGLE_POLARIZATION": (
        "this acquisition provides one polarization; a VH/VV ratio requires two "
        "co-registered channels and none was synthesised"
    ),
    "NO_POLARIZATION": "no polarization was read for this target",
    "UNREAD": "the polarization array could not be read",
    "EMPTY_MASK": "the target mask selected no pixels",
    "FAILED": "polarization extraction failed; the SAR detection is unaffected",
}


@dataclass
class PolarizationResult:
    """What the channel can honestly say about one target.

    ``status`` is the field a surface must branch on. ``FEATURES`` means
    something was measured; every other state means something was not, and each
    carries the reason.
    """

    status: str
    #: Detected polarization actually read for THIS target.
    available: tuple[str, ...] = ()
    requested: tuple[str, ...] = ("VV", "VH")
    #: Per-polarization mean/max/P95 in dB. Empty when nothing was measured.
    per_pol: dict[str, dict[str, float | str]] = field(default_factory=dict)
    vh_over_vv_db: float | None = None
    dual_pol_flags: dict[str, Any] = field(default_factory=dict)
    calibration_domain: str = "unknown"
    reason: str | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def single_pol(self) -> bool:
        return len(self.available) <= 1

    @property
    def measured(self) -> bool:
        """Whether any statistic is a real measurement rather than a marker."""
        return self.status == "FEATURES"

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "available": list(self.available),
            "requested": list(self.requested),
            "single_pol": self.single_pol,
            "per_pol": self.per_pol,
            "vh_over_vv_db": self.vh_over_vv_db,
            "dual_pol_flags": self.dual_pol_flags,
            "calibration_domain": self.calibration_domain,
            "reason": self.reason,
            "notes": list(self.notes),
        }


def unavailable(
    reason: str,
    *,
    available: tuple[str, ...] = (),
    domain: str = "unknown",
) -> PolarizationResult:
    """A typed 'not measured' state. Never an exception, never a fake value.

    `domain` is carried through even here. The calibration domain is known from the
    product before a single pixel is read, so dropping it on the unavailable paths
    loses provenance on precisely the states that have no other provenance, and a
    reader cannot tell an unmeasured RTC from an unmeasured unknown product.
    """
    return PolarizationResult(
        status="NOT_AVAILABLE",
        available=available,
        reason=NOT_AVAILABLE_REASONS.get(reason, reason),
        calibration_domain=domain,
        dual_pol_flags={"vh_over_vv": NOT_AVAILABLE},
    )


def domain_for(product: str | None) -> str:
    """Section 30. Unknown stays unknown; it is never guessed."""
    if not product:
        return "unknown"
    return PRODUCT_DOMAIN.get(product.strip().upper(), "unknown")


def extract_for_target(
    pols: dict[str, np.ndarray],
    *,
    mask: np.ndarray | None,
    product: str | None,
    polarization_read: str | None,
    requested: tuple[str, ...] = ("VV", "VH"),
) -> PolarizationResult:
    """Measure polarization over ONE target's mask.

    ``polarization_read`` is what the pipeline actually opened, recorded so the
    result cannot claim a channel the read path never provided.
    """
    domain = domain_for(product)

    # Everything below is inside the guard. Previously the emptiness probe and the
    # channel filter sat outside it, so a caller passing a non-dict got an
    # AttributeError instead of a typed state -- which is the opposite of what a
    # non-fatal evidence channel promises its caller.
    try:
        if not pols:
            return unavailable("NO_POLARIZATION", domain=domain)

        if mask is not None and int(np.count_nonzero(mask)) == 0:
            return unavailable("EMPTY_MASK", available=tuple(sorted(pols)), domain=domain)

        # Only keep channels the read path can vouch for. A caller handing us a dict
        # with more entries than were read would otherwise get a ratio computed from
        # an array whose provenance is unknown.
        verified = {p: a for p, a in pols.items() if polarization_read in (None, p)}
        if not verified:
            return unavailable("UNREAD", available=tuple(sorted(pols)), domain=domain)

        features = extract_features(
            verified,
            mask=mask,
            requested=requested,
            domain=domain,
            product_id=product or "",
        )
    except Exception as exc:  # noqa: BLE001 - section 39: never fatal
        return PolarizationResult(
            status="FAILED",
            available=tuple(sorted(locals().get("verified") or {})),
            calibration_domain=domain,
            reason=f"{NOT_AVAILABLE_REASONS['FAILED']} ({type(exc).__name__}: {exc})",
            dual_pol_flags={"vh_over_vv": NOT_AVAILABLE},
        )

    available = features.provenance.available
    # FEATURES asserts that something was measured. If every per-pol statistic came
    # back a NOT_AVAILABLE marker, nothing was, and the status must say so.
    any_statistic = any(
        not isinstance(v, str)
        for stats in features.per_pol.values()
        for v in stats.values()
    )
    if available and not any_statistic:
        # The channels that WERE read are kept on the record, with their markers,
        # so a reader can still see that VV was present and produced nothing. What
        # is withheld is the FEATURES claim, not the provenance.
        return PolarizationResult(
            status="NOT_AVAILABLE",
            available=available,
            requested=tuple(requested),
            per_pol=dict(features.per_pol),
            calibration_domain=domain,
            reason=(
                "every polarization present is entirely non-finite, so no statistic "
                "could be measured"
            ),
            notes=list(features.notes),
            dual_pol_flags={"vh_over_vv": NOT_AVAILABLE},
        )
    result = PolarizationResult(
        status="FEATURES",
        available=available,
        requested=tuple(requested),
        per_pol=dict(features.per_pol),
        vh_over_vv_db=features.vh_over_vv_db,
        dual_pol_flags=dict(features.dual_pol_flags),
        calibration_domain=domain,
        notes=list(features.notes),
    )
    if result.single_pol:
        # Make the reason explicit on the record rather than leaving a consumer to
        # infer it from a missing field.
        result.reason = NOT_AVAILABLE_REASONS["SINGLE_POLARIZATION"]
    return result


def for_scene_polarization(
    polarization_read: str | None,
    *,
    product: str | None,
    mask: np.ndarray | None = None,
    db: np.ndarray | None = None,
) -> PolarizationResult:
    """Build the result from what the PRODUCTION path can actually supply.

    Today that is one polarization read from one asset, so this returns the
    single-pol state with the measured statistics when an array is supplied, and
    NOT_AVAILABLE otherwise. When the read path gains a second co-registered
    channel, this is the single place that changes.
    """
    domain = domain_for(product)
    if not polarization_read:
        return unavailable("NO_POLARIZATION", domain=domain)
    if db is None:
        return unavailable("UNREAD", available=(polarization_read,), domain=domain)
    return extract_for_target(
        {polarization_read: db},
        mask=mask,
        product=product,
        polarization_read=polarization_read,
    )