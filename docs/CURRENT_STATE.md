# DF-X0 — RE-AUDIT: authoritative state at `f88a054`

Measured, not inherited. Source, runtime and browser evidence override any
document, including the checkpoint reports written earlier in this project.

## 1. Gate baseline (measured)

| Gate | Session start | Now |
|---|---|---|
| Backend `pytest` | 440 | **472** |
| Frontend `vitest` | 47 | **63** |
| `ruff` | clean | clean |
| `mypy` | clean, 53 files | clean, **55 files** |
| OpenAPI → TS contract | current, 374 lines | current, **1377 lines** |
| `tsc --noEmit` | clean | clean |
| Production build | clean | clean |
| Production modules | 29 reachable / 0 disconnected | **33 reachable / 0 disconnected** |
| Backend routes: `CALLER_REACHABLE` | **not measured** | **17 of 23** |
| Backend routes: `PRODUCT_REACHABLE` | **did not exist** | **17 of 23** |

The contract more than doubled, and none of the growth is new API surface: it is
`<SCHEMA>_FIELDS` arrays emitted for every object schema, so `validate.ts` reads
the generated key set instead of keeping a hand-maintained copy of it. That copy
had drifted and was rejecting every real `/targets` response while the contract it
claimed to enforce sat three hundred lines above it declaring the field.

## 2. Route surface (22 routes, measured)

Reachable from the product:

```
POST /scans                                start a real scan
GET  /scans/{id}/events                    SSE stage stream
GET  /scans/{id}/targets                   detections + AIS-only
GET  /scans/{id}/raster/{layer}            rectangle + CRS + transform + report
GET  /scans/{id}/raster/{layer}/image      server-rendered PNG
GET  /scans/{id}/ais                       observations in the scan window
GET  /scans/{id}/export/{fmt}              json | geojson | kml | png | pdf
GET  /scenes                               Sentinel-1 catalogue (requires bbox)
GET  /targets/{id}                         evidence slice
GET  /vessels/{mmsi}/track                 observed track
GET  /providers/health                     live probes
GET  /revisit                              acquisition planning
GET  /tracks                               multi-pass hypotheses
GET  /patterns                             temporal patterns
GET  /detectors                            detector registry
```

Implemented, verified, and **unreachable** — the defect class this audit exists
to find (`backend/tools/route_reachability.py`):

```
GET  /scans/{id}/raster        layer index; the per-layer endpoint is used
GET  /scans/{id}               scan state; the SSE stream covers it in practice
GET  /evidence/{id}            full evidence document; /targets/{id} is used
GET  /debug/{id}/{layer}       pipeline inspection -- §15/§16 need this
GET  /targets/{id}/summary     validated narrative -- §37 needs this
GET  /ais/coverage             coverage truth; reached via /scans/{id}/ais
GET  /targets/{id}/ais-observations   reached via /vessels/{mmsi}/track
```

## 3. The two findings that mattered

**`SAR_UNMATCHED` existed in the backend. "Ghost Vessel" appeared ZERO times in
the frontend.**

Measured by grep, not inferred:

```
backend/darkfleet/correlation/match.py   "SAR_UNMATCHED"  present
src/**.tsx                               "ghost"          0 matches
```

The product's central concept — a radar contact AIS does not confidently explain
— had no reachable surface. `SAR_UNMATCHED` is a correlation outcome; an operator
must already know the domain to read it.

Second: the correlation recorded **that** nothing cleared the threshold but kept
no record of **why**. "No association was accepted" was unfalsifiable — a reader
could not distinguish an empty search from a near miss.

Third, found later: **nine routes had no frontend caller at all**, including
revisit planning, multi-pass hypotheses, longitudinal patterns and detector
provenance. Four of the nine had no surface because they answered with a bare
`dict[str, Any]` — no `response_model` means no OpenAPI schema, which means no
generated TypeScript, which means the only way to render them would have been a
hand-written mirror of the payload.

## 4. Corrective work landed

| Fix | Detail |
|---|---|
| Closest rejected candidate | `candidatesConsidered`, `acceptanceThreshold`, `closestRejected` (score, separation, Δt, shortfall) on every target |
| Ghost Vessel module | `backend/darkfleet/ghost_vessel.py` — single authority for designation, warning, hypotheses, unknowns |
| Evidence blocks | OBSERVED / HYPOTHESES / UNKNOWNS as structure, rendering even when empty |
| Ghost Vessel panel | `src/intelligence/GhostVesselPanel.tsx`, wired as a GHOST tab |
| Semantics gates | 17 backend + 8 frontend tests over the emitted and rendered strings |
| Response models | `backend/darkfleet/api/advanced.py` — revisit / tracks / patterns / detectors now in the contract |
| ADVANCED workspace | 4 tabs, 4-state delivery (idle / loading / ready / failed) |
| Route reachability gate | `backend/tools/route_reachability.py` + 15 self-tests |
| `/revisit` validation | stopped bypassing `response_model` by hand-building a `Response` |
| §51 compliance | removed a document that named another product |

Two design defects found while writing it: `assess()` accepted `wake_detected`
as an argument while the target row already carried `wake`, letting a caller
assert a wake the detector never flagged; and the tab strip used `.df-tabs` /
`.df-tab`, which do not exist in the design system, so four labels rendered as
one unseparated run of text. Neither was visible to the type checker. The second
was only caught by looking at a screenshot.

## 5. Layer truthfulness pass

Found by auditing the layer console: **toggles that changed state and drew
nothing** — a correctness defect by this brief's own definition.

| Layer | Before | Now |
|---|---|---|
| GRATICULE | declared, no renderer | real (`GridImageryProvider`) |
| SCENE FOOTPRINT | declared, no renderer | real, from the MEASURED raster extent |
| AIS CONTACTS | declared, no renderer | real, from delivered state |
| AIS TRACKS / AIS PREDICTED | declared, no renderer | real, solid vs visually distinct |
| LAND MASK | enabled, no renderer | disabled **with the reason** |
| CFAR THRESHOLD | enabled, no renderer | disabled **with the reason** |

## 6. Browser-verified behaviour (real Chrome, live fixture backend)

The ADVANCED workspace was driven through every tab against the running API.

```
DETECTOR   weights digest -> "none -- deterministic"
           The null digest renders as the fact it is. Displaying it as
           "missing" would invent a provenance gap on a detector that has no
           learned weights by design.

MULTIPASS  "No track hypotheses from 15 observation(s) across 5 stored scan(s)."
PATTERNS   "No patterns from 15 observation(s) across 5 stored scan(s)."
           The counts are what separate "nothing to link" from "nothing
           examined".

REVISIT    planned against the real planetary-computer catalogue; 1 acquisition
           found (SENTINEL-1A), and therefore:

             MEDIAN REVISIT    not established
             SHORTEST GAP      not established
             LONGEST GAP       not established
             LIMITATIONS       "A single acquisition in the window: no revisit
                               interval can be measured from one pass, and none
                               is assumed."

           One acquisition does not produce a revisit interval. The panel says
           "not established" rather than 0 days, because 0 would assert the water
           is imaged continuously.

INVALID    an inverted bbox is refused with the button disabled and the reason
           stated, not planned against.
```

The top strip reading `SAR UNAVAILABLE` / `AIS NOT_CONFIGURED` is the honest
state of a local install with no provider credentials, not a rendering fault.

## 7. Regression externally introduced

`52c4c36` (not authored in this session) deleted `start.bat`, the one-click
Windows launcher that brought up the API + web stack and opened the app. There is
currently **no equivalent** — no `.bat`, `.cmd`, `.ps1` or `.sh` launcher exists.

This is a real loss against §46 ("local execution must remain first-class") and
§60.1 ("an operator can start the local system"). The README documents the manual
two-step, which works, but a double-clickable launcher is the difference between a
local desktop product and a developer setup. **Flagged, not yet restored.**

## 8. Verified-correct work, preserved

| Property | Evidence |
|---|---|
| GEO-CORR geolocation chain | 24 mutation-checked tests; `always_xy`, half-pixel and precision mutations each fail the suite |
| Raster/target alignment | permanent regression; 3/3 detections inside the rendered rectangle |
| Correlation parity | golden fixture + abort-gated migration |
| Nullable AIS measurements | unreported stays `null`; AIS 511/3600 sentinels removed not clamped |
| UTC determinism | DuckDB session timezone pinned; a `+05:30` read of a `12:00Z` row is fixed |
| Coverage semantics | `AVAILABLE/PARTIAL/NO_COVERAGE/NOT_CONFIGURED`, count `null` when uncountable |
| Backend authority | FastAPI decides detections, classification, correlation, Ghost Vessel status |
| No demo mode | `RuntimeMode` is a one-member enum by design |

## 9. Remaining, honestly

Not built. Each would be its own checkpoint.

| Area | State |
|---|---|
| Persistent missions | absent — no model, no endpoints |
| Watchlists | absent |
| Alert engine | absent |
| Persistent annotations | absent (session-only textarea, honestly labelled) |
| Drawing + measurement | absent (AOI is text entry) |
| Maritime context layers | absent (EEZ, coastline, ports, bathymetry) |
| Map source ladder | OSM only, no fallback |
| Photorealistic 3D | absent |
| Wake / polarisation surfaces | in the backend, no operator surface |
| AI analyst narrative (`/targets/{id}/summary`) | backend validated path exists, no surface |
| SAR / CFAR lab (`/debug/{id}/{layer}`) | backend exists, no surface |
| MCP server | absent |
| Command palette | absent |
| Camera system | partial (framing + view modes; no FOLLOW_VESSEL / ORBIT_TARGET) |
| Performance budgets | not measured |
| Security audit (§48) | not performed |
| 1280×720 / 1024×768 render | not verified (1920 and 1440 only) |
| Local launcher | removed externally, not restored |

## 10. Frozen execution order

`docs/MASTER_EXECUTION_PLAN.md` is superseded by this measured state. Next, in
dependency order:

1. **DF-X6** SAR workspace + CFAR lab over `/debug/{id}/{layer}` — backend exists
2. **DF-X7b** wake / polarisation surfaces, and the validated narrative over
   `/targets/{id}/summary`
3. **DF-X1** spatial platform refactor — split the globe into viewer / camera /
   map-source / layer / selection / contact / temporal controllers
4. **DF-X3** map source ladder + camera system (FOLLOW_VESSEL, ORBIT_TARGET)
5. **DF-X4** professional AIS rendering — heading-aware glyphs, screen-space
   orientation, label arbitration
6. **DF-X8** maritime context · **DF-X9** annotations + measurement
7. **DF-X10** missions → **DF-X11** watchlists + alerts → **DF-X12** saved views
8. **DF-X13** reporting → **DF-X14** MCP → **DF-X15** AI analyst
9. **DF-X16** performance → **DF-X17** security + local packaging

GFST (Ghost Vessel) was executed early and out of order, deliberately: it is the
product's centrepiece and it was entirely absent. DF-X7a likewise preceded the
platform refactor because four verified capabilities were unreachable, and an
unreachable capability is a worse defect than an unrefactored module.