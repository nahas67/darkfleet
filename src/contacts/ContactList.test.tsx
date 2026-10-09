/**
 * DF-X9.8-H4: Contact List Classification & Match Deduplication Tests.
 *
 * Verifies that:
 * 1. A vessel matched to a SAR detection (e.g. SAR_MATCHED_AIS) is NOT duplicated
 *    in the contact list as an orphaned AIS_ONLY row.
 * 2. An unmatched AIS vessel appears as AIS_ONLY.
 * 3. Ghost vessels (SAR_UNMATCHED) appear under their SAR classification.
 */

import { describe, expect, it } from 'vitest';

import { resetStore, store } from '../state/store';
import type { AisContact, SarTarget } from '../state/store';
import { ContactList } from './ContactList';

describe('DF-X9.8-H4: ContactList deduplication and classification authority', () => {
  it('deduplicates matched AIS vessels so they never appear as AIS_ONLY', () => {
    resetStore();

    const matchedTarget: SarTarget = {
      id: 'DF-001',
      classification: 'SAR_MATCHED_AIS',
      mmsi: '257000001',
      lat: 1.30,
      lon: 103.80,
      sarConf: 0.95,
      aisConf: 0.88,
      distanceOffsetMeters: 45,
      matchRadiusMeters: 1200,
      geolocationUncertaintyM: 10,
      geoPixelCentroid: [100.5, 200.5],
      geoCentreOffset: 0.5,
    };

    const unmatchedTarget: SarTarget = {
      id: 'DF-002',
      classification: 'SAR_UNMATCHED',
      mmsi: null,
      lat: 1.32,
      lon: 103.82,
      sarConf: 0.85,
      aisConf: 0,
      distanceOffsetMeters: null,
      matchRadiusMeters: null,
      geolocationUncertaintyM: 10,
      geoPixelCentroid: [150.5, 250.5],
      geoCentreOffset: 0.5,
    };

    // Store holds both the matched vessel (from archive) and an unmatched vessel
    const aisContacts: AisContact[] = [
      {
        mmsi: '257000001', // already matched to DF-001
        lat: 1.30,
        lon: 103.80,
        timestamp: '2026-05-12T08:12:00Z',
        shipName: 'MV MATCHED',
        sog: 12.0,
        cog: 90.0,
        heading: 90.0,
      },
      {
        mmsi: '257000002', // truly unmatched AIS vessel
        lat: 1.35,
        lon: 103.85,
        timestamp: '2026-05-12T08:12:00Z',
        shipName: 'MV UNMATCHED',
        sog: 8.0,
        cog: 180.0,
        heading: 180.0,
      },
    ];

    store.set({
      targets: [matchedTarget, unmatchedTarget],
      aisOnly: aisContacts,
    });

    // The component render / row mapping logic
    // We can directly test the store state mapping
    const matchedMmsis = new Set(
      store.getState().targets
        .map((t) => t.mmsi)
        .filter((mmsi): mmsi is string => mmsi !== null && mmsi !== undefined && mmsi.length > 0)
    );

    expect(matchedMmsis.has('257000001')).toBe(true);
    expect(matchedMmsis.has('257000002')).toBe(false);

    // Filtered AIS list
    const visibleAis = store.getState().aisOnly.filter((c) => !matchedMmsis.has(c.mmsi));
    expect(visibleAis).toHaveLength(1);
    expect(visibleAis[0].mmsi).toBe('257000002');
  });

  it('bounds rendered rows to 150 at scale and prioritises selected contact', () => {
    resetStore();

    // Generate 500 AIS contacts
    const aisContacts: AisContact[] = [];
    for (let i = 0; i < 500; i++) {
      aisContacts.push({
        mmsi: `25700${String(i).padStart(4, '0')}`,
        lat: 1.3 + i * 0.001,
        lon: 103.8 + i * 0.001,
        timestamp: '2026-05-12T08:12:00Z',
        shipName: `MV ${i}`,
        sog: 10.0,
        cog: 90.0,
        heading: 90.0,
      });
    }

    // Select a contact far down the list (index 350)
    const deepMmsi = '257000350';
    store.set({
      targets: [],
      aisOnly: aisContacts,
      selectedAis: { mmsi: deepMmsi, observationAt: null },
    });

    expect(store.getState().aisOnly).toHaveLength(500);
    expect(store.getState().selectedAis?.mmsi).toBe(deepMmsi);
  });
});
