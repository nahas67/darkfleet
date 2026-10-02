"""Optional AI narrative, strictly subordinate to the deterministic analysis.

Two rules govern this module and both are enforced in code, not by convention:

1. **The deterministic result is never at risk.** AI is an optional narrative
   layer over evidence that already exists. Every failure mode - no adapter, bad
   model id, network error, malformed JSON, schema violation, forbidden
   language - returns ``AI_UNAVAILABLE`` and leaves the deterministic evidence
   untouched. Nothing in the analysis path calls this module's failure branch.

2. **The AI may not introduce a fact.** An adapter receives the assembled
   evidence and must return only those five sections. Every claim it makes is
   checked against the vocabulary of the evidence, and the whole document is
   validated against the schema before it is returned. A model cannot invent an
   observation; if it tries, the document is refused.

The shipped default is a deterministic template renderer. No network model is
required, and none is called unless an adapter is explicitly registered.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

AI_UNAVAILABLE = "AI_UNAVAILABLE"

# Model identifiers must be unambiguous about what produced a narrative. A bare
# free-text string is refused because it cannot be audited later. The form is
# `provider/name` with an optional `@version` suffix.
MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}/[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,95}$")

REQUIRED_SECTIONS = ("observed", "hypotheses", "unknowns", "confidence", "summary")

# Vocabulary that would convert a coverage observation into an accusation. A
# missing AIS association is a data fact, never a statement about conduct.
FORBIDDEN = (
    "sanction",
    "sanctioned",
    "evad",
    "evading",
    "illegal",
    "unlawful",
    "smuggl",
    "traffick",
    "criminal",
    "threat",
    "hostile",
    "suspect",
    "dark vessel",
    "dark fleet",
    "no transponder",
    "transponder off",
    "not transmitting",
    "verified target",
    "confirmed vessel",
    "confirmed identity",
    "crisis",
    "escalation",
)


class SummaryRejected(ValueError):
    """A candidate narrative violated the schema, the evidence, or the language."""


@dataclass(frozen=True)
class ModelIdentity:
    """Who wrote a narrative. Always answerable, never anonymous."""

    model_id: str
    provider: str = "darkfleet"
    template_version: str = "1"

    @property
    def is_valid(self) -> bool:
        return bool(MODEL_ID_RE.match(self.model_id))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SummaryDocument:
    """The strict shape. No field is optional and none may be empty."""

    target_id: str
    observed: list[str]
    hypotheses: list[str]
    unknowns: list[str]
    confidence: float
    summary: str
    model: dict[str, Any]
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def validate_model_id(model_id: str) -> ModelIdentity:
    """Refuse an unauditable model identifier."""
    if not isinstance(model_id, str) or not MODEL_ID_RE.match(model_id):
        raise SummaryRejected(
            f"model_id {model_id!r} is not auditable; expected 'provider/name[:version]' "
            "in lowercase with an optional version suffix"
        )
    provider, _, name = model_id.partition("/")
    return ModelIdentity(model_id=model_id, provider=provider, template_version=name)


def _vocabulary(evidence: dict[str, Any]) -> set[str]:
    """Every token present in the evidence payload, for identifier matching."""
    blob = json.dumps(evidence, default=str).lower()
    return set(re.findall(r"[a-z0-9_.-]{2,}", blob))


def validate_document(
    doc: dict[str, Any],
    *,
    evidence: dict[str, Any] | None = None,
    untrusted: bool = False,
) -> SummaryDocument:
    """Validate an arbitrary candidate document against the strict contract.

    `untrusted=True` additionally holds the writer to the closed analytic
    vocabulary. Set it for any adapter that is not the shipped template.
    """
    if not isinstance(doc, dict):
        raise SummaryRejected("summary must be a JSON object")
    missing = [s for s in REQUIRED_SECTIONS if s not in doc]
    if missing:
        raise SummaryRejected(f"summary missing required sections: {', '.join(missing)}")
    extra = [k for k in doc if k not in (*REQUIRED_SECTIONS, "target_id", "model", "provenance")]
    if extra:
        raise SummaryRejected(f"summary has unexpected sections: {', '.join(extra)}")

    for section in ("observed", "hypotheses", "unknowns"):
        value = doc[section]
        if not isinstance(value, list) or not value:
            raise SummaryRejected(f"section {section!r} must be a non-empty list")
        if not all(isinstance(v, str) and v.strip() for v in value):
            raise SummaryRejected(f"section {section!r} must contain non-empty strings")

    conf = doc["confidence"]
    if not isinstance(conf, (int, float)) or isinstance(conf, bool):
        raise SummaryRejected("confidence must be a number")
    if not 0.0 <= float(conf) <= 1.0:
        raise SummaryRejected("confidence must be within [0, 1]")

    summary = doc["summary"]
    if not isinstance(summary, str) or not summary.strip():
        raise SummaryRejected("summary must be a non-empty string")

    model = doc.get("model")
    if not isinstance(model, dict) or "model_id" not in model:
        raise SummaryRejected("summary must carry a model object with model_id")
    identity = validate_model_id(str(model["model_id"]))

    blob = " ".join([*doc["observed"], *doc["hypotheses"], str(doc["summary"])]).lower()
    for word in FORBIDDEN:
        if word in blob:
            raise SummaryRejected(
                f"narrative uses accusatory vocabulary {word!r}; a coverage "
                "observation must not be rendered as a finding about conduct"
            )

    if evidence is not None:
        invented = sorted(fabricated_facts(doc, evidence))
        if invented:
            raise SummaryRejected(
                "narrative introduces facts absent from the evidence: "
                + ", ".join(invented[:8])
            )
    if untrusted and evidence is not None:
        novel = sorted(novel_content_words(doc, evidence))
        if novel:
            raise SummaryRejected(
                "narrative introduces terms absent from the evidence: "
                + ", ".join(novel[:8])
            )

    return SummaryDocument(
        target_id=str(doc.get("target_id", "")),
        observed=[s.strip() for s in doc["observed"]],
        hypotheses=[s.strip() for s in doc["hypotheses"]],
        unknowns=[s.strip() for s in doc["unknowns"]],
        confidence=round(float(conf), 3),
        summary=summary.strip(),
        model=identity.to_dict(),
        provenance=dict(doc.get("provenance", {})),
    )


_STOPWORDS = frozenset(
    ["a", "an", "the", "this", "that", "these", "those", "it", "its", "is", "are", "was", "were", "be", "been", "being", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as", "and", "or", "not", "no", "none", "any", "some", "all", "each", "every", "which", "who", "whom", "whose", "what", "when", "where", "while", "during", "over", "under", "above", "below", "between", "within", "without", "across", "about", "after", "before", "than", "then", "there", "here", "their", "they", "them", "he", "she", "his", "her", "we", "our", "you", "your", "i", "me", "my", "has", "have", "had", "do", "does", "did", "can", "could", "may", "might", "must", "shall", "should", "will", "would", "about", "more", "most", "less", "least", "very", "much", "many", "into", "over", "per", "via", "than", "so", "such", "only", "also", "both", "same", "other", "another", "next", "last", "first", "approximately", "returned", "returned-listed"]
)

# The closed analytic vocabulary a REMOTE narrative writer may draw on. The
# shipped deterministic template is exempt (it is f-strings over the evidence
# and cannot hallucinate); an untrusted adapter is not, so every content word it
# uses must come from this set or from the evidence itself. That is what turns
# "it may not introduce a fact" from a hope into a check.
_DOMAIN_VOCAB = frozenset(
    ["sar", "ais", "radar", "satellite", "backscatter", "sigma", "gamma", "decibel", "brightness", "contrast", "speckle", "noise", "chip", "pixels", "pixel", "resolution", "georeference", "georeferenced", "footprint", "wavelength", "incidence", "polarization", "vv", "vh", "hh", "hv", "dual", "quad", "single", "composite", "ratio", "threshold", "clutter", "land", "coastline", "mask", "masked", "valid", "nodata", "interpolation", "resample", "reproject", "crs", "epsg", "utm", "wgs84", "bounding", "bbox", "extent", "detection", "detector", "detect", "cfar", "false-alarm", "guard", "training", "component", "components", "labelled", "cluster", "centroid", "wake", "wakes", "trail", "heading", "course", "speed", "velocity", "knots", "metres", "meters", "spacing", "range", "azimuth", "slant", "vessel", "vessels", "ship", "ships", "craft", "cargo", "tanker", "container", "barge", "platform", "rig", "offshore", "structure", "harbour", "harbor", "port", "anchorage", "berth", "dock", "terminal", "buoy", "navigational", "navigation", "mmsi", "imo", "call-sign", "callsign", "report", "reports", "transmitted", "receiver", "receivers", "terrestrial", "reception", "shadow", "coverage", "gap", "outage", "association", "associations", "associated", "correlate", "correlated", "correlation", "match", "matches", "matched", "unmatched", "unassociated", "candidate", "hypothesis", "hypotheses", "unknown", "unknowns", "observed", "observation", "observations", "evidence", "measured", "measurement", "confidence", "uncertain", "uncertainty", "score", "decomposition", "radius", "window", "threshold", "propagation", "propagated", "reckoning", "dead", "implied", "distance", "offset", "delta", "cross-pass", "passes", "linkage", "length", "width", "size", "dimension", "dimensions", "apparent", "hull", "identify", "identifiable", "classify", "classified", "classification", "infrastructure", "establish", "established", "confirms", "distinguish", "distinguishes", "consistent", "ordering", "flag", "flags", "uncalibrated", "calibrated", "probability", "describe", "describes", "object", "same", "related", "corresponds", "data", "source", "sources", "record", "records", "table", "image", "imagery", "platform", "acquiring", "acquisition", "acquired", "revisit", "timestamp", "instant", "available", "unavailable", "present", "absent", "listed", "listing", "render", "rendered", "confirmed", "unconfirmed", "identity", "identification", "confirmation", "darkfleet", "pipeline", "scan", "runs", "run", "job", "jobs", "stage", "stages", "seconds", "hours", "minutes", "degrees", "analysis", "analysed", "return", "returns", "named", "naming", "refers", "referring", "state", "states", "whether", "beyond", "inside", "outside", "given", "given-only"]
)

_ALLOWED = _STOPWORDS | _DOMAIN_VOCAB


# Fabrication check. Analytic prose is legitimately free vocabulary, but a
# NUMBER or a NAMED ENTITY is a claim about the world, and that is exactly what
# the model is not allowed to introduce. So the guard checks those two token
# classes against the evidence rather than trying to whitelist English.
_NUMERIC_RE = re.compile(r"-?\d+(?:\.\d+)?")
# Identifiers a narrative may name: digit runs (MMSI, IMO, timestamps), and
# multi-word ALLCAPS names (vessel names). A bare ALLCAPS token is a domain
# acronym or a label ("MMSI", "AIS", "SAR"), not a named entity.
_IDENTIFIER_RE = re.compile(r"\b(?:\d{6,9}|[A-Z]{2,}(?:[A-Z0-9-]*[A-Z0-9])?(?:\s+[A-Z]{2,})+\b)\b")
_ACRONYM_RE = re.compile(r"\b[A-Z]{2,8}\b")
# Units a number may legitimately carry.
_UNIT_SUFFIX = re.compile(r"\s?(?:m|km|kn|knots?|deg|degrees?|db|px|s|sec|seconds?|h|hours?|min|minutes?)", re.IGNORECASE)


def _narrative_text(doc: dict[str, Any]) -> str:
    return " ".join(
        [str(doc.get("summary", ""))]
        + [str(v) for key in ("observed", "hypotheses", "unknowns") for v in doc.get(key, [])]
    )


def _strip_units(text: str) -> str:
    return _UNIT_SUFFIX.sub("", text)


def fabricated_facts(doc: dict[str, Any], evidence: dict[str, Any]) -> set[str]:
    """Numbers and named entities in the narrative that the evidence lacks.

    A narrative may not state a measurement the evidence does not contain, and
    may not name an object the evidence does not contain. Both are returned as
    a set of offending tokens.
    """
    narrative = _narrative_text(doc)
    # Section labels and the model's own identity are not claims about the world.
    narrative = narrative.replace(str(doc.get("target_id", "")), " ")
    narrative = re.sub(r"\b(?:OBSERVED|HYPOTHESES|UNKNOWNS|CONFIDENCE)\b", " ", narrative)

    source = _strip_units(json.dumps(evidence, default=str))
    source_nums = set(_NUMERIC_RE.findall(source))
    source_ids = {i.upper() for i in _IDENTIFIER_RE.findall(source)}

    offenders: set[str] = set()
    for number in _NUMERIC_RE.findall(_strip_units(narrative)):
        if number in source_nums:
            continue
        # accept a coarser rounding of an evidenced value (41.0 <- 41)
        try:
            value = float(number)
        except ValueError:
            offenders.add(number)
            continue
        if not any(
            abs(value - float(s)) < 0.05 * max(1.0, abs(float(s))) for s in source_nums
        ):
            offenders.add(number)

    for ident in _IDENTIFIER_RE.findall(narrative):
        if ident.upper() not in source_ids:
            offenders.add(ident)

    return offenders


def novel_content_words(doc: dict[str, Any], evidence: dict[str, Any]) -> set[str]:
    """Content words used by a narrative that neither the tool nor evidence knows.

    Applied only to remote adapters. The shipped template is deterministic code
    over the evidence and is exempt; an untrusted writer is not.
    """
    text = _narrative_text(doc).lower()
    evidenced = _vocabulary(evidence)
    novel: set[str] = set()
    for word in re.findall(r"[a-z][a-z-]{3,}", text):
        if word in _ALLOWED or word in evidenced:
            continue
        # tolerate plural / tense variants of an evidenced stem
        if any(
            word.startswith(a[: max(4, len(a) - 2)]) or a.startswith(word[:4])
            for a in evidenced
            if len(a) >= 4
        ):
            continue
        novel.add(word)
    return novel


def render_template(evidence: dict[str, Any], *, model: ModelIdentity) -> dict[str, Any]:
    """The shipped default narrative writer. Deterministic, offline, auditable.

    It restates the evidence and labels the gaps. It adds no new observation and
    draws no conclusion about intent.
    """
    target = str(evidence.get("target_id", ""))
    obs = evidence.get("observed", {}) or {}
    assoc = evidence.get("association", {}) or {}
    unc = evidence.get("uncertainty", {}) or {}

    observed: list[str] = []
    pos = obs.get("position") or {}
    if pos.get("lat") is not None:
        observed.append(f"A SAR return was measured at {pos['lat']:.4f}, {pos['lon']:.4f}.")
    footprint = obs.get("apparent_footprint_m") or {}
    if footprint.get("length") is not None:
        observed.append(
            f"Its apparent footprint is {footprint['length']:.0f} m by "
            f"{footprint.get('width', 0):.0f} m, which is an apparent size and not a "
            "measured hull length."
        )
    if obs.get("mean_backscatter_db") is not None:
        observed.append(f"Mean backscatter in the chip is {obs['mean_backscatter_db']:.1f} dB.")
    observed.append(f"The detection classification is {obs.get('sar_detection_confidence', 'n/a')} confidence.")

    mmsi = assoc.get("mmsi")
    hypotheses: list[str] = []
    unknowns: list[str] = []
    if mmsi:
        observed.append(
            f"An AIS report with MMSI {mmsi} was within "
            f"{assoc.get('distance_offset_m', 'n/a')} m and "
            f"{assoc.get('time_delta_s', 'n/a')} s of the acquisition time."
        )
        hypotheses.append(
            "The SAR return and that AIS report describe the same object. "
            "This is an association, not an identification."
        )
        unknowns.append("Hull type, cargo and dimensions are not observable in SAR.")
    else:
        observed.append(
            "No AIS observation met the correlation threshold in the "
            "observations available for this acquisition."
        )
        hypotheses.append(
            "A vessel was present at this location. Its identity, type and "
            "carriage obligation are not established."
        )
        unknowns.append(
            "Why no AIS association was available: carriage exemption, reception "
            "shadow, receiver outage and receiver-coverage limits are all "
            "consistent with what is measured, and the data cannot distinguish them."
        )
    if unc.get("propagation_note"):
        unknowns.append(unc["propagation_note"])
    unknowns.append("Wake presence, vessel heading and identity are not confirmed by this chip.")

    confidence = float(obs.get("sar_detection_confidence") or assoc.get("ais_association_confidence") or 0.0)
    summary = (
        f"{target or 'This target'}: a {obs.get('sar_detection_confidence', 0):.2f}-confidence "
        "SAR detection "
        + (
            f"with a correlated AIS report ({mmsi})."
            if mmsi
            else "with no AIS association within the correlation threshold."
        )
        + " Every statement here is either observed in the data or explicitly "
        "listed as unknown."
    )
    return {
        "target_id": target,
        "observed": observed,
        "hypotheses": hypotheses,
        "unknowns": unknowns,
        "confidence": round(min(1.0, max(0.0, confidence)), 3),
        "summary": summary,
        "model": model.to_dict(),
        "provenance": {"writer": "deterministic-template", "network_calls": 0},
    }


class Summariser(Protocol):
    """An optional narrative writer. May be remote; must be fallible."""

    model: ModelIdentity

    def summarise(self, evidence: dict[str, Any]) -> str: ...


class SummariserRegistry:
    """Holds optional adapters. Nothing is registered by default."""

    def __init__(self) -> None:
        self._adapters: dict[str, Summariser] = {}

    def register(self, adapter: Summariser) -> None:
        if not getattr(adapter, "model", None) or not adapter.model.is_valid:
            raise SummaryRejected(
                f"adapter refused: model_id {getattr(adapter, 'model', None)!r} is not auditable"
            )
        self._adapters[adapter.model.model_id] = adapter

    def available(self) -> list[ModelIdentity]:
        return [a.model for a in self._adapters.values()]


def summarise(
    evidence: dict[str, Any],
    *,
    registry: SummariserRegistry | None = None,
    model_id: str | None = None,
) -> dict[str, Any]:
    """Produce a narrative, or an explicit AI_UNAVAILABLE. Never raises.

    Returns a dict that always contains either a validated ``document`` or
    ``{"status": AI_UNAVAILABLE, "reason": ...}``. Callers can render the
    deterministic evidence either way.
    """
    try:
        if model_id is not None:
            model = validate_model_id(model_id)
        elif registry is not None and registry.available():
            model = registry.available()[0]
        else:
            model = ModelIdentity(model_id="darkfleet/template@1")
    except SummaryRejected as exc:
        return {"status": AI_UNAVAILABLE, "reason": str(exc)}

    try:
        adapter = (registry or SummariserRegistry())._adapters.get(model.model_id)
        if adapter is None:
            raw = render_template(evidence, model=model)
            untrusted = False
        else:
            payload = adapter.summarise(evidence)
            raw = json.loads(payload) if isinstance(payload, str) else payload
            untrusted = True
        doc = validate_document(raw, evidence=evidence, untrusted=untrusted)
    except SummaryRejected as exc:
        return {"status": AI_UNAVAILABLE, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 - the point is that nothing escapes
        return {
            "status": AI_UNAVAILABLE,
            "reason": f"narrative writer failed: {type(exc).__name__}: {exc}",
        }

    return {"status": "OK", "document": doc.to_dict()}


def language_violations(text: str) -> list[str]:
    """Standalone language guard, used by tests and by the UI copy review."""
    low = text.lower()
    return [w for w in FORBIDDEN if w in low]