"""Machine-readable provenance for every installed reference dataset.

WHY A MANIFEST EXISTS

A contextual answer is only reproducible if the dataset that produced it can be named,
versioned and integrity-checked after the fact. "This target is in the high seas" is
meaningless without "per Marine Regions v12, CC BY 4.0, installed 2026-10-04", because
the same query against v11 returns a different answer over the same water.

The manifest is that record. It is written at INSTALL time and read by every query, so
the version shown in the dossier and the version on disk cannot disagree -- they are the
same object, read once (§77).

INSTALL STATUS IS NOT SOURCE HEALTH

DF-X8.1 established that provider health and dataset coverage are different axes. This
adds a third, and conflating any two of them produces nonsense:

  * :class:`SourceHealth` -- can the PROVIDER be reached right now.
  * :class:`DatasetCoverage` -- does the DATASET have data for this place.
  * :class:`InstallStatus` -- is a valid copy of the dataset on THIS disk.

A local GEBCO install has no HTTP latency and no 429. Its availability question is
whether the file exists, parses, and matches its checksum (§56). Reporting it with
network vocabulary would be a category error, so it gets its own enum.

INTEGRITY IS NOT OPTIONAL

`expected_sha256` may be None for a dataset whose publisher checksum this repository
has not independently confirmed. That is NOT the same as "verified": such a dataset
reports :attr:`InstallStatus.CHECKSUM_UNRECORDED`, which is visibly weaker than
:attr:`InstallStatus.READY`. A dataset whose recorded checksum MISMATCHES is
``CHECKSUM_MISMATCH`` -- never READY. Corruption reported as available is the one
outcome this module exists to prevent (§57).
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .provenance import DatasetCoverage, LicenseKind


class InstallStatus(str, Enum):
    """State of a dataset ON THIS DISK. Not a provider health state."""

    #: No directory on disk. The normal state for every dataset in a fresh install.
    NOT_INSTALLED = "NOT_INSTALLED"
    #: Present, parses, and matches a recorded checksum.
    READY = "READY"
    #: Present and parses, but no publisher checksum was recorded to check against.
    #: Deliberately distinct from READY so "unverified" is never read as "verified".
    CHECKSUM_UNRECORDED = "CHECKSUM_UNRECORDED"
    #: Present, but its content does not match the recorded checksum. CORRUPT.
    CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH"
    #: Present but unreadable or structurally invalid.
    INVALID = "INVALID"
    #: On disk at a version this build does not recognise.
    VERSION_UNKNOWN = "VERSION_UNKNOWN"


class LocalRepresentation(str, Enum):
    """How the payload is stored once prepared.

    Recorded explicitly because DISPLAY geometry and QUERY geometry are allowed to
    differ (§66): a simplified coastline can be rendered while the backend measures
    distance against the full one. Both carry the same dataset version, so the
    separation is never a licence to answer from different data.
    """

    #: JSON geometry, ring coordinate arrays in (lon, lat).
    PREPPED_GEOJSON = "PREPPED_GEOJSON"
    #: JSON rows with typed fields.
    PREPPED_ROWS = "PREPPED_ROWS"
    #: A prepared regular grid with an explicit origin and cell size.
    PREPPED_GRID = "PREPPED_GRID"


class StrictModel(BaseModel):
    """extra="forbid" everywhere in this module.

    A manifest that silently accepts unknown keys will quietly absorb a typo'd field
    name and report a dataset as installed when the one field that mattered was never
    written.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)


class DatasetManifest(StrictModel):
    """Everything needed to cite, verify and reproduce an installed dataset."""

    id: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    dataset: str = Field(min_length=1)
    #: The exact version integrated. Never "latest" (§46 of the DF-X8 brief).
    version: str = Field(min_length=1)
    #: Publisher release date when known, else None. Never invented.
    release_date: str | None = None
    #: DOI or publisher URL. Preferred over a download link because links rot.
    identifier: str | None = None
    download_url: str | None = None
    license: LicenseKind
    attribution: str = Field(min_length=1)
    #: Obligations beyond attribution. Non-empty where the licence imposes them.
    terms_notes: str = ""
    resolution: str | None = None
    coverage_note: str = ""
    limitations: tuple[str, ...] = ()
    representation: LocalRepresentation
    #: Files that must exist, relative to the dataset directory.
    payload_files: tuple[str, ...] = (Field(min_length=1),)
    #: Publisher checksum, when this repository has confirmed it. None means
    #: unverified, which surfaces as CHECKSUM_UNRECORDED rather than being hidden.
    expected_sha256: str | None = None

    @field_validator("expected_sha256")
    @classmethod
    def _checksum_shape(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) != 64 or any(c not in "0123456789abcdefABCDEF" for c in value):
            raise ValueError("expected_sha256 must be 64 hex characters")
        return value.lower()

    def citation(self) -> str:
        return f"{self.provider} — {self.dataset} {self.version} ({self.attribution})"


class InstalledDataset(StrictModel):
    """A manifest plus what was actually found on disk."""

    manifest: DatasetManifest
    status: InstallStatus
    #: Directory the dataset was resolved from. Absent when NOT_INSTALLED.
    path: str | None = None
    installed_at: str | None = None
    #: Checksum of the primary payload, computed at install or verify time.
    computed_sha256: str | None = None
    #: Why this status, in words. A status without a reason is unreadable in a panel.
    detail: str = ""

    @property
    def usable(self) -> bool:
        """Whether a query may read this dataset.

        ``CHECKSUM_UNRECORDED`` counts as usable: the data parsed and is internally
        consistent, and refusing to serve it would be a false alarm. It is reported
        distinctly so the weaker guarantee stays visible.
        """
        return self.status in (InstallStatus.READY, InstallStatus.CHECKSUM_UNRECORDED)

    def provenance(self) -> Any:
        """The :class:`DatasetProvenance` a contextual value must carry.

        Built from the SAME manifest the query read, so a displayed version cannot
        disagree with the version on disk (§77).
        """
        from .provenance import DatasetProvenance

        m = self.manifest
        return DatasetProvenance(
            provider=m.provider,
            dataset=m.dataset,
            version=m.version,
            license=m.license,
            attribution=m.attribution,
            identifier=m.identifier or "",
            terms_notes=m.terms_notes,
            limitations=m.limitations,
            verified_on=m.release_date or "",
            coverage_note=m.coverage_note,
        )


class DatasetAvailability(StrictModel):
    """Per-dataset state for a UI, keeping install and coverage apart.

    A dataset can be installed and still have no data for a queried point, which is a
    different sentence from "not installed" (§47).
    """

    id: str
    label: str
    install_status: InstallStatus
    coverage: DatasetCoverage
    version: str | None = None
    attribution: str | None = None
    license: str | None = None
    limitations: tuple[str, ...] = ()
    detail: str = ""


def utc_now_iso() -> str:
    """Install timestamps, UTC, second resolution.

    Timezone-aware on purpose: a naive local timestamp in a provenance record is
    ambiguous six months later when two machines in different zones compare notes.
    """
    return datetime.now(UTC).replace(microsecond=0).isoformat()