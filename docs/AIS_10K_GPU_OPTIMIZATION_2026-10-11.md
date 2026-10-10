# DarkFleet AIS 10K renderer optimization — October 11, 2026

## Source identity and scope

- Inspected baseline HEAD `b5bdc675480ad7cc6ff78b3c81fcb0534065bad7` (clean repository at assignment start; other workers subsequently modified unrelated paths). Existing browser hardware baseline source is the same retained `src/globe/aisRenderer.ts` that previous GPU acceptance instrumented, **not** an unverified release-build assumption.
- This lane owns only `src/globe/aisRenderer.ts`, narrowly scoped renderer tests/performance harness work and this report. `src/globe/aisPick.ts`, `src/ais/displayState.ts`, engine/tactical integration, worker-7's `build-tools/ais_webgl_hardware_benchmark.py`, actual user records and unrelated worker edits are **out of scope**.
- The active benchmark's 10,000 MMSIs / five **synthetic** fixes per vessel, actual installed AMD Radeon D3D11 WebGL2, 998×790 app Cesium canvas, 36 measured actual `scene.postRender` intervals and source-digest comparisons are described in `docs/AIS_WEBGL_HARDWARE_ACCEPTANCE_2026-10-11.md`. It is real Cesium, but the contacts are controlled benchmark inputs, not live AIS provider observations.

## Reconciled historical evidence — performance target currently FAILS

The two earlier hardware runs used the **same optimized display-state source bytes**. Their 10K active Cesium frame-interval p50/p95 were **93.3 / 145.7 ms** and **136.4 / 195.1 ms**. The difference is **same-source run-to-run variance**, not proof of a regression or an optimization. Neither run meets 30 or 60 frames per second. The frame interval contains event loop, CPU rendering and GPU command scheduling; no GPU timer query, GPU VRAM usage or true hardware-only frame-duration metric is available.

The earlier hardware check did maintain 10K billboard identities, returned all five AIS parent primitives to zero after destroy, and correctly decoded visible tagged picks; **neither zero memory leak nor acceptable 10K interactive frame rate was proved**. Its reported empty-scene post-GC heap rose ~13.56 MB and ~19.33 MB in separate runs. This observation alone cannot distinguish caches from leaks.

## Source-level hot-path investigation, before production modification

`AisContactRenderer.render` holds a Cesium `BillboardCollection` keyed by MMSI, so position and rotation changes update retained objects. However, the installed Cesium `Billboard.js` already compares `Cartesian3.equals` for position, `Color.equals` for tint, and numeric equality for rotation **before** it marks billboards dirty (`node_modules/@cesium/engine/Source/Scene/Billboard.js`, property setters near lines 293, 670 and 692). Blindly skipping those existing identical-value assignments would trim JavaScript calls but does not explain GPU buffer churn. No GPU-dirty claim is made from those assignments.

The renderer's label path is different: every `#renderLabels` call starts with `this.#labels.removeAll()`, then projects eligible MMSIs onto the current camera/canvas, arbitrates up to **120 labels**, and recreates each chosen label with font, offset, distance scaling, background, text and an `aisContactTag(mmsi)` pick ID. Cesium `LabelCollection.removeAll()` destroys all existing label glyph/background billboards, and `add()` constructs new labels (`node_modules/@cesium/engine/Source/Scene/LabelCollection.js`, approximately lines 875–880 and 936–944). Cesium documents `remove` as an O(n) vertex-buffer rewrite with CPU→GPU work (approximately lines 884–895). Thus unconditional label destroy/recreate is a **source-confirmed redundant allocation/update mechanism** even when the camera, positions, text and chosen labels are unchanged. Its percentage of the actual 10K frame bottleneck still requires matched hardware profiling.

Tracks, observations and predicted-marker rebuilds are already reference-gated (`tracks !== #lastTracks`, and equivalent guards) and have independent layer collections. Do not remove polyline gaps, observation markers, selection cues, or a layer for performance. Label arbitration still needs actual per-frame horizon/canvas projection on camera movements; skipping it or culling arbitrary contacts to improve a score would silently change what the operator can select/see.

## Proposed bounded candidate and integrity gates

Retain Cesium labels by MMSI rather than clearing the whole label collection every render. For every visible arbitration winner, reuse the previous `Label` and update position, rendered text and fill color when changed; assign the **same** `aisContactTag` on first creation. Add genuinely new winners and remove only suppressed/departed winners. Keep the exact max-120 budget, priority rule, selected contact guarantee, camera horizon checks, null-vs-zero measurement text, original distance-scale and background settings, and separate contacts/tracks/prediction ownership. Destroy must clear the retained-label registry along with the owned collection. These are functional acceptance conditions, not merely source-code string matches.

## Executed source-stable prechange AMD baseline

On clean HEAD `8f5042ef0c04d3328e5aac8d4887930ccaa821ac`, the prime executed
the independent **scratch-only** real Chrome/AMD D3D11 Cesium benchmark. Vite,
FastAPI and their data root were created in a temporary directory on newly
allocated loopback ports; the existing operator's ports 5174 and 8000 and
`data/` were not touched. A first scratch attempt identified a Node proxy
`net.Socket.connect([options, callback])` argument shape rejected by a strict
network guard. That harness defect was reproduced by the owned Vite process
log, repaired in `8f5042e` and its self-tests rerun. The next attempt exited
**0 / MEASURED_LONGITUDINAL**, all 36-active-frame measurements complete, all
**17/17** load+actual render/clear+render/destroy+render cycles complete, source
HEAD and source hashes unchanged start/end, zero forbidden egress delivered.
The source used the **pre-label-optimization renderer** SHA-256
`52dc9c01aa5ac75fe9322e10fa21e39bedffcbed2969d866ede542d644961aa3`.

| Deterministic nonlive AIS contacts | Active Cesium postRender p50 / p95 ms | Physical `scene.pick` |
| ---: | ---: | --- |
| 100 | 11.1 / 65.3 | 8/8 |
| 1,000 | 16.9 / 24.2 | 8/8 |
| 5,000 | 48.0 / 67.1 | 8/8 |
| 10,000 | **87.5 / 120.6** | 8/8 |

All 17 cleanup samples returned primitive count zero and the observed WebGL
buffer net count **21**, with one connected canvas and no context loss. In the
eight repeated 10k cycles, settled JavaScript heap ranged from **119,167,789**
to **119,279,729 bytes** (last minus first +111,940 bytes); this alone cannot
establish long-term native VRAM or garbage-free behavior. No GPU timer-query
draw duration was measured. The run blocked 10 attempted external HTTP tile
requests; no external WebSockets were observed. Full read-only raw evidence:
`%TEMP%/darkfleet_gpu_longitudinal_frozen_8f5042e.json` (330,788 bytes,
SHA-256 `bae854a96e744e707769e423e9dcc3e7e00eb4bed7a502f6676e5e450e7955bc`).

## Candidate production repair and pre-hardware validation

The previously identified `LabelCollection.removeAll()` unconditional churn
has now been removed from the ordinary temporal path. Actual retained Cesium
`Label` identity is keyed by MMSI; arbitration, camera/horizon projection,
contact priority, label limit and all scientific kinematics remain recomputed
for each frame. An existing label receives only changed position/text/color;
new winners are added and suppressed/departed labels alone removed. Invalid
camera frames clear all retained labels. Renderer destruction clears the owned
registry. This preserves the typed MMSI picking ID, exact label text including
null-versus-measured-zero bearings, distance settings and separate layer
visibility. The candidate renderer SHA-256 is
`08461bf13d9325684811e32ce4081ddfa4ff22c5f0d58480eda8ca29358aaa89`.
Focused TypeScript type-check and **56/56** renderer, 10k perf, lifecycle and
source ordering tests passed; new setter regressions verify zero property
writes for an unchanged frame and only relevant position/text/color writes
when the source measurements change.

**Pending hardware causality:** A second AMD run of the same isolated
100/1k/5k/10k+17-cycle harness on the committed candidate renderer is required
before claiming a measured frame-time benefit. The former GPU 10k 30/60fps
smoothness target remains **FAIL** until proven otherwise. Per-run differences
without matched source identities are not a valid before/after experiment.
