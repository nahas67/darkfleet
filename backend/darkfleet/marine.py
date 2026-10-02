"""Named marine regions, so evidence can name the water body it came from (GEO-001).

A detection reported as a bare coordinate pair is less useful than one reported as
"1.2634 N, 103.8102 E in the Strait of Malacca". This module resolves a position
to the named seas, gulfs, straits and bays that contain it, plus a coarse
open-ocean basin when no named region matches.

Provenance
----------
Data: Natural Earth ``ne_10m_geography_marine_polys``, 292 named features.
**Public domain** (naturalearthdata.com) -- no attribution legally required.
Source commit ``ca96624a56bd078437bca8184e78163e5039ad19``, fetched
2026-07-28T01:36:39Z. Curation: outer rings only, Douglas-Peucker at 0.01 deg,
coordinates rounded to 3 decimals (~110 m), rings stored open.

Known limitation, carried forward rather than hidden: **Luzon Strait and Drake
Passage are absent from this pack.** Both are sliver-only in the upstream
source, so the pack's own curation dropped them. A position in the Luzon Strait
therefore resolves to a basin or to nothing, and callers must treat "no named
region" as an ordinary answer rather than as an error.

The file format is bespoke, not GeoJSON::

    {"meta": {...},
     "features": [{"name": str, "featurecla": str,
                   "polygons": [[[lon, lat], ...], ...]}]}

Each polygon is one open outer ring. There are no holes, by construction.
"""

from __future__ import annotations

import functools
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_DATA_FILE = Path(__file__).with_name("data") / "marine_regions.json"

#: Coarse open-ocean basins, used only where no named polygon in the pack covers
#: the position (the pack's ocean polygons leave gaps, for example the eastern
#: Pacific off Central America).
#:
#: These are a CONVENTION, not a survey. The boundaries are longitude bands in
#: the temperate/tropical belt plus latitude cuts for the polar caps, chosen so
#: that the bands do not overlap and leave no gap. Hand-tuned lat/lon boxes were
#: tried first and had both a coverage hole at 16N 92W and a wrap bug, which is
#: why the rule is stated as bands instead of rectangles.
ARCTIC_LAT = 66.0
SOUTHERN_LAT = -60.0
#: (name, min_lon, max_lon) within the belt. Half-open: min inclusive, max exclusive.
_BELT_BANDS: tuple[tuple[str, float, float], ...] = (
    ("Atlantic", -70.0, 20.0),
    ("Indian", 20.0, 70.0),
    # Closes the belt: 70E..180 and -180..-70W are one ocean.
    ("Pacific", 70.0, 180.0),
    ("Pacific", -180.0, -70.0),
)


def open_ocean_basins() -> tuple[str, ...]:
    """The basin names this module can fall back to."""
    return (
        "Arctic Ocean",
        "North Atlantic Ocean",
        "South Atlantic Ocean",
        "Indian Ocean",
        "North Pacific Ocean",
        "South Pacific Ocean",
        "Southern Ocean",
    )


@dataclass(frozen=True)
class MarineRegion:
    """One named marine polygon from the Natural Earth pack."""

    name: str
    classification: str
    #: Rings of open ``(lon, lat)`` vertices.
    rings: tuple[tuple[tuple[float, float], ...], ...]
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float

    def contains(self, lon: float, lat: float) -> bool:
        if not (
            self.min_lon <= lon <= self.max_lon and self.min_lat <= lat <= self.max_lat
        ):
            return False
        return any(_point_in_ring(lon, lat, ring) for ring in self.rings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "classification": self.classification,
            "bounds": [self.min_lon, self.min_lat, self.max_lon, self.max_lat],
            "ring_count": len(self.rings),
        }


def _point_in_ring(lon: float, lat: float, ring: tuple[tuple[float, float], ...]) -> bool:
    """Ray-casting point-in-polygon on an OPEN ring.

    The ring is closed implicitly by the algorithm's wraparound, which is why the
    pack stores rings open.
    """
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            # Latitude of the edge crossing, interpolated in longitude.
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def _bbox_of(ring: tuple[tuple[float, float], ...]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


@functools.lru_cache(maxsize=1)
def load_regions() -> tuple[MarineRegion, ...]:
    """Load and index the pack once. Malformed entries are skipped, not fatal."""
    if not _DATA_FILE.exists():  # pragma: no cover - packaging failure
        return ()
    payload = json.loads(_DATA_FILE.read_text(encoding="utf-8"))
    regions: list[MarineRegion] = []
    for feature in payload.get("features") or []:
        name = feature.get("name")
        if not isinstance(name, str) or not name:
            continue
        rings: list[tuple[tuple[float, float], ...]] = []
        for raw_ring in feature.get("polygons") or []:
            try:
                ring = tuple((float(p[0]), float(p[1])) for p in raw_ring)
            except (TypeError, ValueError, IndexError):
                continue
            if len(ring) >= 3:
                rings.append(ring)
        if not rings:
            continue
        bounds = [_bbox_of(r) for r in rings]
        regions.append(
            MarineRegion(
                name=name,
                classification=str(feature.get("featurecla") or ""),
                rings=tuple(rings),
                min_lon=min(b[0] for b in bounds),
                min_lat=min(b[1] for b in bounds),
                max_lon=max(b[2] for b in bounds),
                max_lat=max(b[3] for b in bounds),
            )
        )
    # Smallest bounding box first: a strait must win over the sea that contains
    # it, and the pack has no explicit nesting order.
    regions.sort(key=lambda r: (r.max_lon - r.min_lon) * (r.max_lat - r.min_lat))
    return tuple(regions)


def region_names_at(lat: float, lon: float) -> tuple[str, ...]:
    """Named marine regions containing a position, most specific first."""
    return tuple(r.name for r in load_regions() if r.contains(lon, lat))


def _position_is_valid(lat: float, lon: float) -> bool:
    """Reject coordinates that cannot be located at all.

    An out-of-range or non-finite longitude does not wrap into a neighbouring
    basin: longitude 200.0E would silently read as 160.0W and return a confident,
    entirely fabricated ocean name. Refusing is the only honest answer.
    """
    if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
        return False
    if not math.isfinite(float(lat)) or not math.isfinite(float(lon)):
        return False
    return -90.0 <= float(lat) <= 90.0 and -180.0 <= float(lon) <= 180.0


def named_region_at(lat: float, lon: float) -> str | None:
    """The single most specific named region, or None.

    None is an ordinary answer: the position may be open ocean outside every
    named polygon, may be in the Luzon Strait (absent from the pack), or may be
    a coordinate that cannot be located at all.
    """
    if not _position_is_valid(lat, lon):
        return None
    hits = region_names_at(lat, lon)
    return hits[0] if hits else None


def basin_at(lat: float, lon: float) -> str | None:
    """Coarse open-ocean basin. A fallback, never presented as a surveyed name.

    Latitude splits the polar caps off first, then longitude bands assign the
    temperate/tropical belt. The bands are exhaustive and disjoint, so every
    valid on-Earth position gets exactly one basin.
    """
    if not _position_is_valid(lat, lon):
        return None
    if lat >= ARCTIC_LAT:
        return "Arctic Ocean"
    if lat <= SOUTHERN_LAT:
        return "Southern Ocean"
    base = next(
        (name for name, lo, hi in _BELT_BANDS if lo <= lon < hi),
        None,
    )
    if base is None:
        return None
    north = lat >= 0.0
    if base == "Atlantic":
        return "North Atlantic Ocean" if north else "South Atlantic Ocean"
    if base == "Pacific":
        return "North Pacific Ocean" if north else "South Pacific Ocean"
    return "Indian Ocean"


def describe_position(lat: float, lon: float) -> dict[str, Any]:
    """Full position context for an evidence record.

    ``kind`` is one of ``named_region``, ``open_ocean``, ``unresolved`` or
    ``invalid_position``, so a caller can tell a surveyed name from a coarse
    fallback, from nothing at all, and from a coordinate that is not a position.
    Nothing here is ever invented: with no match the result says so.
    """
    if not _position_is_valid(lat, lon):
        return {
            "kind": "invalid_position",
            "named_regions": [],
            "primary": None,
            "basin": None,
            "note": (
                f"Coordinates ({lat}, {lon}) are outside the valid range or are not "
                "finite, so no water body can be named. This is a data fault, not an "
                "absence of AIS."
            ),
        }
    regions = load_regions()
    if not regions:
        return {
            "kind": "unresolved",
            "named_regions": [],
            "primary": None,
            "basin": None,
            "note": "Marine region pack unavailable; no named region can be asserted.",
        }
    named = region_names_at(lat, lon)
    if named:
        return {
            "kind": "named_region",
            "named_regions": list(named),
            "primary": named[0],
            "basin": basin_at(lat, lon),
            "note": None,
        }
    basin = basin_at(lat, lon)
    return {
        "kind": "open_ocean" if basin else "unresolved",
        "named_regions": [],
        "primary": None,
        "basin": basin,
        "note": (
            "No named marine polygon at this scale. Luzon Strait and Drake Passage "
            "are absent from the source pack, so a position inside one may resolve "
            "to a basin or to nothing."
            if basin is None
            else "Outside every named marine polygon; showing a coarse ocean basin."
        ),
    }


def provenance() -> dict[str, Any]:
    """Attribution block for the evidence record and the docs."""
    meta: dict[str, Any] = {}
    if _DATA_FILE.exists():
        raw = json.loads(_DATA_FILE.read_text(encoding="utf-8"))
        meta = raw.get("meta") or {}
    return {
        "dataset": "Natural Earth 10m physical vectors",
        "layer": "ne_10m_geography_marine_polys",
        "license": "Public domain (naturalearthdata.com)",
        "attribution_required": False,
        "credit": "Made with Natural Earth",
        "source_commit": meta.get("commit"),
        "fetched": meta.get("fetched"),
        "feature_count": len(load_regions()),
        "known_absent": ["Luzon Strait", "Drake Passage"],
    }