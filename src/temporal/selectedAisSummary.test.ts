/**
 * The selected-contact readout (§48-49): pure summary behaviour plus its one surface.
 *
 * The bar is the surface that already shows AIS state -- diagnostics, FRAME TRACK, the gap/MMSI
 * readout -- so the selected contact's fields land there rather than on a second panel that
 * could disagree with it. The summary builder is pure (archive rows in, typed summary out) and
 * is tested behaviourally below; the bar's RENDERING of it is source-bound by stable selectors,
 * mirroring the existing `?raw` patterns where a live viewer is unavailable.
 *
 * VOCABULARY RULES PINNED HERE
 *
 *   missing -> null in the summary, and the bar renders the shared NOT_ESTABLISHED wording --
 *   never a zero, never a dash, never an empty cell. A measured zero (SOG 0 at anchor, COG 0 due
 *   north) stays zero: absence and zero are different claims.
 *
 *   raw means raw: the observation row at `observationAt` carries the archive's own numbers,
 *   never smoothed, never interpolated, never the contact projection.
 */

import { describe, expect, it } from 'vitest';

import { buildSelectedAisSummary } from './AisPlaybackBar';
import type { AisObservationOut } from '../api/contract';

const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T08:04:00.000Z';
const T2 = '2026-03-01T08:08:00.000Z';

function observation(over: Partial<AisObservationOut> = {}): AisObservationOut {
  return {
    timestamp: T1,
    mmsi: '257000003',
    lat: 1.234567,
    lon: 103.765432,
    sog: 9.5,
    cog: 45,
    heading: 47,
    nav_status: null,
    ship_name: 'MV MERIDIAN',
    callsign: 'LAMA8',
    imo: '9876543',
    ship_type: null,
    length_m: null,
    width_m: null,
    source: 'aistream',
    ...over,
  };
}

describe('buildSelectedAisSummary', () => {
  it('returns null when nothing is selected', () => {
    expect(buildSelectedAisSummary(null, [observation()], T2)).toBeNull();
  });

  it('reports the selected contact fields from its latest observation', () => {
    const rows = [
      observation({ timestamp: T0, sog: 8.0 }),
      observation({ timestamp: T2, sog: 9.5 }),
    ];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary).not.toBeNull();
    expect(summary?.mmsi).toBe('257000003');
    expect(summary?.name).toBe('MV MERIDIAN');
    expect(summary?.imo).toBe('9876543');
    expect(summary?.callsign).toBe('LAMA8');
    expect(summary?.latestAt).toBe(T2);
    expect(summary?.sog).toBe(9.5);
    expect(summary?.cog).toBe(45);
    expect(summary?.heading).toBe(47);
    expect(summary?.source).toBe('aistream');
  });

  it('picks the latest row by timestamp, not by array order', () => {
    const rows = [
      observation({ timestamp: T2, sog: 9.5 }),
      observation({ timestamp: T0, sog: 8.0 }),
    ];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary?.latestAt).toBe(T2);
    expect(summary?.sog).toBe(9.5);
  });

  it('missing fields stay null so the bar renders NOT ESTABLISHED, never zero', () => {
    const rows = [
      observation({
        timestamp: T2,
        sog: null,
        cog: null,
        heading: null,
        ship_name: null,
        callsign: null,
        imo: null,
        source: null,
      }),
    ];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary?.sog).toBeNull();
    expect(summary?.cog).toBeNull();
    expect(summary?.heading).toBeNull();
    expect(summary?.name).toBeNull();
    expect(summary?.imo).toBeNull();
    expect(summary?.callsign).toBeNull();
    expect(summary?.source).toBeNull();
    // And the nulls are REAL nulls, not falsy zeroes or empty strings.
    expect(summary?.sog).not.toBe(0);
    expect(summary?.name).not.toBe('');
  });

  it('a measured zero survives: zero is evidence, not absence', () => {
    const rows = [observation({ timestamp: T2, sog: 0, cog: 0, heading: 0 })];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary?.sog).toBe(0);
    expect(summary?.cog).toBe(0);
    expect(summary?.heading).toBe(0);
  });

  it('carries the display state at the reference instant', () => {
    const rows = [observation({ timestamp: T0 }), observation({ timestamp: T2 })];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary?.displayState).toBe('OBSERVED');
  });

  it('a selected MMSI with no archive rows is LOST with null fields, not silence', () => {
    // Reachable after a scan reload clears the archive while a selection persists: the operator
    // sees the selected MMSI with every field NOT ESTABLISHED rather than a bar that forgot
    // what was selected.
    const summary = buildSelectedAisSummary(
      { mmsi: '257000003', observationAt: null },
      [observation({ mmsi: '257000009' })],
      T2,
    );
    expect(summary?.mmsi).toBe('257000003');
    expect(summary?.displayState).toBe('LOST');
    expect(summary?.latestAt).toBeNull();
    expect(summary?.observation).toBeNull();
  });

  it('ignores rows from other vessels', () => {
    const rows = [observation({ mmsi: '257000009', ship_name: 'MV STRANGER' })];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary?.name).toBeNull();
  });
});

describe('the raw observation row', () => {
  it('is the archive row at observationAt, verbatim -- never smoothed', () => {
    const rows = [
      observation({ timestamp: T0, lat: 1.111111, lon: 103.111111, sog: 8.2 }),
      observation({ timestamp: T2, lat: 1.234567, lon: 103.765432, sog: 9.5 }),
    ];
    const summary = buildSelectedAisSummary(
      { mmsi: '257000003', observationAt: T0 },
      rows,
      T2,
    );
    // The EARLIER fix, not the latest: the operator asked about this fix, not the vessel.
    expect(summary?.observation?.at).toBe(T0);
    expect(summary?.observation?.lat).toBe(1.111111);
    expect(summary?.observation?.lon).toBe(103.111111);
    expect(summary?.observation?.sog).toBe(8.2);
    // Full float precision survives: no rounding on the way through.
    expect(summary?.observation?.lat).not.toBe(1.11);
  });

  it('is absent without observationAt: a contact pick names no fix', () => {
    const rows = [observation({ timestamp: T2 })];
    const summary = buildSelectedAisSummary({ mmsi: '257000003', observationAt: null }, rows, T2);
    expect(summary?.observation).toBeNull();
  });

  it('an observationAt with no matching row is absent, never a neighbouring fix', () => {
    // Substituting the nearest row would point the highlight at an observation nobody picked.
    const rows = [observation({ timestamp: T2 })];
    const summary = buildSelectedAisSummary(
      { mmsi: '257000003', observationAt: '2026-03-01T09:00:00.000Z' },
      rows,
      T2,
    );
    expect(summary?.observation).toBeNull();
    // The contact itself is still described.
    expect(summary?.mmsi).toBe('257000003');
  });
});

describe('the bar renders the summary on its one surface', () => {
  it('the selected section and the raw row carry stable selectors', () => {
    expect(BAR_CODE).toContain('data-df-ais-selected');
    expect(BAR_CODE).toContain('data-df-ais-selected-observation');
  });

  it('missing fields render the shared absence wording', () => {
    expect(BAR_CODE).toContain('NOT_ESTABLISHED');
  });

  it('the bar reads the store authorities rather than recomputing them', () => {
    // `selectedAis` names the contact, `aisObservations` is the verbatim archive. Reading both
    // from the store is what keeps this readout from disagreeing with the globe.
    expect(BAR_CODE).toContain('selectedAis');
    expect(BAR_CODE).toContain('aisObservations');
  });
});

/* ============================================================================================== *
 * SOURCE, READ AT TEST TIME
 * ============================================================================================== */

function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const BAR_SOURCE = (await import('./AisPlaybackBar?raw')).default as string;
const BAR_CODE = codeOf(BAR_SOURCE);
