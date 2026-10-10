# DarkFleet — Master Verification and Autonomous Repair Program

**Execution baseline:** 2026-10-11, branch `main`, starting HEAD `15ece157c926c04172728127b11a3aa5765c600a`. Starting tree contained untracked local geospatial data and SQLite state under `data/`; preserve it. No remote publication is authorized. This is a living execution record, separate from the historical frozen CP0 plan in `MASTER_EXECUTION_PLAN.md`.

## Evidence rule

A subsystem passes only after tracing **implementation → production caller → operator surface → behavior → relevant test or real browser evidence**. Green tests alone establish neither sensor calibration nor external-provider availability. Fixture outputs cannot establish operational coverage. Each verdict must distinguish `PASS`, `PRODUCT_FAILURE`, `TEST_FAILURE`, `HARNESS_ERROR`, `HARNESS_HANG`, `NOT_RUN`, and `EXTERNAL_BLOCKER`.

Checkpoint notation: `[ ] NOT VERIFIED`, `[~] VERIFYING`, `[!] DEFECT FOUND`, `[>] REPAIRING`, `[x] VERIFIED AND REPAIRED`, `[-] VERIFIED — NO REPAIR REQUIRED`, `[B] EXTERNALLY BLOCKED`, `[N] NOT RUN`. The current per-feature verdicts and evidence links are in `MASTER_VERIFICATION_CHECKPOINT.md`.

## Execution dependencies

1. **Repository and harness baseline** — inspect Git, source architecture, route reachability, generated API contract, test and runtime prerequisites. Do not reset or discard the local data state; verify server/build identity before browser claims.
2. **Scientific authority** — verify SAR source pixels/metadata, CRS and pixel centers, CFAR and morphology, AIS archive and nullable measurements, correlation/rejection, and Ghost Vessel wording across every consumer. Maintain old/new scientific delta evidence for corrections.
3. **Operator-owned SAR intake** — validate authorized inbox, source and snapshot integrity, errors/races, metadata truth, import-only classification, persistence/restart, API and Advanced UI display.
4. **API, persistence and security** — exercise route registration, contracts, pagination/limits, model validation, transport errors, transactions, idempotency, restart recovery, prompt injection and local-API isolation.
5. **Frontend, Cesium and workflows** — verify every reachable workspace, settings and controls, AIS contacts/tracks/playback/selection, globe resources and camera, full SAR/AIS/case/mission/report/analyst flows with real inputs wherever possible.
6. **Offline and performance** — audit attempted egress while offline; test absence of providers without synthetic substitution. Profile representative 100, 1,000, 5,000 and 10,000 AIS contacts, real browser GPU/render/interaction/memory if available, and repeat cycle correctness.
7. **Final integration** — rerun affected tests, static analysis, production build/contract check, real browser and restart as applicable; reconcile all checkpoints with scoped commit IDs and exact blockers.

## Required invariants

- The Python backend is the unique analytical decision authority; no browser-side fabricated SAR/AIS observations.
- `GHOST VESSEL = SAR_UNMATCHED`, meaning only that no accepted AIS association was established. Evidence surfaces separate `OBSERVED`, `HYPOTHESES` and `UNKNOWNS`; no assertion of illegal behavior or intent.
- Missing AIS position is not `(0,0)`; genuine `(0,0)` remains valid. Missing speed/course/heading/length remain unknown instead of manufactured values or positive scores.
- SAR raster geolocation respects CRS, six affine coefficients, pixel centers and the actual raster window. Resolution and calibration require evidence; an imported TIFF is `IMPORTED_NOT_ANALYZED` until the canonical analysis actually runs.
- Any incomplete provider or data source has a truthful unavailable state, never synthetic fallback. Undeclared and forbidden egress targets are zero; legitimate declared provider/map attempts must remain differentiated.
- Production control claims require the real caller and failure path, appropriate persistence, and, for interactive controls, real browser input where available.
- Browser evidence must record Git HEAD, embedded build HEAD, served build HEAD, digest, browser/GPU and dataset/fixture provenance; a mismatch invalidates that run.

## Checkpoint advancement

For each finding: reproduce → identify root cause → write discriminating regression when practical → repair → run focused tests → check integration/side effects → record actual before/after and commit ID. Existing valid behaviors must survive; unrelated modified and untracked files must be retained. External services, GPU, datasets and credentials are blockers only for the affected acceptance gate.

## Reproduction entry points

```powershell
git status --short --branch
git rev-parse HEAD
backend/.venv/Scripts/python.exe -m darkfleet --check
backend/.venv/Scripts/python.exe backend/tools/route_reachability.py --strict --json
backend/.venv/Scripts/python.exe backend/tools/export_contract.py --check
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
backend/.venv/Scripts/python.exe -m ruff check backend/darkfleet backend/tests
backend/.venv/Scripts/python.exe -m mypy backend/darkfleet
npm test -- --run
npm run lint
npm run build
```

These are prescribed commands, not implied successful runs. The final document must record the commands actually run and their exit codes, counts, harness conditions, output identities and known limits.

## Continuation acceptance cycle — 2026-10-11

The prior cycle closed at local clean Git HEAD `5ddc0c5eed0443ce3d1027b3ddce41aa22f110af`; its attached `refs/notes/darkfleet-verification` receipt records 1,340 backend passes, 14 skips, four deselections, 880 frontend passes and 16/16 production-source/served-bundle identity checks. These figures are **historical evidence**, not proof of the remaining browser workflows. Any subsequent source/documentation commit invalidates the previous built-HEAD equality until a new strict build and served-preview verification is run from the new clean HEAD.

This continuation prioritizes previously unexecuted **local acceptance**, without repeating established scientific fixture checks for their own sake:

1. AIS operator browser: select a visible contact by real pointer input; preserve MMSI, fix identity and nullable kinematics; inspect historical track, play/pause/seek, FRAME TRACK/CONTACT, FOLLOW and manual-camera release; verify map layers, races and Cesium cleanup. A synthetic benchmark fixture may exercise mechanics, but must be identified as synthetic and cannot be relabeled a genuine live AIS acquisition.
2. Writable browser workflows: create/update/reopen case, annotations/notes, geometries, evidence, missions, saved views, PDF/JSON reports and actual persisted settings where implemented. Restart the isolated real API and reopen a new browser page; verify server state and downloaded content, not just optimistic frontend text. Missing implemented UI/API capability is `NOT_IMPLEMENTED`, not an external block.
3. WebGL performance: instrument a recognizable **hardware** adapter in Chrome with the production Cesium renderer, 100/1,000/5,000/10,000 controlled contacts, scene `postRender` and actual interaction/frame intervals, picking latency, cycles and resource/heap behavior. Distinguish JavaScript heap from unobservable VRAM and an isolated renderer fixture from the full operator application.
4. CPU: benchmark all stages of the representative 10,000-contact display/orientation/label path in a quiet standalone process with repeated wall and thread CPU medians/p95/worst. Preserve exact fixture/output fingerprints and nullable/motion semantics; optimize only measured root causes. Do not silently relax the 100 ms performance target.
5. Local runtime: probe Docker availability before attempting isolated Compose startup; exercise actual MCP read-only stdio and offline bounded behavior and interrupted-job recovery where locally testable; protect `data/` and all operator-owned records.
6. Integration close: document each newly observed failure with before/after discriminating evidence, callers, tests, scoped local commit and explicit `PASS`/`FAIL`/`NOT_RUN`/`EXTERNAL_BLOCKER` or `NOT_IMPLEMENTED`. Then rerun affected/full quality gates, regenerate a clean production bundle from the **final** source HEAD, verify served byte/digest identity and attach a new local-only verification receipt. Never push.

Separate dated subsystem reports provide detailed commands, browser evidence and limitations. The current dispositions belong in `MASTER_VERIFICATION_CHECKPOINT.md` and `FINAL_SYSTEM_VERIFICATION.md`, not in this execution specification.

### Continuation execution closeout

- **Implemented/tested operator paths:** Chrome fixture-backed AIS archive→app→Cesium selection, history, seeking, FOLLOW/manual release and source-stable navigation; real Chrome case/mission/note/geometry/views/report actions with backend restart, fresh-page reopen and byte-verified JSON/PDF; genuine subprocess MCP and offline analyst/no-model; owner-aware interrupted-job recovery. Detailed traceability and commands are in the dated subsystem evidence documents and final checkpoint.
- **Repairs:** operator geometry write-vs-refresh receipt, saved view rename control (`a98993d`); orphaned scan owner locks and SSE 409 (`ef1ce87`); 10k chronological archive display-state fast path with identical output hashes (`cf6b3bc`); complete final emitted Cesium resource manifest, missing-file/silent-copy refusals and byte-for-byte release verifier (`2abf3de`). Regressions target the failures, not merely the implementation's existence.
- **Executed full regression replay:** backend **1,346 PASS / 14 SKIPPED / four live DESELECTED**, frontend **887 PASS / 69 files**, contract current, TypeScript and Ruff PASS. The repaired release verifier's hermetic tests **16/16 PASS** and TypeScript identity tests **19/19 PASS**.
- **Real hardware result:** AMD D3D11/WebGL2 active Cesium `postRender` 10k p95 **145.7 ms and 195.1 ms** in two runs of the **same optimized source** — high-density interactive smoothness FAIL; GPU VRAM and long-run leak freedom not demonstrated. The separate 10k full CPU fixture's sampled optimized worst ticks were under 100ms; fixture data were never promoted to REAL AIS observations.
- **Release evidence:** clean committed-head strict Vite build at `2abf3de` PASS; 393 emitted files including 390 copied Cesium resources, actual localhost verifier **20/20 PASS**, digest `7829221f...99ad`. Final documentation amendment changes Git HEAD, so **do not reuse the older digest**: replay the strict build/served digest against the final clean HEAD and store the exact result in its non-mutating local Git note `darkfleet-verification`.
- **Remaining gates explicitly not accepted:** authentic independent SAR/AIS science and live alert decisions, Docker Linux engine unavailable, binary evidence upload and mutable settings not implemented, cross-process Parquet ACID, GPU 10k performance, full native VRAM/long-run heap proof, multi-host durable worker leases and real crash recovery. No push or data-directory mutation.
