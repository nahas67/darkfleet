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
