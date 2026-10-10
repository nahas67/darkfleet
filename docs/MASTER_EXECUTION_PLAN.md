# DarkFleet vNext — Master Execution Plan (FROZEN v1, CP0)

> Authority: actual repo + vNext requirements + live probes + test results.
> Prior runs are re-verified inputs, not authority. Scope changes → PLAN_CHANGES.md.

> **Supersession note, 2026-10-02.** This plan is frozen at CP0 and its gates are
> left as written, but four of them reference a DEMO mode that no longer exists.
> Read them with this note; the corrections are recorded in `PLAN_CHANGES.md` and
> `REMOVALS.md`:
>
> | Gate | Says | Now |
> |---|---|---|
> | CP6 "real job events; DEMO/REAL isolated" | two modes to keep apart | There is one mode. Isolation became "a provider failure yields NO data at all". |
> | CP12 "5 formats, provenance, DEMO marked" | synthetic exports exist and are labelled | Synthetic exports cannot exist. The provenance banner is unconditional and the renderer takes no mode argument. |
> | §"E2E modes" — "DEMO success · REAL success · REAL-failure" | 3 modes | 2 modes. The REAL-failure E2E (TST-012) is now the load-bearing one; DEMO E2E (TST-010) is not runnable and is replaced in `MASTER_REQUIREMENTS.md`. |
> | CP16 global audit "feature-loss audit" | diff against the frozen list | Still required. `FEATURE_PRESERVATION.md` now marks the two retired capabilities and the one never-ported capability (COR-015 proximity pairs) rather than implying all of them survived. |

## Dependency order (no UI polish before the detector is real)

```text
REAL SAR ACCESS → GEOREFERENCING → LAND/WATER MASK → PREPROCESSING
→ CFAR → COMPONENTS → AIS INGEST+STORE → TEMPORAL ALIGN → CORRELATION
→ CONFIDENCE → EVIDENCE → API/JOBS → CESIUM APP → ANALYTICS → OSS POLISH
```

## Checkpoints

| CP | Name | IDs | Advance gate |
|---|---|---|---|
| CP0 | Baseline + research + envs | RES, DOC-004/005 | 11 docs exist; lock populated; re-verified green log |
| CP1 | Real raster + georeferencing | SAR-101..112 | Fixture px→coord in 4326 **and** 32648; live PC RTC window proven |
| CP2 | Preprocessing + real mask | SAR-201..210 | Mask aligned; version in evidence; license clean |
| CP3 | Filter + CFAR + components | SAR-301..315 | **Golden parity**; filter effects measured, no sub-resolution claims |
| CP4 | AIS ingest + persistence | AIS-001..016 | Restart-safe archive; queries; dedup; coverage |
| CP5 | Alignment + correlation | COR-001..016 | 7 classes reachable; geodesic; radii persisted |
| CP6 | Evidence + storage + cache + jobs | EVD, OPS-001..009/013/014 | Cache reuse by counter; real job events; DEMO/REAL isolated |
| CP7 | Complete API | API-001..012 | Typed contracts; REAL-failure explicit, zero synthetics |
| CP8 | New UI foundation | UI-001..005/038/039/040 | Shell renders; legacy intact beside it |
| CP9 | World/layers/camera/search/scenes | UI-006..011/026..034 | Registry layers; search→camera; real SAR overlay |
| CP10 | Evidence + timeline + telemetry | UI-012..014/021/022 | Bidi sync; UNMATCHED explainable; neutral copy |
| CP11 | Analysis + debug workbench | UI-015..017 | 13 debug layers; dB probe; box select; CFAR extended |
| CP12 | Exports + reports | EXP-001..006 | 5 formats, provenance, DEMO marked |
| CP13 | Docker + OSS + config + security | OPS-010..012, SEC, DOC | compose healthy; review closed |
| CP14 | E2E + rendered UI | TST-008..014, UI-023..025/035/036 | **3 E2E modes**; 4 resolutions fixed |
| CP15 | Advanced intelligence | ADV-001..012, UI-029/030 | Wake real; multipass; multipol; ML adapter; temporal intel |
| CP16 | Global audit | TST-015/016 + all | Re-audit; feature-loss audit; **verdict derived** |

## Checkpoint protocol

Re-read plan → git inspect → list IDs → state acceptance criteria → implement →
verify → ledger → commit → re-read plan. Drift audit every 2 CPs (9 checks:
count change, silent removal, duplicate arch, DEMO leak, weakened tests, skipped
verification, dead UI return, frontend domain logic, premature advanced work).

## E2E modes (TST-010/011/012)

DEMO success · REAL success if a provider is accessible · REAL-failure proving
explicit error + zero synthetics + zero fallback. DEMO E2E is never REAL verification.

## Verdict rule

Derived at CP16 from the parity matrix only:
`COMPLETE — VERIFIED` / `COMPLETE — EXTERNAL PROVIDER BLOCKERS ONLY` /
`PARTIALLY VERIFIED` / `BLOCKED`. Never pre-selected (see correction log CP0).

## Prior-correction log (adopted into this frozen plan)

PC RTC primary (anon-verified); CDSE S-1 BLOCKED (no collections; 400=wrong ID);
EarthSearch GCP warp path; `AFFINE/GCP/UNREFERENCED` states; accessibility ≠
georeferencing; filter tests measure retention/displacement/area/FP/SNR (no
sub-resolution promises); AISStream required live provider; Gate split 0A/0B;
git-safety honored (no repo existed; history preserved); advanced slots
`NOT_AVAILABLE`-hidden; 3-mode E2E; verdict never pre-selected.

---

## Living product-completion extension — DF-X9.8 through DF-X20 (2026-10-10)

The sections above remain the original **frozen CP0 plan** for audit history.
This section is the **active execution contract** for the expanded local-first
maritime-intelligence product. It reconciles rather than overwrites that plan.
No historical `DEMO` gate overrides the real-data-only policy in README.

**Takeover evidence:** `main` at `df165df3ed763ce512cd6e9b82100abfdc16ee8d`;
clean tree at the start, 104 local commits ahead of `origin/main`, no remote push.
Source history already contains H1 (`c9e5037`), H2/H3 (`65090d8`), H4
(`0b4b535`), H5 (`e3bf4d0`), H6 (`eac7c62`) and subsequent H7 performance
hardening through `df165df`. **Historical plans listing H1-H5 as PENDING are
stale; their code and validation must be rechecked before closure.**

### Status and verification rules

Use exactly `[ ] NOT STARTED`, `[~] IN PROGRESS`, `[x] COMPLETE`,
`[!] BLOCKED — EXTERNAL`, `[-] DEFERRED — JUSTIFIED`, or `[?] UNVERIFIED`.
An implemented path is not `[x]` until its scientific invariants, persistence,
API consumer, genuine-browser workflow where relevant and tests have evidence.
Existing fixtures may verify deterministic software behavior; they cannot be
presented as proof of operational imagery, AIS coverage or calibration.

Every checkpoint below requires: scoped source paths, an implementation/change
record, applicable unit + API/integration + persisted-restart tests, real-browser
acceptance, scientific/provenance review, quantitative performance evidence
where relevant, an artifact under `docs/`, and the local commit hash. Unavailable
GPU, providers and licensed datasets are individually blocked while independent
local work proceeds. The append-only `EXECUTION_LEDGER.md` records check results.

### Dependency-oriented checkpoints

| ID / state at takeover | Goal / dependencies | Primary implementation scope | Acceptance and evidence gate |
|---|---|---|---|
| **DF-X9.8-H1–H4** `[~] IN PROGRESS` | Remove fabricated coordinates, SAR resolution and missing-length scores; fix AIS authority/races | `backend/darkfleet/ais/delivery.py`, `pipeline.py`, `correlation/match.py`, `src/api/client.ts`, `src/contacts/ContactList.tsx` | Fresh null-vs-measured-zero, missing-data, score-decomposition and async ordering regressions; scan browser proof; record score differences and commit IDs |
| **DF-X9.8-H5–H6** `[~] IN PROGRESS` | FOLLOW ownership, camera disposal, archive restart/concurrency | `src/globe/{aisCamera,engine}.ts`, `backend/darkfleet/ais/archive.py` | Programmatic settle must preserve FOLLOW, manual input releases; repeated attach/dispose; concurrent archive read/write + restart dedup; evidence in DF-X9.8 record |
| **DF-X9.8-H7** `[~] IN PROGRESS` | GPU-backed 10K AIS contact operation; H1–H6 | `src/globe/aisRenderer.ts`, `src/contacts/ContactList.tsx`, browser harness | Real Chrome hardware renderer identified; staged 500/1K/2.5K/5K/10K frame p50/p95/FPS, label budget, picking and selection latency, responsiveness; `docs/DF_X9_8_H7_H8_EVIDENCE.md` |
| **DF-X9.8-H8** `[?] UNVERIFIED` | Long-run leaks, source recovery, offline survival; H7 | `src/globe/{engine,MapSourceController}.ts`, temporal playback | Repeated load/play/follow/clear and 25 basemap-switch cycles, heap trend, timer/listener/primitive counts, recovery and viewport tests; H7/H8 evidence |
| **DF-X9.8-H9** `[?] UNVERIFIED` | Final AIS scientific delta and release gate; H1–H8 | `backend/tests/ais_correctness_fixture.py`, `src/api`, all gates | 27-row before/after score audit; full 12-section browser E2E; pytest/ruff/mypy/vitest/tsc/build; explicit unresolved items; local commit |
| **DF-X10-SAR** `[?] UNVERIFIED` | Genuine local SAR import, repeatable detector configuration, source georeferencing; H9 scientific gate | `backend/darkfleet/{providers,sar,pipeline,api}`, `src/{scenes,analytics,missions}` | Operator imports verified georeferenced SAR without cloud requirement; checksum, CRS, affine/pixel center, radiometry, mask and stage provenance; malformed/unsupported raster safely refused; browser import→detect→select |
| **DF-X11-MULTIPASS** `[?] UNVERIFIED` | Side-by-side SAR, revisit, real multipass comparisons; X10 | `backend/darkfleet/{revisit,temporal}.py`, `api/advanced.py`, `src/intelligence/AdvancedWorkspace.tsx`, `src/analytics` | Independently identified scenes/time/CRS; synchronized viewport and target navigation; comparisons only over aligned measured data; real-scene acceptance and explicit unavailable state |
| **DF-X12-AIS** `[?] UNVERIFIED` | Historical/imported and optional live AIS, gap-safe playback; H9 | `backend/darkfleet/ais`, `src/{ais,temporal,contacts,globe}` | Observation timestamps and nullable fields intact; gaps/predictions clearly separate; antimeridian/high-latitude tests; import→track→play/seek→pick in real browser; live provider only with real credentials |
| **DF-X13-CORRELATION** `[?] UNVERIFIED` | Full explainable MATCHED / SAR_UNMATCHED / UNKNOWN analysis; X10/X12 | `backend/darkfleet/{correlation,ghost_vessel}.py`, `src/dossier` | Candidate rejection trace, uncertainty and coverage provenance; no unmatched→AIS-off conclusion; 27-case scientific comparison and dossier browser assertions |
| **DF-X14-MARITIME** `[?] UNVERIFIED` | Trusted coastline, EEZ, high seas, optional ports/depth/anchorages; H9 | `backend/darkfleet/maritime`, `src/globe/{MapSourceController,maritimeGeometry}.ts`, `src/sensors` | Antimeridian 0–360 and geodesy, offline manifests/checksums, caching and lifecycle; optional unavailable states; real-browser source switching and attribution |
| **DF-X15-SECONDARY** `[?] UNVERIFIED` | Scientifically bounded wake and polarization; X10/X13 | `backend/darkfleet/{polarization,sar/wake,validation/wake}`, `src/dossier/tabs` | Genuine VV stats, dual channels only when co-registered, no fabricated VH; wake stays EXPERIMENTAL — NOT CALIBRATED until independently validated positive/negative corpus, FPR/FNR and domains recorded |
| **DF-X16-WORKBENCH** `[~] IN PROGRESS` | Durable geodesic annotations and measurement tools; X13 | `backend/darkfleet/investigation_geometry.py`, `api/investigations.py`, `src/reports/InvestigationGeometryPanel.tsx`, `src/globe/engine.ts` | Server-backed WGS84 CRUD/geodesics and restart proven in `30faa7d` (`docs/INVESTIGATION_GEOMETRY_EVIDENCE.md`); globe-click placement and primitive overlay integration under verification; snapping/undo history and full 3D browser acceptance still outstanding |
| **DF-X17-VIEWS** `[~] IN PROGRESS` | Named saved camera/layer/selection/playback/workspace views; X16 | `api/views.py`, `src/api/savedViews.ts`, `src/views/SavedViewsWorkspace.tsx`, `engine.ts` | API persistence, missing-resource semantics, optimistic revision and save/restore/delete real-browser smoke verified in `3ba6885`; full selected-SAR/AIS live-data restoration and offline source-switch lifecycle remain unverified |
| **DF-X18-MISSIONS** `[~] IN PROGRESS` | Mission model, watchlists and evidence-based alerts; X13/X16 | `api/missions.py`, `mission_alerts.py`, `src/missions/MissionWorkspace.tsx` | Local persistence/rules/NOT_EVALUATED/idempotent alert/ack and create/delete browser smoke verified in `1b4114c` (`docs/MISSION_ALERT_EVIDENCE.md`); genuine live SAR→watch→alert/ack browser E2E and continuous monitoring not yet verified |
| **DF-X19-REPORTS** `[?] UNVERIFIED` | Reproducible professional reports/export; X13/X16–X18 | `backend/darkfleet/exports`, `src/reports` | Mission dossier PDF/JSON/GeoJSON/KML/PNG as applicable with SHA/provenance, timestamps, uncertainty, analyst annotations distinguished from source, offline regeneration and browser download |
| **DF-X20-AI-MCP** `[ ] NOT STARTED` | Structured MCP and evidence-grounded optional AI; X13/X18/X19 | New bounded backend MCP server and analyst, documented contracts and discoverable UI | Read-only evidence tools, resource validation, no fabricated citations/measurements, deterministic no-model fallback, permission/timeout tests, local integration proof |
| **DF-X21-RELEASE** `[ ] NOT STARTED` | Whole-product integration, resilience, documentation and shipment; X9.8–X20 | All supported services, launch scripts, README, tests, browser and performance harness | Real SAR→AIS→investigation→report workflow; offline and unavailable-provider tests; fresh backend+frontend gates, reproducible installation, performance and security evidence; final verdict derived from open blockers |

The states above describe **verified closure at takeover**, not an assertion that
every subsystem lacks implementation. An audited working feature may move directly
to `[x]` with evidence; no completed component should be recreated merely because
the overall checkpoint is unverified.

### Immediate execution sequence

1. Reverify H1–H6 fixes, test coverage, score deltas and browser behavior.
2. Run H7/H8 with a real GPU browser; fix only measured bottlenecks/leaks.
3. Complete parallel local investigation persistence work and reconcile API/TS
   contracts; keep operator annotations separate from source evidence.
4. Run H9 closure; then deliver SAR and local-first import, multipass, maritime
   context, saved views, missions, alerts, reports and MCP by dependency.
5. Update the machine-readable checkpoint ledger where needed, execute all
   release gates and commit coherent verified work locally. Never infer a
   production-ready verdict from code generation alone.
