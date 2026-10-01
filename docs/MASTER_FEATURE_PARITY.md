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
| SAR-108 | none | no | no | no | GRD branch (CP2) | ⚪ NOT IMPLEMENTED |
| SAR-109 | linear read only | partial | no | no | log/dB branch (CP2) | 🟡 PARTIALLY VERIFIED |
| SAR-110 | partial (TS provenance) | DEMO | no | no | persist raster meta (CP6) | ⚪ NOT IMPLEMENTED |
| SAR-111 | 32648 fixture test | yes | no | 12/12 tests | keep | 🟢 IMPLEMENTED |
| SAR-112 | 4 COGs + sidecar | yes | tests | 12/12 tests | keep | 🟢 IMPLEMENTED |

## SAR-200s (CP2 — all ⚪)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SAR-201 | none | no | no | no | implement | ⚪ NOT IMPLEMENTED |
| SAR-202 | none | no | no | no | per-product branches | ⚪ NOT IMPLEMENTED |
| SAR-203 | legacy-TS only | DEMO | no | no | port | ⚪ NOT IMPLEMENTED |
| SAR-204 | synthetic masks only | no | no | no | WorldCover tiles | ⚪ NOT IMPLEMENTED |
| SAR-205 | legacy buffer (unused real data) | no | no | no | real buffer | ⚪ NOT IMPLEMENTED |
| SAR-206 | none | no | no | no | port exceptions (WPI) | ⚪ NOT IMPLEMENTED |
| SAR-207 | none | no | no | no | version+hash in evidence | ⚪ NOT IMPLEMENTED |
| SAR-208 | none | no | no | no | debug layer | ⚪ NOT IMPLEMENTED |
| SAR-209 | misused as mask-adjacent | no | no | no | label coarse-viz only | ⚪ NOT IMPLEMENTED |
| SAR-210 | none | no | no | no | alignment tests | ⚪ NOT IMPLEMENTED |

## SAR-300s (CP3 — ports of verified legacy math)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| SAR-301 | legacy-TS | DEMO | no | no | port | ⚪ NOT IMPLEMENTED |
| SAR-302 | legacy-TS | DEMO | no | no | port | ⚪ NOT IMPLEMENTED |
| SAR-303 | type only (`'lee'` unreachable) | no | no | no | implement Lee | ⚪ NOT IMPLEMENTED |
| SAR-304 | none | no | no | no | architect slots | ⚪ NOT IMPLEMENTED |
| SAR-305 | none | no | no | no | fixture measurement suite | ⚪ NOT IMPLEMENTED |
| SAR-306 | legacy-TS | DEMO | no | no | port to NumPy | ⚪ NOT IMPLEMENTED |
| SAR-307 | legacy-TS (linear-power) | DEMO | no | no | port | ⚪ NOT IMPLEMENTED |
| SAR-308 | none | no | no | no | morphology | ⚪ NOT IMPLEMENTED |
| SAR-309 | legacy-TS | DEMO | no | no | port | ⚪ NOT IMPLEMENTED |
| SAR-310 | legacy-TS | DEMO | no | no | port + footprint | ⚪ NOT IMPLEMENTED |
| SAR-311 | violated (`correlation.ts:180`) | no | no | no | fix required | ⚪ NOT IMPLEMENTED |
| SAR-312 | golden JSON ready | fixture | no | integrity 5/5 | parity suite | ⚪ NOT IMPLEMENTED |
| SAR-313 | none | no | no | no | CP15 adapter | ⚪ NOT IMPLEMENTED |
| SAR-314 | none | no | no | no | CP15 channels | ⚪ NOT IMPLEMENTED |
| SAR-315 | none | no | no | no | small-target tests | ⚪ NOT IMPLEMENTED |

## AIS (CP4 — all ⚪; MISSING today)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| AIS-001..003 | none | no | no | no | adapters (keys = external block) | ⚪ NOT IMPLEMENTED |
| AIS-004 | none | no | no | no | MarineCadastre ingest (keyless) | ⚪ NOT IMPLEMENTED |
| AIS-005 | none | no | no | no | file importers | ⚪ NOT IMPLEMENTED |
| AIS-006 | none | no | no | no | pyais wiring | ⚪ NOT IMPLEMENTED |
| AIS-007..009 | TS shape only | DEMO | no | no | normalize+dedup | ⚪ NOT IMPLEMENTED |
| AIS-010..013 | none (in-memory Map) | no | no | no | Parquet+DuckDB+restart | ⚪ NOT IMPLEMENTED |
| AIS-014..016 | none | no | no | no | collector+metadata | ⚪ NOT IMPLEMENTED |

## COR (CP5 — ports of legacy math + dead-state implementation)

| ID | Existing | Working | Integrated | Tested | Action | Status |
|---|---|---|---|---|---|---|
| COR-001/002 | legacy-TS (spherical) | DEMO | no | no | port + uncertainty | ⚪ NOT IMPLEMENTED |
| COR-003 | violated (haversine) | no | no | no | pyproj.Geod | ⚪ NOT IMPLEMENTED |
| COR-004/005 | legacy-TS | DEMO | no | no | port + persist radius | ⚪ NOT IMPLEMENTED |
| COR-006..008 | legacy-TS | DEMO | no | no | port + persist backend | ⚪ NOT IMPLEMENTED |
| COR-009 | none | no | no | no | missing-input guards | ⚪ NOT IMPLEMENTED |
| COR-010 | legacy-TS | DEMO | no | no | port greedy 1-to-1 | ⚪ NOT IMPLEMENTED |
| COR-011/012 | 4 of 7 dead | no | no | no | implement 3 + emit AIS_ONLY | ⚪ NOT IMPLEMENTED |
| COR-013/014 | types clean, copy leaks | no | no | no | neutralize UI-022 | ⚪ NOT IMPLEMENTED |
| COR-015 | legacy-TS pairs | DEMO | no | no | port neutral | ⚪ NOT IMPLEMENTED |
| COR-016 | legacy-TS | DEMO | no | no | port with uncertainty | ⚪ NOT IMPLEMENTED |

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
| TST-002 | fixture ready | fixture | no | integrity 5/5 | parity suite (CP3) | ⚪ NOT IMPLEMENTED |
| TST-003..007 | none | no | no | no | integration (CP6/7) | ⚪ NOT IMPLEMENTED |
| TST-008 | tsc clean (non-strict) | yes | — | pass | enable strict (CP8) | 🟡 PARTIALLY VERIFIED |
| TST-009 | none | no | no | no | suite (CP8+) | ⚪ NOT IMPLEMENTED |
| TST-010..012 | none (chromium cached) | no | no | no | 3-mode E2E (CP14) | ⚪ NOT IMPLEMENTED |
| TST-013/014 | none | no | no | no | review + measure (CP14) | ⚪ NOT IMPLEMENTED |
| TST-015/016 | ledger started | process | — | — | enforce every CP | 🟢 IMPLEMENTED |

## Counts at CP0

TOTAL 201 · ✅ 5 · 🟢 4 · 🟡 9 · 🔴 0 · ⚪ 183. (CDSE S-1 BLOCKED is RES-003's
ROLE assessment, recorded in the registry; the row stays ✅ VERIFIED as research.)
