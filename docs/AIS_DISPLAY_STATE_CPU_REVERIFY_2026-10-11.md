# AIS 10k display-state CPU re-verification — 2026-10-11

## Scope, source identity, fixture and measurement protocol

- Source HEAD **before** optimization: `e036a728790bf4a6cb4760a5ecff1c0f0120b027`, same canonical `src/ais/displayState.ts` measured in the prior master checkpoint. The baseline source was not edited for either baseline measurement.
- Changes confined to `src/ais/displayState.ts`, `src/ais/displayState.test.ts`, the existing `src/globe/aisRenderer.perf.test.ts`, and this note. Backend, API client, tasking and other workers' paths were read-only or untouched.
- Reused the **exact** fixture builder `makeVessels(10000)` from `src/globe/aisRenderer.perf.test.ts`: 10,000 distinct MMSIs × 5 AIS fixes at minutes 0, 4, 8, 12, 16; 20° latitude/40° longitude spread; anchored, course-blind and reported-heading variants. No test-only fixture simplification or provider substitution. `at(8)` is **an exact recorded fix**, despite the old benchmark comment incorrectly calling it interpolation. A separate `at(10)` post-change profile exercises real interpolation; only the exact-fix case has an archived matching baseline.
- Fixture generation and initial JIT warm-up are outside the timed region. Per-stage timings use **nine** passes (one warm-up discarded, **eight** measured) on the same preconstructed 10k fleet, sorted by elapsed time; "median" is the average of measured middle entries, "worst" is the largest. Timings are **wall-clock CPU-side JavaScript work**, not isolated thread-CPU usage, GPU rendering, FPS or latency guarantees. Different stages are measured **independently** and overlap transitively: their times must **not** be added together to infer percentages.

## Bottleneck found in source

`displayStateOf` performed `inTimeOrder(observations)` and passed the resulting ordered copy to `resolveOrientation`, which **sorted it again** and called `isMoving`, which **sorted a third time**. It then called `freshnessOf`, which **sorted the same five records a fourth time**. Every sort compared ISO timestamps by repeated `Date.parse` calls. This was unnecessary repeated work for every vessel (10k vessels × 5 fixes), including on temporal frames where order could not have changed.

Sample pre-change independent stage medians: `inTimeOrder` **23.71–25.53 ms**, `isMoving` **21.27–23.41 ms**, `resolveOrientation` **37.98–38.26 ms**, `freshnessOf` **23.51–36.91 ms**, and full `displayStateOf` **92.91–137.61 ms** across two isolated runs. The stage measurements overlap; the key evidence is **four sorts per display state** rather than one.

### Repeated measurement comparison (same fixture, unchanged benchmark implementation)

| Condition | Full display-state median (8 measured passes, ms) | Worst single pass (ms) |
| --- | ---: | ---: |
| **Before**, isolated run A | 92.91 | 95.28 |
| **Before**, isolated run B | 137.61 | 178.82 |
| **After**, isolated run A | 40.67 | 80.08 |
| **After**, isolated run B | 42.59 | 46.00 |
| **After**, isolated run C | 39.76 | 52.61 |
| **After**, concurrent full frontend suite | 93.62 | 106.45 |
| **After**, interpolation at minute 10, isolated A / B | 64.96 / 57.72 | 75.98 / 68.60 |
| **After**, interpolation at minute 10, concurrent full suite | 126.18 | 148.73 |

Note: machine scheduling/load varied even across the **two pre-change runs**, and run B was notably slower. Ratios between differently scheduled runs are **indicative**, not a controlled percentage-speedup guarantee. The repeated isolated measurements do show a meaningful reduction. The original prior-checkpoint **single cold parallel** 10k pipeline measured 223.99 ms display / 5.24 ms orientation / 17.89 ms label and claim construction / **247.12 ms total**, not the 100ms target. With the optimization in a full concurrent suite, the original `measure(10000)` pipeline reported **103.09 ms display**, **16.89 ms orientation**, **27.64 ms label and claims**, **147.62 ms total**. These one-shot measurements are not paired repeated statistical samples and may also be affected by scheduler load.

## Actual fix and safeguards

- Added unexported sorted-series internal helpers `isMovingOrdered`, `resolveOrientationOrdered`, `freshnessOrdered`. The exported `isMoving`, `resolveOrientation`, and `freshnessOf` **still** independently call `inTimeOrder` to preserve their public order-insensitive contracts. The main `displayStateOf` now sorts once and reuses that exact immutable ordered copy through all dependent computations. This avoids three redundant sorts and their comparator timestamp parsing. No geodesic calculations, angular thresholds, freshness tier boundaries, prediction rules, label priorities or renderer APIs were modified.
- All 10,000 original complete display-state records (including provenance timestamps, orientation reasons, nullable SOG/COG/heading and freshness) have exactly the **same JSON SHA-256 fingerprint** as the original HEAD: `d81e18803b9ac4c0a8fa22d0ae77b20faec1f5c9b2e7ed558170b51242dc25d7`. The performance test asserts this baseline fingerprint, so a silent numerical, label or provenance change fails the test.
- Dedicated correctness regressions verify unsorted input is not mutated, the optimized display orientation and freshness agree with independently sorted public helpers at before/within/after/out-of-range/invalid reference instants, `null` speed/course remain absent, reported **zero** speed/course remain zero, and interpolated positions retain **both real source timestamps**. The existing comprehensive display-state tests also cover gaps, antimeridian, observed timestamps, predictions, derived headings and threshold boundaries.

## Gates and remaining limitations

- Focused `npm test -- --run src/ais/displayState.test.ts src/globe/aisRenderer.perf.test.ts`: **113/113 passed** (105 correctness + 8 renderer performance tests). TypeScript `npm run lint`: **passed**.
- Complete concurrent `npm test -- --run`: **869/869 passed over 66 files** (concurrent worker-3 changes included extra tests, untouched by this worker). `npm run build`: **passed**, with the existing warning for a large (~941 kB) minified bundle.
- **Do not mark a 100 ms end-to-end SLA PASS:** one full concurrent 10k renderer CPU sample still took **147.62 ms**, with display alone **103.09 ms**. The full suite's repeated 10k interpolation median was **126.18 ms**, worst **148.73 ms**. High contention may raise wall time substantially. The fix is a demonstrated *algorithmic redundant-work reduction*, not a promise that 10,000 contacts sustain 60 FPS or complete every full pipeline within 100 ms. No GPU or browser frame measurement was performed.
- No push. Explicit staged-only commit of owned paths; unrelated dirty and untracked files preserved.
