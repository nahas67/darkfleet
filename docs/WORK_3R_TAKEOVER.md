# DarkFleet Work 3R — Takeover Audit

**Timestamp:** 2026-10-01T10:57:00-07:00  
**Repository ID:** 7a923af0-638a-48a3-9cc4-45ec98b4526c  
**Author:** DarkFleet-Core Takeover Engineer

---

> ## ⚠ SUPERSEDED IN PART — this is a historical handover record
>
> **This file is a point-in-time audit taken at 2026-10-01T10:57 and is left
> unedited below.** It is not a live work plan and must not be read as one: the
> dispositions it assigns were overtaken by what actually shipped. It is kept
> because the takeover reasoning is worth having, and because deleting it would
> lose the record of what the second analytical engine was.
>
> **Do not act on the rows below without this note.** Corrections, 2026-10-02:
>
> | Row here | Said | Actually true now |
> |---|---|---|
> | §1, §2 `server.ts` **ACTIVE** | the dev/server entry, via `tsx`, on port 3000 | **Deleted.** It was a 375-line Express server reimplementing the whole pipeline in TypeScript and defaulting to DEMO. `npm run dev` is now `vite`; `npm start` is `vite preview`. The API is FastAPI in `backend/`, reached through Vite's `/api` proxy. |
> | §2 `src/engine/rasterSynthesis.ts` **REUSABLE (DEMO ONLY)** | a module to keep and label | **Deleted**, along with the whole synthetic scene concept. There is no DEMO mode to isolate it to. |
> | §2 `src/data/dataProvider.ts` **MIGRATION → REWRITE** | expand into `DemoDataProvider` + `RealDataProvider` | **Deleted.** That expansion was never written. The only client is `src/app/useApi.ts`, and there is one provider kind, not two. |
> | §2 `src/types/darkfleet.ts` **MIGRATION → REWRITE** | keep, modernising its types | **Deleted.** The wire contract lives in `src/types/api.ts` + `src/app/useApi.ts`. |
> | §2 every other path in the classification matrix | ACTIVE / REUSABLE / SPECIALIZED | **Deleted 2026-10-02** — 35 modules, proven unreachable from `src/main.tsx`. |
> | §4 "Current Data Flow & Synthetic Leaks" | describes the live architecture | Describes a tree that no longer exists. All five leaks it lists are closed: synthetic generation is gone from both languages, `RealDataProvider` exists in Python, and the criminal-narrative copy is gone. |
> | §5 Gate 4 (`RuntimeMode = 'DEMO' \| 'REAL'`) | introduce the two-valued enum | Never done, and deliberately not done. `RuntimeMode` is a single-member StrEnum; `RuntimeModeLiteral` is `Literal["REAL"]`. |
> | §5 Gate 5/6/7 (`DemoDataProvider`, remove local synthesis) | implement the split | Obsolete. The split is replaced by "there is no DEMO side": synthetic generation was deleted outright, and tests read a checked-in COG fixture through the production pipeline. |
>
> **What is still worth reading below:** §5 Gates 1, 2, 8, 10 (Cesium as the sole
> viewport, wiring the floating shell, shrinking the root component, canonical
> classifications) were carried out and shipped. §4's leak list is a good
> statement of the failure modes this project is built to avoid, even though the
> code it describes is gone.
>
> Current state of record: `CURRENT_STATE.md`, `REMOVALS.md`, and
> `EXECUTION_LEDGER.md`.

---

## 1. Application Entry Path & Runtime Inventory

The application is a full-stack Node.js + Express + Vite + React 19 SPA running on port 3000.

- **Dev / Server Entry:** `server.ts` running via `tsx`
- **Client HTML Entry:** `index.html` (with Cesium styles and `window.CESIUM_BASE_URL = '/cesium'`)
- **Client JS Entry:** `src/main.tsx` mounting `src/App.tsx`
- **Global Styles:** `src/index.css` (Tailwind CSS `@import "tailwindcss"`, JetBrains Mono & Inter typography)

---

## 2. Source File Classification Matrix

| File Path | Status | Role & Disposition |
|---|---|---|
| `server.ts` | ACTIVE | Express API server (`/api/scenes`, `/api/scans`, `/api/scans/:id`, exports, `/api/scans/analyze-ai`, `/api/health`). Currently calls synthetic pipeline in both demo & fallback. Needs real/demo provider separation and SSE/event streaming for scan stages. |
| `src/main.tsx` | ACTIVE | Client mount entry. Pristine. |
| `src/index.css` | ACTIVE | Global CSS with Tailwind 4. Pristine. |
| `src/App.tsx` | ACTIVE (LEGACY HYBRID) | Currently mounts 2D `TacticalMap` as default with optional 3D globe toggle, carries redundant client-side synthesis and `setTimeout` stages. Must be refactored into a concise root shell composing `DarkFleetSpatialShell`. |
| `src/globe/DarkFleetGlobe.tsx` | REUSABLE | CesiumJS full-screen viewport. Needs layer registry integration, camera controller hooks, and resource disposal verification. |
| `src/globe/cesiumViewer.ts` | REUSABLE | Cesium viewer initializer with dark oceanic theme and keyless baseLayer setup. Working. |
| `src/globe/cameraController.ts` | REUSABLE | Camera flight controllers (`flyToScenario`, `focusTarget`, `resetGlobe`, `setTopDown`, `setOrbit`). Needs inspection easing and target locking. |
| `src/globe/sarOverlay.ts` | REUSABLE | Offscreen canvas SAR backscatter imagery provider overlay on Cesium terrain. Working. |
| `src/globe/sceneFootprint.ts` | REUSABLE | AOI bounding box rectangular outline and corner brackets in Cesium world-space. Working. |
| `src/globe/targetEntities.ts` | REUSABLE | Cesium billboard pins, heading vectors, and correlation line entities. Needs classification update to canonical schema. |
| `src/globe/aisTracks.ts` | REUSABLE | AIS position diamond billboards and velocity leader lines. Working. |
| `src/components/shell/BrandMark.tsx` | REUSABLE (BUGGY) | Top-left brand mark. Bug: displays `SIMULATION` regardless of prop. Needs canonical `RuntimeMode` ('DEMO' \| 'REAL') support. |
| `src/components/shell/MissionStatus.tsx` | REUSABLE | Top-right telemetry readout for sensor, polarization, and scene ID. Working. |
| `src/components/shell/LeftRail.tsx` | REUSABLE | Floating left action rail for layers, sectors, and color palettes. Needs layer registry binding. |
| `src/components/shell/IntelHud.tsx` | REUSABLE | Sparse non-intrusive HUD for cursor lat/lon/alt and target tracking. Working. |
| `src/components/shell/CommandDock.tsx` | REUSABLE (NEEDS COMPACT REWORK) | Bottom floating command dock. Currently 94vw wide; needs compact primary controls (`SEARCH`, `SCAN`, `TIME`, `LAYERS`, `VIEW`) with popover trays. |
| `src/components/target/TargetCard.tsx` | REUSABLE (PRIMARY) | Floating target evidence card with progressive disclosure. Needs canonical classification and evidence workspace link. |
| `src/components/panels/TelemetryOverlay.tsx` | REUSABLE | Bottom drawer data table for contacts and AIS observations. Needs canonical classification migration. |
| `src/components/CFARWorkbench.tsx` | REUSABLE | Parameter tuner for CA-CFAR algorithm ($N_{\text{train}}$, $N_{\text{guard}}$, threshold factor). Preserved as contextual analysis modal. |
| `src/components/IntelligenceDebriefModal.tsx` | REUSABLE | Military/intelligence report modal with Gemini AI integration. Needs neutral evidence wording. |
| `src/components/Header.tsx` | LEGACY -> REPLACE | Top toolbar from 2D dashboard era. Replaced by floating spatial shell (`BrandMark`, `MissionStatus`, `CommandDock`). |
| `src/components/ScanWorkflowBar.tsx` | LEGACY -> REPLACE | Bottom 2D pipeline stage bar. Replaced by real scan progression in `CommandDock`. |
| `src/components/TacticalMap.tsx` | SPECIALIZED ANALYTICAL | 2D Canvas SAR backscatter radar map. Re-framed from primary view into an on-demand contextual raster analysis workbench (`ANALYSIS -> RASTER WORKBENCH`). |
| `src/components/TargetInspector.tsx` | LEGACY -> REPLACE | Replaced by `TargetCard` and `EvidenceWorkspace`. |
| `src/components/AISTelemetryTable.tsx` | LEGACY -> REPLACE | Replaced by `TelemetryOverlay`. |
| `src/data/dataProvider.ts` | MIGRATION -> REWRITE | Contains minimal `SimulationDataProvider`. Must be expanded to canonical `DarkFleetDataProvider` with `DemoDataProvider` and `RealDataProvider`. |
| `src/data/scenes.ts` | REUSABLE | Catalog of Sentinel-1 scenes and regional scenarios. Needs neutral fixture IDs. |
| `src/engine/cfar.ts` | REUSABLE | CA-CFAR 2D sliding window detector and connected-component extractor. Pristine physics. |
| `src/engine/correlation.ts` | REUSABLE | Spatio-temporal matching between radar detections and AIS broadcasts. Needs canonical classifications and score decomposition persistence. |
| `src/engine/export.ts` | REUSABLE | GeoJSON, KML, and Analytical Protocol JSON generators. Needs canonical classifications and explicit provenance. |
| `src/engine/geodesy.ts` | REUSABLE | Haversine distance, dead-reckoning projection, dynamic match radius. Pristine math. |
| `src/engine/rasterSynthesis.ts` | REUSABLE (DEMO ONLY) | Synthetic SAR backscatter and AIS kinematic generator. Needs neutral fixture labeling. Isolated strictly to `DEMO` mode. |
| `src/types/darkfleet.ts` | MIGRATION -> REWRITE | Core types. Must replace legacy `dark_vessel` / `threatLevel` / `NO_TRANSPONDER` with canonical schema. |

---

## 3. Active vs Dead Component Graph

```text
CURRENT ACTIVE RUNTIME (App.tsx):
App.tsx
├── Header (LEGACY)
├── TacticalMap (LEGACY 2D DEFAULT)
├── TargetInspector (LEGACY)
├── ScanWorkflowBar (LEGACY)
├── AISTelemetryTable (LEGACY)
├── CFARWorkbench (CONTEXTUAL)
├── IntelligenceDebriefModal (CONTEXTUAL)
└── DarkFleetGlobe (OPTIONAL 3D TOGGLE - UNUSED AS PRIMARY)

CURRENT DISCONNECTED SPATIAL GENERATION (DEAD / UNUSED):
├── BrandMark
├── MissionStatus
├── LeftRail
├── IntelHud
├── CommandDock
├── TargetCard
└── TelemetryOverlay
```

---

## 4. Current Data Flow & Synthetic Leaks

1. `App.tsx` calls `synthesizeSceneRaster()` locally inside `runScan()` *before* invoking `/api/scans`.
2. When `/api/scans` returns or fails, `App.tsx` invokes `runLocalScan()`, executing another local synthesis.
3. `/api/scans` on the server calls `synthesizeSceneRaster()` unconditionally.
4. There is no `RealDataProvider` implementation for live STAC or historical AIS queries.
5. `threatLevel` ('CRITICAL' / 'ELEVATED' / 'ROUTINE') and `NO_TRANSPONDER` tags leak criminal narratives into unbiased spatial detections.

---

## 5. Required Architectural Plan

1. **Gate 1 & 2:** Make `Cesium` the sole primary spatial viewport through `DarkFleetSpatialShell`. Provide an explicit `WebGLUnavailableFallback` screen rather than silently running 2D.
2. **Gate 3:** Wire all floating spatial components (`BrandMark`, `MissionStatus`, `LeftRail`, `IntelHud`, `CommandDock`, `TargetCard`, `TelemetryOverlay`).
3. **Gate 4:** Introduce canonical `RuntimeMode = 'DEMO' | 'REAL'`.
4. **Gate 5, 6, 7:** Implement `DarkFleetDataProvider` (`DemoDataProvider`, `RealDataProvider`). Remove local synthesis from `App.tsx`.
5. **Gate 8:** Shrink `App.tsx` to root composition.
6. **Gate 9:** Implement event-driven scan stage streaming via SSE/events, eliminating fake `setTimeout` timers.
7. **Gate 10:** Adopt canonical classifications (`SAR_MATCHED_AIS`, `SAR_UNMATCHED`, `AIS_ONLY`, `STATIONARY_OR_INFRASTRUCTURE`, `SEA_CLUTTER`, `LOW_CONFIDENCE`, `UNRESOLVED`). Remove legacy fields.
8. **Gate 11 - 17:** Layer Registry, completed Camera Controller, Spatial Search, TargetCard evidence decomposition, Evidence Workspace, Timeline, and Display Modes.
9. **Gate 18 - 29:** Remove dead legacy components, add Vitest test suites, verify production builds and viewports.
