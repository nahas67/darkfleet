"""Canonical AIS observation. Every provider normalizes to this; nothing else
is stored. (AIS-007)"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class AisObservation(BaseModel):
    timestamp: datetime
    mmsi: str = Field(min_length=9, max_length=9, pattern=r"^\d{9}$")
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    sog: float = Field(default=0.0, ge=0.0)  # knots
    cog: float = Field(default=0.0, ge=0.0, le=360.0)  # degrees
    heading: float = Field(default=0.0, ge=0.0, le=360.0)
    nav_status: str = ""
    name: str = ""
    callsign: str = ""
    imo: str = ""
    ship_type: str = ""
    length_m: float = 0.0
    width_m: float = 0.0
    source: str = ""  # aistream | aishub | gfw | marinecadastre | file-import

    def dedup_key(self) -> str:
        return f"{self.mmsi}|{self.timestamp.isoformat()}"
