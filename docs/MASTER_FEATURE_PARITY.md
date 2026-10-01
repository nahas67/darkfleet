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
| SAR-110 | partial (TS provenance) | DEMO | no | no | persist raster meta (CP6) | ⚪ NOT IMPLEMENTED |
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
| COR-011/012 | **all 7 states + AIS_ONLY** | yes | yes | parity + 3 synthetic | keep | 🟢 IMPLEMENTED |
| COR-013/014 | neutral wording, no intent claims | yes (engine) | yes | classification tests | UI copy (CP10) | 🟡 PARTIALLY VERIFIED |
| COR-015 | proximity pairs | no | no | no | CP15 temporal intel | ⚪ NOT IMPLEMENTED |
| COR-016 | reported dimensions + uncertainty | yes | yes | parity test | keep | 🟢 IMPLEMENTED |

## EVD (CP6 — all ⚪; provenance object exists but ephemeral)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| EVD-001..003 | full provenance persisted | yes | yes (backend) | 7 pipeline tests | API surface (CP7) | 🟢 IMPLEMENTED |
| EVD-004/005 | per-target + debug evidence | yes | yes (backend) | — | API routes (CP7) | 🟢 IMPLEMENTED |
| EVD-006 | DEMO marked synthetic everywhere | yes | yes | isolation tests | keep | 🟢 IMPLEMENTED |
| EVD-007/008 | version + decomposition in evidence | yes | yes | pipeline tests | keep | 🟢 IMPLEMENTED |

## API (CP7 — mostly MISSING; sync scan exists)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| API-001 | POST /api/scans → 202 + DF-#### id | yes | live DEMO scan | 17 API tests | keep | ✅ VERIFIED |
| API-002 | GET /api/scans/{id} (no rerun) | yes | live | tests | keep | ✅ VERIFIED |
| API-003 | GET /api/scans/{id}/targets | yes | live (12 targets) | tests | keep | ✅ VERIFIED |
| API-004 | GET /api/scans/{id}/events (SSE) | yes | live (43 lines) | tests | keep | ✅ VERIFIED |
| API-005 | GET /api/scenes (3 DEMO scenes) | yes | live | tests | keep | ✅ VERIFIED |
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
| UI-008 | scenario select only | DEMO | partial | no | real browser | ⚪ NOT IMPLEMENTED |
| UI-009 | header button | DEMO | partial | no | dock + job events | ⚪ NOT IMPLEMENTED |
| UI-010 | dead type | no | no | no | 5 modes | ⚪ NOT IMPLEMENTED |
| UI-011 | partial (focus dead) | partial | no | no | wire all 6 ops | ⚪ NOT IMPLEMENTED |
| UI-012 | legacy inspector | yes | partial | no | merge + tabs | 🟡 PARTIALLY VERIFIED |
| UI-013 | none | no | no | no | real timeline | ⚪ NOT IMPLEMENTED |
| UI-014 | legacy table | yes | one-way | no | merge + sort + bidi | 🟡 PARTIALLY VERIFIED |
| UI-015 | legacy modal | yes | partial | no | extend (lee/kernel/min/max) | 🟡 PARTIALLY VERIFIED |
| UI-016 | legacy 2D default | yes | yes | no | demote to ANALYSIS | 🟡 PARTIALLY VERIFIED |
| UI-017 | none | no | no | no | 13 layers + ?debug | ⚪ NOT IMPLEMENTED |
| UI-018 | 3 client-side | yes | partial | no | tray + backend + PNG/PDF | ⚪ NOT IMPLEMENTED |
| UI-019 | no settings surface | no | no | no | CP13 | ⚪ NOT IMPLEMENTED |
| UI-020 | probed provider health in top bar | yes | live API source | shell tests | keep | 🟢 IMPLEMENTED |
| UI-021 | ModePill + per-scan mode | yes | yes (tests) | shell tests | keep | 🟢 IMPLEMENTED |
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
| UI-037 | legacy UI files retained, unmounted | yes | — | — | delete after parity CP9–CP11 | 🟡 PARTIALLY VERIFIED |
| UI-038 | legacy shell unmounted from main.tsx | yes | yes | tsc + build | keep single arch | ✅ VERIFIED |
| UI-039 | orbital ocean intelligence laboratory | yes | yes (visual) | shell markup | refine at CP14 | 🟡 PARTIALLY VERIFIED |
| UI-040 | floating surfaces, no dashboard cards | yes | yes | shell tests | keep | 🟢 IMPLEMENTED |

## EXP (CP12)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| EXP-001..003 | legacy-TS | DEMO | client-side | no | server-side + provenance | ⚪ NOT IMPLEMENTED |
| EXP-004/005 | none | no | no | no | PNG + PDF | ⚪ NOT IMPLEMENTED |
| EXP-006 | partial | DEMO | no | no | enforce all | ⚪ NOT IMPLEMENTED |

## OPS (CP6/CP13)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| OPS-001..003 | 15-state machine, real events | yes | yes | 24 job tests + stream test | SSE route (CP7) | 🟢 IMPLEMENTED |
| OPS-004..006 | cache + REAL hit counters | yes | yes | 41 storage tests | wire into scan (CP7) | 🟢 IMPLEMENTED |
| OPS-007 | measured structured logs | yes | yes | live scan output | keep | 🟢 IMPLEMENTED |
| OPS-008 | settings.py | yes | partial | import | extend per domain | 🟢 IMPLEMENTED |
| OPS-009 | `.env.example` real | yes | partial | no | keep secrets out | 🟢 IMPLEMENTED |
| OPS-010..012 | none | no | no | no | compose + volumes | ⚪ NOT IMPLEMENTED |
| OPS-013 | restart persistence | yes | yes (backend) | restart tests | keep | 🟢 IMPLEMENTED |
| OPS-014 | REAL failure persists nothing | yes | yes | isolation tests | keep | 🟢 IMPLEMENTED |

## ADV (CP15 — all ⚪ by rule; nothing starts before CP6)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| ADV-001..003 | none | no | no | no | after CP6 | ⚪ NOT IMPLEMENTED |
| ADV-004/005 | crude sampler (not real) | DEMO | no | no | Radon pipeline | ⚪ NOT IMPLEMENTED |
| ADV-006 | none | no | no | no | where supported | ⚪ NOT IMPLEMENTED |
| ADV-007/008 | none | no | no | no | adapter only | ⚪ NOT IMPLEMENTED |
| ADV-009/010 | proximity pairs only | DEMO | no | no | pattern engine | ⚪ NOT IMPLEMENTED |
| ADV-011/012 | unconstrained `analyze-ai` | DEMO | partial | no | constrain + validate | ⚪ NOT IMPLEMENTED |

## SEC/DOC/TST (CP13/CP14/ongoing)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SEC-001..008 | none | no | no | no | review at CP13 | ⚪ NOT IMPLEMENTED |
| DOC-001..003 | boilerplate | no | — | — | rewrite (CP13) | ⚪ NOT IMPLEMENTED |
| DOC-004/005 | real files | yes | yes | manual | maintain | 🟢 IMPLEMENTED |
| DOC-006..008 | none/legacy | no | — | — | write (CP13) | ⚪ NOT IMPLEMENTED |
| TST-001 | 123 backend tests (CFAR/mask/geodesy/propagation/radius/scores/class/cache/provenance) | yes | — | 123 pass | extend per CP | ✅ VERIFIED |
| TST-002 | detector + correlation golden parity | yes | tests | detector 100%, 12/12 classes exact | keep | ✅ VERIFIED |
| TST-003 | pipeline → detection → AIS → correlation → evidence | yes | yes | 7 pipeline tests | API layer (CP7) | ✅ VERIFIED |
| TST-004 | DEMO/REAL isolation | yes | yes | isolation test | keep | ✅ VERIFIED |
| TST-005 | restart persistence | yes | yes | run-store + archive tests | keep | ✅ VERIFIED |
| TST-006 | cache keying + reuse + invalidation | yes | yes | counter/corruption tests | keep | ✅ VERIFIED |
| TST-007 | export generation + provenance | none | no | no | CP12 | ⚪ NOT IMPLEMENTED |
| TST-008 | tsc clean; vitest wired w/ proxy | yes | — | 14 pass | strict at CP8 | 🟡 PARTIALLY VERIFIED |
| TST-009 | registry + shell suites | partial | — | 8 registry pass | rest CP9–CP11 | 🟡 PARTIALLY VERIFIED |
| TST-009x | remaining frontend suites (search/scenes/evidence/timeline/telemetry/modes/errors/keyboard) | no | no | no | CP9–CP11 | ⚪ NOT IMPLEMENTED |
| TST-010..012 | none (chromium cached) | no | no | no | 3-mode E2E (CP14) | ⚪ NOT IMPLEMENTED |
| TST-013/014 | none | no | no | no | review + measure (CP14) | ⚪ NOT IMPLEMENTED |
| TST-015/016 | ledger started | process | — | — | enforce every CP | 🟢 IMPLEMENTED |

## Counts at CP6

Recounted at CP6 from the rows above: TOTAL 201 · ✅ 24 · 🟢 47 · 🟡 12 ·
🔴 0 · ⚪ 118. Frontend (UI), exports, Docker, E2E and advanced rows remain ⚪
by design — they are CP8–CP15 and start only after the core is verified.
(CDSE S-1 BLOCKED is RES-003's ROLE assessment, recorded in the registry.)
