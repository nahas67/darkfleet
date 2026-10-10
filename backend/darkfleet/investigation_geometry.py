"""Analyst-authored WGS84 geometry and ellipsoidal measurements.

Coordinates are [longitude, latitude] pairs, NOT canvas pixels and NOT SAR
observations. This module is deliberately independent of scan correlation.
"""

from __future__ import annotations

import math
from itertools import pairwise
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pyproj import Geod
from shapely.geometry import Polygon

Kind = Literal["point", "polyline", "polygon", "range_ring"]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Coordinate = tuple[Longitude, Latitude]

_WGS84 = Geod(ellps="WGS84")
_NM_IN_M = 1852.0
_CIRCLE_SEGMENTS = 720


def _unwrapped(points: list[Coordinate]) -> list[tuple[float, float]]:
    """Shortest consecutive longitude path, including an antimeridian crossing."""
    result = [(points[0][0], points[0][1])]
    for lon, lat in points[1:]:
        prev = result[-1][0]
        result.append((prev + (lon - prev + 180) % 360 - 180, lat))
    return result


def _bearing(azimuth: float) -> float:
    return (float(azimuth) + 360.0) % 360.0


class GeometryInput(BaseModel):
    """One operator annotation. Point/range_ring use one vertex.

    For polygon supply open vertices; an optional repeated closing vertex is
    canonicalized away. Server returns precisely those open source vertices.
    """

    model_config = ConfigDict(extra="forbid")
    kind: Kind
    coordinates: list[Coordinate] = Field(min_length=1, max_length=250)
    radius_m: float | None = Field(default=None, ge=1.0, le=2_000_000.0, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if (self.kind == "polygon" and len(self.coordinates) > 3
                and self.coordinates[0] == self.coordinates[-1]):
            self.coordinates = self.coordinates[:-1]
        required = {"point": 1, "range_ring": 1, "polyline": 2, "polygon": 3}[self.kind]
        if len(self.coordinates) < required or (
            self.kind in ("point", "range_ring") and len(self.coordinates) != 1
        ):
            raise ValueError(f"{self.kind} requires {'exactly ' if required == 1 else 'at least '}{required} vertices")
        if self.kind == "range_ring" and self.radius_m is None:
            raise ValueError("range_ring requires radius_m in metres")
        if self.kind != "range_ring" and self.radius_m is not None:
            raise ValueError("radius_m is only valid for range_ring")
        vertices = self.coordinates
        if self.kind in ("polyline", "polygon"):
            for (lon1, lat1), (lon2, lat2) in pairwise(vertices):
                _, _, distance = _WGS84.inv(lon1, lat1, lon2, lat2)
                if not math.isfinite(distance) or distance <= 0:
                    raise ValueError("Adjacent vertices must be geographically distinct")
            if self.kind == "polygon":
                _, _, distance = _WGS84.inv(
                    vertices[-1][0], vertices[-1][1], vertices[0][0], vertices[0][1],
                )
                if not math.isfinite(distance) or distance <= 0:
                    raise ValueError("Polygon closing edge has zero geodesic length")
                if len(set(vertices)) != len(vertices):
                    raise ValueError("A polygon cannot revisit a vertex")
                coords = _unwrapped(vertices)
                if max(lon for lon, _ in coords) - min(lon for lon, _ in coords) >= 180:
                    raise ValueError("Polygon enclosing half the globe is ambiguous")
                shape = Polygon(coords)
                if not shape.is_valid or shape.area == 0:
                    raise ValueError("Polygon self-intersects or has zero area")
        return self


class Measurements(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ellipsoid: Literal["WGS84"] = "WGS84"
    method: str
    length_m: float | None = None
    length_km: float | None = None
    length_nm: float | None = None
    initial_bearing_deg: float | None = None
    perimeter_m: float | None = None
    perimeter_km: float | None = None
    perimeter_nm: float | None = None
    area_m2: float | None = None
    area_km2: float | None = None
    radius_m: float | None = None
    radius_km: float | None = None
    radius_nm: float | None = None


def measure_geometry(geometry: GeometryInput) -> Measurements:
    """Compute authoritative WGS84 metrics from persisted operator vertices."""
    coords = geometry.coordinates
    if geometry.kind == "point":
        return Measurements(method="WGS84 point; distances and area not applicable")
    if geometry.kind == "range_ring":
        assert geometry.radius_m is not None
        origin_lon, origin_lat = coords[0]
        # Geodesic circle with 0.5-degree angular sampling, centered at saved
        # point. Area/perimeter are numerical approximations; radius is exact.
        circle = [
            _WGS84.fwd(origin_lon, origin_lat, angle * 360 / _CIRCLE_SEGMENTS, geometry.radius_m)
            for angle in range(_CIRCLE_SEGMENTS)
        ]
        area, perimeter = _WGS84.polygon_area_perimeter(
            [p[0] for p in circle], [p[1] for p in circle],
        )
        return Measurements(
            method=f"WGS84 geodesic circle; area/perimeter approximated with {_CIRCLE_SEGMENTS} sides",
            perimeter_m=float(perimeter), perimeter_km=perimeter / 1000,
            perimeter_nm=perimeter / _NM_IN_M,
            area_m2=abs(float(area)), area_km2=abs(float(area)) / 1_000_000,
            radius_m=geometry.radius_m, radius_km=geometry.radius_m / 1000,
            radius_nm=geometry.radius_m / _NM_IN_M,
        )
    if geometry.kind == "polyline":
        lengths = []
        bearings = []
        for (lon1, lat1), (lon2, lat2) in pairwise(coords):
            azimuth, _, distance = _WGS84.inv(lon1, lat1, lon2, lat2)
            if not math.isfinite(distance) or distance <= 0:
                raise ValueError("Polyline contains a zero-length geodesic segment")
            lengths.append(float(distance))
            bearings.append(_bearing(azimuth))
        return Measurements(
            method="WGS84 ellipsoidal inverse geodesic segments",
            length_m=sum(lengths), length_km=sum(lengths) / 1000,
            length_nm=sum(lengths) / _NM_IN_M,
            initial_bearing_deg=bearings[0],
        )
    lon, lat = zip(*coords)
    area, perimeter = _WGS84.polygon_area_perimeter(lon, lat)
    first_bearing, _, _ = _WGS84.inv(lon[0], lat[0], lon[1], lat[1])
    if not all(math.isfinite(n) for n in (area, perimeter)) or perimeter <= 0 or area == 0:
        raise ValueError("Polygon has no defensible ellipsoidal measurement")
    return Measurements(
        method="WGS84 ellipsoidal polygon area and closed-perimeter geodesics",
        perimeter_m=float(perimeter), perimeter_km=perimeter / 1000,
        perimeter_nm=perimeter / _NM_IN_M,
        area_m2=abs(float(area)), area_km2=abs(float(area)) / 1_000_000,
        initial_bearing_deg=_bearing(first_bearing),
    )
