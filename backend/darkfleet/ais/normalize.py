"""Normalization: provider payloads -> canonical observations. (AIS-008)"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .models import AisObservation


def _f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


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
        return AisObservation(
            timestamp=_as_utc(ts) if ts else datetime.now(UTC),
            mmsi=str(meta.get("MMSI", report.get("UserID", ""))),
            lat=_f(report.get("Latitude")),
            lon=_f(report.get("Longitude")),
            sog=_f(report.get("Sog")),
            cog=_f(report.get("Cog")),
            heading=_f(report.get("TrueHeading")),
            nav_status=str(report.get("NavigationalStatus", "")),
            name=str((inner.get("ShipStaticData") or {}).get("Name", "")).strip(),
            callsign=str((inner.get("ShipStaticData") or {}).get("Callsign", "")).strip(),
            imo=str((inner.get("ShipStaticData") or {}).get("ImoNumber", "")),
            ship_type=str((inner.get("ShipStaticData") or {}).get("Type", "")),
            source="aistream",
        )
    except (ValueError, TypeError, AttributeError):
        return None


def normalize_aishub(row: dict[str, Any]) -> AisObservation | None:
    """AISHub JSON array row: [MMSI, TIME, LONG, LAT, COG, SOG, HEADING, ...]."""
    try:
        if not isinstance(row, (list, tuple)) or len(row) < 9:
            return None
        return AisObservation(
            timestamp=datetime.fromtimestamp(int(row[1]), tz=UTC),
            mmsi=str(row[0]),
            lat=_f(row[3]),
            lon=_f(row[2]),
            sog=_f(row[5]),
            cog=_f(row[4]),
            heading=_f(row[6]),
            nav_status=str(row[8] or ""),
            name=str(row[7] or ""),
            source="aishub",
        )
    except (ValueError, TypeError, IndexError):
        return None


def normalize_marinecadastre(row: dict[str, Any]) -> AisObservation | None:
    """MarineCadastre zone CSV columns: MMSI, BaseDateTime, LAT, LON, SOG, COG,
    Heading, VesselName, IMO, CallSign, VesselType, Status, Length, Width, ..."""
    try:
        return AisObservation(
            timestamp=_as_utc(str(row.get("BaseDateTime"))),
            mmsi=str(row.get("MMSI", "")),
            lat=_f(row.get("LAT")),
            lon=_f(row.get("LON")),
            sog=_f(row.get("SOG")),
            cog=_f(row.get("COG")),
            heading=_f(row.get("Heading")),
            nav_status=str(row.get("Status") or ""),
            name=str(row.get("VesselName") or ""),
            callsign=str(row.get("CallSign") or ""),
            imo=str(row.get("IMO") or ""),
            ship_type=str(row.get("VesselType") or ""),
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
        lat, lon = d.get("lat"), d.get("lon")
        if lat is None or lon is None:
            return None
        return AisObservation(
            timestamp=timestamp,
            mmsi=str(d.get("mmsi", "")),
            lat=_f(lat),
            lon=_f(lon),
            sog=_f(d.get("speed")),
            cog=_f(d.get("course")),
            heading=_f(d.get("heading")),
            nav_status=str(d.get("status") or d.get("navigation_status") or ""),
            name=str(d.get("shipname") or d.get("name") or "").strip(),
            callsign=str(d.get("callsign") or "").strip(),
            imo=str(d.get("imo") or ""),
            ship_type=str(d.get("ship_type") or d.get("type") or ""),
            length_m=_f(d.get("to_bow", 0)) + _f(d.get("to_stern", 0)),
            width_m=_f(d.get("to_port", 0)) + _f(d.get("to_starboard", 0)),
            source=source,
        )
    except (ValueError, TypeError, AttributeError):
        return None
