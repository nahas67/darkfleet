"""Live collectors. Both require free credentials and fail loudly without them.

Collectors persist into the SAME archive used for historical correlation
(AIS-014). Live data is never the historical store (AIS-015).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from ..providers import RealDataUnavailableError
from .archive import AisArchive
from .models import AisObservation
from .normalize import normalize_aishub, normalize_aistream
from .resilience import (
    AistreamWatchdog,
    FailureKind,
    classify_failure,
    frame_is_oversized,
)

log = logging.getLogger(__name__)


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
        """Stream until `limit` observations persisted (0 = forever).

        Reconnects under the policy in :mod:`darkfleet.ais.resilience`. The
        previous implementation opened one socket and let any failure end the
        run: a transient drop lost the subscription entirely, and there was no
        failure classification at all, so an auth rejection and a network blip
        were indistinguishable.
        """
        import websockets

        watchdog = AistreamWatchdog()
        count = 0

        while True:
            try:
                async with websockets.connect(self.URL) as ws:
                    await ws.send(json.dumps(self.subscribe_message(bbox)))
                    async for raw in ws:
                        if not frame_is_oversized(len(str(raw))):
                            obs = self.handle_message(str(raw))
                            if obs is not None:
                                self.archive.append([obs])
                                count += 1
                                watchdog.record_success()
                                if limit and count >= limit:
                                    return count
                # The stream ended without an exception. That is still a lost
                # subscription: reconnecting immediately here is a hot loop,
                # because a server that closes cleanly would be re-dialled as
                # fast as it can answer. It is paced as a transport fault.
                failure = classify_failure(message="stream ended by the provider")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the policy, not the type, decides
                failure = classify_failure(message=str(exc))

            delay = watchdog.record_failure(failure)
            log.warning(
                "aisstream %s after %d frame(s); next attempt in %.0fs: %s",
                failure.kind.value,
                count,
                delay,
                failure.message,
            )
            if failure.kind is FailureKind.AUTH:
                # The key is rejected. Retrying cannot fix it, so the run stops
                # here rather than hammering the provider hourly.
                raise RealDataUnavailableError(
                    "AISStream rejected the API key; no retry is attempted.",
                    details={"provider": "aistream", "message": failure.message},
                    suggestions=["Check DARKFLEET_AIS__AISTREAM_API_KEY."],
                )
            await asyncio.sleep(delay)


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
