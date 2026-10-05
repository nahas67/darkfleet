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
    """GFW event with position -> canonical. Registry-only entries are skipped.

    GFW PUBLISHES NO KINEMATICS, SO NONE ARE INVENTED.

    This previously wrote ``sog=0.0, cog=0.0, heading=0.0``. GFW is a fishing-activity dataset:
    its events carry a position, a vessel and a time, and nothing else. Writing three zeros
    therefore asserted three measurements nobody made, in three separate ways that mattered:

      * a vessel at anchor and a vessel with no speed report became indistinguishable, which is
        the exact conflation ``AisObservation``'s module docstring exists to prevent;
      * ``propagate``'s ``sog < 0.1`` guard -- the product's own "do not dead-reckon a vessel
        that is not moving" rule -- was defeated, because 0.0 satisfies ``< 0.1`` and so the
        vessel was projected as genuinely stationary rather than declined;
      * ``cog=0.0`` is a real course, due north. A GFW contact would have been drawn pointing
        north, and ``orient_diff`` would have scored it against north-oriented hulls as though
        it had reported agreement.

    All three are absent, so all three are ``None``. The fix is not cosmetic: it changes what
    the correlation scores, because an un-reported course now scores zero on the heading term
    instead of contributing a free match against a north-south hull.
    """
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
            # GFW carries none of these. Absent is None -- see the module docstring of
            # `darkfleet.ais.models`, which is explicit that 0.0 is not the same claim.
            sog=None,
            cog=None,
            heading=None,
            ship_type=str(vessel.get("type") or entry.get("type") or ""),
            name=str(vessel.get("name") or ""),
            callsign=str(vessel.get("callsign") or ""),
            imo=str(vessel.get("imo") or ""),
            source="gfw",
        )
    except (ValueError, TypeError, AttributeError):
        return None
