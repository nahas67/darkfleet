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