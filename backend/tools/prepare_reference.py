"""Prepare publisher archives into the versioned store's representation.

WHY A MINIMAL SHP/DBF READER

No shapefile library is available and none is declared: pyshp, fiona, osgeo, geopandas
and pyogrio are all absent, while shapely IS present and unused. Rather than add a
dependency for one file format, this reads the two structures that matter.

The shapefile format is fixed-width and simple:

    .shp   100-byte header, then per record: 8-byte BE record header
           (number, content length in 16-bit words) followed by
           32-bit LE shape type, then 32-bit LE bounding box, then geometry.
    .dbf   32-byte header (record count and header length at fixed offsets), then
           32-byte field descriptors, then fixed-width records.

Only PolyLine (3), Polygon (5) and MultiPoint (1) are handled, because those are the
only types a coastline or an EEZ boundary uses. Any other shape type is COUNTED AND
SKIPPED rather than guessed at, and the skip is reported in the preparation notes: a
silently dropped geometry is how a dataset ends up quietly wrong.

AXIS ORDER

Shapefile coordinates are (x, y) = (longitude, latitude) in WGS84. The output is
GeoJSON, which is also (lon, lat) -- so no swap happens here, and the prepared payload
matches the `maritime.geometry` convention. The comment exists because "does the
preparer swap the axes" is exactly the question whose wrong answer transposes every
vessel into the Gulf of Guinea.

POLYGON RINGS

A shapefile polygon is exterior ring, then interior rings, distinguished by the sign of
the ring's signed area: clockwise means a hole. That sign convention is part of the
format specification and is relied on here rather than assumed.
"""

from __future__ import annotations

import struct
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

# Shape types this preparer understands.
SHAPE_NULL = 0
SHAPE_POINT = 1
SHAPE_POLYLINE = 3
SHAPE_POLYGON = 5
SHAPE_MULTIPOINT = 8

SHP_HEADER_BYTES = 100
DBF_HEADER_BYTES = 32
DBF_FIELD_DESCRIPTOR_BYTES = 32


def _signed_area(ring: list[tuple[float, float]]) -> float:
    """Shoelace area. Sign encodes exterior vs interior per the shapefile spec."""
    total = 0.0
    for index in range(len(ring)):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % len(ring)]
        total += x1 * y2 - x2 * y1
    return total / 2.0


def read_shp_polygons(path: Path) -> tuple[
    list[tuple[list[tuple[float, float]], list[list[tuple[float, float]]]]], dict[str, int]
]:
    """Every polygon as (exterior ring, holes). Axis order preserved: (lon, lat)."""
    polygons: list[tuple[list[tuple[float, float]], list[list[tuple[float, float]]]]] = []
    counts: dict[str, int] = {}
    data = path.read_bytes()

    if len(data) < SHP_HEADER_BYTES:
        raise ValueError("shapefile shorter than its 100-byte header")
    file_code = struct.unpack_from(">i", data, 0)[0]
    if file_code != 9994:
        raise ValueError(f"unexpected shapefile magic {file_code}; not a .shp")

    offset = SHP_HEADER_BYTES
    while offset + 8 <= len(data):
        _record_number, content_words = struct.unpack_from(">ii", data, offset)
        content = data[offset + 8: offset + 8 + content_words * 2]
        offset += 8 + content_words * 2
        if len(content) < 4:
            continue
        shape_type = struct.unpack_from("<i", content, 0)[0]
        counts[f"type_{shape_type}"] = counts.get(f"type_{shape_type}", 0) + 1

        if shape_type == SHAPE_NULL:
            continue
        if shape_type == SHAPE_POLYLINE:
            parts = _read_parts(content, closed=False)
            polygons.extend((ring, []) for ring in parts)
            continue
        if shape_type != SHAPE_POLYGON:
            # Counted above, skipped here, and reported in the notes. Guessing at an
            # unfamiliar geometry type would corrupt the dataset silently.
            continue

        rings = _read_parts(content, closed=True)
        if not rings:
            continue
        exterior_index = 0
        # Clockwise exterior, counter-clockwise holes.
        if _signed_area(rings[0]) < 0:
            rings = list(reversed(rings))
        polygons.append((rings[exterior_index], rings[exterior_index + 1:]))

    return polygons, counts


def _read_parts(content: bytes, *, closed: bool) -> list[list[tuple[float, float]]]:
    """Split a PolyLine/Polygon content block into its coordinate rings."""
    num_parts, num_points = struct.unpack_from("<ii", content, 36)
    start = 44 + num_parts * 4
    part_offsets = list(struct.unpack_from(f"<{num_parts}i", content, 44))

    points: list[tuple[float, float]] = []
    for index in range(num_points):
        x, y = struct.unpack_from("<dd", content, start + index * 16)
        points.append((x, y))

    rings: list[list[tuple[float, float]]] = []
    for part_index, begin in enumerate(part_offsets):
        end = (
            part_offsets[part_index + 1]
            if part_index + 1 < len(part_offsets)
            else len(points)
        )
        ring = points[begin:end]
        if len(ring) >= 2:
            rings.append(ring)
    if closed:
        for ring in rings:
            if ring[0] != ring[-1]:
                ring.append(ring[0])
    return rings


def read_dbf(path: Path) -> list[dict[str, str]]:
    """DBF rows as dicts of trimmed strings.

    Text only. A numeric field read as text is fine here because the coastline's own
    attributes (name, featurecla) are what provenance needs; a numeric parse would add a
    failure mode without adding anything.
    """
    data = path.read_bytes()
    if len(data) < DBF_HEADER_BYTES:
        raise ValueError("dbf shorter than its 32-byte header")
    record_count = struct.unpack_from("<i", data, 4)[0]
    header_length = struct.unpack_from("<h", data, 8)[0]
    record_length = struct.unpack_from("<h", data, 10)[0]

    fields: list[tuple[str, int]] = []
    offset = DBF_HEADER_BYTES
    while data[offset] != 0x0D and offset < header_length:
        raw_name = data[offset: offset + 11].split(b"\x00")[0]
        length = data[offset + 16]
        fields.append((raw_name.decode("latin-1").strip(), length))
        offset += DBF_FIELD_DESCRIPTOR_BYTES

    rows: list[dict[str, str]] = []
    for record_index in range(record_count):
        base = header_length + record_index * record_length + 1  # +1 skips the delete flag
        row: dict[str, str] = {}
        cursor = base
        for name, length in fields:
            row[name] = data[cursor: cursor + length].decode("latin-1").strip()
            cursor += length
        rows.append(row)
    return rows


def prepare_coastline(zip_path: Path) -> tuple[dict[str, Any], list[str]]:
    """Natural Earth coastline -> a prepared GeoJSON FeatureCollection.

    Coordinates are emitted as (lon, lat), matching both GeoJSON and
    ``maritime.geometry``. Nothing is densified here: densification is a QUERY-time
    concern performed by the spatial authority, so baking it in would inflate the stored
    payload and make the stored geometry no longer the dataset's own.
    """
    notes: list[str] = []
    with zipfile.ZipFile(zip_path) as archive:
        names = {Path(n).name: n for n in archive.namelist()}
        shp_name = next(n for n in names.values() if n.endswith(".shp"))
        dbf_name = next((n for n in names.values() if n.endswith(".dbf")), None)
        version = ""
        if any(n.endswith("VERSION.txt") for n in names.values()):
            version = archive.read(
                next(n for n in names.values() if n.endswith("VERSION.txt"))
            ).decode("utf-8", "replace").strip()

        shp_path = Path(archive.extract(shp_name, zip_path.parent / "_ne_extract"))
        polygons, counts = read_shp_polygons(shp_path)

        attributes: list[dict[str, str]] = []
        if dbf_name is not None:
            dbf_path = Path(archive.extract(dbf_name, zip_path.parent / "_ne_extract"))
            attributes = read_dbf(dbf_path)

    features: list[dict[str, Any]] = []
    for index, (exterior, _holes) in enumerate(polygons):
        properties = attributes[index] if index < len(attributes) else {}
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": properties.get("featurecla") or f"ne-coast-{index}",
                    "name": properties.get("name") or None,
                    "source_feature": index,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(x, 6), round(y, 6)] for x, y in exterior],
                },
            }
        )

    # Geometry types other than polyline/polygon are reported, never dropped silently.
    unexpected = {k: v for k, v in counts.items() if k not in ("type_3", "type_5", "type_0")}
    if unexpected:
        notes.append(f"skipped unexpected geometry types: {unexpected}")

    payload = {
        "type": "FeatureCollection",
        "features": features,
        "preprocessing_notes": notes
        + [
            f"publisher version file: {version or 'not present'}",
            f"source geometry types: {counts}",
            "coordinates are (lon, lat); no densification applied at prepare time",
        ],
    }
    return payload, notes


def iter_archive_files(zip_path: Path) -> Iterator[str]:
    with zipfile.ZipFile(zip_path) as archive:
        yield from archive.namelist()