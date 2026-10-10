# DarkFleet frontend workflow re-verification — 2026-10-11

## Scope and entrypoints

Baseline inspected: `15ece157c926c04172728127b11a3aa5765c600a` (local repository, before this repair).

- `src/main.tsx` renders `DarkFleetCommandApp`. `OperationRail` exposes TASKING, MISSIONS, ADVANCED, VIEWS and SYSTEM. TASKING and TACTICAL mount `ScanWorkflow`; MISSIONS mounts `MissionWorkspace`; VIEWS mounts `SavedViewsWorkspace`.
- ADVANCED mounts `AdvancedWorkspace`, whose tabs mount `SceneComparisonWorkbench`, `SceneImageryWorkspace`, `LocalSarImportPanel` and `AnalystWorkspace`, alongside its other analysis tabs. The Local GeoTIFF tab is present and selectable in source.
- `SceneBrowser.tsx` implements scene card selection, but no current import or mount was found under `src/`. It is therefore **unreachable from the shipped entrypoint**, despite having a UI component. This is an integration decision for the prime owner of the app shell.
- SYSTEM provides operational source/map configuration and health controls. There is **no separate general settings workspace** in the current rail. A comprehensive configuration/settings UX cannot be inferred from these existing controls.

## Reproduced source-level failures and repairs

1. TASKING accepted northwest/northeast WGS84 out-of-range AOIs (`0,0,200,100`) because `parseBbox` only checked the southwest corner. Both corners now use the same WGS84 coordinate bounds as `backend/darkfleet/api/models.py`; a dedicated regression checks invalid coordinates and the disabled run button.
2. TASKING fetched scenes only when the AOI flipped between valid/invalid, so changing an already valid area kept scenes from an earlier area. Scene fetch now tracks the actual typed AOI, uses a 300-ms debounce and serializes requests in the mounted workflow to keep the latest request last. Editing AOI clears the stale selected scan and scene list. Clicking a scene's extent populates the scan choice. Integration note: global `src/api/client.ts::loadScenes` is also called by other consumers and has no cancellation or request identity; cross-component concurrent catalogue requests are still a potential race and should be fixed by the shared API owner.
3. GeoTIFF `Refresh sources` only refreshed status/catalogue; when the same import stayed selected, its detail/verified snapshot state could remain stale after on-disk changes. Explicit refresh now re-fetches selected detail and resets the visible verification state while checking.
4. Analyst selection or question changes invalidated an in-flight result but left `busy` set until an answer with matching generation returned (which it could no longer do). The changed selection now clears the loading state while retaining the generation fence against stale responses.
5. Scientific comparison accepted impossible numeric fractions, category counts and overlap geometry despite claiming measured pixels. The parser now checks integer source counts, geometry, pixel-category reconciliation and `valid_pair_fraction` against recorded counts. Regression inputs covering each mismatch must fail closed.
6. Mission initial loading coupled mission and investigation reads with `Promise.all`, hiding usable missions if the unrelated watchlist fetch failed. Independent settled results now expose saved missions even when watchlists fail; a reload action allows recovery. Failed watchlist reads clear stale watch entries. Reopening the same SAR image pair also clears a prior transient image-load failure so the preview can be reattempted.

## Boundaries and error-state review

- Local GeoTIFF is a server-inbox basename import, not a browser upload. `/api/sar/local/status`, `/api/sar/local/imports`, `/api/sar/local/import`, detail and same-origin image endpoints have explicit loading/errors. Import receipts are required to say `IMPORTED_NOT_ANALYZED`; the UI shows source integrity separately from snapshot integrity, and previews require a verified snapshot. No claim is made that import starts a scan, calibrates GRD, or creates vessel evidence.
- Comparison requires two different persisted scan IDs and surfaces `NOT_COMPARABLE` without fabricating a measurement. Imagery panels differentiate verified cached RTC from absent/corrupt images. Analyst uses only bounded case/intention requests and explicitly identifies deterministic offline operation; unavailable sensor evidence cannot provide sensor claims. Missions evaluate only explicit saved scan/watchlist rules with a manual action, and Views use persisted snapshots and restoration warnings.
- Backend service availability, imported file bytes, image decoding, actual source checksum changes, live mission persistence and real-browser click-through were not established by these frontend source/tests. Existing DarkFleet browser tabs were claimed by another worker and available only for read-only inspection; one DOM read returned an unpopulated `#root`, another an `about:blank` state. No new browser or interactive tab was opened.

## Verification

- Baseline focus: `npm test -- --run src/advanced src/analyst src/missions src/scenes src/views` — 6 files / 26 tests passed before repairs.
- Repair focus: same command — 7 files / 28 tests passed; new `ScanWorkflow` checks added.
- Full frontend: `npm test` — **64 test files, 851 passed, 0 failed**.
- `npm run build` — **PASS**, 104 modules transformed. Existing Vite warning: single JavaScript chunk above 500 kB. This is a packaging/performance concern, not a build failure.
- `npm run lint` (`tsc --noEmit`) — **BLOCKED by unrelated concurrent edits** to `src/dossier/tabs/GhostSemantics.tsx` (three `TS2339` errors at lines 185, 214, 216: `RejectedCandidate` has no `rejectionReason`). An earlier lint run on this worker's unchanged owned scope passed. The dossier file is outside this worker's authority and was left for its owner.
- `git diff --check` — **PASS**; Git emitted ordinary LF/CRLF normalization warnings.

Focused frontend tests cover contracts and static operator controls; they do not simulate every asynchronous React interaction. No actual SAR acquisition, detection, model run or external integration was performed by this frontend pass.
