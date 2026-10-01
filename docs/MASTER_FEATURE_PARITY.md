# DarkFleet Master Feature Parity Matrix

> Execution contract for the Master Recovery. Every requirement from the mission
> prompt appears here exactly once. Statuses use only:
> `✅ VERIFIED` · `🟢 IMPLEMENTED` · `🟡 PARTIALLY VERIFIED` · `🔴 BLOCKED` · `⚪ NOT IMPLEMENTED`
>
> Last updated: Gates 0A + 0B complete. The final verdict is **calculated from
> Gate 11 evidence, never pre-selected**.

## Provider capability ledger (measured 2026-10-01, no credentials in environment)

| Provider | Discovery | Asset access | Georeferencing | Analysis-ready | Role |
|---|---|---|---|---|---|
| Planetary Computer `sentinel-1-rtc` | anon HTTP 200 | anon-equivalent today: unsigned read HTTP 409 → free SAS token endpoint HTTP 200 → range-read OK (512² window, 11.6 s) | AFFINE, EPSG:32648, 10 m COG, float32, 6 overviews | YES | **PRIMARY** |
| Planetary Computer `sentinel-1-grd` | anon HTTP 200 | same SAS mechanism (read untested) | per-item (likely GCP-native) | PARTIAL | SECONDARY |
| CDSE STAC (`stac.dataspace.copernicus.eu/v1`) | anon, but **no Sentinel-1 collections** (exactly 10 IDs: `ccm-*`, `clms_*`); prior HTTP 400 was `CollectionInQuerryDoesNotExist` (wrong ID), prior 404 was wrong ID — **not** auth | n/a for S-1; CCM-SAR downloads credentialed | n/a | NO | 🔴 BLOCKED for S-1 |
| EarthSearch `sentinel-1-grd` | anon HTTP 200, 70 scenes over Singapore Strait | anon public S3 | **GCP (210 GCPs, EPSG:4326)**, no affine, no RPCs | NO (warp required) | SECONDARY via GCP warp path |
| AISStream | — | needs free API key | n/a (point observations) | n/a | live provider (Gate 4) |
| AISHub | endpoint reachable | needs free username key | n/a | n/a | live provider (Gate 4) |
| Global Fishing Watch API | — | HTTP 401 without key | n/a | n/a | adapter where configured (Gate 4) |

`SarAsset` georeferencing states: `AFFINE_GEOREFERENCED` · `GCP_GEOREFERENCED` ·
`UNREFERENCED`. Asset accessibility and georeferencing are **separate** capability
states. `UNREFERENCED` (neither affine nor usable GCP/geolocation metadata) fails
explicitly — never silently mis-georeferenced.

## Key

- **Existing**: did the inherited repo have it? (`legacy-TS` = TypeScript implementation,
  `dead` = present but unmounted/uncalled, `partial` = incomplete)
- **Working**: did it actually work? **Final status** is the only column that changes.

## A. Deterministic pipeline (backend authority)

| # | Feature | Existing | Working | Integrated | Tested | Required action | Final status |
|---|---|---|---|---|---|---|---|
| A1 | Python FastAPI backend as single detector/correlation authority | No | No | No | No | Create `backend/`; retire 3 TS copies after parity proof | ⚪ NOT IMPLEMENTED |
| A2 | REAL STAC scene search (PC RTC primary, capability-based selection) | No (`/api/stac/scenes` expected, never implemented) | No | No | No | Implement provider router; anon search verified by probe, wire into API | ⚪ NOT IMPLEMENTED |
| A3 | CDSE Sentinel-1 path | No | No | No | No | Capability-gated; no S-1 collections on public STAC → BLOCKED unless OData/S3 creds added | 🔴 BLOCKED |
| A4 | EarthSearch GRD + GCP warp path | No | No | No | No | Implement GCP→GeoTIFF warp; 210-GCP asset verified on disk | ⚪ NOT IMPLEMENTED |
| A5 | Remote windowed raster read (no full-scene download) | No | No | No | No | rasterio `from_bounds` in source CRS; PC range-read verified manually | ⚪ NOT IMPLEMENTED |
| A6 | Georeferencing chain + tests (AOI→source→window→pixel→WGS84, non-WGS84) | No | No | No | No | Implement; fixture pixel→known coord is a hard gate | ⚪ NOT IMPLEMENTED |
| A7 | GRD vs RTC preprocessing branches | No | No | No | No | GRD: DN→σ⁰→denoise→terrain→dB. RTC: linear γ⁰→log | ⚪ NOT IMPLEMENTED |
| A8 | Real land/water mask + buffer + exceptions + provenance | No (synthetic masks) | No | No | No | Real coastline source, declared resolution; Natural Earth coarse-viz only | ⚪ NOT IMPLEMENTED |
| A9 | Speckle: none/median/lee (+refined_lee/frost architecture) | partial (median only, legacy-TS) | DEMO-only | No | No | Port; measure retention/displacement/area/FP/SNR on controlled fixtures — no sub-resolution promises | ⚪ NOT IMPLEMENTED |
| A10 | CA-CFAR baseline (guard/train rings, power-domain) | legacy-TS | DEMO-only | No | No | Port to NumPy; golden-vector parity test before TS retirement | ⚪ NOT IMPLEMENTED |
| A11 | Connected components + full extraction | legacy-TS | DEMO-only | No | No | Port; parity test | ⚪ NOT IMPLEMENTED |
| A12 | True image-based wake analysis | No (crude threshold sampler `cfar.ts:329-370`) | — | No | No | Gate 10; retire `wakeVisible` fixture flag | ⚪ NOT IMPLEMENTED |
| A13 | Multi-polarization VV/VH/combined | No | No | No | No | Gate 10, where source data permits | ⚪ NOT IMPLEMENTED |
| A14 | ML detector interface (CFAR stays baseline) | No | No | No | No | Gate 10 adapter contract; no unvalidated weights | ⚪ NOT IMPLEMENTED |

## B. AIS + correlation

| # | Feature | Existing | Working | Integrated | Tested | Required action | Final status |
|---|---|---|---|---|---|---|---|
| B1 | AIS adapters: AISStream, AISHub, GFW, local import | No | No | No | No | Implement; AISStream is a required live provider | ⚪ NOT IMPLEMENTED |
| B2 | Live collector → same Parquet/DuckDB archive | No | No | No | No | Live feed persists forward; live data is not the historical store | ⚪ NOT IMPLEMENTED |
| B3 | `data/ais/YYYY/MM/DD/*.parquet` + DuckDB AOI/time/MMSI/dedup/coverage/freshness | No (in-memory `Map`, `server.ts:41`) | No | No | No | Implement; restart must not lose archive | ⚪ NOT IMPLEMENTED |
| B4 | Dead-reckoning propagation + Δt + uncertainty, recorded | legacy-TS (spherical) | DEMO-only | No | No | Port; upgrade distance to ellipsoidal geodesic | ⚪ NOT IMPLEMENTED |
| B5 | All distances geodesic (metres), never raw degrees | No (haversine mislabeled WGS-84) | — | No | No | pyproj.Geod everywhere | ⚪ NOT IMPLEMENTED |
| B6 | Dynamic match radius, actual radius persisted per candidate | legacy-TS | DEMO-only | No | No | Port + persist | ⚪ NOT IMPLEMENTED |
| B7 | Score decomposition backend (spatial/temporal/heading/size/composite) | legacy-TS | DEMO-only | No | No | Port; weights in config | ⚪ NOT IMPLEMENTED |
| B8 | All 7 canonical classifications reachable; `AIS_ONLY` emitted | partial (4 of 7 dead) | DEMO-only | No | No | Implement `SEA_CLUTTER`, `LOW_CONFIDENCE`, `UNRESOLVED`, emit `AIS_ONLY` | ⚪ NOT IMPLEMENTED |
| B9 | Apparent footprint + uncertainty (replace `pixels × spacing` exact length) | No (`correlation.ts:180` exact) | — | No | No | Fix required | ⚪ NOT IMPLEMENTED |
| B10 | Neutral language; no intent/illegality inference | partial (types clean; UI copy leaks) | — | No | No | Neutralize 4 UI strings; keep FABRICATED-INTENT ban in AI path | ⚪ NOT IMPLEMENTED |

## C. Jobs, evidence, cache, API, observability

| # | Feature | Existing | Working | Integrated | Tested | Required action | Final status |
|---|---|---|---|---|---|---|---|
| C1 | 15-state job machine + real events/SSE (no `setTimeout`) | No (6 fake timers, `App.tsx:212-217`) | No | No | No | Replace; no invented percentages | ⚪ NOT IMPLEMENTED |
| C2 | REST: scans, targets, events, scenes, providers/health, target by ID | partial (sync scan + cache get) | DEMO-only | No | No | Full job API | ⚪ NOT IMPLEMENTED |
| C3 | Deterministic cache + correct invalidation | No | No | No | No | Key: scene+AOI+config-hash+algo-version; prove reuse by counter | ⚪ NOT IMPLEMENTED |
| C4 | Evidence/provenance persisted (not React state) | partial (provenance object, ephemeral) | No | No | No | Persist full record incl. mask version, filter/CFAR config, AIS used, scores, uncertainty | ⚪ NOT IMPLEMENTED |
| C5 | Exports ×5 with provenance (GeoJSON/KML/JSON/PNG/PDF) | partial (3 of 5, TS) | DEMO-only | No | No | Add PNG snapshot + PDF report; DEMO marked synthetic | ⚪ NOT IMPLEMENTED |
| C6 | Structured operational logs of real events | No | No | No | No | Stage logger; measured messages only | ⚪ NOT IMPLEMENTED |
| C7 | Real provider health probing (`AVAILABLE/DEGRADED/UNAVAILABLE/AUTH_REQUIRED/RATE_LIMITED`) | No (env-var check only) | No | No | No | Probe endpoints; never expose secrets | ⚪ NOT IMPLEMENTED |
| C8 | Typed configuration (STAC/SAR/mask/CFAR/AIS/match/storage/cache/API/FE/logging) | No | No | No | No | pydantic-settings; env overrides; sane defaults | 🟢 IMPLEMENTED |
| C9 | DEMO/REAL strict isolation (no silent fallback) | No (`App.tsx:238-246` silent fallback) | No | No | No | Delete fallback; REAL failure raises explicitly | ⚪ NOT IMPLEMENTED |

## D. Spatial product (Cesium-first)

| # | Feature | Existing | Working | Integrated | Tested | Required action | Final status |
|---|---|---|---|---|---|---|---|
| D1 | Full-screen Cesium default, no legacy dashboard frame | partial (secondary view) | Yes (behind toggle) | No | No | Promote; remove 2D-default | ⚪ NOT IMPLEMENTED |
| D2 | Authoritative LayerRegistry, 12 canonical layers, leak-free rescans | dead (`layerRegistry.ts`, zero importers) | No | No | No | Wire; dispose contract + leak test | ⚪ NOT IMPLEMENTED |
| D3 | SpatialSearch wired (coords/sector/scene/target/MMSI/scan ID → camera) | dead (zero importers) | No | No | No | Wire + add scan-ID path | ⚪ NOT IMPLEMENTED |
| D4 | Camera suite (11 commands), easing, no nav override | partial (4 of 5 presets + `isWebGLAvailable` uncalled) | — | No | No | Wire all; WebGL fallback | ⚪ NOT IMPLEMENTED |
| D5 | Scene browser (Sentinel-1 pass discovery) | partial (scenario `<select>`) | DEMO-only | No | No | Real browser over provider search | ⚪ NOT IMPLEMENTED |
| D6 | View modes WORLD/SAR/SAR_CONTRAST/CORRELATION/ANALYSIS | No (`DisplayMode` dead type) | No | No | No | Implement | ⚪ NOT IMPLEMENTED |
| D7 | Target selection (click/hover/next/prev/focus/release) | partial (`onFocus` dead) | — | No | No | Merge TargetCard↔Inspector; wire focus | ⚪ NOT IMPLEMENTED |
| D8 | Evidence workspace (why UNMATCHED without source) | No | No | No | No | New deep-trace surface | ⚪ NOT IMPLEMENTED |
| D9 | Acquisition-time timeline (no fake playback) | No | No | No | No | New | ⚪ NOT IMPLEMENTED |
| D10 | CFAR workbench preserved + extended (lee, kernel/min/max, recompute signaling, before/after) | Yes (modal) | Yes | partial | No | Preserve; add missing controls | 🟡 PARTIALLY VERIFIED |
| D11 | Telemetry merged + bidirectional sync + filters + **sorting** | partial (no sorting; one-way sync) | Yes | partial | No | Merge pair; add sorting + camera-fly | 🟡 PARTIALLY VERIFIED |
| D12 | 2D Raster Workbench preserved (3 colormaps, 3 heatmaps, graticule, scale bar, dB probe, AOI box-select) | Yes (default view) | Yes | Yes | No | Demote to ANALYSIS surface; keep every feature | 🟡 PARTIALLY VERIFIED |
| D13 | Debug `?debug=true` + toggle, 14 layers | No | No | No | No | New | ⚪ NOT IMPLEMENTED |
| D14 | Exports menu (5 formats via API) | partial (3 client-side) | Yes | partial | No | Rewire to backend; add PNG/PDF | ⚪ NOT IMPLEMENTED |
| D15 | Settings / provider configuration | No | No | No | No | New | ⚪ NOT IMPLEMENTED |
| D16 | Advanced slots present but `NOT_AVAILABLE` hidden/disabled (multipass, wake, ML, temporal) | No | No | No | No | Registry slots only; **no fabricated tracks/geometry/output** before Gate 10 | ⚪ NOT IMPLEMENTED |

## E. Verification, docs, OSS

| # | Feature | Existing | Working | Integrated | Tested | Required action | Final status |
|---|---|---|---|---|---|---|---|
| E1 | Backend unit suite (transforms/mask/CFAR/components/geodesic/propagation/radius/scores/classification/cache/provenance) | No (6 tests, zero CFAR) | — | — | No | Full suite; golden parity | ⚪ NOT IMPLEMENTED |
| E2 | Backend integration (fixture→detect; archive→query; detect+AIS→corr; jobs; exports; DEMO/REAL isolation; restart) | No | — | — | No | New; tiny local fixtures, no full-scene downloads | ⚪ NOT IMPLEMENTED |
| E3 | Frontend tests (shell/mode/search/scenes/scan/layers/targets/timeline/evidence/workbench/telemetry/exports/errors/keyboard) | No (vitest not even installed) | — | — | No | Add vitest (Gate 0B) + suite before Gate 7 | ⚪ NOT IMPLEMENTED |
| E4 | Playwright E2E in **3 modes**: DEMO success · REAL success (if provider accessible) · REAL-unavailable (explicit error, no synthetics, no fallback) | No (chromium cached ✅) | — | — | No | New; DEMO E2E is never REAL verification | ⚪ NOT IMPLEMENTED |
| E5 | Rendered review 1920×1080 / 1440×900 / 1280×720 / 1024×768 + fixes | No | — | — | No | Screenshots + defect fixes | ⚪ NOT IMPLEMENTED |
| E6 | Performance measured (SAR window <10 s, detector <5 s, corr <2 s, 60 FPS target) | No | — | — | No | Measure; label measured-vs-target | ⚪ NOT IMPLEMENTED |
| E7 | Keyboard/ARIA/reduced-motion/non-colour status/parallel list | No | — | — | No | New | ⚪ NOT IMPLEMENTED |
| E8 | README + docs set + metadata.json + Makefile + CONTRIBUTING + SECURITY + LICENSE + REMOVALS.md | No (AI Studio boilerplate) | — | — | — | Rewrite all | ⚪ NOT IMPLEMENTED |
| E9 | Docker Compose (api+web, healthchecks, persistent volumes) | No | — | — | — | New | ⚪ NOT IMPLEMENTED |

## F. Advanced (Gate 10 only, after core verification)

| # | Feature | Existing | Working | Integrated | Tested | Required action | Final status |
|---|---|---|---|---|---|---|---|
| F1 | Multi-pass persistence / track hypotheses | No | No | No | No | After Gate 6; never identity-from-geometry | ⚪ NOT IMPLEMENTED |
| F2 | Real wake analysis (candidate/direction/length/heading-consistency/confidence + provenance) | No | No | No | No | After Gate 6 | ⚪ NOT IMPLEMENTED |
| F3 | Multi-polarization VV/VH/combined | No | No | No | No | Where data permits | ⚪ NOT IMPLEMENTED |
| F4 | ML detector interface | No | No | No | No | Adapter; validated models only | ⚪ NOT IMPLEMENTED |
| F5 | Temporal intelligence (hypotheses, not conclusions) | partial (proximity pairs only) | DEMO-only | No | No | After Gate 6 | ⚪ NOT IMPLEMENTED |
| F6 | Optional evidence-constrained AI (OBSERVED/HYPOTHESES/UNKNOWNS/CONFIDENCE) | partial (`analyze-ai` exists) | DEMO-only | partial | No | Constrain; validate model IDs; failure must not break analysis | ⚪ NOT IMPLEMENTED |

## Intentional removals (see `docs/REMOVALS.md`)

| Old behavior | Disposition |
|---|---|
| `App.tsx:runLocalScan` + `server.ts` inline pipeline (3rd + 2nd TS copies) | Remove after Python parity; DEMO preserved server-side |
| `App.tsx:238-246` silent REAL→DEMO fallback | Remove unconditionally (spec-forbidden anti-pattern) |
| `App.tsx:212-217` + `:253-256` fake timer stages | Replace with real job events |
| Type-only duplicates after merge (TargetCard↔Inspector, TelemetryOverlay↔Table) | Merge, keep superior surface, record migration |
