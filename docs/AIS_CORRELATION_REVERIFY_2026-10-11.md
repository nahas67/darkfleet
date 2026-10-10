# AIS, correlation, track and temporal re-verification — 2026-10-11

Scope: `backend/darkfleet/ais/`, `backend/darkfleet/correlation/`,
`backend/darkfleet/tracks.py`, `backend/darkfleet/temporal.py`, and domain regressions.
Base revision inspected: `15ece157c926c04172728127b11a3aa5765c600a`.
This report records independently reproduced defects and tests; it does not
establish end-to-end external AIS-provider operation.

## Corrected behavior

1. **Missing SAR size remains missing.** `build_tracks()` no longer calls
   `float(None)` on the real `/tracks` input shape from `api/routes.py`.
   `TrackPoint.apparent_length_m` and `length_unc_m` are nullable; missing
   raster resolution is never represented as measured zero metres.
2. **UTC chronology.** Tracks and temporal pattern groups sort parsed datetimes,
   not ISO-string lexical representations. Equivalent dates with different
   offsets are ordered by their instants. AIS dedup keys now canonicalize
   naive-assumed-UTC and timezone-aware observations.
3. **Temporal pattern evidence.** An AIS-association gap cannot join different
   MMSIs or treat multiple detections from the same SAR scan as separate passes.
   Repeated-unmatched signals require distinct scans. Co-location requires
   multiple MMSIs in the **same SAR scan**; overlap in a coarse coordinate cell
   months apart is no longer called co-location.
4. **Inspectable association decisions.** A strong AIS candidate assigned to
   another SAR target has `shortfall=0`, rather than a negative value rejected
   by the API. `closestRejected.rejectionReason` distinguishes
   `BELOW_THRESHOLD`, `ONE_TO_ONE_CONFLICT`,
   `LOWER_RANKED_ALTERNATIVE`, and `AMBIGUOUS_PAIR`.
   Accepted associations include an alternate candidate where one exists.
   The pinned golden target classes and tags are unchanged.
5. **Durable local AIS ingest.** Dedup keys enter the in-memory seen index only
   after successful atomic Parquet replacement. Failed writes can be retried,
   and an interrupted update cannot corrupt the previously committed part.
   A per-directory lock coordinates reads/writes and multiple archive instances
   within the same process, including Windows where an open Parquet handle
   prevents replacement. An in-process revision invalidates stale dedup indexes
   between archive instances without rebuilding on each single-writer append.
6. **Provider source cannot select a filesystem path.** Historical safe source
   labels keep their partition filenames. Unsafe characters/path separators
   get a deterministic, hash-suffixed safe filename; the actual original source
   remains in the Parquet `source` column. A traversal regression also checks
   restart dedup and source provenance.

## Reproduction and verification

Before repairs, the initial added regression suite produced **6 failed,
1 passed**: `float(None)`, offset-string chronology, invented AIS gap between
different MMSIs, AIS writer cache poisoning, and negative rejection shortfall.
Follow-on tests additionally cover path traversal, same-process failed update
preservation, duplicate scan sightings, one-pass co-location, and rejected
alternates.

After repairs:

- `python -m pytest -q backend/tests/test_ais.py backend/tests/test_ais_absent_semantics.py backend/tests/test_ais_archive_construction.py backend/tests/test_ais_collector_reconnect.py backend/tests/test_ais_correlation_baseline.py backend/tests/test_ais_delivery.py backend/tests/test_ais_resilience.py backend/tests/test_correlation_parity.py backend/tests/test_advanced.py backend/tests/test_track_temporal_reverify.py backend/tests/test_ais_reverify.py backend/tests/test_correlation_reverify.py`
- Result: **211 passed, 0 failed**. Includes the existing concurrent archive
  read/append exercise and golden AIS-to-SAR scoring parity.

## Integration ownership and residual limitations

- The prime agent owns `backend/darkfleet/api/advanced.py`,
  `backend/darkfleet/api/targets.py`, `backend/darkfleet/ghost_vessel.py`
  and the TypeScript contract. It was informed of the exact nullable fields
  and `rejectionReason` enumeration, and confirmed the related API changes
  were in progress. The worker's domain suite alone does **not** assert that
  the final combined HTTP/TypeScript integration was verified.
- The archive synchronization is **in-process**. Independent service processes
  sharing one directory still need an interprocess write lock or transactional
  store, plus cross-process seen-index invalidation. No multi-process durability
  guarantee is claimed.
- Historically corrupt Parquet parts still make read paths fail; the existing
  `test_corrupt_part_is_tolerated_by_the_index_but_not_by_reads` documents
  that pre-existing behavior.
- `build_tracks()` currently reports physically implausible/beyond-window
  edges as contradictions but still groups all observations sharing one MMSI
  in one hypothesis. A future segmenting design should specify identity and
  continuity rules before changing operator-visible track counts.
- Co-location is a same-pass coarse-cell observation only. The temporal
  `min_passes` parameter remains reserved; there is no verified geometric
  convergence/separation inference.
- No remote provider credentials or live AIS acquisition were exercised.
