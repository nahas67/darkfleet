# OLD UI FEATURE SALVAGE

Feature inventory of the retired DarkFleet frontend, captured before deletion.

**This document preserves BEHAVIOUR, not architecture.** No visual structure,
component tree, or CSS from the old UI is carried forward. The new product is
built from scratch; this file exists so that nothing an operator could actually
do is silently lost, and so that a reviewer can check the new build against a
concrete list rather than against a memory.

- Old UI retired at commits `60c8d7c` (GEO-CORR) → GREEN-1 deletion.
- Baseline at deletion: 427 backend tests, 415 frontend tests, ruff/mypy/tsc/build clean.

## 1. Retention decision key

| Keep | Meaning |
|---|---|
| **REIMPLEMENT** | Behaviour is valuable and must exist in the new product |
| **REPLACE** | A better capability supersedes it; recorded so nothing is lost |
| **DROP+JUSTIFY** | Deliberately removed, with a correctness reason |

---

## 2. Behaviour inventory

### 2.1 Shell, navigation, focus

| Old behaviour | Keep | New implementation location |
|---|---|---|
| One full-screen globe, chrome floating above it | REIMPLEMENT | `command/` shell — globe is the primary surface, never a background |
| Single open workspace at a time (opening one closes another) | REIMPLEMENT | `state/shell.ts` — `activeWorkspace` is a single value |
| Focus moves into an opened workspace | REIMPLEMENT | `command/CommandShell.tsx` — with a real focus trap and focus restore (the old one had neither) |
| `Escape` closes the open workspace, bound globally | REIMPLEMENT | `command/useGlobalKeys.ts` |
| UTC clock, 1 Hz, injectable `now` for tests | REIMPLEMENT | `command/TopStrip.tsx` |
| Cesium attribution never hidden | REIMPLEMENT | `design/` — attribution is styled, never suppressed |
| Settings gear in top strip | REPLACE | `command/TopStrip.tsx` → SYSTEM workspace |
| No global shortcuts beyond `Escape` | REPLACE | Search, layers, next/prev target, reset camera are now bound (§61) |

### 2.2 Scan lifecycle and stage streaming

| Old behaviour | Keep | New implementation location |
|---|---|---|
| `POST /api/scans` with `{bbox, scene_id?}`, no `runtime_mode` | REIMPLEMENT | `api/client.ts` → `missions/` |
| Hand-rolled SSE decoder over `fetch` + `ReadableStream` (not `EventSource`) — handles CRLF, multi-line `data:`, `:` keep-alives | REIMPLEMENT | `api/sse.ts` — the backend's stream framing requires it |
| Stage history as an ordered log; unknown stage strings surfaced verbatim, never coerced | REIMPLEMENT | `state/scan.ts` |
| Stage **counter** ("stage 9 of 15"), never a percentage or ETA | REIMPLEMENT | `command/MissionTimeline.tsx` |
| Connection state `IDLE/CONNECTING/STREAMING/CLOSED/ERROR` shown literally | REIMPLEMENT | `command/TopStrip.tsx` |
| Stream released on terminal stage; `AbortController` on disconnect | REIMPLEMENT | `api/sse.ts` |
| Stream failure never invents data; last real stage retained | REIMPLEMENT | `state/scan.ts` |
| Contract violation throws loudly and is **not** treated as "no data yet" | REPLACE | `api/validate.ts` + an **error boundary** — the old app had no boundary, so a drift blanked everything |
| Globe draws nothing unless `runtime_mode=REAL && synthetic=false` | REIMPLEMENT | `globe/engine.ts` — hard precondition |
| "Clear active scan reference" clears the id but keeps globe marks | DROP+JUSTIFY | Ambiguous and surprising. The new model clears marks with the reference, because stale marks over a new AOI are a correctness hazard |

### 2.3 AOI / extent entry

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Text bbox input, validated, `aria-invalid` on error | REPLACE | Rectangle/polygon draw on the globe is primary; text entry retained as a fallback in `command/` |
| Scene catalogue seeds the extent (never a hardcoded default) | REIMPLEMENT | `scenes/SceneBrowser.tsx` → AOI |
| Drag-to-select AOI on a 2-D plot (`minDragPixels=4`, click emits nothing) | REPLACE | `globe/aoI.ts` — real map rubber-band, keeping the "a click must not zero the AOI" rule |
| The drag callback was **unwired** — the emitted bbox went nowhere | REIMPLEMENT | `state/aoi.ts`, actually connected |

### 2.4 Layers

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Grouped layer toggles with `aria-pressed` | REIMPLEMENT | `sensors/LayerConsole.tsx` |
| Per-layer opacity slider, clamped, `n/a` where unsupported | REPLACE | Opacity sliders are retained AND now actually reach Cesium — the old `setOpacity` was an explicit no-op, so all 10 sliders were inert |
| Advanced layers hard-disabled with a stated reason | REIMPLEMENT | `sensors/LayerConsole.tsx` — unavailable is disabled + truthful reason |
| Reducer-level capability gate (no-op unless `AVAILABLE`) | REPLACE | `state/layers.ts` — capability is derived from provider health, not a separate flag |
| Visibility actually reaches Cesium | REIMPLEMENT | `globe/engine.ts` |
| 11 declared layers but only 5 implemented | DROP+JUSTIFY | The new console lists only layers that render. A declared-but-absent layer is removed from the list rather than shown as a broken toggle |

### 2.5 Globe (infrastructure — preserved, not rebuilt from nothing)

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Single Cesium Viewer, all chrome disabled, no Ion token required (OSM fallback) | PRESERVE | `globe/cesiumViewer.ts` — unchanged |
| Layer registry with idempotent `disposeAll` and leak-count assertions | PRESERVE | `globe/registry.ts` |
| `validatedPosition` rejects non-finite, \|lat\|>90, \|lon\|>180 **and (0,0)** | PRESERVE | Carried into the new engine verbatim — the unset sentinel sits in the Gulf of Guinea and looks real |
| Uncertainty radius drawn only when a measured radius exists | PRESERVE | `globe/engine.ts` |
| Correlation link drawn only when both ends are placeable | PRESERVE | `globe/engine.ts` |
| AIS dedup by MMSI; matched drawn more opaquely than unmatched | PRESERVE | `globe/engine.ts` |
| `UNRESOLVED` deliberately muted — "a bright mark would overstate what is known" | PRESERVE | `design/symbology.ts` |
| Confidence → alpha; low confidence drawn **faint, not hidden** | PRESERVE | `design/symbology.ts` |
| `disableDepthTestDistance: Infinity` so marks behind headlands stay findable | PRESERVE | `globe/engine.ts` |
| Detection label is the target id and nothing else | PRESERVE | No vessel identity is asserted on the globe |
| `window.__darkfleetViewer` debug handle, destroyed on unmount | PRESERVE | Debug-only; product goes through the engine |

### 2.6 Contacts

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Two tabs (SAR targets / AIS contacts) over one payload | REPLACE | `contacts/` — one contact list, SAR + AIS distinguished by symbology, not a mode switch |
| 9 sortable columns; `null` sorts last in **both** directions | REIMPLEMENT | `contacts/ContactList.tsx` |
| Sort affordance without colour (`aria-sort` + glyph) | REIMPLEMENT | `contacts/ContactList.tsx` |
| Classification filters combine as UNION | REIMPLEMENT | `contacts/ContactList.tsx` |
| Free-text search over id / MMSI / name | REPLACE | Unified `search/` covers this plus coordinates, scenes, missions |
| Row activation selects target or MMSI | REIMPLEMENT | `contacts/ContactList.tsx` |
| Selection announced via `sr-only` "(selected)" | REIMPLEMENT | `contacts/ContactList.tsx` |
| 4 distinct empty states (no scan / no detections / filters match nothing / never a placeholder row) | REIMPLEMENT | `contacts/ContactList.tsx` — extended with a **coverage** state (§57) |
| Selecting a row highlighted the table but **never moved the globe** | REPLACE | Bidirectional selection is mandatory now: globe ↔ list ↔ intel ↔ timeline |

### 2.7 Timeline

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Three event kinds: SAR acquisition, AIS observation, projected position | REPLACE | `timeline/` — extended with associations, alerts, notes, mission events |
| **No playback, ever** — no timer, no autoplay | REIMPLEMENT | Kept as a hard rule. A timeline that animates implies data that does not exist |
| Scrub over real instants only, clamped | REIMPLEMENT | `timeline/MissionTimeline.tsx` |
| Single-acquisition state says so instead of showing a dead slider | REIMPLEMENT | `timeline/MissionTimeline.tsx` |
| Correlation window band spans only observations that exist | REIMPLEMENT | Never spans a guessed window |
| Signed Δt per event | REIMPLEMENT | `timeline/MissionTimeline.tsx` |
| Unassociated targets yield **no** AIS events | REIMPLEMENT | Kept exactly |

### 2.8 Target evidence

| Old behaviour | Keep | New implementation location |
|---|---|---|
| OBSERVED / HYPOTHESES / UNKNOWNS always separate; empty block still renders | REIMPLEMENT | `evidence/EvidencePanel.tsx` |
| Evidence auto-fetch; explicit `null` = known absent; **failed lookup is an unknown state, never "no data"** | REPLACE | `intelligence/` — distinct `ABSENT` vs `UNKNOWN` vs `ERROR` states |
| Forbidden-term guard (`dark vessel`, `threat`, `no active transponder`, …) asserted absent from markup | REIMPLEMENT | Kept as a **product test**, not just a code comment |
| `not established` for non-finite values, never a zero or dash | REIMPLEMENT | `design/format.ts` — the single formatter |
| AIS tab: candidate MMSI, per-observation rows, predicted position, distance, Δt, radius, 5 score components | REIMPLEMENT | `intelligence/TargetIntel.tsx` |
| SAR chip rendering with strict matrix validation; >4096 cells subsampled **with a caption saying so** | REPLACE | `intelligence/ImageryTab.tsx` — now uses the real raster endpoint |
| Wake / multi-pass reported as explicitly unavailable | REPLACE | Implemented where the backend supports it; otherwise still explicitly unavailable |
| Classification shown as icon + label + colour, never colour alone | REIMPLEMENT | `design/symbology.ts` |

### 2.9 Analysis workbench

| Old behaviour | Keep | New implementation location |
|---|---|---|
| 8 CFAR parameters with ranges, presets, speckle modes | PRESERVE + REIMPLEMENT | `analysis/cfar.ts` (pure, preserved) driven by `analytics/` |
| Preset radio semantics, `role="radiogroup"` | REIMPLEMENT | `analytics/AnalyticsWorkspace.tsx` |
| **Recompute banner listing exactly the changed keys** | REIMPLEMENT | Kept — and now wired, which the old one was not |
| 3 raster colormaps, 3 heatmap palettes, opacity, dB display window | REPLACE | Superseded by real raster layers with honest display-window reporting |
| Non-finite cells rendered as a dim red wash, "never a plausible value" | REPLACE | Server-side renderer now handles non-finite before the cast |
| Graticule with signed hemisphere labels | REIMPLEMENT | `globe/overlays.ts` |
| Nautical-mile scale bar using `111320 × cos(lat)`; **degenerate extent → no bar at all** | REPLACE | `command/NavHud.tsx` — the "no bar rather than a wrong bar" rule is kept |
| dB cursor probe: lat/lon always, dB only for finite in-range cells, never interpolated | REPLACE | Moved onto the real raster |
| Recompute button was **inert** (`onRecompute` never passed) | REIMPLEMENT | `analytics/` — actually posts a scan |
| `toCfarRequestParams` was **never called** | REIMPLEMENT | Now the single path from control to request |

### 2.10 Debug inspection

| Old behaviour | Keep | New implementation location |
|---|---|---|
| 13 debug layers, 8 served / 5 declared-only | REPLACE | `debug/DebugWorkspace.tsx` — served layers only, declared-only shown as unavailable with a reason |
| **Whole section unreachable in the shipped app** (`?debug` never passed) | REPLACE | Now a first-class workspace with a real toggle |
| Alias disclosure (`normalized` is an alias of `raw`) | REIMPLEMENT | Kept — honest labelling of what a layer actually is |
| 5-state layer view model, each with a stated reason | REIMPLEMENT | `debug/DebugWorkspace.tsx` |
| Backend error codes mapped to specific sentences | REPLACE | `api/errors.ts` |
| Stats rendered verbatim, 11 fields, never averaged or inferred | REIMPLEMENT | Kept exactly |

### 2.11 Provider health

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Live probe; failure is an explicit error state, never "online" | REIMPLEMENT | `command/SystemPanel.tsx` |
| Manual re-probe | REIMPLEMENT | `command/SystemPanel.tsx` |
| SAR vs AIS grouping | REPLACE | `sensors/` console, per-source rows |
| **Worst-member severity** — a bucket reports its worst member so one failing provider is never hidden | REIMPLEMENT | Kept. This is a good rule |
| Absent provider list is absent, not an empty panel claiming all were checked | REIMPLEMENT | Kept |
| Unrecognised status degrades to `UNAVAILABLE` preserving the raw string | REIMPLEMENT | Kept |
| Secrets never exposed | REIMPLEMENT | Backend already redacts; product never renders a credential |

### 2.12 Scenes and acquisition planning

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Read-only scene catalogue | REPLACE | `scenes/SceneBrowser.tsx` — selectable, drives the scan workflow |
| `getScenes()` called with **no arguments**; bbox/date/provider filters existed in `SceneQuery` but had no UI | REPLACE | Filters now real and connected |
| Scenes not selectable to drive a scan | REPLACE | `scenes/SceneBrowser.tsx` → AOI → run |
| Revisit plan with median/fastest/slowest/gaps-over-nominal | REPLACE | `analytics/AcquisitionPlanner.tsx` |
| `null` median renders "insufficient data", never 0 | REIMPLEMENT | Kept |
| Zero-acquisition messaging: "**that is not evidence the area is never covered**" | REIMPLEMENT | Kept verbatim in spirit. This is exactly §57 |
| Backend `limitations[]` rendered under "What this does not say" | REPLACE | `docs/DATA_SOURCE_REGISTRY.md` + per-panel limitation lines |

### 2.13 Exports

| Old behaviour | Keep | New implementation location |
|---|---|---|
| 5 formats as plain links, no client fetch; PNG/PDF rendered server-side | REIMPLEMENT | `reports/ReportsWorkspace.tsx` — uses the existing verified renderers, does not duplicate them |
| Gated on an active scan, with a stated reason | REIMPLEMENT | Kept |
| `csv` deliberately absent (backend did not serve it) | REIMPLEMENT | Still absent. A link to a 400 is worse than no link |
| Whole-scan only | REPLACE | `reports/` adds target-scoped export |

### 2.14 Data layer

| Old behaviour | Keep | New implementation location |
|---|---|---|
| `cls` → `classification` normalisation at the data boundary | REIMPLEMENT | `api/normalize.ts` — backend persists `cls`; the contract aliases it |
| Missing number stays `null`; missing class stays `UNRESOLVED` | REIMPLEMENT | Kept |
| `ApiError` with `status` + `code` + `message`; `NETWORK_ERROR`; `EMPTY_RESPONSE` | REPLACE | `api/errors.ts`, extended with a coverage-aware error model |
| Total synchronous contract validation, no schema lib | PRESERVE | `api/validate.ts` |

### 2.15 Accessibility

| Old behaviour | Keep | New implementation location |
|---|---|---|
| Never colour alone | REIMPLEMENT | Global rule; enforced by test |
| `aria-pressed` on every toggle, `aria-sort` on sortable headers | REIMPLEMENT | Carried |
| Full tab semantics with roving tabindex | REIMPLEMENT | Carried |
| Live regions for recompute + empty states | REIMPLEMENT | Carried |
| `data-df-*` test hooks, no `data-testid` | REPLACE | New `data-df-*` namespace, documented |
| **No focus trap** — Tab escaped to the page behind | REPLACE | Real focus trap + focus restore |
| Globe container had no accessible description or fallback text | REPLACE | `globe/` ships an accessible fallback and description |
| `AnalyticsSurface` had a dead `const error = null` branch | DROP+JUSTIFY | Dead branches are removed, not carried |

---

## 3. Net-new work (absent from the old UI)

These had **no** implementation and are not salvage — they are new capability.

1. AIS observation / track **delivery endpoints** (backend had persistence but no API).
2. Camera control: fly-to, presets, follow, next/prev target, reset.
3. Globe click-to-select and selection-driven camera focus.
4. Working layer opacity on the map.
5. Watchlists, missions, alerts, annotations — zero occurrences in the old UI.
6. Distance/area measurement on the globe.
7. Multi-scan history and comparison.
8. AIS track rendering (observed vs propagated vs predicted) — old globe had contact points only.
9. Reference layers (EEZ, maritime boundaries, coastline, ports).
10. A reachable debug workspace.
11. CFAR controls actually wired to a scan request.
12. Real raster imagery on the globe (old app passed no raster data to the workbench).
13. Error boundary.
14. Layer/view state persistence.

## 4. Explicitly NOT carried forward

| Dropped | Reason |
|---|---|
| `?debug=true` URL gate | A capability hidden behind a query string is a capability that does not exist |
| Old CSS tokens, `index.css` | Replaced by a new design system |
| `useApi.ts` as-is | Reusable data shape, but its surface-driven assumptions and normalisers are re-expressed in `api/` |
| `state.ts` shell/surface model | Superseded by the new workspace model |
| `debugLayers.ts` declared-only layers | Listing a layer that cannot be fetched is noise; they are stated as unavailable in `docs/` instead |
| Any fallback/legacy UI path | Forbidden by the brief; verified absent at GREEN-16 |