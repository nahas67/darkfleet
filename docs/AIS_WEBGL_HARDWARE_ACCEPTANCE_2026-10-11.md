# AIS WebGL hardware acceptance — 2026-10-11

## Scope, existing implementation and evidence boundaries

This is the independent **worker-7 hardware/scene benchmark** for DarkFleet's retained AIS renderer, NOT the existing CPU-only performance tests. The production app uses the singleton `engine` from `src/globe/engine.ts`; its `setAisContacts` path builds a `displayStateOf` for each AIS record and calls `AisContactRenderer.render`, which writes to retained Cesium `BillboardCollection`, `LabelCollection` and `PolylineCollection` objects. `src/tactical/TacticalWorld.tsx` normally supplies the live store projection and playback clock to this singleton. There is also an **older stand-alone** `tools/ais-gpu/{main.ts,run_hardware_benchmark.py}` that instantiates `AisContactRenderer`/`initializeCesiumViewer` on its **own** test canvas; those measurements **cannot alone certify** the fully integrated TacticalWorld app. `src/globe/aisRenderer.perf.test.ts` tests 100/1,000/5,000/10,000 **CPU-side only** and explicitly disclaims GPU FPS.

The new `build-tools/ais_webgl_hardware_benchmark.py` opens a **single disposable, separate-profile, headless installed Chrome** against the ALREADY-RUNNING local DarkFleet Vite application (default `http://localhost:5174/`). It dynamically imports the **same `engine` singleton module used by the app**, requires `engine.viewer.scene.canvas` to be the connected DOM Cesium canvas, rejects WebGL1 and non-hardware / SwiftShader / unknown unmasked drivers, and never constructs a second Cesium viewer or application. It also imports Vite's *raw* engine, renderer, AIS display, store, TacticalWorld and original fixture source text inside the same page, computes SHA-256 for the served source bytes, and requires equality to the local checked-in/dirty source both before and after the run. This is **development-server provenance**, not production-build provenance; Git HEAD alone is not enough for an uncommitted, hot-reloaded Vite app. No persistent AIS archive, saved records, provider calls or backend writes are used. External network destinations are explicitly blocked in the browser context. It does not modify application source or existing operator records; benchmark state lives inside the disposable page only.

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

## Actual exclusive GPU run — 2026-10-11 (UTC date 2026-10-10)

**Result: `MEASURED`; all 4 density workloads completed, no benchmark assertion failures, exit 0.** Prime explicitly released exclusive timed Chrome ownership after worker-2; the run used its own single disposable, headless installed Chrome, closed in `finally`. **This proves hardware-backed synthetic workload measurements, not production release acceptance or a real AIS sensor/feed.** The repository was dirty by design during the measurements.

**Executable command and machine output:**

```powershell
$ev=Join-Path $env:TEMP 'darkfleet_ais_gpu_worker7_run4_20261011.json'
python -B build-tools/ais_webgl_hardware_benchmark.py --run --url http://localhost:5174/ --frames 36 --timeout 90 1> $ev
# Actual process exit code: 0
```

Raw JSON evidence: `C:\Users\nahas\AppData\Local\Temp\darkfleet_ais_gpu_worker7_run4_20261011.json` (151,412 bytes), SHA-256 `47a7f798e997086f0af03569052d41aeac54454b5acc83e0888642bc2883bada`. The output captures all `Performance.getMetrics`, `Memory.getDOMCounters`, reported GPU device details, per-stage primitives/GL operations/heap, and source digests, **not just the summaries below**. File is in machine-local TEMP, not in `data/` or checked-in source; to preserve it independently, copy into an approved evidence archive before temporary-file cleanup. All four stages report `complete=true` and 36 actual Cesium `scene.postRender` intervals. No `pageerror` exception appeared; ten browser console `net::ERR_FAILED` messages appeared due to intentionally blocked external basemap/network requests (these are **not** an available tile-failover test).

**Exact environment:** Chrome exposed real canvas 998 × 790 pixels, connected to the actual UI `.cesium-widget canvas`, `document.visibilityState=visible`, WebGL 2.0 / ANGLE **AMD Radeon(TM) Graphics (0x00001638), Direct3D11** driver `31.0.21914.8004` on Chrome CDP. GPU system info additionally listed an NVIDIA GeForce RTX 3050 Laptop GPU, **not** the selected WebGL context's device: this test executed on reported **AMD**, not NVIDIA. `gpu_compositing=enabled`, `webgl=enabled`, `webgpu=enabled`; EXT_disjoint_timer_query_webgl2 extension reported present but was NOT timed, so no GPU-only elapsed-time claim. Max texture/renderbuffer dimension 16,384, max multisamples 8; GPU VRAM used **UNAVAILABLE**.

**Reproducible app/dev source identity:** Git HEAD before/after `19f7f49cb7d8b05c2ca278f4a3994426e4bbee46`; `dirty=true` both sides. The harness discovered and imported the **actual** app-loaded Vite HMR engine URL `http://localhost:5174/src/globe/engine.ts?t=1791672825656`, avoiding accidental instantiation of a second empty singleton via bare module URL. Raw Vite source SHA-256 and disk SHA-256 matched both before and after for all six reviewed files:

| Source | SHA-256 |
| --- | --- |
| `src/globe/engine.ts` | `3de7c3c82bb40af645ef656023dc5862f96bb2d5842bc50d93864a32b3` |
| `src/globe/aisRenderer.ts` | `52dc9c01aa5ac75fe9322e10fa21e39bedffcbed2969d866ede542d644961aa3` |
| `src/globe/aisRenderer.perf.test.ts` | `f82abdbb44bf5a2cb0f003d82d121159417d8463d40ca01c9d6bd4952eb67744` |
| `src/ais/displayState.ts` | `a6435ed7556d06c895ae4c5086f83407dd84400d480d47ea63107fda0a462795` |
| `src/state/store.ts` | `738adb18696b8e61d8ffae292bc8055331db8483a735f394c031bb799a783e6a` |
| `src/tactical/TacticalWorld.tsx` | `c3a6fe2d87681f6e4d664e2ba5c3d540b213c246a89163f7780888c347d5ad2b` |

**Actual canvas scene intervals**, not idle `requestAnimationFrame` and not raw GPU timer:

| Synthetic AIS count (5 fixes each) | `postRender` intervals | p50 ms | p95 ms | worst ms | initial load ms | playback update p50/p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 36 | **14.5** | **25.2** | 254.9 | 16.3 | 2.2 / 3.8 |
| 1,000 | 36 | **20.8** | **38.0** | 41.0 | 18.7 | 12.2 / 21.5 |
| 5,000 | 36 | **64.1** | **96.3** | 110.6 | 66.0 | 52.5 / 77.4 |
| 10,000 | 36 | **93.3** | **145.7** | 147.1 | 135.3 | 80.7 / 119.0 |

The 100-contact worst outlier was 254.9 ms despite p95 25.2 ms; do not hide outliers. At 10k, the median **frame interval** exceeds 90 ms, so the system is **NOT ACCEPTED as smooth 60 FPS or 30 FPS at 10k**. No corresponding product SLA was invented. Frame intervals are browser scheduling + full app engine updates + Cesium scene rendering; they are not GPU-execution duration or a reproducible real-AIS live service level.

**Selection and canvas picking** (8 real `scene.pick` probes at an observed visible canvas pixel, no synthetic DOM click):

| Count | Renderer select → next `postRender`, ms | `scene.pick` p50 / p95 ms | Verified pick count | Selected pick label |
| ---: | ---: | ---: | ---: | --- |
| 100 | 36.9 | 1.4 / 15.5 | 8/8 | `257000038` (center candidate occluded) |
| 1,000 | 37.2 | 3.4 / 16.1 | 8/8 | `257000500` |
| 5,000 | 83.9 | 3.8 / 26.0 | 8/8 | `257002466` (center candidate occluded) |
| 10,000 | 112.2 | 4.1 / 17.2 | 8/8 | `257004966` (center candidate occluded) |

At each size `engine.setAisSelection` + `setAisContacts` selected the midpoint fixture MMSI and measured time to actual Cesium frame. Pixel picking correctly chose the visible topmost AIS tag, which is **not always the midpoint fixture MMSI**. `scene.pick` success does **not** prove a real physical pointer-triggered React/store workflow; worker-1 has separate ownership of that acceptance lane.

**Clear/destroy and measured JS heap:**

| Density | `scene.primitives` loaded → empty | Billboards loaded → cleared | Clear / destroy ms | Empty-scene JS heap after explicit GC |
| ---: | --- | --- | ---: | ---: |
| Initial baseline | 0 | 0 | — | 107,591,341 bytes |
| 100 | 5 → 0 | 100 → 0 | 0.5 / 0.5 | 107,563,937 bytes |
| 1,000 | 5 → 0 | 1,000 → 0 | 1.4 / 0.9 | 110,090,586 bytes |
| 5,000 | 5 → 0 | 5,000 → 0 | 2.8 / 0.7 | 116,823,278 bytes |
| 10,000 | 5 → 0 | 10,000 → 0 | 4.7 / 0.8 | 121,149,490 bytes |

No WebGL context loss and no Cesium AIS parent-primitive accumulation were observed through four load/clear/destroy phases. The **explicit-GC empty-scene JS heap rose by 13,558,149 bytes** between initial and the final 10k stage; thus heap stability/leak-free operation is **NOT PROVEN**, despite the five Cesium parent primitives and billboard counts returning to zero. The largest final heap of 121.15 MB was after GC with `window.gc` available, versus 170.24 MB immediately after destroy without GC. Continuous owner/React caches and JS profiling overhead may explain part of the growth; this single pass does not isolate those causes. Additional repeated 10k cycles across longer sessions would be required for a leak verdict.

**Observed WebGL allocations (cumulative since instrumentation)** after each density returns to empty: the outstanding *observed* buffers remained at **21**, textures at **3**, vertex arrays at **19**, framebuffers at **2**, renderbuffers at **1** at every empty endpoint; shader net **0**, programs net **10–12**. These GL counters only cover calls intercepted AFTER the baseline and do not represent all live allocations in Cesium or GPU VRAM. Stable observed counts across 100–10k stages are a positive narrow resource finding, **not a zero-GPU-leak proof**.

### Initial harness corrections, with failed attempts retained

The first actual installed-Chrome run (`EXIT 1`) established that the bare Vite dynamic import `/src/globe/engine.ts` yielded a **different null-viewer singleton**, although the mounted UI Cesium canvas existed. A diagnostic retry (`EXIT 1`) confirmed visible application HUD, one Cesium canvas and engine `initialised=false`. Rebinding dynamically to the app's resource URL first imported Vite's `?raw` module by mistake (third run `EXIT 1`; `engine` undefined). The final correction rejects Vite raw-query URLs and imports the **exact resource URL of the already-loaded app engine** including its `?t=` HMR timestamp. This is a harness identity fix; **no production engine/UI files changed**. Final run (`EXIT 0`) completed all four densities with Vite/disk hash parity. Failed attempts are NOT GPU measurements; they are recorded here rather than silently discarded.

## Acceptance disposition

**PASS narrowly:** actual selected AMD WebGL2 hardware + actual live app Cesium canvas, deterministic synthetic 100/1k/5k/10k contacts, all 36 active scene-render interval samples per density, exact Vite module/source hash parity, real `scene.pick` selected visible tags, billboards/primitives clearing to zero after teardown, no context loss, zero measured assertion failures. **NOT PASS / NOT ESTABLISHED:** acceptable smooth 10k framerate, GPU-only frame duration, GPU VRAM usage, long-run heap leak-free behavior, actual user pointer→store behavior, source-backed real AIS playback/identity, or strict clean production-build identity. These are separate acceptance criteria and must not be inferred from a successful synthetic benchmark runner exit.
