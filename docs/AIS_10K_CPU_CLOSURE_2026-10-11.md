# AIS 10K CPU closure checkpoint — 2026-10-11

## Source, scope, and acceptance definition

The original source was clean HEAD **`5ddc0c5eed0443ce3d1027b3ddce41aa22f110af`**. The code under test includes the preceding single-sort display-state optimization (`d4e667a8b66d1986b881bbd24f39cc33eed89fd9`). The previous master checkpoint reported one **147.62 ms** 10K pipeline pass (103.09 ms display-state / 16.89 ms glyph orientation / 27.64 ms claims and labels), inside a **concurrent Vitest suite**, not a standalone frame-budget measurement.

The newly reproducible standalone harness is **`build-tools/ais_10k_cpu_benchmark.ts`**, bundled by esbuild into a native Node.js process under the OS TEMP folder and run without Vitest or a browser. It reproduces the exact `makeVessels(10000)` **synthetic** fixture in `src/globe/aisRenderer.perf.test.ts`: **10,000 vessels, five synthetic 4-minute-spaced AIS-format observations per vessel, 50,000 records, 20° × 40° geographic spread, anchored, course-blind and reported-heading combinations**. This is representative controlled load, **not live provider AIS data**. It measures full CPU-side `displayStateOf` construction, `glyphScreenRotation`, 92 × 15 px label claim construction and `arbitrateLabels(..., maxLabels: 120)` with a deterministic north-up frame. It measures `at(8)` (EXACT fixture fix) and independently `at(10)` (INTERPOLATED display). These two cases cannot be conflated.

Each standalone invocation creates its fixture **outside the clock**, warms the JIT/GC for **five full ticks**, then records **25 consecutive full CPU ticks**, including per-stage wall and Node `process.threadCpuUsage()` time. The reported median and interpolated p95 are calculated over sorted samples, with the maximum recorded explicitly. No time-based gate is silently tuned to pass: the optional `--enforce-100ms` fails the process when the *worst measured entire CPU-path wall time or thread CPU time* is 100 ms or more. Without that flag the report always records separate wall and thread-CPU pass/fail statuses, including failures. Windows thread-CPU accounting has coarse ~15–16 ms resolution, so wall timing and aggregate stage CPU are reported separately rather than treating zero-duration stage CPU samples as proof of free work.

**Scope limitation:** This is a repeatable CPU-side approximation of the existing 10K renderer performance test, **not** the complete `AisContactRenderer.render` with Cesium collection mutations, projection, GPU upload, visible hardware frames, browser input latency or measured 60 FPS. Worker-7 independently owns the hardware WebGL acceptance; CPU-only evidence cannot substitute for it. The separate `tools/ais-gpu/main.ts` browser fixture builds **single-fix** contacts and therefore cannot be substituted for this five-fix display-state CPU benchmark.

## Baseline without candidate code change

These were taken after the earlier commit, before any source optimization in this follow-up, with the exact same fixture. The input fixture SHA256 was always **`b0811413c4902a534c67becebbb8b0b1a0d2c6c03f52f0b09a1944433f652471`**, 10K complete display state at minute 8 SHA256 **`d81e18803b9ac4c0a8fa22d0ae77b20faec1f5c9b2e7ed558170b51242dc25d7`**, minute 10 **`6ea796288cdf194409b997df2f53c3625b509605ba22cea9272796c59cd04d71`**. The chosen labels, suppression counts and glyph rotation summary SHA256 was always **`f2c4f2950f2919e221252be00fddffc30a4cffc3494a691bf5482e094fc787e8`**. The harness now enforces these fingerprints for 10K runs; a change to nullable kinematics, provenance, interpolation, selected direction or label identities must fail visibly.

| Source: old HEAD; 25 measured ticks after five warmups | Whole-path wall median (ms) | p95 (ms) | Worst (ms) | Worst threshold |
| --- | ---: | ---: | ---: | --- |
| Exact fix, baseline run A | 48.79 | 78.70 | 85.73 | Under 100 |
| Exact fix, baseline run B | 47.70 | 58.25 | 75.32 | Under 100 |
| Exact fix, baseline run C | 76.85 | 135.66 | 147.42 | **OVER** |
| Interpolated, baseline run A | 68.35 | 86.24 | 96.70 | Under 100 |
| Interpolated, baseline run B | 107.58 | 127.14 | 130.73 | **OVER** |

The last two rows **disprove stable compliance** even with an isolated script process and no concurrent Vitest. They also showed high real thread-CPU usage, not just OS preemption: exact C whole CPU p95 ~109 ms / worst 126 ms, interpolated B CPU p95 125 ms / worst 140 ms. At least one full-path stage exceeded the budget even before WebGL. These results must not be relabelled PASS because early runs were fast. Original baseline source is retained separately for paired testing via `git show 5ddc0c5:src/ais/displayState.ts`, not from a modified working tree.

## Candidate, controlled A/B and gates

The candidate is a small internal **chronological fast path** in `displayStateOf`: most archived five-fix arrays are already sorted ascending by valid AIS timestamps; a single linear validation scan can reuse that readonly input instead of allocating and sorting a copy again on every frame. An unsorted or invalid-timestamp case falls back to the public archival sort; equal timestamps retain their original stable order. No global cache is used, so mutation between ticks is detected. Public `inTimeOrder`, independent orientation/freshness helpers and all semantic rules remain intact. Correctness tests compare ordered/unsorted/tied/invalid inputs and verify frozen/mutated arrays, null SOG/COG versus measured zero, observed/interpolated positions and exact source timestamps. The **candidate is accepted only if paired measured improvements are meaningful** and both minute8/minute10 output fingerprints remain bit-for-bit unchanged. If not, the product change should be discarded and benchmark/harness evidence retained.

### Controlled historical-source versus candidate measurements

The prime reserved an **exclusive quiet CPU slot after worker-7's GPU sampling and worker-1's Chrome AIS rerun completed**, preventing unrelated benchmark interference. Historical baseline and candidate were bundled separately with the same harness/fixture/dependencies; only `src/ais/displayState.ts` differed. Baseline was fetched from original HEAD **`5ddc0c5`** (Git blob `0b2626b1b90f8cc761dff0dccfc8b8ae5878bcb3`); candidate worktree source blob `7a529ade4a285a345e134a9468d17479e5862eb0`. All bundles were in `%TEMP%` and all runs were **sequential**, not competing for CPU. Order alternated baseline/candidate to reduce source-order drift. Each case had 25 measured full ticks after five warmups.

| Full 10K path, 25 measured ticks per row | Median wall (ms) | p95 wall (ms) | Worst wall (ms) | Median thread CPU (ms) | p95 thread CPU (ms) | Worst thread CPU (ms) | Every tick under 100 ms on both clocks? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Historical baseline — exact A | 52.30 | 72.52 | 81.45 | 47 | 75 | 78 | YES |
| Candidate — exact A | **33.06** | **50.51** | **61.80** | 31 | 47 | 63 | YES |
| Candidate — interpolate A | **52.30** | **63.62** | **64.92** | 47 | 63 | 63 | YES |
| Historical baseline — interpolate A | 73.29 | **103.69** | **132.22** | 78 | 93.80 | **110** | **NO** |
| Candidate — exact B | **40.20** | **50.72** | **50.99** | 32 | 47 | 62 | YES |
| Historical baseline — exact B | 74.30 | 87.98 | 88.60 | 78 | 91 | 94 | YES |
| Historical baseline — interpolate B | 75.22 | 94.44 | **103.83** | 78 | 94 | **109** | **NO** |
| Candidate — interpolate B | **54.46** | **82.89** | **94.41** | 62 | 78 | 78 | YES |

The candidate's median wall time was roughly **37% and 46% lower** on the exact-fix paired comparisons, and **29% and 28% lower** on interpolation. The change is therefore a **measured, meaningful algorithm improvement** rather than a benchmark threshold adjustment. These are independent runs in different processes under OS scheduling and GC, so the ratios are comparisons, not formal confidence intervals. The original benchmark's single exact-fix 147.62 ms path and the extra baseline 147.42 ms worst in an earlier standalone run demonstrate that software and host contention remain material.

The fixture, complete `DisplayContactState[]` output for all 10,000 vessel series at each reference instant, and rendered label/MMSI/rotation-summary SHA256 hashes remained **bit-for-bit identical** between every historical and candidate run; the harness enforces the expected digests on each process invocation. Counts remained **120 shown / 9,880 suppressed**. The optimized candidate was below 100 ms in **all 100 measured ticks total** (**50 exact** and **50 interpolated**), on both clocks. Thus **PASS: sampled quiet standalone 10K CPU-only gate for both fixture instants**. However, do **not** extrapolate to a guaranteed hard real-time SLA, WebGL/GPU draw budget, or worst-case under arbitrary resource contention. Both historical interpolation runs failed their worst-tick gate; earlier baseline runs also failed independently. The separately measured active Cesium GPU/Chrome p95 frame interval remains a distinct performance acceptance question and is not solved by this CPU-only result.

Release coordination: worker-4 explicitly released the quiet CPU slot to the prime immediately after the eight timed processes completed; there were no overlapping GPU/browser timed measurements.

### Focused correctness and build gates after A/B

- `npm test -- --run src/ais/displayState.test.ts src/globe/aisRenderer.perf.test.ts src/globe/tenThousandScale.test.ts`: **119/119 passed in 3 files** (107 display-state assertions, eight renderer-perf assertions, four 10K scale assertions).
- `npm run lint` (`tsc --noEmit`): **passed**.
- `npm run build` (Vite 8.3.2): **passed** (105 transformed modules; JS `index-C2aBNnx9.js` 945.89 kB, gzip 250.16 kB); existing greater-than-500 kB chunk warning remains. Not addressed under this CPU scope.
- A full Vitest project run was **NOT_RUN** during this checkpoint by prime coordination, to avoid interfering with the concurrent hardware GPU re-verification. This focused result is not represented as full-project acceptance.
- Independent real hardware WebGL2 10K active frame timing is not measured by this standalone test; worker-7 owns it. Prime reported a 10K active-Cesium p50/p95 interval approximately **93.3 / 145.7 ms**, so a 60 FPS GPU frame budget is **not met** independently of this CPU-path gain.

## Reproduction and provenance

Build standalone candidate with:

```powershell
$exe = Join-Path $env:TEMP 'darkfleet-ais-10k-candidate.cjs'
node node_modules/esbuild/bin/esbuild build-tools/ais_10k_cpu_benchmark.ts --bundle --platform=node --format=cjs --outfile=$exe
node $exe --runs=25 --warmup=5
node $exe --runs=25 --warmup=5 --interpolated
```

For an independent pre-change baseline comparison, source `5ddc0c5` can be substituted for **only** `src/ais/displayState.ts` through an esbuild `onLoad` plugin; the rest of the harness and all dependencies are identical. For example:

```powershell
git show 5ddc0c5:src/ais/displayState.ts | Set-Content -LiteralPath (Join-Path $env:TEMP 'darkfleet-ais-display-baseline.ts') -Encoding UTF8
node -e "const fs=require('fs');const path=require('path');const esbuild=require('esbuild');const temp=process.env.TEMP;esbuild.build({entryPoints:['build-tools/ais_10k_cpu_benchmark.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'darkfleet-ais-10k-baseline.cjs'),plugins:[{name:'baseline',setup(b){b.onLoad({filter:/displayState[.]ts$/},()=>({contents:fs.readFileSync(path.join(temp,'darkfleet-ais-display-baseline.ts'),'utf8'),loader:'ts'}))}}]}).then(()=>console.log('baseline built')).catch(e=>{console.error(e);process.exitCode=1})"
node (Join-Path $env:TEMP 'darkfleet-ais-10k-baseline.cjs') --runs=25 --warmup=5 --interpolated
```

All emitted bundles and historical baseline source are kept in the OS temporary directory, not committed and not written into user data directories. Do not run paired benchmarks concurrently with hardware GPU trials or another CPU-heavy test suite; prime coordinates the reserved slots with worker-7.
