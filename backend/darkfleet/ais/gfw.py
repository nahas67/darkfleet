"""Global Fishing Watch v3 adapter (key-gated). Derived events/presence with
positions — the only GFW surface that yields correlatable observations."""

from __future__ import annotations

from typing import Any

import httpx

from ..providers import RealDataUnavailableError
from .archive import AisArchive
from .models import AisObservation
from .normalize import _as_utc

GATEWAY = "https://gateway.api.globalfishingwatch.org/v3"


class GfwClient:
    def __init__(self, api_token: str, archive: AisArchive):
        if not api_token:
            raise RealDataUnavailableError(
                "Global Fishing Watch needs a free API token.",
                details={"provider": "gfw"},
                suggestions=["Set DARKFLEET_AIS__GFW_API_TOKEN, or import files."],
            )
        self.api_token = api_token
        self.archive = archive

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_token}"}

    def fetch_events(
        self,
        dataset: str,
        start_date: str,
        end_date: str,
        bbox: tuple[float, float, float, float] | None = None,
    ) -> list[AisObservation]:
        params: dict[str, Any] = {
            "datasets": dataset,
            "start-date": start_date,
            "end-date": end_date,
            "limit": 999,
            "offset": 0,
        }
        if bbox:
            params["bbox"] = ",".join(str(v) for v in bbox)
        resp = httpx.get(f"{GATEWAY}/events", params=params, headers=self._headers(), timeout=60)
        resp.raise_for_status()
        obs = [o for o in (normalize_gfw_event(e) for e in resp.json().get("entries", [])) if o]
        self.archive.append(obs)
        return obs


def normalize_gfw_event(entry: dict[str, Any]) -> AisObservation | None:
    """GFW event with position -> canonical. Registry-only entries are skipped."""
    try:
        pos = entry.get("position", {})
        lat, lon = pos.get("lat"), pos.get("lon")
        if lat is None or lon is None:
            return None
        vessel = entry.get("vessel", {})
        return AisObservation(
            timestamp=_as_utc(str(entry.get("start"))),
            mmsi=str(vessel.get("mmsi", "")),
            lat=float(lat),
            lon=float(lon),
            sog=0.0,
            cog=0.0,
            heading=0.0,
            ship_type=str(vessel.get("type") or entry.get("type") or ""),
            name=str(vessel.get("name") or ""),
            callsign=str(vessel.get("callsign") or ""),
            imo=str(vessel.get("imo") or ""),
            source="gfw",
        )
    except (ValueError, TypeError, AttributeError):
        return None
