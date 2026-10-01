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
## CP1 — Real raster + georeferencing (2026-10-01)

- Fixture COGs generated (seeded): 4326 + 32648 + unreferenced + 4-GCP control.
- `read_window` reprojects WGS84 AOI to native CRS before windowing (bug caught by test).
- 12/12 pytest green; ruff + strict mypy clean.
- LIVE PRIMARY PATH through shipped code: PC RTC search 2.7 s → SAS sign
  1.2 s → AFFINE/EPSG:32648/10 m/float32 → 332×334 window 2.0 s, TOTAL 8.3 s
  (< 10 s target); center lat 1.26499 lon 103.81499 inside AOI; 100% finite.
- Status: ✅ VERIFIED.
