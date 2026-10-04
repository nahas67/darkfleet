# Wake Validation Sources — verified registry

**Status:** source identification and licence verification complete. **No corpus has
been downloaded or evaluated.** Detector state remains `EXPERIMENTAL EVIDENCE`.

Verification levels are stated per source, because they are not equal:

| Level | Meaning |
|---|---|
| `VERIFIED` | I fetched the primary record and read the licence/metadata directly |
| `PUBLICATION_ONLY` | Publication metadata seen; **download availability and terms NOT verified** |
| `INCOMPATIBLE` | Verified to be a domain mismatch for DarkFleet's detector |

Nothing below is inferred from a paper abstract and presented as fact.

---

## A. UEIKAP — `VERIFIED`

The strongest candidate: Sentinel-1 **and** wake **and** AIS, which is exactly
DarkFleet's domain.

| field | value | how verified |
|---|---|---|
| title | UEIKAP_DATASET | Zenodo API |
| version | 1.0 | Zenodo API |
| published | 2026-01-27 | Zenodo API |
| DOI | `10.5281/zenodo.18391027` | Zenodo API |
| **licence** | **CC-BY-4.0** | Zenodo API `metadata.license.id` |
| access | open | Zenodo API |
| SAR subset | `UEIKAP_SAR.zip`, 1 571 288 093 B (1.6 GB) | Zenodo API |
| SAR checksum | `md5:356148359a9ae6b7ae3d3cec2fb61304` | Zenodo API |
| optical subset | 11.96 GB, **placeholder, not populated in v1.0** | README + Zenodo API |

### Licence gate (§8)

| question | answer |
|---|---|
| download allowed | **yes** — open access |
| local research use | **yes** |
| redistribution of originals | **yes**, CC-BY-4.0 |
| **derived chip redistribution** | **yes**, with attribution |
| **annotation redistribution** | **yes**, with attribution |
| attribution required | **yes** — CC-BY-4.0 |

CC-BY-4.0 permits derived-chip redistribution with attribution, so small derived
fixtures are committable. Attribution must name the UEIKAP record and DOI.

### Layout (from `README_UEIKAP.md`)

```text
UEIKAP_dataset_SAR/
  images/                      SAR image chips
  labels/                      annotations
  labels_jsons/                JSON annotations
  images_tifs/                 GeoTIFF SAR images
  AIS_interpolated_SAR_UEIKAP/  interpolated AIS
```

### Two properties that constrain its use

1. **`AIS_interpolated_SAR_UEIKAP/` is INTERPOLATED AIS**, not observed messages.
   Interpolated positions are propagated estimates. They must never be ingested as
   observed AIS, and never presented as DarkFleet's observed-vs-predicted
   distinction is being honoured.

2. **Preprocessing is not yet verified.** The README distinguishes `images/`
   ("SAR image chips") from `images_tifs/` ("GeoTIFF SAR images") but states no
   calibration domain, no processing level, and no polarization per chip. Per §11
   this must be established from the data before any chip is fed to the detector —
   a rendered 8-bit PNG would be a domain mismatch, not a validation.

## B. SSWD — `PUBLICATION_ONLY`

| field | value | confidence |
|---|---|---|
| title | First Results on Wake Detection in SAR Images by Deep Learning | publication |
| authors | Del Prete et al., 2021 | publication |
| venue | *Remote Sensing* 13(22):4573 | publication |
| DOI | `10.3390/rs13224573` | publication |
| content | "more than 250 wake chips" | publication |
| provenance | "visually inspecting Sentinel-1 images over highly trafficked maritime sites" | publication |
| **download** | **NOT VERIFIED** | — |
| **licence** | **NOT VERIFIED** | — |

**Label strength:** visual inspection by the authors. That is *expert-labelled but
not instrument-confirmed*. Usable as `POSITIVE` with `review_status=PUBLICATION_LABELLED`,
**not** as ground truth for precision claims.

## C. OpenSARWake — `PUBLICATION_ONLY`

| field | value | confidence |
|---|---|---|
| title | OpenSARWake: A Large-Scale SAR Dataset for Ship Wake Recognition | publication |
| scale | 3 973 SAR images, 4 096 wake instances, two polarization modes | publication |
| bands | L / C / X | publication |
| **download** | **NOT VERIFIED** | — |
| **licence** | **NOT VERIFIED** | — |

**Not Sentinel-1-only.** Per §4/§10 it must be **stratified**, never pooled into
one DarkFleet accuracy number:

```text
SENTINEL_1_C_BAND   <- only stratum that may inform DarkFleet claims
OTHER_C_BAND
L_BAND
X_BAND
UNKNOWN
```

A pooled figure across L/C/X would describe a detector operating outside its
production domain.

## D. OSSDD — `VERIFIED INCOMPATIBLE`

| field | value |
|---|---|
| title | OSSDD — a New Open Dataset for Sentinel-1 Ship Detection |
| arXiv | 2608.01963 |
| content | 11 346 ships from 41 Sentinel-1 images, harbour areas |

**Domain mismatch, and it is decisive.** The paper states patches were:

> "converted to decibel scale ... and each patch was subsequently normalized to the
> range [0, 1] via linear **min-max scaling based on the per-patch minimum and
> maximum values**"

Per-patch min–max normalisation destroys absolute radiometry and each patch's noise
floor. DarkFleet's detector thresholds **arm contrast over a local background**, so
a contrast ratio computed on min-max-normalised data is not the quantity the
detector was built for. Feeding it to `analyse_wake` would produce numbers that look
like validation and are not.

**Verdict: usable as a NEGATIVE-candidate source only, never as accuracy data, and
not until chips are re-derived from calibrated data.**

## E. Hard negatives — `PUBLICATION_ONLY`

`OSSDD` above, or a Sentinel-1 ship-detection set, could supply bright-hull /
no-wake / coastal-clutter cases.

**Per §5 I will not infer a negative wake label from a missing annotation.**
Absence of a wake annotation in a ship-detection dataset is not evidence that no
wake exists. Any negative must be independently reviewed, and until a reviewer exists
those samples carry `AMBIGUOUS`, not `NEGATIVE`.

---

## Corpus status

| stratum (§9) | samples available today |
|---|---|
| A. clear wake positive | **0** |
| B. clear vessel / no wake | **0** |
| C. bright hull / no wake | **0** |
| D. wake-like sea clutter | **0** |
| E. coast / infrastructure linear | **0** |
| F. multiple vessels | **0** |
| G. low-contrast vessel | **0** |
| H. partial / edge wake | **0** |
| I. ambiguous | **0** |
| J. varied sea state | **0** |

## Consequence for the product

Per §23 the detector is:

```text
STATE C — INSUFFICIENT VALIDATION / EXPERIMENTAL EVIDENCE
```

And per §1 this **does not block the dossier**. Wake ships as:

```text
WAKE ANALYSIS
EVIDENCE-ONLY — NOT CALIBRATED
NOT USED IN CLASSIFICATION
```

No precision, recall, F1, FP/FN rate or angle-error figure is published in this
checkpoint, because N = 0. Publishing a percentage with no samples would be
fabrication.

## To close STATE C

1. Download `UEIKAP_SAR.zip` (1.6 GB, CC-BY-4.0) outside the repo
2. Verify per-chip calibration domain and polarization from `images_tifs/`
3. Build the manifest with full provenance per §7
4. Run `python -m darkfleet.validation.wake --manifest ...`
5. Review every FP and FN by hand before any rate is quoted

Step 2 is a gate, not a formality: if the chips turn out to be rendered PNGs rather
than calibrated backscatter, UEIKAP cannot validate this detector either, and the
search must continue rather than proceed.