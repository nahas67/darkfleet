"""AIS delivery: archive -> API. (GREEN-3)

The AIS archive already existed and was queryable, but nothing exposed it over
HTTP. That made it impossible to draw a track on the globe or show a vessel's
history in the interface, so this module adds delivery without adding a second
store: every query goes through :class:`darkfleet.ais.archive.AisArchive`.

Coverage is a first-class answer, not an absence
----------------------------------------------
"No observations" and "no source covers this place and time" are different
claims, and the interface must be able to tell them apart. Returning ``[]`` for
both would let a panel say "0 AIS vessels" over a region that was never
observed, which reads as evidence of an empty sea rather than as a gap in
coverage.

So every response carries a ``coverage`` block with an explicit state:

``AVAILABLE``
    the archive spans the requested window; ``observation_count`` is the
    measured count, including a legitimate zero.
``PARTIAL``
    the archive overlaps the window but does not span it. Any count is
    incomplete and must be labelled as such.
``NO_COVERAGE``
    the archive does not reach the requested window at all. The count is not
    reported, because there is nothing to count.
``NOT_CONFIGURED``
    no AIS archive exists in this deployment.

Absence stays absence
---------------------
Optional measurements are ``null`` when the provider did not report them. They
are never coerced to ``0.0`` or ``""``: a vessel that never broadcast a speed
and a vessel at anchor are different facts, and ``SOG 0.0 kn`` would assert the
second. See :mod:`darkfleet.ais.models`.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from .archive import AisArchive


class PositionStatus(StrEnum):
    """Explicit position validity diagnostic (DF-X9.8-H1).

    Distinguishes:
    - POSITION_AVAILABLE: a real measured latitude and longitude (including measured 0.0, 0.0)
    - POSITION_UNAVAILABLE: coordinates missing or null in source observation
    - INVALID_COORDINATE: coordinate present but non-finite or out of [-90,90] / [-180,180] bounds
    """

    POSITION_AVAILABLE = "POSITION_AVAILABLE"
    POSITION_UNAVAILABLE = "POSITION_UNAVAILABLE"
    INVALID_COORDINATE = "INVALID_COORDINATE"


class AisCoverageState(StrEnum):
    """Whether the archive can answer a question, and how completely."""

    AVAILABLE = "AVAILABLE"
    PARTIAL = "PARTIAL"
    NO_COVERAGE = "NO_COVERAGE"
    NOT_CONFIGURED = "NOT_CONFIGURED"


#: Default half-width of the window a scan correlates AIS over. Matches the
#: pipeline's own correlation window so a delivered observation set and a
#: correlation decision are drawn over the same instants.
DEFAULT_WINDOW_SECONDS = 900


class AisObservationOut(BaseModel):
    """One delivered observation, with absence preserved.

    Every field except identity, position and time is nullable, and ``None``
    means "the source did not report this" -- never a zero.
    Position is nullable when unavailable or invalid, diagnosed explicitly by
    position_status -- never silently fabricated as (0.0, 0.0) Null Island.
    """

    timestamp: datetime
    mmsi: str
    lat: float | None = Field(default=None, description="degrees north; null when unavailable")
    lon: float | None = Field(default=None, description="degrees east; null when unavailable")
    position_status: PositionStatus = Field(
        default=PositionStatus.POSITION_AVAILABLE,
        description="Explicit position validity: POSITION_AVAILABLE, POSITION_UNAVAILABLE, or INVALID_COORDINATE",
    )
    sog: float | None = Field(default=None, description="knots; null when not reported")
    cog: float | None = Field(default=None, description="degrees true; null when not reported")
    heading: float | None = Field(
        default=None,
        description="degrees true; null when not reported or the AIS 511 sentinel was sent",
    )
    nav_status: str | None = None
    ship_name: str | None = None
    callsign: str | None = None
    imo: str | None = None
    ship_type: str | None = None
    length_m: float | None = None
    width_m: float | None = None
    source: str | None = None


class AisCoverageOut(BaseModel):
    """The honest answer to "can this source speak to this request?"."""

    state: AisCoverageState
    detail: str
    #: Measured count. Deliberately absent (None) when state is NO_COVERAGE or
    #: NOT_CONFIGURED: with nothing to count, a number would imply a measurement.
    observation_count: int | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None
    archive_oldest: datetime | None = None
    archive_newest: datetime | None = None
    sources: list[str] = Field(default_factory=list)


class ScanAisWindow(BaseModel):
    start: datetime
    end: datetime


class ScanAisResponse(BaseModel):
    """``GET /api/scans/{scan_id}/ais`` -- observations behind one scan."""

    scan_id: str
    coverage: AisCoverageOut
    window: ScanAisWindow | None = None
    bbox: tuple[float, float, float, float] | None = None
    observations: list[AisObservationOut] = Field(default_factory=list)
    note: str


class VesselTrackResponse(BaseModel):
    """``GET /api/vessels/{mmsi}/track`` -- one vessel's observed history."""

    mmsi: str
    coverage: AisCoverageOut
    #: Best available identity, or nulls. Never a guess.
    ship_name: str | None = None
    callsign: str | None = None
    imo: str | None = None
    ship_type: str | None = None
    length_m: float | None = None
    width_m: float | None = None
    observations: list[AisObservationOut] = Field(default_factory=list)
    note: str


class TargetAisResponse(BaseModel):
    """``GET /api/targets/{target_id}/ais-observations``."""

    target_id: str
    #: The MMSI the correlation actually associated, or None when it associated
    #: nothing. Never a nearby vessel substituted for the real candidate.
    mmsi: str | None = None
    associated: bool
    coverage: AisCoverageOut
    window: ScanAisWindow | None = None
    observations: list[AisObservationOut] = Field(default_factory=list)
    note: str


def as_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value))
        except ValueError:
            return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _optional_float(value: Any) -> float | None:
    """A stored measurement, passed through faithfully.

    Deliberately does NOT reinterpret a stored ``0.0`` as "not reported".
    Partitions written before absence was representable used ``0.0`` for both
    cases, and that ambiguity is genuinely unresolvable after the fact -- so
    either reading invents something. Reporting the stored value keeps a real
    at-anchor zero intact; rows written since the model change store ``None``
    and arrive here as ``None``, which is unambiguous.

    The residual ambiguity in legacy partitions is stated in
    ``docs/DATA_SOURCE_REGISTRY.md`` rather than silently resolved here.
    """
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_coordinate(value: Any, min_val: float, max_val: float) -> tuple[float | None, bool]:
    """Parse a coordinate value, returning (float_or_none, is_invalid).

    Distinguishes:
    - valid measured coordinate (including 0.0) -> (float, False)
    - missing/None coordinate -> (None, False)
    - invalid coordinate (out of bounds, non-finite, unparseable) -> (None, True)
    """
    if value is None:
        return None, False
    try:
        f = float(value)
        if not math.isfinite(f) or f < min_val or f > max_val:
            return None, True
        return f, False
    except (TypeError, ValueError):
        return None, True


def to_out(row: dict[str, Any]) -> AisObservationOut:
    """One archive row -> the delivered shape, preserving absence.

    Never fabricates Null Island (0.0, 0.0) when position is absent or unparseable.
    A genuine (0.0, 0.0) observation is preserved as POSITION_AVAILABLE.
    """
    ts = as_utc(row.get("timestamp"))
    if ts is None:
        raise ValueError(f"Observation row missing valid timestamp: {row.get('timestamp')!r}")
    mmsi = str(row.get("mmsi") or "").strip()
    if not mmsi:
        raise ValueError(f"Observation row missing valid MMSI: {row.get('mmsi')!r}")

    lat_val, lat_invalid = _parse_coordinate(row.get("lat"), -90.0, 90.0)
    lon_val, lon_invalid = _parse_coordinate(row.get("lon"), -180.0, 180.0)

    if lat_invalid or lon_invalid:
        pos_status = PositionStatus.INVALID_COORDINATE
        lat_out = None
        lon_out = None
    elif lat_val is None or lon_val is None:
        pos_status = PositionStatus.POSITION_UNAVAILABLE
        lat_out = None
        lon_out = None
    else:
        pos_status = PositionStatus.POSITION_AVAILABLE
        lat_out = lat_val
        lon_out = lon_val

    return AisObservationOut(
        timestamp=ts,
        mmsi=mmsi,
        lat=lat_out,
        lon=lon_out,
        position_status=pos_status,
        sog=_optional_float(row.get("sog")),
        cog=_optional_float(row.get("cog")),
        heading=_optional_float(row.get("heading")),
        nav_status=_optional_str(row.get("nav_status")),
        ship_name=_optional_str(row.get("name")),
        callsign=_optional_str(row.get("callsign")),
        imo=_optional_str(row.get("imo")),
        ship_type=_optional_str(row.get("ship_type")),
        length_m=_optional_float(row.get("length_m")),
        width_m=_optional_float(row.get("width_m")),
        source=_optional_str(row.get("source")),
    )


def coverage_for(
    archive: AisArchive,
    start: datetime,
    end: datetime,
    count: int | None,
) -> AisCoverageOut:
    """Classify how completely the archive answers ``[start, end]``.

    The distinction is the whole point of this function. A source that spans the
    window and returns nothing is reporting a real zero; a source that never
    reached the window cannot report anything at all, and its silence is a gap
    in coverage rather than an absence of traffic.
    """
    report = archive.coverage()
    oldest = as_utc(report.get("oldest"))
    newest = as_utc(report.get("newest"))
    sources = [str(s) for s in (report.get("sources") or [])]

    if not report.get("observations") or oldest is None or newest is None:
        return AisCoverageOut(
            state=AisCoverageState.NOT_CONFIGURED,
            detail=(
                "No AIS archive is present in this deployment. Zero AIS data here "
                "means no AIS source has been ingested, not an empty sea."
            ),
            window_start=start,
            window_end=end,
            sources=[],
        )

    def _coverage(
        state: AisCoverageState,
        detail: str,
        *,
        start: datetime,
        end: datetime,
        count: int | None,
        oldest: datetime | None,
        newest: datetime | None,
        sources: list[str],
    ) -> AisCoverageOut:
        """One construction site, so every state reports the same provenance.

        Written explicitly rather than by ``**dict`` splatting: the splat lost its
        field types to mypy and would have needed a cast, which is exactly the
        kind of unchecked construction that hides a wrong argument.
        """
        return AisCoverageOut(
            state=state,
            detail=detail,
            observation_count=count,
            window_start=start,
            window_end=end,
            archive_oldest=oldest,
            archive_newest=newest,
            sources=sources,
        )

    if end < oldest or start > newest:
        return _coverage(
            AisCoverageState.NO_COVERAGE,
            (
                f"The AIS archive covers {oldest.isoformat()} to {newest.isoformat()}. "
                f"The requested window {start.isoformat()} to {end.isoformat()} lies "
                "outside it, so no observation count is reported."
            ),
            start=start,
            end=end,
            count=None,
            oldest=oldest,
            newest=newest,
            sources=sources,
        )

    if start >= oldest and end <= newest:
        return _coverage(
            AisCoverageState.AVAILABLE,
            (
                f"The AIS archive spans the requested window. {count or 0} "
                "observation(s) matched."
                + ("" if count else " A zero here is a measured absence of AIS traffic.")
            ),
            start=start,
            end=end,
            count=count,
            oldest=oldest,
            newest=newest,
            sources=sources,
        )

    return _coverage(
        AisCoverageState.PARTIAL,
        (
            f"The AIS archive covers {oldest.isoformat()} to {newest.isoformat()}, "
            "which only partly overlaps the requested window. The count below is "
            "incomplete: observations outside archive coverage are missing, not zero."
        ),
        start=start,
        end=end,
        count=count,
        oldest=oldest,
        newest=newest,
        sources=sources,
    )


def identity_from(rows: list[AisObservationOut]) -> dict[str, Any]:
    """Best available vessel identity across observations.

    Takes the first non-null value per field rather than the most recent, and
    never falls back to a placeholder. Inconsistent reporting across a track is
    itself information, so this does not attempt to reconcile conflicting values.
    """

    def first(attr: str) -> Any:
        for row in rows:
            value = getattr(row, attr, None)
            if value is not None:
                return value
        return None

    return {
        "ship_name": first("ship_name"),
        "callsign": first("callsign"),
        "imo": first("imo"),
        "ship_type": first("ship_type"),
        "length_m": first("length_m"),
        "width_m": first("width_m"),
    }


__all__ = [
    "DEFAULT_WINDOW_SECONDS",
    "AisCoverageOut",
    "AisCoverageState",
    "AisObservationOut",
    "PositionStatus",
    "ScanAisResponse",
    "ScanAisWindow",
    "TargetAisResponse",
    "VesselTrackResponse",
    "as_utc",
    "coverage_for",
    "identity_from",
    "to_out",
]