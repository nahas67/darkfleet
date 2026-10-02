# Master Feature Parity Matrix (frozen CP0, 202 IDs)

> Full requirement text: `MASTER_REQUIREMENTS.md`. Status values only:
> `✅ 🟢 🟡 🔴 ⚪`. At CP0 nearly everything is ⚪ — that is the honest start.

## RES (CP0)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| RES-001 | probe scripts | yes (512² read) | partial (model only) | manual | wire into API (CP1) | 🟡 PARTIALLY VERIFIED |
| RES-002 | probe + shipped-code read | yes (signed window) | model | live proof | keep | ✅ VERIFIED |
| RES-003 | probe | yes (absence proven) | registry | manual | keep gated | ✅ VERIFIED |
| RES-004 | probe | yes (210 GCPs) | model only | manual | warp path (CP1) | 🟡 PARTIALLY VERIFIED |
| RES-005 | registry | yes | no | no | adapters (CP4) | ✅ VERIFIED |
| RES-006 | registry | yes | no | no | mask/refs (CP2/CP9) | ✅ VERIFIED |
| RES-007 | registry | yes | no | no | deterministic path (CP3/CP15) | ✅ VERIFIED |
| RES-008 | this repo | yes | yes | review | maintain | ✅ VERIFIED |

## SAR-100s (CP1 — all ⚪, no implementation yet)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SAR-101 | PC router | yes (live, full scan) | yes (pipeline) | 2 live REAL scans | API (CP7) | ✅ VERIFIED |
| SAR-102 | capability model | yes | yes | live + refusal | keep | ✅ VERIFIED |
| SAR-103 | VV/VH selection | yes | yes | live VV | keep | ✅ VERIFIED |
| SAR-104 | `read_window` native-CRS | yes (live 442×445 window) | yes | live + fixtures | keep | ✅ VERIFIED |
| SAR-105 | chain + AOI reprojection | yes | no | 12/12 tests | keep | 🟢 IMPLEMENTED |
| SAR-106 | classifier detects GCP (210 on real asset) | yes | yes | GCP control test | warp path (CP15) | 🟡 PARTIALLY VERIFIED |
| SAR-107 | enforced in read path | yes | yes (pipeline) | refusal test | keep | ✅ VERIFIED |
| SAR-108 | GRD branch + LUT refusal | yes | no | refusal test | EarthSearch path (CP6) | 🟢 IMPLEMENTED |
| SAR-109 | RTC linear→dB live-read | yes (live window) | no | live + unit | keep | 🟢 IMPLEMENTED |
| SAR-110 | partial (TS provenance) | REAL | yes (pipeline) | pipeline tests | keep | 🟢 IMPLEMENTED |
| SAR-111 | 32648 fixture test | yes | no | 12/12 tests | keep | 🟢 IMPLEMENTED |
| SAR-112 | 4 COGs + sidecar | yes | tests | 12/12 tests | keep | 🟢 IMPLEMENTED |

## SAR-200s (CP2 — all ⚪)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SAR-201 | `valid_data_mask` | yes | no | 22/22 | keep | 🟢 IMPLEMENTED |
| SAR-202 | RTC+GRD branches | yes | no | LUT-refusal test | keep | 🟢 IMPLEMENTED |
| SAR-203 | `linear_to_db` eps-guarded | yes | no | spot -3.0103 dB | keep | 🟢 IMPLEMENTED |
| SAR-204 | WorldCover mask in live REAL scan | yes | yes (pipeline) | 2 live scans | keep | ✅ VERIFIED |
| SAR-205 | metre buffer → px dilation | yes | tests | monotonic test | keep | 🟢 IMPLEMENTED |
| SAR-206 | port carveback (GeoJSON) | yes | tests | carveback test | keep | 🟢 IMPLEMENTED |
| SAR-207 | version+tile+buffer in evidence | yes | tests | sidecar test | keep | 🟢 IMPLEMENTED |
| SAR-208 | mask array returned | yes | tests | keep | UI layer (CP11) | 🟢 IMPLEMENTED |
| SAR-209 | NE documented coarse-only | yes | docs | — | keep | 🟢 IMPLEMENTED |
| SAR-210 | reproject-onto-grid | yes | tests | alignment tests | keep | 🟢 IMPLEMENTED |

## SAR-300s (CP3 — ports of verified legacy math)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SAR-301 | `apply_speckle none` | yes | tests | 29/29 | keep | 🟢 IMPLEMENTED |
| SAR-302 | median selection-exact | yes | tests | parity proof | keep | 🟢 IMPLEMENTED |
| SAR-303 | Lee power-domain | yes | tests | effect suite | keep | 🟢 IMPLEMENTED |
| SAR-304 | slots only | no | no | no | CP15 | ⚪ NOT IMPLEMENTED |
| SAR-305 | retention/centroid/area/FP/bg measured | yes | tests | 4 tests | keep | 🟢 IMPLEMENTED |
| SAR-306 | integral-image port | yes | tests | 100% mask | keep | 🟢 IMPLEMENTED |
| SAR-307 | power-domain port | yes | tests | 100% mask | keep | 🟢 IMPLEMENTED |
| SAR-308 | legacy had none; port matches | partial | tests | — | add opening post-parity w/ real data | ⚪ NOT IMPLEMENTED |
| SAR-309 | scipy 8-connectivity, scan-order | yes | tests | 12/12 exact | keep | 🟢 IMPLEMENTED |
| SAR-310 | full extraction port | yes | tests | 12/12 exact | keep | 🟢 IMPLEMENTED |
| SAR-311 | apparent footprint + explicit uncertainty | yes | yes | len/unc in parity | keep | 🟢 IMPLEMENTED |
| SAR-312 | detector + correlation parity | yes | tests | 100% / 12-of-12 | keep | ✅ VERIFIED |
| SAR-313 | none | no | no | no | CP15 adapter | ⚪ NOT IMPLEMENTED |
| SAR-314 | none | no | no | no | CP15 channels | ⚪ NOT IMPLEMENTED |
| SAR-315 | retention measured (strong) | partial | tests | — | real small-target test (CP6) | 🟡 PARTIALLY VERIFIED |

## AIS (CP4 — all ⚪; MISSING today)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| AIS-001..003 | collectors + refusal | code tested; live needs free keys | archive | refusal + normalize tests | keys = external block | 🟡 PARTIALLY VERIFIED |
| AIS-004 | MarineCadastre normalizer + CSV import | yes | tests | row + file tests | live bulk ingest (CP6) | 🟢 IMPLEMENTED |
| AIS-005 | CSV/JSON/NMEA/Parquet importers | yes | tests | file tests | keep | 🟢 IMPLEMENTED |
| AIS-006 | pyais 3.x wired (asdict) | yes (real sentence) | tests | decode test | keep | 🟢 IMPLEMENTED |
| AIS-007..009 | Pydantic + normalizers + dedup | yes | tests | validation + dedup tests | keep | 🟢 IMPLEMENTED |
| AIS-010..013 | Parquet partitions + DuckDB | yes | tests | restart test | keep | 🟢 IMPLEMENTED |
| AIS-014..016 | collectors → same archive; live≠history | yes | tests | refusal tests | keep | 🟢 IMPLEMENTED |

## COR (CP5 — ports of legacy math + dead-state implementation)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| COR-001/002 | propagate + full trace | yes | yes (backend) | parity test | keep | 🟢 IMPLEMENTED |
| COR-003 | WGS84 ellipsoidal Geod | yes | yes | spot + parity | keep | 🟢 IMPLEMENTED |
| COR-004/005 | radius persisted per candidate | yes | yes | parity test | keep | 🟢 IMPLEMENTED |
| COR-006..008 | decomposition persisted | yes | yes (backend) | parity test | keep | 🟢 IMPLEMENTED |
| COR-009 | inputs missing → no invented values | partial | yes | — | documented; surfaced in evidence | 🟢 IMPLEMENTED |
| COR-010 | greedy 1-to-1 | yes | yes | parity test | keep | 🟢 IMPLEMENTED |
| COR-011/012 | **all 7 states + AIS_ONLY** | yes | yes | parity + fixture-driven cases | keep | 🟢 IMPLEMENTED |
| COR-013/014 | neutral wording, no intent claims | yes (engine) | yes | classification tests | UI copy (CP10) | 🟡 PARTIALLY VERIFIED |
| COR-015 | proximity pairs | no | no | no | CP15 temporal intel | ⚪ NOT IMPLEMENTED |
| COR-016 | reported dimensions + uncertainty | yes | yes | parity test | keep | 🟢 IMPLEMENTED |

## EVD (CP6 — all ⚪; provenance object exists but ephemeral)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| EVD-001..003 | full provenance persisted | yes | yes (backend) | 7 pipeline tests | API surface (CP7) | 🟢 IMPLEMENTED |
| EVD-004/005 | per-target + debug evidence | yes | yes (backend) | — | API routes (CP7) | 🟢 IMPLEMENTED |
| EVD-006 | DEMO marked synthetic everywhere | — | — | — | **RESOLVED BY REMOVAL 2026-10-02** | ✅ RESOLVED (the marking is now unconditional and structural: `synthetic=false` and `runtime_mode="REAL"` are invariants the run store refuses to persist otherwise, and the synthesiser that would need marking is deleted. `backend/darkfleet/exports/render.py` stamps every exported artefact unconditionally) |
| EVD-007/008 | version + decomposition in evidence | yes | yes | pipeline tests | keep | 🟢 IMPLEMENTED |

## API (CP7 — mostly MISSING; sync scan exists)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| API-001 | POST /api/scans → 202 + DF-#### id | yes | live REAL scan | 17 API tests | keep | ✅ VERIFIED |
| API-002 | GET /api/scans/{id} (no rerun) | yes | live | tests | keep | ✅ VERIFIED |
| API-003 | GET /api/scans/{id}/targets | yes | live (12 targets) | tests | keep | ✅ VERIFIED |
| API-004 | GET /api/scans/{id}/events (SSE) | yes | live (43 lines) | tests | keep | ✅ VERIFIED |
| API-005 | GET /api/scenes — live provider proxy, explicit `bbox` required | yes | live | tests | keep | ✅ VERIFIED (the synthetic scene catalogue it used to serve was deleted 2026-10-02; there is no default extent and no fallback list) |
| API-006 | GET /api/targets/{id} | yes | live | tests | keep | ✅ VERIFIED |
| API-007 | GET /api/providers/health — LIVE probes | yes | live PC AVAILABLE 2784ms, EarthSearch DEGRADED (GCP) | tests | keep | ✅ VERIFIED |
| API-008 | GET /api/evidence/{target_id} | yes | live | tests | keep | ✅ VERIFIED |
| API-009 | GET /api/debug/{scan_id}/{layer} | yes | live | tests | keep | ✅ VERIFIED |
| API-010 | exports geojson/kml/json; png/pdf 501 CP12 | partial | live (3 formats) | tests | PNG+PDF at CP12 | 🟡 PARTIALLY VERIFIED |
| API-011 | Pydantic contracts + TS mirror (api.ts) | yes | live (422 on bad bbox) | tests | keep | ✅ VERIFIED |
| API-012 | REAL fail → explicit status, no DEMO fallback | yes | live 400 UNKNOWN_PROVIDER | tests | keep | ✅ VERIFIED |

## UI (CP8–CP11 — legacy works but is replaced; dead parts unwired)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| UI-001 | secondary view | behind toggle | **mounted as default** | 70 shell tests | CP9 layer wiring | 🟢 IMPLEMENTED |
| UI-002 | dead BrandMark/MissionStatus | no | new top bar | shell tests | keep | 🟢 IMPLEMENTED |
| UI-003 | dead LeftRail | no | new icon rail | shell tests | keep | 🟢 IMPLEMENTED |
| UI-004 | dead CommandDock | no | new floating dock | shell tests | keep | 🟢 IMPLEMENTED |
| UI-005 | new Layers surface (5 groups) | yes | yes (tests) | shell tests | keep | 🟢 IMPLEMENTED |
| UI-006 | authoritative registry + 8 tests | yes | yes (tests) | yes | CP9 globe wiring | 🟢 IMPLEMENTED |
| UI-007 | dead search | no | shell opens surface | shell tests | full query impl CP9 | 🟡 PARTIALLY VERIFIED |
| UI-008 | scenario select only | REAL | partial | no | real browser | ⚪ NOT IMPLEMENTED (the scenario catalogue it selected from was deleted 2026-10-02; real pass discovery is `GET /api/scenes` / `GET /api/revisit`, which the SAR surface consumes) |
| UI-009 | header button | REAL | partial | no | dock + job events | ⚪ NOT IMPLEMENTED |
| UI-010 | dead type | no | no | no | 5 modes | ⚪ NOT IMPLEMENTED |
| UI-011 | partial (focus dead) | partial | no | no | wire all 6 ops | ⚪ NOT IMPLEMENTED |
| UI-012 | legacy inspector | yes | yes | 53 tests | merged into a 4-tab panel | ✅ VERIFIED |
| UI-013 | none | yes | yes | 35 tests | — | ✅ VERIFIED (no fake playback; source-level no-motion guard) |
| UI-014 | legacy table | yes | bidirectional | 48 tests | merged contacts surface | ✅ VERIFIED |
| UI-015 | legacy modal | yes | yes | 60 tests | lee/kernel/min/max all reachable | ✅ VERIFIED |
| UI-016 | legacy 2D default | yes | yes | 43 tests | demoted to a specialist surface | ✅ VERIFIED |
| UI-017 | none | yes | yes (all 13 served) | 43 tests | — | ✅ VERIFIED |
| UI-018 | 3 client-side | yes | partial | no | tray + backend + PNG/PDF | ⚪ NOT IMPLEMENTED |
| UI-019 | no settings surface | no | no | no | CP13 | ⚪ NOT IMPLEMENTED |
| UI-020 | probed provider health in top bar | yes | live API source | shell tests | keep | 🟢 IMPLEMENTED |
| UI-021 | per-scan mode provenance | yes | yes (tests) | shell tests | keep | 🟢 IMPLEMENTED (the DEMO/REAL *switch* and the mode pill are gone as of 2026-10-02; the mode is reported, never chosen) |
| UI-022 | 4 leaking strings | — | no | no | neutralize | ⚪ NOT IMPLEMENTED |
| UI-023 | Escape closes surfaces; named controls | yes | yes (tests) | shell tests | full shortcut set CP14 | 🟡 PARTIALLY VERIFIED |
| UI-024 | aria-labels, focus, accessible names | yes | yes (tests) | a11y assertions | reduced-motion CP14 | 🟡 PARTIALLY VERIFIED |
| UI-025 | none | no | no | no | 4-resolution review | ⚪ NOT IMPLEMENTED |
| UI-026 | 4 presets uncalled | no | no | no | wire 11 | ⚪ NOT IMPLEMENTED |
| UI-027/028 | partial/no refs | partial/no | no | no | links + EEZ/ports/lanes | ⚪ NOT IMPLEMENTED |
| UI-029 | wake layer slot, registry refuses update | yes | yes (tested) | partial | real geometry CP15 | 🟡 PARTIALLY VERIFIED |
| UI-030 | multipass slot, registry refuses update | yes | yes (tested) | partial | real tracks CP15 | 🟡 PARTIALLY VERIFIED |
| UI-031..033 | globe managers | behind toggle | no | no | wire | ⚪ NOT IMPLEMENTED |
| UI-034 | **attribution bug found+fixed** (CSS hid credits container) | yes | yes | CSS + Cesium source check | keep | ✅ VERIFIED |
| UI-035 | no console-error spam in dev run | pending | — | — | verify at CP14 | ⚪ NOT IMPLEMENTED |
| UI-036 | none | no | no | no | measure FPS | ⚪ NOT IMPLEMENTED |
| UI-037 | legacy UI files deleted after parity | — | — | — | — | ✅ RESOLVED 2026-10-02 (35 modules + 4 test files deleted; unreachability proven from `src/main.tsx` at 0 violations before deletion. See `REMOVALS.md`) |
| UI-038 | legacy shell unmounted from main.tsx | yes | yes | tsc + build | keep single arch | ✅ VERIFIED |
| UI-039 | orbital ocean intelligence laboratory | yes | yes (visual) | shell markup | refine at CP14 | 🟡 PARTIALLY VERIFIED |
| UI-040 | floating surfaces, no dashboard cards | yes | yes | shell tests | keep | 🟢 IMPLEMENTED |

## EXP (CP12)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| EXP-001..003 | legacy-TS generators | REAL | server-side | export tests | — | ✅ VERIFIED (client-side generators in `src/engine/export.ts` deleted 2026-10-02; all three formats now carry provenance from the backend) |
| EXP-004/005 | none | yes | yes | 8 render tests + 2 API tests | — | ✅ VERIFIED (was dead code behind a 501) |
| EXP-006 | partial | REAL | yes | render tests | enforce all | ✅ RESOLVED BY REMOVAL (a synthetic export cannot exist, so there is nothing left to mark: the provenance banner is unconditional and `render_png`/`render_pdf` take no `runtime_mode` argument at all. `tests/test_exports_render.py::test_pdf_never_renders_a_legacy_synthetic_record_as_real`) |

## OPS (CP6/CP13)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| OPS-001..003 | 15-state machine, real events | yes | yes | 24 job tests + stream test | SSE route (CP7) | 🟢 IMPLEMENTED |
| OPS-004..006 | cache + REAL hit counters | yes | yes | 41 storage tests | wire into scan (CP7) | 🟢 IMPLEMENTED |
| OPS-007 | measured structured logs | yes | yes | live scan output | keep | 🟢 IMPLEMENTED |
| OPS-008 | settings.py | yes | partial | import | extend per domain | 🟢 IMPLEMENTED |
| OPS-009 | `.env.example` real | yes | partial | no | keep secrets out | 🟢 IMPLEMENTED |
| OPS-010..012 | none | yes | yes | live compose build + run | — | ✅ VERIFIED (built and run; 3 real defects fixed) |
| OPS-013 | restart persistence | yes | yes (backend) | restart tests | keep | 🟢 IMPLEMENTED |
| OPS-014 | REAL failure persists nothing | yes | yes | isolation tests | keep | 🟢 IMPLEMENTED |

## ADV (CP15 — all ⚪ by rule; nothing starts before CP6)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| ADV-001..003 | none | yes | yes (`/api/tracks`) | 5 track tests + 3 API tests | — | ✅ VERIFIED |
| ADV-004/005 | **real image-based polar-ray arm pair** | yes | 13 tests on controlled wake fixtures | 🟡 | ±10° angular tolerance documented | 🟡 PARTIALLY VERIFIED (the wake fixtures are *test inputs*, not a product synthetic mode — no scene generator exists; no real wake is confirmed) |
| ADV-006 | none | yes | module + mandatory provenance | 11 polarization tests | — | ✅ VERIFIED (single-pol reports NOT_AVAILABLE; nothing imputed) |
| ADV-007/008 | none | yes | yes (`/api/detectors`) | 5 registry tests + 2 API tests | — | ✅ VERIFIED (CA-CFAR baseline; unvalidated ML refused at registration) |
| ADV-009/010 | proximity pairs only | yes | yes (`/api/patterns`) | 6 pattern tests + 2 API tests | — | ✅ VERIFIED (hypothesis + confidence + unknowns on every pattern) |
| ADV-011/012 | unconstrained `analyze-ai` | yes | yes (`/api/targets/{id}/summary`) | 14 narrative tests + 4 API tests | — | ✅ VERIFIED (every failure returns AI_UNAVAILABLE; evidence untouched) |

## GEO — geography and acquisition planning (added after the CP0 freeze, 2026-10-02)

> These IDs post-date the frozen CP0 requirement set, so they are **outside** the
> 201-ID count below and the header count is deliberately unchanged. Scope change
> recorded in `PLAN_CHANGES.md`.

| ID | Requirement | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| GEO-001 | Evidence names the water body a position sits in, never a bare coordinate pair | yes | yes — `darkfleet/marine.py`, embedded per target in `evidence.py` | `tests/test_marine.py` | maintain | 🟢 IMPLEMENTED (Natural Earth 10 m, public domain — see `PROVENANCE.md`; Luzon Strait and Drake Passage absent upstream and that is stated, not hidden) |
| GEO-002 | `GET /api/revisit` — measured SAR acquisition planning for an area: real acquisitions, intervals, gaps, and where the coverage holes are | yes | yes — `darkfleet/revisit.py` + `api/routes.py:1783`; surfaced by `src/plan/AcquisitionPlan.tsx` mounted in the SAR surface of `SpatialShell.tsx` | `tests/test_revisit.py` + `tests/test_revisit_live.py` (deselected by default); `src/plan/plan.test.tsx` (18) | maintain | ✅ VERIFIED (measured from the provider catalogue, NOT SGP4-predicted; `median_revisit_days` is `null` when unmeasurable, never 0) |
| GEO-003 | Vertical datum safety: never conflate geoid and ellipsoidal height, and never imply SAR measured altitude | yes | yes — `darkfleet/geoid.py`, `describe_datum()` embedded in every target evidence record with `altitude_measured: false` | `tests/test_geoid.py` | maintain | ✅ VERIFIED (no EGM2008 grid ships, so conversion is refused and the value is labelled WGS84 rather than assuming N=0) |

## SEC/DOC/TST (CP13/CP14/ongoing)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SEC-001..008 | none | yes | non-root, no-new-privileges | image + compose inspection | no auth by design (local-first) | 🟢 VERIFIED (gaps in SECURITY.md) |
| DOC-001..003 | boilerplate | no | — | — | rewrite (CP13) | ⚪ NOT IMPLEMENTED |
| DOC-004/005 | real files | yes | yes | manual | maintain | 🟢 IMPLEMENTED |
| DOC-006..008 | none/legacy | no | — | — | write (CP13) | ⚪ NOT IMPLEMENTED |
| TST-001 | 371 backend tests (CFAR/mask/geodesy/propagation/radius/scores/class/cache/provenance + revisit/geoid/advanced/exports) | yes | — | 371 pass | extend per CP | ✅ VERIFIED |
| TST-002 | detector + correlation golden parity | yes | tests | detector 100%, 12/12 classes exact | keep | ✅ VERIFIED |
| TST-003 | pipeline → detection → AIS → correlation → evidence | yes | yes | 9 pipeline tests over the checked-in COG fixture | API layer (CP7) | ✅ VERIFIED |
| TST-004 | DEMO/REAL isolation | — | — | — | keep | ✅ VERIFIED BY REMOVAL 2026-10-02 (there is no second mode to isolate from; the stronger guarantee replaced it — a provider failure yields NO data at all, and `tests/test_no_synthetic_in_product.py` asserts the synthesiser module does not exist) |
| TST-005 | restart persistence | yes | yes | run-store + archive tests | keep | ✅ VERIFIED |
| TST-006 | cache keying + reuse + invalidation | yes | yes | counter/corruption tests | keep | ✅ VERIFIED |
| TST-007 | export generation + provenance | none | no | no | CP12 | ⚪ NOT IMPLEMENTED |
| TST-008 | tsc clean; vitest wired w/ proxy | yes | — | 356 pass | add `strict`/`noUnusedLocals` to `tsconfig.json` | 🟡 PARTIALLY VERIFIED (tsconfig still has neither; `tsc --noEmit` is clean) |
| TST-009 | registry + shell suites | yes | — | 8 registry + 91 shell | keep | ✅ VERIFIED |
| TST-009x | remaining frontend suites (evidence/timeline/contacts/analysis/debug/acquisition plan) | yes | yes | 257 across 6 files | keep | ✅ VERIFIED (the suites guarding deleted unreachable code — engine, search, layers, camera — were removed with that code; 445 → 356) |
| TST-010..012 | none (chromium cached) | no | no | no | 3-mode E2E (CP14) | ⚪ NOT IMPLEMENTED |
| TST-013/014 | none | no | no | no | review + measure (CP14) | ⚪ NOT IMPLEMENTED |
| TST-015/016 | ledger started | process | — | — | enforce every CP | 🟢 IMPLEMENTED |

## Counts

**At CP8** (historical, recorded 2026-10-01): TOTAL 201 · ✅ 48 · 🟢 53 · 🟡 15 ·
🔴 0 · ⚪ 85. Remaining work at that point was grouped: globe
wiring/search/camera/evidence/timeline/analysis-workbench (CP9–CP11), exports
(CP12), Docker/OSS/security close-out (CP13), E2E + rendered review (CP14),
advanced intelligence (CP15). (CDSE S-1 BLOCKED is RES-003's ROLE assessment,
recorded in the registry.)

**At 2026-10-02**, recounted from the rows above — this is a **row** count, not an
ID count, because rows aggregate ID ranges (a row reading `AIS-010..013` covers
four IDs), so it is not comparable with the 201-ID total:

| | rows |
|---|---|
| ✅ VERIFIED (incl. 2 resolved by removal) | 49 |
| 🟢 IMPLEMENTED | 60 |
| 🟡 PARTIALLY VERIFIED | 16 |
| 🔴 | 0 |
| ⚪ NOT IMPLEMENTED | 24 |
| **non-GEO rows** | **149** |
| GEO rows (added after the freeze, outside the 201) | 3 |

Row-level movement since CP8 is concentrated in what the 2026-10-02 deletion
batch closed (EVD-006, EXP-001..003, EXP-006, UI-037, TST-004) plus CP13–CP15
deliveries. What remains ⚪ is mostly CP14 E2E and rendered review, UI-008/009/011
(browser-verified surfaces), the remaining UI-02x ergonomics rows, and SAR-304 /
SAR-308 / SAR-313 / SAR-314 slots that are deliberately unfilled.
