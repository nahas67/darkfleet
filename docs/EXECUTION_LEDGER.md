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

## CP7 — Complete backend API (2026-10-01)

10 endpoints under FastAPI with lifespan, CORS and uniform error rendering.
- DEMO scan → 202 + `DF-0001`; polled to COMPLETE through all 15 stages in
  order; stage history persisted and replayable without rerunning.
- Live provider health probe (NOT env-var inference): Planetary Computer
  **AVAILABLE** 2784 ms; EarthSearch **DEGRADED** with the GCP caveat surfaced;
  latency + last_check + error reported per provider, no secrets.
- Evidence, targets, debug layers, SSE (43 lines, terminal-terminated),
  geojson/kml/json exports all verified live. PNG/PDF return **501 with
  `planned_in: CP12`** — no stub file, no fake bytes.
- Isolation verified live: REAL with an unknown provider → **400
  UNKNOWN_PROVIDER / NOT_CONFIGURED**, zero synthetic content. Malformed bbox →
  422.
- Three integration defects found by exercising the API rather than its tests:
  pipeline re-emitted QUEUED and SEARCHING_SCENE, both illegal in the 15-state
  machine (adapter now drops the duplicate QUEUED and merges repeats); and
  scans had to be persisted *before* the terminal transition so a COMPLETE job
  can never be read before its evidence hits disk.
- 140/140 pytest · ruff clean · strict mypy clean (37 files).

## CP8 — New UI foundation (2026-10-01)

- `src/app/`: `state.ts` (pure reducers/selectors, capability-gated layers,
  provider severity ranking), `useApi.ts` (typed client for all 10 endpoints),
  `useScan.ts` (SSE decoder, stage counter, no percentages), `SpatialShell.tsx`.
- Shell: full-screen Cesium globe + minimal top bar + left icon rail +
  bottom-centre dock + one floating surface. Legacy dashboard unmounted.
- Advanced layers gated in THREE places: reducers return the identical state
  object, `visibleLayerIds` filters them, and the UI renders a disabled row
  reading "not available until CP15".
- Unknown/unmodelled stage strings are surfaced verbatim rather than coerced,
  so a newer backend stage is never silently dropped or guessed.
- **Legal-exposure bug found and fixed**: `index.css` set
  `.cesium-viewer-bottom { display:none }`, and Cesium appends
  `.cesium-widget-credits` INTO that container (verified in the Cesium source,
  `creditContainer: bottomContainer`) — the required imagery attribution was
  invisible. Now only the interactive widgets are hidden; the credits bar stays
  visible, clickable, and above our overlays.
- `main.tsx` mounts the new shell, owns the Viewer lifetime (destroy on unmount
  so no WebGL context leaks), and probes provider health on load.
- 84/84 frontend tests · `tsc --noEmit` clean · `vite build` succeeds
  (263 kB js / 60 kB css, 8.4 s).

## CP9 — Globe layers, camera, search (2026-10-01)

- 11 `RegisteredLayer` implementations (src/globe/layers.ts). Every `update()`
  clears before rebuilding — leak proven by 5× update loops asserting constant
  primitive counts.
- `SAR_RASTER` uses `SingleTileImageryProvider` + `addImageryProvider` with a
  generation token so a slow provider resolving after a newer update is dropped;
  at most one imagery layer exists at any time.
- Camera suite: 11 commands with `QUADRATIC_IN_OUT` easing. `followTarget` uses
  a grace window + `moveEnd` to distinguish its own flyTo from operator input;
  the first user `moveStart` kills the follow.
- SpatialSearch: coords / sector / scene / target ID / MMSI / scan ID, driving
  the camera. Keyboard navigable, Esc closes, no network in tests.
- Advanced layers are hard no-ops: direct and registry-routed `update()` both
  yield 0 primitives.
- 167/167 frontend tests · tsc clean.

### CP15 (partial) — real image-based wake analysis

- Replaced the legacy threshold sampler with a polar-ray symmetric arm-pair
  detector. Every reported value is measured from pixels; no fixture flag is read.
- MEASURED on a controlled fixture (0.8 dB speckle, 10 m pixels):
  detects arms down to ~7 dB above sea; flat sea, hull-only and stub wakes all
  correctly return `detected=False`; confidence is monotonic in arm contrast;
  arm angle recovered within ~3-9 deg over a 12-32 deg true range.
- Honest limits recorded rather than hidden: confidence saturates (it is
  evidence strength, not P(wake)); angular tolerance is ±10 deg; the reported
  heading is an axis folded to a half-turn because a hull axis is bidirectional.
- Approach changed twice after the Radon variant proved insensitive to wake
  strength — recorded in PLAN_CHANGES rather than quietly rewritten.
- 13 wake tests · 158 backend tests · ruff clean · strict mypy clean.

### CP15 remainder �?" multi-pass intelligence, polarization, detector registry, narrative

- **Tracks (ADV-001..003)**. uild_tracks links ONLY AIS-associated detections.
  An unmatched detection is not evidence of a track, so it is refused rather
  than linked. Identity strength is capped at 0.85 and grows only saturating in
  the pass count; the emitted statement always says identity is not confirmed.
  Gaps record the implied speed and the plausible-surface-speed test. A
  non-positive acquisition interval is reported as a DATA problem, not as an
  implausible vessel �?" an earlier version printed "exceeds plausible surface
  speed" for a zero interval, which would have been a fabricated finding.
  /api/tracks returns an empty history as zero tracks with a note, not an error.
- **Polarization (ADV-006)**. extract_features computes per-pol statistics and
  the VH/VV and HV/HH discriminators only when both polarizations are present.
  Single-pol acquisitions report the dual-pol features as NOT_AVAILABLE with
  the reason recorded in provenance. The VH/VV ship flag is labelled a flag, not
  a probability, and is not calibrated for the product. Ratio computation
  excludes noise-dominated pixels (denominator below -25 dB) because their ratio
  is an artefact of dividing by noise. 11 tests.
- **Detector registry (ADV-007/008)**. CA-CFAR is registered as the real shipped
  baseline and its run path executes the production CFAR + connected-components
  code. An ML or ensemble adapter lacking BOTH weights_digest and validation_data
  is refused at registration, so it cannot appear in /api/detectors. No trained
  weights ship: no maintained open Sentinel-1 GRD vessel-detection weight set
  exists (RESEARCH_REGISTRY).
- **Temporal patterns (ADV-009/010)**. Association-gap, repeated-unmatched and
  co-located-track families. Each pattern carries an observation, a hypothesis, a
  bounded confidence and explicit unknowns. A leading/trailing run of absent AIS
  is archive edge, not a gap, and is not reported. The hypothesis text names
  carriage exemption, reception shadow and receiver outage as equally
  consistent with the data.
- **Narrative (ADV-011/012)**. Strict five-section document. Every failure mode
  returns AI_UNAVAILABLE with a reason and leaves the deterministic evidence
  untouched. Model ids must be auditable (provider/name[:version]) or refused.
  The fabrication guard is TWO-TIER and this was the design correction worth
  recording: an earlier word-whitelist approach rejected the shipped template's
  own analytic vocabulary and would have needed constant maintenance. Numbers
  and named entities are checked against the evidence for EVERY writer, because
  those are the tokens that carry claims about the world. Only an UNTRUSTED
  adapter is additionally held to the closed analytic vocabulary, because the
  shipped template is deterministic f-strings and cannot hallucinate. Accusatory
  vocabulary is refused outright in any writer.
- New endpoints: /api/tracks, /api/patterns, /api/detectors,
  /api/targets/{id}/summary. 216 backend tests -> ruff clean -> strict mypy clean.
### CP10/CP11 — evidence, timeline, contacts, analysis workbench

- Four surfaces delivered and tested in isolation, then found to be UNREACHABLE
  from the shell. Same failure mode CP12 had with its PNG/PDF renderers: complete,
  tested, dead. Wiring them is CP14 below, and that is where the real bugs were.
- UI-012/013/014: 4-tab inspector with OBSERVED / HYPOTHESES / UNKNOWNS kept as
  three separate blocks; real acquisition-time timeline with Delta-t labels;
  sortable + filterable contacts. Neutral language registry for SAR_UNMATCHED;
  missing data renders "not established", never a zero or a null.
- Timeline has a source-level guard test: after comment-stripping the file
  contains no setInterval / setTimeout / requestAnimationFrame / autoplay /
  fetch. Playback is not simulated.
- UI-015/016/017: analysis workbench and all 13 debug layers. Five implementation
  bugs caught by the lane's own tests: applyPreset broke object identity;
  toCfarRequestParams emitted NaN for speckleFilter; scaleBar invented a distance
  over a zero-width AOI; hasReportedStats counted always-numeric counters as real
  statistics; AOI drag state was recreated on every render.
- Legacy scale bar used a flat 111320 m/deg regardless of latitude. Replaced with
  metres-per-degree at the AOI centre latitude.
- The high-sensitivity preset changes 6 keys, not the 4 the brief assumed: the
  legacy UI also moved minPixels 3->2 and maxPixels 1000->1200.
- 136 + 103 frontend tests added. 167 -> 406 after both lanes.

### CP13 — Docker build, run and OSS close-out

Built and RAN both images. The build failed on the first attempt and two further
defects only appeared once the stack was live. Recording all three:

1. **The image did not build.** python:3.12-slim moved from Debian bookworm to
   trixie, so pinned libgdal32 / libgeos-c1v5 / libproj25 no longer resolve and
   apt-get exited 100. Re-pinning the versions would only break again on the next
   base bump, so they were removed after verifying that rasterio 1.5.2 ships
   self-contained wheels (GDAL 3.12.2 with no system GDAL present). The one
   library the wheel genuinely needs from the OS is libexpat.so.1, so only
   libexpat1 plus curl for the healthcheck are installed.

2. **Every REAL scan without an explicit time window failed.** stac_search always
   sent a datetime key; an empty string is a validation error, not an unfiltered
   search, and Planetary Computer answered "Datetime parameter  is invalid."
   The key is now omitted when the range is blank. 8 regression tests.

3. **PNG/PDF export answered 501.** CP12 wrote render_png / render_pdf but never
   wired them into the route, so both were dead code behind a placeholder test
   that asserted the 501. Now rendered server-side; the placeholder test was
   replaced by assertions on real artefact magic bytes.

A rendering defect was found by INSPECTING the exported image rather than by
reading the code: the no-data marker (40,40,40) was a grey, and the data ramp is
pure greyscale, so valid water at low backscatter was indistinguishable from
excluded land. Measured on the output: 95.1% of the frame was ambiguous. No-data
is now (26,26,74), outside the ramp, and the caption states the excluded and
analysed fractions plus the dB stretch so an excluded area can never read as an
observed absence of returns. Re-measured on real data: no-data is exactly the
68.1% land fraction, water occupies the ramp.

Verified in the container against real data: Sentinel-1D
S1D_IW_GRDH_1SDV_20260927T112445, EPSG:32648, VV, 10 m, 23 detections,
synthetic=false, all 13 debug layers serving, all 5 export formats producing real
bytes. A sample export is committed at docs/assets/DF-0001-export-sample.png.

### CP14 — Wiring, and the defects only wiring could expose

Four delivered surfaces were mounted. Mounting them found four real bugs:

1. **A scan could not be started from the UI at all.** useScan().startScan and
   client.createScan both existed with no caller, so the Scan command opened a
   status panel describing a job that could never be launched. ScanLauncher now
   binds them. It has no "whole world" default, because a REAL scan over an
   arbitrary extent would either return nothing or download an unreasonable
   amount of data.
2. **The default bbox always failed in DEMO.** DEMO scenes are synthesised on a
   fixed grid and the backend correctly rejects a mismatched extent, so the
   launcher reads the extent from the backend's own scene catalogue.
3. **Targets never refreshed.** The fetch keyed on scan id alone; one that raced
   the running job got 409, and because nothing re-ran, Contacts, the inspector
   and the timeline stayed empty after the scan finished until a manual reload.
   Confirmed fixed in the container logs: 409s during the run, 200 on completion.
4. **The payload shape was never actually checked.** ScanTargetsResponse.targets
   was Array<Record<string, unknown>>, an escape hatch that hid two mismatches:
   the backend persists the field as `cls` while every surface reads
   `classification` (undefined against the real API), and
   AisAssociation.aisAssociationConfidence was declared but never sent. Both are
   reconciled by an explicit tested normaliser. The wire format is deliberately
   unchanged, because the parity suite and the exports all read `cls`.

Also: the shell offered a `csv` export the backend rejects with 400; ExportFormat
now matches the backend's supported set exactly. The TimelineSurface placeholder,
which claimed the backend had no timeline source, was removed, as was the stale
"unavailable until CP15" copy.

Verified by driving the containerised stack in Chrome: a REAL scan launched from
the UI completed with 23 detections and synthetic=false; a DEMO scan completed in
224 ms; Contacts rendered its 9 sortable columns against live data.

> **Correction 2026-10-02.** The DEMO scan in the paragraph above can no longer be
> run: the synthetic scene generator was deleted in the batch recorded below. Every
> earlier entry in this ledger that mentions `demo.py`, a DEMO scene, or a DEMO
> scan describes the tree as it stood at that checkpoint and is left unedited,
> because the point of an append-only ledger is that it shows the path.

### Post-CP15 — GEO-001..003, and the end of the synthetic mode

Eight commits, `f3540c1` through `be9cd07`. Recorded here because it closes the
DEMO/REAL isolation requirements (EVD-006, EXP-006, TST-004, UI-037) by removal
rather than by implementation, which no earlier entry does.

- **GEO-002 — `GET /api/revisit`.** `darkfleet/revisit.py` measures SAR revisit
  from the provider STAC catalogue instead of predicting passes from a TLE, so
  `skyfield`/SGP4 is deliberately not a dependency. Constraints that cost
  something and were kept: gaps are computed only inside the queried window and
  the window is returned with the statistics; a single acquisition yields
  `median_revisit_days: null` plus a limitations string rather than a number; the
  12-day nominal repeat flags long gaps and never invents an acquisition.
  Surfaced by `src/plan/AcquisitionPlan.tsx`, mounted in the SAR surface of
  `SpatialShell.tsx`, 18 tests.
- **GEO-003 — vertical datum.** `darkfleet/geoid.py`, with
  `describe_datum()` embedded in every target evidence record and
  `altitude_measured: false` as the load-bearing field, because SAR is a 2-D
  sensor. No EGM2008 grid ships, so `to_geoid_height` returns the value on its
  original datum and labels it WGS84 rather than assuming N = 0 — the assumed
  zero is exactly the error the module exists to prevent.
- **GEO-001** (earlier, commit `5681d78`) — named marine regions from Natural
  Earth, public domain; see `PROVENANCE.md`.
- **The synthetic mode is deleted, not gated.** `darkfleet/demo.py`,
  `Settings.allow_synthetic_scenes`, `run_scan(runtime_mode=, scene=)`,
  `ScanCreateRequest.scene_id`/`.runtime_mode`, `DEMO_SCENES` and its two
  resolvers are all gone. `RUNTIME_MODES` is `("REAL",)`, `RuntimeMode` is a
  single-member StrEnum, `mark_synthetic(..., True)` raises at the call site, and
  `render_png`/`render_pdf` take no `runtime_mode` argument at all (PDF
  compression OFF, so the unconditional provenance banner is greppable in the raw
  bytes). Offline tests read `tests/fixtures/cog/fixture_32648.tif` via
  `run_scan(window_source=…)`, so the production pipeline is what runs.
- **`server.ts` deleted**, plus 35 unreachable frontend modules and 4 test files.
  It was a second analytical engine in TypeScript that defaulted to DEMO and was
  the `npm run dev` entry point. Unreachability was proven by resolving the import
  graph from `src/main.tsx` at 0 violations — and the first version of that
  analysis missed a multi-line import block, which `tsc` caught, so the corrected
  analysis was rerun before anything was deleted.
- **A real defect found while removing the pill.** The container healthcheck
  pointed at `/api/providers/health`, which performs a LIVE provider probe; a
  slow third party pushed it past the 5 s timeout and Docker restarted a healthy
  API in a loop. Liveness is now `GET /health`, outside the `/api` prefix, with a
  test that monkeypatches `httpx` to raise and asserts it still answers.
- **Verified after the batch:** 371 backend tests pass (3 live deselected), ruff
  clean, strict mypy clean, 356 frontend tests pass, `tsc --noEmit` clean,
  `vite build` clean. Three `src/` files still contain the string `DEMO`, and all
  three are correct: two negative assertions in `src/app/SpatialShell.test.ts`
  (`not.toContain('demo')`) and one doc comment in `src/types/api.ts` recording
  the removal. **Caveat:** the neighbouring comment in `src/app/useApi.ts:186-188`
  claims the backend answers `?runtime_mode=DEMO` with 404 and a
  `SYNTHETIC_SCENES_DISABLED` status. Neither is true against the current backend —
  `GET /api/scenes` requires `bbox` (400 `INVALID_REQUEST` without it) and no
  `SYNTHETIC_SCENES_DISABLED` code exists. Corrected in `PROVENANCE.md`; the code
  comment is left as-is because this change is markdown-only.
