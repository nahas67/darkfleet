# Globe, AIS, contact and timeline re-verification — 2026-10-11

## Scope and baseline

- Initial inspected repository HEAD: `15ece157c926c04172728127b11a3aa5765c600a` on `main`.
- Environment: Windows, repository mounted at `C:/Users/nahas/OneDrive/Desktop/darkfleet` in the actual test runner; Node `v25.9.0`, npm `11.12.1`, Vitest `5.0.3`.
- Scoped baseline command: `npm test -- --run src/globe src/ais src/contacts src/timeline src/temporal` — **24 test files / 473 passing tests** before these changes.
- The repository had pre-existing untracked data under `data/`. It was not changed or removed by this worker.

## Proven defects and narrowly scoped repairs

1. **Chronological event presentation**: the mission event list sorted by `Date` epochs, but the slider's distinct instants were then sorted as raw strings. Offset or fractional ISO variants could reorder the slider and mislabel the selected instant. `chronologicalEvents` now parses UTC epochs, discards invalid timestamps, applies deterministic tie ordering, and is used for both event rows and slider instants. The slider now retains a timestamp identity across appended/reordered lists; a removed timestamp resets to the newest valid event, and clicking an event also updates the slider's displayed instant. The mission slider stays discrete navigation; the AIS event click still seeks the single `TemporalController` as before.
2. **Contact measurement sort**: descending distance reversed the ascending array, placing unknown distances at the top. Ascending confidence used an inverted comparator, and AIS-only rows represented missing confidence with a numeric zero. `sortContactRows` now puts missing measurements last for either direction, while measured zero SAR confidence remains a valid value. It sorts known confidence values in the direction shown by `aria-sort`.
3. **Globe horizon label occlusion**: the contact-label projection path only tested whether Cesium returned in-bounds screen pixels. The tactical engine already applied the WGS84 horizon tangent-plane guard; AIS labels did not. `isContactAboveHorizon` now rejects the far hemisphere before placing the label, preventing a hidden vessel's text from visually overlaying a nearer contact. Tests cover near-side, far-side and limb positions.

Each change was exercised by a failing regression before implementation, then passed after the repair. Existing tests for typed AIS picks (23), camera/FOLLOW (41), temporal clock (44), lifecycle, label budget and track geometry were rerun as part of the scoped suite.

## CPU scaling benchmark (not WebGL or browser FPS)

Command: `npm test -- --run src/globe src/ais src/contacts src/timeline src/temporal`. Values below are the **second completed run**, after repair. The existing `aisRenderer.perf.test.ts` fixture measures display-state computation, glyph orientation and label arbitration using `performance.now()` in Node. It does not create a Cesium Viewer or measure GPU upload, compositor work, pick latency, or real frame rate. Inputs are generated synthetic fixtures, never real vessel observations. Times are single run observations, not hardware-independent performance guarantees.

| Contacts | Display state (ms) | Orientation (ms) | Labels (ms) | Total CPU (ms) | Total (µs/contact) | Labels shown/suppressed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.68 | 2.82 | 17.30 | 23.80 | 237.96 | 17 / 83 |
| 1,000 | 41.07 | 7.10 | 3.73 | 51.91 | 51.91 | 120 / 880 |
| 5,000 | 130.44 | 12.34 | 4.72 | 147.50 | 29.50 | 120 / 4,880 |
| 10,000 | 288.09 | 5.91 | 24.72 | 318.72 | 31.87 | 120 / 9,880 |

The pre-change baseline run measured total CPU times of **23.65 / 41.04 / 134.82 / 251.05 ms** at these same sizes. Differences reflect a separate run/JIT scheduling and do **not** quantify the horizon-label fix: the fixture does not call the Cesium label projection path. The labels remained capped at 120 in both runs. The 10,000-contact pure performance and selected-label tests passed, but their elapsed values were not separately reported as a publishable benchmark. The retained-update microbenchmark models ordinary JavaScript objects, not actual GPU-managed billboards.

The separate track CPU fixture in the after-change run measured **4.775 ms** for 100 tracks / 500 fixes and **39.659 ms** for 1,000 tracks / 5,000 fixes. This is a separate path and is not additive to the AIS renderer totals without profiling a combined real scene.

## Verification boundary

- The scoped after-change run passed **25 test files / 477 tests**; all new regression assertions passed. `npm run lint` (`tsc --noEmit`) and `npm run build` were also executed in this session; final result is recorded in the worker handoff.
- The existing `tools/ais-gpu/main.ts` is a genuine browser harness with synthetic inputs and requestAnimationFrame/Cesium postRender metrics. It includes stages 500/1,000/2,500/5,000/10,000 but does not include a 100-contact stage. No running DarkFleet browser page was present in the browser tab inventory (only `about:blank`); a hardware-accelerated browser run, GPU adapter identification, real `scene.pick` sampling, FPS/VRAM metrics and real WebGL disposal/restore were **not verified** in this run. No browser FPS or GPU throughput is claimed.
- Other workers are editing separate repository areas concurrently. Only the assigned frontend files and this evidence file are included in this worker's local commit.
