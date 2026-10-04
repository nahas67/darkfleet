"""Geodesy: ellipsoidal distances (the mandated upgrade), legacy-exact kinematics.

Distances use WGS84 ellipsoidal geodesic (pyproj.Geod) — never raw degrees.
Propagation keeps the legacy spherical direct formula so predicted positions
stay parity-stable with the golden run; only the DISTANCE metric changed.
"""

from __future__ import annotations

from pyproj import Geod

_WGS84_A = 6378137.0
KNOTS_TO_MPS = 0.514444444
_GEOD = Geod(ellps="WGS84")


def geodesic_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """WGS84 ellipsoidal distance in metres."""
    _, _, dist = _GEOD.inv(lon1, lat1, lon2, lat2)
    return float(dist)


def propagate(
    lat: float, lon: float, sog_knots: float, cog_deg: float, delta_seconds: float
) -> dict[str, float]:
    """Dead reckoning to SAR acquisition time. Legacy-exact spherical formula."""
    import math

    if abs(delta_seconds) < 1 or sog_knots < 0.1:
        return {"lat": lat, "lon": lon, "projectedDistanceMeters": 0.0}
    speed_mps = sog_knots * KNOTS_TO_MPS
    distance_m = abs(speed_mps * delta_seconds)
    bearing = cog_deg if delta_seconds >= 0 else (cog_deg + 180) % 360
    ang = distance_m / _WGS84_A
    rlat, rlon, rb = (math.radians(lat), math.radians(lon), math.radians(bearing))
    plat = math.asin(math.sin(rlat) * math.cos(ang) + math.cos(rlat) * math.sin(ang) * math.cos(rb))
    plon = rlon + math.atan2(
        math.sin(rb) * math.sin(ang) * math.cos(rlat),
        math.cos(ang) - math.sin(rlat) * math.sin(plat),
    )
    new_lat = plat * 180.0 / math.pi
    new_lon = ((plon * 180.0 / math.pi + 540) % 360) - 180
    return {
        "lat": round(new_lat, 6),
        "lon": round(new_lon, 6),
        "projectedDistanceMeters": distance_m,
    }


def dynamic_radius(base_m: float, delta_seconds: float, sog_knots: float, max_m: float) -> float:
    """Legacy-exact: base + |dt| * sog * 0.514444444 * 0.20, capped."""
    drift = abs(delta_seconds) * (sog_knots * KNOTS_TO_MPS) * 0.20
    return min(base_m + drift, max_m)


def orient_diff(deg1: float, deg2: float) -> float:
    """Undirected angular difference between two hull axes, 0..90 degrees.

    A hull axis is a line, not an arrow: it has no direction of travel, so the
    separation between two axes is only defined modulo a half-turn. Folding to
    0..90 is therefore the correct metric for comparing orientations, and it is
    the only one this function offers.

    This used to take a `wake_visible` flag that selected between this undirected
    metric and a directed 0..180 one, so a wake detection silently changed HOW
    heading agreement was measured -- and the change was large: `orient_diff(0,
    170)` was 10 degrees without a wake and 170 with one. A bare parameter with a
    default-free boolean is an invitation to reintroduce that coupling, so the
    parameter is gone rather than merely unused.
    """
    diff = abs(deg1 - deg2) % 180
    return diff if diff <= 90 else 180 - diff
