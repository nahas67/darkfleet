# AIS WebGL hardware acceptance — 2026-10-11

## Scope, existing implementation and evidence boundaries

This is the independent **worker-7 hardware/scene benchmark** for DarkFleet's retained AIS renderer, NOT the existing CPU-only performance tests. The production app uses the singleton `engine` from `src/globe/engine.ts`; its `setAisContacts` path builds a `displayStateOf` for each AIS record and calls `AisContactRenderer.render`, which writes to retained Cesium `BillboardCollection`, `LabelCollection` and `PolylineCollection` objects. `src/tactical/TacticalWorld.tsx` normally supplies the live store projection and playback clock to this singleton. There is also an **older stand-alone** `tools/ais-gpu/{main.ts,run_hardware_benchmark.py}` that instantiates `AisContactRenderer`/`initializeCesiumViewer` on its **own** test canvas; those measurements **cannot alone certify** the fully integrated TacticalWorld app. `src/globe/aisRenderer.perf.test.ts` tests 100/1,000/5,000/10,000 **CPU-side only** and explicitly disclaims GPU FPS.

The new `build-tools/ais_webgl_hardware_benchmark.py` opens a **single disposable, separate-profile, headless installed Chrome** against the ALREADY-RUNNING local DarkFleet Vite application (default `http://localhost:5174/`). It dynamically imports the **same `engine` singleton module used by the app**, requires `engine.viewer.scene.canvas` to be the connected DOM Cesium canvas, rejects WebGL1 and non-hardware / SwiftShader / unknown unmasked drivers, and never constructs a second Cesium viewer or application. No persistent AIS archive, saved records, provider calls or backend writes are used. External network destinations are explicitly blocked in the browser context. It does not modify application source or existing operator records; benchmark state lives inside the disposable page only.

The benchmark **uses SYNTHETIC fixtures, not historical AIS and not a live AIS feed**. It reproduces `makeVessels` in the checked-in `src/globe/aisRenderer.perf.test.ts`: 9-digit MMSIs starting at 257000000, geographic extent latitude 1–21°/longitude 103–143°, five observations per vessel at a four-minute cadence, three kinematics categories including anchored/no heading and moving/course-blind, deterministic seedless coordinates and reference times at minutes 8 and 10. Each density uses the SAME geographic area. It supplies actual `engine.setAisObservationSeries` and `engine.setAisContacts` calls. One real observed 5-fix track is selected for the playback exercise; **it does NOT create 10,000 displayed track polylines**. This intentionally isolates contact density from a simultaneous full-archive track-density workload.

## Measurements and limitations

| Signal | Implementation | Claim limit |
| --- | --- | --- |
| GPU / WebGL hardware | Unmasked `WEBGL_debug_renderer_info` vendor/renderer plus WebGL2 on actual Cesium canvas. Software renderers and unknown/non-hardware IDs fail. Check for context loss after each stage and record supported GL limits (texture/renderbuffer sizes, texture units, multisamples) | Renderer **reported** by Chrome/ANGLE, not an independent physical GPU probe |
| Active frame intervals | A registered Cesium `scene.postRender` listener samples `performance.now()` **between real Cesium postRender callbacks**; updates AIS reference time 8↔10 minutes after every actual scene render; `requestRender()` / continuous scene mode ensures active frames | Includes browser JS/CPU + Cesium rendering and GPU-submit queue; **NOT true GPU time** or GPU timer-query elapsed |
| AIS load/update cost | Monotonic JS wall-clock around engine calls, first load and per-frame playback updates; p50/p95/max separately | CPU-side renderer + Cesium update invocation, not separately measured GPU execution |
| Contact count | Renderer statistics after insertion, 100 / 1,000 / 5,000 / 10,000 | Not a claim about 10,000 uniquely visible onscreen pixels |
| Selection | `setAisSelection` + `setAisContacts` elapsed to next **Cesium postRender**; observed `scene.pick` at actual projected canvas pixels if a tag is visible | **Not** an end-to-end human pointer→React store selection click; worker-1 owns that live operator path |
| Playback | 8↔10-minute explicit observed AIS time, repeated real `setAisContacts`, 5-fix observation series and one displayed selected track | Synthetic playback, not a genuine externally sourced archive |
| Lifecycle | Each density is loaded, cleared and AIS renderer destroyed; compare Cesium parent `scene.primitives` length before/after, plus AIS billboards and labels | Cesium/JS ownership counts, **not direct driver VRAM use** |
| WebGL resource operations | Lightweight wrappers count calls to the **actual Cesium WebGL2 context** `create/delete Buffer, Texture, Framebuffer, Renderbuffer, VertexArray, Program, Shader` after instrumentation, with net created-minus-freed | Counts **only objects observed from installation onward**, not pre-existing allocations; APIs may be unsupported or calls cached/bypassed; instrumentation adds overhead and is not a complete GL inventory |
| JS heap | Browser `performance.memory.usedJSHeapSize`, Chrome DevTools `Performance.getMetrics` / `Memory.getDOMCounters` where available, and an optional `window.gc` sample **after each case returns** so fixture arrays can become collectible | Heap after GC only if Chrome exposes `window.gc`; browser-dependent; no guaranteed VRAM correlation |
| GPU resources and VRAM | If available, Chrome `SystemInfo.getInfo` gives adapter details; WebGL limit / extension support recorded | **GPU VRAM used, actual driver buffer/texture allocations and GPU command time are not externally accessible in this instrument without intrusive instrumentation. Report UNAVAILABLE, not zero.** |

The harness requires an already-running local UI, installed Playwright, and an accessible hardware WebGL2 Chrome. It does **not** install packages or open an existing Chrome profile. Always coordinate an exclusive timed interval with workers measuring AIS CPU/browser interaction to avoid load-contaminated numbers.

## Commands

```powershell
# Safe inspection mode: source SHA-256 + Git HEAD; NO browser launched.
python -B build-tools/ais_webgl_hardware_benchmark.py

# Only after the prime releases the worker-4 / worker-1 / worker-2 timing windows:
python -B build-tools/ais_webgl_hardware_benchmark.py --run --url http://localhost:5174/ --frames 36 --timeout 90
```

The command returns JSON on stdout and exits nonzero if any density fails or the driver is software/unknown, the Cesium viewer/canvas is missing, the selected counts do not match, or the source changes mid-run. `MEASURED` means this particular **synthetic app-engine hardware test** completed. It is not a full-system 10k AIS acceptance verdict, nor is it valid if concurrent browser/CPU workers were timing at the same time.

## Run evidence and disposition

**PENDING exclusive measurement window.** At script authoring, the prime reported worker-4 CPU sampling was reserved, then browser worker-1, then worker-2. The benchmark's no-browser inspection command completed and showed checked-in source digests at commit `5ddc0c5eed0443ce3d1027b3ddce41aa22f110af`. No frame latency, GPU driver, per-size Cesium scene FPS, browser heap trend, or resource leak result is claimed until the timed real-Chrome run completes and its output is reviewed. Neither the prior worker-7 idle `requestAnimationFrame` measurement nor the existing CPU Vitest benchmark qualifies as hardware postRender evidence.

**Final acceptance remains dependent on independent genuine AIS observation/picking/playback paths and repeatable uncontended hardware measurements.** A fast/slow p50 or p95 in a synthetic fixture must never be interpreted as an independently sourced real AIS performance SLA.
