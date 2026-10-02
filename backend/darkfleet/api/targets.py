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
