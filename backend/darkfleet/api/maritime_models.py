"""The typed maritime-context contract.

Pydantic -> OpenAPI -> generated TypeScript -> generated field metadata -> runtime
validation. No ``dict[str, Any]`` reaches the client, and every context value carries
its OWN provenance rather than one generic source block, so "which dataset produced
this number" is answerable per field.

DESIGN DECISIONS WORTH NAMING

SCOPED, NOT GLOBAL
    Target ids are per-scan: ``DF-002`` in scan 1 is not ``DF-002`` in scan 31. The
    response therefore repeats both halves of the identity, and the route encodes both,
    so a lookup cannot silently resolve to the wrong vessel.

PER-VALUE STATUS
    Each channel reports AVAILABLE / NOT_INSTALLED / NO_COVERAGE / FAILED /
    NOT_ESTABLISHED independently. One missing optional dataset must not turn the route
    into a 500, and must not blank the channels that do work.

NO PLACEHOLDERS
    There is no field for anchorages, weather or anything else not integrated. A
    null-heavy schema for future layers is a promise the product does not keep.

CONTEXT IS NOT EVIDENCE
    Nothing here appears inside a target's evidence document. This is a separate route
    for a separate concept, and the analytical delta test asserts the evidence
    document's key set does not change when context is available.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from darkfleet.maritime.context import ContextStatus
from darkfleet.maritime.geometry import DistanceMethod
from darkfleet.maritime.provenance import LicenseKind, MaritimeZone


class StrictModel(BaseModel):
    """extra="forbid".

    A contract that silently absorbs an unknown key will let a renamed field ship
    without the client noticing, which is precisely the class of drift the generated
    TypeScript exists to prevent.
    """

    model_config = ConfigDict(extra="forbid")


class SourceRef(StrictModel):
    """Which dataset produced a value.

    Built from the installed manifest, so the version shown to an operator is the
    version on disk by construction rather than by a duplicated string in the frontend.
    """

    provider: str
    dataset: str
    version: str
    license: LicenseKind
    attribution: str
    #: DOI or publisher URL. Empty string rather than null so the client never has to
    #: branch on absence for a field that is simply sometimes blank.
    identifier: str = ""
    #: Publisher release date or data currency, when the source declares one. For the
    #: World Port Index this is 2019-08-31, which is the whole reason it is shown.
    release_date: str | None = None
    #: When a SERVICE SNAPSHOT was taken, ISO-8601 UTC.
    #:
    #: The version-like fact a live service carries when it publishes no version string.
    #: The Marine Regions WFS is exactly that case -- its layers have no version and its
    #: metadata documents are unauthenticated -- so this timestamp is the only thing that
    #: distinguishes one snapshot from another. Without it the UI would have to print
    #: either a version it cannot prove or nothing at all about when the data was read.
    #:
    #: Null for a static download, where ``release_date`` is the meaningful fact and a
    #: retrieval time would be noise.
    retrieved_at: str | None = None
    terms_notes: str = ""
    limitations: tuple[str, ...] = ()
    coverage_note: str = ""
    #: Install state at query time, so "not installed" is visible on the value itself
    #: rather than only in a system panel.
    install_status: str


class TargetPosition(StrictModel):
    """The authoritative WGS84 position used for every context calculation.

    Taken from the PERSISTED scan target, never from a client-supplied coordinate. A
    route that accepted lat/lon would let a caller ask about a different vessel than
    the one named in the URL, and the answer would look authoritative.
    """

    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)


class ZoneContext(StrictModel):
    """Maritime zone as the DATASET represents it."""

    status: ContextStatus
    zone: MaritimeZone | None = None
    #: Feature identifier exactly as the dataset writes it.
    feature_id: str | None = None
    #: Sovereign/territory names verbatim from the source. Never reduced to one: a
    #: dataset naming three claimants reports three, and choosing among them would be
    #: DarkFleet asserting a sovereignty position it has no standing to take.
    sovereign_names: tuple[str, ...] = ()
    dispute_note: str | None = None
    #: Why the answer is AMBIGUOUS or NOT_ESTABLISHED.
    reason: str | None = None
    #: True only when a dataset actually decided. NOT_ESTABLISHED and AMBIGUOUS are both
    #: non-answers and neither may be rendered as a zone.
    established: bool = False
    disputed: bool = False
    provenance: SourceRef | None = None
    detail: str = ""

    @classmethod
    def from_classification(cls, classification: object, source: SourceRef | None) -> ZoneContext:
        """Build from a :class:`ZoneClassification` plus its channel status."""
        return cls(
            status=ContextStatus.AVAILABLE,
            zone=classification.zone,  # type: ignore[attr-defined]
            feature_id=classification.feature_id,  # type: ignore[attr-defined]
            sovereign_names=classification.sovereign_names,  # type: ignore[attr-defined]
            dispute_note=classification.dispute_note,  # type: ignore[attr-defined]
            reason=classification.reason,  # type: ignore[attr-defined]
            established=classification.established,  # type: ignore[attr-defined]
            disputed=classification.disputed,  # type: ignore[attr-defined]
            provenance=source,
        )

    @classmethod
    def unavailable(cls, status: ContextStatus, detail: str, source: SourceRef | None = None) -> ZoneContext:
        return cls(status=status, detail=detail, provenance=source)


class CoastContext(StrictModel):
    """Distance to the nearest coastline."""

    status: ContextStatus
    meters: float | None = None
    #: Named explicitly. A coastal distance measured to densified samples is NOT an
    #: exact point-to-segment measurement, and presenting it as one would overstate the
    #: precision by up to half the sample spacing.
    method: DistanceMethod = DistanceMethod.DENSIFIED_POINT_METER
    #: The sampling interval used, so a reader can judge the bound.
    sample_spacing_m: float | None = None
    searched_radius_m: float | None = None
    provenance: SourceRef | None = None
    detail: str = ""


class PortContext(StrictModel):
    """Nearest port and the distance to it.

    There is deliberately no destination, origin, ETA, heading or port-call field.
    Proximity establishes identity and distance and nothing more; the restriction is
    stated on the response so it cannot be lost by a client rendering the name without
    the surrounding context.
    """

    status: ContextStatus
    port_id: str | None = None
    name: str | None = None
    #: Country / territory exactly as the source words it. Not normalised to a code.
    country: str | None = None
    harbor_type: str | None = None
    harbor_size: str | None = None
    longitude: float | None = None
    latitude: float | None = None
    meters: float | None = None
    method: DistanceMethod = DistanceMethod.GEODESIC_METER
    searched_radius_m: float | None = None
    provenance: SourceRef | None = None
    interpretation: str = (
        "PROXIMITY IS CONTEXT ONLY - not a destination, origin, intent or port call."
    )
    detail: str = ""


class BathymetryContext(StrictModel):
    """Reference depth at the target.

    With GEBCO not installed this reports NOT_INSTALLED with the provenance still
    attached, so an operator learns WHICH dataset would answer and how to get it. A
    hidden channel and a channel reading 0 m are both wrong; this is the third option.
    """

    status: ContextStatus
    #: Metres, negative below sea level, following the dataset's sign convention.
    meters: float | None = None
    resolution_deg: float | None = None
    #: The dataset's own source-quality code when the installed product supplies one.
    #: Never synthesised.
    source_type: str | None = None
    provenance: SourceRef | None = None
    detail: str = ""


class TargetMaritimeContextResponse(StrictModel):
    """Maritime context for one SCAN-SCOPED target.

    Both halves of the identity are repeated in the body, not just the URL, so a
    response can be checked against what was asked for.
    """

    scan_id: str
    target_id: str
    position: TargetPosition

    maritime_zone: ZoneContext
    nearest_coast: CoastContext
    nearest_port: PortContext
    bathymetry: BathymetryContext

    #: UTC, second resolution.
    generated_at: datetime
    #: Bumped when the CONTEXT SHAPE changes, so a client can detect a contract it does
    #: not understand rather than mis-reading a missing field as "no data".
    context_version: int = 1


#: The version this build emits. A contract-shape change must bump it.
CONTEXT_VERSION = 1