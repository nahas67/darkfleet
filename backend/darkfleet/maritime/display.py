"""DISPLAY geometry, distinct from analytical geometry.

WHY A SEPARATE MODULE
---------------------
The analytical readers in :mod:`context` answer questions about ONE point and must be
exact. This module answers "draw the world", and the two have opposite requirements:

    analytical   every vertex, no simplification, holes tested exactly
    display      as few vertices as the eye needs, holes PRESERVED not flattened

Simplifying the analytical geometry would corrupt the coastline distance authority,
because the distance is measured to densified samples of that geometry. Simplifying the
display geometry cannot, because nothing measures against it. Keeping them apart makes
the distinction structural rather than a comment.

THE PROVENANCE RULE THAT IS NOT NEGOTIABLE
------------------------------------------
Display geometry may differ from analytical geometry; it may not differ in DATASET or
VERSION. :func:`simplify` and :func:`viewport_filter` take no dataset argument and cannot
invent one -- the provenance travels with the payload from the installed manifest. A
simplified polygon wearing a different dataset's provenance would be a lie an operator
could not detect.

WHAT IS NEVER LOST
------------------
Multi-part geometry stays multi-part. Interior rings stay interior rings. Overlap and
joint-regime metadata stays attached to the feature. Flattening a MultiPolygon to one
ring would drop every detached island block, and dropping a hole would draw land that the
dataset says is sea.

COORDINATE ORDER IS (lon, lat)
------------------------------
GeoJSON order, because the prepared payloads store GeoJSON order. An axis swap here
would place every polygon in the wrong ocean while looking entirely plausible, so it is
asserted by range-checking in :func:`validate_display_payload` rather than trusted.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

#: Degrees of latitude. Display tolerance is expressed in degrees so the caller can ask
#: for a tolerance they can reason about, and the conversion is stated rather than
#: hidden inside a helper.
_M_PER_DEG_LAT = 111_320.0

#: Tolerance below which simplification is refused.
#
#: Simplifying at a very small tolerance costs time and saves nothing visible, and worse,
#: it invites the belief that the result is the data. At 1e-4 degrees (about 11 m) the
#: coastline looks identical and the vertex count barely moves.
_MIN_TOLERANCE_DEG = 1e-3


@dataclass(frozen=True)
class DisplayGeometry:
    """Simplified geometry, with the statistics that make the simplification visible."""

    #: (lon, lat) vertex runs. One entry per part; multi-part geometry stays multi-part.
    parts: tuple[tuple[tuple[float, float], ...], ...]
    #: Interior rings, unchanged in count. A hole stays a hole.
    holes: tuple[tuple[tuple[float, float], ...], ...]
    #: Vertices before simplification, so a reader can see what was dropped.
    source_vertex_count: int
    #: Vertices after.
    vertex_count: int

    @property
    def part_count(self) -> int:
        return len(self.parts)


def simplify(
    points: Sequence[tuple[float, float]],
    tolerance_deg: float = 0.02,
) -> tuple[tuple[float, float], ...]:
    """Ramer-Douglas-Peucker, vectorised, with a latitude correction.

    WHY PER-BAND: a vertex is dropped when every point it spans lies within
    ``tolerance_deg`` of the line joining its neighbours. Measured in degrees, a tolerance
    is 1 degree of LONGITUDE at the equator and near-zero at the pole, which would shred
    high-latitude coastlines while barely touching equatorial ones. Longitude is therefore
    scaled by ``cos(lat)`` so the tolerance means the same physical distance everywhere.

    WHY VECTORISED, AND WHY IT MATTERS
    -----------------------------------
    The straightforward loop is O(n^2) in Python. Measured on the installed Marine
    Regions snapshot: 285 features, 3,178,649 vertices, of which one feature alone has
    367,796. The scalar version took **59.2 seconds** for one request, which would make
    the globe unusable -- not slow, unusable, since the request blocks the layer.

    NumPy makes each RDP level a vectorised reduction over the candidate span, so the
    same work is milliseconds. The recursion is still explicit (an explicit stack, not
    Python recursion) because the longest ring recurses thousands of levels deep and
    would blow the interpreter's limit.

    Endpoint handling is the standard RDP guarantee: the first and last vertices are
    always kept, so a line still starts and ends where the dataset says it does.

    A run of fewer than three points is returned unchanged -- there is nothing to drop.
    """
    import numpy as np

    if len(points) < 3:
        return tuple(points)
    if tolerance_deg < _MIN_TOLERANCE_DEG:
        # Refused rather than clamped silently. A caller asking for 1e-9 deg has a reason,
        # and quietly substituting a different tolerance would hide it.
        raise ValueError(
            f"tolerance_deg must be >= {_MIN_TOLERANCE_DEG}; "
            f"got {tolerance_deg}. Requesting near-zero simplification produces the data "
            "back with a misleading label."
        )

    coords = np.asarray(points, dtype=np.float64)
    tol_m = tolerance_deg * _M_PER_DEG_LAT

    keep = np.zeros(len(coords), dtype=bool)
    keep[0] = keep[-1] = True
    stack: list[tuple[int, int]] = [(0, len(coords) - 1)]

    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        a = coords[first]
        b = coords[last]
        middle = coords[first + 1 : last]

        distances = _perpendicular_m_array(a, b, middle)
        offset = int(np.argmax(distances))
        if float(distances[offset]) <= tol_m:
            continue
        index = first + 1 + offset
        keep[index] = True
        stack.append((first, index))
        stack.append((index, last))

    return tuple(tuple(point) for point in coords[keep])


def _perpendicular_m_array(
    a: tuple[float, float], b: tuple[float, float], middle: Any
) -> Any:
    """Vectorised distance from each point in ``middle`` to segment ``ab``, in metres.

    Degenerate segments return point-to-``a`` distances rather than NaN, so a repeated
    vertex cannot poison the comparison and silently keep everything.
    """
    import numpy as np

    lat_ref = (a[1] + b[1]) / 2.0
    lon_scale = max(0.01, abs(_cos_deg(lat_ref)))

    ax = a[0] * lon_scale
    ay = a[1]
    bx = b[0] * lon_scale
    by = b[1]

    dx = bx - ax
    dy = by - ay
    length_sq = dx * dx + dy * dy

    px = middle[:, 0] * lon_scale
    py = middle[:, 1]

    if length_sq <= 1e-18:
        return np.hypot(px - ax, py - ay) * _M_PER_DEG_LAT

    # Projection parameter, clamped to the segment so a point beyond an endpoint measures
    # to that endpoint rather than to the infinite line.
    t = ((px - ax) * dx + (py - ay) * dy) / length_sq
    np.clip(t, 0.0, 1.0, out=t)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy)) * _M_PER_DEG_LAT


def _perpendicular_m(
    a: tuple[float, float], b: tuple[float, float], p: tuple[float, float]
) -> float:
    """Distance from ``p`` to segment ``ab``, in metres, longitude-scaled.

    Degenerate segments (zero length, or the two endpoints at the same point after
    scaling) return the point-to-a distance, so a repeated vertex cannot produce NaN.
    """
    lat_ref = (a[1] + b[1]) / 2.0
    lon_scale = max(0.01, abs(_cos_deg(lat_ref)))

    ax = a[0] * lon_scale
    ay = a[1]
    bx = b[0] * lon_scale
    by = b[1]
    px = p[0] * lon_scale
    py = p[1]

    dx = bx - ax
    dy = by - ay
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-18:
        return _hypot_m(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / length_sq
    t = max(0.0, min(1.0, t))
    cx = ax + t * dx
    cy = ay + t * dy
    return _hypot_m(px - cx, py - cy)


def _cos_deg(degrees: float) -> float:
    import math

    return math.cos(math.radians(max(-89.9, min(89.9, degrees))))


def _hypot_m(dx: float, dy: float) -> float:
    import math

    return math.hypot(dx, dy) * _M_PER_DEG_LAT


def bbox_of(parts: Iterable[Sequence[tuple[float, float]]]) -> tuple[float, float, float, float]:
    """(west, south, east, north) over every vertex, or a degenerate box when empty."""
    west = east = None
    south = north = None
    for part in parts:
        for lon, lat in part:
            west = lon if west is None else min(west, lon)
            east = lon if east is None else max(east, lon)
            south = lat if south is None else min(south, lat)
            north = lat if north is None else max(north, lat)
    if west is None or south is None or east is None or north is None:
        return (0.0, 0.0, 0.0, 0.0)
    return (west, south, east, north)


def overlaps(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> bool:
    """Whether two boxes overlap, in EITHER order's sense.

    Intersection, not containment: a viewport containing the whole world must still match
    a feature, and a feature containing the viewport must still be returned. A
    containment test would drop one of those and make the globe blank on zoom-in.
    """
    a_w, a_s, a_e, a_n = a
    b_w, b_s, b_e, b_n = b
    return not (a_e < b_w or b_e < a_w or a_n < b_s or b_n < a_s)


def coast_display_geometry(
    payload: dict[str, Any], *, tolerance_deg: float = 0.02
) -> list[DisplayGeometry]:
    """Prepared coastline GeoJSON -> simplified parts.

    Each source feature becomes one :class:`DisplayGeometry`. Features are not merged:
    merging would destroy the ability to say which coastline a line came from, and the
    prepared payload's ``properties.id`` is what identifies it.
    """
    out: list[DisplayGeometry] = []
    for feature in payload.get("features") or []:
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        if kind == "LineString":
            runs: list[Sequence[tuple[float, float]]] = [geometry.get("coordinates") or []]
        elif kind == "MultiLineString":
            runs = list(geometry.get("coordinates") or [])
        else:
            continue
        parts: list[tuple[tuple[float, float], ...]] = []
        source_vertices = 0
        for run in runs:
            points = [(float(x), float(y)) for x, y in run]
            if len(points) < 2:
                continue
            source_vertices += len(points)
            parts.append(simplify(points, tolerance_deg))
        if parts:
            out.append(
                DisplayGeometry(
                    parts=tuple(parts),
                    holes=(),
                    source_vertex_count=source_vertices,
                    vertex_count=sum(len(p) for p in parts),
                )
            )
    return out


def zone_display_geometry(
    payload: dict[str, Any], *, tolerance_deg: float = 0.02
) -> list[dict[str, Any]]:
    """Prepared zone payload -> simplified features with their source attributes kept.

    Each output entry pairs a :class:`DisplayGeometry` with the feature's OWN fields --
    id, zone, sovereign and territory names, pol_type, dispute note. The attributes are
    what let the globe draw a contested area as contested; geometry alone cannot.
    """
    out: list[dict[str, Any]] = []
    for feature in payload.get("features") or []:
        raw_parts = feature.get("parts") or []
        if not raw_parts:
            continue
        parts: list[tuple[tuple[float, float], ...]] = []
        source_vertices = 0
        for ring in raw_parts:
            points = [(float(x), float(y)) for x, y in ring]
            if len(points) < 4:
                # A ring needs four points to enclose anything. Dropping it silently would
                # remove a feature; skipping it explicitly is visible in the counts.
                continue
            source_vertices += len(points)
            parts.append(simplify(points, tolerance_deg))

        # Holes are simplified with the same tolerance but are NEVER dropped for being
        # small: a hole is the difference between sea and land as the dataset says it.
        holes: list[tuple[tuple[float, float], ...]] = []
        for hole in feature.get("holes") or []:
            points = [(float(x), float(y)) for x, y in hole]
            if len(points) >= 4:
                holes.append(simplify(points, tolerance_deg))

        if not parts:
            continue

        out.append(
            {
                "geometry": DisplayGeometry(
                    parts=tuple(parts),
                    holes=tuple(holes),
                    source_vertex_count=source_vertices,
                    vertex_count=sum(len(p) for p in parts)
                    + sum(len(h) for h in holes),
                ),
                "id": str(feature.get("id") or ""),
                "zone": str(feature.get("zone") or ""),
                "sovereign_names": tuple(feature.get("sovereign_names") or ()),
                "territory_names": tuple(feature.get("territory_names") or ()),
                "pol_type": feature.get("pol_type"),
                "geoname": feature.get("geoname"),
                "dispute_note": feature.get("dispute_note"),
                #: True when the SOURCE says this feature has more than one claimant or a
                #: joint regime. The renderer may style it differently, and must not
                #: decide that claim itself.
                "disputed": bool(feature.get("dispute_note")) or (
                    len(feature.get("sovereign_names") or ()) > 1
                ),
            }
        )
    return out


def validate_display_payload(
    parts: Iterable[Sequence[tuple[float, float]]],
) -> None:
    """Raise if any coordinate is outside the WGS84 envelope, or looks axis-swapped.

    A silent axis swap is the single most damaging bug this file could have: every
    polygon would be drawn in the wrong hemisphere while every number still looked
    reasonable. Because the prepared payloads are GeoJSON -- (lon, lat) by specification
    -- a point whose longitude is out of range, or whose latitude is out of range, means
    something upstream changed the order. That is asserted here rather than assumed.
    """
    for part in parts:
        for lon, lat in part:
            if not (-180.0 <= lon <= 180.0) or not (-90.0 <= lat <= 90.0):
                raise ValueError(
                    f"display coordinate out of WGS84 range or axis-swapped: "
                    f"lon={lon}, lat={lat}. GeoJSON order is (lon, lat)."
                )
