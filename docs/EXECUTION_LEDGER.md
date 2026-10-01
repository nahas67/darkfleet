# Execution Ledger

> Append-only. One entry per checkpoint with proof, never claims.

## CP0 — Baseline, research, environments (2026-10-01)

- Re-verified prior artifacts instead of trusting them: pytest 5/5, ruff clean,
  mypy strict clean (7 files), tsc clean, vitest 6/6, npm 240 pkgs / 0 vulns.
- Research complete: RES-SAR (provider probes), RES-AIS (5 sources + pyais),
  RES-AUX (9 datasets), RES-ML (datasets + no-weights verdict).
- Key corrections adopted: CDSE S-1 BLOCKED (no collections, 400 was wrong ID);
  EarthSearch GCP-referenced (210 GCPs, warp path); MarineCadastre = keyless
  historical AIS; WorldCover 10 m = primary mask; deterministic CV path.
- 11 plan docs written; PLAN_LOCK.json populated; commit follows.
- Status: ✅ VERIFIED.

## CP1 — Real raster + georeferencing (2026-10-01)

- Fixture COGs generated (seeded): 4326 + 32648 + unreferenced + 4-GCP control.
- `read_window` reprojects WGS84 AOI to native CRS before windowing (bug caught by test).
- 12/12 pytest green; ruff + strict mypy clean.
- LIVE PRIMARY PATH through shipped code: PC RTC search 2.7 s → SAS sign
  1.2 s → AFFINE/EPSG:32648/10 m/float32 → 332×334 window 2.0 s, TOTAL 8.3 s
  (< 10 s target); center lat 1.26499 lon 103.81499 inside AOI; 100% finite.
- Status: ✅ VERIFIED.

## CP2 — Preprocessing + real land mask (2026-10-01)

- RTC branch (linear γ⁰→dB, eps-guarded) and GRD branch (DN→σ⁰ via LUT;
  raises loudly without LUT; `denoised=False` flagged, never faked).
- Real mask: WorldCover v200 N00E102 tile range-read live (7.5 s), 4800×3600
  clip committed (976 KB): 59.2% water / 20.0% built-up / 13.6% tree —
  geographically plausible for the Malacca AOI.
- `build_land_mask`: nearest reproject → water-class!=80 land → metre buffer
  dilation → port carveback (GeoJSON fix) + versioned provenance.
- Point-verified: strait water open, island land excluded, harbour pier excluded.
- 22/22 pytest; ruff + strict mypy clean.
- Status: ✅ VERIFIED.

## CP3 — Filtering + CFAR + components (2026-10-01)

- Ported: median (selection-exact), Lee (power-domain), CA-CFAR (integral-image,
  legacy-exact geometry+rings+multiplier), components (scan-order labels,
  weighted moments, 24×24 chips, legacy wake sampler kept for parity).
- Real bugs caught: Float64Array JSON dump (re-dumped), `_box_sum` OOB on
  borders (interior-only rewrite), GeoJSON rasterize, float32-vs-64 test tolerance.
- PARITY: median selection 100%; CFAR mask 100% (0/97 differ); 12/12 components
  field-exact (cx/cy millipixel, areas, axes, orient, dB, wake, bbox, clutter).
- Detector timing: 8 ms on 180×180 (median+CFAR).
- Filter effects measured: retention ≥3/3 all modes; centroid ≤2 px; background
  std improves; no FP explosion. No sub-resolution promises.
- Deferred honestly: morphology (legacy had none; adding it changes the mask —
  post-parity with real data), refined-Lee/Frost slots, Radon wake (CP15).
- 29/29 pytest; ruff + strict mypy clean.
- Status: ✅ VERIFIED.
