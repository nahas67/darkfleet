# DF-X9.8 — Final AIS System Closure: Master Working Plan and Checkpoint Record

Created 2026-10-08, updated 2026-10-09.
This document tracks the recovery and final closure of DarkFleet's AIS, moving-contact, and spatial-intelligence subsystems across checkpoints X9.8-H0 through X9.8-H9.

## Checkpoint Status Matrix

| ID | Checkpoint | Status | Evidence Level | Commit / Notes |
|---|---|---|---|---|
| **X9.8-H0** | Repository takeover and authority audit | **ACTIVE** | CODE-VERIFIED | HEAD `5b72b43`, clean tree; defects confirmed |
| **X9.8-H1** | Eliminate Null Island fabrication | **PENDING** | - | `delivery.py:198-199` `lat=0.0/lon=0.0` removal |
| **X9.8-H2** | Correct fabricated SAR resolution | **PENDING** | - | `pipeline.py:381`, `routes.py:425` `10.0m` removal |
| **X9.8-H3** | Correct missing-length scoring | **PENDING** | - | `match.py:321` `size=0.8` missingness handling |
| **X9.8-H4** | Correct AIS frontend classification & request races | **PENDING** | - | `ContactList.tsx:73`, `client.ts:266/353/538` |
| **X9.8-H5** | Fix flight/FOLLOW interleaving & listener lifecycle | **PENDING** | - | `aisCamera.ts`, `engine.ts:916-917` teardown |
| **X9.8-H6** | Verify AIS archive performance & concurrent correctness | **COMPLETE** | MEASURED | Commit `f7e940e`: 121.6s -> 1.04s, 6 concurrent 1.0s wall |
| **X9.8-H7** | Real 10K browser benchmark & performance hardening | **NOT RUN** | - | Real GPU, staged 500 -> 1000 -> 2500 -> 5000 -> 10000 |
| **X9.8-H8** | Long-run memory/resource verification | **NOT RUN** | - | Multi-cycle time-series, primitive & listener counts |
| **X9.8-H9** | Scientific delta, system E2E, and release closure | **PENDING** | - | Fixture deltas, 12-section E2E, release gate |

---

## Historical Baseline Established (Pre-H0)
- Eager deduplication index fixed in `f7e940e`: `AisArchive.__init__` is lazy on write, O(1) for reads.
- GPU frame time measured in real hardware environment: median 7.2 ms, p95 9.9 ms (139 FPS) on ANGLE/D3D11, disproving the earlier 90.3 ms / 11 FPS software-rasterisation harness artefact.
- Live observation picking (S53) verified: exact MMSI/timestamp, raw values, null semantics, contact-level pivot.
- Browser E2E suite passes 12/12 at `3cc5b97` under sequential execution; interleaving flight defect isolated.

---

## Detailed Checkpoint Specifications

### X9.8-H0: Repository takeover and authority audit
- Inspect git status, branch, clean tree, verify HEAD `5b72b43`.
- Trace lines for all 6 audited defects (`delivery.py`, `pipeline.py`, `match.py`, `ContactList.tsx`, `client.ts`, `engine.ts`).
- Record baseline test results and pre-fix evidence.

### X9.8-H1: Eliminate Null Island fabrication
- Problem: `delivery.py:198-199` defaults absent latitude/longitude to `0.0`. Missing position renders at (0°N, 0°E).
- Requirement: Positions must be explicitly available or unavailable. Genuine (0,0) observations preserved.
- Output: Typed nullable coordinates or record exclusion with diagnostic; no fake vessel at Null Island.

### X9.8-H2: Correct fabricated SAR resolution
- Problem: `pipeline.py:381` and `routes.py:425` substitute `10.0` metres when raster resolution is missing.
- Requirement: Absent resolution must be represented as `None` / `NOT ESTABLISHED`. Size calculations must explicitly handle missing resolution without inventing 10m pixel size.

### X9.8-H3: Correct missing-length scoring
- Problem: `match.py:321` assigns `size = 0.8` when `length_m` is absent, out-scoring measured 240m vs 120m vessels.
- Requirement: Calibrated or neutral missing-feature scoring; absent length must never be rewarded over evidence.

### X9.8-H4: Correct AIS frontend classification & request races
- Problem: `ContactList.tsx:73` hardcodes `classification: 'AIS_ONLY'`, causing matched vessels to duplicate as AIS-only.
- Problem: `client.ts` concurrent promises in `followScan` allow `loadScanAis` to overwrite `aisOnly` depending on network arrival.
- Requirement: Deduplicate contacts against backend match authority; deterministic merge across asynchronous responses.

### X9.8-H5: Fix flight/FOLLOW interleaving & listener lifecycle
- Problem: Programmatic flights (`engine.flyTo`) settle after `moveEnd` (~500ms wait), emitting a post-flight `moveStart` at the flight destination that releases FOLLOW with "Released: the camera was moved."
- Problem: `engine.ts:916-917` registers `changed` and `moveEnd` telemetry listeners without cleanup in `dispose()`.
- Requirement: Flight settle tail attributed to programmatic flight; full listener teardown in `engine.dispose()`.

### X9.8-H6: Verify AIS archive performance & concurrent correctness
- Baseline verified: 50K query 359ms, coverage 44ms, concurrent read throughput proven.
- Test concurrency under simultaneous read/write, restart-dedup integrity, and error bounds.

### X9.8-H7: Real 10K browser benchmark & performance hardening
- Live WebGL scaling in real Chrome with GPU acceleration enabled.
- Stages: 500 -> 1,000 -> 2,500 -> 5,000 -> 10,000 contacts.
- Metrics: initial render, frame time (p50/p95), FPS, selection latency, pick latency, label budget <= 120.

### X9.8-H8: Long-run memory/resource verification
- Time-series heap measurements across repeated load/play/seek/follow/release/clear cycles.
- Verify Cesium billboard/label/polyline collections, listeners, and timers return to baseline.
- 25-cycle basemap recovery stability.

### X9.8-H9: Scientific delta, system E2E, and release closure
- 27-row correctness fixture comparison: explain any intentional delta from length/resolution fixes.
- Full E2E browser suite: all 12 sections passing against final HEAD.
- Backend gates (pytest, ruff, mypy), frontend gates (vitest, tsc, strict build).
- Gate check for continuation to DF-X10.
