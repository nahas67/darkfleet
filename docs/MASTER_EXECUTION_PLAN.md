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
| **DF-X9.8-H7** `[~] IN PROGRESS` | GPU-backed 10K AIS contact operation; H1–H6 | `src/globe/{aisRenderer,glyphGeometry}.ts`, `tools/ais-gpu`, hardware Playwright runner | Chrome 154 hardware WebGL2 AMD D3D11 measured 10K 32.5/37.1 ms postRender frame p50/p95, 30.77 median-derived FPS, 120 labels, 10/10 topmost visible contact picks (2.9/4.3 ms p50/p95), selected update 43 ms; `a00b821`; other drivers and user-app accessibility still open. |
| **DF-X9.8-H8** `[~] IN PROGRESS` | Long-run leaks, source recovery, offline survival; H7 | `src/globe/{engine,MapSourceController}.ts`, temporal playback, hardware harness | 25 true WebGL Cesium renderer create/clear/destroy cycles had 5→0→5 owned primitives without drift, GC-exposed cleared-heap 121,669,344→112,478,428 B, 25 forced fallback/manual source selections; **GPU VRAM, full app playback/FOLLOW/automated cooldown recovery, context loss and soak remain UNVERIFIED**. |
| **DF-X9.8-H9** `[?] UNVERIFIED` | Final AIS scientific delta and release gate; H1–H8 | `backend/tests/ais_correctness_fixture.py`, `src/api`, all gates | 27-row before/after score audit; full 12-section browser E2E; pytest/ruff/mypy/vitest/tsc/build; explicit unresolved items; local commit |
| **DF-X10-SAR** `[~] IN PROGRESS` | Genuine local SAR import, repeatable detector configuration, source georeferencing; H9 scientific gate | `backend/darkfleet/{providers,sar,pipeline,api}`, `src/{scenes,analytics,missions}` | REAL Planetary Computer RTC acquisitions `DF-0001`/`DF-0002` accepted, completed (~7.303 s/6.901 s) and restored after restart; 10 m EPSG:32648 sources, 49,283 valid pixels each, actual CA-CFAR, one SEA_CLUTTER/no AIS case. `docs/REAL_SAR_TWO_PASS_VALIDATION_2026-10-10.md` records proof. Offline operator local-import UI, broad GRD/RTC source acceptance, target selection and multiple-source reliability still open. |
| **DF-X11-MULTIPASS** `[~] IN PROGRESS` | Side-by-side SAR, revisit, real multipass comparisons; X10 | `sar_scene_compare.py`, `sar_scene_imagery.py`, isolated API routers, `src/advanced/{SceneComparisonWorkbench,SceneImageryWorkspace}.tsx`, `AdvancedWorkspace.tsx` | Real distinct RTC `DF-0001`/`DF-0002` checked after backend restart: 49,283 valid paired gamma0 dB pixels, exact EPSG:32648 10 m lattice, descriptive metrics, independent browser PNGs 223×221 loaded, pane-specific first zoom 1.50× vs second 1.00× (`docs/REAL_SAR_TWO_PASS_VALIDATION_2026-10-10.md`); **not** validated subpixel alignment or vessel changes. Mathematically justified synchronized viewport and target navigation still open. |
| **DF-X12-AIS** `[?] UNVERIFIED` | Historical/imported and optional live AIS, gap-safe playback; H9 | `backend/darkfleet/ais`, `src/{ais,temporal,contacts,globe}` | Observation timestamps and nullable fields intact; gaps/predictions clearly separate; antimeridian/high-latitude tests; import→track→play/seek→pick in real browser; live provider only with real credentials |
| **DF-X13-CORRELATION** `[?] UNVERIFIED` | Full explainable MATCHED / SAR_UNMATCHED / UNKNOWN analysis; X10/X12 | `backend/darkfleet/{correlation,ghost_vessel}.py`, `src/dossier` | Candidate rejection trace, uncertainty and coverage provenance; no unmatched→AIS-off conclusion; 27-case scientific comparison and dossier browser assertions |
| **DF-X14-MARITIME** `[~] IN PROGRESS` | Trusted coastline, EEZ, high seas, optional ports/depth/anchorages; H9 | `backend/darkfleet/maritime`, `tools/install_maritime_reference.py`, `src/globe/{MapSourceController,maritimeGeometry}.ts`, `src/sensors` | Real Natural Earth 10m GeoJSON 4,133 features, 410,957 vertices imported to local store; reboot verified `CHECKSUM_UNRECORDED`/usable and genuine `DF-0001/DF-001` coast-context estimate **867.6 m** with exact source metadata. No authenticated publisher prepared-file checksum. EEZ, high seas, NGA ports, GEBCO remain NOT_INSTALLED; no fictitious context. `docs/REAL_NATURAL_EARTH_LOCAL_INSTALL_2026-10-10.md`. |
| **DF-X15-SECONDARY** `[?] UNVERIFIED` | Scientifically bounded wake and polarization; X10/X13 | `backend/darkfleet/{polarization,sar/wake,validation/wake}`, `src/dossier/tabs` | Genuine VV stats, dual channels only when co-registered, no fabricated VH; wake stays EXPERIMENTAL — NOT CALIBRATED until independently validated positive/negative corpus, FPR/FNR and domains recorded |
| **DF-X16-WORKBENCH** `[~] IN PROGRESS` | Durable geodesic annotations and measurement tools; X13 | `investigation_geometry.py`, `api/investigations.py`, `src/reports/{InvestigationGeometryPanel,geometryVertexHistory}.ts*`, `src/globe/engine.ts` | CRUD/restart `30faa7d`; two real browser Cesium canvas clicks → WGS84 polyline → HTTP 201 → reopened after backend restart: 295.085723 km, 159.333544 nm, 114.113837° from operator coordinates, NOT sensor evidence. Bounded draft undo/redo committed `00c62dc`, tests 5/5. SAR/AIS snapping, saved edit-action history, advanced drawing modalities and full lifecycle still open. |
| **DF-X17-VIEWS** `[~] IN PROGRESS` | Named saved camera/layer/selection/playback/workspace views; X16 | `api/views.py`, `src/api/savedViews.ts`, `src/views/SavedViewsWorkspace.tsx`, `engine.ts` | API persistence, missing-resource semantics, optimistic revision and save/restore/delete real-browser smoke verified in `3ba6885`; full selected-SAR/AIS live-data restoration and offline source-switch lifecycle remain unverified |
| **DF-X18-MISSIONS** `[~] IN PROGRESS` | Mission model, watchlists and evidence-based alerts; X13/X16 | `api/missions.py`, `mission_alerts.py`, `src/missions/MissionWorkspace.tsx` | Local persistence/rules/NOT_EVALUATED/idempotent alert/ack and create/delete browser smoke verified in `1b4114c` (`docs/MISSION_ALERT_EVIDENCE.md`); genuine live SAR→watch→alert/ack browser E2E and continuous monitoring not yet verified |
| **DF-X19-REPORTS** `[~] IN PROGRESS` | Reproducible professional reports/export; X13/X16–X18 | `backend/darkfleet/{investigation_reports.py,exports}`, `api/report_routes.py`, `src/reports` | Canonical SHA-256 investigation JSON and linked PDF `17a741f`, relative SQLite path bug fixed, HTTP JSON/PDF 200 for operator-created no-scan case; missing sensor source explicitly unavailable. Full real-source reproduction and cross-format mission dossier acceptance open. |
| **DF-X20-AI-MCP** `[~] IN PROGRESS` | Structured MCP and evidence-grounded optional AI; X13/X18/X19 | `backend/darkfleet/{mcp,analyst.py}`, `api/analyst_routes.py`, `src/analyst`, `src/intelligence/AdvancedWorkspace.tsx` | Read-only stdio MCP implementation `0c3833f`/`ef8930f`; deterministic case-scoped source-cited analyst `796adb2` mounted `e9a9b3c`; real linked RTC case disclosed genuine SEA_CLUTTER from persisted `$.targets[0].cls` (HTTP alias `classification`) after `a377d52` fix; **7 claims, 2 unknowns**; 7 focused backend tests. No independent AIS archive, no optional secured local model configured. |
| **DF-X21-RELEASE** `[~] IN PROGRESS` | Whole-product integration, resilience, documentation and shipment; X9.8–X20 | FastAPI/frontend, WGS84 geodesics, source-backed reports/MCP, GPU and local reference data installer | Post-SAR/MCP GPU integration backend **1,221 passed** before later two MCP/analyst refinements; frontend **834/834** in 60 files, TypeScript/build green, live real RTC two-scan/independent browser PNG/render/restart/compare, local coast/restart and hardware measured H7. AIS archive NOT_CONFIGURED and full H8/model/optional datasets remain not release-certified. |

The states above describe **verified closure at takeover**, not an assertion that
every subsystem lacks implementation. An audited working feature may move directly
to `[x]` with evidence; no completed component should be recreated merely because
the overall checkpoint is unverified.

### Live evidence checkpoint register (2026-10-10 continuation)

This is an **acceptance register**, not a feature-count score. `COMPLETE` requires
the specified scientific, integration, browser, performance and persistence gates;
passing regression fixtures establishes software behavior, not genuine vessel
observations. All commit IDs below are **local** and were not pushed.

| ID / status | Goal; dependencies | Actual components and completed tasks | Tests and browser/scientific acceptance | Performance threshold and measured evidence | Evidence artifacts; commit | Open acceptance tasks |
|---|---|---|---|---|---|---|
| **DF-X11-VIS** `[~] IN PROGRESS` | Review two genuine RTC scenes; requires X10 persisted provenance/cache | `sar_scene_imagery.py`, `api/sar_imagery_routes.py`, `SceneImageryWorkspace.tsx`; checksum-gated source, fixed grayscale, separately controlled pan/zoom and hardened bounded NPY decode | After restart, browser rendered both *distinct REAL* Planetary Computer acquisitions `DF-0001`/`DF-0002`, both PNG 223×221 loaded; first zoom 1.50× while second stayed 1.00×; native CRS/window and timestamps shown. Tests protect absent-source states | Source bound ≤8,000,000 pixels; PNG edge ≤1,024; NPZ ≤96 MiB, member and dtype/header exact checks; measured pair 49,283 finite source pixels per scan | `docs/REAL_SAR_TWO_PASS_VALIDATION_2026-10-10.md`; `4b759af`, `b4b1452`, `39acd4d` | Actual subpixel registration, real-scene synchronized navigation and vessel-change validation unverified; do not infer target identity/behavior from difference statistics |
| **DF-X10-LOCAL** `[x] COMPLETE — IMPORT ONLY` | Allow offline operator-owned GeoTIFF evidence intake without STAC; keep independent of canonical scan completion | `local_sar_import.py`, `api/local_sar_routes.py`, `LocalSarImportPanel.tsx`, Advanced tab, generated API request contract; checksum-verifiable original and snapshot, declared/unverified calibration and timestamp | Live HTTP 201 and 200 PNG; genuine `DF-0001`-derived cache pixels imported, verified SHA256, 223×221 EPSG:32648 and 49,283 valid pixels; actual Chrome DOM panel loaded 223×221 PNG and showed `IMPORTED_NOT_ANALYZED`; 24 backend focused tests/1 skip and 8 UI tests; full backend 1,246/12 skipped/4 deselected, frontend 842/842 | 64 MiB TIFF, 8M native pixels, 8192 edge, ≤768 preview, no remote access; backend live restart query not independently reconfirmed (test-restart verified) | `docs/LOCAL_SAR_IMPORT_EVIDENCE.md`; `5a281d8`, `4e6a9e9`, integration commit recorded in ledger | Validated local-source intake **does not imply RTC/GRD analytical pipeline integration**, authenticated source calibration, a genuine AIS match, or full DF-X10 scientific closure |
| **DF-X16-GEO** `[~] IN PROGRESS` | Geodesic operator geometry; case persistence and WGS84 | `investigation_geometry.py`, `api/investigations.py`, `InvestigationGeometryPanel.tsx`, `geometryVertexHistory.ts`, `engine.ts`; draw, store, reload, undo/redo drafts | Two genuine Cesium pointer clicks and save HTTP 201, subsequent GET after backend restart; coordinates 99.2878258/16.0603010 and 101.7914902/14.9564120; measured WGS84 295.085723 km / 159.333544 nm, operator provenance | Bounded 100 draft history states, 5 focused UI tests passed; no long-run overlay allocation benchmark | `docs/INVESTIGATION_GEOMETRY_EVIDENCE.md`, local browser/HTTP evidence in ledger; `30faa7d`, `17a741f`, `00c62dc` | Real SAR/AIS target snapping, persisted undo history, complete draw/edit/delete browser permutations and lifetime cleanup |
| **DF-X19-CASE** `[~] IN PROGRESS` | Reproducible source-honest reports; depends on saved case and verified scan | `investigation_reports.py`, `api/report_routes.py`, `InvestigationNotebook.tsx`; deterministic JSON digest, PDF report, explicit missing-source | Browser operator case JSON 200/PDF 200; NEW real `DF-0001`-linked case `11b284a1-bdc3-4a85-bfdc-bdaa325e99cf` with one actual SEA_CLUTTER source target plus user note and watch entry displayed after browser reload; JSON correctly `PERSISTED_REAL`, distinguishes operator material and sensor metadata | SHA-256 integrity verified previously for no-scan case; no large export SLA or live AIS report proof | `docs/REAL_SAR_TWO_PASS_VALIDATION_2026-10-10.md`, `backend/tests/test_investigation_reports.py`; `17a741f` | Verify real-case PDF on restart and full cross-format dossier, source-removal stress; no genuine AIS archive configured |
| **DF-X20-OFFLINE** `[~] IN PROGRESS` | Read-only MCP and evidence-grounded analyst; requires saved investigations and source records | `analyst.py`, `api/analyst_routes.py`, `AnalystWorkspace.tsx` and read-only MCP; bounded intents, source field paths, removal and injection controls | Real linked `DF-0001` case: before fix false class-missing unknown; after `a377d52` reads `$.targets[0].cls=SEA_CLUTTER`, 7 real-source claims/2 honest unknowns. 7 Python scoped tests, 5 UI tests; MCP stdio integration historically verified | **NO_MODEL_DETERMINISTIC_OFFLINE**; no model latency/isolation proof or AIS archive coverage | `docs/GROUNDED_ANALYST_EVIDENCE.md`, `docs/REAL_SAR_TWO_PASS_VALIDATION_2026-10-10.md`; `0c3833f`, `796adb2`, `e9a9b3c`, `a377d52` | Safe optional locally restricted model, independent AIS archive support, multi-resource source-deletion E2E |
| **DF-X21-REGRESSION** `[~] IN PROGRESS` | Complete integrated product validation; depends X9.8–X20 | FastAPI/router, generated `src/api/contract.ts`, Vite UI, renderer and durable stores | Final Python **1,222 passed / 11 skipped / 4 deselected** (4 warnings), frontend **834/834** in 60 files, TypeScript/Vite/Ruff and generated contract green; 34/35 routes reachable (1 documented redundant raster). Backend 12/12 focused analyst/MCP post-fix | Two genuine RTC scenes 7.303/6.901 s; GPU AMD D3D11 browser 10K ~30.77 median-derived FPS, pick 10/10; Vite large-bundle advisory | `docs/DF_X9_8_H7_H8_CHROME_HARDWARE_EVIDENCE_2026-10-10.json`, `docs/REAL_SAR_TWO_PASS_VALIDATION_2026-10-10.md`, `docs/REAL_NATURAL_EARTH_LOCAL_INSTALL_2026-10-10.md`; `a00b821`, `a377d52` | Context-loss/soak and true AIS match, optional model and source licensing checks; no unconditional release certification |

**Later DF-X10-LOCAL gate clarification (2026-10-11):** The earlier acceptance
table's “post-restart live HTTP not reconfirmed” note is superseded by the
subsequent confirmed persisted-receipt recovery after a live backend restart:
01:05:13 receipt, 01:11:44 backend launch, fresh loopback status/list/detail/PNG
HTTP 200 and matching source/snapshot SHA-256. See
`docs/LOCAL_SAR_IMPORT_EVIDENCE.md`. This closes **only import intake and
post-restart read acceptance**, not canonical scan analysis or DF-X10-SAR.

**Final follow-up (2026-10-11):** `cf5eafb` hardened vanished-source error
handling; `c1fb4f0` fixed real FastAPI refusal feedback and Advanced tab
overflow. After both commits: 1,249 backend passed/12 skipped/4 deselected,
844 frontend passed across 62 files, Ruff/mypy/tsc/build/contract green.
Patched live API restarted at 01:26:44 local; saved import and PNG remained
readable; nonexistent source gave structured 404. Windows symlink privilege and
privileged link-swap resistance, true calibrated detection/AIS acceptance and
full X21 release certification **remain open**.

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
