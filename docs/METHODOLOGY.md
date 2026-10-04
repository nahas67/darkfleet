# DarkFleet Methodology

How a detection becomes evidence. Every claim in the product must be traceable
to one of the stages below, and every stage records what it actually did.

## Pipeline

```text
AOI + time range
      ↓
STAC search                 providers/stac.py
      ↓
Product capability check    AFFINE_GEOREFERENCED | GCP_GEOREFERENCED | UNREFERENCED
      ↓
Asset selection             polarization + product aware
      ↓
Windowed raster read        sar/georef.py — range reads, never a full-scene download
      ↓
Georeferencing              pixel → source CRS → WGS84 (pyproj)
      ↓
Preprocessing              sar/preprocess.py — RTC and GRD take different branches
      ↓
Land/water mask             sar/landmask.py — ESA WorldCover 10 m
      ↓
Speckle filter              sar/speckle.py — none | median | lee
      ↓
CA-CFAR detection           sar/cfar.py
      ↓
Connected components        sar/components.py
      ↓
AIS load                    ais/archive.py — local Parquet archive
      ↓
Temporal alignment          correlation/match.py — dead reckoning to acquisition time
      ↓
Correlation + scoring       geodesic metres, 5-part score decomposition
      ↓
Evidence assembly           evidence.py
```

## Stage notes

**Georeferencing.** SAR assets arrive in different reference frames. `read_window`
converts the requested WGS84 AOI into the raster's *native* CRS before
windowing, then keeps the window transform so every pixel keeps a geographic
identity. An asset with neither an affine transform nor usable ground control
points raises `UNREFERENCED` and stops the scan; we never guess pixel locations.

**Product branches.** Sentinel-1 **RTC** products are already radiometrically
terrain corrected: linear γ⁰ → dB. **GRD** products are not: DN → σ⁰ via the
product calibration lookup table, then thermal-noise removal, then terrain
correction. Treating the two as interchangeable would be a radiometric error,
so the branches are separate functions and the branch used is recorded in
provenance.

**Land mask.** ESA WorldCover v200 at 10 m (class 80 = water), fetched as
per-tile COGs. A configurable coastline buffer dilates the exclusion; port
polygons carve navigable water back out. Mangroves and wetlands count as land —
a vessel cannot be distinguished from canopy there, and the buffer covers that
ambiguity rather than hiding it.

**Speckle.** Median and Lee are the required modes. Lee operates in the linear
power domain, which is the physically correct domain for speckle statistics.
Filtering effects are *measured* on controlled fixtures — target retention,
centroid displacement, apparent-area change, false-positive change, and
background statistics. No claim is made below the sensor's actual resolution.

**Detection.** CA-CFAR estimates local background power from a training ring
that excludes a guard ring, then thresholds in the power domain. Integral
images make this O(pixels) rather than O(pixels × window²).

A deliberate honesty note: the threshold is a plain multiplier, not the
textbook `α = N(P_fa^(-1/N) − 1)`. This preserves behavioural parity with the
verified reference implementation. A Pfa-calibrated variant is future work, not
a silent change.

**Components.** Eight-connected labelling in scan order, so target IDs are
stable across runs. Weighted second central moments give the major/minor axes
and orientation. A 24×24 SAR chip is extracted per target with clutter
statistics for the evidence view.

**Temporal alignment.** A vessel observed by AIS at `t_ais` is propagated to the
SAR acquisition time using SOG and COG. The record keeps the source timestamp,
the acquisition timestamp, Δt, the predicted coordinate, and an explicit
propagation-uncertainty note. Uncertainty is never dropped: an unmatched target
reports an apparent footprint *with* an uncertainty band, never a bare length.

**Correlation.** All distances are WGS84 ellipsoidal geodesic metres — never raw
degree differences. The match radius is dynamic: sensor geolocation uncertainty
plus AIS observation age plus vessel movement plus processing uncertainty. The
radius actually used is persisted per candidate.

The score is a transparent weighted sum of spatial, temporal, heading and size
components, with weights in configuration and the decomposition persisted
backend-side. Missing inputs are not invented — a component with no basis is
absent, not zero-filled.

Association is greedy one-to-one on candidates above the minimum composite
score. Two near-equal claimants produce `UNRESOLVED` rather than a forced match.

## Classification

Seven neutral states. An unmatched detection means *no sufficiently confident
AIS association was found in the available observations* — nothing more. It is
not evidence of evasion, illegality, or intent.

| State | Meaning |
|---|---|
| `SAR_MATCHED_AIS` | Association above the composite threshold |
| `SAR_UNMATCHED` | Radar return, no association met the threshold |
| `AIS_ONLY` | AIS transmission with no corresponding radar return |
| `STATIONARY_OR_INFRASTRUCTURE` | High backscatter, compact aspect. No wake term. |
| `SEA_CLUTTER` | Weak, small, no SNR support |
| `LOW_CONFIDENCE` | A sub-threshold candidate exists but was not established |
| `UNRESOLVED` | Competing candidates; association deliberately withheld |

## What `sarConf` means

`sarConf` is confidence **in the SAR detection itself**. It answers one question:
*how sure is the detector that this is a vessel-sized surface return?* It is not a
score for the target's identity, its type, or its behaviour, and it is not a
probability that the target is doing anything.

What contributes to it:

| Input | Why it is in the score |
|---|---|
| Peak backscatter | Bright returns are more likely vessels and less likely speckle |
| Mean backscatter over the component | Separates a coherent hull from scattered noise |
| Component area and compactness | A vessel has a plausible footprint |
| SNR relative to local clutter | A return that stands above its surroundings is more likely a target |
| Detector version | A change in algorithm invalidates comparison with older records |

What **must not** contribute, and why:

| Excluded | Reason |
|---|---|
| Wake evidence | Validated as geometry, not as a classifier. See below. |
| AIS association | Would make the SAR confidence depend on a different sensor, and a missing AIS feed would silently lower confidence in a correct detection |
| Polarization | Integrated as an evidence channel only; no validated production rule exists |
| Multipass | Not present at scan time |
| Wake **absence** | Absence of wake evidence is not negative evidence. A stationary hull, a wake beyond the chip, a low sea state and a head-on aspect all produce no detectable wake while the vessel is real and moving. Scoring its absence would penalise correct detections for conditions the sensor cannot resolve. |

The scoring model is versioned. `SCORING_MODEL_VERSION` is currently
**`sar-scoring/v2`**. v1 included a wake term; v2 removed it. Stored records carry
the version they were computed under, because a confidence from v1 and a
confidence from v2 are not the same quantity and must not be compared or averaged
without saying which produced them.

### Why wake was removed rather than weighted

`wake` reached into the confidence and orientation logic through a brightness
threshold on the hull axis with hardcoded limits. It was never validated against
labelled data, it returned `true` for bright hulls with no wake at all, and it
returned `true` for **0 of 84** stored targets — so it was an authority that had
never once changed an outcome, while carrying the power to change any of them.

Substituting a different unvalidated signal would have swapped one unvalidated
authority for another, so the capability was **deleted** rather than reweighted.
Wake now runs, is persisted, and is visible as evidence — but it influences no
score, no association, no heading tolerance and no classification. Wake returns
below as a separate structured channel.

Wake's own product status is **EVIDENCE-ONLY, NOT CALIBRATED**, and it stays that
way until a labelled Sentinel-1 corpus has been reviewed. Absence of a calibration
corpus does not justify pretending the detector is authoritative; it justifies
saying plainly that it is not yet.

### Evidence channels are not fused

Wake, polarization, AIS and multipass each produce their own structured channel.
They are deliberately **not** compressed into one number. A fused score is
comfortable to read and impossible to interrogate: when it looks wrong, there is no
way to ask which input was wrong. A separate fused field (e.g.
`vesselEvidenceScore`) may be added later, on its own name, with its own
validation — but it will not be smuggled in under the existing `sarConf`.

## Cache

Keyed on scene item id + AOI (rounded) + processing config + algorithm version,
hashed to a digest. Stored payloads are checksum-verified on read: a corrupt
entry counts as a miss, never a silent success. Reuse is proven by a real hit
counter.

## Modes

There is one mode. Every artifact carries `{"runtime_mode":"REAL",
"synthetic":false}`, and those two fields are invariants rather than labels: the
run store rejects any record that is not both of those things, and requires both
fields to be present. There is no synthetic scene generator anywhere in the
project — `backend/darkfleet/demo.py` is deleted and
`Settings.allow_synthetic_scenes` no longer exists — so a provider failure has
nothing to degrade into. It surfaces as an explicit `ProviderStatus` code and the
scan persists nothing.

Offline tests read a checked-in GeoTIFF fixture
(`tests/fixtures/cog/fixture_32648.tif`) through the pipeline's `window_source`
injection point, so the stages above are the real ones even with no network.

## Geography the evidence carries

Two facts are attached to every target's position, because a bare coordinate pair
is either less useful than it should be or actively misleading:

- **GEO-001 — the named water body.** `darkfleet/marine.py` resolves the
  position to a Natural Earth marine region so evidence reads as geography. An
  unmatched position reports `kind`/`primary` explicitly rather than silently
  returning nothing.
- **GEO-003 — the vertical datum.** `darkfleet/geoid.py` embeds
  `describe_datum(lat, lon)` with `altitude_measured: false`, because SAR
  measures a two-dimensional backscatter image and does not measure height. The
  record names the ellipsoid (WGS84) and the geoid model (EGM2008) separately and
  carries the undulation only if an undulation source is installed. No EGM2008
  grid ships with this project, so the value is reported on its original datum and
  clearly labelled as *not* height above sea level. N is never assumed to be zero,
  because a sign error in the undulation is exactly the tens-of-metres mistake
  this module exists to prevent.

## Acquisition planning (GEO-002)

`GET /api/revisit` sits beside the scan pipeline rather than inside it, because
it answers a prior question: can this water be imaged at all, and when?
`darkfleet/revisit.py` searches the provider STAC catalogue over a window and
reports the acquisitions that **genuinely exist**.

It measures rather than predicts. Predicting a pass from a TLE would mean
shipping `skyfield`/SGP4 and presenting an estimate of when a satellite *could*
look as though it were a schedule; the catalogue gives what was actually acquired.
Three honesty constraints follow from that choice:

- Gaps and intervals are computed only **inside** the queried window. A gap at the
  window edge is not evidence of a coverage hole, so window bounds are returned
  alongside the statistics and `nominal_repeat_days` (12 d) is a constraint used
  only to *flag* long gaps, never to invent an acquisition.
- A revisit interval is reported only when at least two acquisitions exist. With
  one, the honest answer is "insufficient data" — `median_revisit_days` is `null`,
  not `0` — and a `limitations` string says why.
- The response echoes the provider, collection, requested bbox and window, so a
  statistic can never be quoted without the bounds that produced it.