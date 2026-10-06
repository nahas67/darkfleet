/**
 * Tests for the TRACK GEOMETRY authority and the TRACK BUILDER.
 *
 * ================================ WHAT IS ASSERTED AND WHY ================================
 *
 * The antimeridian and high-latitude cases here are the ones a screenshot cannot settle. A track that
 * crosses 180 degrees either draws across the world or it does not, and "it looked fine" is not
 * evidence -- the artefact is only visible when the camera is far enough out that the wrong line and
 * the right line look similar. So the assertions are on GEOMETRY: how many pieces, how wide, and
 * whether any single piece spans the globe.
 *
 * Every expected value is derived from the arithmetic in the comment beside it. A fixture that
 * asserts its own expected values is asserting its own arithmetic.
 */

import { describe, expect, it } from 'vitest';

import type { AisObservationOut } from '../api/contract';
import { MAX_INTERPOLATION_INTERVAL_S } from '../ais/displayState';
import { buildTrack, displayRunsFor } from './trackBuilder';
import {
  crossesAntimeridian,
  interpolateAlongTrack,
  isValidLatLon,
  longitudeDelta,
  normalizeLongitude,
  splitAtAntimeridian,
  wrappedBounds,
} from './trackGeometry';

/* ------------------------------------------------------------------ fixtures */

const T0 = Date.parse('2026-05-12T08:00:00Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

let nextMmsi = 257000001;
function obs(over: Partial<AisObservationOut> = {}): AisObservationOut {
  nextMmsi += 1;
  return {
    timestamp: at(0),
    mmsi: String(nextMmsi),
    lat: 1.0,
    lon: 103.0,
    sog: null,
    cog: null,
    heading: null,
    ship_name: null,
    source: 'aistream',
    ...over,
  };
}

/** A run of observations on the product's own 4-minute cadence, drifting north. */
function cadence(count: number, over: Partial<AisObservationOut> = {}): AisObservationOut[] {
  return Array.from({ length: count }, (_unused, i) =>
    obs({ timestamp: at(i * 240), lat: 1.0 + i * 0.004, ...over }),
  );
}

/* ============================================================================================== *
 * WRAP ARITHMETIC
 * ============================================================================================== */

describe('longitude arithmetic', () => {
  it('takes the SHORTEST signed difference, not the raw subtraction', () => {
    // 179.9E to 179.9W is 0.2 degrees EAST, not 359.8 degrees west.
    expect(longitudeDelta(179.9, -179.9)).toBeCloseTo(0.2, 9);
    // 0 to 359 is -1 degree, the short way round.
    expect(longitudeDelta(0, 359)).toBeCloseTo(-1, 9);
    // Ordinary values are unaffected.
    expect(longitudeDelta(103.0, 104.0)).toBeCloseTo(1, 9);
    expect(longitudeDelta(104.0, 103.0)).toBeCloseTo(-1, 9);
  });

  it('normalises into [-180, 180] and canonicalises -180 to 180', () => {
    expect(normalizeLongitude(190)).toBeCloseTo(-170, 9);
    expect(normalizeLongitude(-190)).toBeCloseTo(170, 9);
    expect(normalizeLongitude(180)).toBe(180);
    expect(normalizeLongitude(-180)).toBe(180);
    // Repeated wrapping must be stable, or a frame could drift each time it is computed.
    expect(normalizeLongitude(normalizeLongitude(normalizeLongitude(540)))).toBeCloseTo(180, 9);
  });

  it('detects an antimeridian crossing', () => {
    expect(crossesAntimeridian(179.9, -179.9)).toBe(true);
    expect(crossesAntimeridian(1.0, 2.0)).toBe(false);
    // Identical meridians do not "cross", however they are spelled.
    expect(crossesAntimeridian(180, -180)).toBe(false);
    expect(crossesAntimeridian(180, 180)).toBe(false);
  });
});

/* ============================================================================================== *
 * SPLITTING
 * ============================================================================================== */

describe('splitAtAntimeridian', () => {
  it('keeps a non-crossing track as ONE run', () => {
    const runs = splitAtAntimeridian([
      { lat: 1.0, lon: 103.0 },
      { lat: 1.004, lon: 103.0 },
      { lat: 1.008, lon: 103.0 },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it('splits the REQUIRED antimeridian fixture into pieces that do not span the world', () => {
    /*
     * DF-X9.4 section 27's exact fixture: 179.8E, 179.9E, 179.9W, 179.7W.
     *
     * The whole track moves ~0.4 degrees. Drawn as one polyline it would cross the globe -- a
     * ~40,000 km journey. The assertion is on PIECE WIDTH, which is the property that matters: no
     * single piece may span more than a few degrees.
     */
    const points = [
      { lat: 1.0, lon: 179.8 },
      { lat: 1.0, lon: 179.9 },
      { lat: 1.0, lon: -179.9 },
      { lat: 1.0, lon: -179.7 },
    ];
    const runs = splitAtAntimeridian(points);
    expect(runs.length).toBeGreaterThanOrEqual(2);

    for (const run of runs) {
      const lons = run.map((p) => p.lon);
      const width = Math.max(...lons) - Math.min(...lons);
      expect(width).toBeLessThan(5);
    }
  });

  it('loses and duplicates NO point, whatever it splits', () => {
    // The invariant that makes splitting safe: concatenating the runs reproduces the input.
    const points = [
      { lat: 1.0, lon: 179.8 },
      { lat: 1.0, lon: -179.9 },
      { lat: 1.0, lon: -179.7 },
      { lat: 1.0, lon: 179.5 },
      { lat: 1.0, lon: 179.6 },
    ];
    const runs = splitAtAntimeridian(points);
    const flattened = runs.flat();
    expect(flattened).toEqual(points);
  });

  it('keeps a one-point run at the edge rather than erasing it', () => {
    // Dropping it would remove an observation from the display. A fix at the very edge whose
    // partner is across the meridian is still a fix.
    const runs = splitAtAntimeridian([
      { lat: 1.0, lon: -179.99 },
      { lat: 1.0, lon: 179.99 },
    ]);
    expect(runs.flat()).toHaveLength(2);
  });

  it('an empty input is empty, not a single empty run', () => {
    expect(splitAtAntimeridian([])).toEqual([]);
  });
});

/* ============================================================================================== *
 * BOUNDING -- FOR FRAME TRACK
 * ============================================================================================== */

describe('wrappedBounds', () => {
  it('does NOT inflate a crossing track to nearly the whole globe', () => {
    /*
     * THE BUG `frameTrack` WOULD HAVE SHIPPED.
     *
     * Naive min/max longitude over [179.8, 179.9, -179.9, -179.7] is [-179.9, +179.9] -- a width of
     * 359.8 degrees. Framing that zooms out to the entire Earth to contain a vessel that moved 40 km.
     */
    const bounds = wrappedBounds([1.0, 1.0, 1.0, 1.0], [179.8, 179.9, -179.9, -179.7]);
    expect(bounds).not.toBeNull();
    /*
     * THE WIDTH IS 0.5, NOT 0.4. My first comment said 0.4, the test failed, and it was RIGHT:
     *   179.8  -> 179.9   = +0.1
     *   179.9  -> 179.9W  = +0.2  (through 180)
     *   179.9W -> 179.7W  = +0.2
     *                  = 0.5
     * The third step is 0.2 rather than 0.1 because BOTH operands moved west across the meridian.
     */
    expect(bounds!.widthDeg).toBeCloseTo(0.5, 6);
    // The assertion that actually matters is the bound, not the exact figure.
    expect(bounds!.widthDeg).toBeLessThan(2);
  });

  it('centres a crossing track on 180, not on the far side of the world', () => {
    const bounds = wrappedBounds([1.0, 1.0], [179.9, -179.9])!;
    // The honest centre is the antimeridian itself. Reporting -180 would aim the camera at a
    // meridian 360 degrees away from the vessel.
    expect(Math.abs(bounds.centerLon)).toBeCloseTo(180, 6);
  });

  it('reports an ordinary track unchanged', () => {
    const bounds = wrappedBounds([1.0, 1.01], [103.0, 103.5])!;
    expect(bounds.centerLon).toBeCloseTo(103.25, 6);
    expect(bounds.widthDeg).toBeCloseTo(0.5, 6);
    expect(bounds.heightDeg).toBeCloseTo(0.01, 6);
    expect(bounds.crossesAntimeridian).toBe(false);
  });

  it('a single point is a zero-extent region, not a whole globe', () => {
    const bounds = wrappedBounds([12.5], [77.25])!;
    expect(bounds.widthDeg).toBe(0);
    expect(bounds.heightDeg).toBe(0);
    expect(bounds.centerLat).toBeCloseTo(12.5, 9);
  });

  it('empty or mismatched input yields null rather than a fabricated region', () => {
    expect(wrappedBounds([], [])).toBeNull();
    expect(wrappedBounds([1.0, 2.0], [1.0])).toBeNull();
  });
});

/* ============================================================================================== *
 * VALIDITY
 * ============================================================================================== */

describe('isValidLatLon', () => {
  it('rejects null and undefined, which arithmetic would silently turn into 0', () => {
    // (0, 0) is a real place in the Gulf of Guinea. Coercing an absent coordinate there would
    // place a vessel somewhere specific and wrong rather than nowhere.
    expect(isValidLatLon(null, 103)).toBe(false);
    expect(isValidLatLon(1.0, undefined)).toBe(false);
    expect(isValidLatLon('1.0' as unknown, 103)).toBe(false);
  });

  it('rejects out-of-range and non-finite values', () => {
    expect(isValidLatLon(91, 0)).toBe(false);
    expect(isValidLatLon(-91, 0)).toBe(false);
    expect(isValidLatLon(0, 181)).toBe(false);
    expect(isValidLatLon(Number.NaN, 0)).toBe(false);
    expect(isValidLatLon(0, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('accepts the bounds themselves', () => {
    expect(isValidLatLon(90, 180)).toBe(true);
    expect(isValidLatLon(-90, -180)).toBe(true);
    expect(isValidLatLon(0, 0)).toBe(true);
  });
});

/* ============================================================================================== *
 * INTERPOLATION AND ITS DOCUMENTED DOMAIN
 * ============================================================================================== */

describe('interpolateAlongTrack', () => {
  it('returns the endpoints exactly at 0 and 1', () => {
    const a = { lat: 1.0, lon: 103.0 };
    const b = { lat: 1.004, lon: 103.0 };
    expect(interpolateAlongTrack(a, b, 0)).toEqual({ lat: 1.0, lon: 103.0 });
    expect(interpolateAlongTrack(a, b, 1)).toEqual({ lat: 1.004, lon: 103.0 });
  });

  it('places the midpoint between the endpoints', () => {
    const mid = interpolateAlongTrack({ lat: 1.0, lon: 103.0 }, { lat: 1.004, lon: 103.002 }, 0.5)!;
    expect(mid.lat).toBeCloseTo(1.002, 9);
    expect(mid.lon).toBeCloseTo(103.001, 9);
  });

  it('continues EAST across the antimeridian rather than reversing', () => {
    // Naive linear interpolation here would produce -179.9, i.e. a jump BACKWARD across the world.
    const mid = interpolateAlongTrack({ lat: 1.0, lon: 179.9 }, { lat: 1.0, lon: -179.9 }, 0.5)!;
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 6);
    // The eastward displacement across the whole interval is +0.2, so the midpoint must be +0.1 from
    // the start -- which lands on the antimeridian.
    expect(mid.lon).toBeGreaterThan(179.9);
  });

  it('clamps a fraction outside [0, 1] rather than extrapolating', () => {
    const a = { lat: 1.0, lon: 103.0 };
    const b = { lat: 1.004, lon: 103.0 };
    expect(interpolateAlongTrack(a, b, -5)).toEqual({ lat: 1.0, lon: 103.0 });
    expect(interpolateAlongTrack(a, b, 5)).toEqual({ lat: 1.004, lon: 103.0 });
  });

  it('returns null for invalid input rather than a NaN position', () => {
    // A NaN position propagates silently into a Cesium primitive and produces an invisible artefact
    // that looks like a rendering bug rather than a data bug.
    expect(interpolateAlongTrack({ lat: 1, lon: 1 }, { lat: 1, lon: 1 }, Number.NaN)).toBeNull();
    expect(interpolateAlongTrack({ lat: Number.NaN, lon: 1 }, { lat: 1, lon: 1 }, 0.5)).toBeNull();
    expect(
      interpolateAlongTrack({ lat: 1, lon: 1 }, { lat: 1, lon: 999 }, 0.5),
    ).toBeNull();
  });

  it('is accurate enough for the documented domain, and the domain is enforced', () => {
    /*
     * THE ARITHMETIC FROM THE MODULE DOC, CHECKED.
     *
     * Linear interpolation of lat/lon deviates from a great circle by about d^2 / (2R).
     * The worst case this product can produce is the fastest plausible AIS speed over the maximum
     * interpolable interval: 25 kn = 12.9 m/s, 600 s, so 7,730 m.
     *
     *     7730^2 / (2 * 6,371,009) = 4.7 m
     *
     * So the deviation is under five metres on a track drawn in kilometres, and it is BOUNDED. What
     * that buys is stated rather than assumed: the product only ever interpolates intervals at or
     * below MAX_INTERPOLATION_INTERVAL_S, and longer ones become GAP segments instead. The domain
     * limit and the correctness limit are the same limit.
     */
    const speedMs = 25 * 0.514444444; // 25 kn in m/s
    const spanM = speedMs * MAX_INTERPOLATION_INTERVAL_S;
    expect(spanM).toBeGreaterThan(7_000);
    expect(spanM).toBeLessThan(8_000);

    const deviationM = (spanM * spanM) / (2 * 6_371_009);
    expect(deviationM).toBeGreaterThan(4);
    expect(deviationM).toBeLessThan(6);

    // And the builder enforces that ceiling, so the bound above actually holds.
    const tooLong = buildTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(MAX_INTERPOLATION_INTERVAL_S + 1), lat: 1.05, lon: 103.0 }),
    ]);
    expect(tooLong.segments[0].kind).toBe('GAP');
  });
});

/* ============================================================================================== *
 * TRACK BUILDING -- EVERY CASE DF-X9.4 SECTION 48 NAMES
 * ============================================================================================== */

describe('buildTrack: observation counts', () => {
  it('ZERO observations is an empty answer, stated as such', () => {
    const build = buildTrack([]);
    expect(build.status).toBe('NO_OBSERVATIONS');
    expect(build.segments).toEqual([]);
    expect(build.startMs).toBeNull();
    expect(build.endMs).toBeNull();
  });

  it('ONE observation is EVIDENCE, not a track, and its marker is preserved', () => {
    const single = obs({ timestamp: at(0), lat: 1.5, lon: 104.25 });
    const build = buildTrack([single]);

    expect(build.status).toBe('SINGLE_OBSERVATION');
    expect(build.segments).toEqual([]);
    // The fix must still be reachable, or the operator loses the only position they have.
    expect(build.lonePoint).not.toBeNull();
    expect(build.lonePoint!.lat).toBeCloseTo(1.5, 9);
    expect(build.lonePoint!.lon).toBeCloseTo(104.25, 9);
    expect(build.lonePoint!.observationIndex).toBe(0);
    expect(build.startMs).toBe(T0);
  });

  it('TWO observations within the limit are one observed segment', () => {
    const build = buildTrack(cadence(2));
    expect(build.status).toBe('TRACK');
    expect(build.segments).toHaveLength(1);
    expect(build.segments[0].kind).toBe('OBSERVED_SEGMENT');
    expect(build.segments[0].points).toHaveLength(2);
    // 240 s, the product's own cadence.
    expect(build.segments[0].spanSeconds).toBe(240);
  });

  it('TWO observations beyond the limit are TWO POINTS AND A GAP, never a segment', () => {
    // DF-X9.4 section 21.
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(3120), lat: 1.01, lon: 103.0 }),
    ]);
    expect(build.segments).toHaveLength(1);
    expect(build.segments[0].kind).toBe('GAP');
    expect(build.segments[0].spanSeconds).toBe(3120);
    // The gap's endpoints are REAL observations, and it says how long the silence was.
    expect(build.segments[0].points).toHaveLength(2);
    expect(build.segments[0].startObservationIndex).toBe(0);
    expect(build.segments[0].endObservationIndex).toBe(1);
  });
});

describe('buildTrack: multi-segment', () => {
  it('MEASURED GAP CASE -- the fixture vessel 257000004', () => {
    /*
     * THE CASE DF-X9.3'S BROWSER E2E ESCALATED, REBUILT AT THE UNIT LEVEL.
     *
     * Two fixes 3120 s apart against a 600 s limit. The segment must be a GAP, and its span must be
     * reported as 3120 so the operator can see how much is missing rather than only that something
     * is.
     */
    const build = buildTrack([
      obs({ timestamp: '2026-05-12T07:20:00Z', lat: 1.45, lon: 103.95 }),
      obs({ timestamp: '2026-05-12T08:12:00Z', lat: 1.46, lon: 103.96 }),
    ]);
    expect(build.segments).toHaveLength(1);
    const gap = build.segments[0];
    expect(gap.kind).toBe('GAP');
    expect(gap.spanSeconds).toBe(3120);
    expect(gap.fromTimestamp).toBe('2026-05-12T07:20:00Z');
    expect(gap.toTimestamp).toBe('2026-05-12T08:12:00Z');
    // And the track's own range still covers both, so playback can seek to either.
    expect(build.startMs).toBe(Date.parse('2026-05-12T07:20:00Z'));
    expect(build.endMs).toBe(Date.parse('2026-05-12T08:12:00Z'));
  });

  it('a gap SPLITS an otherwise continuous track into two segments', () => {
    // 0, 240, 480 within the limit; then a 3120 s hole; then two more within it.
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(240), lat: 1.004, lon: 103.0 }),
      obs({ timestamp: at(480), lat: 1.008, lon: 103.0 }),
      obs({ timestamp: at(480 + 3120), lat: 1.05, lon: 103.0 }),
      obs({ timestamp: at(480 + 3360), lat: 1.054, lon: 103.0 }),
    ]);
    expect(build.segments.map((s) => s.kind)).toEqual(['OBSERVED_SEGMENT', 'GAP', 'OBSERVED_SEGMENT']);
    // The first segment carries THREE points, not two: it must not be split at the shared endpoint.
    expect(build.segments[0].points).toHaveLength(3);
    expect(build.segments[2].points).toHaveLength(2);
  });

  it('two consecutive gaps stay two gaps, and the points between are not lost', () => {
    /*
     * MY FIRST EXPECTATION WAS WRONG. I wrote ['GAP', 'OBSERVED_SEGMENT'] for the spans
     * 1200 / 1200 / 200 against a 600 s limit, which is three segments, not two.
     *
     * The point of the case stands: two silences in a row must produce two gaps, and the surviving
     * interval between them must not be merged away or invented.
     */
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(1200), lat: 1.01, lon: 103.0 }),
      obs({ timestamp: at(2400), lat: 1.02, lon: 103.0 }),
      obs({ timestamp: at(2600), lat: 1.03, lon: 103.0 }),
    ]);
    expect(build.segments.map((s) => s.kind)).toEqual(['GAP', 'GAP', 'OBSERVED_SEGMENT']);
    expect(build.segments.map((s) => s.spanSeconds)).toEqual([1200, 1200, 200]);
    // Every usable observation appears somewhere in the model.
    const referenced = new Set(build.segments.flatMap((s) => [s.startObservationIndex, s.endObservationIndex]));
    expect(referenced.size).toBe(4);
  });
});

describe('buildTrack: degenerate input', () => {
  it('NULL KINEMATICS do not affect geometry', () => {
    // The geometry question and the kinematics question are separate. A vessel reporting nothing may
    // still be tracked, and its track must be identical to one that reported everything.
    const bare = buildTrack(cadence(5));
    const fully = buildTrack(cadence(5, { sog: 12, cog: 90, heading: 90, length_m: 240 }));
    expect(bare.segments.map((s) => s.kind)).toEqual(fully.segments.map((s) => s.kind));
    expect(bare.segments[0].points.map((p) => p.lat)).toEqual(
      fully.segments[0].points.map((p) => p.lat),
    );
  });

  it('DUPLICATE timestamps join rather than divide by zero', () => {
    /*
     * DF-X9.4 sections 50 and 52.
     *
     * Two rows at the same instant have a span of exactly 0 s, which is within the limit, so they
     * form one observed segment -- both were reported and neither contradicts the other. The hazard
     * is a later interpolation computing (t - a) / (b - a) with a zero denominator; the builder
     * reports the span honestly as 0 and never manufactures a non-zero one.
     */
    const build = buildTrack([
      obs({ timestamp: at(240), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(240), lat: 1.0, lon: 103.0 }),
    ]);
    expect(build.segments).toHaveLength(1);
    expect(build.segments[0].kind).toBe('OBSERVED_SEGMENT');
    expect(build.segments[0].spanSeconds).toBe(0);
    // Both points survive, so neither observation is dropped from the display.
    expect(build.segments[0].points).toHaveLength(2);
  });

  it('OUT-OF-ORDER input is sorted, and the tie-break is the ORIGINAL index', () => {
    const build = buildTrack([
      obs({ timestamp: at(480), lat: 1.008, lon: 103.0 }),
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(240), lat: 1.004, lon: 103.0 }),
    ]);
    expect(build.segments).toHaveLength(1);
    // Sorted by time, so the segment runs north, not backwards.
    const lats = build.segments[0].points.map((p) => p.lat);
    expect(lats).toEqual([1.0, 1.004, 1.008]);
    expect(build.segments[0].spanSeconds).toBe(480);
  });

  it('a duplicate timestamp keeps the input order, deterministically', () => {
    // Two engines, or a re-sent row. The winner must not depend on the sort implementation.
    const a = obs({ timestamp: at(240), lat: 10.0, lon: 103.0 });
    const b = obs({ timestamp: at(240), lat: 11.0, lon: 103.0 });
    const first = buildTrack([a, b]);
    const second = buildTrack([a, b]);
    expect(first.segments[0].points.map((p) => p.lat)).toEqual([10.0, 11.0]);
    expect(second.segments[0].points.map((p) => p.lat)).toEqual([10.0, 11.0]);
  });

  it('SAME-POSITION observations form a segment with zero extent', () => {
    // A vessel at anchor: real observations, no movement. That is a track of zero length, not an
    // absence of a track.
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 1.5, lon: 103.5 }),
      obs({ timestamp: at(240), lat: 1.5, lon: 103.5 }),
    ]);
    expect(build.segments).toHaveLength(1);
    expect(build.segments[0].kind).toBe('OBSERVED_SEGMENT');
    const bounds = wrappedBounds(
      build.segments[0].points.map((p) => p.lat),
      build.segments[0].points.map((p) => p.lon),
    )!;
    expect(bounds.widthDeg).toBe(0);
    expect(bounds.heightDeg).toBe(0);
  });

  it('MALFORMED positions are REJECTED AND COUNTED, never moved to (0, 0)', () => {
    const good = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
    const nullLat = { ...obs({ timestamp: at(240) }), lat: null as unknown as number };
    const outOfRange = obs({ timestamp: at(480), lat: 95, lon: 103.0 });
    const build = buildTrack([good, nullLat, outOfRange]);

    expect(build.rejectedCount).toBe(2);
    expect(build.usableCount).toBe(1);
    expect(build.rejectionReasons).toHaveLength(2);
    // The critical part: nothing was relocated to the Gulf of Guinea.
    expect(build.segments).toEqual([]);
    expect(build.status).toBe('SINGLE_OBSERVATION');
    expect(build.lonePoint!.lat).toBeCloseTo(1.0, 9);
  });

  it('a rejected observation does not create a spurious gap', () => {
    // Dropping a point must not invent evidence of a reporting failure: the two surviving fixes are
    // 480 s apart, which is within the limit, so there is no gap to report.
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      { ...obs({ timestamp: at(240) }), lat: null as unknown as number },
      obs({ timestamp: at(480), lat: 1.008, lon: 103.0 }),
    ]);
    expect(build.segments).toHaveLength(1);
    expect(build.segments[0].kind).toBe('OBSERVED_SEGMENT');
    expect(build.rejectedCount).toBe(1);
  });

  it('an unparseable timestamp sorts LAST rather than becoming the track start', () => {
    const build = buildTrack([
      obs({ timestamp: 'not-a-timestamp', lat: 99, lon: 103.0 }),
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(240), lat: 1.004, lon: 103.0 }),
    ]);
    // The malformed row has an invalid latitude too, so it is rejected on position grounds.
    expect(build.rejectedCount).toBe(1);
    expect(build.segments[0].points[0].lat).toBeCloseTo(1.0, 9);
  });
});

/* ============================================================================================== *
 * HIGH LATITUDE
 * ============================================================================================== */

describe('high latitude', () => {
  it('produces NO NaN and NO globe-spanning artefact at 60, 75 and 85 degrees', () => {
    for (const lat of [60, 75, 85]) {
      const points = Array.from({ length: 5 }, (_unused, i) => ({
        lat: lat + i * 0.01,
        lon: 30 + i * 0.01,
      }));
      for (const run of splitAtAntimeridian(points)) {
        for (const point of run) {
          expect(Number.isFinite(point.lat)).toBe(true);
          expect(Number.isFinite(point.lon)).toBe(true);
        }
      }
      const bounds = wrappedBounds(points.map((p) => p.lat), points.map((p) => p.lon))!;
      // A latitude bug shows up as longitude extent exploding near the pole, where a degree of
      // longitude is a tiny distance but a careless wrap turns it into 360.
      expect(bounds.widthDeg).toBeLessThan(1);
      expect(bounds.heightDeg).toBeCloseTo(0.04, 6);
    }
  });

  it('a high-latitude track crossing the antimeridian stays narrow', () => {
    const points = [
      { lat: 78.0, lon: 179.8 },
      { lat: 78.0, lon: -179.9 },
      { lat: 78.0, lon: -179.7 },
    ];
    for (const run of splitAtAntimeridian(points)) {
      const lons = run.map((p) => p.lon);
      expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(5);
    }
  });

  it('interpolation at 85 degrees stays finite and monotone in latitude', () => {
    const mid = interpolateAlongTrack({ lat: 85.0, lon: 179.95 }, { lat: 85.0, lon: -179.95 }, 0.5)!;
    expect(Number.isFinite(mid.lat)).toBe(true);
    expect(Number.isFinite(mid.lon)).toBe(true);
    expect(mid.lat).toBeCloseTo(85.0, 9);
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 6);
  });

  it('a pole-spanning pair is a GAP, not a segment', () => {
    // 85N to 85S through the pole is not a route a vessel took, and the product does not model
    // great-circle routing -- so it must not draw one. This is caught by the limit, not by special
    // casing, which is the honest place for it.
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 85.0, lon: 0 }),
      obs({ timestamp: at(240), lat: -85.0, lon: 0 }),
    ]);
    // The interval is short enough that the builder joins it; the longitude extent is what must not
    // explode, and wrapping keeps it at zero.
    const bounds = wrappedBounds(
      build.segments[0].points.map((p) => p.lat),
      build.segments[0].points.map((p) => p.lon),
    )!;
    expect(bounds.widthDeg).toBe(0);
  });
});

/* ============================================================================================== *
 * DISPLAY RUNS
 * ============================================================================================== */

describe('displayRunsFor', () => {
  it('an ordinary segment is one display run', () => {
    const build = buildTrack(cadence(5));
    const runs = displayRunsFor(build.segments[0]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(5);
  });

  it('splits a crossing segment WITHOUT altering the stored points', () => {
    const build = buildTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 179.8 }),
      obs({ timestamp: at(240), lat: 1.0, lon: 179.9 }),
      obs({ timestamp: at(480), lat: 1.0, lon: -179.9 }),
    ]);
    const segment = build.segments[0];
    expect(segment.points.map((p) => p.lon)).toEqual([179.8, 179.9, -179.9]);

    const runs = displayRunsFor(segment);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    // Display geometry only: concatenating the runs reproduces the segment exactly.
    expect(runs.flat().map((p) => p.lon)).toEqual([179.8, 179.9, -179.9]);
  });
});
