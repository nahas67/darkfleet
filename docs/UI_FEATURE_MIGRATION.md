# UI Feature Migration Matrix

> Old capability → new surface. Every row ends `MIGRATED`, `REPLACED`, or
> `REMOVED_WITH_JUSTIFICATION`. No silent loss. Verified at CP8–CP11.

| Old capability | Existing file:line | Required? | New surface | Disposition | Verification |
|---|---|---|---|---|---|
| Sector select (5 scenarios) | `Header.tsx:109-122` | yes | Scene Browser (sectors + real scenes) | REPLACED | select sector → camera flies |
| RUN SAR SCAN | `Header.tsx:126-137` | yes | Command dock SCAN + scan-on-AOI | REPLACED | scan completes, job events real |
| CFAR CONFIG button | `Header.tsx:140-147` | yes | Analysis workspace | REPLACED | workbench opens, apply re-runs |
| INTEL DEBRIEF button | `Header.tsx:150-157` | yes | Evidence inspector (AI section, optional) | REPLACED | constrained JSON renders |
| CONTACTS drawer toggle | `Header.tsx:161-172` | yes | Contacts surface | REPLACED | drawer parity |
| 2D/3D view toggle | `Header.tsx:176-185` | no | removed (Cesium only default; 2D = Analysis mode) | REMOVED_WITH_JUSTIFICATION | Analysis workbench covers raster needs |
| DARK / CRITICAL counters | `Header.tsx:188-205` | yes (neutralized) | Top-bar status (neutral wording) | REPLACED | no `CRITICAL` copy |
| GeoJSON/KML/JSON export | `Header.tsx:208-233` | yes | Export tray (+PNG/PDF via API) | REPLACED | 5 files with provenance |
| Zulu clock | `Header.tsx:59-67` | yes | Top-bar current time | MIGRATED | ticks, no 1 s full re-render |
| Brand block | `Header.tsx:75-102` | yes | Top-bar brand + mode pill | REPLACED | DEMO/REAL unmistakable |
| 2D canvas renderer | `TacticalMap.tsx` (all) | yes (as specialist tool) | ANALYSIS workbench raster stack | REPLACED | all 11 passes available |
| 3 raster colormaps | `TacticalMap.tsx:305-366` | yes | Workbench colormap controls | MIGRATED | pixel-identical mapping |
| 3 heatmap palettes + opacity | `TacticalMap.tsx:30-85,1006-1057` | yes | Workbench heatmap controls | MIGRATED | palettes selectable |
| Graticule + labels | `TacticalMap.tsx:276-302` | yes | Workbench overlay | MIGRATED | renders |
| AOI footprint + brackets | `TacticalMap.tsx:427-460` | yes | Cesium footprint + workbench box | MIGRATED | both render |
| STS 2 NM rings | `TacticalMap.tsx:465-483` | yes (neutral label) | Uncertainty/proximity geometry | REPLACED | no `threat` wording |
| Correlation tethers + m tags | `TacticalMap.tsx:486-512` | yes | Cesium correlation links | MIGRATED | distances shown |
| Kelvin wake V-lines | `TacticalMap.tsx:515-552` | yes | Wake overlay (slot; real geometry CP15) | MIGRATED | renders from evidence |
| AIS ghosts + labels | `TacticalMap.tsx:555-586` | yes | AIS positions + AIS_ONLY targets | REPLACED | ghosts become real targets |
| Target markers + boxes | `TacticalMap.tsx:589-674` | yes | Cesium detection entities | MIGRATED | click/hover/select |
| AOI drag-select | `TacticalMap.tsx:677-690,810-827` | yes | Spatial AOI tool + workbench box | MIGRATED | box → scan AOI |
| NM scale bar | `TacticalMap.tsx:693-711` | yes | Workbench scale bar | MIGRATED | correct at zoom |
| Wheel zoom / drag-pan / reset | `TacticalMap.tsx:756-900` | yes | Cesium camera suite | REPLACED | 11 commands, eased |
| LAYERS menu (7) | `TacticalMap.tsx:930-1004` | yes | Floating layers surface | REPLACED | registry-driven |
| Cursor lat/lon + dB probe | `TacticalMap.tsx:767-776,1093-1120` | yes | Workbench dB probe | MIGRATED | value under cursor |
| Compass rose (hardcoded) | `TacticalMap.tsx:1083-1090` | no | removed (derive or drop) | REMOVED_WITH_JUSTIFICATION | no invented look-angle |
| Classification badge | `TargetInspector.tsx:88-90` | yes | Evidence header | MIGRATED | canonical only |
| 24×24 SAR chip + toggle | `TargetInspector.tsx:114-173` | yes | Evidence IMAGERY tab | MIGRATED | phosphor/thermal kept |
| PEAK/CLUTTER/SNR | `TargetInspector.tsx:177-192` | yes | Evidence tab | MIGRATED | values shown |
| Dual confidence bars | `TargetInspector.tsx:200-226` | yes | Evidence confidence block | MIGRATED | decomposition shown |
| Position/length/heading | `TargetInspector.tsx:236-267` | yes | Evidence tab | MIGRATED | + uncertainty |
| Wake + box2d + pixelArea | `TargetInspector.tsx:254-266` | yes | Evidence tab | MIGRATED | — |
| AIS correlation detail | `TargetInspector.tsx:288-314` | yes | Evidence AIS tab | MIGRATED | full candidate detail |
| Tactical assessment + tags | `TargetInspector.tsx:334-351` | yes | OBSERVED/HYPOTHESES/UNKNOWNS | REPLACED | categories separated |
| Single-target GeoJSON/COPY | `TargetInspector.tsx:354-371` | yes | Export tray (with provenance) | REPLACED | provenance included |
| FOCUS camera hook | `TargetCard.tsx:164-170` (dead) | yes | inspectTarget/followTarget | MIGRATED | flies + follows |
| Progressive disclosure | `TargetCard.tsx` (dead) | yes | Inspector accordions | MIGRATED | default pattern |
| Stage bar | `ScanWorkflowBar.tsx` | yes | Job status in dock + timeline | REPLACED | real states only |
| Radar-targets tab + filters | `AISTelemetryTable.tsx` | yes | Contacts surface (+ sorting) | REPLACED | 3 filters + sort |
| AIS telemetry tab | `AISTelemetryTable.tsx:229-268` | yes | Contacts AIS tab | MIGRATED | columns kept |
| Row↔map selection | `AISTelemetryTable.tsx:165-218` | yes | Bidirectional sync + camera-fly | REPLACED | both directions |
| Sector/target/MMSI search | `SpatialSearch.tsx` (dead) | yes | Wired search + scan-ID | MIGRATED | drives camera |
| Layer visibility/opacity | `layerRegistry.ts` (dead) | yes | Layers surface | MIGRATED | all 12 layers |
| DEMO/REAL provider switch | `dataProvider.ts` (dead) | yes | Mode pill + settings | MIGRATED | strict isolation |
| Camera presets | `cameraController.ts` (4 uncalled) | yes | Full suite wired | MIGRATED | all 11 commands |
| WebGL fallback | `cesiumViewer.ts:23` (uncalled) | yes | Startup check + fallback view | MIGRATED | renders message |
| AI summary + per-target notes | `IntelligenceDebriefModal.tsx` | yes (optional) | Evidence AI section | REPLACED | constrained schema |

Legacy files are deleted only after the Verification column is ticked, and each
deletion lands in `docs/REMOVALS.md` (UI-037).
