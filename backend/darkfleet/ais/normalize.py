"""Normalization: provider payloads -> canonical observations. (AIS-008)"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .models import AisObservation


def _f(value: Any) -> float | None:
    """Best-effort float, or `None` when the provider did not report it.

    GEO-CORR follow-on: this used to return `0.0` on failure, which made
    "reported 0 knots" and "never reported a speed" the same stored value. An
    absent measurement now stays absent all the way to the contract.

    Blank strings are treated as absent, because providers use "" for both
    "no value" and "not applicable".
    """
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _s(value: Any) -> str | None:
    """Trimmed string, or ``None`` when blank. An empty string is absence."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


#: AIS encodes 511 as "heading not available" and 3600 as "course/heading
#: unavailable". Both are sentinels, not measurements; clamping them to 0
#: would invent a vessel pointing north.
_HEADING_UNAVAILABLE = frozenset({511.0, 3600.0})


def _sum(a: float | None, b: float | None) -> float | None:
    """Sum two optional dimensions. `None` unless both parts are known."""
    return None if a is None or b is None else a + b


def _position(value: Any) -> float | None:
    """A latitude/longitude, or ``None`` when the row carried no position.

    Separate from :func:`_f` only in intent: a missing POSITION means the row is
    not an observation at all and must be dropped, whereas a missing speed means
    an observation with an unmeasured speed. Both return ``None``; the caller
    decides whether that is fatal.
    """
    return _f(value)


def _angle(value: Any) -> float | None:
    """A course or heading, with the AIS "unavailable" sentinels removed."""
    number = _f(value)
    if number is None or number in _HEADING_UNAVAILABLE:
        return None
    return number


def _as_utc(value: str | datetime) -> datetime:
    """Parse to a timezone-aware UTC datetime; naive inputs are assumed UTC."""
    dt = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def normalize_aistream(msg: dict[str, Any]) -> AisObservation | None:
    """AISStream websocket JSON: {MetaData: {...}, Message: {PositionReport: {...}}}."""
    try:
        meta = msg.get("MetaData", {})
        inner = msg.get("Message", {})
        report = inner.get("PositionReport") or inner.get("ShipStaticData") or {}
        if "Latitude" not in report or "Longitude" not in report:
            return None
        ts = meta.get("time_utc", "")
        lat = _position(report.get("Latitude"))
        lon = _position(report.get("Longitude"))
        if lat is None or lon is None:
            return None
        return AisObservation(
            timestamp=_as_utc(ts) if ts else datetime.now(UTC),
            mmsi=str(meta.get("MMSI", report.get("UserID", ""))),
            lat=lat,
            lon=lon,
            sog=_f(report.get("Sog")),
            cog=_angle(report.get("Cog")),
            heading=_angle(report.get("TrueHeading")),
            nav_status=_s(report.get("NavigationalStatus")),
            name=_s((inner.get("ShipStaticData") or {}).get("Name")),
            callsign=_s((inner.get("ShipStaticData") or {}).get("Callsign")),
            imo=_s((inner.get("ShipStaticData") or {}).get("ImoNumber")),
            ship_type=_s((inner.get("ShipStaticData") or {}).get("Type")),
            source="aistream",
        )
    except (ValueError, TypeError, AttributeError):
        return None


def normalize_aishub(row: dict[str, Any]) -> AisObservation | None:
    """AISHub JSON array row: [MMSI, TIME, LONG, LAT, COG, SOG, HEADING, ...]."""
    try:
        if not isinstance(row, (list, tuple)) or len(row) < 9:
            return None
        lat = _position(row[3])
        lon = _position(row[2])
        if lat is None or lon is None:
            return None
        return AisObservation(
            timestamp=datetime.fromtimestamp(int(row[1]), tz=UTC),
            mmsi=str(row[0]),
            lat=lat,
            lon=lon,
            sog=_f(row[5]),
            cog=_angle(row[4]),
            heading=_angle(row[6]),
            nav_status=_s(row[8]),
            name=_s(row[7]),
            source="aishub",
        )
    except (ValueError, TypeError, IndexError):
        return None


def normalize_marinecadastre(row: dict[str, Any]) -> AisObservation | None:
    """MarineCadastre zone CSV columns: MMSI, BaseDateTime, LAT, LON, SOG, COG,
    Heading, VesselName, IMO, CallSign, VesselType, Status, Length, Width, ..."""
    try:
        lat = _position(row.get("LAT"))
        lon = _position(row.get("LON"))
        if lat is None or lon is None:
            return None
        return AisObservation(
            timestamp=_as_utc(str(row.get("BaseDateTime"))),
            mmsi=str(row.get("MMSI", "")),
            lat=lat,
            lon=lon,
            sog=_f(row.get("SOG")),
            cog=_angle(row.get("COG")),
            heading=_angle(row.get("Heading")),
            nav_status=_s(row.get("Status")),
            name=_s(row.get("VesselName")),
            callsign=_s(row.get("CallSign")),
            imo=_s(row.get("IMO")),
            ship_type=_s(row.get("VesselType")),
            length_m=_f(row.get("Length")),
            width_m=_f(row.get("Width")),
            source="marinecadastre",
        )
    except (ValueError, TypeError, AttributeError):
        return None


def normalize_pyais(msg: Any, source: str = "nmea-import") -> AisObservation | None:
    """Decoded pyais message -> canonical. (AIS-006)"""
    try:
        if hasattr(msg, "asdict"):
            d = dict(msg.asdict())
        elif hasattr(msg, "content"):
            d = dict(msg.content)
        else:
            d = dict(msg)
        ts = d.get("timestamp") or d.get("time")
        timestamp = (
            ts
            if isinstance(ts, datetime)
            else datetime.fromtimestamp(float(ts), tz=UTC) if ts else datetime.now(UTC)
        )
        lat = _position(d.get("lat"))
        lon = _position(d.get("lon"))
        if lat is None or lon is None:
            return None
        return AisObservation(
            timestamp=timestamp,
            mmsi=str(d.get("mmsi", "")),
            lat=lat,
            lon=lon,
            sog=_f(d.get("speed")),
            cog=_angle(d.get("course")),
            heading=_angle(d.get("heading")),
            nav_status=_s(d.get("status") or d.get("navigation_status")),
            name=_s(d.get("shipname") or d.get("name")),
            callsign=_s(d.get("callsign")),
            imo=_s(d.get("imo")),
            ship_type=_s(d.get("ship_type") or d.get("type")),
            length_m=_sum(_f(d.get("to_bow")), _f(d.get("to_stern"))),
            width_m=_sum(_f(d.get("to_port")), _f(d.get("to_starboard"))),
            source=source,
        )
    except (ValueError, TypeError, AttributeError):
        return None
