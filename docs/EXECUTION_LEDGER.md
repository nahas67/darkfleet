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

## CP4 — AIS ingestion + persistence (2026-10-01)

- Canonical Pydantic model (9-digit MMSI, lat/lon bounds, dimensions, source).
- Normalizers: AISStream WS JSON, AISHub rows, MarineCadastre CSV, pyais NMEA
  (asdict API), GFW events. Real `!AIVDM` sentence decoded in tests.
- Archive: `data/ais/YYYY/MM/DD/part-<source>.parquet`, DuckDB AOI/time/MMSI/
  source queries, time-ordered, dedup by mmsi|timestamp (in-memory seen-set
  rebuilt from disk), coverage/freshness report.
- Restart proven: new instance over same dir keeps data + dedup state.
- Collectors (AISStream WS, AISHub poll, GFW events) persist into the same
  archive; all raise `RealDataUnavailableError` without keys. Live runs are
  externally blocked (free keys), code paths tested.
- Bugs caught: pyais 3.x `.content`→`.asdict()`; DuckDB needs pytz (added to deps).
- 39/39 pytest; ruff + strict mypy clean.
- Status: ✅ VERIFIED.

## CP5 — Temporal alignment + correlation (2026-10-01)

- geodesy.py: WGS84 **ellipsoidal** geodesic (mandated upgrade; legacy used
  spherical haversine mislabeled "WGS-84"); propagation/radius/heading kept
  legacy-exact so predicted positions stay parity-stable.
- match.py: candidate enumeration, persisted per-candidate radius, 5-part score
  decomposition, greedy 1-to-1 with explicit `UNRESOLVED` on near-tie conflict,
  `AIS_ONLY` emitted as real targets.
- **All 7 canonical classifications now reachable** (legacy emitted 3):
  SEA_CLUTTER (weak/small/no-SNR), LOW_CONFIDENCE (sub-threshold candidate),
  UNRESOLVED (two near-equal claimants).
- PARITY: 12/12 classifications, positions, associations, SAR confidence exact;
  radii/Δt exact; scores within 0.005; distance delta ≤1.11% (measured cost of
  the geodesic upgrade — recorded, not hidden).
- Correlation: 12 components × 200 AIS in **12.6 ms** (target <2s).
- 44/44 pytest; ruff + strict mypy clean.
- Status: ✅ VERIFIED.

## CP6 — Evidence + storage + cache + job system (2026-10-01)

- `pipeline.py`: the single authoritative scan; stages streamed via callback at
  the moment work completes. 14 real transitions, 0 timers, 0 percentages.
- `evidence.py` / `observability.py`: full provenance (SAR, config hash, mask,
  filter, CFAR, AIS provider, matching weights) + structured measured logs.
- `storage/cache.py` + `storage/runs.py` (subagent): content-addressed cache with
  REAL hit/miss counters, sha256-verified reads (corrupt = MISS), RunStore with
  the DEMO/REAL+synthetic isolation guard; survives restart.
- `jobs/` (subagent): canonical 15-state machine, strictly-next transitions with
  escape-to-FAILED, threaded runner, per-transition persistence, `subscribe()`
  seeded queue for SSE.
- `demo.py`: DEMO synthesis ported to Python (TS engine now unreferenced by the
  backend; retirement recorded in REMOVALS after full parity).
- DEMO scan measured: 101 detected px → 12 components → 6 AIS obs → 4 matched,
  8 unmatched, 2 AIS-only, 96 ms end to end. Logs show only real events.
- 123/123 pytest · ruff clean · strict mypy clean (32 files).
- Status: ✅ VERIFIED.

### CP6 addendum — LIVE REAL scan through the shipped pipeline

Two REAL scans over open water east of Singapore, live Sentinel-1 RTC, no
credentials, no synthetic input:
- AOI 103.83–103.87E / 1.22–1.26N · window 442×445 px · 10 m · EPSG:32648
- 15 real stage transitions, 12.4 s total (scene search + SAS + window read +
  WorldCover mask + RTC→dB + median + CA-CFAR + components + correlation)
- 7 SAR_UNMATCHED + 2 STATIONARY_OR_INFRASTRUCTURE, confidence 0.72–0.81,
  peaks 6.3–13.4 dB — consistent with real hull returns
- 0 AIS observations (archive empty) ⇒ every target correctly UNMATCHED rather
  than inventing a match — the failure mode the spec forbids, demonstrably absent
- `runtime_mode=REAL`, `synthetic=False` on every artifact; mask provenance
  records the exact WorldCover clip used
- First scan exposed two real defects, both fixed: `resolution_m` was recorded
  as null, and an unknown-provider guard wrongly blocked valid discovery.
