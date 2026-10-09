/**
 * THE TRACK BUILDER: observed fixes in, a truthful segment model out.
 *
 * ================================ THE MODEL ================================
 *
 *     REAL OBSERVATION
 *           ↓
 *     OBSERVED_SEGMENT      -- positions that genuinely were reported, joined only across
 *           |                  intervals the product is willing to interpolate
 *           ↓  gap
 *     GAP                   -- the ABSENCE of evidence, as a first-class segment
 *           ↓
 *     NEXT OBSERVATION
 *
 * A gap is NOT a polyline with a different colour. It is a segment whose meaning is "nothing was
 * reported here", and it is modelled separately precisely so it can never be mistaken for a
 * trajectory. DF-X9.4 section 15 requires that, and the alternative -- one line with two styles --
 * is indistinguishable from continuous observation to anyone who is not told to look closely.
 *
 * ================================ EVERY SEGMENT IS TRACEABLE ================================
 *
 * Each segment carries the INDEX of the stored observation at each end, and each point carries its
 * own. So "what was actually measured here?" is answerable by index rather than by eye, and a
 * reviewer can go to the archive row and confirm it.
 */

/* ============================================================================================== *
 * INPUT
 * ============================================================================================== */

import type { AisObservationOut } from '../api/contract';
import { MAX_INTERPOLATION_INTERVAL_S } from '../ais/displayState';
import { isValidLatLon, splitAtAntimeridian, type LatLon } from './trackGeometry';

/* ============================================================================================== *
 * OUTPUT
 * ============================================================================================== */

/**
 * `GAP` and `OBSERVED_SEGMENT` are the only two kinds the archive can produce.
 *
 * `PREDICTED_EXTENSION` is deliberately absent from THIS builder. A prediction is an analytical
 * position computed by the backend and stored on the scan record, not a function of the archive's
 * observations, so building one here would mean deriving prediction in the display layer -- the
 * exact boundary DF-X9.3 drew and DF-X9.4 section 25 repeats. Predicted geometry arrives as its own
 * input and is rendered separately.
 */
export type TrackSegmentKind = 'OBSERVED_SEGMENT' | 'GAP';

export type TrackPoint = LatLon & {
  /** ISO timestamp of the stored observation this point IS. */
  at: string;
  /** Index into the SORTED observation list. Traceable back to an archive row. */
  observationIndex: number;
};

export type TrackSegment = {
  kind: TrackSegmentKind;
  points: TrackPoint[];
  /** ISO timestamp of the first observation bounding this segment, or null when unknown. */
  fromTimestamp: string | null;
  toTimestamp: string | null;
  /**
   * Seconds from the first bounding observation to the last.
   *
   * NULL when the timestamps could not be parsed. Null rather than 0, because 0 asserts "these
   * were simultaneous" and that is not what an unparseable timestamp means.
   */
  spanSeconds: number | null;
  /** Index of the observation at the start of this segment. */
  startObservationIndex: number;
  endObservationIndex: number;
};

/**
 * Why a track cannot be drawn, when it cannot.
 *
 * `SINGLE_OBSERVATION` IS NOT AN ERROR. One recorded fix is real evidence and its marker must still
 * draw -- it simply is not a track, and DF-X9.4 section 20 requires saying so rather than connecting
 * one point to itself or dropping it.
 */
export type TrackStatus = 'NO_OBSERVATIONS' | 'SINGLE_OBSERVATION' | 'TRACK';

export type TrackBuild = {
  status: TrackStatus;
  segments: TrackSegment[];
  /** Observations with a usable position, after sorting. */
  usableCount: number;
  /**
   * Observations DROPPED for an unusable position.
   *
   * Counted and reported rather than silently skipped: a coordinate that fails validation is a data
   * problem, and a track that quietly omits points reads exactly like a track with fewer
   * observations. The dossier states the number so the two can be told apart.
   */
  rejectedCount: number;
  /** The rejection reasons, grouped, so a whole feed failing is recognisable at a glance. */
  rejectionReasons: string[];
  /** Epoch ms of the first and last usable observation. */
  startMs: number | null;
  endMs: number | null;
  /** The single fix, when `status` is `SINGLE_OBSERVATION`. Drawn as a marker, not a track. */
  lonePoint: (TrackPoint & { at: string }) | null;
};

/* ============================================================================================== *
 * BUILDING
 * ============================================================================================== */

function epochMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sort observations by timestamp, STABLY.
 *
 * DF-X9.4 section 49: API order is not guaranteed, and building a track from unsorted input produces
 * negative spans and backwards segments.
 *
 * THE STABLE TIE-BREAK IS THE POINT. Two observations can share a timestamp -- two receivers, or a
 * re-sent row -- and `Array.prototype.sort` is stable in modern engines but the ORIGINAL INDEX is
 * still made explicit, so the tie-break cannot depend on engine version or on which sorter runs.
 * A tie-break that varies between environments is a tie-break that produces different evidence.
 */
function orderedIndexes(observations: readonly AisObservationOut[]): number[] {
  return observations
    .map((observation, index) => ({ index, ms: epochMs(observation.timestamp) }))
    .sort((a, b) => {
      // Unparseable timestamps sort LAST, so they cannot silently become the track's start.
      if (a.ms === null && b.ms === null) return a.index - b.index;
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      if (a.ms !== b.ms) return a.ms - b.ms;
      return a.index - b.index;
    })
    .map((entry) => entry.index);
}

/**
 * Build the segment model for one contact's observations.
 *
 * PURE, AND IT TAKES THE REFERENCE TIME NOT AT ALL. The reference instant belongs to the display
 * layer's per-contact decision (`displayStateOf`), which also decides freshness. A track builder that
 * knew the reference time would have two places deciding whether a moment is valid, and they would
 * eventually disagree.
 */
export function buildTrack(observations: readonly AisObservationOut[]): TrackBuild {
  /* ---- 1. ORDER, with a stable tie-break on the original index. ---- */
  const order = orderedIndexes(observations);

  /* ---- 2. VALIDATE. An unusable coordinate is DROPPED AND COUNTED, never moved to (0, 0). ---- */
  const points: TrackPoint[] = [];
  const rejectionReasons: string[] = [];
  let rejectedCount = 0;

  for (const index of order) {
    const observation = observations[index];
    if (!isValidLatLon(observation.lat, observation.lon)) {
      rejectedCount += 1;
      const reason =
        typeof observation.lat !== 'number' || typeof observation.lon !== 'number'
          ? `observation ${index} has a non-numeric position`
          : `observation ${index} has a position outside valid latitude/longitude bounds`;
      rejectionReasons.push(reason);
      continue;
    }
    points.push({
      lat: observation.lat as number,
      lon: observation.lon as number,
      at: observation.timestamp,
      observationIndex: index,
    });
  }

  /* ---- 3. NO USABLE POSITIONS: an empty answer, stated. ---- */
  if (points.length === 0) {
    return {
      status: 'NO_OBSERVATIONS',
      segments: [],
      usableCount: 0,
      rejectedCount,
      rejectionReasons,
      startMs: null,
      endMs: null,
      lonePoint: null,
    };
  }

  /* ---- 4. ONE OBSERVATION IS EVIDENCE, NOT A TRACK. Its marker still draws. ---- */
  const firstMs = epochMs(points[0].at);
  const lastMs = epochMs(points[points.length - 1].at);

  if (points.length === 1) {
    return {
      status: 'SINGLE_OBSERVATION',
      segments: [],
      usableCount: 1,
      rejectedCount,
      rejectionReasons,
      startMs: firstMs,
      endMs: lastMs,
      lonePoint: points[0],
    };
  }

  /* ---- 5. SEGMENT. ---- */
  const segments: TrackSegment[] = [];
  let run: TrackPoint[] = [];

  const flush = (): void => {
    // A segment needs two endpoints. One point is a fix, and fixes are markers -- they are already
    // drawn separately, so emitting a one-point "segment" would draw them twice.
    if (run.length < 2) {
      run = [];
      return;
    }
    segments.push({
      kind: 'OBSERVED_SEGMENT',
      points: run,
      fromTimestamp: run[0].at,
      toTimestamp: run[run.length - 1].at,
      spanSeconds: spanOf(run),
      startObservationIndex: run[0].observationIndex,
      endObservationIndex: run[run.length - 1].observationIndex,
    });
    run = [];
  };

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const aMs = epochMs(a.at);
    const bMs = epochMs(b.at);

    /*
     * DUPLICATE TIMESTAMPS.
     *
     * Two observations at the same instant have a span of exactly 0 s, which IS within the
     * interpolation limit, so they join into one observed segment. That is correct: both were
     * reported, and neither is contradicted by the other.
     *
     * What must NOT happen is a later interpolation dividing by `bMs - aMs`, which is zero. The
     * builder therefore records the span honestly as 0 and never manufactures a non-zero one; the
     * interpolation side guards the division separately, and `trackGeometry.interpolateAlongTrack`
     * takes a FRACTION rather than two instants so it cannot divide at all.
     */
    const spanSeconds = aMs !== null && bMs !== null ? (bMs - aMs) / 1000 : null;

    /*
     * THE GAP RULE, TRACED TO A PRODUCT CONSTANT (DF-X9.4 section 14).
     *
     * The threshold is `MAX_INTERPOLATION_INTERVAL_S` = 600 s, and it is the SAME constant the
     * contact-position logic already uses, deliberately: a track segment and a contact glyph are
     * answers to one question -- "is the evidence continuous enough to join?" -- and two thresholds
     * would eventually disagree, producing a glyph that refuses to interpolate across an interval its
     * own track draws as solid.
     *
     * 600 s itself is derived, not invented: the fixture cadence is 240 s (`08:00, 08:04, 08:08,
     * 08:12, 08:16` in `test_ais_delivery.py`), so 600 s is 2.5 cadence intervals. That tolerates one
     * missed report (480 s) and rejects two (720 s). It sits below the 900 s correlation window, so a
     * segment is never drawn that correlation would have excluded anyway.
     */
    const withinObservedLimit =
      spanSeconds !== null && spanSeconds <= MAX_INTERPOLATION_INTERVAL_S;

    if (withinObservedLimit) {
      if (run.length === 0) run.push(a);
      run.push(b);
      continue;
    }

    flush();
    segments.push({
      kind: 'GAP',
      // The gap's endpoints are REAL observations. What is missing is everything between them, and
      // the span says how much -- or null, when it could not be determined.
      points: [a, b],
      fromTimestamp: a.at,
      toTimestamp: b.at,
      spanSeconds,
      startObservationIndex: a.observationIndex,
      endObservationIndex: b.observationIndex,
    });
  }
  flush();

  return {
    status: 'TRACK',
    segments,
    usableCount: points.length,
    rejectedCount,
    rejectionReasons,
    startMs: firstMs,
    endMs: lastMs,
    lonePoint: null,
  };
}

/** Total span of a run, or null when any timestamp is unparseable. Never a fabricated zero. */
function spanOf(run: readonly TrackPoint[]): number | null {
  const first = epochMs(run[0].at);
  const last = epochMs(run[run.length - 1].at);
  if (first === null || last === null) return null;
  return (last - first) / 1000;
}

/* ============================================================================================== *
 * SEGMENT HELPERS FOR THE RENDERER
 * ============================================================================================== */

/**
 * The polyline pieces a segment must be drawn as.
 *
 * A single observed segment can still cross the antimeridian, and `Cartesian3.fromDegrees` normalises
 * longitude into [-180, 180] -- so a crossing drawn as one polyline becomes a line straight across the
 * world, asserting a 20,000 km journey no vessel made. Unwrapping the longitudes does NOT help,
 * because the normalisation happens inside Cesium regardless of the value handed to it.
 *
 * So the only correct display strategy is to SPLIT. Each returned run is a contiguous slice, and
 * concatenating every run reproduces the segment's points exactly: nothing is reordered, dropped or
 * duplicated, and the stored coordinates are untouched. This is display geometry only, which is what
 * DF-X9.4 section 29 permits.
 */
export function displayRunsFor(segment: TrackSegment): TrackPoint[][] {
  return splitAtAntimeridian(segment.points).map((run) =>
    run.map((point) => point as TrackPoint),
  );
}
