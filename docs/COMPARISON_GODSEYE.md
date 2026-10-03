# DarkFleet vs God's Eye View — feature-by-feature audit

Compiled from two sources, both verified rather than assumed:

- **God's Eye View (GEV):** its own `README.md` at `github.com/bilawalsidhu/gods-eye-view`
  (fetched 2026-10-03), plus `DATA_SOURCES.md` and `SECURITY.md` as referenced there.
  GEV publishes 19 layers, 17 with a keyless path.
- **DarkFleet:** this repository at `d3428ec`, verified by running the gates and by
  four rounds of browser automation against real Chrome at 1920×1080 and 1440×900.

Where a row says DarkFleet is absent, it was checked by grep, not inferred.

---

## 0. The headline, stated honestly

**GEV wins the feature-count comparison, and it is not close.** It ships 19 live
layers, voice control, an AI agent, photorealistic 3D cities, cinematic scene
capture, URL share links and an MCP server. DarkFleet ships **one** sensor domain
(SAR), one correlation engine, and no voice, no AI, no 3D tiles, no sharing —
confirmed by grep returning 0 for `SpeechRecognition`, `openai`, `3DTiles`,
`shareUrl`.

**But the comparison is not like-for-like, and pretending otherwise would flatter
us.** GEV is an *exploratory client for public signals* — a browser for watching the
planet. DarkFleet is an *evidence-oriented correlation engine* that happens to have a
globe. GEV's own README draws the line that decides this audit:

> "premium imagery, **SAR**, and the deeper commercial feeds live behind enterprise
> contracts"

**GEV has no SAR.** Neither does anything else in its layer table. DarkFleet's entire
product rests on SAR. On the one sensor where DarkFleet is specialised, there is no
contest — because they do not have it.

The honest summary: **they win breadth, we win substance.** A fair verdict is that
they are the better *globe* and we are the only *analyser*.

---

## 1. Data layers

| Layer | GEV | DarkFleet | Winner |
|---|---|---|---|
| SAR (Sentinel-1) | ❌ absent — "behind enterprise contracts" | ✅ **only radar source**, 6 rendered layers | **DarkFleet** |
| AIS vessels | ✅ AISStream, live, thousands | ✅ archive delivery + tracks; **NOT_CONFIGURED** in this deployment | **GEV** (live vs archive) |
| Aircraft (live) | ✅ 11,000+, OpenSky/adsb.lol | ❌ absent | **GEV** |
| Military aircraft | ✅ ADS-B, amber layer | ❌ absent | **GEV** |
| Satellites / orbits | ✅ 838 objects, SGP4 + GMST | ❌ absent | **GEV** |
| Earthquakes | ✅ USGS | ❌ absent | **GEV** |
| Active fires | ✅ NASA FIRMS | ❌ absent | **GEV** |
| Weather / wind / radar / lightning | ✅ GFS, ECMWF, nowCOAST | ❌ absent | **GEV** |
| Cyclones | ✅ NHC/CPHC cones | ❌ absent | **GEV** |
| CCTV mesh | ✅ ~3,600 cameras, live video | ❌ absent | **GEV** |
| ALPR cameras | ✅ OSM/DeFlock | ❌ absent | **GEV** |
| Traffic | ✅ simulated on real roads | ❌ absent | **GEV** |
| Transit / bikeshare | ✅ GTFS-RT, GBFS | ❌ absent | **GEV** |
| Radio stations | ✅ analog tuner, 750 | ❌ absent | **GEV** |
| Datacenters / dams / cables | ✅ 4,351 / 704 / 712 bundled | ❌ absent | **GEV** |
| Space missions | ✅ 30-day launches | ❌ absent | **GEV** |
| Reference: EEZ / coastline / ports | ❌ not in layer table | ❌ not implemented | **tie (both absent)** |
| **Layer count** | **19** | **6 raster + 3 analytic + 1 graticule** | **GEV 19–6** |

**Score: GEV 17 – DarkFleet 1 – 1 tie.**

That 1 is the row the entire product exists for.

---

## 2. Globe & rendering

| Capability | GEV | DarkFleet | Winner |
|---|---|---|---|
| Engine | CesiumJS | CesiumJS 1.145 | tie |
| Basemap ladder | Esri → OSM fallback → ion → Google 3D | OSM only | **GEV** |
| Photorealistic 3D cities | ✅ Google Photorealistic 3D Tiles | ❌ | **GEV** |
| Terrain | ✅ world terrain | ❌ (keyless 2D-ish globe) | **GEV** |
| Sensor looks | ✅ **GLSL**: CRT, NVG, FLIR/thermal, Noir, Snow | ❌ | **GEV** |
| Ground alignment for 3D tiles | ✅ aircraft park on aprons | n/a (no tiles) | **GEV** |
| World-stable icon headings | ✅ per-frame screen-space course projection | ❌ icons are static points | **GEV** |
| Motion smoothing / dead reckoning | ✅ interpolates 15–30 s feeds, one interval behind | ❌ (no live streaming) | **GEV** |
| Single Viewer, no recreation | ✅ | ✅ **verified** (engine is idempotent under StrictMode) | tie |
| Camera modes | tilt + North-Up | 5 modes: GLOBAL/THEATER/TOP_DOWN/OBLIQUE/NORTH_UP | **DarkFleet** (5 vs 2) |
| Fly-to target / bbox / reset | ✅ | ✅ **verified in browser** | tie |
| Click-to-select | ✅ anything | ✅ entities (verified) | tie |
| Follow a contact | ✅ cockpit | ❌ `followingMmsi` state exists, not driven | **GEV** |
| Detection overlay (boxes + IDs) | ✅ screen-space | ❌ (points + labels only) | **GEV** |
| Cockpit view | ✅ ride a live contact down | ❌ | **GEV** |
| Trail behind tracked object | ✅ fading trail | ❌ | **GEV** |

---

## 3. Analysis & evidence — the domain that matters

| Capability | GEV | DarkFleet | Winner |
|---|---|---|---|
| **SAR detection** (CFAR) | ❌ | ✅ CA-CFAR, tunable (train/guard/α, speckle, component size) | **DarkFleet** |
| **SAR pipeline visualisation** | ❌ | ✅ raw → normalised → filtered → land mask → CFAR → detection mask | **DarkFleet** |
| **Pixel→geolocation correctness** | ❌ (no SAR) | ✅ window transform → CRS → WGS84, pixel-centre, axis-order, **mutation-checked** | **DarkFleet** |
| **Raster/target alignment regression** | ❌ | ✅ permanent test, 3/3 inside rectangle | **DarkFleet** |
| **AIS↔SAR correlation** | ❌ (side by side only) | ✅ distance + temporal + heading + size → composite | **DarkFleet** |
| **Dynamic match radius** | ❌ | ✅ propagates with Δt and spacing | **DarkFleet** |
| **Score decomposition** | ❌ | ✅ all five terms exposed | **DarkFleet** |
| **Geolocation uncertainty** | ❌ | ✅ half-pixel budget; `null` when unsupported | **DarkFleet** |
| **Evidence discipline** (OBSERVED / HYPOTHESES / UNKNOWNS) | ❌ | ✅ enforced structurally | **DarkFleet** |
| **Neutral classification schema** | ❌ | ✅ `DarkFleet-Neutral-v1`, `UNRESOLVED` deliberately muted | **DarkFleet** |
| Multi-pass track hypotheses | ✅ trace backfill (ADS-B only) | ✅ `/tracks` (SAR+AIS, single pass here) | tie |
| Revisit / acquisition planning | ❌ | ✅ `/revisit`, gaps over nominal cycle | **DarkFleet** |
| Detector abstraction | ❌ | ✅ `/detectors` | **DarkFleet** |
| Temporal patterns | ❌ | ✅ `/patterns` | **DarkFleet** |

**Score: DarkFleet 13 – GEV 0.**

GEV's own words place it outside this: *"an exploratory visualization… not a
hardened production service."* It does not claim to analyse, and it does not.

---

## 4. Truthfulness & engineering quality

This is the category where the products differ in kind, not degree.

| Property | GEV | DarkFleet | Winner |
|---|---|---|---|
| Simulated data labelled | ✅ "Traffic… **simulated** vehicles", "individual positions are **not live observations**" | ✅ n/a — nothing simulated | tie |
| Estimated data labelled | ✅ CCTV poses "estimated priors **you calibrate**", launches `RECONSTRUCTED ESTIMATE` | ✅ raster window reports when a percentile stretch was **degenerate** | tie |
| Disclaims fitness | ✅ explicit "do not use for navigation or operational purposes" | ✅ same posture, plus `NOT_ESTABLISHED` never rendered as `0` | tie |
| **Missing vs zero** | ⚠️ not addressed as a first-class concern | ✅ `AVAILABLE/PARTIAL/NO_COVERAGE/NOT_CONFIGURED`, count `null` when uncountable | **DarkFleet** |
| **Unknown vs measured zero** | ⚠️ AIS `0.0` semantics not documented | ✅ nullable end-to-end; AIS `511`/`3600` sentinels removed, not clamped | **DarkFleet** |
| Contract enforcement | ⚠️ vanilla JS, no schema layer | ✅ generated OpenAPI→TS contract, `--check` in CI, **runtime validation wired** | **DarkFleet** |
| Backend authority | ⚠️ much logic client-side | ✅ FastAPI is sole authority; FE never computes detections | **DarkFleet** |
| Test discipline | ⚠️ CI badge, unknown depth | ✅ **440 backend + 47 frontend**, ruff/mypy clean | **DarkFleet** |
| Type safety | ⚠️ vanilla JS | ✅ `strict` TS, tsc clean | **DarkFleet** |
| Dead-module audit | n/a | ✅ 29/29 modules reachable, **0 disconnected** | **DarkFleet** |
| No control without behaviour | ⚠️ some toggles optimistic | ✅ audited; unavailable layers disabled **with the reason** | **DarkFleet** |
| Credential handling | ✅ server-side proxy, SSRF caps, sanitised errors, rate limits | ✅ backend-only, redacted, never sent to browser | tie |
| Licence | MIT | (repo licence) | — |

**Score: DarkFleet 9 – GEV 0 – 3 tie.**

---

## 5. Interaction, AI & reach

| Capability | GEV | DarkFleet | Winner |
|---|---|---|---|
| Voice control | ✅ OpenAI Realtime, **29 tools** | ❌ **0** | **GEV** |
| AI scene understanding | ✅ viewport screenshots, entity Q&A, cinematic framing | ❌ **0** | **GEV** |
| AI HUD summary | ✅ terse 5-word readout, regenerates | ❌ | **GEV** |
| Hands-free console ops | ✅ "switch to NVG, turn on flights" | ❌ | **GEV** |
| MCP server (Claude/Codex) | ✅ | ❌ | **GEV** |
| Voice/mouse **drawing** (area, line, pin) | ✅ persistent | ❌ | **GEV** |
| Distance measurement | ✅ spoken, arrow + distance | ❌ | **GEV** |
| Routing + fly-the-route | ✅ OSRM draped, banked turns | ❌ | **GEV** |
| Search | ✅ keyless coords + bundled places + 3 fallbacks | ✅ unified (coords/target/MMSI/scene/AOI) | tie |
| Share links | ✅ camera+style+layers+target in a URL | ❌ **0** | **GEV** |
| Scene director / cinematic capture | ✅ exportable scene bundles | ❌ | **GEV** |
| Import/export scenes | ✅ files + bundles | ❌ | **GEV** |
| Shareable reports | ✅ | ✅ 5 formats (geojson/kml/json/png/pdf) | tie |
| Keyboard shortcuts | ✅ 6 (`1`–`7`, H, D, C, `` ` ``, Esc) | ✅ 7 (`/`, N, P, H, L, ?, Esc) | tie |
| Hands-off install | ✅ Pinokio one-click, 1.86 s cold start | ❌ `npm run dev` + backend | **GEV** |
| Community | ✅ #1 GitHub Trending, 25M+ socials, Product Hunt | ❌ none | **GEV** |
| Cost to first result | ✅ $0, no signup, 17/19 layers keyless | ✅ $0, but 2 services to run | **GEV** |

**Score: GEV 13 – DarkFleet 0 – 3 tie.**

---

## 6. Product surface

| | GEV | DarkFleet |
|---|---|---|
| Workspaces / modes | 1 globe + panel groups + first-run missions | 8 workspaces (TACTICAL, SEARCH, INTEL, TASKING, LAYERS, ANALYTICS, REPORTS, SYSTEM) |
| Missions | ✅ scripted "field missions" | ⚠️ ScanWorkflow is the mission; **no persistence** |
| Watchlists | ❌ | ❌ **both absent** |
| Alerts | ❌ | ❌ **both absent** |
| Annotations (persistent) | ✅ voice + mouse, persists | ⚠️ notes textarea is **session-only by design** |
| Watch areas / monitoring | ❌ | ❌ **both absent** |
| Responsive | ✅ desktop-first | ⚠️ verified 1920 & 1440 only |

---

## 7. What we have that they don't

1. **Any SAR at all.** Their single largest acknowledged gap. Six rendered layers, real CA-CFAR, tunable detector.
2. **A geolocation chain proven correct** — 24 mutation-checked tests, window-transform discipline, axis-order guards, permanent alignment regression. GEV has no pixels to geolocate.
3. **SAR↔AIS correlation as analysis** — five-term score decomposition, dynamic radius, association confidence. GEV puts ships and planes in the same view; it does not reason about the relationship.
4. **Evidence epistemics** — OBSERVED / HYPOTHESES / UNKNOWNS as structure, and `UNRESOLVED` drawn muted.
5. **Coverage as a first-class answer** — `NO_COVERAGE` never renders as `0 vessels`.
6. **Nullable unknowns** — no fabricated zeroes in delivered AIS.
7. **A contract-enforced boundary** — generated types + runtime validation + FastAPI as sole authority.
8. **Five view modes** vs their two.
9. **Honest degenerate-data reporting** — the raster basis string states when a stretch was not a percentile measurement.

## 8. What they have that we don't

1. **19 live layers** vs our 1 sensor domain. Aircraft, satellites, fires, quakes, weather, cyclones, cameras, transit, traffic, radio, cables.
2. **Voice control + AI agent** (29 tools). Zero on our side.
3. **Photorealistic 3D cities + world terrain.**
4. **GLSL sensor looks** — NVG/FLIR/CRT.
5. **Cockpit view** and follow-a-contact.
6. **Persistent annotations, drawing tools, measurement, routing.**
7. **Share links, scene export, cinematic director, MCP server.**
8. **CCTV mesh with live video** and viewshed gizmos.
9. **World-stable icon orientation** and motion interpolation across sparse feeds.
10. **One-click install and 1.86 s cold start.**
11. **Community, traction, and a contributor funnel.**
12. **Simulation and scale theatre** — thousands of moving entities at once.

## 9. Scorecard

| Category | GEV | DarkFleet |
|---|---|---|
| Data layers | **17** | 1 |
| Globe & rendering | **11** | 1 (tie) |
| Analysis & evidence | 0 | **13** |
| Truthfulness & engineering | 0 | **9** (3 tie) |
| Interaction, AI, reach | **13** | 0 (3 tie) |
| **Total** | **41** | **24** |

**They lead 41–24 on capability count.** We lead 22–0 in the two categories that
decide whether a product may be trusted with an operational claim.

---

## 10. What is worth taking from them

Honest engineering, not feature envy:

| Take | Why it is worth it |
|---|---|
| **Icon orientation** — project each entity's true heading into screen space | Our points don't indicate course at all. A vessel's heading is measured data we already have. |
| **Motion smoothing across sparse feeds** | Our AIS archive is discrete fixes. Rendering them as a smooth track with the *observed* path still solid is honest and far more readable. |
| **Basemap ladder with automatic fallback** | Our globe hard-depends on OSM. A fallback chain is robustness, not cosmetics. |
| **On-demand keys panel** | A credential should be addable in-app, not an env var hunt. |
| **Cold-start budget** | 1.86 s is a published, measured target. We have none. |
| **MCP / share links** | Cheap, and they turn a tool into something collaborative. |

## 11. What we must refuse

- **Simulation as a layer.** GEV labels its traffic as simulated and that is the right call — but for DarkFleet it would put invented entities next to measured ones. Our isolation guard exists precisely for this.
- **Spy-thriller aesthetics as a product goal.** They say it themselves: *"the aesthetics are obviously having a little bit of fun."* We are evidence software.
- **"Military" theatre without the analysis.** An amber military-flight layer with no correlation is a mood, not a capability.
- **AI that answers about targets.** GEV's agent is honest about a scene. An LLM summarising a maritime contact invites exactly the intent inference this product refuses to make. If we ever add AI, it must not speak about what a vessel is doing.

---

## 12. Verdict

**On features: they win, 41–24.** They are a more complete, more beautiful, more
reachable product today, and no amount of re-scoping changes that this session.

**On the thing that matters, we are alone.** GEV states in its own README that SAR
is behind enterprise contracts. DarkFleet's entire analytical chain — pixel
centroid → window transform → CRS → WGS84 → correlation → evidence — exists because
that chain has to be *correct*, not merely present. Their own positioning
("exploratory", "not a hardened production service") is an honest description of a
different product, and it is not a criticism of either.

The strategic read is not "catch up on layers". It is: **our SAR and evidence
chain is the asset; their interaction craft and reach are the lessons.** Catch up on
the four takes in §10 — they are days of work. Do not chase 19 layers; a maritime
analyser with 19 irrelevant layers is worse than one with the right six.

**Final: they win the product comparison. We win the domain.**