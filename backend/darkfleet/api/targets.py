"""Wire contracts for scan detections (IR1 / Checkpoint B).

Why this module exists
----------------------
``ScanTargetsResponse.targets`` was typed ``list[dict[str, Any]]``. FastAPI
therefore validated *nothing* inside a detection, and the frontend declared
``classification`` while the backend emitted ``cls``. Measured against the
running container on 2026-10-02, a live target had ``cls='SAR_UNMATCHED'`` and
**no** ``classification`` key at all -- so the detection's class was ``undefined``
in every live render path. That is the single highest-severity defect the
integration audit found, and a hand-written mirror on both sides is what caused
it.

The fix is one declaration, validated on write, that both sides generate from:

* These models are the wire contract. They validate on construction, so a target
  missing a required measurement fails loudly at the boundary instead of
  arriving as a half-typed object.
* :mod:`tools.export_contract` reads the generated OpenAPI schema and emits
  ``src/api/contract.ts``. The frontend does not restate these shapes.
* ``classification`` is the canonical wire field. ``cls`` is accepted as an input
  alias because that is what the persisted record and the pipeline use internally
  -- the *record* format is not migrated here, only the wire. Output is always
  ``classification``.

Wire field names are unchanged everywhere else (``sarConf``, ``lenM``, ...), so
this is additive: existing consumers keep working and the one broken field starts
working.

Honesty constraints encoded in the types themselves:

* Every measurement is a real number or ``None``. Nothing is defaulted to a
  plausible-looking value. ``heading`` is ``None`` when the detector measured no
  heading, and ``None`` serialises to JSON ``null``, which the frontend must
  render as "not measured" rather than as 0 -- 0 degrees true is north, a real
  bearing.
* ``matched`` is a fact, not a confidence. With no association every other field
  is ``None``; a zero offset would be a measurement, and there is no measurement.
* No field asserts intent, threat, or identity. ``assessment`` is the backend's
  measured, evidence-bounded prose and is optional so its absence is explicit.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

#: The seven canonical classes. A Literal so an eighth class is a type error on
#: the backend and a compile error on the frontend, rather than a value that
#: quietly falls through every rendering branch.
Classification = Literal[
    "SAR_MATCHED_AIS",
    "SAR_UNMATCHED",
    "AIS_ONLY",
    "STATIONARY_OR_INFRASTRUCTURE",
    "SEA_CLUTTER",
    "LOW_CONFIDENCE",
    "UNRESOLVED",
]

CLASSIFICATION_VALUES: tuple[str, ...] = (
    "SAR_MATCHED_AIS",
    "SAR_UNMATCHED",
    "AIS_ONLY",
    "STATIONARY_OR_INFRASTRUCTURE",
    "SEA_CLUTTER",
    "LOW_CONFIDENCE",
    "UNRESOLVED",
)

Longitude = Annotated[float, Field(ge=-180.0, le=180.0)]
Latitude = Annotated[float, Field(ge=-90.0, le=90.0)]
Confidence = Annotated[float, Field(ge=0.0, le=1.0)]


class ScoreDecomposition(BaseModel):
    """The individual terms behind an association score.

    Present only when an association was evaluated. Every term is on the same
    0..1 scale so the weights are legible rather than implied, and
    ``matchRadiusMeters`` is the radius the match was tested against -- the
    single most useful number for judging whether a match was plausible.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    spatial_score: float = Field(alias="spatialScore")
    temporal_score: float = Field(alias="temporalScore")
    heading_score: float = Field(alias="headingScore")
    size_score: float = Field(alias="sizeScore")
    composite_score: float = Field(alias="compositeScore")
    match_radius_meters: float = Field(alias="matchRadiusMeters")
    distance_offset_meters: float = Field(alias="distanceOffsetMeters")
    time_delta_seconds: float = Field(alias="timeDeltaSeconds")


class RejectedCandidate(BaseModel):
    """The best AIS candidate that was considered and not accepted (GFST).

    Carries its score and how far short it fell, so the rejection can be
    arithmetic rather than assertion.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)

    mmsi: str
    vessel_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("vesselName", "vessel_name"),
        serialization_alias="vesselName",
    )
    score: Confidence = Field(ge=0.0, le=1.0)
    distance_meters: float = Field(
        ge=0.0, validation_alias=AliasChoices("distanceMeters", "distance_meters"),
        serialization_alias="distanceMeters",
    )
    time_delta_seconds: float = Field(
        validation_alias=AliasChoices("timeDeltaSeconds", "time_delta_seconds"),
        serialization_alias="timeDeltaSeconds",
    )
    shortfall: float = Field(
        ge=0.0,
        description="How far below the acceptance threshold this candidate scored.",
    )


class AisAssociation(BaseModel):
    """An association between one detection and one AIS observation."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        serialize_by_alias=True,
    )

    matched: bool
    mmsi: str | None = None
    vessel_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("vesselName", "vessel_name"),
        serialization_alias="vesselName",
    )
    distance_offset_meters: float | None = Field(
        default=None,
        validation_alias=AliasChoices("distanceOffsetMeters", "distance_offset_meters"),
        serialization_alias="distanceOffsetMeters",
    )
    time_delta_seconds: float | None = Field(
        default=None,
        validation_alias=AliasChoices("timeDeltaSeconds", "time_delta_seconds"),
        serialization_alias="timeDeltaSeconds",
    )
    predicted_lat: Latitude | None = Field(
        default=None,
        validation_alias=AliasChoices("predictedLat", "predicted_lat"),
        serialization_alias="predictedLat",
    )
    predicted_lon: Longitude | None = Field(
        default=None,
        validation_alias=AliasChoices("predictedLon", "predicted_lon"),
        serialization_alias="predictedLon",
    )
    ais_association_confidence: Confidence = Field(
        default=0.0,
        validation_alias=AliasChoices(
            "aisAssociationConfidence", "ais_association_confidence"
        ),
        serialization_alias="aisAssociationConfidence",
    )

    # ---- making the association decision inspectable (GFST) ----
    # Without these, "no association was accepted" is unfalsifiable: a reader
    # cannot distinguish an empty search from a near miss, and those are entirely
    # different findings. `closest_rejected` is what makes the decision
    # defensible to an analyst who has to explain it.
    candidates_considered: int = Field(
        default=0,
        ge=0,
        validation_alias=AliasChoices("candidatesConsidered", "candidates_considered"),
        serialization_alias="candidatesConsidered",
        description="AIS candidates evaluated for this detection, accepted or not.",
    )
    acceptance_threshold: Confidence = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        validation_alias=AliasChoices("acceptanceThreshold", "acceptance_threshold"),
        serialization_alias="acceptanceThreshold",
        description="Composite score a candidate needed to be accepted.",
    )
    closest_rejected: RejectedCandidate | None = Field(
        default=None,
        validation_alias=AliasChoices("closestRejected", "closest_rejected"),
        serialization_alias="closestRejected",
        description=(
            "Best candidate that was NOT accepted. Null means the search found "
            "nothing at all, which is a different finding from a near miss."
        ),
    )
    score_decomposition: ScoreDecomposition | None = Field(
        default=None,
        validation_alias=AliasChoices("scoreDecomposition", "score_decomposition"),
        serialization_alias="scoreDecomposition",
    )

    @field_validator("mmsi", "vessel_name", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        # Providers routinely send "" for "no name". That is absence, not a name.
        return None if value == "" else value

    @field_validator(
        "distance_offset_meters",
        "time_delta_seconds",
        "predicted_lat",
        "predicted_lon",
        mode="after",
    )
    @classmethod
    def _non_finite_is_absent(cls, value: object) -> object:
        # A NaN offset would serialise as invalid JSON or as `NaN`, which parses
        # as a number in JS. Absence is the only honest representation.
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value


class WakeEvidence(BaseModel):
    """What the wake detector measured, and how strongly.

    A wake result is EVIDENCE, not a finding. Every field here is a measurement or
    a statement about the measurement, and the epistemics are deliberate:

    ``confidence``
        Bounded evidence strength, never P(wake). It saturates because a stronger
        arm does not make the geometry more certain, only the contrast evidence
        stronger. It must never be rendered as a probability.

    ``heading_deg`` / ``wake_direction_deg``
        Populated ONLY by a detection. A non-detection leaves them null so no
        surface can draw a wake axis the detector did not observe -- a centroid
        and a heading are different quantities and neither implies the other.

    ``notes``
        Never empty. "Not analysed" and "analysed, found nothing" must stay
        distinguishable, and a caller cannot separate them if the reason is blank.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)

    detected: bool
    #: Evidence strength in 0..1. NOT a probability of a wake.
    confidence: float = Field(ge=0.0, le=1.0)
    heading_deg: float | None = None
    wake_direction_deg: float | None = None
    #: Apparent wake length in METRES. Null unless detected.
    apparent_length_m: float | None = None
    #: Measured angle between the observed wake axis and the hull axis, folded to
    #: 0..180. READ THE CONVENTION BEFORE COMPARING IT.
    #:
    #: This is a directed difference folded to a half-turn, NOT an undirected
    #: line angle, and NOT a physical arm separation. Because a wake trails
    #: astern while the hull axis points forward, a genuine Kelvin wake with arms
    #: at the classical ~19.5 deg to the track reports roughly ``180 - 19.5 =
    #: 160.5`` here. Values in the 149-158 deg band are therefore consistent with
    #: real Kelvin geometry rather than contradicting it.
    #:
    #: To compare against the Kelvin cusp angle, fold it:
    #: ``arm_angle_line_deg`` is that value, and ``sar.wake.axial_delta_deg`` is
    #: the function that computes it. Comparing this field directly to 19.5 is a
    #: units error.
    arm_angle_deg: float | None = None
    #: The same measurement as an UNDIRECTED line angle, 0..90 degrees. This is the
    #: field to compare against a Kelvin cusp angle. Null unless the arm pair was
    #: actually measured.
    arm_angle_line_deg: float | None = None
    #: The analysis method, so a reader knows what was actually run.
    method: str
    #: Why this result, in the detector's own words. Never empty.
    notes: str


class VesselTarget(BaseModel):
    """One SAR detection, correlated or not."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        serialize_by_alias=True,
    )

    id: str

    #: The field that was silently broken. Input accepts ``cls`` (what the record
    #: holds) or ``classification``; output is always ``classification``.
    classification: Classification = Field(
        validation_alias=AliasChoices("classification", "cls"),
        serialization_alias="classification",
    )

    lat: Latitude
    lon: Longitude

    #: GEO-CORR's sub-pixel centroid in the window raster: [col, row].
    #:
    #: The analytical anchor for a detection: what makes the target mappable onto
    #: the raster it came from, and what lets the coordinate above be re-derived
    #: rather than merely trusted. Measured by ``geolocate_components`` and then
    #: dropped by correlation's explicit field list, so the raster-to-target link
    #: existed only positionally.
    #:
    #: Nullable, not defaulted: a target whose centroid was never measured must say
    #: so rather than reporting (0, 0), which would place it at the raster corner.
    geo_pixel_centroid: list[float] | None = Field(
        default=None,
        validation_alias=AliasChoices("geo_pixel_centroid", "geoPixelCentroid"),
        serialization_alias="geoPixelCentroid",
        description="Sub-pixel [col, row] centroid in the window raster; null when unmeasured.",
    )
    #: The sample-index to sample-centre offset that produced the coordinate.
    #: 0.5 means pixel CENTRE -- the convention rasterio calls ``offset='center'``.
    #: Carried so a reader can reproduce the conversion rather than assume it.
    geo_centre_offset: float | None = Field(
        default=None,
        validation_alias=AliasChoices("geo_centre_offset", "geoCentreOffset"),
        serialization_alias="geoCentreOffset",
        description="Pixel-centre offset applied by the geolocation authority.",
    )

    #: MEASURED wake evidence from ``sar.wake.analyse_wake``.
    #:
    #: Deliberately separate from the legacy ``wake`` boolean. ``wake`` is the
    #: six-point hull-axis threshold sampler and is what correlation reads, so no
    #: classification, association or confidence moves because this field exists.
    #: This is the real detector: a 360-degree ray sweep with a symmetric arm-pair
    #: search, reporting what it measured and why.
    #:
    #: Nullable because a scan run before the detector was wired has none. That is
    #: "not analysed", which is a different statement from "analysed, found
    #: nothing", and a surface has to be able to tell them apart.
    wake_analysis: WakeEvidence | None = Field(
        default=None,
        validation_alias=AliasChoices("wakeAnalysis", "wake_analysis"),
        serialization_alias="wakeAnalysis",
        description="Measured wake evidence; null when the detector never ran for this target.",
    )

    #: SAR detection confidence, 0..1. Never None: the detector always produced a
    #: score, and a detection without one would not be a detection.
    sar_conf: Confidence = Field(alias="sarConf")
    #: AIS association confidence. Exactly 0.0 when no association exists.
    #:
    #: Required, not defaulted. The pipeline emits this key on every detection, and
    #: a default here would make the generated TypeScript mark it optional -- which
    #: is how a consumer ends up writing `aisConf ?? 0` and rendering a fabricated
    #: zero confidence for a target the backend did score.
    ais_conf: Confidence = Field(alias="aisConf")

    #: Apparent SAR footprint in metres. NOT a vessel length: SAR resolves a bright
    #: return whose extent depends on heading, sea state and sidelobes.
    len_m: float = Field(alias="lenM")
    wid_m: float = Field(alias="widM")
    #: Explicit uncertainty on the apparent footprint. Never dropped and never
    #: zero, so no consumer can draw a confident circle the detector did not earn.
    len_unc_m: float = Field(alias="lenUncM")

    #: Heading estimate in degrees true. Required-but-nullable: the key is always
    #: present, and ``None`` means "no heading measured". Never 0 for that case,
    #: since 0 degrees true is north, a real bearing.
    hdg: float | None

    #: Wake flag. Required even when false, so a consumer can tell "measured, no
    #: wake" from "not analysed".
    wake: bool

    #: Backscatter statistics in dB, measured on the calibrated product.
    mean_db: float = Field(alias="meanDb")
    max_db: float = Field(alias="maxDb")
    area: float

    corr: AisAssociation
    assessment: str | None
    tags: list[str]


class ScanScene(BaseModel):
    """The SAR scene a scan actually read.

    Declared rather than passed through as ``dict[str, Any]``. The pipeline
    records these measured values (``darkfleet.pipeline`` builds this dict), so
    they are facts about an acquisition, not free-form metadata -- and a
    consumer that has to read ``scene.item_id`` or ``scene.polarization`` cannot
    do so safely against an untyped object.

    ``asset_href`` is included because it is in the record and the evidence
    panel shows the exact source. It is a provider URL that may carry a signed
    query string; the frontend must never render it as a clickable link.
    """

    model_config = ConfigDict(extra="allow")

    provider: str = ""
    collection: str = ""
    item_id: str = ""
    platform: str = ""
    acquisition_time: str = ""
    product: str = ""
    polarization: str = ""
    asset_href: str = ""
    #: Present when the raster carried affine georeferencing. None when the record
    #: did not measure it, which is different from measuring zero.
    crs: str | None = None
    resolution_m: float | None = None


class AisOnlyTarget(BaseModel):
    """An AIS observation with no corresponding SAR detection.

    A vessel transmitting with nothing in the radar image beside it. That is an
    open question, not a finding of concealment: SAR coverage, incidence angle and
    detection threshold all affect it.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        serialize_by_alias=True,
    )

    cls: Literal["AIS_ONLY"] = "AIS_ONLY"
    mmsi: str
    vessel_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("vesselName", "vessel_name"),
        serialization_alias="vesselName",
    )
    lat: Latitude
    lon: Longitude
    timestamp: str
