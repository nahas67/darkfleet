# DF-X0 — RE-AUDIT: authoritative state at `88c28bd`

Measured, not inherited. Source, runtime and browser evidence override any
document, including the checkpoint reports written earlier in this project.

## 1. Gate baseline (measured)

| Gate | Before this checkpoint | Now |
|---|---|---|
| Backend `pytest` | 440 | **457** |
| Frontend `vitest` | 47 | **55** |
| `ruff` | clean | clean |
| `mypy` | clean, 53 files | clean, **54 files** |
| OpenAPI → TS contract | current, 374 lines | current, **392 lines** |
| `tsc --noEmit` | clean | clean |
| Production build | clean | clean |
| Production modules | 29 reachable / 0 disconnected | **31 reachable / 0 disconnected** |

## 2. Route surface (measured, 21 routes)

```
/scans                                    POST   start a real scan
/scans/{id}                               GET    job state + stage history
/scans/{id}/events                        GET    SSE stage stream
/scans/{id}/targets                       GET    detections + AIS-only
/scans/{id}/raster                        GET    raster layer index
/scans/{id}/raster/{layer}                GET    rectangle + CRS + transform + report
/scans/{id}/raster/{layer}/image          GET    server-rendered PNG
/scans/{id}/ais                           GET    observations in the scan window
/scans/{id}/export/{fmt}                  GET    json | geojson | kml | png | pdf
/scenes                                   GET    Sentinel-1 catalogue (requires bbox)
/targets/{id}                             GET    evidence slice
/targets/{id}/ais-observations            GET    observations for the associated MMSI
/targets/{id}/summary                     GET    evidence + validated narrative
/vessels/{mmsi}/track                     GET    observed track
/ais/coverage                             GET    coverage truth
/evidence/{id}                            GET    full evidence document
/providers/health                         GET    live probes
/revisit                                  GET    acquisition planning
/tracks                                   GET    multi-pass hypotheses
/patterns                                 GET    temporal patterns
/detectors                                GET    detector interface
/debug/{id}/{layer}                       GET    pipeline inspection
```

## 3. The finding that mattered

**`SAR_UNMATCHED` existed in the backend. "Ghost Vessel" appeared ZERO times in
the frontend.**

Measured by grep, not inferred:

```
backend/darkfleet/correlation/match.py   "SAR_UNMATCHED"  present
src/**.tsx                               "ghost"          0 matches
```

The product's central concept — a radar contact AIS does not confidently explain
— had no reachable surface. `SAR_UNMATCHED` is a correlation outcome; an operator
must already know the domain to read it. The mission statement names Ghost Vessels
as the centrepiece, and it was not built.

Second finding, in the same area: the correlation recorded **that** nothing
cleared the threshold but kept no record of **why**. "No association was accepted"
was unfalsifiable — a reader could not distinguish an empty search from a near
miss.

## 4. Corrective work landed in this checkpoint

| Fix | Detail |
|---|---|
| Closest rejected candidate | `candidatesConsidered`, `acceptanceThreshold`, `closestRejected` (score, separation, Δt, shortfall) on every target |
| Ghost Vessel module | `backend/darkfleet/ghost_vessel.py` — single authority for designation, warning, hypotheses, unknowns |
| Evidence blocks | OBSERVED / HYPOTHESES / UNKNOWNS as structure, rendering even when empty |
| Ghost Vessel panel | `src/intelligence/GhostVesselPanel.tsx`, wired as a GHOST tab |
| Semantics gates | 17 backend + 8 frontend tests over the emitted and rendered strings |
| Contract | `RejectedCandidate` emitted; three new fields on `AisAssociation` |
| §51 compliance | removed a document that named another product |

A design defect was found and fixed while writing this: `assess()` accepted
`wake_detected` as an argument while the target row already carried `wake`,
letting a caller assert a wake the detector never flagged. The record is now
authoritative.

## 5. Layer truthfulness pass

Found by auditing the layer console: **toggles that changed state and drew
nothing** — the defect this brief calls a correctness defect.

| Layer | Before | Now |
|---|---|---|
| GRATICULE | declared, no renderer | real (`GridImageryProvider`) |
| SCENE FOOTPRINT | declared, no renderer | real, from the MEASURED raster extent |
| AIS CONTACTS | declared, no renderer | real, from delivered state |
| AIS TRACKS / AIS PREDICTED | declared, no renderer | real, solid vs visually distinct |
| LAND MASK | enabled, no renderer | disabled **with the reason** |
| CFAR THRESHOLD | enabled, no renderer | disabled **with the reason** |

## 6. Regression externally introduced

`52c4c36` (not authored in this session) deleted `start.bat`, the one-click
Windows launcher that brought up the API + web stack and opened the app. There is
currently **no equivalent** — no `.bat`, `.cmd`, `.ps1` or `.sh` launcher exists.

This is a real loss against §46 ("local execution must remain first-class") and
§60.1 ("an operator can start the local system"). The README documents the manual
two-step (`uv run … python -m darkfleet`, then `npm run dev`), which works, but a
double-clickable launcher is the difference between a local desktop product and a
developer setup. **Flagged, not yet restored** — see Remaining Blockers.

## 7. Verified-correct work, preserved

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

## 8. Remaining, honestly

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
| Advanced backend surfaced in UI | wake, polarization, multipass, revisit exist in the backend but have no operator surface |
| MCP server | absent |
| AI analyst | absent (correctly — the backend has a validated narrative path to build on) |
| Command palette | absent |
| Performance budgets | not measured |
| Security audit (§48) | not performed in this session |
| 1280×720 / 1024×768 render | not verified (only 1920 and 1440) |
| Local launcher | removed externally, not restored |

## 9. Frozen execution order

The plan in `docs/MASTER_EXECUTION_PLAN.md` is superseded by this measured state.
Next, in dependency order:

1. **DF-X1** spatial platform refactor — split the globe into viewer / camera /
   map-source / layer / selection / contact / temporal controllers
2. **DF-X2** command shell rebuild around the globe, migrating every capability
3. **DF-X3** map source ladder + camera system
4. **DF-X4** professional AIS rendering — heading-aware glyphs, screen-space
   orientation, label arbitration
5. **DF-X5** Ghost Vessel workspace deepened — evidence, wake, polarization,
   rejected-candidate walkthrough
6. **DF-X6** SAR workspace + CFAR lab
7. **DF-X7** advanced intelligence surfaced — wake, polarization, multipass, revisit
8. **DF-X8** maritime context
9. **DF-X9** annotations + measurement
10. **DF-X10** missions → **DF-X11** watchlists + alerts → **DF-X12** saved views
11. **DF-X13** reporting → **DF-X14** MCP → **DF-X15** AI analyst
12. **DF-X16** performance → **DF-X17** security + local packaging

GFST (Ghost Vessel) has been executed early and out of order, deliberately: it is
the product's centrepiece and it was entirely absent.