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
| `STATIONARY_OR_INFRASTRUCTURE` | High backscatter, compact aspect, no wake |
| `SEA_CLUTTER` | Weak, small, no SNR support |
| `LOW_CONFIDENCE` | A sub-threshold candidate exists but was not established |
| `UNRESOLVED` | Competing candidates; association deliberately withheld |

## Cache

Keyed on scene item id + AOI (rounded) + processing config + algorithm version,
hashed to a digest. Stored payloads are checksum-verified on read: a corrupt
entry counts as a miss, never a silent success. Reuse is proven by a real hit
counter.

## Modes

`DEMO` uses deterministic synthetic SAR and AIS; every artifact carries
`{"runtime_mode":"DEMO","synthetic":true}`. `REAL` uses live providers only. A
provider failure in REAL surfaces an explicit status and **never** degrades to
synthetic data — the run store rejects any record whose mode and synthetic flag
disagree.