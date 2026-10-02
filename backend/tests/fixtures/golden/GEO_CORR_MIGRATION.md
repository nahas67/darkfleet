# GEO-CORR — intentional correctness migration

**This is not test churn.** Read this before touching
`tests/fixtures/golden/ts_engine_golden.json`.

## What changed and why

The golden fixture's `targets[].lat/lon` (and everything derived from them) were
produced by a geolocation function that has since been **deleted as incorrect**:

```python
# REMOVED — do not restore
lon = min_lon + (x / width) * (max_lon - min_lon)
lat = max_lat - (y / height) * (max_lat - min_lat)
```

It interpolated linearly across the **requested AOI** rather than transforming
through the **window that was actually read**, and it treated a sample index as a
pixel **corner** rather than its **centre**.

Both are defects. Together they placed every detection roughly half a pixel —
and, whenever the window did not fill the AOI, kilometres — from its true
position. Because the spatial score and dynamic match radius derive from that
position, the error reached the association and the classification while still
producing plausible-looking numbers.

## Classifying a golden expectation before you change it

Every expectation is one of two things:

**`ALGORITHM TRUTH`** — correct, independent of the defect. Do not rewrite.
Re-derive it and confirm it is unchanged.

- `sarConf` — from component dB and geometry only, no coordinates
- `counts.aisOnly` — AIS-driven, no SAR coordinates
- geodesy functions (`geodesic_meters`, `dynamic_radius`, `propagate`, `orient_diff`)
- classification logic and thresholds

**`LEGACY BUG OUTPUT`** — encoded the defect. May be replaced, and only after
independent tests establish the correct value.

- `targets[].lat` / `targets[].lon`
- `targets[].corr.distanceOffsetMeters`
- `targets[].corr.scoreDecomposition`
- `targets[].aisConf`
- `targets[].cls` / `corr.mmsi` where the displacement changed the outcome

## Independent source of truth

The corrected coordinates are established by `backend/tests/test_geolocation.py`,
which derives its expectations **analytically from the grid's own transform**,
cross-checks **rasterio's `xy(offset="center")`**, and uses the committed
`sidecar.json` — never from the correlation code that consumes them.

Those tests are mutation-checked: injecting `always_xy=False`, dropping the
half-pixel offset, or rounding coordinates to 4 dp each makes them fail.

## Why the shift is exactly 154 m

The golden's `bbox` **exactly fills** its 180×180 grid, so the AOI-vs-window
defect contributes **nothing** here. The entire shift is the corner-vs-centre
convention, which for this grid is a half-pixel diagonal:

```
predicted (analytic): 154.6 m
observed:             154.2 – 154.3 m
```

Agreement to 0.3 m. That the shift is *uniform and analytically predicted* is the
evidence that the migration changed the geometry and nothing else.

## The two associations that moved

DF-005 and DF-006 swapped MMSI 477421900. They are distinct detections 1326.7 m
apart. Greedy 1-to-1 awards on **composite score**, not distance, so the *nearer*
target (DF-006, 598 m) lost to the better-aligned one (DF-005, 756 m):

```
0.15 × (0.822 − 0.144)  heading  = +0.1018
0.45 × (0.524 − 0.399)  spatial  = −0.0563
net                                  +0.0455   (observed 0.548 − 0.503 = 0.045)
```

DF-006 scored **0.503** when run alone — above `MIN_SCORE` (0.40) — so it was not
threshold-rejected; it lost the contest on score. Reproduce with:

```
python tools/geo_corr_audit.py
```

**No threshold was weakened.** If a future correction makes an association
disappear because the target is genuinely farther away, the association was wrong.
Fix the expectation, not the mathematics.

## Regenerating safely

```
python tools/recalibrate_golden.py   # aborts if any ALGORITHM TRUTH field moves
python tools/geo_corr_audit.py       # regenerates the before/after record
```

`recalibrate_golden.py` **aborts rather than migrating** if `sarConf` or any other
truth field differs. If it aborts, the correction changed something it had no
business changing — investigate, do not force it.

## Known pre-existing inconsistency, deliberately untouched

`meta.resolutionMeters` is `10`, but `bbox / width` implies **185.5 m** of latitude
and **247.3 m** of longitude per pixel. `resolutionMeters` feeds `apparent_len` and
therefore `sizeScore`.

The fixture is self-inconsistent, and this predates GEO-CORR. Changing it during a
coordinate migration would move size scores too and confound the two changes.
Fixing it belongs in its own checkpoint, with its own before/after record.

## The renderer honesty note

The raster layer's `raw`/`normalized`/`filtered` layers render bimodally (2 tones)
on this fixture, and that is **correct**: the water background is a single clamped
−90 dB across >98% of pixels, so the 1st–99th percentile window is degenerate.

`_stats` widens such a window by one unit and now **says so** in the report basis.
Do not "fix" the two-tone render by inventing contrast — that would fabricate
detail the measurement does not support.

Full record: `docs/GEO_CORR_AUDIT.md`.
Machine-readable: `tests/fixtures/golden/GEO_CORR_MIGRATION.json`.