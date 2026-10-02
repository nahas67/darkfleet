# DarkFleet — Current State (CP0 takeover inventory)

> Inspected 2026-10-01 from git `9f4e726` (baseline `d334898` preserved).
> States: `VERIFIED IMPLEMENTED_UNVERIFIED PARTIAL SIMULATED DISCONNECTED LEGACY
> DEAD BROKEN MISSING BLOCKED_EXTERNAL`. Evidence is file:line or probe output.
>
> **Convention (added 2026-10-02).** This is a dated snapshot of CP0, so its
> rows describe CP0 as found. Where a file has since been deleted, the row is
> marked `DELETED <date>` and names what replaced it; the CP0 observation is kept
> beside it rather than erased, because "this was dead and then removed" and "this
> was live" are different findings. Anything not marked was not touched by the
> 2026-10-02 deletion batch.

## Frontend (`src/`, React 19 + Vite 8 + Cesium 1.145 + Tailwind v4)

| Subsystem | State | Evidence |
|---|---|---|
| App composition | DELETED 2026-10-02 | Was LEGACY: `src/App.tsx:137` defaulted `viewMode='2d'`; `:359` Header, `:397` TacticalMap. The file is gone; composition is `src/main.tsx` → `src/app/SpatialShell.tsx`, which is the only product architecture (UI-038). |
| 3D globe path | DELETED 2026-10-02 | Was IMPLEMENTED_UNVERIFIED: `DarkFleetGlobe.tsx` + 6 managers rendered only behind a toggle and were unreachable in the default view. All deleted; the live Cesium path is `src/globe/cesiumViewer.ts` + `src/globe/registry.ts` inside `src/app/SpatialShell.tsx`. |
| Spatial shell (6 files) | DELETED 2026-10-02 | Were DEAD at CP0 (`BrandMark, CommandDock, IntelHud, LeftRail, MissionStatus, SpatialSearch` — zero importers each). Equivalent capability now ships inside `SpatialShell.tsx`; the standalone files are gone. |
| LayerRegistry | DELETED 2026-10-02 | Was DEAD at CP0 (`globe/layerRegistry.ts` — zero importers). The live registry is `src/globe/registry.ts`, wired from `SpatialShell.tsx`. |
| DataProvider | DELETED 2026-10-02 | Was DEAD at CP0 (`getDataProvider` — zero callers; `App.tsx` fetched `/api/*` directly). `src/data/dataProvider.ts` and `src/data/scenes.ts` are gone. The only client is `src/app/useApi.ts`, typed by `src/types/api.ts`; `src/types/darkfleet.ts` (the CP0 "wire-contract mirror") is also deleted. |
| TargetCard (superior design) | DELETED 2026-10-02 | Was DEAD at CP0 (`components/target/TargetCard.tsx` — zero importers). Its progressive-disclosure evidence design is now `src/evidence/TargetInspector.tsx`. |
| TelemetryOverlay | DEAD → superseded | Was DEAD at CP0 (`panels/TelemetryOverlay.tsx` — zero importers); deleted 2026-10-02. The merged live surface is `src/contacts/Contacts.tsx`. |
| TacticalMap 2D renderer | DELETED 2026-10-02 | Was LEGACY + VERIFIED behavior: 1186 lines, 11 render passes, working but a parallel geospatial stack to Cesium. Reimplemented as the specialist raster surface `src/analysis/AnalysisWorkbench.tsx` (UI-016) and the legacy file deleted. |
| CFARWorkbench | DELETED 2026-10-02 | Was PARTIAL: modal worked but `lee` was unreachable, kernel/min/max had no UI, config was not re-synced while open. All fixed in `src/analysis/AnalysisWorkbench.tsx` (UI-015/016); the standalone modal is gone. |
| AISTelemetryTable | DELETED 2026-10-02 | Was PARTIAL: no sorting, one-way map sync, MMSI search case bug at `:54`. Merged into `src/contacts/Contacts.tsx` (UI-014) with sorting, filters and bidirectional sync. |
| TargetInspector | DELETED 2026-10-02 | Was LEGACY: worked but was ~85% duplicate of TargetCard and leaked copy (`:283` UNMATCHED (DARK), `:319` TRANSPONDER ANOMALY). The surviving, de-duplicated inspector is `src/evidence/TargetInspector.tsx` (UI-012). |
| IntelligenceDebriefModal | DELETED 2026-10-02 | Was PARTIAL: hardcoded `SIMULATION` badge at `:133` ignored runtimeMode. Replaced by the optional AI evidence section; backend narratives now return `AI_UNAVAILABLE` rather than fabricating (ADV-011/012). |
| ScanWorkflowBar | DELETED 2026-10-02 | Was BROKEN contract: declared `MASKING_LAND`/`FILTERING`, not members of `ScanStage`. Stage progression is `src/app/useScan.ts` fed by real job events. |
| Scan progression | FIXED, was SIMULATED | Was six `setTimeout` fakes (`App.tsx:212-217`) + an 850 ms tail. Both the fakes and the file are gone; the real 15-state machine is `backend/darkfleet/jobs/`. |
| REAL→DEMO fallback | REMOVED | Was BROKEN (spec-forbidden): `App.tsx:238-246` silently substituted DEMO on REAL failure. Deleted with the file. The backend has no fallback branch to degrade into — `RealDataUnavailableError` propagates and nothing is persisted. |
| Design tokens | CONNECTED | Was DISCONNECTED: 16 `--df-*` tokens + `.df-glass` defined, zero components using them. The live surfaces (`AnalysisWorkbench.tsx`, `Timeline.tsx`, `SpatialShell.tsx`, `Contacts.tsx`) now consume them. |
| `scanlines` class | MOOT | Was BROKEN: `TacticalMap.tsx:862` referenced a class absent from the CSS. Both files are gone. An unrelated `.scanlines-opt` rule still sits unused at `src/index.css:109`. |
| tsconfig | PARTIAL (unchanged) | Still no `strict`/`noUnusedLocals` (TST-008 open). The `__dirname` complaint is resolved: `vite.config.ts:8` uses `fileURLToPath(import.meta.url)`. |
| Classification types | VERIFIED clean | 7 canonical values; `dark_vessel`/`threatLevel`/`NO_TRANSPONDER` occur 0× in `src/`. Now declared once, in `src/types/api.ts`. |
| Length estimation | FIXED, was BROKEN (spec-forbidden) | Was `correlation.ts:180` exact `pixels × spacing` with a flat 22% band. That file is deleted; apparent footprint now carries an explicit uncertainty band (`sar/components.py`). |
| 4 of 7 classifications | FIXED | `SEA_CLUTTER`, `LOW_CONFIDENCE`, `UNRESOLVED`, `AIS_ONLY` are all emitted by the Python authority (COR-011/012). |
| Geodesy | FIXED, was PARTIAL | Haversine mislabeled WGS-84 and `calculateBearing` was a dead export. The frontend has no geodesy at all now; the WGS84 ellipsoidal `Geod` upgrade lives in `backend/darkfleet/correlation/geodesy.py` (COR-003). |
| Wake | FIXED, was SIMULATED | Was a crude threshold sampler (`cfar.ts:329-370`). The real image-based polar-ray arm-pair detector is `backend/darkfleet/sar/wake.py` (ADV-004/005). |
| Exports (GeoJSON/KML/JSON) | BACKEND-ONLY | The client-side generators in `src/engine/export.ts` are deleted. All five formats, with provenance, are served by `backend/darkfleet/exports/render.py`. |
| PNG/PDF exports | IMPLEMENTED (was MISSING) | `GET /api/scans/{id}/export/png` and `/pdf`, rendered server-side with an unconditional provenance banner (EXP-004/005). |
| Tests (frontend) | 356 passing (was 6) | 8 files: `SpatialShell.test.ts` 91, `analysis.test.tsx` 60, `evidence.test.tsx` 53, `contacts.test.tsx` 48, `debug.test.ts` 43, `timeline.test.tsx` 35, `plan.test.tsx` 18, `registry.test.ts` 8. |

## Backend

| Subsystem | State | Evidence |
|---|---|---|
| `server.ts` Express API | DELETED 2026-10-02 | Was LEGACY: a DEMO-only pipeline, REAL hard-503 at `:105-127`, in-memory `Map` scan store at `:41` — a second analytical engine in TypeScript. Gone; every `/api` route is served by FastAPI in `backend/darkfleet/api/`. |
| STAC endpoint | REPLACED, was MISSING | The CP0 complaint was that `RealDataProvider` called `/api/stac/scenes`, which did not exist. Scene discovery is now `GET /api/scenes` (`api/routes.py:858`), which proxies the live provider catalog directly and requires an explicit `bbox`. |
| Python authority (`backend/`) | VERIFIED | Was IMPLEMENTED_UNVERIFIED (scaffold + config + provider model + georef). It is now the only analytical authority: 371 pytest pass, ruff clean, strict mypy clean, live REAL scans verified (CP6 addendum, CP13 container run). |
| Golden vectors | VERIFIED | `backend/tests/fixtures/golden/ts_engine_golden.json`, re-verified CP0; parity against it still passes in `test_cfar_parity.py` / `test_correlation_parity.py`. |
| AIS persistence | IMPLEMENTED (was MISSING) | `backend/darkfleet/ais/archive.py`: Parquet partitions + DuckDB queries, restart-safe with a rebuilt dedup set (CP4). |
| Job system / SSE / cache | IMPLEMENTED (was MISSING) | `backend/darkfleet/jobs/` 15-state machine with `subscribe()` for SSE at `GET /api/scans/{id}/events`; `backend/darkfleet/storage/cache.py` content-addressed with REAL hit counters (CP6). |
| Docker / Compose | IMPLEMENTED (was MISSING) | `docker/Dockerfile.api` + `docker/Dockerfile.web` + `docker-compose.yml`, both images built and run (CP13). |
| Synthetic scene generator | DELETED 2026-10-02 | `backend/darkfleet/demo.py` and `Settings.allow_synthetic_scenes` are gone. There is no `DEMO_SCENES` catalogue and no scene synthesiser anywhere. |

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

**This section is the CP0 assessment and describes the CP0 tree only.** It is
kept verbatim because "where it started" is the point of a takeover inventory.

A working DEMO-only product with a real (if crude) detector, a dead-but-sound
spatial shell, and a verified green backend scaffold. No real-data path is wired;
no persistence, jobs, cache, Docker, or E2E exist. The rebuild starts from
evidence, not from zero.

**Where it stands now (2026-10-02).** Every item above is resolved. The REAL
data path is live (CP6 addendum: a full 15-stage Sentinel-1 RTC scan, keyless);
persistence, jobs/SSE, cache and Docker all shipped (CP6, CP13); E2E and the
final audit remain open (CP14, CP16). The DEMO-only framing of the CP0
assessment no longer describes the product in any respect: the synthetic mode,
its generator and its TypeScript twin are deleted, and `README.md` now documents
the real Vite-plus-Python workflow.
