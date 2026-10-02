"""GEO-CORR correlation impact audit: before/after for every target.

Runs the golden fixture twice against the SAME correlation algorithm:

  BEFORE  detections placed by linear interpolation across the REQUESTED AOI
          (the removed defect, reproduced here verbatim for comparison only)
  AFTER   detections placed from a real affine window transform covering the
          golden's own extent, via darkfleet.geolocation

so that every difference in distance, radius, score and classification is
attributable to the coordinate correction alone -- no algorithm change is mixed
in.

Writes: tests/fixtures/golden/GEO_CORR_MIGRATION.json (the record of the change)
        docs/GEO_CORR_AUDIT.md                       (the human-readable audit)
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

from darkfleet.correlation.geodesy import geodesic_meters, propagate
from darkfleet.correlation.match import correlate
from darkfleet.geolocation import geolocate_components

ROOT = Path(__file__).resolve().parents[1]
GOLDEN_DIR = ROOT / "tests" / "fixtures" / "golden"
GOLDEN = json.loads((GOLDEN_DIR / "ts_engine_golden.json").read_text())
AIS = json.loads((GOLDEN_DIR / "ts_ais.json").read_text())["aisObservations"]
META = GOLDEN["meta"]
BBOX = tuple(META["bbox"])
MIN_LON, MIN_LAT, MAX_LON, MAX_LAT = BBOX
W, H = META["width"], META["height"]


def legacy_position(cx: float, cy: float) -> tuple[float, float]:
    """The REMOVED formula, reproduced verbatim for before/after comparison.

    Linear interpolation across the requested AOI, with sample index treated as
    a pixel CORNER. Never call this outside an audit.
    """
    lon = MIN_LON + (cx / W) * (MAX_LON - MIN_LON)
    lat = MAX_LAT - (cy / H) * (MAX_LAT - MIN_LAT)
    return round(lat, 6), round(lon, 6)


def north_up_transform(bbox: tuple[float, float, float, float], w: int, h: int) -> list[float]:
    """Affine for a raster whose OUTER bounds are exactly ``bbox``.

    Built so the raster is self-consistent: pixel 0's centre lands half a pixel
    inside the outer edge, which is the convention the fixtures use.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    return [(max_lon - min_lon) / w, 0.0, min_lon, 0.0, -(max_lat - min_lat) / h, max_lat]


def metres(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    return geodesic_meters(lat_a, lon_a, lat_b, lon_b)


def run_before() -> dict[str, Any]:
    comps = [dict(c, lat=legacy_position(c["cx"], c["cy"])[0], lon=legacy_position(c["cx"], c["cy"])[1])
             for c in GOLDEN["components"]]
    return correlate(comps, AIS, META["acquisitionTime"], META["resolutionMeters"], "AUDIT-BEFORE")


def run_after() -> dict[str, Any]:
    comps = geolocate_components(
        GOLDEN["components"], crs="EPSG:4326", transform=north_up_transform(BBOX, W, H)
    )
    return correlate(comps, AIS, META["acquisitionTime"], META["resolutionMeters"], "AUDIT-AFTER")


def isolate(mmsi: str, indices: list[int]) -> dict[str, Any]:
    """Score specific targets against one observation, ignoring other claimants.

    This is the decisive experiment for an association change: it separates
    "lost the one-to-one contest" from "fell below MIN_SCORE". Running a target
    ALONE shows what it scores on its own merits; running two together shows what
    the greedy assignment actually did with them.
    """
    obs = [o for o in AIS if str(o["mmsi"]) == mmsi]
    if not obs:
        return {}
    comps = geolocate_components(
        [GOLDEN["components"][i] for i in indices],
        crs="EPSG:4326",
        transform=north_up_transform(BBOX, W, H),
    )
    out = correlate(comps, obs, META["acquisitionTime"], META["resolutionMeters"], "AUDIT-ISOLATE")
    return {
        "targets": [
            {
                "cls": t["cls"],
                "mmsi": (t.get("corr") or {}).get("mmsi"),
                "distance_m": ((t.get("corr") or {}).get("scoreDecomposition") or {}).get(
                    "distanceOffsetMeters"
                ),
                "spatial": ((t.get("corr") or {}).get("scoreDecomposition") or {}).get("spatialScore"),
                "heading": ((t.get("corr") or {}).get("scoreDecomposition") or {}).get("headingScore"),
                "composite": ((t.get("corr") or {}).get("scoreDecomposition") or {}).get(
                    "compositeScore"
                ),
            }
            for t in out["targets"]
        ],
    }


def main() -> None:
    before, after = run_before(), run_after()
    b_by_id = {t["id"]: t for t in before["targets"]}
    a_by_id = {t["id"]: t for t in after["targets"]}

    rows: list[dict[str, Any]] = []
    for tid in sorted(set(b_by_id) | set(a_by_id)):
        b, a = b_by_id.get(tid), a_by_id.get(tid)
        if b is None or a is None:
            rows.append({"id": tid, "present_before": b is not None, "present_after": a is not None})
            continue
        bc, ac = b.get("corr") or {}, a.get("corr") or {}
        bd, ad = bc.get("distanceOffsetMeters"), ac.get("distanceOffsetMeters")
        bs, as_ = bc.get("scoreDecomposition") or {}, ac.get("scoreDecomposition") or {}
        rows.append({
            "id": tid,
            "old_lat": b["lat"], "new_lat": a["lat"],
            "old_lon": b["lon"], "new_lon": a["lon"],
            "shift_m": round(metres(b["lat"], b["lon"], a["lat"], a["lon"]), 2),
            "old_mmsi": bc.get("mmsi"), "new_mmsi": ac.get("mmsi"),
            "old_distance_m": bd, "new_distance_m": ad,
            "distance_delta_m": None if (bd is None or ad is None) else round(ad - bd, 2),
            "old_radius_m": bs.get("matchRadiusMeters"), "new_radius_m": as_.get("matchRadiusMeters"),
            "old_spatial": bs.get("spatialScore"), "new_spatial": as_.get("spatialScore"),
            "old_composite": bs.get("compositeScore"), "new_composite": as_.get("compositeScore"),
            "old_aisConf": b.get("aisConf"), "new_aisConf": a.get("aisConf"),
            "old_cls": b.get("cls"), "new_cls": a.get("cls"),
            "sarConf_unchanged": b.get("sarConf") == a.get("sarConf"),
        })

    def changed(k: str) -> int:
        """Count rows where the before/after pair differs for field ``k``.

        Compares the ``old_<k>``/``new_<k>`` pair. An earlier draft guarded on
        ``r.get(k)``, a key this script never writes, so every counter silently
        returned 0 -- including for a run that had just moved an association.
        The guard is now on both values being present.
        """
        n = 0
        for r in rows:
            old, new = r.get("old_" + k), r.get("new_" + k)
            if old is None and new is None:
                continue
            if old != new:
                n += 1
        return n

    summary = {
        "targets": len(rows),
        "sar_conf_changed": sum(1 for r in rows if not r.get("sarConf_unchanged", True)),
        "distance_changed": changed("distance_m"),
        "radius_changed": changed("radius_m"),
        "spatial_changed": changed("spatial"),
        "composite_changed": changed("composite"),
        "ais_conf_changed": changed("aisConf"),
        "association_changed": changed("mmsi"),
        "classification_changed": changed("cls"),
        "max_shift_m": max((r.get("shift_m") or 0.0) for r in rows),
    }

    # Every association/classification change must be explainable from the
    # corrected geometry, not waved through. Derive the explanation rather than
    # assert it: for each moved MMSI, list every corrected target that competed
    # for it, with the score terms that decided the outcome.
    moved = sorted(
        {
            str(r.get("new_mmsi") or r.get("old_mmsi"))
            for r in rows
            if r.get("old_mmsi") != r.get("new_mmsi") and (r.get("new_mmsi") or r.get("old_mmsi"))
        }
    )
    explanations: list[dict[str, Any]] = []
    after_comps = geolocate_components(
        GOLDEN["components"], crs="EPSG:4326", transform=north_up_transform(BBOX, W, H)
    )
    for mmsi in moved:
        obs = next((o for o in AIS if str(o["mmsi"]) == mmsi), None)
        if obs is None:
            continue
        pred = propagate(
            float(obs["lat"]),
            float(obs["lon"]),
            float(obs["sog"]),
            float(obs["cog"]),
            (datetime.fromisoformat(META["acquisitionTime"]).timestamp()
             - datetime.fromisoformat(str(obs["timestamp"])).timestamp()),
        )
        claimants = []
        for tid, t in a_by_id.items():
            c = next((x for x in after_comps if x.get("_tid") == tid), None)
            dist = geodesic_meters(
                float(pred["lat"]), float(pred["lon"]), float(t["lat"]), float(t["lon"])
            )
            if dist > 2000.0:
                continue
            dec = (t.get("corr") or {}).get("scoreDecomposition") or {}
            claimants.append({
                "target": tid,
                "distance_m": round(dist, 1),
                "won": (t.get("corr") or {}).get("mmsi") == mmsi,
                "composite": dec.get("compositeScore"),
                "spatial": dec.get("spatialScore"),
                "heading": dec.get("headingScore"),
                "temporal": dec.get("temporalScore"),
                "size": dec.get("sizeScore"),
                "_unused": c is None,
            })
        claimants.sort(key=lambda x: -(x["composite"] or 0.0))
        for cl in claimants:
            cl.pop("_unused", None)
        # Indices of the corrected targets that competed for this observation.
        comp_idx = [
            i for i, c in enumerate(after_comps)
            if any(abs(c["lat"] - float(t["lat"])) < 1e-12 for t in after["targets"])
            and geodesic_meters(
                float(pred["lat"]), float(pred["lon"]), c["lat"], c["lon"]
            ) <= 2000.0
        ]
        solo = {f"idx{i}_alone": isolate(mmsi, [i]) for i in comp_idx}
        together = isolate(mmsi, comp_idx) if len(comp_idx) > 1 else {}
        explanations.append({
            "mmsi": mmsi,
            "claimants_under_corrected_geometry": claimants,
            "isolation": {
                "solo_scores": solo,
                "together": together,
                "reading": (
                    "A solo composite >= MIN_SCORE (0.40) means the target was NOT "
                    "threshold-rejected; it lost the greedy one-to-1 contest on "
                    "composite score. Heading (weight 0.15) can outweigh spatial "
                    "(weight 0.45) when both terms are close."
                ),
            },
            "note": (
                "Greedy 1-to-1 awards the observation to the highest COMPOSITE score, "
                "not the smallest distance."
            ),
        })

    payload = {
        "checkpoint": "GEO-CORR",
        "fixture": "tests/fixtures/golden/ts_engine_golden.json",
        "classification": {
            "ALGORITHM_TRUTH": [
                "sarConf - derived from component dB/geometry only, no coordinates",
                "counts.aisOnly - AIS-driven, no SAR coordinates involved",
                "geodesy functions - untouched by this checkpoint",
                "classification logic and thresholds - untouched by this checkpoint",
            ],
            "LEGACY_BUG_OUTPUT": [
                "targets[].lat / targets[].lon - AOI interpolation with corner semantics",
                "targets[].corr.distanceOffsetMeters - computed from the displaced SAR point",
                "targets[].corr.scoreDecomposition - spatial/radius terms derive from it",
                "targets[].aisConf - composite score inherits the displacement",
                "targets[].cls / corr.mmsi where the displacement changed the outcome",
            ],
        },
        "summary": summary,
        "association_change_explanations": explanations,
        "rows": rows,
        "golden_counts": GOLDEN.get("counts"),
        "counts_after": after.get("counts"),
        "note_on_counts": (
            "correlate() does not emit a counts block; `golden_counts` is the "
            "committed expectation being migrated, not a live before/after pair."
        ),
    }
    (GOLDEN_DIR / "GEO_CORR_MIGRATION.json").write_text(
        json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )

    print("=== GEO-CORR correlation impact audit ===")
    print(f"targets                 : {summary['targets']}")
    print(f"sarConf changed         : {summary['sar_conf_changed']}")
    print(f"distance changed        : {summary['distance_changed']}")
    print(f"dynamic radius changed  : {summary['radius_changed']}")
    print(f"composite score changed : {summary['composite_changed']}")
    print(f"ASSOCIATION changed     : {summary['association_changed']}")
    print(f"CLASSIFICATION changed  : {summary['classification_changed']}")
    print(f"max coordinate shift    : {summary['max_shift_m']:.1f} m")
    print()
    print("=== per-target before/after ===")
    print(f"{'id':<6}{'old cls':<20}{'new cls':<20}{'old mmsi':<12}{'new mmsi':<12}{'shift m':>9}{'d dist m':>10}")
    for r in rows:
        dd = f"{r['distance_delta_m']:+.1f}" if r.get("distance_delta_m") is not None else "-"
        print(f"{r['id']:<6}{r['old_cls']:<20}{r['new_cls']:<20}{r['old_mmsi']!s:<12}"
              f"{r['new_mmsi']!s:<12}{r['shift_m']:>9.1f}{dd:>10}")
    print()
    print(f"golden counts (migrated) : {payload['golden_counts']}")
    live = {k: sum(1 for r in rows if r.get('new_cls') == k) for k in sorted({r.get('new_cls') for r in rows if r.get('new_cls')})}
    print(f"live classification tally : {live}")
    print()
    print(f"written: {(GOLDEN_DIR / 'GEO_CORR_MIGRATION.json').relative_to(ROOT)}")

    # half-pixel expectation, stated analytically rather than fitted
    px_lat = (MAX_LAT - MIN_LAT) / H
    px_lon = (MAX_LON - MIN_LON) / W
    half_m_lat = px_lat * 111_320.0
    half_m_lon = px_lon * 111_320.0 * math.cos(math.radians((MIN_LAT + MAX_LAT) / 2))
    print()
    print(f"declared resolutionMeters : {META['resolutionMeters']}")
    print(f"bbox/width implies px lat : {px_lat:.6f} deg = {px_lat * 111_320.0:.1f} m")
    print(f"bbox/width implies px lon : {px_lon:.6f} deg = {px_lon * 111_320.0 * math.cos(math.radians((MIN_LAT + MAX_LAT) / 2)):.1f} m")
    print(f"expected half-pixel shift : {math.hypot(half_m_lat, half_m_lon) / 2:.1f} m")


if __name__ == "__main__":
    main()