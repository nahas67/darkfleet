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
