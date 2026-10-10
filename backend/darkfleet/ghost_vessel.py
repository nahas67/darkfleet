"""Ghost Vessel semantics (GFST).

A Ghost Vessel is a **product-facing designation**, not an analytical class. The
analytical classification stays ``SAR_UNMATCHED``; the interface may render::

    GHOST VESSEL
    SAR_UNMATCHED

Definition
----------
> A vessel-like SAR return for which DarkFleet found no sufficiently confident AIS
> association in the available observations and correlation window.

What a Ghost Vessel designation does NOT mean
----------------------------------------------
It does not establish, imply, or suggest any of:

- a transponder was intentionally disabled;
- AIS was never transmitted;
- sanctions evasion, smuggling, or criminal activity;
- hostile or deceptive behaviour;
- identity concealment;
- illegal fishing;
- military intent.

None of those are measurable from a radar return and an absence of association.
The correlation only established that no candidate cleared a threshold. Every
plausible reading of *why* is a HYPOTHESIS, and hypotheses live in their own
section where they cannot be mistaken for findings.

This module exists so that the semantics are enforced in ONE place and cannot
drift per-surface. :func:`semantic_warning` is rendered on every Ghost Vessel
surface, and :data:`FORBIDDEN_INFERENCES` is asserted against product copy by a
test, so a future panel cannot quietly introduce accusatory language.

Why the designation is still worth having
-----------------------------------------
``SAR_UNMATCHED`` is a correlation outcome; a reader must already know the domain
to understand it. "Ghost Vessel" names the operational question an analyst is
actually asking -- *what did the radar see that AIS does not explain?* -- without
answering it. The risk is entirely in how it is phrased, which is why the phrasing
is code rather than copy.
"""

from __future__ import annotations

from typing import Any, Final

#: The analytical class that qualifies. Deliberately the raw backend value: the
#: designation is layered on top, never substituted for it.
GHOST_CLASSIFICATION: Final = "SAR_UNMATCHED"

#: Product-facing label. Rendered ABOVE the analytical class, never instead of it.
GHOST_LABEL: Final = "GHOST VESSEL"

#: Rendered on every Ghost Vessel surface, unmissably.
SEMANTIC_WARNING: Final = (
    "No sufficiently confident AIS association was found in the available "
    "observations and correlation window. This alone does not establish why."
)

#: Infers that are not supported by a radar return and an absent association.
#: Asserted absent from product copy by tests/test_ghost_vessel.py.
FORBIDDEN_INFERENCES: Final = (
    "transponder intentionally disabled",
    "transponder disabled",
    "ais was never transmitted",
    "never transmitted",
    "dark vessel",
    "sanctions evasion",
    "sanctions evasion",
    "smuggling",
    "criminal",
    "hostile",
    "deceptive",
    "identity concealment",
    "concealment",
    "illegal fishing",
    "military intent",
    "no transponder",
    "turned off",
    "go dark",
)

#: Candidate explanations, offered as hypotheses and never as findings.
#:
#: Every entry is a *coverage or detection* explanation. None is about intent,
#: because intent is not observable here. An analyst who wants intent hypotheses
#: has to reason from evidence; the product does not pre-supply them.
_HYPOTHESIS_TEMPLATES: Final = (
    "AIS coverage gap: no receiver covered this position at acquisition time.",
    "Stale observation: the nearest AIS report was too old to associate.",
    "The vessel was not broadcasting a position report at that moment.",
    "The vessel was outside reliable reception for its class and heading.",
    (
        "The return is not a vessel: surface clutter, a structure, or a processing "
        "artefact that met the detection threshold."
    ),
    "Incidence angle or radar geometry degraded detectability or association.",
)

#: Never established from a radar return.
_UNKNOWN_ITEMS: Final = (
    "Identity",
    "Flag or registry",
    "Destination",
    "Cargo",
    "Intent",
    "Whether any AIS transmission exists at all",
    "Whether the vessel is crewed",
    "Whether the return is a vessel at all",
)


def is_ghost_vessel(classification: Any) -> bool:
    """Whether this analytical class qualifies as a Ghost Vessel candidate."""
    return str(classification) == GHOST_CLASSIFICATION


def display_label(classification: Any) -> tuple[str | None, str]:
    """The (designation, analytical class) pair to render.

    Returns ``(None, classification)`` for anything else, so a non-Ghost target
    never acquires the designation by accident.
    """
    text = str(classification)
    return (GHOST_LABEL if is_ghost_vessel(text) else None), text


def _bullets(items: tuple[str, ...]) -> list[dict[str, str]]:
    return [{"text": item} for item in items]


def assess(
    target: dict[str, Any],
    *,
    ais_coverage: dict[str, Any] | None = None,
    wake_detected: bool | None = None,
    polarization_note: str | None = None,
    multipass_note: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    """Build the full Ghost Vessel record for one target.

    Every field is derived from measured or explicitly-absent data. Nothing is
    inferred: when a value was not measured it is ``None`` and says so, because a
    Ghost Vessel dossier is the document an analyst will be asked to defend.

    ``wake_detected`` defaults to the target's own ``wake`` field. An earlier
    signature took it as a required argument, which let the argument and the
    record disagree -- a caller could pass ``True`` for a target the detector had
    not flagged. The record is authoritative unless a caller has genuinely
    measured something the target row lacks, and that case passes explicitly.
    """
    if wake_detected is None:
        wake_detected = target.get("wake")
    corr = dict(target.get("corr") or {})
    decomposition = corr.get("scoreDecomposition") or {}
    classification = str(target.get("cls", ""))

    if not is_ghost_vessel(classification):
        return {
            "is_ghost_vessel": False,
            "designation": None,
            "analytical_classification": classification,
        }

    closest = corr.get("closestRejected")
    considered = corr.get("candidatesConsidered")
    threshold = corr.get("acceptanceThreshold")
    coverage_state = str((ais_coverage or {}).get("state") or "NOT_ESTABLISHED")

    # Why no association was accepted, in arithmetic.
    if closest is None:
        reason = (
            f"No AIS candidate was available to correlate within the search window. "
            f"{considered or 0} candidate(s) were considered."
            if considered == 0
            else f"{considered} AIS candidate(s) were considered, but no rejected-candidate "
                 "detail was recorded; the rejection cause is not established."
        )
    else:
        candidate_detail = (
            f"The closest candidate (MMSI {closest.get('mmsi')}"
            f"{', ' + str(closest.get('vesselName')) if closest.get('vesselName') else ''}) "
            f"scored {closest.get('score')} against a threshold of {threshold} "
            f"at {closest.get('distanceMeters')} m "
            f"and {closest.get('timeDeltaSeconds')} s."
        )
        rejection = closest.get("rejectionReason", closest.get("rejection_reason"))
        if rejection == "BELOW_THRESHOLD":
            reason = f"{candidate_detail} Its score was short by {closest.get('shortfall')}."
        elif rejection == "ONE_TO_ONE_CONFLICT":
            reason = (
                f"{candidate_detail} The AIS identity was already assigned to another "
                "SAR target under the one-to-one association rule."
            )
        elif rejection == "LOWER_RANKED_ALTERNATIVE":
            reason = f"{candidate_detail} It was a lower-ranked alternative to another candidate."
        elif rejection == "AMBIGUOUS_PAIR":
            reason = (
                f"{candidate_detail} Near-equal competing AIS candidates prevented "
                "an unambiguous association."
            )
        else:
            # Historical persisted records predate the reason field. A shortfall
            # number alone does not prove why a candidate was rejected.
            reason = f"{candidate_detail} The rejection cause was not recorded."

    return {
        "is_ghost_vessel": True,
        "designation": GHOST_LABEL,
        "analytical_classification": classification,
        "semantic_warning": SEMANTIC_WARNING,
        "observed": {
            "target_id": target.get("id"),
            "position": {"lat": target.get("lat"), "lon": target.get("lon")},
            "marine_region": region,
            "sar_detection_confidence": target.get("sarConf"),
            "apparent_footprint_m": {
                "length": target.get("lenM"),
                "width": target.get("widM"),
            },
            "length_uncertainty_m": target.get("lenUncM"),
            "orientation_deg": target.get("hdg"),
            "mean_backscatter_db": target.get("meanDb"),
            "max_backscatter_db": target.get("maxDb"),
            "wake_detected": wake_detected,
            "polarization_evidence": polarization_note,
            "multipass_evidence": multipass_note,
        },
        "decision": {
            "candidates_considered": considered,
            "acceptance_threshold": threshold,
            "closest_rejected_candidate": closest,
            "reason_no_association": reason,
            "ais_association_confidence": target.get("aisConf"),
            "ais_coverage_state": coverage_state,
            "score_decomposition": decomposition or None,
        },
        "hypotheses": _bullets(_HYPOTHESIS_TEMPLATES),
        "unknowns": _bullets(_UNKNOWN_ITEMS),
    }


__all__ = [
    "FORBIDDEN_INFERENCES",
    "GHOST_CLASSIFICATION",
    "GHOST_LABEL",
    "SEMANTIC_WARNING",
    "assess",
    "display_label",
    "is_ghost_vessel",
]
