# DF-X7W — Wake Scoring Authority: Machine-Generated Delta

**Status:** authoritative. Supersedes any prose in the DF-X7.1 report.
**Baseline commit:** `bcf6864`
**Fixture:** `backend/tests/fixtures/golden/ts_engine_golden.json` (legacy TS engine parity vector)
**Generator:** recomputes `analyse_wake` over the fixture grid, substitutes the
measured verdict for the legacy one, and diffs every target field.

## 0. The report contradiction, resolved

The DF-X7.1 report contained two incompatible statements. The measured table said

```
DF-005  SAR_MATCHED_AIS  ->  SAR_UNMATCHED
DF-006  SAR_UNMATCHED     ->  SAR_MATCHED_AIS
```

and the prose said "DF-006 becoming a Ghost Vessel". The prose was **wrong**.

- **DF-005 ENTERS** Ghost Vessel state (`SAR_UNMATCHED`)
- **DF-006 LEAVES** Ghost Vessel state (becomes `SAR_MATCHED_AIS`)

Ghost Vessel set before: `DF-002, DF-006, DF-008, DF-009, DF-010, DF-011, DF-012`
Ghost Vessel set after:  `DF-002, DF-005, DF-008, DF-009, DF-010, DF-011, DF-012`

**Net count is unchanged at 7.** No Ghost Vessel is created or destroyed.

## 1. What actually happened: an identity assignment flipped

DF-005 and DF-006 exchange the **same** MMSI.

| | DF-005 | DF-006 |
|---|---|---|
| before | `SAR_MATCHED_AIS`, MMSI **477421900**, 756 m, score 0.548 | `SAR_UNMATCHED` |
| after | `SAR_UNMATCHED` | `SAR_MATCHED_AIS`, MMSI **477421900**, 598 m, score 0.500 |

The AIS vessel did not appear or disappear. The product changed which of two
adjacent SAR detections it belongs to, and that is what moved Ghost Vessel status.

This is more serious than two classifications changing. A `+0.08` confidence nudge
— applied through `orient_diff` tolerance and `eff_hdg` substitution — is enough to
transfer a named vessel between two detections. That is the fragility of a single
opaque score, and it is the concrete argument for §6 of the DF-X7W brief: several
inspectable evidence channels rather than one fused number.

## 2. Full per-target delta

```
DF-002  SAR_UNMATCHED -> SAR_UNMATCHED
    sarConf   0.71  -> 0.79      hdg  179 -> 200.0    wake False -> True
    tags      + UNDERWAY

DF-003  SAR_MATCHED_AIS -> SAR_MATCHED_AIS
    sarConf   0.80  -> 0.72      aisConf 0.62 -> 0.63   hdg 210 -> 30
    wake      True  -> False
    composite 0.623 -> 0.627     heading 0.0 -> 0.022

DF-004  SAR_MATCHED_AIS -> SAR_MATCHED_AIS
    sarConf   0.81  -> 0.73      wake True -> False

DF-005  SAR_MATCHED_AIS -> SAR_UNMATCHED          <-- ENTERS GHOST VESSEL
    mmsi      477421900 -> None   aisConf 0.55 -> 0.0
    sarConf   0.74  -> 0.82      dist  756 -> None
    hdg       108    -> 134.0    wake False -> True
    tags      CORRELATED_AIS,CRUDE_OIL_TANKER
           -> SAR_UNMATCHED,AIS_UNASSOCIATED,UNDERWAY
    all score decomposition fields -> None

DF-006  SAR_UNMATCHED -> SAR_MATCHED_AIS           <-- LEAVES GHOST VESSEL
    mmsi      None   -> 477421900 aisConf 0.0 -> 0.5
    sarConf   0.70   -> 0.62      dist  None -> 598
    hdg       227    -> 47        wake True -> False
    tags      SAR_UNMATCHED,AIS_UNASSOCIATED,UNDERWAY
           -> CORRELATED_AIS,CRUDE_OIL_TANKER

DF-007  SAR_MATCHED_AIS -> SAR_MATCHED_AIS
    aisConf   0.66  -> 0.70      hdg 35 -> 189.0
    composite 0.66  -> 0.704     heading 0.0 -> 0.289

DF-008  SAR_UNMATCHED -> SAR_UNMATCHED
    sarConf   0.71  -> 0.79      hdg 134 -> 103.0   wake False -> True
    tags      + UNDERWAY

DF-009  SAR_UNMATCHED -> SAR_UNMATCHED
    hdg       305   -> 336.0

DF-010  SAR_UNMATCHED -> SAR_UNMATCHED
    hdg       271   -> 103.0

DF-011  SAR_UNMATCHED -> SAR_UNMATCHED
    hdg       149   -> 307.0

DF-012  SAR_UNMATCHED -> SAR_UNMATCHED
    hdg       325   -> 160.0
```

**11 of 12 targets change something.** Only DF-001 is untouched.

## 3. Observed field ranges

| field | range across the fixture |
|---|---|
| `sarConf` delta | exactly ±0.08, never anything else |
| `hdg` delta | up to 154° |
| `wake` flips | 6 of 12 |
| classification flips | 2 (DF-005 in, DF-006 out) |
| coordinates | **unchanged — 0 of 12 moved** |

The `sarConf` delta being *exactly* ±0.08 everywhere confirms the coupling is the
single constant in `_sar_confidence`, not an emergent effect.

The `hdg` deltas are the §8/§10 problem: raw values such as `210 -> 30` and
`325 -> 160.0` cross the 0°/180° boundary, so they cannot be read as ordinary
angular differences. See the angle-convention analysis in DF-X7W.

## 4. Decision

The provisional production rule stands, and this delta is its justification:

> **WAKE ANALYSIS IS EVIDENCE, NOT SCORING AUTHORITY.**

`analyse_wake` keeps running and its result is persisted as `WakeEvidence`. It does
not modify `sarConf`, AIS association, correlation composite score, heading
tolerance, or classification. The legacy `_kelvin_sampler` is removed from all of
those as well — replacing one unvalidated authority with another is not a fix.

Removing wake from authority means the fixture result becomes identical to a
"wake always absent" path, which is a *principled* golden change and is reviewed as
such rather than regenerated.