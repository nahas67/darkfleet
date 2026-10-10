/**
 * AIS full CPU-path standalone benchmark, independent of Vitest and WebGL.
 *
 * From the repo root:
 *   node node_modules/esbuild/bin/esbuild build-tools/ais_10k_cpu_benchmark.ts --bundle --platform=node --format=cjs --outfile=<TEMP_PATH>.cjs
 *   node <TEMP_PATH>.cjs --runs=25 --warmup=5
 *
 * The vessel fixture, reference instant and CPU stages reproduce measure(10000)
 * in src/globe/aisRenderer.perf.test.ts. This is NOT an actual Cesium GPU frame.
 * Build output belongs in the OS temp directory, not inside product data/.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AisObservationOut } from '../src/api/contract';
import { displayStateOf, type DisplayContactState } from '../src/ais/displayState';
import {
  arbitrateLabels,
  glyphScreenRotation,
  localFrameDeg,
  type LabelClaim,
} from '../src/globe/glyphGeometry';

const REFERENCE = '2026-03-01T12:08:00.000Z';
const INTERPOLATED_REFERENCE = '2026-03-01T12:10:00.000Z';
const FIXTURE_T0 = Date.parse('2026-03-01T12:00:00Z');
// Measured against unmodified source HEAD 5ddc0c5eed0443ce3d1027b3ddce41aa22f110af.
const EXPECTED_10K = {
  fixture: 'b0811413c4902a534c67becebbb8b0b1a0d2c6c03f52f0b09a1944433f652471',
  exactState: 'd81e18803b9ac4c0a8fa22d0ae77b20faec1f5c9b2e7ed558170b51242dc25d7',
  interpolatedState: '6ea796288cdf194409b997df2f53c3625b509605ba22cea9272796c59cd04d71',
  rendered: 'f2c4f2950f2919e221252be00fddffc30a4cffc3494a691bf5482e094fc787e8',
} as const;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// IDENTICAL vessel construction and numeric spread to aisRenderer.perf.test.ts:
// five fixes at 0,4,8,12,16min; nullable kinematics; uniform lat and
// coprime-stride lon; 1-in-8 anchored, course-blind, measured heading variants.
export function makeBenchmarkVessels(count: number): AisObservationOut[][] {
  const vessels: AisObservationOut[][] = [];
  const LAT_SPAN = 20;
  const LON_SPAN = 40;
  for (let v = 0; v < count; v += 1) {
    const mmsi = String(257000000 + v).padStart(9, '0');
    const lat = 1.0 + (v / count) * LAT_SPAN;
    const lon = 103.0 + (((v * 7919) % 9973) / 9973) * LON_SPAN;
    const anchored = v % 8 === 7;
    const courseBlind = v % 4 === 3;
    const rows: AisObservationOut[] = [];
    for (let i = 0; i < 5; i += 1) {
      const drift = anchored ? 0 : i * 0.001;
      rows.push({
        timestamp: new Date(FIXTURE_T0 + i * 4 * 60_000).toISOString(),
        mmsi,
        lat: lat + drift,
        lon: lon + drift,
        sog: anchored ? null : 8 + (v % 7),
        cog: anchored || courseBlind ? null : (v * 13) % 360,
        heading: anchored || v % 3 !== 0 ? null : (v * 7) % 360,
        ship_name: `MV TEST ${v}`,
        source: 'aistream',
      });
    }
    vessels.push(rows);
  }
  return vessels;
}

const frame = (() => {
  const { east, north } = localFrameDeg(1.0, 103.0);
  return { right: east, up: north };
})();

type Sample = { wallMs: number; threadCpuMs: number };
type Stages = {
  display: Sample;
  orientation: Sample;
  claimsAndLabels: Sample;
  whole: Sample;
};

const elapsedCpu = (start: NodeJS.CpuUsage): number => {
  const usage = process.threadCpuUsage(start);
  return (usage.user + usage.system) / 1000;
};

const measured = <T>(func: () => T): { value: T; cost: Sample } => {
  const cpuStart = process.threadCpuUsage();
  const wallStart = performance.now();
  const value = func();
  return {
    value,
    cost: {
      wallMs: performance.now() - wallStart,
      threadCpuMs: elapsedCpu(cpuStart),
    },
  };
};

// Same three timed stages and 92px x 15px claims as measure(10000).
function tick(vessels: readonly AisObservationOut[][], reference: string): {
  stages: Stages;
  states: DisplayContactState[];
  rendered: { labels: string[]; suppressed: number; rotations: number };
} {
  const entireCpuStart = process.threadCpuUsage();
  const entireStart = performance.now();

  const display = measured(() => vessels.map((series) => displayStateOf(series, reference)));
  const states = display.value;

  const orientation = measured(() => {
    let rotations = 0;
    for (const state of states) {
      if (state.lat === null || state.lon === null) continue;
      const bearing = state.orientation.degrees;
      if (bearing === null) continue;
      const angle = glyphScreenRotation(bearing, state.lat, state.lon, frame as never);
      if (angle !== null) rotations += 1;
    }
    return rotations;
  });
  const claimsAndLabels = measured(() => {
    const claims: LabelClaim[] = [];
    states.forEach((state, index) => {
      if (state.lat === null || state.lon === null) return;
      claims.push({
        id: state.mmsi || `c${index}`,
        priority: 'GENERIC_AIS',
        screen: { x: (index % 120) * 16, y: Math.floor(index / 120) * 18 },
        widthPx: 92,
        heightPx: 15,
      });
    });
    const decision = arbitrateLabels(claims, { maxLabels: 120 });
    return { labels: decision.shown.map((item) => item.id), suppressed: decision.suppressed.length };
  });
  return {
    stages: {
      display: display.cost,
      orientation: orientation.cost,
      claimsAndLabels: claimsAndLabels.cost,
      whole: {
        wallMs: performance.now() - entireStart,
        threadCpuMs: elapsedCpu(entireCpuStart),
      },
    },
    states,
    rendered: { ...claimsAndLabels.value, rotations: orientation.value },
  };
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const n = (sorted.length - 1) * p;
    const lower = Math.floor(n);
    return sorted[lower] + (sorted[Math.ceil(n)] - sorted[lower]) * (n - lower);
  };
  return { median: percentile(0.5), p95: percentile(0.95), worst: sorted[sorted.length - 1] };
}

function summarize(samples: readonly Stages[]) {
  return Object.fromEntries((['display', 'orientation', 'claimsAndLabels', 'whole'] as const).map((stage) =>
    [stage, {
      wallMs: distribution(samples.map((s) => s[stage].wallMs)),
      threadCpuMs: distribution(samples.map((s) => s[stage].threadCpuMs)),
    }],
  ));
}

function positiveNumber(flag: string, fallback: number): number {
  const arg = process.argv.find((value) => value.startsWith(`--${flag}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(flag.length + 3));
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error(`Invalid ${flag}: ${arg}`);
  }
  return value;
}

function main() {
  const count = positiveNumber('contacts', 10000);
  const runs = positiveNumber('runs', 25);
  const warmup = positiveNumber('warmup', 5);
  const reference = process.argv.includes('--interpolated') ? INTERPOLATED_REFERENCE : REFERENCE;
  const vessels = makeBenchmarkVessels(count);
  const fixtureHash = hash(vessels);
  if (count === 10000 && fixtureHash !== EXPECTED_10K.fixture) {
    throw new Error(`Fixture provenance drift: ${fixtureHash}`);
  }
  const samples: Stages[] = [];
  let stateHash = '';
  let renderedHash = '';
  let firstRendered: { labels: string[]; suppressed: number; rotations: number } | null = null;
  for (let pass = 0; pass < runs + warmup; pass += 1) {
    const result = tick(vessels, reference);
    if (pass === 0) {
      stateHash = hash(result.states);
      renderedHash = hash(result.rendered);
      firstRendered = result.rendered;
      if (result.rendered.labels.length > 120) throw new Error('Production label budget violated');
    }
    if (pass >= warmup) samples.push(result.stages);
  }
  if (count === 10000) {
    const expectedState = reference === REFERENCE ? EXPECTED_10K.exactState : EXPECTED_10K.interpolatedState;
    if (stateHash !== expectedState) throw new Error(`10k state/provenance mismatch: ${stateHash}`);
    if (renderedHash !== EXPECTED_10K.rendered) throw new Error(`10k labels/glyph identity mismatch: ${renderedHash}`);
    if (firstRendered?.labels.length !== 120 || firstRendered?.suppressed !== 9880) {
      throw new Error('10k label arbitration count/priority mismatch');
    }
  }
  const wholeWall = distribution(samples.map((s) => s.whole.wallMs));
  const wholeThread = distribution(samples.map((s) => s.whole.threadCpuMs));
  const meetsAllObserved = wholeWall.worst < 100 && wholeThread.worst < 100;
  const report = {
    harness: 'build-tools/ais_10k_cpu_benchmark.ts',
    node: process.version,
    pid: process.pid,
    count,
    observations: count * 5,
    reference,
    runs,
    warmup,
    fixtureHash,
    stateHash,
    renderedHash,
    labelsShown: firstRendered?.labels.length ?? null,
    labelsSuppressed: firstRendered?.suppressed ?? null,
    glyphRotations: firstRendered?.rotations ?? null,
    results: summarize(samples),
    // Two distinct questions; do not equate CPU consumption with wall latency.
    medianWholeWallUnder100ms: wholeWall.median < 100,
    p95WholeWallUnder100ms: wholeWall.p95 < 100,
    worstWholeWallUnder100ms: wholeWall.worst < 100,
    medianWholeThreadCpuUnder100ms: wholeThread.median < 100,
    p95WholeThreadCpuUnder100ms: wholeThread.p95 < 100,
    worstWholeThreadCpuUnder100ms: wholeThread.worst < 100,
    allMeasuredTicksUnder100msOnBothClocks: meetsAllObserved,
    interpretation: 'Stand-alone CPU-only display/orientation/claim/declutter path. No Cesium collections, canvas projection, GPU upload, actual frame time, or browser event scheduling.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--enforce-100ms') && !meetsAllObserved) process.exitCode = 1;
}
main();
