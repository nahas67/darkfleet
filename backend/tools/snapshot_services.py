"""Snapshot an OGC WFS layer into the versioned local store.

WHY A SNAPSHOT RATHER THAN A LIVE QUERY
---------------------------------------
DarkFleet is local-first. A live WFS query at dossier-open time would make every
investigation depend on VLIZ being reachable, and would silently change the answer when
the publisher updates. So the service is consulted ONCE, at explicit install time, and
what it returned is frozen with its retrieval time and digests. Runtime reads only the
snapshot.

WFS 2.0.0 PAGINATION IS HONOURED, NOT ASSUMED AWAY
--------------------------------------------------
``count`` and ``startIndex`` are used in a loop until fewer than ``count`` features come
back. A single request returning the world's EEZ would either be silently truncated or
enormous, and an installer that assumes one request either loses data or hangs. The
service's own ``numberMatched`` is compared against what was stored, so truncation fails
loudly instead of producing a partial dataset that looks complete.

DIGESTS ARE KEPT SEPARATE
-------------------------
``raw_sha256`` covers the bytes as served; ``prepared_sha256`` covers the canonical
prepared representation. Overloading one hash is what caused the DF-X8.4A installer bug,
where a download digest was compared against a re-serialised file.
"""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

#: Features per request. Conservative, because a too-large request is silently capped by
#: some servers -- which would look like "the layer is smaller than it is".
PAGE_SIZE = 50

#: Hard stop, so a service that keeps returning a full page forever cannot loop. Compared
#: against the service's own count, so hitting it is an error rather than a partial save.
MAX_PAGES = 2_000


class ServiceError(RuntimeError):
    """The service failed in a way that must not be papered over."""


def _http_get(url: str, timeout: float = 180.0) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "DarkFleet/1.0 dataset-install", "Accept": "*/*"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise ServiceError(f"{url} -> HTTP {exc.code}") from exc
    except Exception as exc:
        raise ServiceError(f"{url} -> {type(exc).__name__}: {exc}") from exc


def capabilities(base_url: str) -> str:
    """The raw capabilities document, retained as provenance for the snapshot."""
    return _http_get(
        f"{base_url}?"
        + urllib.parse.urlencode(
            {"service": "WFS", "request": "GetCapabilities", "version": "2.0.0"}
        )
    ).decode("utf-8", "replace")


def _feature_count(base_url: str, layer: str) -> int | None:
    """The service's authoritative count, or None when it does not report one."""
    url = f"{base_url}?" + urllib.parse.urlencode({
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": layer, "resultType": "hits", "count": 1,
    })
    body = _http_get(url).decode("utf-8", "replace")
    import re

    for pattern in (r'numberMatched="(\d+)"', r'numberOfFeatures="(\d+)"',
                    r'totalFeatures="(\d+)"'):
        match = re.search(pattern, body)
        if match:
            return int(match.group(1))
    return None


def fetch_layer(
    base_url: str,
    layer: str,
    *,
    page_size: int = PAGE_SIZE,
    progress: Callable[[int, int | None], None] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Page the whole layer and return (features, raw-response-metadata).

    Every response's bytes are hashed as they arrive, so ``raw_sha256`` is a digest of
    exactly what the service sent, in order, without holding a second copy.
    """
    expected = _feature_count(base_url, layer)
    features: list[dict[str, Any]] = []
    raw_digest = hashlib.sha256()
    start = 0
    pages = 0

    while True:
        url = f"{base_url}?" + urllib.parse.urlencode({
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": layer, "outputFormat": "application/json",
            "count": page_size, "startIndex": start,
        })
        raw = _http_get(url)
        raw_digest.update(raw)
        pages += 1
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except ValueError as exc:
            raise ServiceError(
                f"{layer} page at startIndex={start} returned non-JSON "
                f"({len(raw)} bytes)"
            ) from exc

        page = data.get("features") or []
        features.extend(page)
        if progress is not None:
            progress(len(features), expected)
        if len(page) < page_size:
            break
        start += page_size
        if pages >= MAX_PAGES:
            raise ServiceError(f"{layer}: exceeded {MAX_PAGES} pages; aborting rather "
                               "than looping")

    return features, {
        "raw_sha256": raw_digest.hexdigest(),
        "pages": pages,
        "page_size": page_size,
        "service_reported_count": expected,
        "stored_count": len(features),
    }


def geometry_to_rings(geometry: dict[str, Any]) -> list[list[tuple[float, float]]]:
    """Flatten a GeoJSON polygon or multipolygon into exterior rings.

    Only EXTERIOR rings are returned, which is what containment needs; interior rings are
    counted by the caller for the record rather than silently discarded.

    Coordinates are (lon, lat) exactly as GeoJSON specifies, and no axis swap happens
    here. The comment exists because "did the converter swap the axes" is the question
    whose wrong answer places every vessel in the wrong ocean.
    """
    rings: list[list[tuple[float, float]]] = []
    if not geometry:
        return rings
    kind = geometry.get("type")
    if kind == "Polygon":
        candidates = [geometry.get("coordinates") or []]
    elif kind == "MultiPolygon":
        candidates = geometry.get("coordinates") or []
    elif kind == "LineString":
        candidates = [[geometry.get("coordinates") or []]]
    elif kind == "MultiLineString":
        candidates = list(geometry.get("coordinates") or [])
    else:
        return rings
    for polygon in candidates:
        if polygon:
            exterior = polygon[0]
            rings.append([(float(x), float(y)) for x, y in exterior])
    return rings


def prepare_eez(
    features: list[dict[str, Any]],
    *,
    source_feature_count: int | None,
    layer: str,
) -> dict[str, Any]:
    """GeoJSON features -> the prepared zone payload the context service reads.

    Attribute handling follows the source rather than flattening it: sovereign1..3 and
    territory1..3 are kept SEPARATELY, because a dataset naming three claimants must
    report three. Collapsing them into one list of names would be a presentation choice
    that discards which name is a sovereign state and which is a territory.

    ``pol_type`` is preserved because '200NM' versus '12NM' is the difference between an
    EEZ and a territorial sea, and inferring it from the geometry would be a guess.
    """
    prepared: list[dict[str, Any]] = []
    skipped_no_geometry = 0
    multi_claimant = 0
    joint_or_overlapping = 0

    for feature in features:
        properties = dict(feature.get("properties") or {})
        geometry = feature.get("geometry") or {}
        rings = geometry_to_rings(geometry)
        if not rings:
            skipped_no_geometry += 1
            continue

        sovereigns = [properties.get(f"sovereign{i}") for i in (1, 2, 3)]
        territories = [properties.get(f"territory{i}") for i in (1, 2, 3)]
        sovereigns = [s for s in sovereigns if s]
        territories = [t for t in territories if t]
        if len(sovereigns) > 1 or len(territories) > 1:
            multi_claimant += 1

        # A joint regime or an overlapping claim is a REAL condition in this dataset.
        # It is preserved verbatim rather than normalised away, because it is exactly the
        # evidence behind a DISPUTED classification.
        dispute_note = None
        raw_type = (properties.get("pol_type") or "").strip()
        if "joint" in raw_type.lower():
            dispute_note = f"pol_type={raw_type} (joint regime)"
            joint_or_overlapping += 1
        elif properties.get("mrgid_sov2"):
            dispute_note = (
                f"overlapping claim: {', '.join(sovereigns)}"
            )
            joint_or_overlapping += 1

        pol_type = raw_type or None
        zone = "EXCLUSIVE_ECONOMIC_ZONE"
        if "12NM" in raw_type.upper():
            zone = "TERRITORIAL_SEA"
        elif "24NM" in raw_type.upper():
            zone = "CONTIGUOUS_ZONE"
        elif "ARCH" in raw_type.upper():
            zone = "ARCHIPELAGIC_WATERS"
        elif "IW" in raw_type.upper() or "INTERNAL" in raw_type.upper():
            zone = "INTERNAL_WATERS"

        prepared.append(
            {
                "id": str(properties.get("mrgid") or f"mr-{len(prepared)}"),
                "zone": zone,
                # Names kept in their source roles.
                "sovereign_names": tuple(sovereigns),
                "territory_names": tuple(territories),
                "pol_type": pol_type,
                "geoname": properties.get("geoname") or None,
                "area_km2": properties.get("area_km2"),
                "mrgid_eez": properties.get("mrgid_eez"),
                "dispute_note": dispute_note,
                # A ZoneFeature carries ONE ring. Multi-part features are split so each
                # part is independently testable and no part is silently dropped.
                "parts": [[list(point) for point in ring] for ring in rings],
            }
        )

    notes = [
        f"source layer {layer}",
        f"features received {len(features)}",
        f"features prepared {len(prepared)}",
        f"skipped for lack of geometry {skipped_no_geometry}",
        f"multi-sovereign or multi-territory features {multi_claimant}",
        f"features carrying dispute or joint-regime metadata {joint_or_overlapping}",
        "coordinates are (lon, lat); no densification at prepare time",
    ]
    if source_feature_count is not None and source_feature_count != len(features):
        notes.append(
            f"WARNING: service reported {source_feature_count} features, "
            f"stored {len(features)}"
        )

    return {"features": prepared, "preprocessing_notes": tuple(notes)}


def prepare_high_seas(
    features: list[dict[str, Any]],
    *,
    source_feature_count: int | None,
    layer: str,
) -> dict[str, Any]:
    """High seas -> the same zone payload shape, so one reader serves both."""
    prepared: list[dict[str, Any]] = []
    skipped = 0
    for feature in features:
        properties = dict(feature.get("properties") or {})
        geometry = feature.get("geometry") or {}
        rings = geometry_to_rings(geometry)
        if not rings:
            skipped += 1
            continue
        prepared.append(
            {
                "id": str(properties.get("mrgid") or f"hs-{len(prepared)}"),
                "zone": "HIGH_SEAS",
                "sovereign_names": (),
                "territory_names": (),
                "pol_type": None,
                "geoname": properties.get("name") or "High Seas",
                "area_km2": properties.get("area_km2"),
                "mrgid_eez": None,
                "dispute_note": None,
                "parts": [[list(point) for point in ring] for ring in rings],
                # The publisher's own pointer to how these boundaries were derived.
                "source": properties.get("source"),
            }
        )

    notes = [
        f"source layer {layer}",
        f"features received {len(features)}",
        f"features prepared {len(prepared)}",
        f"skipped for lack of geometry {skipped}",
        "used ONLY to answer HIGH_SEAS positively; absence is never read as high seas",
    ]
    if source_feature_count is not None and source_feature_count != len(features):
        notes.append(
            f"WARNING: service reported {source_feature_count}, stored {len(features)}"
        )
    return {"features": prepared, "preprocessing_notes": tuple(notes)}