/**
 * Proves the DF-X9.1 data-path fixes at the boundary they were made at.
 *
 * The defect being guarded here is not a crash. It is a SILENT loss of evidence at a projection
 * boundary: fields that exist in the contract, exist in the archive, and reach the store as
 * `null` -- indistinguishable from a vessel that reported nothing. A test suite that only
 * checked "did it throw" would have stayed green through all of it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
vi.mock('./errors', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  ApiError: class ApiError extends Error {},
  ContractViolation: class ContractViolation extends Error {},
}));

import { loadScanAis } from './client';
import { store } from '../state/store';

const T0 = '2026-03-01T12:00:00Z';
const at = (minutes: number): string =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** A complete, contract-valid `ScanAisResponse`. */
function response(observations: unknown[]) {
  return {
    scan_id: 'S1',
    coverage: {
      state: 'AVAILABLE',
      detail: 'AIS window covered.',
      observation_count: observations.length,
      window_start: T0,
      window_end: at(20),
      archive_oldest: T0,
      archive_newest: at(20),
      sources: ['aistream'],
    },
    window: [at(-15), at(15)],
    bbox: [102, 0, 104, 2],
    observations,
    note: 'scan AIS window',
  };
}

function observation(over: Record<string, unknown> = {}) {
  return {
    timestamp: T0,
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

beforeEach(() => {
  getMock.mockReset();
  store.set({ scanId: null, aisOnly: [], aisObservations: [] });
});

describe('the route that used to discard the evidence', () => {
  it('retains every observation, not just the latest per vessel', () => {
    // THE regression. `payload.observations` was fetched and never read, so a vessel's history
    // was unreachable without a second request and the globe had nothing to orient by.
    getMock.mockResolvedValue(
      response([
        observation({ timestamp: at(0), lat: 1.0 }),
        observation({ timestamp: at(4), lat: 1.004 }),
        observation({ timestamp: at(8), lat: 1.008 }),
      ]),
    );
    return loadScanAis('S1').then(() => {
      expect(store.getState().aisObservations).toHaveLength(3);
    });
  });

  it('carries reported kinematics through to the contact', () => {
    getMock.mockResolvedValue(
      response([observation({ sog: 12.5, cog: 275, heading: 271 })]),
    );
    return loadScanAis('S1').then(() => {
      const contact = store.getState().aisOnly[0];
      expect(contact.sog).toBe(12.5);
      expect(contact.cog).toBe(275);
      // Never present on the type before DF-X9, so a renderer could not prefer a vessel's own
      // heading over its course.
      expect(contact.heading).toBe(271);
    });
  });

  it('distinguishes not-reported from measured zero', () => {
    // THE hazard. `sog: null` and `sog: 0` are different claims, and reading either as the other
    // makes an anchored vessel indistinguishable from a silent one.
    getMock.mockResolvedValue(
      response([
        observation({ mmsi: '257000001', sog: null, cog: null, heading: null }),
        observation({ mmsi: '257000002', sog: 0, cog: 0, heading: 0 }),
      ]),
    );
    return loadScanAis('S1').then(() => {
      const byMmsi = new Map(store.getState().aisOnly.map((c) => [c.mmsi, c]));
      expect(byMmsi.get('257000001')!.sog).toBeNull();
      expect(byMmsi.get('257000001')!.cog).toBeNull();
      expect(byMmsi.get('257000002')!.sog).toBe(0);
      expect(byMmsi.get('257000002')!.cog).toBe(0);
      expect(byMmsi.get('257000002')!.heading).toBe(0);
    });
  });

  it('draws one marker per vessel, at its newest fix', () => {
    getMock.mockResolvedValue(
      response([
        observation({ mmsi: '257000001', timestamp: at(0), lat: 1.0 }),
        observation({ mmsi: '257000001', timestamp: at(8), lat: 1.008 }),
      ]),
    );
    return loadScanAis('S1').then(() => {
      const contacts = store.getState().aisOnly;
      expect(contacts).toHaveLength(1);
      // At the NEWEST fix, not the oldest: a marker left at a stale fix would be a contact
      // drawn where the vessel no longer is.
      expect(contacts[0].lat).toBe(1.008);
      expect(contacts[0].timestamp).toBe(at(8));
    });
  });

  it('stores the coverage state', () => {
    getMock.mockResolvedValue(response([]));
    return loadScanAis('S1').then(() => {
      expect(store.getState().aisCoverage?.state).toBe('AVAILABLE');
    });
  });

  it('drops a contact with unusable coordinates rather than drawing it at the origin', () => {
    // 0,0 is Null Island. A contact with a NaN coordinate would otherwise render in the Gulf of
    // Guinea, which is a fabricated position rather than a missing one.
    getMock.mockResolvedValue(
      response([
        observation({ mmsi: '257000001', lat: 1.0 }),
        observation({ mmsi: '257000002', lat: Number.NaN, lon: Number.NaN }),
      ]),
    );
    return loadScanAis('S1').then(() => {
      const contacts = store.getState().aisOnly;
      expect(contacts).toHaveLength(1);
      expect(contacts[0].mmsi).toBe('257000001');
    });
  });

  it('does not let an unparseable timestamp displace a real one', () => {
    getMock.mockResolvedValue(
      response([
        observation({ mmsi: '257000001', timestamp: at(4), lat: 1.004 }),
        observation({ mmsi: '257000001', timestamp: 'not-a-time', lat: 9.9 }),
      ]),
    );
    return loadScanAis('S1').then(() => {
      expect(store.getState().aisOnly[0].lat).toBe(1.004);
    });
  });

  it('merges deterministically with existing ais_only without dropping unmatched contacts', async () => {
    // DF-X9.8-H4: Store already has an unmatched contact from targets payload.ais_only
    store.set({
      scanId: 'S1',
      aisOnly: [
        {
          mmsi: '257000999',
          lat: 1.5,
          lon: 103.9,
          timestamp: at(0),
          shipName: 'MV UNMATCHED',
          sog: null,
          cog: null,
          heading: null,
        },
      ],
    });

    getMock.mockResolvedValue(
      response([
        observation({ mmsi: '257000001', timestamp: at(4), lat: 1.004, sog: 12.0 }),
      ]),
    );

    await loadScanAis('S1');

    const contacts = store.getState().aisOnly;
    const byMmsi = new Map(contacts.map((c) => [c.mmsi, c]));
    // Both survive: the archive contact AND the unmatched contact from targets
    expect(byMmsi.has('257000001')).toBe(true);
    expect(byMmsi.has('257000999')).toBe(true);
    expect(byMmsi.get('257000001')!.sog).toBe(12.0);
  });

  it('discards a response when the active scanId has changed', async () => {
    // Active scan moved on to S2
    store.set({ scanId: 'S2', aisObservations: [] });

    getMock.mockResolvedValue(
      response([observation({ mmsi: '257000001', timestamp: at(4), lat: 1.004 })]),
    );

    // Stale S1 response returns
    await loadScanAis('S1');

    // S2 state is not clobbered by stale S1 response
    expect(store.getState().aisObservations).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('rejects a payload whose keys are not in the generated contract', () => {
    // Runtime validation, added by DF-X9. A drifted payload used to be typed as correct and
    // would have arrived as `undefined` -- which for `observations` reads as an EMPTY ARCHIVE,
    // a completely different claim from a vessel that reported nothing.
    getMock.mockResolvedValue({
      ...response([observation()]),
      observations_renamed: [],
    });
    return loadScanAis('S1').then(() => {
      expect(store.getState().aisCoverage?.state).toBe('UNAVAILABLE');
      expect(store.getState().aisObservations).toEqual([]);
    });
  });

  it('clears contacts on failure instead of leaving a previous scan on the globe', () => {
    getMock.mockResolvedValueOnce(
      response([observation({ mmsi: '257000001' })]),
    );
    return loadScanAis('S1')
      .then(() => {
        expect(store.getState().aisOnly).toHaveLength(1);
        getMock.mockRejectedValueOnce(new Error('network'));
        return loadScanAis('S2');
      })
      .then(() => {
        // Left in place, these would be contacts from the PREVIOUS window drawn as though they
        // were current -- the exact failure the display-state model exists to prevent.
        expect(store.getState().aisOnly).toEqual([]);
        expect(store.getState().aisObservations).toEqual([]);
      });
  });

  it('does not report a healthy state after a contract violation', () => {
    getMock.mockResolvedValue({ coverage: {}, observations: [] });
    return loadScanAis('S1').then(() => {
      expect(store.getState().aisCoverage?.state).not.toBe('AVAILABLE');
    });
  });
});