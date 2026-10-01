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
| SAR-101 | PC router | yes (live 2.7 s) | model | live proof | wire into API (CP7) | 🟢 IMPLEMENTED |
| SAR-102 | capability model | yes | model | live proof | keep | 🟢 IMPLEMENTED |
| SAR-103 | VV/VH selection | yes | model | live proof | keep | 🟢 IMPLEMENTED |
| SAR-104 | `read_window` native-CRS | yes (live 2.0 s, 8.3 s total) | no | live + fixture | keep | 🟢 IMPLEMENTED |
| SAR-105 | chain + AOI reprojection | yes | no | 12/12 tests | keep | 🟢 IMPLEMENTED |
| SAR-106 | classifier (GCP proven) | partial | no | GCP control | warp path remains | 🟡 PARTIALLY VERIFIED |
| SAR-107 | enforced in read path | yes | no | refusal test | keep | 🟢 IMPLEMENTED |
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
| SAR-204 | WorldCover clip 59.2% water | yes | tests | point-verified | keep | 🟢 IMPLEMENTED |
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
| EVD-001..003 | partial TS object | no | no | no | persist server-side | ⚪ NOT IMPLEMENTED |
| EVD-004/005 | none | no | no | no | evidence + debug APIs | ⚪ NOT IMPLEMENTED |
| EVD-006 | partial (synthetic flag) | DEMO | no | no | enforce on all artifacts | ⚪ NOT IMPLEMENTED |
| EVD-007/008 | partial | DEMO | no | no | version + decomposition | ⚪ NOT IMPLEMENTED |

## API (CP7 — mostly MISSING; sync scan exists)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| API-001/002 | legacy sync scan | DEMO | no | no | job-based rebuild | ⚪ NOT IMPLEMENTED |
| API-003..006 | cache-get only | DEMO | no | no | full job API | ⚪ NOT IMPLEMENTED |
| API-007 | env-var check only | no | no | no | real probing | ⚪ NOT IMPLEMENTED |
| API-008/009 | none | no | no | no | new endpoints | ⚪ NOT IMPLEMENTED |
| API-010 | client-side only | DEMO | no | no | server exports | ⚪ NOT IMPLEMENTED |
| API-011 | TS types only | no | no | no | Pydantic + mirror | ⚪ NOT IMPLEMENTED |
| API-012 | 503 block (honest but dead-end) | no | no | no | capability errors | ⚪ NOT IMPLEMENTED |

## UI (CP8–CP11 — legacy works but is replaced; dead parts unwired)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| UI-001 | secondary view | behind toggle | no | no | promote to default | ⚪ NOT IMPLEMENTED |
| UI-002..004 | dead shell parts | no | no | no | new shell | ⚪ NOT IMPLEMENTED |
| UI-005/006 | dead registry | no | no | no | wire 12 layers | ⚪ NOT IMPLEMENTED |
| UI-007 | dead search | no | no | no | wire + scan-ID | ⚪ NOT IMPLEMENTED |
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
| UI-019/020 | none/env-check | no | no | no | settings + probed health | ⚪ NOT IMPLEMENTED |
| UI-021 | partial (SIMULATION bug) | no | no | no | unmistakable mode | ⚪ NOT IMPLEMENTED |
| UI-022 | 4 leaking strings | — | no | no | neutralize | ⚪ NOT IMPLEMENTED |
| UI-023/024 | none | no | no | no | keyboard + a11y | ⚪ NOT IMPLEMENTED |
| UI-025 | none | no | no | no | 4-resolution review | ⚪ NOT IMPLEMENTED |
| UI-026 | 4 presets uncalled | no | no | no | wire 11 | ⚪ NOT IMPLEMENTED |
| UI-027/028 | partial/no refs | partial/no | no | no | links + EEZ/ports/lanes | ⚪ NOT IMPLEMENTED |
| UI-029/030 | none | no | no | no | slots, hidden | ⚪ NOT IMPLEMENTED |
| UI-031..033 | globe managers | behind toggle | no | no | wire | ⚪ NOT IMPLEMENTED |
| UI-034/035 | CSS hides chrome, keeps credits | yes | no | no | keep + zero spam | 🟡 PARTIALLY VERIFIED |
| UI-036 | none | no | no | no | measure FPS | ⚪ NOT IMPLEMENTED |
| UI-037..040 | — | — | — | — | enforced at CP8+ | ⚪ NOT IMPLEMENTED |

## EXP (CP12)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| EXP-001..003 | legacy-TS | DEMO | client-side | no | server-side + provenance | ⚪ NOT IMPLEMENTED |
| EXP-004/005 | none | no | no | no | PNG + PDF | ⚪ NOT IMPLEMENTED |
| EXP-006 | partial | DEMO | no | no | enforce all | ⚪ NOT IMPLEMENTED |

## OPS (CP6/CP13)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| OPS-001..003 | fake timers | no | no | no | 15-state jobs + SSE | ⚪ NOT IMPLEMENTED |
| OPS-004..006 | none | no | no | no | cache + counter proof | ⚪ NOT IMPLEMENTED |
| OPS-007 | none | no | no | no | stage logger | ⚪ NOT IMPLEMENTED |
| OPS-008 | settings.py | yes | partial | import | extend per domain | 🟢 IMPLEMENTED |
| OPS-009 | `.env.example` real | yes | partial | no | keep secrets out | 🟢 IMPLEMENTED |
| OPS-010..012 | none | no | no | no | compose + volumes | ⚪ NOT IMPLEMENTED |
| OPS-013 | none | no | no | no | restart tests | ⚪ NOT IMPLEMENTED |
| OPS-014 | violated (fallback) | no | no | no | delete fallback | ⚪ NOT IMPLEMENTED |

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
| TST-001 | 6 tests, zero CFAR | partial | — | 6 pass | full suite | ⚪ NOT IMPLEMENTED |
| TST-002 | detector + correlation golden parity | yes | tests | detector 100%, 12/12 classes exact | keep | ✅ VERIFIED |
| TST-003..007 | none | no | no | no | integration (CP6/7) | ⚪ NOT IMPLEMENTED |
| TST-008 | tsc clean (non-strict) | yes | — | pass | enable strict (CP8) | 🟡 PARTIALLY VERIFIED |
| TST-009 | none | no | no | no | suite (CP8+) | ⚪ NOT IMPLEMENTED |
| TST-010..012 | none (chromium cached) | no | no | no | 3-mode E2E (CP14) | ⚪ NOT IMPLEMENTED |
| TST-013/014 | none | no | no | no | review + measure (CP14) | ⚪ NOT IMPLEMENTED |
| TST-015/016 | ledger started | process | — | — | enforce every CP | 🟢 IMPLEMENTED |

## Counts at CP0

TOTAL 201 · ✅ 5 · 🟢 4 · 🟡 9 · 🔴 0 · ⚪ 183. (CDSE S-1 BLOCKED is RES-003's
ROLE assessment, recorded in the registry; the row stays ✅ VERIFIED as research.)
