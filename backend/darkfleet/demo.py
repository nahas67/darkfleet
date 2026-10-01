"""Deterministic DEMO SAR/AIS synthesis (port of the legacy TS generator).

DEMO mode ONLY. Every artifact produced from here carries synthetic=True.
The port is seeded and reproducible so DEMO results are stable across runs.
"""

from __future__ import annotations

import math
from datetime import timedelta
from typing import Any

import numpy as np

from .ais.models import AisObservation
from .ais.normalize import _as_utc
from .correlation.geodesy import propagate


def _prand(seed: float) -> float:
    s = math.sin(seed) * 10000.0
    return s - math.floor(s)


def _ocean(height: int, width: int, clutter: str) -> np.ndarray:
    base = {"HIGH": -18.5, "LOW": -24.0}.get(clutter, -21.0)
    ys, xs = np.mgrid[0:height, 0:width]
    streak = np.sin((xs * math.cos(0.65) + ys * math.sin(0.65)) * 0.08) * 1.8
    u1 = np.maximum(0.0001, np.sin(xs * 37 + ys * 97 + 101) * 10000 % 1.0)
    u2 = _u2_grid(ys, xs)
    speckle = np.sqrt(-2 * np.log(u1)) * np.cos(2 * np.pi * u2) * 2.2
    out: np.ndarray = np.round(base + streak + speckle, 1)
    return out.astype(np.float64)


def _u2_grid(ys: np.ndarray, xs: np.ndarray) -> np.ndarray:
    out = np.empty_like(ys, dtype=np.float64)
    for y in range(ys.shape[0]):
        for x in range(xs.shape[1]):
            out[y, x] = _prand(x * 53 + ys[y, x] * 13 + 307)
    return out


def _land(grid: np.ndarray, mask: np.ndarray, scene: str, rng: np.random.Generator) -> None:
    h, w = mask.shape
    if "MALACCA" in scene:
        for y in range(int(h * 0.35)):
            for x in range(int(w * 0.45), w):
                edge = math.sin(x * 0.15) * 6
                if y < int(h * 0.28) + edge:
                    mask[y, x] = True
                    grid[y, x] = round(-8.0 + rng.uniform(0, 6), 1)
        for y in range(int(h * 0.68), h):
            for x in range(int(w * 0.55)):
                if y > int(h * 0.72) - math.cos(x * 0.12) * 8:
                    mask[y, x] = True
                    grid[y, x] = round(-7.5 + rng.uniform(0, 5), 1)
    elif "HORMUZ" in scene:
        for y in range(h):
            for x in range(int(w * 0.28)):
                if x < int(w * 0.22) + math.sin(y * 0.1) * 7:
                    mask[y, x] = True
                    grid[y, x] = round(-6.5 + rng.uniform(0, 5), 1)
    else:
        for y in range(int(h * 0.40)):
            for x in range(w):
                cape = math.sin(x * 0.08) * 12 + math.cos(x * 0.04) * 8
                if y < int(h * 0.25) + cape:
                    mask[y, x] = True
                    grid[y, x] = round(-7.0 + rng.uniform(0, 5.5), 1)


_VESSELS: dict[str, list[dict[str, Any]]] = {
    "MALACCA": [
        {"xn": 0.35, "yn": 0.42, "len": 294, "wid": 32, "hdg": 122, "sog": 14.8, "mmsi": "563189210", "name": "MAERSK MC-KINNEY", "type": "Container Ship", "flag": "Singapore", "imo": "9619907"},
        {"xn": 0.52, "yn": 0.48, "len": 333, "wid": 60, "hdg": 304, "sog": 13.2, "mmsi": "477421900", "name": "COSCO SHIPPING SCORPIO", "type": "Crude Oil Tanker", "flag": "Hong Kong", "imo": "9789647"},
        {"xn": 0.68, "yn": 0.54, "len": 228, "wid": 32, "hdg": 125, "sog": 11.5, "mmsi": "636019882", "name": "PACIFIC RUBY", "type": "Bulk Carrier", "flag": "Liberia", "imo": "9428798"},
        {"xn": 0.44, "yn": 0.38, "len": 180, "wid": 28, "hdg": 302, "sog": 12.0, "mmsi": "538007142", "name": "ORIENT ADVANCE", "type": "Chemical Tanker", "flag": "Marshall Islands", "imo": "9512018"},
        {"xn": 0.78, "yn": 0.62, "len": 95, "wid": 18, "hdg": 118, "sog": 9.4, "mmsi": "525005822", "name": "BATAM TRADER", "type": "General Cargo", "flag": "Indonesia", "imo": "8910452"},
        {"xn": 0.72, "yn": 0.32, "len": 318, "wid": 58, "hdg": 78, "sog": 1.2, "dark": True},
        {"xn": 0.28, "yn": 0.62, "len": 245, "wid": 42, "hdg": 45, "sog": 1.8, "dark": True},
        {"xn": 0.31, "yn": 0.64, "len": 274, "wid": 48, "hdg": 50, "sog": 1.5, "dark": True},
        {"xn": 0.58, "yn": 0.65, "len": 115, "wid": 16, "hdg": 260, "sog": 16.5, "dark": True},
        {"xn": 0.18, "yn": 0.22, "len": 65, "wid": 65, "hdg": 0, "sog": 0.0, "stationary": True},
    ],
}


def synthesize(scene: dict[str, Any], width: int = 180, height: int = 180) -> dict[str, Any]:
    """Deterministic synthetic scene: dB grid, land mask, AIS observations."""
    rng = np.random.default_rng(20260918)
    grid = _ocean(height, width, str(scene.get("seaClutterLevel", "MODERATE")))
    land = np.zeros((height, width), dtype=bool)
    _land(grid, land, str(scene["id"]), rng)

    min_lon, min_lat, max_lon, max_lat = scene["bbox"]
    acq = _as_utc(scene["acquisitionTime"])
    vessels = _VESSELS.get(
        "MALACCA" if "MALACCA" in scene["id"] else "DEFAULT",
        [
            {"xn": 0.40, "yn": 0.55, "len": 210, "wid": 30, "hdg": 110, "sog": 12.5, "mmsi": "215124000", "name": "SEAMAR TRADER", "type": "Bulk Carrier", "flag": "Malta", "imo": "9312890"},
            {"xn": 0.65, "yn": 0.45, "len": 185, "wid": 26, "hdg": 285, "sog": 10.8, "mmsi": "352001182", "name": "CRIMEA FREIGHTER", "type": "General Cargo", "flag": "Panama", "imo": "9211054"},
            {"xn": 0.50, "yn": 0.70, "len": 240, "wid": 40, "hdg": 195, "sog": 8.5, "dark": True},
            {"xn": 0.72, "yn": 0.30, "len": 145, "wid": 22, "hdg": 45, "sog": 0.8, "dark": True},
            {"xn": 0.25, "yn": 0.35, "len": 55, "wid": 55, "hdg": 0, "sog": 0.0, "stationary": True},
        ],
    )

    ais: list[AisObservation] = []
    for v in vessels:
        px, py = round(v["xn"] * width), round(v["yn"] * height)
        if land[py, px]:
            continue
        hl = max(3, min(10, round(v["len"] / 32)))
        hw = max(1, min(4, round(v["wid"] / 20)))
        rad = math.radians(v["hdg"])
        dx, dy = math.sin(rad), -math.cos(rad)
        nx, ny = -dy, dx
        for li in np.arange(-hl / 2, hl / 2 + 0.01, 0.8):
            for wi in np.arange(-hw / 2, hw / 2 + 0.01, 0.8):
                hx, hy = round(px + li * dx + wi * nx), round(py + li * dy + wi * ny)
                if 0 <= hx < width and 0 <= hy < height and not land[hy, hx]:
                    inten = round(0.5 + _prand(hx * 17 + hy * 41) * 3.8, 1)
                    grid[hy, hx] = max(grid[hy, hx], inten)
        if v["len"] > 150:
            for s in range(-2, 3):
                sx, sy = px + s, py
                if 0 <= sx < width and 0 <= sy < height and not land[sy, sx]:
                    grid[sy, sx] = max(grid[sy, sx], -4.0)
        if v["sog"] > 4.0 and not v.get("stationary"):
            for dist in range(3, 13, 2):
                cx2, cy2 = round(px - dx * dist), round(py - dy * dist)
                if 0 <= cx2 < width and 0 <= cy2 < height and not land[cy2, cx2]:
                    grid[cy2, cx2] = -27.5
                off = dist * math.tan(0.34)
                for sgn in (1, -1):
                    ax, ay = round(cx2 + nx * off * sgn), round(cy2 + ny * off * sgn)
                    if 0 <= ax < width and 0 <= ay < height and not land[ay, ax]:
                        grid[ay, ax] = max(grid[ay, ax], -13.0)
        if not v.get("dark") and v.get("mmsi"):
            sar_lon = min_lon + (px / width) * (max_lon - min_lon)
            sar_lat = max_lat - (py / height) * (max_lat - min_lat)
            offset = round((_prand(px * 19 + py * 29) - 0.4) * 80)
            back = propagate(sar_lat, sar_lon, v["sog"], v["hdg"], -offset)
            ais.append(
                AisObservation(
                    timestamp=acq - timedelta(seconds=offset),
                    mmsi=v["mmsi"], lat=round(back["lat"], 6), lon=round(back["lon"], 6),
                    sog=v["sog"], cog=v["hdg"], heading=v["hdg"],
                    nav_status="At Anchor" if v["sog"] < 1.0 else "Under Way Using Engine",
                    name=v["name"], callsign=f"9V{v['mmsi'][-4:]}", imo=v.get("imo", ""),
                    ship_type=v["type"], length_m=v["len"], width_m=v["wid"], source="demo",
                )
            )
    ais.append(
        AisObservation(
            timestamp=acq - timedelta(seconds=45), mmsi="357900124",
            name="PHANTOM TRADER (DEMO)", callsign="HO9912", imo="9182391",
            ship_type="Oil Products Tanker",
            lat=round(max_lat - 0.85 * (max_lat - min_lat), 6),
            lon=round(min_lon + 0.15 * (max_lon - min_lon), 6),
            sog=11.2, cog=85, heading=85, nav_status="Under Way Using Engine",
            length_m=182, width_m=32, source="demo",
        )
    )
    return {"grid": grid, "land": land, "ais": ais, "width": width, "height": height}