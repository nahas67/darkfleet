/**
 * PERFORMANCE: the TRACK ENGINE and the PLAYBACK TICK, measured.
 *
 * ================================ WHY THIS IS SEPARATE FROM THE RENDERER HARNESS ================================
 *
 * `aisRenderer.perf.test.ts` measures the contact path. This measures the TRACK path, which DF-X9.4
 * added and which is a different cost profile: it builds a segment model per vessel, and it does so
 * on every tick while playback runs.
 *
 * The question is not whether the numbers look good in absolute terms -- no threshold is invented
 * here -- but whether per-vessel cost stays FLAT as the fleet grows. A per-tick cost that grows with
 * the fleet means the architecture is wrong regardless of how the absolute numbers look, and that
 * is the claim being made here.
 *
 * What is NOT measured, and is therefore not claimed: GPU upload, draw calls, frame time. Those need
 * a canvas and belong to the browser E2E.
 */

import { describe, expect, it } from 'vitest';

import type { AisObservationOut } from '../api/contract';
import { displayStateOf } from '../ais/displayState';
import { buildTrack, displayRunsFor } from './trackBuilder';
import { planFrameTrack, pointsOfSegments } from './framing';
import { TemporalController, rangeFromTimestamps } from './TemporalController';

/* ------------------------------------------------------------------ fixtures */

const T0 = Date.parse('2026-05-12T08:00:00Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

/**
 * `count` vessels on the product's own 4-minute cadence, spread over a FIXED geographic extent.
 *
 * FIXED EXTENT AT EVERY SIZE, deliberately. A first draft spaced vessels by `v % 40`, so 100
 * contacts occupied a small patch while 1,000 wrapped onto the same coordinates. That is not a scale
 * test: vessel separation is what makes geometry real, and coincident points make bounding boxes and
 * frame planning degenerate.
 */
function makeTracks(count: number, fixesPerVessel = 5): AisObservationOut[][] {
  const out: AisObservationOut[][] = [];
  for (let v = 0; v < count; v += 1) {
    const mmsi = String(257000000 + v).padStart(9, '0');
    const lat = 1.0 + (v / count) * 20; // the SAME 20-degree extent at every size
    const lon = 103.0 + (((v * 7919) % 9973) / 9973) * 40;
    const rows: AisObservationOut[] = [];
    for (let i = 0; i < fixesPerVessel; i += 1) {
      /*
       * ONE VESSEL IN EIGHT CARRIES A REPORTING GAP, at 1,920 s -- well beyond the 600 s limit.
       *
       * A fixture with no gaps exercises only the OBSERVED_SEGMENT branch, and the gap branch is where
       * the extra segment allocations and the antimeridian splits live. A performance fixture that
       * never reaches the expensive path measures the cheap one.
       */
      const hasGap = v % 8 === 7 && i === 3;
      rows.push({
        timestamp: hasGap ? at(i * 240 + 1920) : at(i * 240),
        mmsi,
        lat: lat + i * 0.001,
        lon: lon + i * 0.001,
        sog: 8,
        cog: 45,
        heading: null,
        ship_name: `MV PERF ${v}`,
        source: 'aistream',
      });
    }
    out.push(rows);
  }
  return out;
}

/** The 27-row DF-X9.3A correctness fixture, in the shape the engine consumes. */
function theTwentySevenRows(): AisObservationOut[][] {
  const cadence = [0, 240, 480, 720, 960];
  const perVessel = 5;
  const byMmsi = new Map<string, AisObservationOut[]>();
  let mmsiIndex = 1;
  for (let v = 0; v < 5; v += 1) {
    const mmsi = String(257000000 + mmsiIndex);
    mmsiIndex += 1;
    byMmsi.set(
      mmsi,
      cadence.map((s, i) => ({
        timestamp: at(s),
        mmsi,
        lat: 1.3 + v * 0.1 + i * 0.004,
        lon: 103.8 + v * 0.1,
        sog: v === 0 ? null : 8 + v,
        cog: v === 0 ? null : (v * 45) % 360,
        heading: null,
        ship_name: `MV FIXTURE ${v}`,
        source: 'aistream',
      })),
    );
  }
  // The 3120 s gap vessel, which is what makes the fixture worth exercising.
  byMmsi.set(
    '257000006',
    [0, 3120].map((s, i) => ({
      timestamp: at(s),
      mmsi: '257000006',
      lat: 1.45 + i * 0.01,
      lon: 103.95,
      sog: 8,
      cog: 45,
      heading: null,
      ship_name: 'MV OUT OF WINDOW',
      source: 'aistream',
    })),
  );
  void perVessel;
  return [...byMmsi.values()];
}

/* ============================================================================================== *
 * MEASUREMENT
 * ============================================================================================== */

interface Measurement {
  label: string;
  tracks: number;
  fixes: number;
  /** Full segment-model build, per fleet. */
  buildMs: number;
  /** One playback tick's worth of per-contact display state. */
  tickMs: number;
  /** Antimeridian splitting plus framing planning, per fleet. */
  geometryMs: number;
  totalMs: number;
  segments: number;
  gaps: number;
  usPerTrack: number;
}

function bestOf(runs: number, body: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    body();
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/** Enough iterations that the measurement clears timer resolution at the smallest size. */
const RUNS = 12;

function measure(label: string, fleet: AisObservationOut[][], referenceIso: string): Measurement {
  const fixes = fleet.reduce((n, rows) => n + rows.length, 0);

  // Warm-up, discarded. Enough to compile the path; not enough to fully tier up, which is why the
  // SMALLEST fleet is the least representative row and the scaling gate compares the warm rows.
  buildTrack(fleet[0][0] === undefined ? [] : fleet[0]);

  const buildMs = bestOf(RUNS, () => {
    for (const rows of fleet) buildTrack(rows);
  });

  const tickMs = bestOf(RUNS, () => {
    for (const rows of fleet) displayStateOf(rows, referenceIso);
  });

  /*
   * SEGMENT AND GAP COUNTS ARE TAKEN ONCE, NOT ACCUMULATED ACROSS TIMING ITERATIONS.
   *
   * A first draft counted them INSIDE the timed body, which runs RUNS times, so the reported table
   * showed the 27-row fixture producing 72 segments and 12 gaps for what is really 6 and 1. The
   * figures were inflated by exactly RUNS, the assertions still passed (so nothing was caught), and
   * the table -- which is the artefact the acceptance criteria quote -- was wrong.
   *
   * Timing and counting are now separate concerns: count once, time the shape of the work.
   */
  let segments = 0;
  let gaps = 0;
  for (const rows of fleet) {
    const build = buildTrack(rows);
    segments += build.segments.length;
    gaps += build.segments.filter((s) => s.kind === 'GAP').length;
  }

  const geometryMs = bestOf(RUNS, () => {
    for (const rows of fleet) {
      const build = buildTrack(rows);
      for (const segment of build.segments) displayRunsFor(segment);
      planFrameTrack({ points: pointsOfSegments(build.segments) });
    }
  });

  const totalMs = buildMs + tickMs + geometryMs;
  return {
    label,
    tracks: fleet.length,
    fixes,
    buildMs,
    tickMs,
    geometryMs,
    totalMs,
    segments,
    gaps,
    usPerTrack: (totalMs * 1000) / fleet.length,
  };
}

const SIZES = [
  { label: '27-row correctness fixture', fleet: theTwentySevenRows() },
  { label: '100 tracks', fleet: makeTracks(100) },
  { label: '1,000 tracks', fleet: makeTracks(1000) },
] as const;

/** The mid-range instant, so the tick exercises interpolation rather than an exact observation. */
const REFERENCE = at(600);

const measurements: Measurement[] = SIZES.map((s) => measure(s.label, s.fleet, REFERENCE));

/* ============================================================================================== *
 * ASSERTIONS
 * ============================================================================================== */

describe('track engine performance', () => {
  it('measures every required case', () => {
    expect(measurements.map((m) => m.label)).toEqual([
      '27-row correctness fixture',
      '100 tracks',
      '1,000 tracks',
    ]);
    for (const m of measurements) {
      expect(m.totalMs).toBeGreaterThan(0);
      expect(m.tracks).toBeGreaterThan(0);
    }
  });

  it('per-track cost does not blow up with scale', () => {
    /*
     * THE ARCHITECTURAL CLAIM. Per-track cost must stay broadly flat as the fleet grows 10x; a
     * per-tick cost that rises steeply with the fleet is the architecture being wrong.
     *
     * THE TWO SYNTHETIC ROWS ARE COMPARED, not the fixture against 1,000. The fixture is six vessels
     * measured first and so absorbs the most JIT warm-up while being the smallest -- which makes it
     * the least representative row, not the most. `await`-free ordering is deliberate; the
     * measurements are taken at module scope above in ascending size for the same reason.
     */
    const hundred = measurements.find((m) => m.tracks === 100)!.usPerTrack;
    const thousand = measurements.find((m) => m.tracks === 1000)!.usPerTrack;
    expect(thousand).toBeLessThan(hundred * 3);
  });

  it('the fixture exercises BOTH segment kinds, so the gap branch is not untimed', () => {
    const fixture = measurements.find((m) => m.label === '27-row correctness fixture')!;
    // 5 vessels on an unbroken 4-minute cadence contribute 5 segments; the 3120 s vessel
    // contributes 1 GAP. Exactly 6 and 1 -- pinned because these counts are what the printed table
    // quotes, and a 12x inflation of them passed every assertion while making the table a fiction.
    expect(fixture.tracks).toBe(6);
    expect(fixture.fixes).toBe(27);
    expect(fixture.segments).toBe(6);
    expect(fixture.gaps).toBe(1);
  });

  it('the 1,000-track fixture exercises gaps at scale', () => {
    const big = measurements.find((m) => m.tracks === 1000)!;
    // One vessel in eight carries a gap: 1000 / 8 = 125. A fixture that produced none would be
    // timing only the cheap branch.
    expect(big.gaps).toBe(125);
    // And each gapped vessel contributes 2 segments (an observed stretch, the gap, another stretch),
    // while the rest contribute 1: 875 + 125*2 = 1,125.
    expect(big.segments).toBe(1125);
  });

  it('framing a crossing track stays O(points), not O(world)', () => {
    /*
     * NOT A TIMING CLAIM. A wrap-aware bounding box is O(n) in the points and O(1) in the Earth's
     * size, so a crossing track must cost the same as an ordinary one of the same length. If the
     * implementation ever fell back to an unwrapped or globe-spanning approach, this would still
     * pass on time and fail on correctness -- which is why the assertion is on the returned WIDTH.
     */
    const crossing = planFrameTrack({
      points: [
        { lat: 1.0, lon: 179.8 },
        { lat: 1.0, lon: -179.9 },
        { lat: 1.0, lon: -179.7 },
      ],
    })!;
    expect(crossing.wrapped).toBe(true);
    // 0.5 degrees of movement must not become 359.8.
    expect(crossing.halfWidthDeg).toBeLessThan(2);
  });
});

/* ============================================================================================== *
 * PLAYBACK TICK AND TIMER OWNERSHIP
 * ============================================================================================== */

describe('playback tick cost and timer ownership', () => {
  it('a tick re-reads state without rebuilding the track model', () => {
    /*
     * DF-X9.4 sections 59 and 60: a tick must not rebuild every contact and every track.
     *
     * What is asserted is that the CONTROLLER does no per-tick track work at all -- it only moves a
     * number. The track model is built from the archive, which does not change while the playhead
     * moves, so rebuilding it per tick would be pure waste.
     */
    let monotonic = 0;
    const controller = new TemporalController({ monotonic: () => monotonic, tickPeriodMs: 1_000_000 });
    const fleet = makeTracks(1000);

    // Build every track ONCE, up front.
    const buildsBefore = performance.now();
    const built = fleet.map((rows) => buildTrack(rows));
    const buildOnce = performance.now() - buildsBefore;

    controller.setRange(rangeFromTimestamps(fleet.flat().map((o) => o.timestamp)));
    controller.play();

    // Now time a hundred ticks: they must not build anything.
    const ticksBefore = performance.now();
    for (let i = 0; i < 100; i += 1) {
      monotonic += 100;
      controller.tickForTesting();
    }
    const hundredTicks = performance.now() - ticksBefore;

    // 100 ticks must cost far less than building 1,000 tracks 100 times over.
    expect(hundredTicks).toBeLessThan(buildOnce * 10);
    expect(built).toHaveLength(1000);
    controller.dispose();
  });

  it('exactly ONE timer exists while playing, and none while paused', () => {
    /*
     * DF-X9.4 section 64. A per-component timer makes this number equal the number of mounted
     * components, and two timers advancing one playhead produce a clock running at double speed
     * depending on which mounted last -- a bug that looks exactly like a data problem.
     */
    const controller = new TemporalController({ tickPeriodMs: 1_000_000 });
    const fleet = makeTracks(10);
    controller.setRange(rangeFromTimestamps(fleet.flat().map((o) => o.timestamp)));

    expect(controller.timerCount).toBe(0);
    controller.play();
    expect(controller.timerCount).toBe(1);
    controller.pause();
    expect(controller.timerCount).toBe(0);

    // Repeated cycles accumulate nothing.
    for (let i = 0; i < 100; i += 1) {
      controller.play();
      controller.pause();
    }
    expect(controller.timerCount).toBe(0);
    controller.dispose();
  });

  it('subscribers do not accumulate across repeated subscriptions', () => {
    // A listener leak is invisible until the page has been open for an hour, at which point it looks
    // like a memory problem rather than a missing unsubscribe.
    const controller = new TemporalController({ tickPeriodMs: 1_000_000 });
    const offs: Array<() => void> = [];
    for (let i = 0; i < 50; i += 1) offs.push(controller.subscribe(() => {}));
    expect(controller.listenerCount).toBe(50);
    for (const off of offs) off();
    expect(controller.listenerCount).toBe(0);
    controller.dispose();
  });
});

/* ============================================================================================== *
 * REPORTED, NOT ASSERTED
 * ============================================================================================== */

describe('measured numbers', () => {
  it('reports the table for the record', () => {
    /*
     * PRINTED, NOT PINNED. An earlier revision of the renderer harness asserted against figures like
     * "31.9 us falling to 25.4 us"; re-measurement later produced 21.23 -> 29.24 -- the opposite
     * direction -- and the pinned numbers were simply JIT- and machine-dependent.
     *
     * So no figure is written into the file. The gate is structural (per-track cost must not blow up)
     * and the numbers are printed for whoever ran it.
     */
    const rows: string[][] = [
      [
        'case', 'tracks', 'fixes', 'build ms', 'tick ms', 'geometry ms',
        'total ms', 'us/track', 'segments', 'gaps',
      ],
      ...measurements.map(
        (m): string[] => [
          m.label,
          String(m.tracks),
          String(m.fixes),
          m.buildMs.toFixed(3),
          m.tickMs.toFixed(3),
          m.geometryMs.toFixed(3),
          m.totalMs.toFixed(3),
          m.usPerTrack.toFixed(2),
          String(m.segments),
          String(m.gaps),
        ],
      ),
    ];
    console.info(
      `\nTRACK ENGINE CPU-SIDE COST (no WebGL; NOT a frame rate)\n${rows.map((r) => r.join(' | ')).join('\n')}\n`,
    );
    expect(rows[0][0]).toBe('case');
  });
});
