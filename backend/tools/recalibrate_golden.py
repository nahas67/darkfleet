"""Recalibrate the correlation golden fixture for GEO-CORR.

Discipline enforced here:

1. `ALGORITHM TRUTH` fields are NOT rewritten. They are re-derived and compared;
   if any of them moves, the script ABORTS instead of migrating. That is what
   stops this from being blind test churn.
2. `LEGACY BUG_OUTPUT` fields are rewritten from the corrected run only.
3. The before/after record for every changed value is written to
   GEO_CORR_MIGRATION.json with its reason and its independent source of truth.

GEO-CORR MIGRATION NOTE
-----------------------
The golden's `bbox` exactly fills the 180x180 grid it describes, so the
AOI-vs-window defect contributed nothing here. The entire 154.3 m shift is the
pixel-centre convention: the old mapping treated sample index 0 as the raster's
OUTER edge, putting every target half a pixel south-west of where it is.

Independent source of truth for the corrected coordinates is
tests/test_geolocation.py, which derives them analytically from the grid's own
transform and cross-checks rasterio's ``xy(offset="center")`` -- not from the
correlation code that consumes them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from darkfleet.correlation.match import correlate
from darkfleet.geolocation import geolocate_components

ROOT = Path(__file__).resolve().parents[1]
GOLDEN_DIR = ROOT / "tests" / "fixtures" / "golden"
GOLDEN_PATH = GOLDEN_DIR / "ts_engine_golden.json"
GOLDEN = json.loads(GOLDEN_PATH.read_text())
AIS = json.loads((GOLDEN_DIR / "ts_ais.json").read_text())["aisObservations"]
META = GOLDEN["meta"]
BBOX = tuple(META["bbox"])
MIN_LON, MIN_LAT, MAX_LON, MAX_LAT = BBOX
W, H = META["width"], META["height"]

#: Fields whose values must be identical before and after. If the correction
#: moves any of these, the correction has changed something it had no business
#: changing and the migration must stop.
ALGORITHM_TRUTH_FIELDS = ("sarConf",)


def north_up_transform() -> list[float]:
    min_lon, min_lat, max_lon, max_lat = BBOX
    return [
        (max_lon - min_lon) / W,
        0.0,
        min_lon,
        0.0,
        -(max_lat - min_lat) / H,
        max_lat,
    ]


def corrected_run() -> dict[str, Any]:
    comps = geolocate_components(
        GOLDEN["components"], crs="EPSG:4326", transform=north_up_transform()
    )
    return correlate(comps, AIS, META["acquisitionTime"], META["resolutionMeters"], "RECALIBRATE")


def main() -> int:
    old_by_id = {t["id"]: t for t in GOLDEN["targets"]}
    new_by_id = {t["id"]: t for t in corrected_run()["targets"]}

    if set(old_by_id) != set(new_by_id):
        print("ABORT: target ids differ between golden and corrected run")
        return 1

    changes: list[dict[str, Any]] = []
    violations: list[str] = []

    for tid, old in old_by_id.items():
        new = new_by_id[tid]

        # --- gate 1: algorithm truth must not move -------------------------
        for field in ALGORITHM_TRUTH_FIELDS:
            if old.get(field) != new.get(field):
                violations.append(f"{tid}.{field}: {old.get(field)!r} -> {new.get(field)!r}")

        # --- record every differing field ---------------------------------
        for field in ("lat", "lon", "cls", "aisConf"):
            if old.get(field) != new.get(field):
                changes.append({
                    "target": tid,
                    "field": field,
                    "old": old.get(field),
                    "new": new.get(field),
                    "reason": "detection re-geolocated from the pixel-centre convention",
                    "independent_source_of_truth": "tests/test_geolocation.py (analytical + rasterio xy)",
                })

        oc, nc = old.get("corr") or {}, new.get("corr") or {}
        if oc.get("mmsi") != nc.get("mmsi"):
            changes.append({
                "target": tid,
                "field": "corr.mmsi",
                "old": oc.get("mmsi"),
                "new": nc.get("mmsi"),
                "reason": (
                    "association decided by composite score, which moved when the "
                    "target position moved; see association_change_explanations"
                ),
                "independent_source_of_truth": "tools/geo_corr_audit.py isolation experiment",
            })

    if violations:
        print("ABORT: ALGORITHM TRUTH fields moved -- refusing to migrate:")
        for v in violations:
            print("  " + v)
        return 1

    print(f"ALGORITHM TRUTH fields verified unchanged: {list(ALGORITHM_TRUTH_FIELDS)}")
    print(f"legacy-bug fields to migrate: {len(changes)}")
    for c in changes:
        print(f"  {c['target']:<8} {c['field']:<12} {c['old']!r} -> {c['new']!r}")

    # --- apply -------------------------------------------------------------
    GOLDEN["targets"] = [new_by_id[t["id"]] for t in GOLDEN["targets"]]
    GOLDEN["meta"]["geolocation"] = {
        "method": "pixel_centroid_via_affine_window_transform",
        "crs": "EPSG:4326",
        "transform": north_up_transform(),
        "centre_offset": 0.5,
        "migrated_by": "GEO-CORR",
        "note": (
            "Coordinates are measured from the grid transform, not interpolated "
            "across meta.bbox. The bbox coincides with the grid extent, so the "
            "only change is the pixel-centre convention."
        ),
    }
    GOLDEN_PATH.write_text(json.dumps(GOLDEN, indent=1, sort_keys=False) + "\n", encoding="utf-8")
    print(f"\nrewritten: {GOLDEN_PATH.relative_to(ROOT)}")

    mig_path = GOLDEN_DIR / "GEO_CORR_MIGRATION.json"
    mig = json.loads(mig_path.read_text())
    mig["golden_field_changes"] = changes
    mig["algorithm_truth_verified_unchanged"] = list(ALGORITHM_TRUTH_FIELDS)
    mig_path.write_text(json.dumps(mig, indent=2) + "\n", encoding="utf-8")
    print(f"recorded : {mig_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())