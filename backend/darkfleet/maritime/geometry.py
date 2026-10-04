"""The single spatial authority for maritime context.

Point-in-zone, nearest-port and distance-to-coast must not exist twice: if the globe
estimates a distance for a hover readout and the backend computes one for the
dossier, they disagree by the frontend's rounding and an operator cannot tell which is
right. The BACKEND is the authority; the frontend may only display what it returns.

Everything here is (lon, lat) -- GeoJSON axis order, what every maritime dataset
ships. Mixing it with the (lat, lon) the SAR pipeline uses transposes positions, so
the order is part of the type name.

DarkFleet is global, so ``west < east`` is false across much of the ocean. The naive
span test is therefore wrong for exactly the regions that matter, and is replaced by
wrap-aware helpers.

Geodesic and planar distances are both called "distance to coast" and differ by up to
~20% with latitude. The default is geodesic; planar exists only to pre-filter, and
every result records which method produced it.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any

from ..correlation.geodesy import geodesic_meters

# Metres per degree of latitude (111.32 km), spherical. Coarse pre-filtering only.
#
# Was previously 1_111_320, which is metres per RADIAN-scale error -- ten times too
# large. The prefilter is a bound on how far a candidate may be and still survive, so
# a 10x-too-tight bound silently DROPS legitimate near candidates rather than merely
# costing time: a port 1.5 degrees away was excluded by a 500 km search radius
# because 1.5 > 0.45. Silent data loss in a spatial query is exactly the failure
# mode the prefilter exists to avoid.
_M_PER_DEG_LAT = 111_320.0


class DistanceMethod(str, Enum):
    GEODESIC_METER = "GEODESIC_METER"
    PLANAR_DEGREE = "PLANAR_DEGREE"


class DistanceResult(str, Enum):
    """OUT_OF_RANGE is not a large number: "nothing within 200 km" and "nearest is
    43,000 km away" support opposite conclusions."""

    MEASURED = "MEASURED"
    OUT_OF_RANGE = "OUT_OF_RANGE"
    NO_DATASET = "NO_DATASET"
    NOT_COMPUTED = "NOT_COMPUTED"


@dataclass(frozen=True)
class Distance:
    meters: float | None
    method: DistanceMethod
    result: DistanceResult
    subject: str
    feature_id: str | None = None
    searched_radius_m: float | None = None

    @property
    def measured(self) -> bool:
        return self.result is DistanceResult.MEASURED and self.meters is not None

    def to_dict(self) -> dict[str, Any]:
        return {
            "meters": self.meters,
            "method": self.method.value,
            "result": self.result.value,
            "subject": self.subject,
            "feature_id": self.feature_id,
            "searched_radius_m": self.searched_radius_m,
        }


@dataclass(frozen=True)
class LonLat:
    """(lon, lat). The order is in the name so it cannot be got wrong by habit."""

    lon: float
    lat: float

    def validate(self) -> None:
        if not -180.0 <= self.lon <= 180.0:
            raise ValueError(f"longitude {self.lon} out of range")
        if not -90.0 <= self.lat <= 90.0:
            raise ValueError(f"latitude {self.lat} out of range")


@dataclass(frozen=True)
class LonSpan:
    west: float
    east: float
    crosses_antimeridian: bool = False

    def contains(self, lon: float) -> bool:
        if self.crosses_antimeridian:
            return lon >= self.west or lon <= self.east
        return self.west <= lon <= self.east


def normalize_span(west: float, east: float) -> LonSpan:
    """Any pair to one representation: west > east means it wraps."""
    return LonSpan(west, east, west > east)


def unwrap_lon(lon: float, reference: float) -> float:
    """Shift lon by multiples of 360 to lie within 180 of reference.

    Without this, Fiji at 178E and Samoa at 172W are 354 degrees apart, not 6.
    """
    return lon + 360.0 * math.floor((reference - lon) / 360.0 + 0.5)


def geodesic_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Metres between (lon, lat) points, via the correlation authority's geodesic so
    a dossier distance and a correlation radius cannot disagree.

    Longitudes are wrapped back into range here rather than trusted from the caller.
    :func:`unwrap_lon` deliberately leaves values outside [-180, 180] so two
    longitudes either side of the antimeridian can be differenced naively; pyproj
    wants a valid longitude, so every hand-off goes through :func:`_wrap`.
    """
    return geodesic_meters(lat1, _wrap(lon1), lat2, _wrap(lon2))


def _wrap(lon: float) -> float:
    """Fold a longitude back into [-180, 180]."""
    return (lon + 180.0) % 360.0 - 180.0


def planar_degree_distance(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Approximate degrees, PRE-FILTERING ONLY. Never a reported distance."""
    mid = math.radians((lat1 + lat2) / 2.0)
    dx = (unwrap_lon(lon2, lon1) - lon1) * math.cos(mid)
    return math.hypot(dx, lat2 - lat1)


def bounding_box_of(points: Sequence[tuple[float, float]], pad_deg: float = 0.0) -> LonSpan:
    """Longitude span over (lon, lat) points, antimeridian-aware.

    Naive min/max gives a 358-degree box for data straddling the antimeridian when it
    should give 2 degrees.
    """
    lons = [p[0] for p in points]
    if not lons:
        raise ValueError("no points")
    if max(lons) - min(lons) > 180.0:
        shifted = [unwrap_lon(x, 180.0) for x in lons]
        if max(shifted) - min(shifted) < 180.0:
            lons = shifted
    west, east = min(lons) - pad_deg, max(lons) + pad_deg
    if west < -180.0:
        return LonSpan(west + 360.0, east, True)
    if east > 180.0:
        return LonSpan(west, east - 360.0, True)
    return LonSpan(west, east, False)


def within_span(lon: float, lat: float, lat_span: tuple[float, float], lon_span: LonSpan) -> bool:
    """(lon, lat) containment against a latitude range and a wrap-aware span."""
    return lat_span[0] <= lat <= lat_span[1] and lon_span.contains(lon)


def nearest_point(
    origin: LonLat,
    candidates: Iterable[tuple[str, float, float, Any]],
    *,
    subject: str = "POINT",
    max_radius_m: float = 200_000.0,
) -> Distance:
    """Nearest candidate by true geodesic distance, in two phases.

    A cheap planar pre-filter narrows thousands of candidates to a few, then the exact
    ellipsoidal distance picks the winner. Beyond ``max_radius_m`` the answer is
    OUT_OF_RANGE, not a large number.
    """
    origin.validate()
    prefilter = max_radius_m / _M_PER_DEG_LAT + 1.0
    survivors: list[tuple[str, float, float, Any]] = []
    for feature_id, lon, lat, payload in candidates:
        try:
            clon, clat = unwrap_lon(float(lon), origin.lon), float(lat)
        except (TypeError, ValueError):
            continue
        if abs(clon - origin.lon) <= prefilter and abs(clat - origin.lat) <= prefilter:
            survivors.append((feature_id, clon, clat, payload))

    if not survivors:
        return Distance(None, DistanceMethod.GEODESIC_METER, DistanceResult.OUT_OF_RANGE,
                        subject, None, max_radius_m)

    best_id: str | None = None
    best_d = math.inf
    for feature_id, clon, clat, _payload in survivors:
        # `unwrap_lon` is a DIFFERENCING aid and produces values outside [-180, 180]
        # so a crossing pair can be compared naively. pyproj wants a valid longitude,
        # so it is normalised back before the geodesic is asked for the real
        # distance. Without this, a candidate at 179E found from a target at 179.5W
        # is unwrapped to -181 and handed to pyproj as an invalid longitude.
        d = geodesic_m(origin.lon, origin.lat, _wrap(clon), clat)
        if d < best_d:
            best_id, best_d = feature_id, d

    if best_d > max_radius_m:
        return Distance(None, DistanceMethod.GEODESIC_METER, DistanceResult.OUT_OF_RANGE,
                        subject, None, max_radius_m)
    return Distance(round(best_d, 1), DistanceMethod.GEODESIC_METER,
                    DistanceResult.MEASURED, subject, best_id, max_radius_m)
