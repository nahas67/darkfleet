"""Live collectors. Both require free credentials and fail loudly without them.

Collectors persist into the SAME archive used for historical correlation
(AIS-014). Live data is never the historical store (AIS-015).
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..providers import RealDataUnavailableError
from .archive import AisArchive
from .models import AisObservation
from .normalize import normalize_aishub, normalize_aistream


class AistreamCollector:
    """AISStream websocket subscriber. Needs DARKFLEET_AIS__AISTREAM_API_KEY."""

    URL = "wss://stream.aisstream.io/v0/stream"

    def __init__(self, api_key: str, archive: AisArchive):
        if not api_key:
            raise RealDataUnavailableError(
                "AISStream needs a free API key (aisstream.io).",
                details={"provider": "aistream"},
                suggestions=["Set DARKFLEET_AIS__AISTREAM_API_KEY, or import files."],
            )
        self.api_key = api_key
        self.archive = archive

    def subscribe_message(self, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
        min_lon, min_lat, max_lon, max_lat = bbox
        return {
            "APIKey": self.api_key,
            "BoundingBoxes": [[[min_lat, min_lon], [max_lat, max_lon]]],
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
        }

    def handle_message(self, raw: str) -> AisObservation | None:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return None
        return normalize_aistream(msg)

    async def run(self, bbox: tuple[float, float, float, float], limit: int = 0) -> int:
        """Stream until `limit` observations persisted (0 = forever)."""
        import websockets

        count = 0
        async with websockets.connect(self.URL) as ws:
            await ws.send(json.dumps(self.subscribe_message(bbox)))
            async for raw in ws:
                obs = self.handle_message(str(raw))
                if obs is None:
                    continue
                self.archive.append([obs])
                count += 1
                if limit and count >= limit:
                    return count
        return count


class AishubPoller:
    """AISHub HTTP snapshot poller. Needs a free username (aishub.net)."""

    URL = "https://data.aishub.net/ws.php"

    def __init__(self, username: str, archive: AisArchive):
        if not username:
            raise RealDataUnavailableError(
                "AISHub needs a free username (aishub.net).",
                details={"provider": "aishub"},
                suggestions=["Set DARKFLEET_AIS__AISHUB_USERNAME, or import files."],
            )
        self.username = username
        self.archive = archive

    def poll_once(self, bbox: tuple[float, float, float, float]) -> dict[str, int]:
        min_lon, min_lat, max_lon, max_lat = bbox
        resp = httpx.get(
            self.URL,
            params={
                "username": self.username,
                "format": 1,
                "output": "json",
                "compress": 0,
                "latmin": min_lat,
                "latmax": max_lat,
                "lonmin": min_lon,
                "lonmax": max_lon,
            },
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        obs = [o for o in (normalize_aishub(r) for r in rows) if o is not None]
        return self.archive.append(obs)
