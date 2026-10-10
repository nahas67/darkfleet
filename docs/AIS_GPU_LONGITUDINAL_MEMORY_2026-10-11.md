# AIS WebGL2 longitudinal memory and lifecycle acceptance — 2026-10-11

## Scope and evidence rules

This acceptance lane augments `build-tools/ais_webgl_hardware_benchmark.py`; it does not change application renderer or production sources. It must run **exclusively** after prime releases hardware Chrome and while worker-1/worker-4 CPU, browser, and compilation work is stopped. Hardware: require existing DarkFleet Vite application, actual mounted Cesium scene/canvas, WebGL2 **AMD Radeon / D3D11**, fail on SwiftShader, visible page, zero allowed public network egress. All injected contacts and **five observations per MMSI are deterministic SYNTHETIC test fixtures**; no sensor, genuine AIS feed, or live mission evidence is represented.

Existing first- and second-run raw JSON files remain untouched in machine-local `%TEMP%`:

* `darkfleet_ais_gpu_worker7_run4_20261011.json`, SHA-256 `47a7f798e997086f0af03569052d41aeac54454b5acc83e0888642bc2883bada`, 151,412 bytes, 100/1k/5k/10k active Cesium 36-frame per-stage measurements.
* `darkfleet_ais_gpu_worker7_post_cf6b3bc_20261011.json`, SHA-256 `ca4cad7cd3e08ad2185e5bbdbe2413df4e32129da9ce05b24797d48a2886ce6f`, 151,256 bytes, same source/hardware repeated run.

**Critical historical qualification:** Both prior runs used the *same already-optimized* `src/ais/displayState.ts` source SHA-256 `a6435ed7556d06c895ae4c5086f83407dd84400d480d47ea63107fda0a462795` despite different Git HEADs. They were **not** an original-vs-optimized GPU A/B test. One run accumulated +13,558,149 JS heap bytes after explicit GC through four increasing-density stages, the other +19,331,451 bytes. Four stages of increasing density in one page do not establish per-density retained-object growth or a resource leak. Details: `docs/AIS_WEBGL_HARDWARE_ACCEPTANCE_2026-10-11.md`.

## Bounded extended test design

Run from repo root **only after explicit exclusive Chrome slot approval**:

```powershell
$evidence=Join-Path $env:TEMP 'darkfleet_ais_gpu_longitudinal_20261011.json'
$stderr=Join-Path $env:TEMP 'darkfleet_ais_gpu_longitudinal_20261011.stderr'
python -B build-tools/ais_webgl_hardware_benchmark.py --self-test
python -B build-tools/ais_webgl_hardware_benchmark.py --run --longitudinal --cycles-per-size 3,3,3,8 --frames 36 --timeout 90 --url http://localhost:5174/ 1> $evidence 2> $stderr
# Record actual exit code, SHA-256 of full JSON and stderr, source identity and GPU adapter.
```

* One isolated installed Chrome instance/context/tab, one actual mounted Vite/React/Cesium engine, never a second Viewer. Existing harness supplies one **36-active-`scene.postRender`** benchmark at each of 100, 1,000, 5,000, 10,000 contacts, including selection/render and playback timing.
* Same browser then performs **17 additional whole AIS renderer load/actual Cesium render/clear/actual render/destroy/actual render** cycles: **3 × 100**, **3 × 1,000**, **3 × 5,000**, **8 × 10,000**. Each cycle asserts loaded billboards = requested count and exactly five AIS collection parents, zero billboards on clear and zero parent primitives after destroy; WebGL context must remain valid.
* The *same fixture object arrays* (including their five observations each) are **reused within a density** to avoid measuring newly generated input array garbage as a per-cycle leak. After each density, references to that fixture are released and GC sampled again. Fresh density allocations across 100→10k are not directly comparable to repeated equal-size steady-state cycles.
* After every empty cycle, call Chrome DevTools `HeapProfiler.collectGarbage` (if available), allow 175 ms for settling, call `window.gc` twice when exposed and record `performance.memory.usedJSHeapSize`, heap limit, `document.querySelectorAll('*')`, attached canvases/widgets, scene primitives/entities, GL context-loss flag, CDP `Memory.getDOMCounters` and **cumulative observed** WebGL create/delete/net counts by object type. CDP/JS garbage-collection hooks are best effort, not a guarantee of quiescent browser/native cache state.
* GL wrappers instrument only calls made **after** installation and possibly miss cached method references or native driver allocators. Their net counts **do not measure GPU VRAM**. Stable net after teardown is a narrow check, not leak freedom. Heap trends are neither proof of a production leak nor disproof of one without repeatability and attribution. DOM counts likewise do not count all detached, native or remotely held references.
* A **210-second entry budget** for the longitudinal loop plus **15-second per Cesium render transition** timeout avoids indefinite contention. A cycle that has already started can finish after the 210-second threshold (at most three render waits); do not mislabel this as a hard kill of the underlying process. Only one timed pass; on any failure retain partial samples and explicitly report `UNVERIFIED`, not guessed completions.
* Vite `?raw` SHA-256 content is matched to disk before and after the browser run for six renderer/app/fixture modules; Git HEAD/dirty bits recorded twice, including HMR module identity. No production `dist`/release manifest verification is inferred from dirty dev builds. External HTTP fetches and WebSocket routes are intercepted and blocked except localhost/127.0.0.1/::1, and ServiceWorkers are disabled; count/record attempts, never send fixture data. Internal Chromium background traffic cannot be inferred solely from Playwright interception; no machine-wide packet capture is claimed.

## Actual run and scientific disposition

### Interrupted first attempt — PROVISIONAL; not a longitudinal result

Prime granted the exclusive Chrome slot after worker-1 released it. The harness passed all **13/13 static checks** (including Node syntax of generated JavaScript), Python AST parsing and source-file diff checks. At the first probe, `5174` appeared closed; before test execution an existing app process (PID `18764`) had reopened it. An attempted **owned** Vite dev-server process (PID `23068`) exited with `Port 5174 is already in use`; the existing server answered HTTP 200 and was used instead. Worker-7 did not terminate or modify the existing Vite PID.

The following *first attempt* ran in a single disposable installed Chrome on the actual connected Cesium canvas; Chrome was closed on exit and the slot explicitly released to prime:

```powershell
$ev=Join-Path $env:TEMP 'darkfleet_ais_gpu_longitudinal_20261011.json'
$err=Join-Path $env:TEMP 'darkfleet_ais_gpu_longitudinal_20261011.stderr'
python -B build-tools/ais_webgl_hardware_benchmark.py --run --longitudinal --cycles-per-size 3,3,3,8 --frames 36 --timeout 90 --url http://localhost:5174/ 1> $ev 2> $err
# Actual exit 1, JSON status UNVERIFIED, NOT a completed memory/leak test.
```

Raw JSON 135,090 bytes, SHA-256 **`ad140fcad2741be90ba2262bd3e6a8dfe905229237903310fb35b2844ce1b5ac`**, UTC `2026-10-10T23:31:35.874049+00:00`; **preserve this raw failed-run evidence unchanged**. Git HEAD changed **during** the timed run from `03be3a41a7bc64e812d70428c9523a05068b9e58` to `50ad48a50d522df7b79504844f069040c0766c22` as unrelated worker commits landed. All six watched renderer/app source SHA-256 values matched local source both before/after and Vite `?raw` bytes before/after, including AIS renderer `52dc9c01aa5ac75fe9322e10fa21e39bedffcbed2969d866ede542d644961aa3` and optimized `displayState.ts` `a6435ed7556d06c895ae4c5086f83407dd84400d480d47ea63107fda0a462795`. Despite stable watched file bytes, the live page's **execution context was destroyed, most likely by Vite HMR/navigation**, during the **10,000-contact** frame stage. Exact logged errors: `10000: Error: Page.evaluate: Execution context was destroyed, most likely because of a navigation.` and `SOURCE_CHANGED_DURING_HARDWARE_TEST`. The partial frame output is *provisional only*:

| Synthetic density | Active postRender frames | p50 / p95 ms | Empty heap post-GC (bytes) |
| ---: | ---: | ---: | ---: |
| 100 | 36 | 15.0 / 36.7 | 108,186,805 |
| 1,000 | 36 | 34.1 / 61.3 | 110,797,760 |
| 5,000 | 36 | 94.7 / 154.7 | 116,762,109 |
| 10,000 | **not completed** | **UNVERIFIED** | **UNVERIFIED** |

**Longitudinal cycles completed: 0 / 17**, because the 36-frame all-density baseline must complete first. Therefore **NO longitudinal slope, leak, retained DOM or GL cycle verdict** can be inferred. The actual WebGL2 renderer was AMD Radeon / ANGLE Direct3D11. Playwright blocked **10** external HTTP attempts to `tile.openstreetmap.org` and `server.arcgisonline.com`, with **0 external WebSocket routes**, while local HTTP was allowed; no actual external request delivery was observed by interception. CDP initial DOM counters were 3 documents, 291 nodes, 252 JS event listeners, but there is no matched completed final DOM count.

### Pending uncontended source-stable rerun

**PENDING prime's new explicit exclusive GPU Chrome release with workers' commits, Vite reloads and builds paused.** The first attempt is preserved as a failure and cannot be relabeled measured. The next run must write a **new, non-overwriting** TEMP evidence file, verify HEAD/source SHA stability and the same AMD adapter, and only then examine cycle GC/GL/DOM trends, particularly the eight repeated 10k cycles. If any resource leak is actually confirmed, report exact source-stable per-cycle evidence to worker-4 through prime and await a fix before retesting. No firmware VRAM, leak-free assertion or production release identity is established by the interrupted run.
