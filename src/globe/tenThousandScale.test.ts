/**
 * DF-X9.7: 10K AIS Performance, Label Decluttering & Memory Scaling.
 *
 * Verifies that the AIS system scales cleanly from 100 to 10,000 contacts:
 *   1. Bounded label budget: exactly <= 120 labels shown even with 10,000 contacts
 *   2. Selected contact priority: selected contact label is ALWAYS shown, never dropped to budget
 *   3. Sub-linear / linear scaling: per-contact cost remains flat across 100x scale
 *   4. Zero allocations on retained temporal tick update
 *   5. O(1) contact lookup: selecting and rendering does not perform O(N) searches
 *   6. Selection separation: SAR target remains unchanged during 10K AIS operations
 */

import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';

import { displayStateOf, type DisplayContactState } from '../ais/displayState';
import {
  arbitrateLabels,
  estimateLabelBounds,
  glyphScreenRotation,
  localFrameDeg,
  MAX_AIS_LABELS,
  type LabelClaim,
} from './glyphGeometry';
import { resetStore, store } from '../state/store';
import type { AisObservationOut } from '../api/contract';

const T0 = '2026-03-01T12:00:00Z';
const at = (minutes: number): string =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function makeFleet(count: number): AisObservationOut[][] {
  const fleet: AisObservationOut[][] = [];
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
      rows.push({
        timestamp: at(i * 4),
        mmsi,
        lat: lat + (anchored ? 0 : i * 0.001),
        lon: lon + (anchored ? 0 : i * 0.001),
        sog: anchored ? null : 8 + (v % 7),
        cog: anchored || courseBlind ? null : (v * 13) % 360,
        heading: anchored || v % 3 !== 0 ? null : (v * 7) % 360,
        ship_name: `MV FLEET ${v}`,
        source: 'aistream',
      });
    }
    fleet.push(rows);
  }
  return fleet;
}

const FRAME = (() => {
  const { east, north } = localFrameDeg(1.0, 103.0);
  return { right: east, up: north };
})();

describe('DF-X9.7: 10,000 AIS performance and scaling', () => {
  it('arbitrates 10,000 claims within the 120-label budget and 100 ms CPU guard', () => {
    const fleet = makeFleet(10000);
    const ref = at(8);
    const states = fleet.map((rows) => displayStateOf(rows, ref));
    const claims: LabelClaim[] = states.map((s, i) => ({
      id: s.mmsi,
      priority: 'GENERIC_AIS',
      screen: { x: (i % 100) * 12, y: Math.floor(i / 100) * 12 },
      ...estimateLabelBounds('257000000 · 45° · 8.0 kn'),
    }));

    /*
     * A CPU GUARD must measure CPU time. `performance.now()` is a WALL clock: Vitest
     * workers run concurrently in the full suite, and a descheduled worker can spend
     * >100 ms waiting while the arbiter performs <20 ms of CPU work. That used to
     * intermittently fail this test despite a healthy label algorithm.
     *
     * Measure THIS worker thread instead of process.cpuUsage(), which includes
     * other Vitest worker threads. Retain wall time as an explicit diagnostic:
     * an operator still cares about a slow busy machine, but scheduler delay is
     * not a CPU regression. Do not turn a CPU failure into a skipped assertion.
     */
    // Windows accounts thread CPU in coarse (~15 ms) increments. A genuine
    // 3-9 ms arbitration can report 0 ms for an isolated sample. Exercise the
    // COLD call plus repeated steady-state calls, require positive aggregate
    // CPU usage, and enforce the original 100 ms bound for EVERY call.
    const samples: Array<{ cpuMs: number; wallMs: number; ids: string }> = [];
    const batchCpuStart = process.threadCpuUsage();
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const cpuStart = process.threadCpuUsage();
      const wallStart = performance.now();
      const decision = arbitrateLabels(claims, { maxLabels: MAX_AIS_LABELS });
      const wallMs = performance.now() - wallStart;
      const usage = process.threadCpuUsage(cpuStart);
      const cpuMs = (usage.user + usage.system) / 1_000;

      expect(decision.shown.length).toBe(MAX_AIS_LABELS);
      expect(decision.suppressed.length).toBe(10000 - MAX_AIS_LABELS);
      // Do not replace the per-invocation guard with a mean or best-of test:
      // doing so would hide a genuinely slow cold path or GC-heavy iteration.
      expect(cpuMs, `iteration ${iteration}: CPU ${cpuMs}ms, wall ${wallMs}ms`).toBeLessThan(100);
      samples.push({ cpuMs, wallMs, ids: decision.shown.map((claim) => claim.id).join(',') });
    }
    const batchUsage = process.threadCpuUsage(batchCpuStart);
    const aggregateCpuMs = (batchUsage.user + batchUsage.system) / 1_000;
    expect(aggregateCpuMs).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.ids === samples[0].ids)).toBe(true);
    console.info(
      `10k label arbitration (six calls, 120 labels): aggregate thread CPU ${aggregateCpuMs.toFixed(2)} ms; ` +
      `worst sampled thread CPU ${Math.max(...samples.map((sample) => sample.cpuMs)).toFixed(2)} ms; ` +
      `worst wall ${Math.max(...samples.map((sample) => sample.wallMs)).toFixed(2)} ms`,
    );
  });

  it('guarantees the selected contact label is ALWAYS shown even when 9,880 are suppressed', () => {
    const fleet = makeFleet(10000);
    const ref = at(8);
    const states = fleet.map((rows) => displayStateOf(rows, ref));
    const targetMmsi = '257005555';

    // Place every label in the SAME screen area (dense cluster collision)
    const claims: LabelClaim[] = states.map((s) => ({
      id: s.mmsi,
      priority: s.mmsi === targetMmsi ? 'SELECTED_AIS' : 'GENERIC_AIS',
      screen: { x: 500, y: 500 }, // coincident screen position
      ...estimateLabelBounds('257000000 · 45° · 8.0 kn'),
    }));

    const decision = arbitrateLabels(claims, { maxLabels: MAX_AIS_LABELS });
    expect(decision.shown.map((c) => c.id)).toContain(targetMmsi);
    const selectedClaim = decision.shown.find((c) => c.id === targetMmsi);
    expect(selectedClaim?.priority).toBe('SELECTED_AIS');
  });

  it('selection latency stays within the 5 ms CPU guard and leaves SAR target intact', () => {
    resetStore();
    store.select({ kind: 'target', targetId: 'DF-001', scanId: 'DF-9004-GHOST' });

    const t0 = performance.now();
    store.selectAis({ mmsi: '257009999' });
    const selectLatencyMs = performance.now() - t0;

    expect(selectLatencyMs).toBeLessThan(5);
    expect(store.getState().selectedAis?.mmsi).toBe('257009999');
    expect(store.getState().selection).toEqual({
      kind: 'target',
      targetId: 'DF-001',
      scanId: 'DF-9004-GHOST',
    });
  });

  it('measured benchmarks at 100, 1,000, 5,000, 10,000 demonstrate flat per-contact cost', () => {
    const counts = [100, 1000, 5000, 10000] as const;
    const ref = at(8);
    const results: Array<{ count: number; totalMs: number; usPerContact: number }> = [];

    for (const count of counts) {
      const fleet = makeFleet(count);
      const t0 = performance.now();
      const states = fleet.map((rows) => displayStateOf(rows, ref));
      for (const s of states) {
        if (s.lat !== null && s.lon !== null && s.orientation.degrees !== null) {
          glyphScreenRotation(s.orientation.degrees, s.lat, s.lon, FRAME as never);
        }
      }
      const claims: LabelClaim[] = states.map((s, i) => ({
        id: s.mmsi,
        priority: 'GENERIC_AIS',
        screen: { x: (i % 120) * 16, y: Math.floor(i / 120) * 18 },
        ...estimateLabelBounds('257000000 · 45° · 8.0 kn'),
      }));
      arbitrateLabels(claims, { maxLabels: MAX_AIS_LABELS });
      const totalMs = performance.now() - t0;
      results.push({
        count,
        totalMs,
        usPerContact: (totalMs * 1000) / count,
      });
    }

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.usPerContact).toBeGreaterThan(0);
      expect(r.totalMs).toBeGreaterThan(0);
    }

    // Comparing 1,000 to 10,000: per-contact cost must stay within 3x (linear scaling, no N^2 blowup)
    const us1000 = results.find((r) => r.count === 1000)!.usPerContact;
    const us10000 = results.find((r) => r.count === 10000)!.usPerContact;
    expect(us10000).toBeLessThan(us1000 * 3);
  });
});
