"""Wire contracts for the per-target evidence document (EVD).

Why this module exists
----------------------
Three routes serve an evidence document and all three handed the browser an
unvalidated object: ``/targets/{id}`` and ``/targets/{id}/summary`` declared
``dict[str, Any]``, and the summary's model was ``extra="allow"`` with
``dict[str, Any]`` nested blocks. Nothing validated anything inside the document,
so the exact failure this repository has already paid for twice shipped again:
the ``cls``/``classification`` drift was invisible because a field that was
declared nowhere could not be checked against anything.

The document is the analytical record an analyst is asked to defend, and it
makes claims whose truth value depends on distinctions an untyped dict cannot
hold:

* ``ghost_vessel.designation`` ("GHOST VESSEL") is a product label while
  ``ghost_vessel.analytical_classification`` ("SAR_UNMATCHED") is the
  correlation outcome. Merging them would make a correlation result read as a
  finding about intent, which is precisely the inference
  :mod:`darkfleet.ghost_vessel` exists to forbid. The two are separate fields
  here and a validator refuses a payload where they have collapsed into one.
* A null association field means *the source did not report this*. Coercing it
  to ``0`` would claim a zero-metre offset or a 0-degree bearing -- both real,
  both wrong, and 0 degrees true is north. Every one of those fields is
  nullable and required-but-null: the key is always present so a caller can
  tell "reported as absent" from "not reported on".
* ``altitude_measured`` is typed ``Literal[False]``. SAR is a two-dimensional
  sensor; a boolean would let a future payload carry ``true`` through a
  consumer that has already learned to render an inferred height.

Design constraints
------------------
* ``extra="forbid"`` everywhere. :func:`darkfleet.evidence.target_evidence`
  still returns a plain dict -- many tests consume it that way -- so the model
  is the boundary check, and a builder key that no model declares becomes a
  loud failure instead of a silently invisible field.
  ``test_evidence_document_contract.py`` proves the builder and the models agree
  against the real pipeline output, so forbidding cannot become a 500.
* Where a shape is genuinely not this repository's to fix, the field stays open
  and says so: ``sar_chip`` (no producer exists anywhere in the codebase), the
  stored record's ``targets`` (the pipeline's internal record form, which is not
  the wire form) and its ``debug.columns`` (column names for the debug tables).
  Those are the only concessions, and each is documented at its declaration.
* ``/evidence/{id}`` does NOT serve this document. It serves the persisted scan
  record, which is a different shape with a different name; ``ScanRecordDocument``
  below types it so the difference is declared rather than assumed.
* Nothing here re-implements pipeline logic. These models describe what
  :mod:`darkfleet.evidence` and :func:`darkfleet.pipeline.run_scan` emit; they
  never compute it.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..ghost_vessel import GHOST_CLASSIFICATION, GHOST_LABEL
from .targets import (
    AisOnlyTarget,
    Classification,
    Confidence,
    Latitude,
    Longitude,
    RejectedCandidate,
    ScanScene,
    ScoreDecomposition,
)

__all__ = [
    "AisProvenance",
    "AssociationEvidence",
    "CfarSettings",
    "DebugCacheInputs",
    "EvidenceBullet",
    "EvidenceDocument",
    "EvidenceProvenance",
    "GhostAssociationDecision",
    "GhostObservedEvidence",
    "GhostVesselDossier",
    "GhostVesselNotApplicable",
    "LandMaskProvenance",
    "MarineRegionContext",
    "MarineRegionsProvenance",
    "MatchingSettings",
    "ObservedEvidence",
    "ObservedPosition",
    "PredictedPosition",
    "ProcessingProvenance",
    "SarProvenance",
    "ScanConfigRecord",
    "ScanDebugBlock",
    "ScanRecordDocument",
    "SpeckleSettings",
    "UncertaintyEvidence",
    "VerticalDatumContext",
]


# --------------------------------------------------------------- leaf blocks


class EvidenceBullet(BaseModel):
    """One hypothesis or one unknown.

    A bare string would lose the block each belongs to. `{"text": ...}` keeps
    ``hypotheses`` and ``unknowns`` structurally separate even as they render
    as two lists of sentences, so a UI cannot concatenate them into one
    paragraph and lose the reader's ability to see which claim was measured and
    which was only suggested.
    """

    model_config = ConfigDict(extra="forbid")

    text: str


class MarineRegionContext(BaseModel):
    """Which water body a position is in (GEO-001).

    ``kind`` is the field a consumer branches on, because the other four cannot
    be read without it: a surveyed ``named_region`` and a coarse ``open_ocean``
    basin both populate ``basin``, and presenting the second as the first would
    be presenting a longitude-band convention as a survey.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["named_region", "open_ocean", "unresolved", "invalid_position"]
    #: Every matching name, most specific first. Empty is an ordinary answer.
    named_regions: list[str]
    primary: str | None
    basin: str | None
    note: str | None


class VerticalDatumContext(BaseModel):
    """The datum every height on this record would be measured from (GEO-003).

    ``altitude_measured`` is ``Literal[False]`` and not ``bool``. The builder
    cannot currently produce ``True``, so widening the type would only ever be
    used to weaken the guarantee: a consumer that has learned to read
    ``undulation_available`` and ignore ``undulation_m`` when no grid is
    installed should not have to re-derive that SAR measures no altitude. A
    future altimetry source becomes a schema change, which is the point.
    """

    model_config = ConfigDict(extra="forbid")

    geoid_model: str
    ellipsoid: str
    #: Null whenever no undulation grid is installed. Never substituted with
    #: zero: an assumed N is exactly the error this block exists to prevent,
    #: and its sign flips across the world.
    undulation_m: float | None
    undulation_available: bool
    altitude_measured: Literal[False]
    note: str


class ApparentFootprint(BaseModel):
    """Apparent SAR extent in metres. NOT a vessel length.

    SAR resolves a bright return whose extent depends on heading, sea state and
    sidelobes, so the field is named for what it is. Shared by the top-level
    and Ghost Vessel observation blocks because it is the same measurement
    under two names (``wake_evident`` vs ``wake_detected`` are NOT -- those are
    different claims and are modelled separately).
    """

    model_config = ConfigDict(extra="forbid")

    length: float
    width: float


# ------------------------------------------------------- observed / position


class ObservedPosition(BaseModel):
    """Where the detection is, as geography rather than as a coordinate pair."""

    model_config = ConfigDict(extra="forbid")

    lat: Latitude
    lon: Longitude
    marine_region: MarineRegionContext
    vertical_datum: VerticalDatumContext


class PredictedPosition(BaseModel):
    """An AIS position propagated to acquisition time by dead reckoning.

    Present only when the source reported one. The builder emits this block
    only when a predicted latitude exists and correlation writes both members
    together, so a half-populated position is not representable -- an
    un-propagated longitude is absence, not 0.
    """

    model_config = ConfigDict(extra="forbid")

    lat: Latitude
    lon: Longitude


class ObservedEvidence(BaseModel):
    """The top-level ``observed`` block: what the radar actually measured.

    Deliberately holds no hypothesis. Every value here is a measurement or an
    explicit statement that the detector ran and found nothing, which is what
    lets a reader skim this block without wondering which clause was measured.
    """

    model_config = ConfigDict(extra="forbid")

    position: ObservedPosition
    apparent_footprint_m: ApparentFootprint
    #: Degrees true. Null means no heading was measured, and 0 degrees true is
    #: north -- a real bearing -- so this is never defaulted.
    orientation_deg: float | None
    mean_backscatter_db: float
    max_backscatter_db: float
    pixel_area: float
    #: The legacy six-point hull-axis threshold flag. Not the wake *detector*:
    #: see :class:`GhostObservedEvidence`, whose ``wake_detected`` comes from
    #: the 360-degree ray sweep. The two names differ because the two
    #: measurements differ, and merging them would let one detector's silence
    #: render as the other's finding.
    wake_evident: bool | None
    sar_detection_confidence: Confidence


class UncertaintyEvidence(BaseModel):
    """What is not known about this detection, stated.

    ``propagation_note`` is always populated even for a perfectly matched
    target, because dead reckoning was applied regardless of the outcome.
    """

    model_config = ConfigDict(extra="forbid")

    length_uncertainty_m: float
    #: Null when no association was evaluated, so a caller cannot report the
    #: search radius of a search that never ran.
    match_radius_m: float | None
    propagation_note: str


# ---------------------------------------------------------------- association


class AssociationEvidence(BaseModel):
    """The AIS association, with absence preserved.

    Every field except the confidence is nullable and every one of them means
    "the source did not report this". None of them may be rendered as 0, as
    "0 kn", or as "000deg": a zero offset is a measurement of zero separation
    and a zero bearing is north, and the difference between "not measured" and
    "measured as zero" is the whole point of the association block.

    They are required-but-nullable rather than defaulted so the generated
    TypeScript marks them present, which stops a consumer writing
    ``?? 0`` -- the exact coercion this type exists to make impossible.
    """

    model_config = ConfigDict(extra="forbid")

    mmsi: str | None
    vessel_name: str | None
    distance_offset_m: float | None
    time_delta_s: float | None
    predicted_position: PredictedPosition | None
    ais_association_confidence: Confidence
    #: The arithmetic behind the score. Reused from
    #: :class:`darkfleet.api.targets.ScoreDecomposition` rather than restated:
    #: two models for one shape would be two truths, and DF-X6C already pins
    #: this one.
    score_decomposition: ScoreDecomposition | None


# ------------------------------------------------------------- ghost vessel


class GhostObservedPosition(BaseModel):
    """Ghost Vessel position: the pair only, no region or datum context.

    Nullable per member because ``assess`` reads the target with ``.get``. The
    full geography and datum context lives on the top-level ``observed``; a
    Ghost Vessel dossier repeats the coordinate so it can be read alone, and
    this block is not a second source of geography.
    """

    model_config = ConfigDict(extra="forbid")

    lat: Latitude | None
    lon: Longitude | None


class GhostObservedEvidence(BaseModel):
    """The Ghost Vessel variant of the observation block.

    A DISTINCT type from :class:`ObservedEvidence`, not a subclass. Three
    differences make merging them impossible to do honestly:

    * ``marine_region`` is a readable phrase here and a structured block
      (:class:`MarineRegionContext`) at top level. One answers "where", the
      other answers "which water body, and how confident are we that we know".
    * ``wake_detected`` is the ray-sweep detector's answer;
      ``wake_evident`` is the legacy threshold flag's. Same word, two
      measurements.
    * ``polarization_evidence`` and ``multipass_evidence`` exist only here,
      because only the Ghost Vessel dossier states what analysis was and was
      not available.
    """

    model_config = ConfigDict(extra="forbid")

    target_id: str | None
    position: GhostObservedPosition
    marine_region: str | None
    sar_detection_confidence: Confidence | None
    apparent_footprint_m: ApparentFootprint
    length_uncertainty_m: float | None
    orientation_deg: float | None
    mean_backscatter_db: float | None
    max_backscatter_db: float | None
    wake_detected: bool | None
    #: Null means the channel produced no note for this target, NOT that it
    #: ran and found nothing -- the two are different findings and only the
    #: channel can tell them apart.
    polarization_evidence: str | None
    multipass_evidence: str | None


class GhostAssociationDecision(BaseModel):
    """Why no association was accepted, in arithmetic (GFST).

    ``closest_rejected_candidate`` null means the search found nothing at all,
    which is a DIFFERENT finding from a near miss. Collapsing the two is what
    makes "no association was found" unfalsifiable.
    """

    model_config = ConfigDict(extra="forbid")

    candidates_considered: int | None = Field(ge=0)
    acceptance_threshold: Confidence | None
    closest_rejected_candidate: RejectedCandidate | None
    reason_no_association: str
    ais_association_confidence: Confidence | None
    #: "NOT_ESTABLISHED" when no coverage source could speak to this position.
    #: A named absence, never an empty string.
    ais_coverage_state: str
    score_decomposition: ScoreDecomposition | None


class GhostVesselDossier(BaseModel):
    """A target that qualifies as a Ghost Vessel.

    ``designation`` and ``analytical_classification`` are two fields and stay
    two fields. ``designation`` is the product label a reader sees;
    ``analytical_classification`` is the correlation outcome, which is all the
    evidence supports. The validator below refuses a payload in which the label
    has replaced the class, because that substitution is what turns a
    correlation result into an accusation.
    """

    model_config = ConfigDict(extra="forbid")

    is_ghost_vessel: Literal[True]
    designation: str
    analytical_classification: str
    #: Rendered unmissably on every Ghost Vessel surface. Never omitted: a
    #: dossier without it reads as a finding rather than as an absence of one.
    semantic_warning: str
    observed: GhostObservedEvidence
    decision: GhostAssociationDecision
    hypotheses: list[EvidenceBullet]
    unknowns: list[EvidenceBullet]

    @model_validator(mode="after")
    def _designation_never_replaces_the_class(self) -> GhostVesselDossier:
        """The product label and the analytical class must stay distinct.

        ``GHOST VESSEL`` is what we call it; ``SAR_UNMATCHED`` is what the
        correlation established. If the two ever hold the same string, one of
        them has been overwritten and every surface that renders the pair has
        silently lost the distinction the whole designation rests on. Rejecting
        is the only honest response -- the payload is not renderable as it
        stands.
        """
        if self.designation == self.analytical_classification:
            raise ValueError(
                "ghost_vessel.designation and ghost_vessel.analytical_classification "
                "must differ; the designation is a product label and the analytical "
                "classification is the correlation outcome"
            )
        if self.analytical_classification != GHOST_CLASSIFICATION:
            raise ValueError(
                f"a Ghost Vessel dossier must carry the analytical class "
                f"{GHOST_CLASSIFICATION!r}, got {self.analytical_classification!r}"
            )
        if self.designation != GHOST_LABEL:
            raise ValueError(
                f"ghost_vessel.desification must be {GHOST_LABEL!r}, "
                f"got {self.designation!r}"
            )
        return self


class GhostVesselNotApplicable(BaseModel):
    """The stub emitted for every target that is not a Ghost Vessel.

    Present rather than omitted. Omission would read as "not examined", and the
    assessment WAS performed -- it concluded that the designation does not
    apply. ``analytical_classification`` still carries the real class, so this
    stub is a statement rather than a hole.
    """

    model_config = ConfigDict(extra="forbid")

    is_ghost_vessel: Literal[False]
    #: Structurally impossible to be anything else. A non-Ghost target must not
    #: acquire the designation by accident, and a ``str | None`` here would let
    #: it.
    designation: None
    analytical_classification: str


# ------------------------------------------------------------- the document


class EvidenceDocument(BaseModel):
    """:func:`darkfleet.evidence.target_evidence` output, as a wire contract.

    The top-level ``hypotheses``/``unknowns`` are required and always
    populated by the builder -- for a non-Ghost target they carry an explicit
    "no hypotheses are raised for this classification" statement and the
    generic unknowns rather than an empty list. An empty block here would mean
    "nothing found"; a missing key would mean "not examined", and the builder
    never emits the second. Required-but-possibly-empty keeps them apart.
    """

    model_config = ConfigDict(extra="forbid")

    target_id: str
    classification: Classification
    #: Sits ABOVE the analytical class on every surface and never replaces it.
    #: Null for every class that is not a Ghost Vessel.
    designation: str | None
    ghost_vessel: GhostVesselDossier | GhostVesselNotApplicable
    observed: ObservedEvidence
    uncertainty: UncertaintyEvidence
    association: AssociationEvidence
    #: The backend's evidence-bounded prose, or null when it wrote none. Not
    #: defaulted to "": an empty string reads as a rendered assessment.
    summary: str | None
    tags: list[str]
    hypotheses: list[EvidenceBullet]
    unknowns: list[EvidenceBullet]
    #: Open on purpose, and this is the one place where the builder hands the API
    #: a shape it did not create. ``target_evidence`` takes the chip as an
    #: argument, and NO producer for it exists in this codebase: ``/targets/{id}``
    #: passes None, and ``/targets/{id}/summary`` passes a target field no
    #: pipeline stage sets. Declaring fields here would be inventing a contract
    #: for a document that does not exist yet, and a wrong declaration is worse
    #: than an open block -- the first real chip would fail validation for a
    #: reason nobody could reconstruct. The day a producer exists, it gets its
    #: own model here and this comment goes.
    sar_chip: dict[str, Any] | None
    #: The owning scan's reproducibility block, or null when the record carried
    #: none. Nullable rather than required because the route that serves this
    #: document explicitly tolerates a record with no provenance -- and a record
    #: that cannot say how it was produced must render as an absent audit trail,
    #: not as an invented empty one. Declared once and reused by
    #: :class:`ScanRecordDocument` rather than mirrored, so the two documents
    #: cannot describe the same block differently.
    provenance: EvidenceProvenance | None


# --------------------------------------------------------------- provenance


class MarineRegionsProvenance(BaseModel):
    """Attribution for the Natural Earth marine polygons (GEO-001).

    Public domain, so no attribution duty is created -- but the source commit
    is recorded, because an answer that cannot be reproduced is not evidence.
    """

    model_config = ConfigDict(extra="forbid")

    dataset: str
    layer: str
    license: str
    attribution_required: bool
    credit: str
    source_commit: str | None
    fetched: str | None
    feature_count: int = Field(ge=0)
    #: Regions the upstream pack dropped, carried forward rather than hidden.
    known_absent: list[str]


class SarProvenance(BaseModel):
    """The acquisition that was actually read.

    ``transform`` and ``raster_window`` are nullable rather than defaulted: the
    read window's affine is what GEO-CORR measured against, and a record that
    did not measure it must say so instead of reporting the identity affine,
    which would silently place every pixel at the raster origin.
    """

    model_config = ConfigDict(extra="forbid")

    provider: str
    collection: str
    item_id: str
    platform: str
    acquisition_time: str
    product: str
    polarization: str
    #: A provider URL that may carry a signed query string. Never render it as
    #: a clickable link.
    asset_href: str
    crs: str | None
    transform: list[float] | None
    resolution_m: float | None
    raster_window: list[int] | None


class CfarSettings(BaseModel):
    """The detector settings that produced the detections in this record."""

    model_config = ConfigDict(extra="forbid")

    training_cells: int = Field(ge=8, le=32)
    guard_cells: int = Field(ge=2, le=8)
    threshold_factor: float = Field(ge=2.0, le=5.5)
    min_pixels: int = Field(ge=1, le=50)
    max_pixels: int = Field(ge=100, le=5000)


class SpeckleSettings(BaseModel):
    """Pre-detection speckle filter settings."""

    model_config = ConfigDict(extra="forbid")

    mode: str
    kernel: int


class LandMaskProvenance(BaseModel):
    """Which land/water mask excluded detections from this window.

    ``port_exceptions`` is a count rather than a list: the reader needs to know
    ports were carved and how many, not to re-derive the coastline.
    """

    model_config = ConfigDict(extra="forbid")

    source: str
    water_href: str
    water_class: int
    coastline_buffer_m: int
    port_exceptions: int = Field(ge=0)
    # Earlier persisted scans predate fail-closed handling of unknown WorldCover
    # pixels. Keep those records readable without inventing a policy or an
    # unknown-pixel count that they never recorded.
    nodata_policy: Literal["EXCLUDED_UNKNOWN_NOT_WATER"] | None = None
    unknown_fraction: float | None = Field(default=None, ge=0.0, le=1.0)


class ProcessingProvenance(BaseModel):
    """Everything that determined the pixels the detector saw.

    Grouped under one model so a consumer asking "what was done to this image
    before detection" reads one block instead of reaching three.
    """

    model_config = ConfigDict(extra="forbid")

    config_hash: str
    land_mask: LandMaskProvenance
    speckle: SpeckleSettings
    cfar: CfarSettings


class AisProvenance(BaseModel):
    """Which AIS source the correlation consulted."""

    model_config = ConfigDict(extra="forbid")

    provider: str


class MatchingSettings(BaseModel):
    """The correlation weights and threshold in force for this record.

    Declared because a score without its weights is not reproducible, and
    "reproducible" is the property the whole provenance block exists for.
    """

    model_config = ConfigDict(extra="forbid")

    weights: list[float]
    min_score: Confidence
    window_s: int = Field(ge=0)


class EvidenceProvenance(BaseModel):
    """:func:`darkfleet.evidence.build_provenance` output.

    Strict at every level, because this block is a fixed literal in one
    function plus one fixed literal per subordinate authority
    (:mod:`darkfleet.marine`, :mod:`darkfleet.sar.landmask`). Every sub-block
    is a named model rather than a passthrough so a key that disappears from a
    subordinate authority fails the contract instead of vanishing from a record
    an analyst is citing.
    """

    model_config = ConfigDict(extra="forbid")

    software_version: str
    processing_version: str
    classification_schema: str
    recorded_at: str
    runtime_mode: str
    synthetic: bool
    marine_regions: MarineRegionsProvenance
    sar: SarProvenance
    aoi: list[float]
    processing: ProcessingProvenance
    ais: AisProvenance
    matching: MatchingSettings


# ------------------------------------------------------- the stored record


class ScanConfigRecord(BaseModel):
    """The CA-CFAR configuration a stored record was produced with.

    The hash travels with the settings it was computed from, so a consumer can
    tell "same configuration" from "same-looking configuration".
    """

    model_config = ConfigDict(extra="forbid")

    config_hash: str
    training_cells: int
    guard_cells: int
    threshold_factor: float
    coastline_buffer_meters: int
    speckle_filter: str
    kernel_size: int
    min_pixels: int
    max_pixels: int


class DebugCacheInputs(BaseModel):
    """The four inputs that define an artifact-cache key.

    Recorded so a debug read can rebuild the key without guessing, and so a
    consumer can tell "the same acquisition" from "the same coordinates".
    """

    model_config = ConfigDict(extra="forbid")

    scene_item_id: str
    bbox: list[float]
    #: The whole detector configuration, not just the hash: the hash proves two
    #: runs are identical, this block says what they were.
    processing_config: dict[str, Any]
    algorithm_version: str


class ScanDebugBlock(BaseModel):
    """Which debug layers exist for this scan, and how to read them.

    The rasters themselves are NOT here: they are written to the artifact cache
    and referenced by key, because a record carrying its own arrays would be a
    record nobody could store or serve.
    """

    model_config = ConfigDict(extra="forbid")

    cache: DebugCacheInputs
    layers: list[str] = Field(default_factory=list)
    columns: dict[str, list[str]] = Field(default_factory=dict)
    runtime_mode: str
    synthetic: bool


class ScanRecordDocument(BaseModel):
    """The persisted record of one scan, as :meth:`RunStore.save` writes it.

    NOT the per-target evidence document, and not the pipeline's in-memory
    return value either. ``GET /api/evidence/{target_id}`` answers with the
    STORED record that owns the target -- which is why ``evidence.targets`` and
    ``evidence.config`` exist on it, and which is why
    ``test_api.py`` pins ``evidence.config.config_hash``. Typing it as
    :class:`EvidenceDocument` would have been a functional regression disguised as
    a stricter contract, so it gets its own model and
    ``test_evidence_document_contract.py`` proves the two are not
    interchangeable.

    Three differences from ``run_scan``'s return value are load-bearing and were
    found by the coverage gate rather than assumed:

    * ``artifacts`` is ABSENT. Persisting five rasters inside the JSON document
      is why ``_persist_scan`` strips them; they live in the artifact cache and
      are named by ``debug.layers``.
    * ``debug`` is present, and it is what makes those layers reachable.
    * ``schema_version`` is present, stamped by the store.

    Two blocks stay open, each for a reason that is not "we ran out of time":

    ``targets``
        The pipeline's internal record form, which uses ``cls`` and camelCase
        measurement keys. :class:`darkfleet.api.targets.VesselTarget` is the
        WIRE form and would rename ``cls`` to ``classification`` here, silently
        changing a payload that already shipped. Normalising the stored form on
        a read route is a separate decision, and it is not this lane's to make.
        (The route validated against is ``/scans/{id}/targets``, which already
        emits ``classification``; the two routes disagree today and that
        disagreement is pre-existing.)

    ``debug.columns``
        Column-name lists per debug table. Declaring the rows here would mean
        restating the target schema a third time; the names are what a consumer
        needs in order to read the row the debug route actually serves.
    """

    model_config = ConfigDict(extra="forbid")

    scan_id: str
    schema_version: int
    runtime_mode: str
    synthetic: bool
    scene: ScanScene
    aoi: list[float]
    acquisition_time: str
    config: ScanConfigRecord
    targets: list[dict[str, Any]]
    ais_only: list[AisOnlyTarget]
    counts: dict[str, int]
    provenance: EvidenceProvenance | None
    debug: ScanDebugBlock
    processing_time_ms: int
    created_at: str
