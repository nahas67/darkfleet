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

**Pending:** worker-7's exclusive prechange GPU/billboard/label/memory baseline and worker-1's browser slot release. No production renderer edit or matched before-after GPU performance result is claimed before those occur.
