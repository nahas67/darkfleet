"""Dataset provenance for every contextual answer DarkFleet gives.

WHY THIS EXISTS

A maritime answer without a source is an assertion. "This target is in the high
seas" only carries meaning next to "per Marine Regions Maritime Boundaries
Geodatabase v12, CC BY 4.0, retrieved 2026-10-04", because that dataset is a third
party's *representation* of the Law of the Sea Convention, not a determination of
sovereignty by this product.

Provenance is therefore part of the answer, travels with the value, and is preserved
on stored evidence after the installed dataset is updated -- an operator who installs
vY must not retroactively change what a report generated against vX says it relied
on.

THE TWO HEALTH CONCEPTS ARE NOT MERGED

:attr:`SourceHealth` is whether a PROVIDER can be used right now.
:attr:`DatasetCoverage` is whether a DATASET has data for the place asked about.
They are separate axes. Conflating them produces nonsense in both directions: a
provider can be perfectly AVAILABLE while the dataset has NO_COVERAGE for a region,
and a dataset can be fully COVERED while the provider is UNAVAILABLE. `NO_COVERAGE`
is emphatically not a provider state.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class SourceHealth(str, Enum):
    """Whether a PROVIDER can be used right now.

    The same vocabulary the provider-health route already uses, so an operator learns
    one word for one idea. Note what is absent: no ``NO_COVERAGE``, because that is a
    property of a dataset's spatial extent and not of a transport.
    """

    AVAILABLE = "AVAILABLE"
    DEGRADED = "DEGRADED"
    AUTH_REQUIRED = "AUTH_REQUIRED"
    RATE_LIMITED = "RATE_LIMITED"
    UNAVAILABLE = "UNAVAILABLE"
    NOT_CONFIGURED = "NOT_CONFIGURED"


class DatasetCoverage(str, Enum):
    """Whether a DATASET has usable data for the requested place.

    Separate from :class:`SourceHealth`. A healthy provider with no data for the
    Arctic is ``AVAILABLE`` + ``NO_COVERAGE``, not ``UNAVAILABLE``.
    """

    COVERED = "COVERED"
    NO_COVERAGE = "NO_COVERAGE"
    PARTIAL = "PARTIAL"
    UNKNOWN = "UNKNOWN"
    STALE = "STALE"


class LicenseKind(str, Enum):
    """How a dataset may be used.

    Modelled rather than free-text because the distinction changes what DarkFleet is
    permitted to DO. "Downloadable" alone says nothing about redistribution, and
    reading "I could fetch it" as "I may ship it" is exactly the mistake DF-X8 §58
    warns about. Marine Regions is the live example: CC BY, but with an explicit
    request not to redistribute the products elsewhere and to refer to
    marineregions.org for the most current version.
    """

    PUBLIC_DOMAIN = "PUBLIC_DOMAIN"
    CC_BY = "CC_BY"
    CC_BY_SA = "CC_BY_SA"
    ODBL = "ODBL"
    #: Fetch permitted; redistribution or derived-tile terms need checking.
    DOWNLOAD_ONLY = "DOWNLOAD_ONLY"
    #: Requires a key, token or account.
    AUTHENTICATED = "AUTHENTICATED"
    #: Commercial terms. Must never be the only path to a working product.
    COMMERCIAL = "COMMERCIAL"
    #: Could not be determined, and is reported rather than assumed permissive.
    UNDETERMINED = "UNDETERMINED"


class DataKind(str, Enum):
    """The shape of the data, which determines what a renderer can do with it.

    A renderer that cannot handle ``RASTER`` must be told at registration rather
    than discovering it at draw time.
    """

    POLYGON = "POLYGON"
    POLYLINE = "POLYLINE"
    POINT = "POINT"
    RASTER = "RASTER"
    IMAGE = "IMAGE"
    TERRAIN = "TERRAIN"
    TILES3D = "TILES3D"


@dataclass(frozen=True)
class DatasetProvenance:
    """Everything needed to cite a contextual answer and reproduce it.

    Frozen, because provenance editable after the fact is not provenance. A stored
    evidence record must hold the value it had at the time, not whatever the operator
    installed afterwards.
    """

    #: Short provider name, e.g. ``VLIZ / Marine Regions``.
    provider: str
    #: The product name as the publisher writes it.
    dataset: str
    #: The exact version integrated. Never a paraphrase -- and never ``latest``,
    #: which is not a version and would silently change the meaning of stored
    #: evidence over time.
    version: str
    license: LicenseKind
    #: Attribution string to display. Required whenever the licence requires one.
    attribution: str
    #: Authoritative identifier -- a DOI or publisher URL. Preferred over a download
    #: link, because a link rots and a DOI does not.
    identifier: str = ""
    #: Free-text terms summary. Non-empty whenever the licence imposes obligations
    #: beyond attribution, because those are the ones that bite.
    terms_notes: str = ""
    #: Known limitations, in the publisher's or the integrator's own words.
    limitations: tuple[str, ...] = ()
    #: ISO date this provenance was last checked against the publisher.
    verified_on: str = ""
    #: Standing spatial-coverage note, as a property of the product.
    coverage_note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "dataset": self.dataset,
            "version": self.version,
            "license": self.license.value,
            "attribution": self.attribution,
            "identifier": self.identifier,
            "terms_notes": self.terms_notes,
            "limitations": list(self.limitations),
            "verified_on": self.verified_on,
            "coverage_note": self.coverage_note,
        }

    def citation(self) -> str:
        """One-line citation, as the publisher would want it acknowledged."""
        base = f"{self.provider} - {self.dataset} {self.version}"
        return f"{base} ({self.attribution})" if self.attribution else base


class MaritimeZone(str, Enum):
    """Law of the Sea zones, as a DATASET represents them.

    Surfaced in the UI as a *dataset-represented* zone. DarkFleet reports a third
    party's representation; it does not determine sovereignty. ``DISPUTED`` and
    ``AMBIGUOUS`` are real answers, not failures, and neither may be collapsed into
    a confident zone.
    """

    TERRITORIAL_SEA = "TERRITORIAL_SEA"
    CONTIGUOUS_ZONE = "CONTIGUOUS_ZONE"
    EXCLUSIVE_ECONOMIC_ZONE = "EXCLUSIVE_ECONOMIC_ZONE"
    INTERNAL_WATERS = "INTERNAL_WATERS"
    ARCHIPELAGIC_WATERS = "ARCHIPELAGIC_WATERS"
    HIGH_SEAS = "HIGH_SEAS"
    #: Claims overlap, or the source marks the area disputed.
    DISPUTED = "DISPUTED"
    #: The geometry gave no usable answer.
    AMBIGUOUS = "AMBIGUOUS"
    #: No integrated dataset covers this point.
    NOT_ESTABLISHED = "NOT_ESTABLISHED"


#: Exact wording shown beside a zone. Held here rather than in a component so every
#: surface says the same thing and the disclaimer cannot be softened in one place and
#: not another.
ZONE_DISCLAIMER = (
    "DATASET-REPRESENTED ZONE. This is how the cited maritime-boundary dataset "
    "represents this location. DarkFleet does not determine sovereignty, and a "
    "boundary here is not a legal opinion."
)


@dataclass(frozen=True)
class ZoneClassification:
    """A point's zone, with the feature that decided it and its caveats.

    ``feature_id`` and ``sovereign_names`` are carried verbatim from the dataset and
    are never normalised, completed or reduced to one. A dataset naming three
    claimants reports three names; choosing among them would be DarkFleet asserting
    a sovereignty position it has no standing to take.
    """

    zone: MaritimeZone
    #: Identifier of the deciding feature, as the dataset writes it.
    feature_id: str | None = None
    #: Sovereign/territory names exactly as supplied by the dataset.
    sovereign_names: tuple[str, ...] = ()
    #: The source's own note about overlap or dispute, when it exposes one.
    dispute_note: str | None = None
    #: Why the answer is AMBIGUOUS, when it is.
    reason: str | None = None
    provenance: DatasetProvenance | None = None

    @property
    def established(self) -> bool:
        """Whether a dataset actually decided this.

        ``NOT_ESTABLISHED`` and ``AMBIGUOUS`` are both non-answers and neither may be
        rendered as a zone.
        """
        return self.zone not in (MaritimeZone.NOT_ESTABLISHED, MaritimeZone.AMBIGUOUS)

    @property
    def disputed(self) -> bool:
        return self.zone is MaritimeZone.DISPUTED or bool(self.dispute_note)

    def to_dict(self) -> dict[str, Any]:
        return {
            "zone": self.zone.value,
            "feature_id": self.feature_id,
            "sovereign_names": list(self.sovereign_names),
            "dispute_note": self.dispute_note,
            "reason": self.reason,
            "established": self.established,
            "disputed": self.disputed,
        }
