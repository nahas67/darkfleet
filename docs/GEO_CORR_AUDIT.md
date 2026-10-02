# GEO-CORR — Pixel Geolocation + Correlation Revalidation

Checkpoint report. **CLOSED — all acceptance gates pass.**

## Result

Detection coordinates were being produced by interpolating linearly across the
**requested** AOI instead of from the **measured window transform**. Every target
was placed where the request asked, not where the pixel was. Because the spatial
score and the dynamic match radius are both computed from that position, the
error propagated into the association and the classification while still
producing plausible-looking numbers — which is why it survived.

Measured on the committed UTM scene, detections sat ~4 km north of the raster
that produced them. Two distinct defects were stacked:

| # | Defect | Size | Invisible because |
|---|--------|------|-------------------|
| 1 | AOI interpolated instead of the window transform | ~4 km | longitude extents happened to coincide |
| 2 | Sample index treated as pixel **corner**, not centre | half a pixel (5 m @ 10 m) | far below visual resolution |

## Root cause

`darkfleet/correlation/match.py::grid_to_wgs84`:

```python
lon = min_lon + (x / width) * (max_lon - min_lon)
lat = max_lat - (y / height) * (max_lat - min_lat)
```

Correct only when the window read exactly fills the requested AOI in the source
CRS. It generally does not: a window is clamped to the raster's own extent, and
an AOI may extend past it.

On the committed scene the raster measured **lat 1.32075..1.35693** while the
requested AOI was **lat 1.35690..1.39310** — the raster lay almost entirely
*outside* the requested box.

## Architecture change

```
BEFORE
  SAR window ──► components (pixel centroids)
                      │
                      ▼
        correlate(components, ais, width, height, bbox, ...)
                      │  ← match.py re-derived lat/lon by interpolating the AOI
                      ▼
                spatial score / dynamic radius / association

AFTER
  SAR window ──► components (pixel centroids)
                      │
                      ▼
        geolocate_components(crs, window_transform)   ← darkfleet/geolocation.py
                      │     lat, lon + provenance
                      ▼
        correlate(components, ais, resolution_m, ...)  ← no bbox, no width, no height
                      │  consumes a measured position; never inspects a raster
                      ▼
                spatial score / dynamic radius / association
```

- `width`, `height` and `bbox` were **removed from `correlate`'s signature**, not
  merely ignored. A parameter that exists invites a caller to pass a bbox and
  trust it — which is the defect.
- A component with no measured position raises `DetectionNotGeolocatedError`.
  Guessing is not a fallback.
- `darkfleet/sar/georef.py::pixel_to_wgs84` was reduced to a **thin adapter** over
  the new module. Two hand-written copies of the same affine arithmetic drift, and
  only one would get the centre convention right.

`GEOLOCATING` is now a real pipeline stage (`ScanStage`), so a scan that silently
misplaced its targets would have been visible.

## Independent geolocation proofs

`backend/tests/test_geolocation.py` — 24 tests. Expected values come from
**analytical arithmetic on the fixture transform**, **rasterio's own
`xy(offset="center")`**, and the **committed `sidecar.json`**. None is derived
from the matching implementation.

| Brief | Test | What it pins |
|-------|------|--------------|
| A | `test_a_pixel_centres_match_analytical_literals` | (0,0), centre, bottom-right against typed-out literals |
| A | `test_a_pixel_centres_agree_with_rasterio_dataset_xy` | equality with `ds.xy()` to 1e-12 |
| A | `test_a_embedded_targets_land_on_their_sidecar_coordinates` | the 3 known vessels from `sidecar.json` |
| A | `test_a_pixel_centres_sit_half_a_pixel_inside_the_outer_bounds` | the half-pixel convention, per axis |
| B | `test_b_window_pixel_equals_the_corresponding_full_raster_coordinate` | **the regression that matters** |
| B | `test_b_scene_transform_instead_of_window_transform_is_measurably_wrong` | proves the guard has teeth (**1112 m**) |
| B | `test_b_window_transform_is_scene_transform_composed_with_the_offset` | the affine identity |
| B | `test_b_inconsistent_window_transform_is_refused_loudly` | wrong transform raises |
| C | `test_c_projected_crs_conversion_within_explicit_tolerance` | pixel → UTM → WGS84, 1e-9 |
| D | `test_d_4326_returns_lat_in_latitude_range_and_lon_in_longitude_range` | non-overlapping ranges; a swap cannot hide |
| D | `test_d_transformer_is_built_with_explicit_xy_axis_order` | `always_xy=True` structurally |
| E | `test_e_float_centroid_keeps_subpixel_position` | exact in source CRS: 2.5 m / 7.5 m |
| E | `test_e_float_centroid_is_not_silently_rounded_to_a_pixel` | sub-pixel survives |
| — | `test_real_vessels_fall_inside_the_measured_raster_bounds` | **headline invariant** |
| — | `test_aoi_interpolation_would_place_vessels_outside_their_own_raster` | proves the invariant is not vacuous |

### The proofs can fail — mutation gate

A test that cannot fail proves nothing. Three defects were injected into
`geolocation.py` and the suite re-run:

| Injected defect | Result |
|---|---|
| `always_xy=True` → `False` (real code) | **6 failed** |
| `centre_offset` 0.5 → 0.0 | **4 failed** |
| coordinates rounded to 4 dp (~11 m) | **5 failed** |

An earlier mutation run appeared to show the axis-order defect going undetected.
That was a **flawed harness**: it replaced the first `always_xy=True`, which is in
a docstring, not in code. Re-run against the actual code line, the defect is
caught. Worth recording because "the mutation survived" was a false negative that
would have wrongly cleared a real gap.

`always_xy` was also measured to be a genuine no-op for `EPSG:4326 → EPSG:4326`
(pyproj short-circuits a same-CRS transform) and a **total output swap** for
`EPSG:32648 → EPSG:4326`. Axis order is therefore only observable on the
projected fixture, and that is where the test asserts it.

## Real scene before/after

Committed UTM fixture, EPSG:32648, 400×400, 10 m pixels. Vessels from
`sidecar.json`; measured raster extent **lat 1.32075..1.35693, lon 104.10111..104.13708**.

| Vessel (row,col) | Old lat/lon (AOI interp) | Correct lat/lon | Shift |
|---|---|---|---|
| (120,200) | outside the raster | 1.34603, 104.11914 | ~4 km N |
| (250,300) | outside the raster | 1.33428, 104.12813 | ~4 km N |
| (310,150) | outside the raster | 1.32884, 104.11465 | ~4 km N |

All three now fall **inside** the measured bounds. This is asserted permanently by
`test_real_vessels_fall_inside_the_measured_raster_bounds`, which also pins the
measured extent itself (`1.32075`, `1.35693`) so a silent fixture change is visible.

## Correlation impact

Full per-target record: `tests/fixtures/golden/GEO_CORR_MIGRATION.json`.
Regenerate with `python tools/geo_corr_audit.py`.

| Measure | Changed |
|---|---|
| targets | 12 |
| `sarConf` | **0** ← proves it is coordinate-independent |
| distance offset | 5 |
| dynamic radius | 2 |
| composite score | 5 |
| **association (MMSI)** | **2** |
| **classification** | **2** |
| max coordinate shift | **154.3 m** |

**Every target shifted 154.2–154.3 m.** The analytic half-pixel prediction for this
fixture is **154.6 m** — agreement to 0.3 m. That confirms the *entire* golden shift
is the corner-vs-centre convention: the golden's `bbox` exactly fills its 180×180
grid, so the AOI-vs-window defect contributes nothing here.

Aggregate counts are **unchanged** (`matched=4, unmatched=7, infra=1, aisOnly=2`).
The association *moved between two targets* rather than appearing or vanishing.

### The association change, explained

DF-005 and DF-006 are distinct detections **1326.7 m apart** (4.71 px E, 3.45 px S),
not one object. Both competed for MMSI 477421900, whose propagated position sits
between them.

| | distance | spatial | heading | composite (solo) |
|---|---|---|---|---|
| DF-005 | 755.8 m | 0.399 | **0.822** | **0.548** ← won |
| DF-006 | **598.1 m** | 0.524 | 0.144 | 0.503 |

DF-006 is *nearer*, but greedy 1-to-1 assignment (`match.py:165`) awards on
**composite**, not distance. The arithmetic closes exactly:

- spatial advantage to DF-006: `0.45 × (0.524 − 0.399)` = **+0.0563**
- heading advantage to DF-005: `0.15 × (0.822 − 0.144)` = **+0.1018**
- net **+0.0455** → observed `0.548 − 0.503 = 0.045` ✓

Decisive control: run each **alone** against that observation. DF-006's solo
composite is **0.503**, above `MIN_SCORE = 0.40`. So it was **not** threshold-rejected —
it lost the one-to-one contest on score. `tools/geo_corr_audit.py` records this
isolation experiment as reproducible data, not prose.

**Honest caveat:** the margin is 0.045, just under `CONFLICT_GAP` (0.05). This is a
marginal association and should not be read as high confidence. No threshold was
weakened to obtain it.

## Golden fixture migration

This was **not** blind regeneration.

**`ALGORITHM TRUTH` — verified unchanged, migration aborts if any moves:**
`sarConf` (derived from component dB/geometry only), `counts.aisOnly`, all geodesy
functions, all classification logic and thresholds.

**`LEGACY BUG OUTPUT` — rewritten:** `targets[].lat/lon`,
`corr.distanceOffsetMeters`, `corr.scoreDecomposition`, `aisConf`, and the two
`cls`/`corr.mmsi` pairs that the displacement changed.

`tools/recalibrate_golden.py` re-derives the truth fields and **aborts** if any
differs, so this cannot be re-run as a rubber stamp:

```
ALGORITHM TRUTH fields verified unchanged: ['sarConf']
legacy-bug fields to migrate: 33
```

Each change is recorded with old value, new value, reason, independent source of
truth and downstream effect. `meta.geolocation` now records the method, CRS,
transform and centre offset, so the fixture explains its own coordinates.

**Fixture inconsistency found, deliberately NOT changed:**
`meta.resolutionMeters` is `10`, but `bbox/width` implies **185.5 m** lat /
**247.3 m** lon pixels. `resolutionMeters` feeds `apparent_len` and therefore
`sizeScore`. It is self-inconsistent and pre-existing; changing it would move size
scores on top of a coordinate migration and confound the two. Reported, not touched.

## Additional defects found and fixed along the way

1. **Silent stage-list drift (three places).** `tests/test_jobs.py` held a
   hand-written copy of the pipeline order; adding `GEOLOCATING` left it stale and
   produced **nine failures on a `KeyError`** rather than on anything about
   geolocation. Now derived from `PIPELINE`, with an assertion that `DETAILS`
   covers every pipeline stage.
2. **Stage union mirrored in the frontend.** `src/types/api.ts` hand-wrote both
   the `ScanStage` union and `SCAN_PIPELINE`. Root cause: the backend typed
   `stage` as a bare `str`, so OpenAPI emitted `{"type":"string"}` and the
   generator had nothing to emit. Fixed at source — `StageEventOut.stage`,
   `ScanStateResponse.stage` and `.failed_at` are now typed `ScanStage`, and
   `export_contract.py` emits `ScanStage` plus an ordered `SCAN_STAGE_ORDER`.
   The frontend derives from the contract; the two literals are gone.
3. **Divide-by-zero in the raster renderer.** `_normalise` computed
   `(clean - lo) / (hi - lo)`. When the percentile window collapses, that is
   `0/0` → **NaN**, which `np.clip` does not remove (the module's own docstring
   says so) and which then rode the `astype(np.uint8)` cast — the exact failure
   mode that had been fixed deliberately, reintroduced accidentally. Now total by
   construction, plus a defensive `nan_to_num`.
4. **Render report claimed a stretch that never happened.** `_stats` silently
   widened a degenerate window by one unit and the report still said "measured
   1st-99th percentile". The committed fixture hits this path — its water
   background is one clamped −90 dB across >98% of pixels. The basis string now
   reads: *"percentile window was degenerate (one value dominates the scene);
   widened to a 1-unit synthetic span, which is NOT a percentile measurement"*.

   This also disproved my own first hypothesis. I had assumed p1 == p99 == −90 and
   written a fallback in `render_png`; it never fired, because `_stats` had already
   widened the window upstream. The dead code was removed rather than left in.

## Uncertainty

`geolocation_uncertainty_m` reports what the source supports and **returns `None`
rather than inventing a figure** for GCP-georeferenced or unreferenced products.
For an affine product with known spacing it returns half the pixel spacing
(0.5 px), documented as an upper bound rather than a measured error, because it
feeds a match radius where understating uncertainty widens false associations.

## Provenance

Each component carries `lat`, `lon`, `geo_source_transform`, `geo_crs`,
`geo_pixel_centroid` and `geo_centre_offset` — enough to explain the coordinate
without a rerun. The full affine matrix is available in evidence/debug provenance
rather than the default UI.

## Gates

| Gate | Result |
|---|---|
| AOI interpolation removed from analytical geolocation | **PASS** — deleted; `correlate` has no bbox/width/height |
| pixel-center semantics documented + tested | **PASS** |
| window transform used | **PASS** |
| projected CRS conversion verified | **PASS** — 1e-9 |
| axis-order regression verified | **PASS** — mutation-caught |
| floating centroid verified | **PASS** — exact in source CRS |
| real Sentinel targets inside measured raster bounds | **PASS** — 3/3 |
| raster/target alignment assertion | **PASS** — 3/3 inside |
| correlation before/after audit produced | **PASS** |
| all changed associations explained | **PASS** — isolation experiment |
| golden expectations independently recalibrated | **PASS** — abort-gated |
| backend full suite | **PASS** — 411 passed |
| ruff | **PASS** |
| mypy | **PASS** — 52 files |
| generated API contract | **PASS** — 295 lines, `--check` current |
| frontend tests / tsc / build | **PASS** — 415 / clean / clean |

Backend 386 → **411** (+24 geolocation proofs, +1 parity gate).
Frontend 415 → **415** (no new tests needed; existing ones hardened).