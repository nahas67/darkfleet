# AIS 10,000-contact CPU guard re-verification — 2026-10-11

## Scope and failure interpretation

- Inspected at HEAD `0d1dfee401a8c7c854d72a38fa39eed2f19c64d0` (parallel workers advanced HEAD while testing). Source change is restricted to `src/globe/tenThousandScale.test.ts`; `glyphGeometry.ts`, renderer, app, and all other workers' files remain untouched.
- Reported failure: the full frontend run flagged `arbitrates 10,000 claims within the 120-label budget and 100ms CPU guard`, with 533 ms test/suite time. **That total is not the arbitration measurement.** The test first creates 10,000 vessel series with five observations apiece (50,000 observations), computes 10,000 `displayStateOf` objects, builds 10,000 label claims, and only then times `arbitrateLabels`.
- The assertion used `performance.now()`. That returns **elapsed wall time**, including OS preemption, GC, and other scheduling effects, so the test was not testing its stated per-call **CPU** limit. Vitest runs files in parallel by default; a worker waiting off-core can exceed 100 ms wall time without doing 100 ms CPU work. Test duration additionally includes expensive fixture setup.

## Before the fix: actual reproductions

| Configuration | Outcome | Interpretation |
| --- | --- | --- |
| Isolated `npm test -- --run src/globe/tenThousandScale.test.ts -t "arbitrates 10,000"` | PASS; test runner reported 222 ms for this file | Includes data generation and display-state work. Isolated wall arbitration did not exceed the old threshold in this run. |
| `npm test -- --run --no-file-parallelism src/globe/tenThousandScale.test.ts src/globe/glyphGeometry.test.ts src/globe/aisRenderer.perf.test.ts` | PASS 58/58 | All related CPU/geometry checks passed serialized. |
| The same three files under ordinary parallel Vitest | PASS 58/58 | One measured scale-test duration was ~308 ms, but old arbitration assertion passed. |
| `npm test -- --run src/globe/tenThousandScale.test.ts --repeats=5` | PASS (all repetitions) | Reported failure was not reproduced under this isolated repeated invocation. |

These results **do not erase the prior failure**; they show it was intermittent and that its reported duration cannot diagnose the specific label algorithm.

## Corrected guard, not a relaxed threshold

The corrected scale test now measures `process.threadCpuUsage()` (CPU microseconds for **this thread**) instead of wall elapsed. `process.cpuUsage()` would count other worker threads in the Node process; it is not an appropriate substitute. This API is available on the local Node **v25.9.0** and is documented by the installed Node declarations as available from **v22.19.0**. An older runtime lacking it cannot run the test successfully; silently substituting wall time would reintroduce the bug.

The 10,000-claim test arbitrates **six times** (including a cold call), and each invocation independently must satisfy **thread CPU <100 ms**. No percentile, best-of or mean can hide an over-budget invocation. Every result must show exactly **120 labels**, **9,880 suppressed**, and identical chosen label identities. Because Windows per-thread CPU accounting is quantized (~15–16 ms) and sometimes reports `0 ms` for a 3–9 ms invocation, the test also requires strictly positive **aggregate CPU** across six invocations. It logs aggregate and worst sampled CPU, plus the worst elapsed wall time, with unambiguous units. It does **not** assert a 100 ms wall-clock service-level objective.

Immediately after the six-call fix, six repetitions of the test produced aggregate thread CPU samples (ms) of **63, 16, 31, 16, 31, 32**; worst wall per sample (ms) **19.46, 6.37, 3.66, 4.75, 3.66, 7.41**, all passing the unchanged per-call `<100 ms CPU` ceiling. Targeted serial tests passed **58/58**; the serial 10k renderer fixture reported **192.61 ms total**: **166.52 ms display**, **13.45 ms orientation**, **12.64 ms label**. The label measure there includes claim construction, not just arbitration.

## Representative full-suite cost and limitations

The first complete parallel frontend run after switching to thread CPU (before adding the extra repeated-call assertion) passed **861/861 tests across 66 files**. With concurrent workload, the test runner attributed **501 ms** to the 10k test including fixture setup; the *single arbitration* reported **47 ms thread CPU / 36.23 ms wall**. The separate `aisRenderer.perf.test.ts` pipeline at 10k contacts reported **225.41 ms total**, **208.33 ms display-state**, **6.16 ms orientation**, **10.92 ms label+claim-construction**. That pipeline was *not* under a 100 ms end-to-end threshold and **does not meet a 100 ms end-to-end CPU target in that run**.

Consequently, this change is a **harness correction**, not an algorithm throughput improvement: no evidence indicates that label arbitration itself was consuming the reported 533 ms or required modifying `glyphGeometry.ts`. Under heavy machine contention, wall latency can still exceed 100 ms; this test intentionally verifies CPU effort rather than frame time or responsiveness. A claim that the globe maintains 60 FPS with 10,000 vessels, or updates the entire 10k-contact AIS pipeline within 100 ms, is **not established** here. Browser WebGL/GPU frame timings were not measured.

## Gates

- After the final six-call guard, `npm test -- --run src/globe/tenThousandScale.test.ts --repeats=5` passed every repetition. The six-call assertion independently passed each time.
- `npm test -- --run --no-file-parallelism src/globe/tenThousandScale.test.ts src/globe/glyphGeometry.test.ts src/globe/aisRenderer.perf.test.ts` passed **58/58**.
- A second complete concurrent `npm test -- --run` passed **861/861 tests across 66 files**, with the final six-call guard in place. The test runner showed the *entire* first test at **524 ms** while the six actual arbitrations together measured **47 ms thread CPU**, worst sampled invocation **16 ms thread CPU** and **41.60 ms wall**. All 120 labels were retained in each call with 9,880 suppressed.
- The concurrent renderer pipeline in this final full run was **247.12 ms total** at 10k contacts, **223.99 ms display-state**, **5.24 ms orientation**, **17.89 ms label+claim-construction**. **It does not satisfy a 100 ms full-pipeline expectation**, despite the label-only CPU gate passing.
- `npm run lint` (TypeScript) **passed**; `npm run build` **passed** with the pre-existing warning for a >500 kB minified JavaScript bundle (~938 kB).
- Browser/GPU frame time, 60 FPS behavior, and guarantee of <100 ms **wall** under OS contention remain **unverified**, not recorded as PASS.

Only the test harness and this evidence note are in the scoped local commit; there is no remote push.
