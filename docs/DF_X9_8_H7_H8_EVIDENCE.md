# DF-X9.8 H7/H8 — AIS renderer takeover and evidence boundary

Date: **2026-10-10**. Scope: review the preserved, previously uncommitted
`src/globe/aisRenderer.ts`, `src/globe/glyphGeometry.ts`, and the previously
untracked `tools/ais-gpu/` harness; add local verification. Performance fixture
contacts are generated solely for controlled testing and **are not genuine AIS
observations**. No actual satellite or maritime observation has been generated.

## Verdict by claim

| Requirement | Current evidence | Verdict |
| --- | --- | --- |
| H7 500/1K/2.5K/5K/10K hardware WebGL frame intervals (p50/p95), FPS, GPU identification | Isolated Chrome 154 with unmasked AMD Radeon D3D11 adapter; complete staged browser results recorded below | **MEASURED HARDWARE-BACKED SCENE INTERVALS** (not GPU timer queries) |
| H7 GPU scene picking and selection latency at 10K | Hardware browser selected visible topmost MMSI, then verified 10/10 matching pick tags | **MEASURED BROWSER PICKING** (specific scene and point) |
| H7 10K label selection determinism and 120-budget | Existing tests and new differential reference test (10K dense and dispersed) | **VERIFIED CPU-SIDE** |
| H8 25-cycle Cesium primitive-collection ownership | Real Cesium tests and now hardware-backed browser repeat cycles: 5 → 0 → 5, no count drift | **VERIFIED IN BROWSER AND TESTS** |
| H8 browser JS heap trend | 25-cycle **matched empty-collection** JS heap readings with explicit `window.gc`, documented below | **MEASURED JS HEAP ONLY**; no long-run leak-free assertion |
| H8 VRAM, WebGL context loss, event/timer listener trend, application play/seek/FOLLOW/clear | Not exercised by the isolated harness | **UNVERIFIED** |
| H8 25 forced basemap failover/manual reselections | Browser records one layer at each of 25 cycles | **MEASURED MANUAL FALLBACK**; automatic cooldown recovery/offline survival **UNVERIFIED** |

## What changed and why

The takeover preserved two prior edits after comparing them to `git diff`:

1. `AisContactRenderer.destroy()` removes each of its **five** retained Cesium
   child collections through its parent `scene.primitives`, leaving neither
   destroyed child entries nor accumulation through subsequent new renderers.
   If the parent already removed/destroyed a child, the fallback only destroys
   an undestroyed child. The renderer's contact maps are cleared.
2. `arbitrateLabels()` stops testing after the **first** generic-label collision.
   This preserves the original exhaustive algorithm's ordering, selected-label
   priority, suppression reasons and maximum overlap values (maximum overlap is
   populated for selected labels only). The new differential test compares the
   10K dense and dispersed outputs to a faithful pre-change exhaustive reference.

The harness originally reported `primitivesAfterClear = countAfterDestroy + 5`;
that number was inferred, not measured. It now records actual parent counts
after clearing, after destroying and after recreating. The 25-cycle result has
an explicit `collectionsStable` boolean. The harness now measures the count of
Cesium `postRender` events and wall-time between those events alongside ordinary
`requestAnimationFrame` intervals. These **are not GPU timer-query timings**.
An interval measured only from RAF must not be presented as Cesium FPS when no
scene frames render.

The staged `runAll()` order now tests picking on the dispersed 10K fixture,
then renders a dense 10K fixture. The pick report contains the sampled IDs,
`selectedContactPickCount`, `pickVerified`, and null timing if the selected
contact projects outside the viewport. No picked point is treated as the
selected MMSI unless its recorded primitive tag actually matches. This avoids
falsely crediting an overlapping neighbour's hit.

The page now has direct **Run staged H7/H8 harness**, **Run 10K contact stage**,
and **Download captured JSON** controls. It exports the browser's actual
WebGL identity fields, recorded results, timestamp, and an explicit
`UNVERIFIED_VITE_DEV_SOURCE` build-revision label. The current HTML/JS is a
diagnostic under `/tools/ais-gpu/`; serving it does not prove the browser ran.

## Local verification performed

The focused command was:

```text
npm test -- --run src/globe/aisH7H8Lifecycle.test.ts src/globe/aisRenderer.test.ts src/globe/glyphGeometry.test.ts src/globe/aisRenderer.perf.test.ts src/globe/tenThousandScale.test.ts src/globe/aisPick.test.ts src/globe/sourceSwitchMemory.test.ts
```

Result: **7 test files, 124 tests passed**. This includes **25/25** actual
Cesium collection-constructor/parent-removal cycles (without a GPU context),
double-destroy, parent-already-destroyed/removed, and parity against old label
arbitration on 10K dense/dispersed contacts. Existing pick decoder tests
exercise typed AIS primitive tags. The relevant CPU-only performance fixture
printed the following observations in this run:

| Contact count | Display CPU ms | Orientation CPU ms | Label CPU ms | Total CPU ms | Labels shown |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.23 | 2.00 | 11.12 | 16.35 | 17 |
| 1,000 | 21.69 | 5.13 | 6.43 | 33.25 | 120 |
| 5,000 | 90.63 | 6.07 | 11.38 | 108.08 | 120 |
| 10,000 | 156.05 | 7.23 | 3.56 | 166.83 | 120 |

These values are one **Node/Vitest CPU fixture run**, without real Cesium
WebGL rendering. They vary with scheduling and cannot establish frame rate,
picking performance, hardware acceleration, responsiveness or memory health.
The relative structural result of retained vs rebuilt state is covered in the
existing fixture tests; it is likewise not a GPU measurement.

`npm run lint` (TypeScript) and `npm run build` (Vite application) passed.
The app bundle reported the existing >500 kB chunk-size warning. Vite's root
application build does not execute the separate diagnostic HTML page.
`Invoke-WebRequest` to `http://127.0.0.1:5173/tools/ais-gpu/index.html`
returned **HTTP 200**, `text/html`, with title *DarkFleet AIS GPU Measurement
Harness*. This verifies HTTP serving only.

## Historical browser connector blocker (bypassed by isolated hardware Chrome)

The existing tab at
`http://127.0.0.1:5173/tools/ais-gpu/index.html` appeared in the connected
tab inventory as **unloaded**. Its DOM inspection reported a companion
extension host-permission error. Attaching to that **same existing tab**
failed with **`BROWSER_CDP_TIMEOUT: Page.enable did not acknowledge`**, matching
two prior attempts reported by the prime agent. No browser result could be
recovered *from that tab*. The later isolated Python Playwright/Chrome run
below **did succeed**; do not treat the historical attachment failure as the
current status of H7 browser verification.

## Procedure for independently repeating the browser measurement

Open the already-served local diagnostic page in a hardware-accelerated Chrome
tab and keep the tab in the foreground during measurement. Use **Run staged
H7/H8 harness**, followed by **Download captured JSON**. Examine
`gpu.unmaskedRenderer`, `gpu.renderer`, `sizes[*].frames.scenePostRenderEvents`,
scene/RAF interval percentiles, 10K selected MMSI `picking.pickVerified`,
`resources.collectionsStable`, and the 25 basemap records. A software renderer
or absent identity must be identified as such; an absence of `postRender` events
invalidates apparent FPS. Check the browser's GPU diagnostics independently.

Alternatively use the automated browser runner described below. It does not
claim an unidentified WebGL adapter is hardware.

For H8 operational closure, separately verify full application temporal
load/play/seek/FOLLOW/release/clear, event/timer listener count, actual
basemap-source outage and cooldown-based recovery, offline behavior, GPU memory
and long-run heap after GC or a controlled memory timeline. The diagnostic's
basemap function only forces failure reports and manually reselects the
primary; it **does not** establish `maybeRecover()` cooldown behavior. These
requirements remain open pending direct browser evidence.

## Hardware follow-up: isolated local Chrome, 2026-10-10

An installed **Python Playwright** package was available even though the
project did not contain Node `playwright`/`puppeteer`. The following command
launched an **isolated Chrome browser process**, executed the actual Vite-served
AIS renderer JavaScript, and wrote raw JSON evidence:

```powershell
python tools/ais-gpu/run_hardware_benchmark.py --output docs/DF_X9_8_H7_H8_CHROME_HARDWARE_EVIDENCE_2026-10-10.json --timeout-ms 30000
python -m unittest discover -s tools/ais-gpu -p 'test_run_hardware_benchmark.py'
```

**Raw machine-readable evidence:**
`docs/DF_X9_8_H7_H8_CHROME_HARDWARE_EVIDENCE_2026-10-10.json`.
It contains the browser version, adapter, full samples and pick identities,
heap/primitive series, timestamps, HTTP URL, Git HEAD and SHA-256 for the exact
local `aisRenderer.ts`, `glyphGeometry.ts`, and both harness source files.
The run uses only synthetic test contacts; external data requests are blocked
at the browser context boundary. The exposed Vite development server is NOT
a production build provenance claim; verify its hashes on reproduction.

### Browser and hardware provenance

- **Browser:** Chrome/HeadlessChrome **154.0.8037.98**, Windows 10/11
  (User-Agent identifies Windows NT 10.0), WebGL **2.0**.
- **Unmasked adapter:** `ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638)
  Direct3D11 vs_5_0 ps_5_0, D3D11)`; `Google Inc. (AMD)` unmasked vendor.
- **Maximum texture size:** 16,384; `--disable-software-rasterizer` was set.
  The runner refuses to benchmark unknown/masked/software adapters. This is
  actual browser-reported adapter identity, not a GPU timer query or an
  independently audited driver stack.
- **Result:** `MEASURED_BROWSER_GPU` in JSON, **zero `pageErrors`**.
- **Source Git HEAD at capture:** `4bece16043e7e0c832725013edbe27aa7101c401`
  (the JSON binds subsequent uncommitted harness edits by SHA-256).

### Stage measurements from the completed browser run

Every stage collected **91 actual Cesium `postRender` events** while the
renderer displayed the requested fixture size. These percentiles are **wall
intervals between Cesium render callbacks** (not GPU draw durations, nor pure
RAF callbacks). Derived FPS is `1000 / p50_ms`.

| AIS contacts | Cesium interval p50 | Cesium interval p95 | FPS from p50 | Labels shown | Parent primitives |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 24.7 ms | 28.8 ms | 40.49 | 89 | 5 |
| 1,000 | 24.8 ms | 31.8 ms | 40.32 | 96 | 5 |
| 2,500 | 26.1 ms | 28.5 ms | 38.31 | 114 | 5 |
| 5,000 | 28.3 ms | 32.8 ms | 35.34 | 116 | 5 |
| 10,000 | 32.5 ms | 37.1 ms | 30.77 | 120 | 5 |

A second *dense* 10K fixture measured 31.2 ms p50, 32.7 ms p95
(32.05 FPS-from-median). The hardware ran in headless Chrome, at a 1440×900
viewport, with network access to non-local providers blocked. These samples
cannot certify foreground interactive performance on other operating systems,
GPU drivers or production basemaps. The 30.77 FPS figure is an observation,
not a predeclared service-level pass threshold.

### Observed picking, including occlusion caveat

The first completed browser run revealed that arbitrary midpoint contact
`257005000` was occluded by the actually topmost glyph `257004898` at its
projected pixel: **10 of 10 picks returned `257004898`**, not the arbitrary
requested MMSI. That run therefore correctly reported `pickVerified=false`.
This is a real overlapping-glyph behavior, not an invented failure or proof
that clicking the visible contact is broken.

The hardened harness now reads the actual **topmost AIS tag at the clicked
visible pixel**, selects that tag's MMSI, and requires all 10 subsequent
`scene.pick` results to match it. In the final measured run:

- Requested arbitrary contact: `257005000`; visibly picked contact: `257004898`.
- Selected-contact update: **43.0 ms**, while 10K contacts remained loaded.
- 10/10 returned the selected contact's exact `AIS_CONTACT` MMSI tag.
- Pick call latency: **2.9 ms p50, 4.3 ms p95**; `pickVerified=true`.

This proves selection/picking at that **specific visible point** during the
hardware browser run, not correctness of all overlapping glyphs/positions.

### H8 resource and heap measurements

- **25 cycles** of renderer load→clear→destroy→recreate in actual browser
  Cesium: each cycle had **5 primitives after clear**, **0 after destroy**,
  **5 after recreate**. Final count **5**, `collectionsStable=true`.
- With `window.gc()` exposed and invoked at both **cleared renderer** endpoints,
  reported `performance.memory.usedJSHeapSize` fell from **121,669,344** bytes
  to **112,478,428** bytes (**−9,190,916** bytes). This is a single
  garbage-collected JavaScript heap comparison, not measured VRAM or a claim of
  leak-free long-duration sessions.
- `25` forced-failure basemap cycles reported **ESRI fallback**, manual OSM
  reselection and **one imagery layer** in each record; no actual tile success,
  autonomous cooldown recovery or provider uptime was established.

One intermediate Vite-run attempt lost its page execution context during the
2.5K→5K transition and returned **UNVERIFIED** with an explicit navigation
error. It was not treated as evidence. The subsequent complete run succeeded
with all requested stages, and the committed JSON is that successful run.

### Remaining qualification

H7 is now **observed on one locally identified hardware WebGL2 adapter** with
documented frame and pick measurements; this is not a promise of 60 FPS or an
endorsement of every configuration. H8 primitive counts and an initial
GC-controlled JS heap comparison are genuinely measured. **GPU VRAM, WebGL
context-loss recovery, full application playback/FOLLOW lifecycle, listener
and timer leak analysis, offline data survival, and automatic basemap cooldown
recovery remain UNVERIFIED.** None were replaced with CPU-only estimates.
