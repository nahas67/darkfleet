# DarkFleet Limitations

What this tool does not do, and where its output should not be trusted. Written
alongside the code, not after it.

## The central limitation

**An unmatched SAR return is not evidence of wrongdoing.** It means no AIS
association met the correlation threshold in the available observations.
Legitimate explanations are common and frequent:

- Vessels exempt from AIS carriage (small craft, fishing under 300 GT)
- Reception shadow — satellite AIS or terrestrial receiver geometry
- Receiver or antenna fault
- A stale archive that simply lacks the relevant window

DarkFleet deliberately does not convert missing data into accusations. It
reports the observation, the candidates considered, the score decomposition, and
the uncertainty. Interpretation is the analyst's, and the unknowns are listed as
explicitly as the observations.

## Detection limits

- **Detections are radar returns, not confirmed vessels.** Sea clutter,
  coastlines, fixed structures, and partial wakes all produce returns.
- **Apparent length is not vessel length.** It is the extent of the detected
  return with an uncertainty band. A ship at an unfavourable aspect may be much
  longer, or a structure much larger, than the reported footprint.
- **Speckle filtering trades sensitivity for false positives.** Small vessels
  near the detection threshold can be suppressed. Filtering effects are measured
  on controlled fixtures, not assumed.
- **CA-CFAR assumes a locally stationary clutter background.** Wind fronts,
  current lines, and rain cells violate that assumption and raise the false
  alarm rate locally.
- **The threshold is a multiplier, not a calibrated Pfa.** It reproduces the
  verified reference implementation. It is not a statistical false-alarm-rate
  guarantee.
- **Sentinel-1 is a wide-swath, moderate-resolution sensor.** It resolves larger
  vessels reliably; very small craft are near the detection limit and results for
  them should be treated as indicative only.

## Spatial limitations

- **Position accuracy is bounded by the product, not by our processing.** A
  georeferencing bug would place a detection on the wrong vessel, so the
  georeferencing chain is a hard correctness gate with dedicated tests in both
  WGS84 and UTM.
- **The coastline buffer is a proxy.** It excludes coastal water to suppress
  land-clutter false alarms, which also removes genuinely navigable water near
  shore. Port exceptions carve selected areas back out; the rest is a real
  limitation of the approach.
- **The land mask is a 10 m classification, not a bathymetric chart.** Its own
  stated accuracy is roughly 77%. Fine coastal structures may be misclassified.
- **Inland water bodies classified as water are still excluded** from the
  detection mask, so analysis is restricted to genuinely marine areas.

## AIS limitations

- **A live AIS feed is not a historical archive.** Correlating a past satellite
  overpass requires observations from that time. The local Parquet archive
  builds that history forward from when collection starts; it cannot recover
  history that was never recorded.
- **Historical AIS coverage depends on the configured source.** Where no
  historical provider is available, historical correlation is genuinely blocked
  and reported as `AUTH_REQUIRED` or `NO_COVERAGE` rather than estimated.
- **Dead reckoning drifts.** Propagation uses constant SOG/COG with no gyro,
  current, or weather correction. Predicted positions carry an explicit
  uncertainty note; large Δt values degrade the prediction meaningfully.
- **AIS can be absent for many reasons**, listed above. Its absence is not
  evidence of presence for any particular purpose.

## Correlation limitations

- **Greedy association is not optimal matching.** A globally optimal assignment
  could resolve cases greedy matching leaves unresolved. Near-ties are reported
  as `UNRESOLVED` rather than guessed.
- **The size score needs reported dimensions.** AIS often omits length and
  width; that component is then absent rather than invented.
- **Heading comparison depends on wake evidence.** Without a detected wake, the
  hull axis has a 180° ambiguity and the comparison is undirected.

## Provider limitations

- Provider availability, throttling, and policy change without notice. The
  health endpoint probes live; treat a stale reading as stale.
- Planetary Computer currently serves Sentinel-1 RTC anonymously, but its
  documentation states an account is required for SAS tokens. If that changes,
  REAL access becomes credential-gated and must be reported honestly.
- Copernicus Data Space Ecosystem's public STAC catalogue does not currently
  publish Sentinel-1; CDSE is not a usable anonymous Sentinel-1 source.
- EarthSearch serves Sentinel-1 GRD whose measurement assets are GCP-referenced
  rather than affine-georeferenced, requiring a warp path.

## Coverage limitations

- **SAR revisit is a property of the provider's catalogue, not of the sky.**
  `GET /api/revisit` (GEO-002) measures the acquisitions that exist for an area,
  so it is honest about what was captured and never predicts a pass from an orbit.
  A long median interval means the catalogue holds nothing between two passes; it
  does not mean the satellite could not have looked.
- **The plan is bounded by the queried window.** Intervals are computed only
  inside it, and a gap at the window edge is reported as an edge rather than as a
  coverage hole. The window is returned with the statistics for that reason.
- **No geoid undulation grid ships with this project.** Every height-related
  value is therefore reported on the WGS84 ellipsoid and explicitly labelled *not*
  height above sea level (GEO-003). A conversion is refused rather than performed
  with an assumed N = 0, because the sign of N flips across the world and a wrong
  sign is worse than no answer.
- **DarkFleet reports no vessel altitude at all.** SAR measures a
  two-dimensional backscatter image. `altitude_measured: false` appears in every
  target's evidence record so no consumer infers a height from an apparent
  footprint.
- **Two named marine regions are absent.** Luzon Strait and Drake Passage are
  sliver-only in the upstream Natural Earth source and were dropped by its own
  curation. An unresolved lookup says so rather than returning nothing (GEO-001).

## What is not implemented yet

Stated plainly rather than implied:

- Multi-pass track hypothesis association
- True image-based wake analysis (direction, length, heading consistency)
- Multi-polarization feature fusion
- Machine-learning detector (the interface exists; no validated model is shipped)
- Longitudinal temporal-pattern analysis
- PNG and PDF evidence exports

> **Correction, 2026-10-02.** Five of the six items above have since shipped:
> multi-pass track hypotheses (`/api/tracks`, ADV-001..003), image-based wake
> analysis (`sar/wake.py`, ADV-004/005, still 🟡 — angular recovery is ±10° and
> confidence is bounded evidence strength, not a probability), multi-polarization
> features (`/api/detectors` registry + `polarization.py`, ADV-006, with single-pol
> acquisitions reporting `NOT_AVAILABLE` rather than an imputed ratio), temporal
> patterns (`/api/patterns`, ADV-009/010), and PNG/PDF exports
> (`GET /api/scans/{id}/export/{fmt}`, EXP-004/005). Only the validated ML detector
> remains genuinely unshipped, and `MASTER_FEATURE_PARITY.md` is the row-level
> record of status. The list is left visible because it was true at the time and
> because it is a useful picture of how much of this was aspiration.

## Appropriate use

DarkFleet is an evidence and prioritisation aid. It reduces a large SAR scene to
a ranked, explainable set of observations. It does not identify vessels, assign
nationality, determine intent, or support legal conclusions on its own.

Every result should be read with its provenance, its uncertainty, and its
unknowns — which is why those are first-class outputs rather than footnotes.
---

## OPEN DEFECT (DF-X9.4S, measured in a browser): the shell requires a public font CDN

### What was measured

Section O blocked all public network and counted attempts rather than asserting failure. On a plain
load of the strict production build (stamped `4dc55cd`, digest `c25ccb88`), against **zero**
permitted public hosts:

```
fonts.googleapis.com        x 1
fonts.gstatic.com           x 4
tile.openstreetmap.org      x 99
                            ----
                            104 external attempts
```

Everything else passed underneath it: app boots, archived scan loads, Ghost Vessel fixture loads,
AIS playback works, seek works, coastline, EEZ, HIGH_SEAS and maritime context all work, and
GhostSemantics renders. The functional product is intact. What is not intact is the claim that this
deploys without egress.

### The two findings are NOT the same finding

**1. `index.html:55-60` requires Google Fonts, unguarded.**

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed...&display=swap" rel="stylesheet" />
```

Three font families load from a public CDN at shell load, with no `local()` source and no
`font-family` fallback declared for them. On an air-gapped deployment the typography silently
degrades to whatever the OS substitutes while every panel, label and numeric readout still renders
and still looks like it is working.

This is a real defect and it is **not** declared intentional anywhere. It is also not a
correctness risk -- nothing depends on those metrics -- so it is a fidelity defect, which is why it
is recorded rather than treated as a blocker.

**2. `tile.openstreetmap.org` egress is INTENTIONAL.**

`src/globe/mapSources.ts:46` names OpenStreetMap "the required keyless fallback", and
`MapSourceController` implements an explicit fallback policy whose first documented bug was "one
tile server down left a blank world, with no fallback and no message".

So the section O expectation of **zero** external attempts is **unsatisfiable by design** against
this product. It encodes an assumption -- that a basemap needs no egress -- which the basemap
source layer explicitly contradicts.

### The honest statement of the offline requirement

Not "0 external attempts". It is:

> Every ATTEMPT is DECLARED. A source that cannot be reached is reported as `NOT_CONFIGURED` or
> `ALL_SOURCES_EXHAUSTED` in the SOURCE panel, and the fallback chain is exercised rather than
> assumed.

That is what `MapSourceController` is built to do. Proving it in a browser is
**BROWSER BASEMAP-RECOVERY PROOF**, which is on the deferred list and is NOT closed by section O.
Section O measured the attempt count and reported it; it did not establish that the failure is
*visible*, and this record does not claim it is.

### Not fixed here, and why

The font link is a three-line change plus a decision about which weights to self-host, and self-hosting
three families is a binary-asset decision with a visual consequence that cannot be verified in a
headless run. Guessing at it would be a change I could not honestly report as verified. The OSM
egress is intentional and must not be "fixed" by deleting the keyless fallback.

### Correction — DF-X9.4T (2026-10-07)

The font dependency above **has been removed**, not self-hosted: `index.html` no longer requests
Google Fonts; `src/design/tokens.css`, `tokens.ts`, and canvas labels use local/system font stacks.
A regression test failed when the old Google Fonts link was temporarily reintroduced. The browser
census on clean build `f0431f0` found **zero** Google Fonts requests while all public network was
blocked at the CDP Fetch layer. Four-width font/layout screenshots accompany that run; the top
provider status needed a narrower mission ID to keep `UNAVAILABLE` from splitting across lines
at 1024px. That correction is included in the next clean build.

The new acceptance rule is **zero UNDECLARED or FORBIDDEN egress**, not zero external requests.
`mapSourceEgress.ts` classifies attempts by the URL template in the registered map source and its
configuration state, not by hostname alone. With public network blocked, the browser attempted
OSM tiles **5** times and Esri fallback tiles **5** times (both `DECLARED_PROVIDER`, purpose
`BASEMAP`), then stopped: 10 attempts by 10 seconds, 10 at 20 seconds, 10 at 30 seconds and 10
at 35 seconds. `SYSTEM` reported `data-df-basemap="none"` with the visible notice
"No configured basemap source could be constructed. The globe will render without imagery."
This is the acceptable air-gapped state, not a successful basemap. The SYSTEM panel also names
failed OSM and Esri providers individually as `UNAVAILABLE`, using the controller's own attempted
source IDs; its aggregate notice alone did not name them. Local scan, AIS playback and seek,
GhostSemantics, coastline, EEZ, HIGH_SEAS and maritime context continued to work. Full basemap
**recovery after connectivity returns** remains deferred; this test proved exhaustion, not recovery.

**HIGH_SEAS correction (independent DF-X9.4T review).** The first blocked-network browser run
above established that the local high-seas endpoint returned a polygon, the control toggled ON
and Marine Regions attribution appeared. It did **not** establish that the globe drew it. Review
found the loader put the polygon into `lines` while forwarding `polygons: []` to
`engine.setZoneBoundaries`. The renderer built **zero** high-seas entities despite the healthy-
looking UI. The loader now forwards the original multipart polygon to the engine's existing
outline-only renderer (transparent fill), preserving separate parts rather than drawing straight
links across disconnected seas. SYSTEM now exposes counts of actually built coastline, EEZ and
HIGH_SEAS entities separately from source health and toggle state. A browser measurement must
confirm each is nonzero before the offline layer row may be called closed. Attribution alone is
not evidence of drawing.

The deployment baseline's previously unexplained third field is **Windows FILETIME ticks** (100ns
since 1601-01-01 UTC). Its value `639266744270954823` converts exactly to
`(ticks - 621355968000000000) × 100 = 1791077627095482300` Unix nanoseconds, which equals
`data/validation/.gitignore`'s measured `st_mtime_ns` byte-for-byte. It was not an unknown hash or
an extra file. The file set/size and empty deployment AIS directory are unchanged.

### Completion — DF-X9.6 (2026-10-08)

DF-X9.6 is fully closed.
- **AIS Click-Selection:** Real Cesium `scene.pick` decodes tagged primitives (`AIS_CONTACT`, `AIS_OBSERVATION`, `AIS_TRACK`, `AIS_PREDICTION`) through `decodeAisPick`. `mmsiOf` retained as untagged billboard fallback. Empty ocean clicks clear AIS selection without disturbing the selected SAR target.
- **Observation Marker Picking (S53):** Live browser proof physically clicked 7px observation markers on the Cesium canvas via deterministic `projectCoordinates`. Verified exact MMSI and timestamp, raw kinematic readout, null-field semantics (`not established`, never zero), marker highlighting, SAR target preservation, re-pick across observations, and contact-level pivot on glyph clicks.
- **Camera Follow & Frame:** `AisCameraController` provides single-owner camera follow, one-shot `FRAME CONTACT`, and wrap-aware `FRAME TRACK`. Manual user gestures (wheel zoom, drag) release follow to `OFF` without camera fight or snap-back. Follow state machine correctly handles playback, pause, seek, gaps (`HOLD_GAP`), and after-last positions (`HOLD_FINAL`).
- **Cleanliness:** Zero listener/timer leaks, 0 orphan Chrome processes, verified exact HEAD build freshness.