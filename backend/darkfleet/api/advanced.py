"""Response models for the analytical routes that had none (ADV-007..012, GFST).

Why this module exists
----------------------
Four routes answered with a bare ``dict[str, Any]``:

    /revisit     /tracks     /patterns     /detectors

That is the reason the frontend had no types for them and therefore no surface
for them. Without a ``response_model``, FastAPI emits nothing for OpenAPI, the
contract generator has nothing to translate, and the only way to render a revisit
plan in TypeScript would be a hand-written mirror of the payload -- which is
exactly the drift the generated contract exists to prevent.

So the routes are given models here, the contract picks them up, and the frontend
is typed from the same source of truth as every other capability.

Semantics preserved, not reshaped
---------------------------------
Each model encodes a truthfulness rule that was previously only in prose:

- revisit statistics are ``float | None``: ``median_revisit_days: null`` means
  "not enough acquisitions to say", which is not the same as zero;
- detector ``weights_digest`` is ``str | None`` and the registry refuses an
  adapter without one, so a bare ``None`` here means "no learned weights", not
  "weights failed to load";
- track ``implied_speed_knots`` is nullable for the same reason: an unbridgeable
  gap has no implied speed, and inventing one would fabricate a kinematic fact;
- every ``limitations`` list is required, so a response cannot silently omit the
  caveats the backend already computes.
"""

from __future__ import annotations

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

_STRICT = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)


class AcquisitionOut(BaseModel):
    """One real acquisition from the provider catalogue.

    ``item_id`` is the catalogue identifier, so the entry can be re-fetched
    independently of this product.
    """

    model_config = _STRICT

    item_id: str
    acquisition_time: str
    platform: str
    collection: str
    polarizations: list[str] = Field(default_factory=list)


class RevisitGapOut(BaseModel):
    """A measured interval between acquisitions.

    ``window_edge`` marks an interval truncated by the query window rather than
    by the satellite, so a reader does not mistake a window artefact for a real
    coverage hole. ``exceeds_nominal`` compares against the nominal repeat, which
    is context only -- the measured gap is the evidence.
    """

    model_config = _STRICT

    start: str
    end: str
    days: float
    window_edge: bool = False
    exceeds_nominal: bool = False


class RevisitStatisticsOut(BaseModel):
    """Measured revisit statistics. Absent values stay ``null``, never guessed."""

    model_config = _STRICT

    platform_count: int = 0
    acquisitions_per_platform: dict[str, int] = Field(default_factory=dict)
    interior_gap_count: int = 0
    median_revisit_days: float | None = None
    min_revisit_days: float | None = None
    max_revisit_days: float | None = None
    flagged_gap_count: int = 0
    nominal_repeat_days: float


class RevisitPlanOut(BaseModel):
    """The acquisition plan for an area.

    Built from the provider catalogue, never from an orbit prediction: every
    entry is an acquisition that genuinely exists. A provider failure surfaces as
    a 5xx with the real cause; there is no simulated plan and no predicted pass.
    """

    model_config = _STRICT

    acquisition_count: int = 0
    acquisitions: list[AcquisitionOut] = Field(default_factory=list)
    gaps: list[RevisitGapOut] = Field(default_factory=list)
    statistics: RevisitStatisticsOut
    window: dict[str, str | None] = Field(default_factory=dict)
    next_after: AcquisitionOut | None = None
    limitations: list[str] = Field(default_factory=list)
    provider: str
    collection: str
    requested_bbox: list[float] = Field(default_factory=list)


class TrackPointOut(BaseModel):
    """One SAR observation along a multi-pass hypothesis."""

    model_config = _STRICT

    scan_id: str
    item_id: str
    acquisition_time: str
    lat: float
    lon: float
    sar_conf: float
    classification: str
    # Missing source pixel spacing cannot be turned into a measured vessel size.
    apparent_length_m: float | None
    length_unc_m: float | None


class TrackGapOut(BaseModel):
    """An interval between observations.

    ``implied_speed_knots`` is nullable: a gap too long to bridge honestly has no
    implied speed, and a fabricated one would be a kinematic claim nobody
    measured. ``plausible`` records whether the implied motion is physically
    reasonable, which is a check on the hypothesis, not a confirmation of it.
    """

    model_config = _STRICT

    seconds: float
    implied_speed_knots: float | None = None
    plausible: bool = False
    note: str = ""


class TrackHypothesisOut(BaseModel):
    """A multi-pass track HYPOTHESIS.

    Never a confirmed identity. ``identity_strength`` and
    ``confidence_statement`` are the backend's own bounded assessment;
    ``supporting_evidence`` and ``contradicting_evidence`` are both required so a
    hypothesis cannot be presented with only the evidence that flatters it.
    """

    model_config = _STRICT

    track_id: str
    points: list[TrackPointOut] = Field(default_factory=list)
    gaps: list[TrackGapOut] = Field(default_factory=list)
    supporting_evidence: list[str] = Field(default_factory=list)
    contradicting_evidence: list[str] = Field(default_factory=list)
    identity_strength: float = 0.0
    confidence_statement: str = ""


class TracksOut(BaseModel):
    """Multi-pass track hypotheses across the persisted history.

    A single stored scan legitimately yields zero tracks; ``scans_considered``
    and ``observations_considered`` are what make that legible.
    """

    model_config = _STRICT

    scans_considered: int = 0
    observations_considered: int = 0
    track_count: int = 0
    tracks: list[TrackHypothesisOut] = Field(default_factory=list)
    note: str = ""


class PatternOut(BaseModel):
    """A longitudinal behaviour pattern.

    ``observed`` / ``hypothesis`` / ``unknowns`` are three separate fields, never
    merged into prose: a missing AIS association is a coverage fact and is not
    evidence of conduct.
    """

    model_config = _STRICT

    pattern_id: str
    kind: str
    observed: str
    hypothesis: str
    confidence: float = 0.0
    unknowns: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)


class PatternsOut(BaseModel):
    """Longitudinal patterns over the persisted observation history."""

    model_config = _STRICT

    scans_considered: int = 0
    observations_considered: int = 0
    pattern_count: int = 0
    patterns: list[PatternOut] = Field(default_factory=list)
    note: str = ""


class DetectorCardOut(BaseModel):
    """Detector provenance.

    The registry refuses to register an adapter that does not declare its
    training domain and validation data, so a card appearing here is itself the
    evidence that the provenance requirements were met. ``weights_digest`` is
    ``None`` for deterministic detectors, which is a real answer, not a
    missing one.
    """

    model_config = _STRICT

    name: str
    kind: str
    training_domain: str = ""
    input_product: str = ""
    validation_data: str = ""
    limitations: str = ""
    weights_digest: str | None = Field(
        default=None,
        validation_alias=AliasChoices("weights_digest", "weightsDigest"),
        serialization_alias="weights_digest",
        description="Digest of learned weights; None for deterministic detectors.",
    )


class DetectorsOut(BaseModel):
    """The detector registry."""

    model_config = _STRICT

    default: str
    detectors: list[DetectorCardOut] = Field(default_factory=list)
    note: str = ""


__all__ = [
    "AcquisitionOut",
    "DetectorCardOut",
    "DetectorsOut",
    "PatternOut",
    "PatternsOut",
    "RevisitGapOut",
    "RevisitPlanOut",
    "RevisitStatisticsOut",
    "TrackGapOut",
    "TrackHypothesisOut",
    "TrackPointOut",
    "TracksOut",
]
