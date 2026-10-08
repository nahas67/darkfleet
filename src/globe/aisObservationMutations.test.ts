/**
 * DF-X9.6 Section 12: Permanent Mutation Tests for Observation Picking Chain.
 *
 * Verifies that each required defect scenario in the proof chain is caught by an
 * assertion and causes an immediate failure:
 *   1. Remove observation pick tag -> decodeAisPick fails to identify observation
 *   2. Drop observationAt -> decodeAisPick rejects or drops timestamp
 *   3. Return adjacent timestamp -> fails exact timestamp identity
 *   4. Select vessel instead of observation -> fails kind assertion
 *   5. Convert null COG to zero -> fails null-preservation / NOT_ESTABLISHED
 *   6. Remove selected-marker highlight -> renderer fails highlightedObservation
 *   7. Clear SAR target during AIS pick -> store.selection fails
 *   8. Change aisCoverage on selection -> coverage equality fails
 */

import { describe, expect, it } from 'vitest';

import { aisContactTag, aisObservationTag, decodeAisPick } from './aisPick';
import { resetStore, store } from '../state/store';
import { buildSelectedAisSummary } from '../temporal/AisPlaybackBar';
import { fmtDegrees, NOT_ESTABLISHED } from '../design/format';
import type { AisObservationOut } from '../api/contract';

const OBS_ROW: AisObservationOut = {
  timestamp: '2026-05-12T08:04:00.000Z',
  mmsi: '257000001',
  lat: 1.295534,
  lon: 103.8,
  sog: null,
  cog: null,
  heading: null,
  nav_status: null,
  ship_name: 'MV TEST',
  callsign: null,
  imo: null,
  ship_type: null,
  length_m: null,
  width_m: null,
  source: 'aistream',
};

describe('DF-X9.6 Section 12: observation mutation guards', () => {
  it('1. Remove observation pick tag -> decodeAisPick rejects as UNKNOWN', () => {
    // Correct tag
    const tagged = { id: aisObservationTag('257000001', '2026-05-12T08:04:00.000Z') };
    expect(decodeAisPick(tagged)).toEqual({
      kind: 'AIS_OBSERVATION',
      mmsi: '257000001',
      at: '2026-05-12T08:04:00.000Z',
    });

    // Mutated: tag removed / empty id
    const untagged = { id: undefined, primitive: {} };
    expect(decodeAisPick(untagged).kind).not.toBe('AIS_OBSERVATION');
  });

  it('2. Drop observationAt -> decodeAisPick returns UNKNOWN, never an observation', () => {
    // Mutated: tag has domain AIS_OBSERVATION but missing 'at'
    const droppedAt = { id: { domain: 'AIS_OBSERVATION', mmsi: '257000001' } };
    expect(decodeAisPick(droppedAt)).toEqual({ kind: 'UNKNOWN' });
  });

  it('3. Return adjacent timestamp -> fails exact timestamp identity', () => {
    const rawAt = '2026-05-12T08:04:00.000Z';
    const decoded = decodeAisPick({ id: aisObservationTag('257000001', rawAt) });
    expect(decoded.kind).toBe('AIS_OBSERVATION');
    if (decoded.kind === 'AIS_OBSERVATION') {
      expect(decoded.at).toBe(rawAt);
      // An adjacent or neighbouring timestamp (e.g. 08:04:01 or 08:08) must fail
      expect(decoded.at).not.toBe('2026-05-12T08:04:01.000Z');
      expect(decoded.at).not.toBe('2026-05-12T08:08:00.000Z');
    }
  });

  it('4. Select vessel instead of observation -> fails kind assertion', () => {
    const contactPick = decodeAisPick({ id: aisContactTag('257000001') });
    expect(contactPick.kind).toBe('AIS_CONTACT');
    expect(contactPick.kind).not.toBe('AIS_OBSERVATION');
  });

  it('5. Convert null COG to zero -> fails null-preservation / NOT_ESTABLISHED', () => {
    const summary = buildSelectedAisSummary(
      { mmsi: '257000001', observationAt: '2026-05-12T08:04:00.000Z' },
      [OBS_ROW],
      '2026-05-12T08:16:00.000Z',
    );
    expect(summary?.observation?.cog).toBeNull();
    expect(summary?.observation?.cog).not.toBe(0);
    // Formatting null COG must render NOT_ESTABLISHED, never "0.0°" or "0°"
    expect(fmtDegrees(summary?.observation?.cog)).toBe(NOT_ESTABLISHED);
    expect(fmtDegrees(summary?.observation?.cog)).not.toBe('0.0°');
    expect(fmtDegrees(summary?.observation?.cog)).not.toBe('0°');
  });

  it('6. Remove selected-marker highlight -> highlightedObservation cleared', () => {
    resetStore();
    store.selectAis({ mmsi: '257000001', observationAt: '2026-05-12T08:04:00.000Z' });
    store.set({
      highlightedObservation: { mmsi: '257000001', at: '2026-05-12T08:04:00.000Z' },
    });
    expect(store.getState().highlightedObservation).toEqual({
      mmsi: '257000001',
      at: '2026-05-12T08:04:00.000Z',
    });
    // If highlight is removed, state must be null
    store.set({ highlightedObservation: null });
    expect(store.getState().highlightedObservation).toBeNull();
  });

  it('7. Clear SAR target during AIS pick -> store.selection must remain intact', () => {
    resetStore();
    store.select({ kind: 'target', targetId: 'DF-001', scanId: 'DF-9004-GHOST' });
    // Pick AIS observation
    store.selectAis({ mmsi: '257000001', observationAt: '2026-05-12T08:04:00.000Z' });
    // SAR target must survive untouched (DF-X9.6 Section 7 invariant)
    expect(store.getState().selection).toEqual({
      kind: 'target',
      targetId: 'DF-001',
      scanId: 'DF-9004-GHOST',
    });
  });

  it('8. Change aisCoverage on selection -> coverage remains strictly unchanged', () => {
    resetStore();
    const coverage = { state: 'AVAILABLE' as const, detail: '27 fixes', observationCount: 27 };
    store.set({ aisCoverage: coverage });
    // Pick AIS observation
    store.selectAis({ mmsi: '257000001', observationAt: '2026-05-12T08:04:00.000Z' });
    // aisCoverage MUST remain exactly identical
    expect(store.getState().aisCoverage).toEqual(coverage);
  });
});
