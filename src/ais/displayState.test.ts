/**
 * Tests for the AIS display-state model.
 *
 * Every test names THE FAILURE IT PREVENTS, not just the behaviour it asserts. A test that only
 * pins current behaviour cannot be read a year later to tell whether it guards a real hazard or
 * merely freezes an accident.
 *
 * The recurring theme: ABSENCE MUST NOT BECOME ZERO, and DERIVED MUST NOT BECOME OBSERVED.
 */

import { describe, expect, it } from 'vitest';
import type { AisObservationOut } from '../api/contract';
import {
  CORRELATION_WINDOW_S,
  MAX_INTERPOLATION_INTERVAL_S,
  MIN_DERIVED_DISPLACEMENT_M,
  MIN_MOTION_KNOTS,
  OBSERVED_CADENCE_S,
  approachDegrees,
  byTime,
  circularDeltaDeg,
  courseOverGround,
  displayStateOf,
  freshnessOf,
  initialBearingDeg,
  interpolateForDisplay,
  inTimeOrder,
  isMoving,
  normalizeDegrees,
  predictedDisplayState,
  resolveOrientation,
  segmentTrack,
  speedKnots,
  stabilizeOrientation,
  surfaceDistanceM,
  trueHeading,
} from './displayState';

/* ------------------------------------------------------------------ fixtures */

function obs(over: Partial<AisObservationOut> & { timestamp: string }): AisObservationOut {
  return {
    mmsi: '257000000',
    lat: 1.0,
    lon: 103.0,
    sog: null,
    cog: null,
    heading: null,
    nav_status: null,
    ship_name: null,
    callsign: null,
    imo: null,
    ship_type: null,
    length_m: null,
    width_m: null,
    source: 'aistream',
    ...over,
  };
}

const T0 = '2026-03-01T12:00:00Z';
const at = (minutes: number): string =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/**
 * A timestamp a given number of SECONDS after T0.
 *
 * Written as a function rather than inlined as `at(0) + seconds * 1000`, because string plus
 * number in JavaScript is CONCATENATION, not addition: it silently yields
 * "2026-03-01T12:00:00.000Z2400000", which `Date.parse` returns NaN for. Four tests in the first
 * draft of this file failed that way and the error surfaced as a null span rather than as a
 * malformed timestamp, which is a poor way to be told about a typo.
 */
const atSeconds = (seconds: number): string =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();

/* ================================================================================================
 * CIRCULAR ANGLES
 * ============================================================================================== */

describe('circular angle handling', () => {
  it('normalises into [0, 360) from both directions', () => {
    expect(normalizeDegrees(0)).toBe(0);
    expect(normalizeDegrees(359.9)).toBeCloseTo(359.9, 6);
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(361)).toBe(1);
    expect(normalizeDegrees(-1)).toBe(359);
    expect(normalizeDegrees(-359)).toBe(1);
    expect(normalizeDegrees(720.5)).toBeCloseTo(0.5, 6);
  });

  it('359 to 1 rotates by 2 degrees, not 358', () => {
    // THE regression DF-X9 §14 names. A naive subtraction gives -358, which would make the
    // stabiliser spin a glyph almost all the way round to correct a 2-degree wobble.
    expect(circularDeltaDeg(359, 1)).toBeCloseTo(2, 6);
    expect(circularDeltaDeg(1, 359)).toBeCloseTo(-2, 6);
    // And the naive value is what we are NOT doing:
    expect(Math.abs(circularDeltaDeg(359, 1))).toBeLessThan(3);
  });

  it('treats +180 and -180 as the same rotation with one representation', () => {
    expect(circularDeltaDeg(0, 180)).toBe(180);
    expect(circularDeltaDeg(0, -180)).toBe(180);
  });

  it('stays small across the whole circle', () => {
    let worst = 0;
    for (let a = 0; a < 360; a += 7) {
      for (let b = 0; b < 360; b += 11) {
        const d = circularDeltaDeg(a, b);
        expect(d).toBeGreaterThan(-180.000001);
        expect(d).toBeLessThanOrEqual(180.000001);
        worst = Math.max(worst, Math.abs(d));
      }
    }
    expect(worst).toBeLessThanOrEqual(180);
  });

  it('returns NaN for non-finite input rather than a plausible number', () => {
    // A NaN angle must not become 0 by falling through an abs().
    expect(Number.isNaN(normalizeDegrees(Number.NaN))).toBe(true);
    expect(Number.isNaN(circularDeltaDeg(Number.NaN, 90))).toBe(true);
  });
});

describe('rate-limited approach', () => {
  it('snaps when within the step limit', () => {
    expect(approachDegrees(10, 12, 5)).toBeCloseTo(12, 6);
  });

  it('moves by at most the limit, the short way round', () => {
    const next = approachDegrees(359, 1, 5);
    // 359 -> 1 is +2, so with a limit of 5 it should arrive, not travel 358.
    expect(next).toBeCloseTo(1, 6);
    const partial = approachDegrees(0, 90, 10);
    expect(partial).toBeCloseTo(10, 6);
  });

  it('crosses the antimeridian by the short route', () => {
    const next = approachDegrees(358, 2, 10);
    expect(next).toBeCloseTo(2, 6);
  });
});

/* ================================================================================================
 * ABSENCE IS NOT ZERO
 * ============================================================================================== */

describe('absence is never read as zero', () => {
  it('null and undefined measure as absent', () => {
    expect(speedKnots(obs({ timestamp: T0, sog: null }))).toBeNull();
    expect(speedKnots(obs({ timestamp: T0, sog: undefined }))).toBeNull();
    expect(courseOverGround(obs({ timestamp: T0, cog: null }))).toBeNull();
    expect(trueHeading(obs({ timestamp: T0, heading: null }))).toBeNull();
  });

  it('a MEASURED zero stays zero', () => {
    // The distinction the whole model rests on: course 0 is due north and speed 0 is at anchor.
    // Reading either as "no data" would throw away real measurements.
    expect(courseOverGround(obs({ timestamp: T0, cog: 0 }))).toBe(0);
    expect(speedKnots(obs({ timestamp: T0, sog: 0 }))).toBe(0);
    expect(trueHeading(obs({ timestamp: T0, heading: 0 }))).toBe(0);
  });

  it('non-finite measures as absent', () => {
    expect(speedKnots(obs({ timestamp: T0, sog: Number.NaN }))).toBeNull();
    expect(courseOverGround(obs({ timestamp: T0, cog: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it('a course of 360 normalises to 0 rather than reading as absent', () => {
    // The AIS spec permits 360 as synonymous with 0. It is a measurement.
    expect(courseOverGround(obs({ timestamp: T0, cog: 360 }))).toBe(0);
  });
});

/* ================================================================================================
 * TIME ORDER
 * ============================================================================================== */

describe('archive time order', () => {
  it('sorts ascending without mutating the input', () => {
    const input = [obs({ timestamp: at(8) }), obs({ timestamp: at(0) }), obs({ timestamp: at(4) })];
    const sorted = inTimeOrder(input);
    expect(sorted.map((o) => o.timestamp)).toEqual([at(0), at(4), at(8)]);
    expect(input[0].timestamp).toBe(at(8));
  });

  it('puts unparseable timestamps last instead of corrupting the order', () => {
    const sorted = inTimeOrder([
      obs({ timestamp: 'not-a-time' }),
      obs({ timestamp: at(4) }),
    ]);
    expect(sorted[0].timestamp).toBe(at(4));
    expect(sorted[1].timestamp).toBe('not-a-time');
  });

  it('orders the antimeridian-crossing pair without a special case', () => {
    const east = obs({ timestamp: at(0), lon: 179.8 });
    const west = obs({ timestamp: at(4), lon: -179.9 });
    expect(inTimeOrder([west, east]).map((o) => o.lon)).toEqual([179.8, -179.9]);
  });
});

/* ================================================================================================
 * ORIENTATION PRECEDENCE: heading -> COG -> derived -> unknown
 * ============================================================================================== */

describe('orientation precedence', () => {
  it('a valid true heading wins over everything', () => {
    // Heading and COG deliberately disagree: the vessel is crabbing across a current. The
    // hull is what the glyph represents, so the hull wins.
    const o = resolveOrientation([obs({ timestamp: T0, sog: 8, cog: 45, heading: 200 })]);
    expect(o.source).toBe('HEADING');
    expect(o.degrees).toBe(200);
  });

  it('falls back to COG when heading is absent and the vessel is moving', () => {
    const o = resolveOrientation([obs({ timestamp: T0, sog: 8, cog: 45, heading: null })]);
    expect(o.source).toBe('COG');
    expect(o.degrees).toBe(45);
  });

  it('derives from observed movement when no course was reported', () => {
    const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
    const b = obs({ timestamp: at(4), lat: 1.0, lon: 103.02 });
    const o = resolveOrientation([a, b]);
    expect(o.source).toBe('DERIVED_TRACK');
    expect(o.degrees).not.toBeNull();
    // Due east at the equator.
    expect(o.degrees!).toBeCloseTo(90, 0);
  });

  it('answers UNKNOWN rather than 0 degrees when nothing establishes a direction', () => {
    const o = resolveOrientation([obs({ timestamp: T0 })]);
    expect(o.source).toBe('UNKNOWN');
    // THE assertion. 0 degrees is due north -- a claim nobody made.
    expect(o.degrees).toBeNull();
  });

  it('UNKNOWN on an empty observation set', () => {
    const o = resolveOrientation([]);
    expect(o.source).toBe('UNKNOWN');
    expect(o.degrees).toBeNull();
    expect(o.reason).not.toBe('');
  });

  it('names the observation every orientation was read from', () => {
    const o = resolveOrientation([obs({ timestamp: at(0) }), obs({ timestamp: at(4), heading: 12 })]);
    expect(o.source).toBe('HEADING');
    expect(o.observedAt).toBe(at(4));
  });

  it('explains why an orientation was chosen', () => {
    const o = resolveOrientation([obs({ timestamp: T0, sog: 5, cog: 10 })]);
    expect(o.reason.length).toBeGreaterThan(0);
  });
});

describe('near-zero speed stability', () => {
  it('refuses COG below the minimum motion threshold', () => {
    // THE defect DF-X9 §13 names: at near-zero speed AIS COG jitters freely, and rotating the
    // glyph by that noise makes an anchored vessel appear to be manoeuvring.
    const jittery = resolveOrientation([obs({ timestamp: T0, sog: 0.02, cog: 350 })]);
    expect(jittery.source).not.toBe('COG');
  });

  it('accepts COG at exactly the threshold', () => {
    const o = resolveOrientation([obs({ timestamp: T0, sog: MIN_MOTION_KNOTS, cog: 45 })]);
    expect(o.source).toBe('COG');
  });

  it('a heading survives even at zero speed', () => {
    // Heading describes the HULL, so a vessel at anchor still reports where it points. The
    // motion gate applies to COG only.
    const o = resolveOrientation([obs({ timestamp: T0, sog: 0, cog: 350, heading: 275 })]);
    expect(o.source).toBe('HEADING');
    expect(o.degrees).toBe(275);
  });

  it('falls back to derived movement when COG is refused for near-zero reported speed', () => {
    // Reported speed says "not moving", but the vessel demonstrably travelled 2 km. Positions
    // are ground truth, so they can still define a direction.
    const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0, sog: 0.01, cog: 350 });
    const b = obs({ timestamp: at(4), lat: 1.0, lon: 103.02, sog: 0.01, cog: 340 });
    const o = resolveOrientation([a, b]);
    expect(o.source).toBe('DERIVED_TRACK');
  });

  it('isMoving uses reported speed when there is one', () => {
    expect(isMoving([obs({ timestamp: T0, sog: 5 })])).toBe(true);
    expect(isMoving([obs({ timestamp: T0, sog: 0 })])).toBe(false);
  });

  it('isMoving falls back to ground distance when no speed was reported', () => {
    // Two well-separated fixes with no speed: the vessel moved, whatever it failed to report.
    const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
    const b = obs({ timestamp: at(4), lat: 1.0, lon: 103.02 });
    expect(isMoving([a, b])).toBe(true);
    expect(isMoving([a])).toBe(false);
  });

  it('two coincident fixes do not establish motion', () => {
    const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
    const b = obs({ timestamp: at(4), lat: 1.0, lon: 103.0 });
    expect(isMoving([a, b])).toBe(false);
  });
});

describe('derived heading needs a real separation', () => {
  it('refuses to derive a heading from noise-level separation', () => {
    // Sub-metre separation is position noise, not a course. Deriving 0 degrees (or any
    // direction) from it would invent an orientation.
    const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
    const b = obs({ timestamp: at(4), lat: 1.00001, lon: 103.0 });
    expect(surfaceDistanceM(a.lat, a.lon, b.lat, b.lon)).toBeLessThan(
      MIN_DERIVED_DISPLACEMENT_M,
    );
    expect(resolveOrientation([a, b]).source).toBe('UNKNOWN');
  });

  it('accepts a separation just above the threshold', () => {
    const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
    const b = obs({ timestamp: at(4), lat: 1.0, lon: 103.0005 });
    expect(surfaceDistanceM(a.lat, a.lon, b.lat, b.lon)).toBeGreaterThanOrEqual(
      MIN_DERIVED_DISPLACEMENT_M,
    );
    expect(resolveOrientation([a, b]).source).toBe('DERIVED_TRACK');
  });
});

/* ================================================================================================
 * HIGH LATITUDE
 * ============================================================================================== */

describe('orientation at high latitude', () => {
  it('eastbound at 78N still bears 090', () => {
    // DF-X9 §16. A contact heading 090 at high latitude must point along LOCAL east. If the
    // bearing came out as something else, the display would be rotating by screen angle rather
    // than by a geographic one.
    expect(initialBearingDeg(78, 15, 78, 15.02)).toBeCloseTo(90, 0);
  });

  it('eastbound at the equator bears 090', () => {
    expect(initialBearingDeg(0, 103, 0, 103.02)).toBeCloseTo(90, 0);
  });

  it('northbound at high latitude bears close to 000, not 090', () => {
    expect(initialBearingDeg(78, 15, 78.02, 15)).toBeCloseTo(0, 0);
  });

  it('meridian convergence does not distort an eastbound course', () => {
    // The failure this pins: rotating by a SCREEN angle instead of a geographic one makes a
    // high-latitude vessel appear to travel diagonally.
    const equator = initialBearingDeg(0, 0, 0, 0.02);
    const high = initialBearingDeg(80, 0, 80, 0.02);
    expect(Math.abs(equator - high)).toBeLessThan(1);
  });
});

describe('antimeridian-aware bearing', () => {
  it('reads a step across the antimeridian as continuing east', () => {
    // 179.9E -> 179.9W is 0.2 degrees EAST, not 359.8 degrees west.
    const bearing = initialBearingDeg(0, 179.9, 0, -179.9);
    expect(bearing).toBeCloseTo(90, 0);
  });

  it('walks the full DF-X9 §41 track eastward without a world-spanning bearing', () => {
    const path: Array<[number, number]> = [
      [179.8, 0],
      [179.9, 0],
      [-179.9, 0],
      [-179.7, 0],
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const [lonA] = path[i];
      const [lonB] = path[i + 1];
      const b = initialBearingDeg(0, lonA, 0, lonB);
      expect(b).toBeGreaterThan(80);
      expect(b).toBeLessThan(100);
    }
  });
});

/* ================================================================================================
 * FRESHNESS
 * ============================================================================================== */

describe('freshness tiers', () => {
  const one = (minutesAgo: number): AisObservationOut[] => [
    obs({ timestamp: at(-minutesAgo) }),
  ];

  it('is CURRENT within one cadence interval', () => {
    const r = freshnessOf(one(1), T0);
    expect(r.tier).toBe('CURRENT');
    expect(r.ageSeconds).toBe(60);
  });

  it('is AGING beyond one cadence interval', () => {
    const r = freshnessOf(one(OBSERVED_CADENCE_S / 60 + 1), T0);
    expect(r.tier).toBe('AGING');
  });

  it('is STALE beyond two cadence intervals', () => {
    const r = freshnessOf(one((2 * OBSERVED_CADENCE_S) / 60 + 1), T0);
    expect(r.tier).toBe('STALE');
  });

  it('is LOST beyond the correlation window', () => {
    // The product's own science boundary: `match.py:168` excludes such observations entirely,
    // so the display must not present one as current.
    const r = freshnessOf(one(CORRELATION_WINDOW_S / 60 + 5), T0);
    expect(r.tier).toBe('LOST');
  });

  it('respects exact boundaries inclusively', () => {
    expect(freshnessOf([obs({ timestamp: at(-OBSERVED_CADENCE_S / 60) })], T0).tier).toBe(
      'CURRENT',
    );
    expect(freshnessOf([obs({ timestamp: at(-(2 * OBSERVED_CADENCE_S) / 60) })], T0).tier).toBe(
      'AGING',
    );
    expect(
      freshnessOf([obs({ timestamp: at(-CORRELATION_WINDOW_S / 60) })], T0).tier,
    ).toBe('STALE');
  });

  it('is measured against the reference time, never the wall clock', () => {
    // THE property DF-X9 requires. A historical scan viewed today must not read as ancient:
    // this deployment has no live feed, and wall-clock staleness would assert that every
    // vessel stopped transmitting -- a confident false claim.
    const r = freshnessOf(one(4), T0);
    expect(r.tier).toBe('CURRENT');
    expect(r.ageSeconds).toBe(240);
  });

  it('reports no age for an observation newer than the reference, rather than a negative', () => {
    const r = freshnessOf([obs({ timestamp: at(5) })], T0);
    expect(r.tier).toBe('CURRENT');
    expect(r.ageSeconds).toBeNull();
    expect(r.labelSeconds).toBeNull();
  });

  it('no observations is LOST with no age', () => {
    const r = freshnessOf([], T0);
    expect(r.tier).toBe('LOST');
    expect(r.ageSeconds).toBeNull();
  });

  it('uses the LATEST observation, not the oldest', () => {
    const many = [obs({ timestamp: at(-60) }), obs({ timestamp: at(-1) })];
    expect(freshnessOf(many, T0).tier).toBe('CURRENT');
  });

  it('documents the threshold it applied', () => {
    expect(freshnessOf(one(1), T0).thresholdReason).toContain(String(OBSERVED_CADENCE_S));
  });

  it('says nothing about a transponder', () => {
    // DF-X9 §28: STALE must never become "AIS TURNED OFF". The vocabulary must not contain it.
    for (const minutes of [0, 5, 10, 30, 120]) {
      const r = freshnessOf(one(minutes), T0);
      const text = `${r.tier} ${r.thresholdReason}`.toLowerCase();
      expect(text).not.toMatch(/transponder|turned off|disabled|switched off/);
    }
  });
});

/* ================================================================================================
 * INTERPOLATION
 * ============================================================================================== */

describe('display interpolation', () => {
  const a = obs({ timestamp: at(0), lat: 1.0, lon: 103.0 });
  const b = obs({ timestamp: at(4), lat: 1.004, lon: 103.0 });

  it('produces a midpoint between two observations', () => {
    const mid = interpolateForDisplay(a, b, 0.5)!;
    expect(mid.lat).toBeCloseTo(1.002, 6);
    expect(mid.lon).toBeCloseTo(103.0, 6);
  });

  it('returns exactly the endpoints at 0 and 1', () => {
    expect(interpolateForDisplay(a, b, 0)).toEqual({ lat: 1.0, lon: 103.0 });
    expect(interpolateForDisplay(b, a, 0)).toEqual({ lat: 1.004, lon: 103.0 });
  });

  it('clamps a fraction outside [0, 1] rather than extrapolating', () => {
    // Extrapolating past an observation would invent positions in neither measurement.
    expect(interpolateForDisplay(a, b, 2)!.lat).toBeCloseTo(1.004, 6);
    expect(interpolateForDisplay(a, b, -1)!.lat).toBeCloseTo(1.0, 6);
  });

  it('DECLINES to interpolate across a gap beyond the limit', () => {
    // DF-X9 §8. The limit sits below CORRELATION_WINDOW_S so the display never animates
    // through water the correlation has already disclaimed.
    const late = obs({ timestamp: at(0) + (MAX_INTERPOLATION_INTERVAL_S / 60 + 1) * 60_000, lat: 1.004 });
    expect(interpolateForDisplay(a, late, 0.5)).toBeNull();
  });

  it('interpolates at exactly the limit', () => {
    const edge = obs({ timestamp: atSeconds(MAX_INTERPOLATION_INTERVAL_S), lat: 1.004 });
    expect(interpolateForDisplay(a, edge, 0.5)).not.toBeNull();
  });

  it('keeps the limit below the correlation window', () => {
    // A structural property, asserted so the two constants cannot drift into an
    // inconsistent relationship later.
    expect(MAX_INTERPOLATION_INTERVAL_S).toBeLessThan(CORRELATION_WINDOW_S);
    expect(MAX_INTERPOLATION_INTERVAL_S).toBeGreaterThan(OBSERVED_CADENCE_S);
  });

  it('returns null when an observation has no coordinates', () => {
    const broken = obs({ timestamp: at(4), lat: Number.NaN });
    expect(interpolateForDisplay(a, broken, 0.5)).toBeNull();
  });

  it('interpolates the short way across the antimeridian', () => {
    const east = obs({ timestamp: at(0), lon: 179.9, lat: 0 });
    const west = obs({ timestamp: at(4), lon: -179.9, lat: 0 });
    const mid = interpolateForDisplay(east, west, 0.5)!;
    // The half-way point from 179.9E to 179.9W the SHORT way is exactly 180, because the two
    // ends are symmetric about the antimeridian. 0 is also 180 numerically, but reaching 0 here
    // would mean the contact swept 359.8 degrees across the planet.
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 3);
    // And each step from the endpoint is a tenth of a degree, not half the world.
    expect(Math.abs(Math.abs(mid.lon) - 179.9)).toBeCloseTo(0.1, 3);
  });

  it('declines when the two observations are antipodal in longitude', () => {
    // Two equally short ways round; picking one would be an invention.
    const west = obs({ timestamp: at(0), lon: 0 });
    const east = obs({ timestamp: at(4), lon: 180 });
    expect(interpolateForDisplay(west, east, 0.5)).toBeNull();
  });
});

/* ================================================================================================
 * DISPLAY STATE
 * ============================================================================================== */

describe('display contact state', () => {
  const series = [
    obs({ timestamp: at(0), lat: 1.0, lon: 103.0, sog: 8, cog: 90, heading: 90 }),
    obs({ timestamp: at(4), lat: 1.004, lon: 103.0, sog: 8, cog: 90, heading: 90 }),
  ];

  it('is OBSERVED at the instant of a real fix', () => {
    const s = displayStateOf(series, at(4));
    expect(s.state).toBe('OBSERVED');
    expect(s.lat).toBeCloseTo(1.004, 6);
    expect(s.at).toBe(at(4));
    expect(s.sourceObservationTimestamps).toEqual([at(4)]);
  });

  it('is INTERPOLATED_DISPLAY strictly between two fixes', () => {
    const s = displayStateOf(series, at(2));
    expect(s.state).toBe('INTERPOLATED_DISPLAY');
    expect(s.lat).toBeGreaterThan(1.0);
    expect(s.lat).toBeLessThan(1.004);
  });

  it('an interpolated state names BOTH bracketing observations', () => {
    // The field that makes the derived value auditable. It must never claim a single source.
    const s = displayStateOf(series, at(2));
    expect(s.sourceObservationTimestamps).toEqual([at(0), at(4)]);
  });

  it('never reports an interpolated position as an observation timestamp', () => {
    const s = displayStateOf(series, at(2));
    expect(s.at).toBe(at(2));
    expect(s.sourceObservationTimestamps).not.toContain(at(2));
  });

  it('does NOT interpolate across a gap -- it stays at the last real fix and says STALE', () => {
    const gapped = [
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({
        timestamp: at(0) + (MAX_INTERPOLATION_INTERVAL_S / 60 + 30) * 60_000,
        lat: 2.0,
        lon: 104.0,
      }),
    ];
    const s = displayStateOf(gapped, gapped[1].timestamp);
    expect(s.state).not.toBe('INTERPOLATED_DISPLAY');
    // Drawn at a real fix, never at a point in the hole.
    expect(s.sourceObservationTimestamps).toEqual([gapped[1].timestamp]);
  });

  it('is STALE when the latest fix has aged', () => {
    const old = [
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0 }),
    ];
    // Reference time far past the last fix, so freshness has aged but no interpolation applies.
    const s = displayStateOf(old, at(4 + CORRELATION_WINDOW_S / 60 - 1));
    expect(s.state).toBe('STALE');
  });

  it('is LOST beyond the correlation window', () => {
    const s = displayStateOf([obs({ timestamp: at(0) })], at(CORRELATION_WINDOW_S / 60 + 10));
    expect(s.state).toBe('LOST');
  });

  it('has nothing to draw with no observations', () => {
    const s = displayStateOf([], T0);
    expect(s.state).toBe('LOST');
    expect(s.lat).toBeNull();
    expect(s.lon).toBeNull();
    expect(s.sourceObservationTimestamps).toEqual([]);
  });

  it('carries the REPORTED values unmodified alongside any smoothing', () => {
    // DF-X9 §19: expose the raw value. Smoothing is a rendering decision and must not be the
    // only number available anywhere.
    const s = displayStateOf(series, at(2));
    expect(s.reported).not.toBeNull();
    expect(s.reported!.sogKnots).toBe(8);
    expect(s.reported!.cogDegrees).toBe(90);
    expect(s.reported!.headingDegrees).toBe(90);
  });

  it('reported values preserve the difference between zero and absent', () => {
    const absent = displayStateOf([obs({ timestamp: at(0), sog: null, cog: null })], at(0));
    expect(absent.reported!.sogKnots).toBeNull();
    expect(absent.reported!.cogDegrees).toBeNull();

    const measuredZero = displayStateOf([obs({ timestamp: at(0), sog: 0, cog: 0 })], at(0));
    expect(measuredZero.reported!.sogKnots).toBe(0);
    expect(measuredZero.reported!.cogDegrees).toBe(0);
  });

  it('reports orientation alongside state, so a contact always points somewhere honest', () => {
    const s = displayStateOf([obs({ timestamp: at(0), heading: 275 })], at(0));
    expect(s.orientation.source).toBe('HEADING');
    expect(s.orientation.degrees).toBe(275);
  });
});

describe('predicted position stays its own thing', () => {
  const series = [obs({ timestamp: at(0), lat: 1.0, lon: 103.0, sog: 10, cog: 90 })];

  it('is a distinct state from observed', () => {
    const p = predictedDisplayState('257000000', { lat: 1.05, lon: 103.0 }, series, at(4));
    expect(p.state).toBe('PREDICTED');
    expect(p.state).not.toBe('OBSERVED');
    expect(p.state).not.toBe('INTERPOLATED_DISPLAY');
  });

  it('claims NO source observations', () => {
    // The prediction was derived from one observation plus a speed, a course and a time delta,
    // by the backend. Listing the observations here would claim a provenance it lacks.
    const p = predictedDisplayState('257000000', { lat: 1.05, lon: 103.0 }, series, at(4));
    expect(p.sourceObservationTimestamps).toEqual([]);
  });

  it('has no observation timestamp at all', () => {
    const p = predictedDisplayState('257000000', { lat: 1.05, lon: 103.0 }, series, at(4));
    expect(p.at).toBeNull();
  });

  it('is still PREDICTED when there is no prediction to draw', () => {
    const p = predictedDisplayState('257000000', null, series, at(4));
    expect(p.state).toBe('PREDICTED');
    expect(p.lat).toBeNull();
  });

  it('refuses a non-finite prediction rather than drawing it', () => {
    const p = predictedDisplayState(
      '257000000',
      { lat: Number.NaN, lon: 103 },
      series,
      at(4),
    );
    expect(p.lat).toBeNull();
  });

  it('a predicted point is never produced by interpolating observations', () => {
    // Belt and braces: no path through displayStateOf can yield PREDICTED.
    const s = displayStateOf(series, at(4));
    expect(s.state).not.toBe('PREDICTED');
  });
});

/* ================================================================================================
 * STABILISATION
 * ============================================================================================== */

describe('display stabilisation does not touch analytical values', () => {
  it('takes the first raw value as-is', () => {
    expect(stabilizeOrientation(null, 45, 10, 2)).toBe(45);
  });

  it('holds still inside the deadband', () => {
    // A vessel on a steady course reports 091 then 092. That is not a turn.
    expect(stabilizeOrientation(90, 91, 10, 2)).toBe(90);
  });

  it('moves outside the deadband', () => {
    expect(stabilizeOrientation(90, 95, 10, 2)).toBeCloseTo(95, 6);
  });

  it('rate-limits a large turn', () => {
    expect(stabilizeOrientation(0, 90, 10, 1)).toBeCloseTo(10, 6);
  });

  it('crosses the antimeridian without spinning the long way', () => {
    // THE regression: naive subtraction here gives -358, and the glyph would rotate almost all
    // the way round to correct a 2-degree wobble.
    const next = stabilizeOrientation(359, 1, 10, 0.5);
    expect(next).not.toBeNull();
    expect(Math.abs(circularDeltaDeg(359, next as number))).toBeLessThanOrEqual(10);
  });

  it('keeps the previous angle when the new raw value is absent', () => {
    // A contact losing its heading must not snap to 0. Holding the last drawn angle is the
    // least-invention option; the dossier still shows that the raw value is now absent.
    expect(stabilizeOrientation(120, null, 10, 2)).toBe(120);
  });

  it('does not manufacture an angle from an absent first value', () => {
    expect(stabilizeOrientation(null, null, 10, 2)).toBeNull();
  });

  it('the input is a value, so nothing is mutated by construction', () => {
    const raw = { value: 359 };
    stabilizeOrientation(1, raw.value, 10, 0.5);
    expect(raw.value).toBe(359);
  });
});

/* ================================================================================================
 * TRACK SEGMENTATION
 * ============================================================================================== */

describe('track segmentation', () => {
  it('a single fix is not a track', () => {
    // DF-X9 §50.
    expect(segmentTrack([obs({ timestamp: at(0) })])).toEqual([]);
    expect(segmentTrack([])).toEqual([]);
  });

  it('joins fixes inside the interval limit into one observed segment', () => {
    const s = segmentTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0 }),
      obs({ timestamp: at(8), lat: 1.008, lon: 103.0 }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('OBSERVED');
    expect(s[0].points).toHaveLength(3);
    expect(s[0].fromTimestamp).toBe(at(0));
    expect(s[0].toTimestamp).toBe(at(8));
  });

  it('breaks at a gap beyond the interval limit', () => {
    // DF-X9 §26: a gap must be visible, not a confident line across missing data.
    const gapAt = MAX_INTERPOLATION_INTERVAL_S + 1800;
    const s = segmentTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0 }),
      obs({ timestamp: atSeconds(gapAt), lat: 2.0, lon: 104.0 }),
      obs({ timestamp: atSeconds(gapAt + 240), lat: 2.004, lon: 104.0 }),
    ]);
    expect(s.some((seg) => seg.kind === 'GAP')).toBe(true);
    // Two observed stretches, plus one gap.
    expect(s.filter((seg) => seg.kind === 'OBSERVED')).toHaveLength(2);
  });

  it('does not bridge the gap with observed points', () => {
    const gapAt = MAX_INTERPOLATION_INTERVAL_S + 1800;
    const s = segmentTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: atSeconds(gapAt), lat: 2.0, lon: 104.0 }),
    ]);
    const observed = s.filter((seg) => seg.kind === 'OBSERVED');
    // No observed segment exists at all, so nothing is drawn as a continuous trajectory.
    expect(observed).toHaveLength(0);
  });

  it('a gap records its endpoints and an honest span', () => {
    const gapAt = MAX_INTERPOLATION_INTERVAL_S + 1800;
    const s = segmentTrack([
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: atSeconds(gapAt), lat: 2.0, lon: 104.0 }),
    ]);
    const gap = s.find((seg) => seg.kind === 'GAP')!;
    expect(gap.fromTimestamp).toBe(at(0));
    expect(gap.toTimestamp).toBe(atSeconds(gapAt));
    expect(gap.spanSeconds).toBeCloseTo(gapAt, 3);
  });

  it('an antimeridian track is not drawn across the world', () => {
    // DF-X9 §41, permanent. Every consecutive pair is a short step eastward.
    const s = segmentTrack([
      obs({ timestamp: at(0), lon: 179.8, lat: 0 }),
      obs({ timestamp: at(4), lon: 179.9, lat: 0 }),
      obs({ timestamp: at(8), lon: -179.9, lat: 0 }),
      obs({ timestamp: at(12), lon: -179.7, lat: 0 }),
    ]);
    expect(s).toHaveLength(1);
    for (let i = 0; i < s[0].points.length - 1; i += 1) {
      const a = s[0].points[i].lon;
      const b = s[0].points[i + 1].lon;
      // Wrap-aware, so this measures the 0.2-degree step rather than the 359.8-degree one.
      // `Math.abs(b - a)` alone would read 359.8 and the assertion below would fail for the
      // right reason if the renderer ever drew the long way.
      const step = Math.abs(circularDeltaDeg(a, b));
      // A single 0.2-degree step, never a 359.8-degree sweep.
      expect(step).toBeLessThan(1);
    }
  });

  it('a high-latitude track does not crash or produce absurd segments', () => {
    // DF-X9 §42.
    const s = segmentTrack([
      obs({ timestamp: at(0), lat: 79.0, lon: 15.0 }),
      obs({ timestamp: at(4), lat: 79.2, lon: 15.4 }),
      obs({ timestamp: at(8), lat: 79.4, lon: 15.8 }),
    ]);
    expect(s).toHaveLength(1);
    for (const p of s[0].points) {
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Number.isFinite(p.lon)).toBe(true);
      expect(p.lat).toBeGreaterThanOrEqual(-90);
      expect(p.lat).toBeLessThanOrEqual(90);
    }
  });

  it('orders fixes before segmenting', () => {
    const s = segmentTrack([
      obs({ timestamp: at(8), lat: 1.008, lon: 103.0 }),
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0 }),
    ]);
    expect(s[0].points.map((p) => p.lat)).toEqual([1.0, 1.004, 1.008]);
  });
});

/* ================================================================================================
 * ANTI-REGRESSION: the invariants DF-X9 exists to hold, asserted together
 * ============================================================================================== */

describe('the defining invariant', () => {
  it('NEVER extrapolates past the newest observation', () => {
    // THE regression this file's second draft was written against.
    //
    // The first implementation interpolated whenever the reference time was at or after the
    // latest fix, with fraction `(reference - latest) / (reference - previous)`. For a
    // reference time 14 minutes past a fix that arrived at minute 4, that is 14/18 = 0.78
    // between the previous fix (minute 0) and the latest one (minute 4) -- a position roughly
    // three quarters of the way PAST the newest observation, drawn smoothly, with the
    // freshest evidence sitting behind it. Every part of that is false.
    //
    // A contact whose last report is 14 minutes old must be drawn AT that report.
    const series = [
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0, sog: 9, cog: 90 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0, sog: 9, cog: 90 }),
    ];
    for (const minutes of [5, 6, 8, 14, 60, 600]) {
      const s = displayStateOf(series, at(minutes));
      expect(s.state).not.toBe('INTERPOLATED_DISPLAY');
      // Landed exactly on the newest real fix, no further north than it.
      expect(s.lat).toBeCloseTo(1.004, 9);
      expect(s.lon).toBeCloseTo(103.0, 9);
      expect(s.at).toBe(at(4));
    }
  });

  it('does not extrapolate into the past either', () => {
    // Before the earliest observation nothing is known. Drawing the earliest fix is the only
    // answer that does not invent a position.
    const series = [obs({ timestamp: at(4), lat: 1.004, lon: 103.0 })];
    const s = displayStateOf(series, at(0));
    expect(s.lat).toBeCloseTo(1.004, 9);
    expect(s.at).toBe(at(4));
    expect(s.sourceObservationTimestamps).toEqual([at(4)]);
  });

  it('at an exact observation instant the state is OBSERVED', () => {
    const series = [
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0 }),
    ];
    for (const minutes of [0, 4]) {
      const s = displayStateOf(series, at(minutes));
      expect(s.state).toBe('OBSERVED');
      expect(s.sourceObservationTimestamps).toEqual([at(minutes)]);
    }
  });

  it('every interpolated position lies BETWEEN its two observations', () => {
    const series = [
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0 }),
    ];
    for (let minutes = 0.25; minutes < 4; minutes += 0.25) {
      const s = displayStateOf(series, at(minutes));
      expect(s.state).toBe('INTERPOLATED_DISPLAY');
      expect(s.lat!).not.toBeNull();
      expect(s.lat as number).toBeGreaterThan(1.0);
      expect(s.lat as number).toBeLessThan(1.004);
    }
  });

  it('no code path produces a coordinate that lacks a declared provenance', () => {
    const cases: Array<[AisObservationOut[], string]> = [
      [[obs({ timestamp: at(0) })], at(0)],
      [[obs({ timestamp: at(0) }), obs({ timestamp: at(4), lat: 1.004 })], at(2)],
      [[], T0],
    ];
    for (const [series, atTime] of cases) {
      const s = displayStateOf(series, atTime);
      if (s.lat !== null) {
        // A drawn position must either be a real fix or name the observations it came from.
        expect(s.sourceObservationTimestamps.length).toBeGreaterThan(0);
        expect(s.state).not.toBe('PREDICTED');
      }
    }
  });

  it('smooth display never creates an observation timestamp', () => {
    const series = [
      obs({ timestamp: at(0), lat: 1.0, lon: 103.0, sog: 9, cog: 90 }),
      obs({ timestamp: at(4), lat: 1.004, lon: 103.0, sog: 9, cog: 90 }),
    ];
    const observedTimes = new Set(series.map((o) => o.timestamp));
    for (let minutes = 0; minutes <= 4; minutes += 1) {
      const t = at(minutes);
      const s = displayStateOf(series, t);
      if (s.state === 'INTERPOLATED_DISPLAY') {
        // Every source timestamp is a REAL observation, and the displayed time is not one.
        for (const src of s.sourceObservationTimestamps) expect(observedTimes.has(src)).toBe(true);
        expect(observedTimes.has(s.at!)).toBe(false);
      }
    }
  });

  it('UNKNOWN orientation is never rendered as zero degrees', () => {
    const s = displayStateOf([obs({ timestamp: T0 })], T0);
    expect(s.orientation.source).toBe('UNKNOWN');
    expect(s.orientation.degrees).not.toBe(0);
    expect(s.orientation.degrees).toBeNull();
  });

  it('heading and COG are never relabelled as one another', () => {
    const headingOnly = resolveOrientation([obs({ timestamp: T0, sog: 9, heading: 30 })]);
    expect(headingOnly.source).toBe('HEADING');
    expect(headingOnly.degrees).toBe(30);

    const cogOnly = resolveOrientation([obs({ timestamp: T0, sog: 9, cog: 30 })]);
    expect(cogOnly.source).toBe('COG');
    // Same number, different source -- and the source is what is recorded, so a reader can
    // never mistake a course for a heading.
    expect(cogOnly.degrees).toBe(30);
    expect(cogOnly.source).not.toBe(headingOnly.source);
  });
});

describe('surface distance', () => {
  it('is zero for coincident points', () => {
    expect(surfaceDistanceM(1, 103, 1, 103)).toBeCloseTo(0, 6);
  });

  it('is about 111 km for one degree of latitude', () => {
    expect(surfaceDistanceM(0, 0, 1, 0)).toBeGreaterThan(110_000);
    expect(surfaceDistanceM(0, 0, 1, 0)).toBeLessThan(112_000);
  });

  it('shrinks with the cosine of latitude for a longitude step', () => {
    const equator = surfaceDistanceM(0, 0, 0, 1);
    const high = surfaceDistanceM(60, 0, 60, 1);
    expect(high).toBeLessThan(equator * 0.6);
  });
});