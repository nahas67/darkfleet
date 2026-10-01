# DarkFleet — Current State (CP0 takeover inventory)

> Inspected 2026-10-01 from git `9f4e726` (baseline `d334898` preserved).
> States: `VERIFIED IMPLEMENTED_UNVERIFIED PARTIAL SIMULATED DISCONNECTED LEGACY
> DEAD BROKEN MISSING BLOCKED_EXTERNAL`. Evidence is file:line or probe output.

## Frontend (`src/`, React 19 + Vite 8 + Cesium 1.145 + Tailwind v4)

| Subsystem | State | Evidence |
|---|---|---|
| App composition | LEGACY | `src/App.tsx:137` defaults `viewMode='2d'`; `:359` Header, `:397` TacticalMap |
| 3D globe path | IMPLEMENTED_UNVERIFIED | `DarkFleetGlobe.tsx` + 6 managers render only behind toggle (`App.tsx:408`); unreachable in default view |
| Spatial shell (6 files) | DEAD | `BrandMark, CommandDock, IntelHud, LeftRail, MissionStatus, SpatialSearch` — zero importers each |
| LayerRegistry | DEAD | `globe/layerRegistry.ts` — zero importers |
| DataProvider | DEAD | `getDataProvider` — zero callers; `App.tsx` fetches `/api/*` directly |
| TargetCard (superior design) | DEAD | `components/target/TargetCard.tsx` — zero importers |
| TelemetryOverlay | DEAD | `panels/TelemetryOverlay.tsx` — zero importers |
| TacticalMap 2D renderer | LEGACY + VERIFIED behavior | 1186 lines, 11 render passes, works; parallel geospatial stack to Cesium |
| CFARWorkbench | PARTIAL | Works as modal; `lee` unreachable, kernel/min/max have no UI, config not re-synced while open |
| AISTelemetryTable | PARTIAL | Works; no sorting, one-way map sync, MMSI search case bug (`:54`) |
| TargetInspector | LEGACY | Works; ~85% duplicate of TargetCard; copy leaks (`:283` UNMATCHED (DARK), `:319` TRANSPONDER ANOMALY) |
| IntelligenceDebriefModal | PARTIAL | Hardcoded `SIMULATION` badge (`:133`) ignores runtimeMode |
| ScanWorkflowBar | BROKEN contract | Declares `MASKING_LAND`/`FILTERING` — not members of `ScanStage` type; stage typed bare `string` |
| Scan progression | SIMULATED | Six `setTimeout` fakes (`App.tsx:212-217`) + 850 ms tail |
| REAL→DEMO fallback | BROKEN (spec-forbidden) | `App.tsx:238-246` silently substitutes DEMO on REAL failure |
| Design tokens | DISCONNECTED | 16 `--df-*` tokens + `.df-glass` defined, zero components use them |
| `scanlines` class | BROKEN | `TacticalMap.tsx:862` references class that does not exist in CSS |
| tsconfig | PARTIAL | No `strict`/`noUnusedLocals`; `__dirname` in `vite.config.ts:12` (Node 25 warns) |
| Classification types | VERIFIED clean | 7 canonical values; `dark_vessel`/`threatLevel`/`NO_TRANSPONDER` occur 0× in `src/` |
| Length estimation | BROKEN (spec-forbidden) | `correlation.ts:180` exact `pixels × spacing`, flat 22% band |
| 4 of 7 classifications | DEAD | `SEA_CLUTTER`, `LOW_CONFIDENCE`, `UNRESOLVED`, `AIS_ONLY` never emitted |
| Geodesy | PARTIAL | Haversine mislabeled WGS-84; `calculateBearing` dead export |
| Wake | SIMULATED | Crude threshold sampler (`cfar.ts:329-370`), not image analysis |
| Exports (GeoJSON/KML/JSON) | PARTIAL | Work; KML provenance weaker; per-target blobs lack provenance wrapper |
| PNG/PDF exports | MISSING | — |
| Tests (frontend) | PARTIAL | 6 tests pass; CFAR/correlation/components untested |

## Backend

| Subsystem | State | Evidence |
|---|---|---|
| `server.ts` Express API | LEGACY | DEMO-only pipeline; REAL hard-503 (`:105-127`); in-memory `Map` scan store (`:41`) |
| STAC endpoint | MISSING | `RealDataProvider` calls `/api/stac/scenes` — route does not exist |
| Python authority (`backend/`) | IMPLEMENTED_UNVERIFIED | Scaffold + config + provider model + georef; strict mypy/ruff/pytest green, golden integrity 5/5 |
| Golden vectors | VERIFIED | `backend/tests/fixtures/golden/ts_engine_golden.json`, re-verified CP0 |
| AIS persistence | MISSING | No Parquet/DuckDB; no collector; no archive |
| Job system / SSE / cache | MISSING | — |
| Docker / Compose | MISSING | — |

## Providers (live-probed, keyless)

| Source | State | Evidence |
|---|---|---|
| PC `sentinel-1-rtc` | VERIFIED capable | Anon search 200; free SAS token 200; 512² range-read 11.6 s, EPSG:32648 affine COG |
| PC `sentinel-1-grd` | IMPLEMENTED_UNVERIFIED | Anon search 200; SAS read untested |
| CDSE S-1 | BLOCKED_EXTERNAL | No S-1 collections on public STAC (10 IDs only); prior 400 = wrong ID |
| EarthSearch GRD | PARTIAL | Anon search + public S3 OK; 210 GCPs EPSG:4326, warp path unwritten |
| AISStream/AISHub/GFW | BLOCKED_EXTERNAL (keyless) | All need free keys; live-only (no history) |
| MarineCadastre AIS | VERIFIED capable | Public ZIP archive, no login, US public domain |
| WorldCover 10 m mask | VERIFIED capable | Anonymous per-tile AWS COGs, CC-BY-4.0 |
| Ports (NGA WPI), lanes (NOAA), bathymetry (GEBCO), orbits (AWS s1-orbits) | VERIFIED capable | PD/anonymous (see RESEARCH_REGISTRY) |
| EEZ (MarineRegions) | PARTIAL | CC-BY-4.0 but no re-host; WFS live |

## Docs / OSS

| Item | State |
|---|---|
| README, CONTRIBUTING, SECURITY, LICENSE, Makefile (partially), docs set | MISSING or LEGACY (AI Studio boilerplate README) |
| `MASTER_FEATURE_PARITY.md` (62 rows), `REMOVALS.md` | IMPLEMENTED_UNVERIFIED (pre-ID; rewritten at CP0 with IDs) |
| `metadata.json` | LEGACY (AI Studio applet manifest) |

## Net assessment

A working DEMO-only product with a real (if crude) detector, a dead-but-sound
spatial shell, and a verified green backend scaffold. No real-data path is wired;
no persistence, jobs, cache, Docker, or E2E exist. The rebuild starts from
evidence, not from zero.
