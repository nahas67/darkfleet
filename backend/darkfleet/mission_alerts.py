"""Pure, deterministic evaluation of persisted SAR evidence against operator rules.

This module does not ingest or estimate observations, infer criminal activity,
or contact a provider. Unavailable evidence has its own status, never zero.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class RuleFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["TRIGGERED", "BELOW_THRESHOLD", "NOT_EVALUATED"]
    reason: str
    sar_confidence: float | None
    classification: str | None
    evidence_fingerprint: str | None
    evidence: dict[str, Any] | None


def _safe_value(value: object) -> str | None:
    """Never include unreviewed signed URLs or provider metadata in an alert."""
    if isinstance(value, str) and 0 < len(value) <= 200 and "://" not in value:
        return value
    return None


def evaluate_sar_watch(
    scan_id: str,
    record: dict[str, Any] | None,
    target_id: str,
    minimum_confidence: float,
) -> RuleFinding:
    """Evaluate one watched target against one persisted REAL scan.

    The caller checks watchlist membership independently: a target's presence
    in scan evidence is not authorization for a watch or alert.
    """
    def missing(reason: str) -> RuleFinding:
        return RuleFinding(
            status="NOT_EVALUATED", reason=reason, sar_confidence=None,
            classification=None, evidence_fingerprint=None, evidence=None,
        )

    if not isinstance(record, dict) or (
        record.get("scan_id") != scan_id
        or record.get("runtime_mode") != "REAL"
        or record.get("synthetic") is not False
    ):
        return missing("PERSISTED_REAL_SCAN_UNAVAILABLE")
    if record.get("stage") != "COMPLETE":
        return missing("SCAN_NOT_COMPLETE")
    targets = record.get("targets")
    if not isinstance(targets, list):
        return missing("TARGET_EVIDENCE_UNAVAILABLE")
    candidates = [t for t in targets if isinstance(t, dict) and t.get("id") == target_id]
    if len(candidates) != 1:
        return missing("WATCHED_TARGET_NOT_UNIQUELY_PRESENT")
    target = candidates[0]
    value = target.get("sarConf")
    if (isinstance(value, bool) or not isinstance(value, (float, int))
            or not math.isfinite(value) or not 0 <= value <= 1):
        return missing("SAR_CONFIDENCE_NOT_RECORDED")
    classification = _safe_value(target.get("cls"))
    # Classifications and source observations are only echoed; this evaluator
    # never treats "unmatched" as illicit, non-reporting or deceptive conduct.
    scene = record.get("scene")
    scene = scene if isinstance(scene, dict) else {}
    provenance = record.get("provenance")
    provenance = provenance if isinstance(provenance, dict) else {}
    evidence: dict[str, Any] = {
        "source": "PERSISTED_REAL_SAR_SCAN",
        "scan_id": scan_id,
        "target_id": target_id,
        "runtime_mode": "REAL",
        "synthetic": False,
        "scan_stage": "COMPLETE",
        "sar_confidence": float(value),
        "classification": classification,
        "scene_item_id": _safe_value(scene.get("item_id")),
        "acquisition_time": _safe_value(scene.get("acquisition_time"))
            or _safe_value(record.get("acquisition_time")),
        "scan_created_at": _safe_value(record.get("created_at")),
        "processing_version": _safe_value(provenance.get("processing_version")),
    }
    digest = hashlib.sha256(
        json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode("utf-8"),
    ).hexdigest()
    actual = float(value)
    if actual >= minimum_confidence:
        return RuleFinding(
            status="TRIGGERED",
            reason=(
                f"Operator-configured SAR confidence watch: saved target {target_id} "
                f"in REAL scan {scan_id} has recorded sarConf={actual:.6g}, "
                f"meeting threshold {minimum_confidence:.6g}. This indicates only a "
                "rule threshold match, not a determination of vessel identity or intent."
            ),
            sar_confidence=actual, classification=classification,
            evidence_fingerprint=digest, evidence=evidence,
        )
    return RuleFinding(
        status="BELOW_THRESHOLD",
        reason=(
            f"Recorded sarConf={actual:.6g} is below operator threshold "
            f"{minimum_confidence:.6g} for watched target {target_id} in scan {scan_id}."
        ),
        sar_confidence=actual, classification=classification,
        evidence_fingerprint=digest, evidence=evidence,
    )
