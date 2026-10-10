# SYSTEM and LAYERS re-verification — 2026-10-11

## Scope and verification method

- Initial inspected HEAD: `3833fc4c71a17206943d80b8f1ae7d7b58866389` (other workers advanced `main` while this audit ran).
- Edited only `src/command/SystemPanel.tsx`, `src/sensors/LayerConsole.tsx`, corresponding scoped tests, and this document.
- Inspected the actual caller `DarkFleetCommandApp.tsx`, store and API client, `TacticalWorld.tsx`, `MapSourceController.ts`, the Cesium engine/layer registry, API Pydantic routes and models. Those files were read only.
- Focused pre-change baseline: 3 test files / 47 tests passing. Meaningful new regressions were reproduced failing before code changes.

## What the controls really operate

| Control or section | Actual authority / data | Verified scope or repair |
| --- | --- | --- |
| SYSTEM source Re-probe | `loadProviders` calls `/api/providers/health`, updates the shared store | Disabled while loading; previously reported individual states retained with explicit refreshing hint. Worst reported status is now actually computed, using `healthSeverity` order; unknown statuses are never defaulted to `NOT_CONFIGURED`. |
| SYSTEM archive Re-probe | `useArchiveCoverage` calls `/api/ais/coverage` | Loading, failure and ready remain separate; repeated click is disabled while a probe is in flight. The archive is deployment-wide, not proof of a specific target's AIS coverage. |
| SYSTEM map-source choice | `engine.selectBasemapSource`, `MapSourceController.select` | Choices disable unconfigured sources. Attempted failed sources appear individually; automatic engine fallback/recovery now gets an inspector refresh while mounted (5 s polling with cleanup). Active only establishes provider construction, not successful delivery of every imagery tile. |
| SYSTEM dataset Re-check | `loadDatasetHealth(true)` calls `/api/maritime/datasets` | Disabled while loading. Cached health remains labelled previous/stale on re-check failure, with a visible failure reason; dependent maritime switches are unavailable until a successful inventory read. |
| SYSTEM geometry built | `engine.maritimeEntityCounts()` plus layer visibility | Displays actual retained Cesium entity counts, independent of what is installed; does not misstate counts as geographic coverage. |
| LAYERS visibility buttons | `store.layerState` → `TacticalWorld` effect → `engine.setLayerVisibility` | Three-state ON/OFF/UNAVAILABLE and `aria-pressed` maintained. Unavailable buttons have a concrete reason; stored preference survives unavailability. |
| LAYERS opacity sliders | Stored `layerState.opacity`, but **no** `TacticalWorld` or `engine` opacity application | Removed inert range controls. Existing saved-view opacity values are preserved in the data contract; no UI claims they affect Cesium. Globe opacity requires a separate engine implementation and tests in a later authorized scope. |

Per-layer drawability audit: `SAR_RASTER` needs a loaded raster; `SAR_SCENE_FOOTPRINT` uses the same loaded-raster evidence even if a scan found zero detections; `SAR_DETECTIONS` needs targets; `UNCERTAINTY_RADII` needs an observed positive radius; `AIS_CONTACTS` requires AIS evidence; `AIS_TRACKS` requires at least two usable observations of the same vessel (or the selected track); `AIS_PREDICTED` requires finite backend propagation and is also guarded by the runtime renderer refusal; `CORRELATION_LINKS` is disabled with an explicit unavailable reason because `engine.setCorrelationLinks` currently has **no production caller**. `LAND_MASK` and `CFAR_DEBUG` remain unavailable as simultaneous globe overlays and point to ANALYTICS. `GRATICULE` works without scan evidence. The coastline, EEZ, and high-seas toggles each use their own backend dataset ID and inherit runtime loader/provenance refusals.

The material missing integration is **correlation links**: the method exists in `src/globe/engine.ts`, but a source search found no invocation from product code. An enabled control would claim to draw geometry that no caller supplies. Restoring it requires a verified canonical association-to-geometry caller in a separate owned scope, not a synthetic link.

## Live local API observation

On 2026-10-11 (Asia/Kolkata), `curl.exe --silent --show-error --max-time 3 http://127.0.0.1:8000/api/maritime/datasets` **returned JSON successfully**, `generated_at=2026-10-10T21:11:57Z`, six registered datasets, `usable_count=1`, `verified_count=0`. These are the backend's own installed-file statements, not an independent byte-for-byte digest verification by this worker:

| Dataset | Backend status | Interpretation |
| --- | --- | --- |
| `natural_earth_coastline` | `CHECKSUM_UNRECORDED`, `usable=true` | Parsed local reference data; publisher checksum not recorded, so not checksum-verified. |
| `marine_regions_eez_wfs` | `NOT_INSTALLED`, `usable=false` | No local EEZ WFS snapshot. Bulk `marine_regions_eez` is separately not installed; its version 12 is not the WFS snapshot's version. |
| `marine_regions_high_seas_wfs` | `NOT_INSTALLED`, `usable=false` | No local high-seas geometry snapshot; do not infer high seas from absence of EEZ coverage. |
| `nga_world_port_index` | `NOT_INSTALLED`, trusted-source TLS blocker | The backend reports a certificate trust/transport failure. TLS verification was not bypassed. |
| `gebco_2025` | `NOT_INSTALLED`, optional | No local bathymetry. No globe bathymetry switch is enabled or implied by this fact. |

`GET /api/providers/health` at the same loopback address did not complete within a **3-second client timeout** (`curl` exit 28 with zero response bytes). This establishes only that that specific probe exceeded 3 s; it does **not** prove any individual source is unavailable. The frontend's `loadProviders` catches a failed request and writes `providers: []` without preserving an error message. That unresolved API/store limitation prevents SYSTEM from distinguishing an empty provider list from a failed probe. Fixing it needs authorization for `api/client.ts` and `state/store.ts`, outside this worker's edit scope.

## Evidence and remaining limits

- Pre-change 47 tests passed; new tests initially reproduced stale-health, control-availability and decorative-opacity behavior as failures, then verified the repairs, including actual React server markup.
- `npm test -- --run src/sensors/systemLayersReverify.test.tsx src/sensors/layerControlState.test.ts src/command/basemapProviderHealth.test.ts src/globe/layerRegistry.test.ts` verified scoped controls. `npm run lint` and `npm run build` were executed; final results are in the worker handoff.
- The live maritime inventory confirms installation state, not actual WebGL rendering. No browser `scene.pick`, painted coastline/EEZ polygons, GPU timing, or visual inspector screenshot was verified here. Unavailable maritime datasets remain unavailable; no fake fallback geometry was added.
- No changes to `src/globe`, other workers' files or master verification documents; no remote push.
