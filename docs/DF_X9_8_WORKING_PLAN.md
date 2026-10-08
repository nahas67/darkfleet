# DF-X9.8 — Final AIS System Closure: working plan and checkpoint record

Created 2026-10-08. This file is the checkpoint record for DF-X9.8. Every status below is
tied to the evidence class that produced it. Nothing here is marked complete on the strength
of a unit test alone.

Evidence classes used throughout:

| Class | Meaning |
|---|---|
| `MEASURED` | A number produced by running the real thing, recorded with method |
| `BROWSER PROVEN` | Observed in a real browser against a HEAD-pinned build |
| `UNIT PROVEN` | Behaviour asserted in the test suite, product reachability NOT implied |
| `INTEGRATION PROVEN` | Exercised through the real backend/API/store path |
| `NOT RUN` | Not executed. Never to be reported as a pass |
| `DEFERRED` | Deliberately out of scope for this checkpoint |
| `EXTERNALLY BLOCKED` | Cannot be resolved here |

---

## 0. Why this checkpoint exists

DF-X9.6 and DF-X9.7 closed, but §4 of the DF-X9.8 brief requires the previous performance
claims to be **reconciled rather than accepted**. That reconciliation found two large product
defects that the previous checkpoint's evidence could not see, plus one benchmark artefact.

---

## X9.8A — Authority reconciliation

**STATUS: COMPLETE.**

Independent audit of the AIS scientific authority (`CODE-VERIFIED`), plus a live measurement
that changed the picture.

| Claim | Verdict | Evidence |
|---|---|---|
| Nullable SOG never crashes propagation | VERIFIED | `backend/darkfleet/correlation/geodesy.py:55-57` |
| Nullable COG never crashes orientation/correlation | VERIFIED | `match.py:49-62`, `geodesy.py:55` |
| Missing COG never becomes 0° | VERIFIED | no coercion found; `design/format.ts:58-61` → `NOT_ESTABLISHED` |
| Real `length_m` enters size scoring | VERIFIED, with a defect | `match.py:84`, `match.py:320-323` |
| GFW missing kinematics stay null | VERIFIED | `ais/gfw.py:90-92` |
| Observations immutable | VERIFIED by convention | `ais/models.py:34` is not `frozen=True` |
| Interpolation display-only | VERIFIED | `displayState.ts:605-632`, `trackBuilder.ts:39-47` |
| Prediction distinct from interpolation | VERIFIED | `displayState.ts:824-858`, separate collection `aisRenderer.ts:799-816` |
| Ghost classification backend-authoritative | VERIFIED | `src/ghost_vessel.ts:69-71` is strict equality; `validate.ts:246-252` throws rather than defaults |
| Gaps never invent movement | VERIFIED | `trackBuilder.ts:264-284`, `displayState.ts:945-975` |

### Defects recorded, NOT yet fixed (carried)

These are real and are **not** closed by this checkpoint. They are listed so they cannot be
mistaken for resolved work.

| Severity | Location | Defect |
|---|---|---|
| major | `delivery.py:198-199` | `lat=float(row.get("lat", 0.0))` — an absent position becomes Null Island (0°N, 0°E). Measured: `to_out({...no lat/lon})` → `0.0 0.0` |
| major | `pipeline.py:381` | `float(raster_meta["resolution_m"] or 10.0)` fabricates a 10 m pixel resolution that feeds size scoring **and** operator-facing `lenM`/`lenUncM` |
| major | `match.py:321` | absent `length_m` scores `0.8`, better than a measured disagreement (240 m vs 120 m → `0.5`). Absence outscores evidence |
| major | `ContactList.tsx:73` | `classification: 'AIS_ONLY'` hardcoded by the frontend rather than read from the backend, so a backend-matched vessel can render twice and appear AIS-orphaned |
| major | `client.ts:266-288` | `followScan` launches `loadScanResults` and `loadScanAis` concurrently; if AIS resolves last it replaces the merged list, so the contact set is network-timing dependent |
| minor | `pipeline.py:318`, `routes.py:425` | further fabricated resolutions (1.0 m, 10.0 m) |
| minor | `aisRenderer.ts:569` | a contact that loses orientation keeps its last rotation |

---

## X9.8B — Live performance diagnosis  ← the substantive finding

**STATUS: COMPLETE. This checkpoint found the largest defect in the session.**

### The brief's question

Why did the previous run report 5.7 s scene load, 90.3 ms frames, 3.5 s selection and 2.09 s
pick at 500 contacts, when an isolated 10K CPU benchmark looked fast?

### Finding 1 — the benchmark was real, but the browser numbers were mostly harness

`MEASURED`.

- **90.3 ms / 11 FPS was a software-rasterisation artefact.** The harness launched Chrome with
  `--disable-gpu` on a machine with an RTX 3050. Re-run with a real renderer
  (`ANGLE (AMD, AMD Radeon(TM) Graphics, Direct3D11)`): **median 7.2 ms, p95 9.9 ms, 139 FPS.**
- **3.5 s selection and 2.09 s pick were dominated by harness wall-clock**, which included
  workspace switches, 250 ms poll quantisation and a literal 1.0 s settle sleep inside the
  measurement.

These were measurement defects, and correcting them is part of the result, not a
reinterpretation of it.

### Finding 2 — a request path that re-ingested the whole archive  (ROOT CAUSE)

`MEASURED`, on a 50,000-observation fixture.

`AisArchive.__init__` read **every parquet part in full** and materialised a Python dedup set
for `mmsi|timestamp` — and every API request constructs an `AisArchive`. Read-only endpoints
paid a full-archive ingest to answer a question about file metadata.

| Measurement | Before | After |
|---|---|---|
| `/api/scans/{id}/ais` (13.78 MB) | **121.6 s** | **1.04 s** |
| `/api/ais/coverage` | **>180 s, no answer** | **0.044 s** |
| 3 concurrent coverage requests | 1 timed out at 35 s, 2 at 45 s | all succeed |
| 6 concurrent mixed requests | 2 of 3 timed out | all succeed, 1.0 s wall |
| construction alone | 0.98–4.89 s per call, serialised | O(1) |

Fixed by making the dedup index **lazy** — built on first `append()`, never for reads. The
index exists only for restart-dedup, and `test_archive_roundtrip_dedup_query_restart` proves a
new instance still rejects rows it already holds. That test still passes.

This also explains why 10K live was previously impossible.

### Finding 3 — camera FOLLOW cancelled itself  (two distinct defects)

`BROWSER PROVEN`.

Static reading of the shipped Cesium bundle was checked first and was correct:
`moveStart.raiseEvent` occurs exactly once, inside `View.checkForCameraUpdates`, driven by
`Scene.render` — so it arrives on a **later frame**, not inside `setView`. The product guarded
its own writes with a synchronous flag cleared in `finally`.

Browser evidence before the fix, FOLLOW on a moving contact:

```
camera holding, playback paused   mode=ON   status=TRACKING  (alt 599,329 -> 450,000)
playhead advances, camera moves   mode=OFF  status=OFF
```

Fix 1 — recognise our own echo by comparing the live pose against the poses we wrote, instead
of relying on a synchronous flag.

Fix 2 — hold a **history** of writes, not one slot. Follow can write twice before the first
echo arrives (the anchor moves as the renderer catches up with a seek); a single slot compared
the first write against the second pose and released anyway.

### The test harness was wrong in the same way as the product

`aisCamera.test.ts` raised `moveStart` **synchronously inside `setView`** — an emulation Cesium
does not perform. That is why 82 tests passed while follow was broken. The double now defers to
`flushRender()` and models Cesium's `_cameraStartFired` latch. Each new test was verified to
fail without its fix.

### Finding 4 — product surfaces framed the camera behind the camera owner's back

`BROWSER PROVEN`, found by instrumenting `moveStart` rather than guessing.

One moveStart was recorded whose live camera position was **~1.4 million metres** from anything
follow had written (live magnitude 6.83e6 m vs written 7.58e6 m — exactly the 450,000 m
`engine.flyTo` default). `ContactList`, `UnifiedSearch`, `MissionTimeline`, `useGlobalKeys` and
`ScanWorkflow` all call `engine.flyTo` directly. Those flights raise a `moveStart`
indistinguishable from a drag, so the owner released FOLLOW on the product's own framing — a
violation of the stated single-camera-owner invariant.

Fixed by counting in-flight programmatic flights in the engine (which owns them, retiring each
on its own `moveEnd`, since Cesium's `flyTo` returns void in these typings), exposing that count
through a port method so the layering stays acyclic, and routing AIS contact-list framing
through `aisCamera.frameContact()`.

---

## X9.8C — Measured remediation

**STATUS: COMPLETE.** See X9.8B for before/after. Optimisations were applied only to measured
bottlenecks; nothing was changed for an unmeasured guess except the camera-flight suspension,
which is explicitly labelled below.

---

## X9.8D — 10K live-browser scaling

**STATUS: NOT RUN — and no longer blocked by the archive defect.**

The backend could previously not serve 10K at all (121.6 s, and `coverage` never answered).
That is fixed and re-measured. The **live 10K browser drill is still outstanding** and is the
next action. The previous "10K complete" claim rested on a CPU-only benchmark; it is recorded
here as **superseded**.

---

## X9.8E — Long-run memory

**STATUS: NOT RUN.** A single heap snapshot is not evidence of a leak, and none is offered.

---

## X9.8F — Science and regression

**STATUS: COMPLETE.**

| Gate | Result |
|---|---|
| Raw/analytical delta (27-row fixture) | 2,070 comparisons, **0 differences** |
| Null semantics | `257000001` and GFW `257000005` all kinematics absent = True |
| Deployment delta | AIS rows 0 → **VACUOUS**, stated as such |
| DF-X8 maritime | **UNCHANGED** |
| Frontend | **788 / 788**, 47 files |
| TypeScript | clean |
| Backend | **1127 passed** |
| Ruff | clean |
| Mypy | 17 errors, **identical to baseline** (pre-existing rasterio stub gaps) |
| Contract | current, 2,763 lines |
| Route reachability | 24 / 24 strict |
| Offline egress | **UNDECLARED 0, FORBIDDEN 0**; 10 declared provider attempts |
| Build identity | FRESH at `3cc5b97`, digest `26eb1c6a998d1877`, clean tree |
| Browser E2E | **12 / 12 PASS**, including S58 |

---

## X9.8G — Final closure

**STATUS: NOT REACHED. DF-X9.8 is PARTIAL.**

Closure requires live 10K browser scaling (X9.8D) and long-run memory evidence (X9.8E), neither
of which has been produced. One known defect is also still open — see below.

### Open defect: FOLLOW released by a concurrent product flight

`BROWSER PROVEN`, **NOT FIXED**.

A stricter scenario than the shipped S58 — engaging FOLLOW while a contact-list flight is still
animating — still releases at ~2.1 s with `"Released: the camera was moved."` The shipped
acceptance suite passes; this harder interleaving does not. Three mitigations are in place
(history guard, flight counter, write suspension) and none closes it. Suspending follow writes
during an in-flight animation is kept because writing during one is a camera fight in its own
right, but it is **not** presented as the fix.

Next action: instrument the post-flight `moveStart` (the latch resets on settle, so a
`moveStart` arrives after the flight is retired and carries no pending write) and extend the
own-write attribution to cover the flight's settle tail.

---

## Master backlog — unchanged

WAKE VALIDATION CORPUS · SIDE-BY-SIDE SAR COMPARISON · REAL OPERATIONAL GHOST VESSEL BROWSER
FLOW · ANCHORAGES · NGA WORLD PORT INDEX (EXTERNAL TRUSTED TRANSPORT BLOCKER) · GEBCO
BATHYMETRY · MARITIME 0–360 ANTIMERIDIAN DATA · EEZ PRIMITIVE CACHING · MANUAL MAP-SOURCE UI ·
BASEMAP RECOVERY BROWSER PROOF (browser evidence only) · MISSIONS · WATCHLISTS · ALERTS ·
ANNOTATIONS · MEASUREMENT · SAVED INVESTIGATION STATE · ADVANCED REPORTING · MCP ·
EVIDENCE-GROUNDED AI ANALYST · SECURITY · LOCAL-FIRST DISTRIBUTION · FINAL GLOBAL VERIFICATION

None of these were closed, started, or silently removed by this checkpoint.