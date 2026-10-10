# DF-X9.8 H7/H8 — AIS renderer takeover and evidence boundary

Date: **2026-10-10**. Scope: review the preserved, previously uncommitted
`src/globe/aisRenderer.ts`, `src/globe/glyphGeometry.ts`, and the previously
untracked `tools/ais-gpu/` harness; add local verification. Performance fixture
contacts are generated solely for controlled testing and **are not genuine AIS
observations**. No actual satellite or maritime observation has been generated.

## Verdict by claim

| Requirement | Current evidence | Verdict |
| --- | --- | --- |
| H7 500/1K/2.5K/5K/10K hardware WebGL frame intervals (p50/p95), FPS, GPU identification | Browser instrumentation written and Vite local HTTP serves the page, but browser attach failed | **UNVERIFIED** |
| H7 GPU scene picking and selection latency at 10K | Harness provides observed match counts, timing and explicit failure; no GPU browser run | **UNVERIFIED** |
| H7 10K label selection determinism and 120-budget | Existing tests and new differential reference test (10K dense and dispersed) | **VERIFIED CPU-SIDE** |
| H8 25-cycle Cesium primitive-collection ownership | New tests instantiate *actual Cesium collection classes* without WebGL; 25 renderer create/destroy cycles return to base count | **VERIFIED LOCAL RESOURCE OWNERSHIP** |
| H8 browser heap trend, VRAM, WebGL context loss, timer/listener trend, application play/seek/FOLLOW/clear | No accessible hardware browser run | **UNVERIFIED** |
| H8 25-cycle basemap failover, automatic cooldown recovery, offline survival | Browser harness can exercise forced failures and **manual** primary reselection only | **UNVERIFIED** |

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

## Browser access blocker

The existing tab at
`http://127.0.0.1:5173/tools/ais-gpu/index.html` appeared in the connected
tab inventory as **unloaded**. Its DOM inspection reported a companion
extension host-permission error. Attaching to that **same existing tab**
failed with **`BROWSER_CDP_TIMEOUT: Page.enable did not acknowledge`**, matching
two prior attempts reported by the prime agent. No browser GPU benchmark JSON,
vendor, real frame p50/p95, browser picking latency or heap trend was recovered.
No CPU result has been substituted for that absent hardware result.

## Procedure for completing the remaining hardware gate

Open the already-served local diagnostic page in a hardware-accelerated Chrome
tab and keep the tab in the foreground during measurement. Use **Run staged
H7/H8 harness**, followed by **Download captured JSON**. Examine
`gpu.unmaskedRenderer`, `gpu.renderer`, `sizes[*].frames.scenePostRenderEvents`,
scene/RAF interval percentiles, 10K selected MMSI `picking.pickVerified`,
`resources.collectionsStable`, and the 25 basemap records. A software renderer
or absent identity must be identified as such; an absence of `postRender` events
invalidates apparent FPS. Check the browser's GPU diagnostics independently.

For H8 operational closure, separately verify full application temporal
load/play/seek/FOLLOW/release/clear, event/timer listener count, actual
basemap-source outage and cooldown-based recovery, offline behavior, GPU memory
and long-run heap after GC or a controlled memory timeline. The diagnostic's
basemap function only forces failure reports and manually reselects the
primary; it **does not** establish `maybeRecover()` cooldown behavior. These
requirements remain open pending direct browser evidence.
