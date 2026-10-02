# PRODUCT INTEGRATION AUDIT — IR0

**Date:** 2026-10-02
**Scope:** actual repository and runtime state, measured. Supersedes every prior
parity/checkpoint document where they conflict with code or observed runtime.

Every claim below is backed by a command that was run, or a response captured from
the running container. Where a brief's premise turned out to be stale, that is
recorded rather than silently absorbed.

---

## 0. HEADLINE

The brief's central premise — *"the repository contains substantially more
capability than the running product exposes: ~43 production modules, ~8
reachable, ~35 outside the active runtime graph"* — **was true when it was
written and is no longer true now.** Those 35 modules were deleted earlier in this
same session, with the owner's explicit instruction ("delete demo, i hate it").
The audit below therefore measures the repository as it stands, and the plan that
follows is built on what actually exists rather than on what used to.

The *real* integration gap is still large, but it is a different one, and it is
smaller and more specific than the brief describes. It is quantified in §4.

---

## 1. CHECKPOINT A — ALREADY COMPLETE

| Brief premise | Actual state | Evidence |
|---|---|---|
| "repository currently contains Python FastAPI backend + legacy server.ts Express backend" | **Express backend is gone** | `Test-Path server.ts` → `False` |
| "The current npm development path can still launch the legacy server" | **It cannot** | `package.json.scripts` → `dev: vite`, `start: vite preview` |
| "Remove the legacy Express application" | **Done** in `7764af8` | git log |
| "There must be exactly one authoritative backend" | **Satisfied** — FastAPI only | no other server entrypoint exists |

Supporting detail, because it matters for Checkpoint F:

- `server.ts` was not merely unreachable. It was a 375-line TypeScript
  reimplementation of CA-CFAR, AIS correlation and geojson/kml export, and it
  **defaulted to DEMO** (`runtimeMode = 'DEMO'`), fabricating SAR rasters via
  `synthesizeSceneRaster`. It contradicted `vite.config.ts`'s own stated
  principle: *"the Python backend is the single analytical authority."*
- `vite.config.ts` already proxies `/api` → `http://127.0.0.1:8000`
  (`DARKFLEET_API_URL`). Docker runs only `api` (FastAPI) and `web` (nginx over
  the Vite bundle). `server.ts` was reachable only via npm and in no deployment.

**Checkpoint A requires no further work.**

---

## 2. ACTUAL FRONTEND REACHABILITY

Measured by resolving the import graph from `src/main.tsx`
(`Temp/opencode/reverify_graph.py`, using a specifier regex that handles
multi-line imports, `vi.mock()` and dynamic `import()` — the first version of
this analysis missed multi-line imports and was wrong).

```
production frontend modules present : 17
reachable from src/main.tsx         : 18   (incl. main.tsx itself)
orphan test files                   : none
live modules importing a missing file: none
unexpected disconnected modules     : 0
```

The live set:

```
src/main.tsx
src/index.css (not a module)
src/app/SpatialShell.tsx
src/app/state.ts
src/app/useApi.ts
src/app/useScan.ts
src/globe/cesiumViewer.ts
src/globe/registry.ts
src/globe/scanLayers.ts
src/globe/globeBridge.ts
src/types/api.ts
src/analysis/{analysis.test.tsx, AnalysisWorkbench.tsx, cfar.ts, debug.test.ts,
              debugLayers.ts}
src/contacts/{contacts.test.tsx, Contacts.tsx}
src/evidence/{evidence.test.tsx, TargetInspector.tsx}
src/plan/{AcquisitionPlan.tsx, plan.test.tsx}
src/timeline/{timeline.test.tsx, Timeline.tsx}
src/globe/{scanLayers.test.ts, globeBridge.test.ts, registry.test.ts}
```

### 2.1 Modules Checkpoint F asks me to "wire in" — all deleted

Checkpoint F says to *evaluate and reuse where correct* these modules. **None of
them exist any more.**

| Module named in Checkpoint F | Actual state |
|---|---|
| `globe/camera.ts`, `globe/cameraController.ts` | **MISSING** |
| `globe/useGlobeLayers.ts` | **MISSING** |
| `globe/layerRegistry.ts` | **MISSING** (a `LayerRegistry` *class* still exists inside `globe/registry.ts`) |
| `globe/sarOverlay.ts` | **MISSING** |
| `search/SpatialSearch.tsx` | **MISSING** |
| `components/TacticalMap.tsx` | **MISSING** |
| `components/CFARWorkbench.tsx` | **MISSING** |
| `components/TargetInspector.tsx` | **MISSING** (a *different*, live one exists at `src/evidence/TargetInspector.tsx`) |
| `components/Header.tsx` | **MISSING** |

They were deleted in `7764af8` because they were provably unreachable from
`src/main.tsx` **and** seven of them carried DEMO mode toggles and "DEMO DATA"
banners. Deleting one DEMO file forced deletion of everything importing it, so
the tree went as a unit. 89 tests that guarded only that dead code went with it.

**Consequence for the plan:** Checkpoints F, and the parts of E and the
"analytics / CFAR workbench" and "2D SAR analysis" sections that name these
files, are **greenfield work, not re-integration.** Re-creating them from memory
would be fabricating prior art; the honest move is to build the required
capability deliberately, re-using only what still exists
(`globe/registry.ts`, `analysis/AnalysisWorkbench.tsx`, `analysis/debugLayers.ts`,
`analysis/cfar.ts`).

---

## 3. BACKEND SURFACE — MEASURED

15 API operations + 2 liveness. All confirmed live and reachable.

| Method | Path | Frontend calls it? |
|---|---|---|
| GET | `/health` | (liveness; Docker healthcheck) |
| POST | `/api/scans` | yes |
| GET | `/api/scans/{id}` | yes |
| GET | `/api/scans/{id}/events` | yes |
| GET | `/api/scans/{id}/targets` | yes |
| GET | `/api/scans/{id}/export/{fmt}` | yes |
| GET | `/api/scenes` | yes |
| GET | `/api/targets/{id}` | yes |
| GET | `/api/targets/{id}/summary` | **NO — disconnected** |
| GET | `/api/evidence/{id}` | yes |
| GET | `/api/debug/{id}/{layer}` | yes |
| GET | `/api/providers/health` | yes |
| GET | `/api/tracks` | **NO — disconnected** |
| GET | `/api/patterns` | **NO — disconnected** |
| GET | `/api/detectors` | **NO — disconnected** |
| GET | `/api/revisit` | yes |

### 3.1 Backend capability with no UI workflow (4)

These are real, working, tested backend features with **no reachable user
workflow**. This is the concrete, measured version of the brief's IR0 step 7:

1. **`GET /api/tracks`** — multi-pass target hypotheses (CP15 `tracks.py`).
2. **`GET /api/patterns`** — temporal pattern detection (CP15 `temporal.py`).
3. **`GET /api/detectors`** — detector registry, CFAR/ML/ensemble capability state.
4. **`GET /api/targets/{id}/summary`** — deterministic narrative writer
   (`darkfleet/template@1`), the two-tier fabrication guard.

---

## 4. THE REAL INTEGRATION GAP — MEASURED

### 4.1 Checkpoint B — DTO mismatch: CONFIRMED, with live evidence

The brief cites `cls` vs `classification`. Verified against the running
container, not inferred.

Live `GET /api/scans/DF-0011/targets`, first target, complete key list:

```
aisConf 0.0     area 5        assessment 'Unmatched surface radar return (~15m).
                                 No sufficiently conf…'
cls 'SAR_UNMATCHED'                                <-- backend field
corr {...}     hdg 89        id 'DF-001'
lat 1.267269   lenM 15       lenUncM 10     lon 103.85533
maxDb -9.4     meanDb -10.3  sarConf 0.54
tags [...]     wake False     widM 12
```

```
has 'cls'            : True
has 'classification' : False
```

`frontend/src/types/api.ts` declares `VesselTarget.classification` and the globe
code reads `t.classification`. So **the detection's classification is `undefined`
in every live render path today** — detections are drawn, but coloured by a
default branch, not by their real class. Classes actually observed live:
`['SAR_UNMATCHED', 'SEA_CLUTTER', 'STATIONARY_OR_INFRASTRUCTURE']`.

Backend emits `cls` in `darkfleet/correlation/match.py` (lines 152–194). This is
the single highest-severity finding: it is not a cosmetic mismatch, it silently
degrades a user-visible judgement.

Two further instances of the same class of defect:
- `ScanTargetsResponse.targets` is typed `list[dict[str, Any]]` on the backend, so
  FastAPI validates nothing inside it. The payload shape is unchecked on both sides.
- `toGlobeScanResult` casts `targets` via `as unknown as VesselTarget[]`, which
  is precisely the "cast partially validated JSON into a large trusted domain
  type" the brief forbids. It is my code from `724dad6` and it is a real defect.

### 4.2 Checkpoint E — SAR raster: NOT RENDERED AT ALL

The brief warns against feeding GeoTIFF to a browser image primitive. The
measured situation is worse than the warning anticipates:

```
grep SAR_RASTER|imageryLayer|ImageryLayer|singleTile|GeoTIFF|.tif
  in src/globe/globeBridge.ts and src/globe/scanLayers.ts  ->  (no matches)
```

**The SAR raster is never rendered.** `globeBridge` pushes exactly five layers:
`SAR_SCENE_FOOTPRINT`, `SAR_DETECTIONS`, `UNCERTAINTY_RADII`, `AIS_CONTACTS`,
`CORRELATION_LINKS`. `LAYER_DEFS` advertises `SAR_RASTER` and `LAND_MASK` as
`AVAILABLE`, but nothing feeds them.

The only existing raster-ish endpoint is `GET /api/debug/{id}/{layer}`. Measured
against all 13 debug layers:

```
raw                200 application/json   477 B  ['columns','dtype','grid','grid_size',
                                               'kind','layer','notes','row_limit','rows',
                                               'scan_id','shape','source']
normalized         200 application/json   605 B   (same keys)
landmask           200 application/json   367 B   (same keys)
filtered           200 application/json   483 B   (same keys)
cfar_threshold     200 application/json   499 B   (same keys)
detection_mask     200 application/json   373 B   (same keys)
components         200 application/json   340 B   (same keys)
centroids          200 application/json   300 B   (same keys)
ais_observations   200 application/json   674 B   (same keys)
correlation_lines  200 application/json   667 B   (same keys)
```

So the debug workspace is **functional and returns downsampled numeric grids as
JSON**, not images, and carries no georeferencing needed to place them on the
globe. There is **no** endpoint anywhere that serves a georeferenced raster
image. Checkpoint E is greenfield.

### 4.3 UI controls with no real implementation

Measured: no fake buttons were found. Every layer toggle in `SpatialShell`
mutates real store state, and since `724dad6` that state is mirrored onto real
Cesium entities and was observed to work in a browser. There are **no** dead
buttons.

There is, however, an inverse problem: `LAYER_DEFS` declares `SAR_RASTER` and
`LAND_MASK` `AVAILABLE` while nothing implements them — a layer panel promising
two layers the product cannot draw. That is the same defect class as the CP14
"switches connected to nothing" finding, in a smaller form, and it must be fixed
either by implementing them or by demoting them to `NOT_AVAILABLE` with a reason.

### 4.4 AIS telemetry: partial

- `GET /api/scans/{id}/targets` returns `ais_only: []` and
  `ais_only_count: 0` on the live scan, because no AIS provider is configured.
- There is **no** endpoint for timestamped AIS observations or a vessel track:
  `GET /api/scans/{id}/ais`, `/api/targets/{id}/ais-observations` and
  `/api/vessels/{mmsi}/track` **do not exist**.
- Therefore `AIS_TRAILS` is declared `AVAILABLE` but cannot be drawn, and the
  brief's "AIS trails must not be fabricated from only one point" constraint is
  currently satisfied only vacuously (nothing is drawn).

---

## 5. WHAT IS GENUINELY WORKING TODAY

Not everything is broken. Measured, live, in a browser:

- REAL scan end to end: `S1D_IW_GRDH_1SDV_20260927T112445_…`, 23 detections,
  counts `{SAR_UNMATCHED: 14, SEA_CLUTTER: 3, STATIONARY_OR_INFRASTRUCTURE: 6}`.
- Globe drawing: 0 → 47 Cesium entities after a scan (1 AOI, 23 detections,
  23 uncertainty rings). Layer toggles verified to control entity `show`.
- GEO-001 marine region: first target resolves to "Strait of Singapore".
- GEO-002 acquisition plan: 17 acquisitions, 2 platforms, median gap 7.74 d.
- GEO-003 vertical datum: `altitude_measured: false` in target evidence.
- All 13 debug layers return data.
- Exports PNG/PDF/GeoJSON/KML/JSON are implemented server-side (`be9cd07`
  removed the dead 501).
- 371 backend tests, 392 frontend tests, ruff/mypy/tsc/build clean.

---

## 6. WORKFLOW 2 ("DEMO") IS NOT BUILDABLE — AND MUST NOT BE

The brief's E2E Workflow 2 requires "full successful deterministic **DEMO**
workflow", and Workflow 1/DEMO appear again in the verification matrix.

This project has **no DEMO mode**, by explicit repeated instruction from the
owner in this session ("delete demo, i hate it, don't need that"), executed
across commits `d6f99d8`, `be9cd07`, `7764af8`, `f3540c1`.

The equivalent deterministic offline workflow that *does* exist is the fixture
harness: `tests/fixture_source.py` runs the **production** pipeline against a
checked-in COG (`tests/fixtures/cog/fixture_32648.tif`), whose own sidecar lists
3 vessel pixels and the pipeline returns exactly 3 detections.

**Decision:** Workflow 2 will be executed as **FIXTURE-DETERMINISTIC** — the real
pipeline against a real GeoTIFF on disk, offline — and labelled as such. I will
not reintroduce a synthetic mode to satisfy a test matrix, and I will not silently
report a fixture run as a "DEMO run". Flagged here because it is a direct
conflict with the written brief, resolved in favour of the owner's standing
instruction.

---

## 7. IR0 CONCLUSION — the gap, restated accurately

| # | Finding | Severity | Checkpoint |
|---|---|---|---|
| 1 | `cls` vs `classification` — classification is `undefined` in every render path | **Critical** | B |
| 2 | SAR raster never rendered; no georeferenced image endpoint exists | **Critical** | E |
| 3 | 4 backend capabilities (`tracks`, `patterns`, `detectors`, `summary`) have no UI workflow | High | D, F |
| 4 | No AIS observation/track endpoints; `AIS_TRAILS` undeliverable | High | D, F |
| 5 | `SAR_RASTER` + `LAND_MASK` advertised `AVAILABLE` but unimplemented | High | F |
| 6 | Frontend types unvalidated (`list[dict]`, `as unknown as`) | High | B |
| 7 | The modules named in Checkpoint F were deleted | Informational | plan input |
| 8 | Brief's E2E "DEMO" workflow conflicts with owner instruction | Informational | §6 |

Checkpoint A is already complete. Checkpoint B and E are the two genuine
blockers, and both are contract/rendering problems rather than missing features —
which is a materially better starting position than the brief implies.

---

*Every number in this document came from a command run against this repository or
the running container on 2026-10-02. Nothing is carried over from a prior
checkpoint document without re-measurement.*
