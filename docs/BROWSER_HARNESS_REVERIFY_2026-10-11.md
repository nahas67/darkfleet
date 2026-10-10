# DarkFleet browser and integration re-verification — 2026-10-11

## Scope, provenance, reproducibility

An independent read-only browser check ran against the **live Vite development server** at `http://localhost:5174/`, with its existing proxy to the live FastAPI backend at `http://127.0.0.1:8000`. Port 5173 hosts a different Vite application; requests for DarkFleet modules there return that other application's `text/html`, not a DarkFleet JS module. No service launches were needed. An existing Chrome tab at localhost:5174 was inspected first; after companion browser controls became unreliable, an isolated **headless** Chrome was used to conduct the actual end-to-end interactions without opening a visible window.

Evidence capture: `2026-10-10T21:08:03Z` (local date October 11), repository HEAD **`eadd8552854186a5ff60da417befd578aef1cd66`** before and after the successful browser run; **working tree dirty** because concurrent verification work was under way. Browser: Chrome/HeadlessChrome **154.0.8037.98** on Windows, 1440×900 viewport. The repeatable harness is `build-tools/browser_harness_reverify.py`:

```powershell
python build-tools/browser_harness_reverify.py
```

The harness requires the already-running local frontend/backend, installed Chrome and Python Playwright. It prints structured JSON and exits nonzero when an observable required smoke criterion fails. It uses a separate short-lived headless process, closes it at the end, blocks external browser requests, **does not submit forms or create/update/delete records**, and samples read-only HTTP sources. It does request the imagery pair display endpoint, which calculates a pair response without persisting records.

## Observed PASS — browser and API

| Surface | Observed outcome | Qualification |
| --- | --- | --- |
| Frontend response | HTTP 200; title `DarkFleet — Maritime SAR/AIS Intelligence`; React app and Cesium canvas mounted | Live Vite dev app, not committed production bundle |
| Operation rail | **11/11** workspaces clicked and asserted active with a visible workspace panel: Search, Intelligence, Tasking, Missions, Layers, Analytics, Advanced, Reports, Views, System, Tactical | Tests panel routing/mounting; does not certify hidden or unmet data workflows |
| Click-to-active timing | Approximate Playwright browser wall time **69–545 ms** across 11 clicks in the final run | Includes Playwright action/selector overhead; not a benchmark or UX service-level claim |
| Advanced → Local GeoTIFF | Panel and complete import form rendered; local service settled to `Server inbox configured`, inbox `local-sar-inbox`, max **64 MiB**, max **8,000,000** pixels | No operator import attempted; data mutation forbidden by this audit |
| Advanced → SAR imagery | Two options `DF-0001` and `DF-0002` loaded from API; `Display stored imagery` returned **READY**; two **223×221** actual PNG image elements finished decoding (`complete=true`, natural dimensions nonzero) | Backend claims persisted REAL / synthetic-false RTC, but upstream identity/calibration not independently authenticated |
| API `/health` | HTTP 200, `darkfleet-api`, version `3.0.0` | Root `/` returning 404 is expected |
| API `/api/maritime/datasets` | HTTP 200; coastline `usable=true` with **CHECKSUM_UNRECORDED**; most other datasets `NOT_INSTALLED` | No claim that unavailable context layers are present |
| API `/api/sar/imagery/scans` | HTTP 200, `total_real_scans=2` | Availability assertions are source-record claims |
| API cached imagery | `GET /api/sar/imagery/scans/DF-0001/image` → HTTP 200 `image/png` ~59 KB; DF-0002 → HTTP 200 `image/png` ~59 KB | Independently verified direct backend transport and browser rendering; files are source-cache derived |
| Browser JavaScript | Zero uncaught page errors and zero unblocked console errors in final run | Some GET requests are cancelled with `net::ERR_ABORTED` when quickly unmounting workspaces (expected navigation/cleanup; not an HTTP 5xx) |

The page rendered a real **WebGL2** context and one application canvas. Chrome identified an unmasked renderer:

```text
ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)
Google Inc. (AMD)
```

This establishes an identifiable hardware-backed WebGL2 context for this run, not stable frame rate, GPU VRAM, full-scene real basemap imagery, or lifecycle recovery. External network tiles were intentionally blocked. Historical synthetic AIS GPU benchmark results in `docs/DF_X9_8_H7_H8_EVIDENCE.md` are separate; this smoke test did **not** run 10K AIS contacts or reproduce those FPS metrics.

## HEAD and byte identity: dev source verified; bundled release stale

The browser's Vite development HTML **does not expose** `darkfleet-build-*` meta tags; these are emitted by the production-build-only Vite plugin. The harness therefore verifies the live dev sources through an alternative byte-level check:

- `GET /src/command/DarkFleetCommandApp.tsx` and `GET /src/intelligence/AdvancedWorkspace.tsx`: HTTP 200, `text/javascript`, expected component markers present.
- Both corresponding `?raw` Vite source responses, decoded as source text, match the local source files' full **SHA-256**. The two hashes at capture were `1a2ce280ac733e36bd072b108dfa8c7d60478c65d91f4727bc6f25240fa823b3` and `7041fa9488c21e916f16be94d18340a64438b79b79c0dd2ca6b2fc937d834ce5`.
- These and three further source hashes (imagery workspace, local import panel, globe engine) remained unchanged through the full browser run. Git HEAD also remained fixed during that run.
- Preexisting `dist/build-manifest.json` instead identifies **`c1fb4f0300eea45d645b3f600057d9fcf33e6b3f`**, `dirty=true`, with bundle digest **`bacf5a9d8be7826ee5a9ddb0f1f6d8d863340acacff3e5ea59d057818c634b9b`**, built `2026-10-10T19:56:10.123Z`. That bundle is stale relative to the tested HEAD and is **NOT VERIFIED** as current product output.

Even with raw-module hash equality, the dirty checkout does not justify the claim that all served bytes equal a clean Git commit. For a release gate, produce a clean-tree build and verify meta HEAD, clean flag and recomputed full bundle digest against that exact deployment. Do not reuse this old `dist/` manifest as proof of the current HEAD.

## Limitations and actionable follow-ups

1. **Current release bundle provenance remains unverified.** A clean revision build/deploy plus manifest and browser identity assertions are needed. The present Vite development run is intentionally reported as a working-tree observation.
2. **No live AIS archive** was configured in this environment, so AIS playback, track following, real live correlation, 10K active AIS performance, and persistence/restart/recovery were **NOT VERIFIED**. The UI displayed `NOT_CONFIGURED` and empty selection states.
3. **Operator import, persisted write workflows and cross-session recovery** were outside the audit's read-only permission; GeoTIFF ingestion was verified through panel/API wiring only, not an imported file or source-snapshot restart proof.
4. **Marine data completeness:** the coastline is reported usable but its checksum unrecorded, while EEZ/high seas/bathymetry/ports were not installed. Do not infer that these maritime layers are validated and visible.
5. **Companion Chrome control path is unreliable:** the original tab's first DOM snapshot displayed DarkFleet, but subsequent snapshots alternated to `about:blank` despite tab inventory showing localhost:5174. `browser_evaluate` returned an argument-mapping error (`expected string ... at function`), `browser_screenshot` returned `UNKNOWN_TOOL`, and navigation returned stale-page errors. The independently run Python Playwright smoke test succeeded and did not depend on those controls. These are browser connector/harness limitations, not demonstrated product failures.

No application-source changes, data writes, destructive commands, or external browser requests were made by this audit. All findings apply to the observed local runtime and stated revision, and should be reverified after integration of concurrent source changes.
