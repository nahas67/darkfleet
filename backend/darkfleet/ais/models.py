"""Canonical AIS observation. Every provider normalizes to this; nothing else
is stored. (AIS-007)

Absence is representable
------------------------
An earlier revision typed every optional measurement as ``float = 0.0`` /
``str = ""``. That made three different states indistinguishable:

1. the vessel reported the value;
2. the vessel reported nothing for that field;
3. the provider's payload could not be parsed.

All three stored as ``0.0``. Downstream that surfaced as "SOG 0.0 kn" and
"COG 0°" in the interface, which reads as a measurement: a vessel at anchor and
a vessel that never broadcast a speed look identical. Worse, a ``0.0`` speed
participates in correlation arithmetic as if it were observed.

So absent is ``None`` here, and the ingest helpers in :mod:`darkfleet.ais.normalize`
return ``None`` rather than a placeholder. ``None`` propagates through the Parquet
archive, through the API, and into the contract, which marks these fields
nullable -- so a consumer cannot accidentally render a zero.

``lat``/``lon``/``timestamp``/``mmsi`` stay required and total: an AIS row
without a position or an identity is not an observation.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class AisObservation(BaseModel):
    timestamp: datetime
    mmsi: str = Field(min_length=9, max_length=9, pattern=r"^\d{9}$")
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)

    #: Speed over ground, knots. ``None`` means not reported -- NOT zero.
    sog: float | None = Field(default=None, ge=0.0)
    #: Course over ground, degrees true. ``None`` means not reported.
    cog: float | None = Field(default=None, ge=0.0, le=360.0)
    #: True heading, degrees. ``None`` means not reported. AIS encodes 511 as
    #: "heading not available"; that sentinel is normalised to ``None`` at ingest
    #: rather than clamped to a plausible-looking 0.
    heading: float | None = Field(default=None, ge=0.0, le=360.0)
    nav_status: str | None = None
    name: str | None = None
    callsign: str | None = None
    imo: str | None = None
    ship_type: str | None = None
    length_m: float | None = Field(default=None, ge=0.0)
    width_m: float | None = Field(default=None, ge=0.0)
    #: aistream | aishub | gfw | marinecadastre | file-import
    source: str | None = None

    def dedup_key(self) -> str:
        return f"{self.mmsi}|{self.timestamp.isoformat()}"