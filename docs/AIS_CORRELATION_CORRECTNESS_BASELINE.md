# DF-X9.3 — AIS correlation correctness baseline

**Status:** authoritative for the AIS scoring path. Measured, not asserted.
**Builds on:** `docs/AIS_AUTHORITY_MAP.md` (the authority trace; the defect numbering here is
restated from that document and from `backend/tests/ais_correctness_fixture.py`, and the two
numberings do not coincide — see §4).
**Fixture:** `backend/tests/ais_correctness_fixture.py` — 6 vessels, 27 observations, 8 components,
8 scenarios.
**Pins:** `backend/tests/test_ais_correlation_baseline.py` — 50 tests.
**Measured:** 2026-10-06, by executing the fixture against the real archive and the real
`correlate()`. Every number below is output, not arithmetic performed by hand.

---

## 1. Purpose and status

This artifact records what the AIS correlation path actually does once the five DF-X9.1 evidence
corrections are in force, measured end to end through the real read path:

```
real AisObservation objects
  -> real AisArchive.append()          Parquet partitions on disk
  -> real AisArchive.query()           DuckDB, session pinned to UTC
  -> real correlate()                  match.py:250
  -> real score decomposition          match.py:500-509
```

The reason this artifact had to be built at all is a hole in the earlier evidence. The formal
analytical delta against the real deployment archive reported 87 targets, 1,827 comparisons,
0 differences — and proved nothing about AIS, because that archive is **empty**
(`GET /api/ais/coverage` → `NOT_CONFIGURED`, `observations: 0`). Zero AIS rows means zero AIS
scoring paths exercised. Five fixes could not have acted on a row that does not exist.

> **THE CAVEAT THAT GOVERNS EVERYTHING BELOW.**
> **This is a CORRECTNESS FIXTURE, not operational data.** It is written to a pytest `tmp_path`,
> it is never installed into a deployment data directory, it is never served by a route, and it is
> never reachable from the product. Where it appears in a report it is labelled
> `CORRECTNESS FIXTURE`. Any code that reads it into an operational path is a defect. Nothing in
> this document may be cited as evidence about what any real vessel did.

What the artifact *is* good for: pinning the behaviour of the scorer so the renderer work in
DF-X9.3B onwards has a fixed analytical base, and naming every field correction responsible for
every outcome that moved.

## 2. Fixture identity

| Property | Value | Where it lives |
|---|---|---|
| Acquisition instant | `2026-05-12T08:12:00+00:00` | `ais_correctness_fixture.py:77` |
| Raster resolution | `10.0 m` | `ais_correctness_fixture.py:79`; passed to `correlate` as `resolution_m` |
| Cadence | `08:00, 08:04, 08:08, 08:12, 08:16` — 4-minute steps | `ais_correctness_fixture.py:102` |
| Vessels | 6 MMSIs, `257000001` … `257000006` | `ais_correctness_fixture.py:159-248` |
| Rows | **27** — 5 + 5 + 5 + 2 + 5 + 5 | measured: `archive.coverage()["observations"] == 27` |
| Components | 8, `C1`…`C8`, identical geometry | `ais_correctness_fixture.py:347-375` |
| Sources present | `aistream`, `gfw` | measured |
| Archive extent | `2026-05-12T07:20:00+00:00` … `2026-05-12T08:16:00+00:00`, 1 day | measured |
| Weight vector | `(0.45, 0.25, 0.15, 0.15)` = spatial, temporal, heading, size | `match.py:256` |
| `WINDOW_S` | `900` s (±15 min) | `match.py:16` |
| `sog` floor | `sog < 0.1` kn → no projection at all | `geodesy.py:57` |
| `MIN_SCORE` | `0.40` | `match.py:131` |
| `LOW_BAND` | `0.30` — `[0.30, 0.40)` with a candidate → `LOW_CONFIDENCE` | `match.py:132` |
| Base / max radius | `1200.0 m` / `2800.0 m` | `match.py:257-258` |
| `apparent_len` | `round(comp["major"] * resolution_m)` = `round(12.0 × 10.0)` = **120 m** | `match.py:278` |

The cadence is the product's own, not invented for this fixture: `08:00…08:16` in 4-minute steps
matches `test_ais_delivery.py`'s `for minute in (0, 4, 8, 12, 16)`, the fastest cadence the
product models. Every component shares one geometry, chosen so the `SAR_MATCHED_AIS` branch is
reachable at all: `snr = 6 − (−8) = 14` gives `_sar_conf` `0.63` (above `CLUTTER_CONF` `0.45`, with
`area` 9 not `< 4` so no small-component multiplier applies), aspect `12/5 = 2.4` is not `< 1.4` so
the stationary test does not fire despite `maxDb 6 > 2.0`, and `area` 9 is not `<= CLUTTER_AREA` 6
so no clutter branch fires. Measured `sarConf` is `0.63` on all eight targets.

Why the fixture goes through Parquet at all: a nullable column that silently becomes a zero on
write would reintroduce the exact defect under test. Round-tripping is the check, not an
incidental detail — `test_it_survives_the_parquet_round_trip_with_absence_intact` asserts `sog`,
`cog` and `heading` are all `None` after the write, and
`test_the_archive_column_is_length_m_and_not_length` asserts no `length` key exists alongside
`length_m`, because a fixture carrying both would hide which spelling the scorer actually reads.

## 3. Per-scenario table

Every value measured by running the fixture's own `run_scenario` against the on-disk archive.

| Scenario | Component | MMSI | `cls` | matched | `vesselName` | spatial | temporal | heading | size | composite | dist (m) | radius (m) | `dt` (s) | `candidatesConsidered` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | C1 | 257000001 | `SAR_MATCHED_AIS` | true | MV BARE KINEMATICS | 0.875 | 1.0 | 0.0 | 1.0 | **0.794** | 150 | 1200 | 0 | 5 |
| S2 | C2 | 257000002 | `SAR_MATCHED_AIS` | true | MV NORTHWIND | 0.75 | 1.0 | 0.0 | 0.5 | **0.662** | 300 | 1200 | 0 | 5 |
| S3 | C3 | 257000003 | `SAR_MATCHED_AIS` | true | *(absent)* | 0.875 | 1.0 | **1.0** | 0.8 | **0.914** | 150 | 1200 | 0 | 5 |
| S4 | C4 | 257000004 | `SAR_UNMATCHED` | false | — | — | — | — | — | — | 200 † | — | **+3120** | **0** |
| S5 | C5 | 257000004 | `SAR_MATCHED_AIS` | true | MV OUT OF WINDOW | 0.833 | 1.0 | 1.0 | **0.0** | **0.775** | 200 | 1200 | 0 | 1 |
| S6 | C6 | 257000005 | `SAR_MATCHED_AIS` | true | MV GFW FISHING | 0.75 | 1.0 | **0.0** | 0.8 | **0.707** | 300 | 1200 | 0 | 1 |
| S7 | C7 | 257000005 | `SAR_UNMATCHED` | false | — | — | — | — | — | — | 900 ‡ | 1200 ‡ | 720 ‡ | **1** |
| S8 | C8 | 257000006 | `SAR_MATCHED_AIS` | true | MV COURSE BLIND | 0.833 | 1.0 | **0.0** | 0.8 | **0.745** | 200 | 1200 | 0 | 1 |

† S4's 200 m is the **geometric offset the component was placed at** (measured 200.03 m between
`C4` and the `07:20` row). It is *not* a `distanceOffsetMeters`: `|dt| = 3120 > WINDOW_S`, so no
candidate was ever built and `scoreDecomposition` is `None`. Nothing was scored.
‡ S7 has no decomposition for the same structural reason (nothing was *matched*), but it is a
different finding: `candidatesConsidered = 1` and `closestRejected` is populated with
`MMSI 257000005`, `score 0.283`, `shortfall 0.117`. S4 found nothing; S7 found something and
refused it. Both are `SAR_UNMATCHED`, and `corr["closestRejected"]` is what keeps those two
findings distinguishable (`match.py:487-498`).

`dt` sign is `acq − ob_ts` (`match.py:281`). `07:20` precedes the `08:12` acquisition, so S4's
delta is **positive** 3120 s; only `abs(dt)` is tested against the window (`match.py:282`), and
`08:16` would give the negative counterpart.

Two further measured facts that belong with this table:

- **`run_combined` — 8 components in, 8 targets out.** Every component survives: six
  `SAR_MATCHED_AIS` (aisConf 0.79 / 0.66 / 0.91 / 0.77 / 0.71 / 0.74), two `SAR_UNMATCHED`
  (`DF-004`, `DF-007`). `ais_only` is **empty** — all six MMSIs were consumed by the 1-to-1
  association. Under the pre-fix revision this leg returned **zero** targets for the whole scene,
  because one row without a speed aborted the stage (`test_the_combined_scene_survives_one_absent_speed_row`).
- **The internal key is `cls`, not `classification`.** `correlate` emits `cls` (`match.py:513`);
  the API renames it on the way out (`routes.py:1905, 2212, 2226, 2445, 2618`;
  `evidence.py:113`). Measured: `classification=None` on the raw output. `SCORE_KEYS` in the
  fixture documents the same hazard for the decomposition field names.

## 4. The five defects

Numbering follows this document. `docs/AIS_AUTHORITY_MAP.md` numbers the *traced* defects
differently, and `ais_correctness_fixture.py` numbers the *test* ones differently again; the
mapping is stated per defect so the three documents can be reconciled.

### DEFECT 1 — absent SOG crashing `propagate()`

**Old behaviour.** `correlate` read `ob["sog"]` with no `None` guard and passed it straight to
`propagate`, which evaluates `sog_knots < 0.1` (`geodesy.py:57`). Executed:
`propagate(1.0, 103.0, None, 90.0, 120.0)` → `TypeError: '<' not supported between instances of
'NoneType' and 'float'`. Not a wrong number — a crash. `AisObservation.sog` is explicitly nullable
(`models.py:41`), so this was the CORRELATING stage failing on an archive the model permits.

**Correct behaviour.** `_speed_knots` (`match.py:19-46`) reads absence as **zero MOTION**, not zero
speed, and the retained `< 0.1` guard declines to project. Measured:
`propagate(1.0, 103.0, None, 90.0, 120.0)` → `{'lat': 1.0, 'lon': 103.0,
'projectedDistanceMeters': 0.0}`; `dynamic_radius(1200.0, 900.0, None, 2800.0)` → `1200.0` — an
un-reported speed licenses no drift *and* no wider search.

**Proved by.** `TestNullSog::test_nothing_is_propagated_for_an_absent_speed` (exact
`projectedDistanceMeters == 0.0` and unchanged coordinates),
`::test_an_absent_speed_licenses_no_search_allowance`, and
`::test_a_vessel_that_reports_no_speed_can_still_be_matched_on_position` — the last is the one that
rules out the cheap fix, which would have been to exclude such vessels from correlation. S1 matches
MMSI 257000001 with 5 candidates considered and composite 0.794.

**Analytical effect.** S1 has no pre-fix outcome at all; the stage raised before reaching one.
Blast radius is the point: **one** such row anywhere in the archive took the entire scene to zero
targets. Measured now: 8 components → 8 targets.

### DEFECT 2 — SOG present, COG absent, crashing `orient_diff`

**Old behaviour.** A second, distinct crash. `_course_deg` did not exist, so `orient_diff(eff_hdg,
cog_deg)` received `None` and `abs(deg1 - deg2) % 180` (`geodesy.py:108`) raised `TypeError`. It
is a separate mechanism from DEFECT 1 and was found **by measurement, not by reading the code** —
which is why the fixture carries a dedicated vessel (257000006) for it.

**Correct behaviour.** `_course_deg` returns `None` (`match.py:56-57`) and the heading term
short-circuits to `0.0` (`match.py:306`). Measured:
`propagate(1.0, 103.0, 10.0, None, 120.0)` → `projectedDistanceMeters == 0.0`. There is a distance
but no direction; inventing a direction would be inventing a heading.

**Proved by.** `TestNullCogWithAValidSpeed::test_the_heading_term_scores_exactly_zero`,
`::test_no_course_means_no_direction_to_project_along`, and
`::test_the_heading_weight_is_still_charged_for_the_missing_term` — the last is what stops "scoring
zero" from being indistinguishable from "dropping the term": the composite must fall below 1.0,
and it does (0.745).

**Analytical effect.** S8 has no pre-fix outcome; the stage raised. Measured now:
`headingScore 0.0`, composite **0.745**. The hull axis is 45°, so a *reported* 45° course would
have scored 0.5 — which is what makes the zero a real assertion rather than a tautology.

### DEFECT 3 — `length` vs the real `length_m` column

**Old behaviour.** `correlate` read `ob.get("length", 0)`; `AisObservation` names the field
`length_m` (`models.py:53`) and the Parquet schema names the column `length_m` (`archive.py:36`).
On every real archive row the read returned `0`, the `> 0` guard skipped, and `size` stayed pinned
at its `0.8` default (`match.py:321`). A 0.15-weighted term contributed a **constant**.

**Correct behaviour.** `_hull_length_m` (`match.py:70-94`) reads both spellings, canonical first.
Measured: `_hull_length_m({'length_m': 240.0, 'length': 999.0})` → `240.0`, so a row carrying both
cannot pick the wrong one by dict ordering.

**Proved by.** `TestRealHullLengthDrivesTheSizeTerm::test_the_size_term_is_not_the_pinned_default`,
`::test_the_size_term_is_the_documented_value_for_this_hull` (pins 0.5 from the documented formula,
independently of the code), and the mutation guard
`::test_the_size_term_responds_to_the_real_hull_length`, which strips `length_m` from the same
rows and requires the default 0.8 to return. Without the mutation leg, "size is not 0.8" would
also be satisfied by a size term that read something else entirely.

**Analytical effect.** Measured with `length_m` stripped from the identical rows, which restores
the pre-fix default exactly:

| Scenario | hull | size (measured) | size (default) | composite (measured) | composite (default) | Δ |
|---|---|---|---|---|---|---|
| S2 | 240 m | **0.5** | 0.8 | 0.662 | 0.707 | **−0.045** |
| S5 | 60 m | **0.0** | 0.8 | 0.775 | 0.895 | **−0.120** |

S2 is the identity test: a real 240 m hull against a 120 m apparent length. S5 is the case
DF-X9.3 §6 asks about — see §6.

The same column-name mismatch applied to two sibling fields, fixed in the same pass and measured
here too: the archive stores `name` (`archive.py:32`) and `ship_type` (`archive.py:35`) where the
scorer had read `shipName` and `shipType`. Measured: S6's `vesselName` is `MV GFW FISHING` (was
always `None` on a real archive row) and S6's tags are `['CORRELATED_AIS', 'FISHING']` — a
non-empty vessel type, so no bare empty-string tag reaches the output
(`test_no_target_claims_a_name_it_was_not_given`).

### DEFECT 4 — absent COG read as 0°

**Old behaviour.** The scorer treated an absent course as a course of zero degrees, which is a
**real course due north**. Against a north-oriented hull, `orient_diff(0.0, 0.0) = 0`, so
`hdg = 1.0` — a full 0.15 of composite earned by a value nobody reported.

**Correct behaviour.** An absent course scores exactly `0.0` on the heading term
(`match.py:301-306`). The penalty is deliberate and stays visible in the composite.

**Proved by.** `TestGfwAbsentKinematics::test_the_heading_term_is_zero_not_a_free_north_match`
and, on the general (non-GFW) path,
`TestMeasuredZeroIsNotAbsence::test_the_control_and_the_absent_course_vessels_are_distinguishable`.

**Analytical effect.** Measured counterfactual — the same rows with the fabricated zeros restored:

| Scenario | heading (measured) | heading (zeros restored) | composite (measured) | composite (restored) | Δ |
|---|---|---|---|---|---|
| S6 | **0.0** | 1.0 | 0.707 | 0.857 | **−0.150** |
| S7 | **0.0** | 1.0 | 0.283 (rejected) | **0.433 → `SAR_MATCHED_AIS`** | classification flips |

The delta is exactly the 0.15 heading weight in both cases. At S6 that costs score and the match
survives. At S7 it costs the match — see §5.

### DEFECT 5 — GFW fabricating zero kinematics

**Old behaviour.** `normalize_gfw_event` wrote `sog=0.0, cog=0.0, heading=0.0` (`gfw.py`). GFW is a
fishing-activity dataset: its events carry a position, a vessel and a time, and nothing else. The
zeros asserted three measurements nobody made, in three separate ways that mattered:

- a vessel at anchor and a vessel with no speed report became indistinguishable — the exact
  conflation `models.py`'s module docstring exists to prevent;
- `propagate`'s own `sog < 0.1` guard was **defeated**, because `0.0 < 0.1` is true and so the
  vessel was projected as genuinely stationary rather than declined;
- `cog = 0.0` is a real course due north, which is DEFECT 4's free heading match supplied at the
  source.

**Correct behaviour.** All three are `None` (`gfw.py:88-92`).

**Proved by.** `TestGfwAbsentKinematics::test_the_stored_row_carries_null_kinematics` (measured: all
five GFW rows carry `sog=None, cog=None, heading=None` through Parquet),
`::test_a_gfw_vessel_is_not_projected`, and — the one that makes the distinction concrete —
`::test_the_positions_still_move`. Measured: MMSI 257000005's `lat` differs between its first and
last observation. **An AIS track can move without the row carrying a speed.** Absence of kinematics
is not evidence of a stationary vessel, and the fixture proves it rather than asserting it.

**Analytical effect.** The vessel identity is not lost by the fix: measured `vesselName` is
`MV GFW FISHING` (`test_the_vessel_identity_survives_normalisation`). What is lost is the three
fabricated zeros, worth exactly 0.150 of composite at S6 and one classification at S7.

**Mapping note.** DEFECTS 4 and 5 are the two halves of authority-map defect 2. DEFECT 4 is the
scorer's substitution; DEFECT 5 is the provider supplying it. They are separate corrections in
separate files, and fixing either alone leaves the other in place.

## 5. Classification / association deltas

### EXPECTED CORRECTNESS CHANGES

Every scenario whose outcome differs from the pre-fix revision, each naming the evidence-field
correction responsible. Source of record: `TestNoUnexpectedAnalyticalChange::PINNED`.

| Scenario | Pre-fix | Post-fix | Responsible evidence-field correction |
|---|---|---|---|
| S1 | *(no outcome — `TypeError`)* | `SAR_MATCHED_AIS` | `sog` absent now reads as zero motion instead of raising (`_speed_knots`, `match.py:40-42`) |
| S2 | `SAR_MATCHED_AIS` | `SAR_MATCHED_AIS` (composite 0.707 → 0.662) | `length_m` drives the size term — 0.8 default → 0.5 (`_hull_length_m`, `match.py:84`) |
| S6 | `SAR_MATCHED_AIS` | `SAR_MATCHED_AIS` (composite 0.857 → 0.707) | GFW absent `cog` no longer reads as a real course of 0.0 (`gfw.py:91`) |
| **S7** | **`SAR_MATCHED_AIS`** | **`SAR_UNMATCHED`** | GFW absent `cog` no longer reads as a real course of 0.0 (`gfw.py:91`) |
| S8 | *(no outcome — `TypeError`)* | `SAR_MATCHED_AIS` | `cog` absent now scores zero on heading instead of raising (`match.py:306`) |

**S7 is the notable one, and it is the only classification that moves.** At the `08:00` stamp the
GFW vessel sits 900 m from `C7` at `dt = 720 s`, so spatial `= 1 − 900/1200 = 0.25` and temporal
`= 1 − 720/900 = 0.20`. Composite measured now: `0.45 × 0.25 + 0.25 × 0.20 + 0.15 × 0 + 0.15 ×
0.8 = 0.283` — **0.117 short** of `MIN_SCORE`. With the fabricated zeros restored, measured
composite `0.433`, which is **0.033 above** threshold, and the scenario classifies
`SAR_MATCHED_AIS`. The 0.150 heading weight moved this vessel across the acceptance line in one
step.

This is the shape of the whole exercise: the same correction that costs S6 score costs S7 its
association, because S7 sat within one heading weight of `MIN_SCORE`. S7 still reports
`closestRejected` with the shortfall, so an analyst can see a near miss rather than an empty
search.

Unchanged, and pinned as unchanged: **S3** (the control), **S4** and **S5** (windowing). Their
`PINNED` reasons are the empty string, and
`test_every_changed_scenario_names_its_correction` asserts they carry none — a control that moved
must fail the suite rather than acquire a post-hoc justification.

### UNEXPECTED CHANGES

**Zero.** No scenario changed for a reason that cannot be attributed to a named evidence-field
correction.

"Unexpected" is defined precisely: *an outcome difference not attributable to a named correction in
the PINNED table*. The suite enforces both directions of that definition —
`test_every_pinned_scenario_is_justified_by_a_named_field_correction` fails if a changed scenario
names no correction, and `test_every_changed_scenario_names_its_correction` fails if an unchanged
control carries one. `test_the_pinned_classification_and_score_are_held` runs every scenario
against its pin, and `test_every_scenario_has_a_pinned_outcome` fails if a scenario is added
without one.

Two supporting measurements: `test_the_fixture_is_deterministic` requires two `run_combined` calls
over the same rows to agree exactly on every `cls` and `aisConf`, so none of the pins rest on a
non-reproducible run; and the weight vector was recomputed independently for every scenario with a
decomposition — stored composite vs `0.45·spatial + 0.25·temporal + 0.15·heading + 0.15·size`,
residuals `+0.000250, −0.000500, +0.000250, +0.000150, −0.000500, +0.000150` for S1, S2, S3, S5,
S6, S8. All within the 5e-4 rounding tolerance of the three-decimal stored composite, which is the
direct evidence that no weight moved.

## 6. The size-term arithmetic

DF-X9.3 §6 asks this explicitly, so it is pinned as a test
(`test_the_artefact_size_drop_is_arithmetic_and_not_a_bug`) as well as written here.

```
apparent length   = round(major × resolution_m) = round(12.0 × 10.0) = 120 m

60 m hull:  size = max(0, 1 − |120 − 60| / max(60, 50))
                = 1 − 60 / 60
                = 0.0

240 m hull: size = max(0, 1 − |120 − 240| / max(240, 50))
                = 1 − 120 / 240
                = 0.5

weight    = 0.15
Δ (60 m)  = 0.15 × (0.0 − 0.8) = −0.120
```

Measured against the real code: S5's hull is 60 m, its `sizeScore` is `0.0`, and stripping
`length_m` from those same rows restores `0.8` and a composite of 0.895 against the measured
0.775 — a delta of **−0.120000**, to six places.

**A score decreasing is not a bug.** Before the fix the term was a constant: `ob.get("length", 0)`
returned 0 on every real archive row, the `> 0` guard skipped, and `size` sat at 0.8 for every
vessel regardless of what it was. A term that cannot move cannot lower anything, so the pre-fix
0.8 was not a measurement of agreement — it was the absence of one. Now that the term reads the
hull, a hull that disagrees with the detection's apparent length is correctly penalised, and
`−0.120` is the correct size of that penalty.

The weights are unchanged. `match.py:256` still declares `(0.45, 0.25, 0.15, 0.15)`; the
recomputation in §5 confirms every stored composite against that vector within rounding. If a
different figure had appeared, the weights would have moved — which is why the test asserts
`−0.12` at `abs=1e-9` rather than asserting a range.

## 7. Nullable-field semantics

**The rule: absent is zero MOTION, never zero SPEED, and never zero COURSE.**

Without a speed there is no distance to project; without a course there is no direction to project
along. Substituting `0.0` knots would assert a vessel measured stationary, and substituting
`0.0` degrees would assert it was heading north. Both are measurements nobody made, and
`propagate`'s stated purpose is to be the authority on where a vessel probably was
(`geodesy.py:44-47`).

Measured consequences:

- `propagate(1.0, 103.0, None, 90.0, 120.0)` → `projectedDistanceMeters == 0.0`, coordinates
  unchanged. `_speed_knots` returns `0.0` for kinematics and `propagate`'s retained `< 0.1` guard
  declines; the helper never claims the vessel measured zero.
- `propagate(1.0, 103.0, 10.0, None, 120.0)` → `projectedDistanceMeters == 0.0`. A reported speed
  with no course still does not move.
- `dynamic_radius(1200.0, 900.0, None, 2800.0)` → `1200.0`. Absence must not *widen* the search
  either: a vessel whose speed was not reported has not licensed extra drift. Measured identically
  for `0.0` knots (`dynamic_radius(1200.0, 900.0, 0.0, 2800.0)` → `1200.0`), which is why the
  absent-speed case cannot be told from a genuinely stationary one by radius alone — and must not
  need to be.
- An unreadable value is not absence: `_speed_knots` **raises** `ValueError` on a non-finite `sog`
  (`match.py:44-45`) rather than reading it as 0.0, because a NaN reaching the score would
  propagate into every candidate.

**Why `0` is preserved as a measurement.** `0.0` is a legal, common and *informative* value: a
vessel at anchor, a course of 0.0 meaning due north. Collapsing `0` into absence would destroy
real observations, and a vessel at anchor genuinely is not dead-reckoning — so the `< 0.1` guard
reaching the same numerical result by a different route is correct, not redundant. `models.py:40`
states it directly: *"`None` means not reported — NOT zero."* The fixture's `offset_m` and `_drift`
helpers are flagged design-time only, and every number this document quotes is measured by running
the real code rather than read back from them — a fixture that asserts its own expected values
would be asserting its own arithmetic.

## 8. Size-field semantics

**Canonical first, then the legacy spelling.** `_hull_length_m` (`match.py:84`) iterates
`("length_m", "length")`. `AisObservation` and the Parquet schema name the field `length_m`
(`models.py:53`, `archive.py:36`); the golden fixture and the correlation-input shape call it
`length`. Canonical-first rather than either-or, so a row carrying both cannot pick the wrong one
by dict ordering. Measured: `_hull_length_m({'length_m': 240.0, 'length': 999.0})` → `240.0`.

Both spellings are read rather than one, so that the golden run's parity is unchanged: a fixture
that says `length` and an archive that says `length_m` are the same vessel, and picking one
arbitrarily would silently move the score for whichever spelling was missed.

**Zero reads as absent.** Measured: `_hull_length_m({'length_m': 0.0})` → `None`, not `0.0`
(`match.py:92`, guarded on `value > 0`); `{'length_m': 240.0}` → `240.0`. A 0 m hull would make
the `hull_length > 0` guard skip — which is the defect, not the fix. Reading it as absent routes
to the documented 0.8 default, which is what "no measurement" means everywhere else in this
document. A non-numeric value is also skipped rather than raised, so one malformed row cannot take
the stage down. `test_a_zero_length_is_read_as_absent_not_as_a_zero_metre_vessel` pins it.

## 9. Provider missing-data semantics

**GFW publishes none of SOG, COG or heading, so the store contains none of them.** All three are
`None` (`gfw.py:88-92`). Measured: all five MMSI 257000005 rows read back from Parquet with
`sog=None, cog=None, heading=None`, and `source='gfw'`.

The generalisation is the rule `models.py` states: three different states — reported, not
reported, unparseable — were once all stored as `0.0`, and a `0.0` speed participates in
correlation arithmetic as though observed. The fixture builds vessel 257000005 through the
product's **own** `normalize_gfw_event`, so the stored kinematics are whatever that code decides,
not whatever the fixture asserts; the assertion is only that they survive Parquet as `None`.

Positions still move, and that is the point: measured, MMSI 257000005's `lat` differs between its
first and last observation while `sog` is `None` throughout. The fixture drifts the positions at
4 kn while reporting no speed, because an AIS track can move without the row carrying a speed, and
a scorer that reads absence as stationary would be wrong about this vessel.

## 10. Measured zero vs absent

This is the single most important distinction in the artifact, and the easiest thing to break.

**`cog = 0.0` is a real course due north. `cog = None` is the absence of a course.** They are
different claims. Conflating them is precisely what made DEFECT 4 invisible: a vessel reporting
nothing looked identical to a vessel reporting "due north", so it earned a free heading match
against every north-oriented hull.

The fixture holds the pair apart with two vessels and proves it by measurement:

| | MMSI | `cog` | hull axis | measured `headingScore` |
|---|---|---|---|---|
| **S3** | 257000003 | `0.0` — a **real** course | 0° (north) | **`1.0`** |
| **S8** | 257000006 | `None` — **absent** | 45° | **`0.0`** |

S3 is the pure control: same north orientation, same hull geometry, and it MUST score 1.0. If it
ever reads 0.0, measured zeros have been swallowed by the absence handling, which would mean the
fix for DEFECT 4 disabled a real measurement. S3 also still propagates — a real speed and a real
course must keep dead reckoning, or the fix has disabled the mechanism entirely
(`test_the_control_vessel_still_propagates`). Vessels 257000003 and 257000006 are otherwise
deliberately stripped — no length, no name — so the size and naming terms are identical and the
heading term is the only thing under test.

The negative direction is pinned too: S8's hull axis is 45°, so a *reported* 45° course would have
scored 0.5. That is what makes S8's `0.0` an assertion about absence rather than a coincidence of
geometry. 257000005 (GFW) carries the same lesson at source level: it has no course at all, and it
must not inherit the north match that 257000003 legitimately earns.

## 11. The empty-deployment case

Kept as a separate evidence class, because it is a real product state and it proves something
different from correlation correctness.

**SAR detections still exist without AIS.** Measured: 8 components, 0 AIS rows →
**8 targets, all `SAR_UNMATCHED`**, `ais_only == []`, every `corr["matched"] is False`, every
`corr["mmsi"] is None`, every `predictedLat` / `predictedLon` is `None`. Tags on each:
`['SAR_UNMATCHED', 'AIS_UNASSOCIATED']`.

This is worth stating as a correction to a first draft of the suite. It originally asserted
`targets == []`, and the failure was the correct outcome: a SAR detection is an observation in its
own right. An empty AIS archive means "no vessels to associate", not "no targets". Asserting an
empty list would have required deleting real detections whenever the AIS feed was absent, turning
a data-availability problem into an evidence-destroying one
(`test_correlate_over_no_observations_returns_no_target_without_raising`).

- **No contacts manufactured.** `ais_only == []` measured. An empty archive is an empty answer,
  not an invitation to fill it (`test_an_empty_archive_manufactures_no_contacts`).
- **No predicted position claimed.** Nothing was propagated, so nothing may claim to have been.
  Measured `evidence.association.predicted_position is None` and `mmsi is None`.
- **The product says so in words, not just by omission.** Measured `uncertainty.propagation_note`:
  *"No AIS position was propagated for this target: it carries no association, so no dead
  reckoning was performed. No gyro/IMU correction available."* On an associated target (S1) it
  reads *"AIS position propagated to acquisition time by dead reckoning; no gyro/IMU correction
  available."* Both branches say something different, or the note is decoration
  (`test_the_note_differs_between_an_associated_and_an_unassociated_target`).

What this class does **not** prove: correlation correctness. It proves no crashes and truthful
absence semantics. A green empty-archive test must not be read as evidence about the scoring path
— that is what this fixture exists to provide.

## 12. Known limitations

1. **Six vessels is not a dataset.** 27 rows, 8 components, one acquisition instant. This is
   enough to pin semantics and nothing more. It says nothing about frequency, accuracy, or
   behaviour under real traffic density.
2. **It is not operational data, and cannot become so.** §1. The numbers here are not evidence
   about any real vessel, and no figure in §3 may be quoted as a performance result.
3. **`correlate` is exercised directly, not through the full HTTP scan pipeline.** `run_scenario`
   and `run_combined` call `correlate` itself. `pipeline.py:369` (archive query) and
   `pipeline.py:380` (correlate) are cited as the production shape, but this artifact does not
   execute a scan, does not pass a bbox, and does not traverse geolocation, polarisation, or the
   route handlers. A defect in any of those stages would not appear here.
4. **The real deployment archive is empty, so this fixture is currently the ONLY coverage of the
   AIS scoring path.** Every number in this document is synthetic by necessity. The moment real
   AIS rows exist, they supersede this document as the analytical base and the pins here become a
   regression guard rather than a measurement.
5. **S7 sits close to `MIN_SCORE`.** Measured shortfall 0.117; pre-fix it cleared the threshold by
   0.033. It is the scenario whose classification is most sensitive to a threshold recalibration
   and to any future change to the heading term's weight. A reviewer should expect it to move
   first, and should treat that movement as unremarkable unless a correction is named for it.
6. **The component geometry is synthetic.** Every component shares `COMPONENT_BASE` — `major` 12,
   `minor` 5, `area` 9, `maxDb` 6, `clutterMeanDb` −8 — chosen to make the `SAR_MATCHED_AIS`
   branch reachable and to isolate individual score terms, not to resemble a real detection.
   Apparent length 120 m against real hulls of 60 m and 240 m is an arithmetic convenience: it is
   what makes the size term read 0.0 and 0.5 in the same fixture. No conclusion about size-term
   calibration follows from it.
7. **S8 cannot by itself prove DEFECT 3 is fixed.** Its hull is 100 m, so
   `1 − |120 − 100| / max(100, 50) = 0.8` — coincidentally identical to the pinned default, measured
   identical (`sizeScore 0.8`). DEFECT 3 is proved by S2 (0.5) and S5 (0.0) and by the mutation
   guard, never by S8. Recorded here because a future reader checking S8 alone would see nothing.
8. **Scenarios pin one stamp where the effect needs one.** S4–S8 select a single cadence stamp;
   S1–S3 see all five. That is deliberate — it isolates a single `dt` and therefore one score term,
   rather than averaging over five — but it means the per-scenario table is not a description of
   what the product would do with the full track. The production-shaped `run_combined` leg is the
   one that describes the whole scene: 8 components → 8 targets, 6 matched, 2 unmatched, `ais_only`
   empty.
9. **`component_position` is required, and every component here supplies it.** The
   `DetectionNotGeolocatedError` path (`match.py:153`) and the finite-coordinate guard
   (`match.py:198`) are not exercised by this fixture.
10. **`rotation of the map from numbers to meaning is out of scope.** This document records what the
    scorer computes. It does not evaluate whether 1200 m is the right base radius, whether
    `0.45/0.25/0.15/0.15` is the right weighting, or whether `MIN_SCORE 0.40` is well placed. Those
    constants were inherited unchanged and are deliberately pinned rather than tuned here.

---

## Method and reproduction

Every figure in this document was produced by executing the fixture against the real archive and
the real `correlate`, then dumping `cls`, `corr["matched"]`, `corr["mmsi"]`, `corr["vesselName"]`,
`corr["candidatesConsidered"]`, `corr["closestRejected"]` and the full
`corr["scoreDecomposition"]` for all eight scenarios, plus `run_combined`'s target count. The
harness was throwaway; the durable reproduction is the suite itself, which pins all of it:

```
cd backend
& ".venv\Scripts\python.exe" -m pytest tests/test_ais_correlation_baseline.py -q --no-header -p no:cacheprovider
```

Gate state at the time of writing — 2026-10-06:

```
ruff    All checks passed!
mypy    Success: no issues found in 75 source files
pytest  50 passed
```

Counterfactual figures in §4 and §5 (the "zeros restored" and "`length_m` stripped" columns) were
produced by re-running the identical component and the identical rows with only the corrected field
mutated, so the delta is attributable to that correction and nothing else. Each mutation leg is also
a test: `test_the_size_term_responds_to_the_real_hull_length`,
`test_the_artefact_size_drop_is_arithmetic_and_not_a_bug`, and
`test_the_fixture_is_deterministic`.