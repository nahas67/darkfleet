# AIS operator browser acceptance — 2026-10-11

## Scope and verdict

**Executed: real installed Chrome 154.0.8037.98, Playwright pointer input,
temporary FastAPI, actual `AisArchive`/Parquet, actual Vite/React/Cesium.**
The observed archive-transport and principal operator actions **passed in a
controlled non-live fixture session**. Full operator acceptance is **PARTIAL**,
not production verified: direct Cesium observation-marker pointer picking was
NOT_RUN, a late rapid-navigation probe lost the AIS bar, and authoritative
provider-to-completed-REAL-scan integration was NOT_RUN. The final script now
requires a persistent bar and stable relevant source hashes for `PASS`; this
new, tightened assertion has **not** been rerun during the browser handoff.

The original run's JSON printed `status=PASS` because it only required no
uncaught JavaScript exception and checked input dispatches. This document
supersedes that overly broad label: **fixture interactions PASS; complete
requested browser matrix PARTIAL**.

## Isolation, provenance, and build identity

- Harness: `python build-tools/ais_operator_browser_e2e.py`. Python owns and
  terminates Chrome, FastAPI and Vite process trees, and uses unique unoccupied
  127.0.0.1 TCP ports plus a `TemporaryDirectory`; no writes to repository
  `data/` and no external fixture downloads. Non-loopback browser requests are
  blocked; the API also rejects external socket connections and DNS queries.
- Deterministic **fabricated TEST DATA**, never live AIS or a Sentinel-1 scene:
  100 MMSIs (`257600001`–`257600100`), 499 observation rows over
  `2026-10-10 12:00:00Z` to `12:20:00Z`, source label
  **`fixture-browser-nonlive`**, one deliberate vessel-reporting gap, explicit
  NULL SOG/COG for one contact and measured numeric zero on another.
  Generated parquet SHA-256:
  `dd5395abbb85353859449c882a350ce5782b9bdf84bcd0ced1c081e73b025e53`.
- The application rightly refuses saving synthetic observations as a
  `runtime_mode=REAL` scan. The harness writes a **temporary test-only scan
  window descriptor** marked `runtime_mode=FIXTURE_NONLIVE`, `synthetic=true`,
  `stage=FIXTURE_ONLY_NOT_A_SCAN`, ID `AIS-BROWSER-FIXTURE-NONLIVE`, to the
  scratch `scans/` directory. It does **not** pass through `RunStore.save`,
  represent a complete scan or invent a successful provider receipt. The
  browser test initializes only this descriptor's scan ID + AOI in the
  in-memory store, then calls the unmodified `loadScanAis()` which fetches all
  AIS content from actual `/api/scans/{id}/ais` and the temp Parquet archive.
  It does not inject AIS observations or model state directly.
- The scan stage remained `QUEUED`. This harness proves the archive/API/React/
  Cesium AIS read/draw path **with a controlled fixture**, not the normal
  operator create-scan→provider acquisition→validated REAL targets path.
- The two initial attempts were excluded: cold Vite dependency optimization
  exceeded a 20-second navigation wait; then concurrent edits of
  `build-tools/buildIdentity.ts` restarted Vite during a FRAME TRACK click.
  The completed run used isolated `configFile:false` Vite with the repository's
  actual React, Tailwind, Cesium and `/api` proxy plugins to avoid unrelated
  build-tool file watcher restarts. This is **dev-module execution**, not a
  signed production bundle. The browser had no `darkfleet-build-*` meta tags.
- Completed session Chrome 154.0.8037.98, temporary API **62602**, temporary
  Vite **62603**. Git HEAD at test start:
  `7fca8dfb2cf13595e39fc63b4fd51753e2d2aba6`; HEAD at end:
  `ad79e72c850da2b5d44bdceea44d438fe1ca611f`. Other workers committed
  during the run. All **12 explicitly hashed code files** in the completed
  run were byte-identical before/after, including AIS client, contacts,
  tactical, renderer, engine, camera, playback, store, archive, delivery, API
  routes and Vite config. Example SHA-256:

  | Source in completed browser run | SHA-256 |
  |---|---|
  | `src/api/client.ts` | `8d47bf4333147dd76e2cfbfeb37f564ff567ca0e28a9bc0ccd1b508084c35566` |
  | `src/globe/aisRenderer.ts` | `52dc9c01aa5ac75fe9322e10fa21e39bedffcbed2969d866ede542d644961aa3` |
  | `src/globe/engine.ts` | `3de7c3c82bb40af645ef656023dc5862f96bb2d5842bc50d93864a32b3bd2a3b` |
  | `src/globe/aisCamera.ts` | `8cace40fb33eb92ad4beb504e7cd017a7c4a4bb58ce3acd8a9f757ac72bf76d4` |
  | `src/temporal/AisPlaybackBar.tsx` | `dedd9516a8ed44a9a00e49b54bd04811c30bdadbb61dc7a10c82e78c149d241b` |
  | `src/state/store.ts` | `738adb18696b8e61d8ffae292bc8055331db8483a735f394c031bb799a783e6a` |

  **Limitation:** that first set of digests omitted
  `src/ais/displayState.ts`, `TemporalController.ts`, `LayerConsole.ts`,
  `DarkFleetCommandApp.tsx`, and `OperationRail.tsx` while other workers were
  editing the checkout. The harness now hashes these as well, but the expanded
  source check needs a further exclusive-window rerun before claiming a stable
  complete source/build identity. No production-build HEAD equivalence claimed.

## Executed operator actions and direct evidence

| Operator action | Real observable result | Status |
|---|---|---|
| Query isolated `/api/scans/{id}/ais` | 499 rows, 100 distinct MMSIs, all sources `fixture-browser-nonlive`, PARTIAL time coverage; standalone `/api/ais/coverage` count 499 | PASS (fixture) |
| Production frontend `loadScanAis(id)` through FastAPI | Store contained 100 contacts, 499 raw fixes; no mocked endpoint; stage still `QUEUED` | PASS (fixture) |
| Cesium renderer + AIS playback DOM | **100 CONTACTS · 499 FIX · 101 TRACK**, all 100 MMSI identities in `data-df-ais-drawn-mmsis`, 1 reporting gap | PASS (fixture) |
| Genuine pointer click `[data-df-contact-row="ais:257600001"]` | selected MMSI 257600001, name `NONLIVE TEST 001`, source `fixture-browser-nonlive`, 4 historical observations | PASS |
| Genuine pointer FRAME TRACK; FRAME CONTACT | Buttons accepted, AIS selected identity preserved, 1 Cesium canvas remained | PASS input/state; numeric camera extent not independently captured |
| Genuine pointer FOLLOW ON | `data-df-ais-follow=ON`, status `HOLD_FINAL` at last observed instant | PASS |
| Genuine pointer scrub near midpoint | Playhead moved from `12:20:00Z` to `12:09:19Z`, in intentional reporting gap; FOLLOW status `HOLD_GAP` | PASS |
| Genuine pointer PLAY and PAUSE | Mode changed `HISTORICAL_PLAYBACK`/playing true, then `FIXED_INSTANT`/playing false | PASS |
| Rapid pointer selection of MMSI 257600002 while FOLLOW | Selected vessel updated, source preserved, 5 observations, status `TRACKING` | PASS (single sequence, not randomized concurrency fuzz) |
| Pointer LATEST | Selected second vessel playhead moved to `12:16:00Z`; no wall-clock/live state | PASS |
| AIS_CONTACTS and AIS_TRACKS layer switches | For each actual enabled layer button: `aria-pressed` true→false→true; restored previous control state | PASS; GPU visibility changes not separately instrumented |
| Re-engage FOLLOW, mouse wheel on Cesium canvas | Following released to `OFF`, real wheel event rather than synthetic JS-dispatched event | PASS |
| Workspace navigation TACTICAL→LAYERS→INTELLIGENCE→SEARCH→INTELLIGENCE | One Cesium canvas still in DOM; **AIS playback bar unexpectedly absent** at last observation, and no pageerror captured | **UNRESOLVED** |
| Close Chrome page; navigate a fresh page in same browser context | Old page `is_closed=true`; new page initialized exactly 1 Cesium canvas; browser subsequently closed | PASS for page lifecycle only |
| Pointer pick a specific on-canvas AIS observation marker to set exact `observationAt` | The test projection helper returned no usable visible screen point after FRAME TRACK; raw `data-df-ais-selected-observation` stayed null | **NOT_RUN** |
| Teardown WebGL resources, GPU allocations and Cesium primitive lifetime | Only page-close + new viewer canvas observed; no GPU/primitive count or disposal instrumentation | **NOT_RUN** (worker-7 GPU scope) |
| Authentic provider→production REAL scan→AIS archive→full UI load | No credentials/acquisition; synthetic REAL scan intentionally prohibited | **NOT_RUN** |

All externally requested OSM (`tile.openstreetmap.org`) and Esri
(`server.arcgisonline.com`) imagery was blocked in browser; this does not imply
those declared providers are broken. Browser recorded **0 uncaught page errors**
through the completed test and preserved 1 Cesium canvas after mid-app route
navigation. No hardware acceleration claims belong to this run; the separate
worker-7 harness owns that measurement.

## Navigation anomaly and exact limits

The final rapid-navigation DOM snapshot had no `[data-df-ais-playback]` and
`data-df-ais-selected` despite the earlier valid archive and one retained
Cesium canvas. That is **not a verified frontend defect** yet: other workers
advanced Git HEAD during the test; the initial digest set did not include
every transitive AIS module; there is no captured store snapshot/error-boundary
state at that instant. Static review found no direct reset of `aisObservations`
on `OperationRail` navigation: buttons set only `workspace`; `ScanWorkflow`
changes scene-catalogue state, not AIS. The result therefore remains a
candidate state-loss/HMR race, not a production repair justification.

The harness now captures `navFinalProbe` (app, alert, active workspace, AIS bar
count), includes transitive source hashes, and labels a missing playback bar
**PARTIAL** instead of PASS. This tightened version is **NOT_RUN** after the
exclusive browser window was relinquished; rerun it once worker-2 and worker-7
have completed their assigned browser/GPU tests. If reproduced on a clean,
unchanged source revision, capture an immutable store snapshot and make a
dedicated AIS frontend regression before altering production components.

The DOM and pointer proofs above remain useful, independently observed
fixture acceptance; they are **not** evidence of an operational AIS receiver,
radio observations, live monitoring, successful SAR scan, production build or
full renderer-resource cleanup.

## Reproduction and handoff

Execute from `/darkfleet` with project dependencies installed:

```powershell
python build-tools/ais_operator_browser_e2e.py
python -m ruff check build-tools/ais_operator_browser_e2e.py
python -m py_compile build-tools/ais_operator_browser_e2e.py
```

Only one Chrome benchmark/process group should run at a time. The completed
worker-1 fixture browser slot was **released to prime for worker-2, then
worker-7**, before this report was written. No production code modifications,
no git push and no writes to existing operator `data/`.
