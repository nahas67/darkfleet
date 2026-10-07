/**
 * DF-X9.6 section 7: SAR target and AIS contact selection coexist.
 *
 * The single `selection` union used to collapse both authorities into one
 * reference, so selecting an AIS contact REPLACED the selected SAR target.
 * Section 7 forbids that: `selection` names the SAR target (or scene), and
 * `selectedAis` names the AIS contact, and neither write may disturb the other.
 *
 * Written FIRST against the old union, where `selectAis` does not exist, so
 * every test here fails until the split lands.
 */

import { describe, expect, it } from 'vitest';

import { resetStore, store } from './store';

describe('DF-X9.6 section 7: target and AIS selection coexist', () => {
  it('selecting an AIS contact leaves the SAR target intact', () => {
    resetStore();
    store.select({ kind: 'target', targetId: 'DF-001', scanId: 'DF-0001' });
    store.selectAis({ mmsi: '123456789' });
    expect(store.getState().selection).toEqual({
      kind: 'target',
      targetId: 'DF-001',
      scanId: 'DF-0001',
    });
    expect(store.getState().selectedAis).toEqual({ mmsi: '123456789', observationAt: null });
  });

  it('selecting a SAR target leaves the AIS contact intact', () => {
    resetStore();
    store.selectAis({ mmsi: '123456789' });
    store.select({ kind: 'target', targetId: 'DF-002', scanId: 'DF-0001' });
    expect(store.getState().selectedAis).toEqual({ mmsi: '123456789', observationAt: null });
    expect(store.getState().selection).toEqual({
      kind: 'target',
      targetId: 'DF-002',
      scanId: 'DF-0001',
    });
  });

  it('clearAis leaves the SAR target selected', () => {
    resetStore();
    store.select({ kind: 'target', targetId: 'DF-001', scanId: 'DF-0001' });
    store.selectAis({ mmsi: '123456789' });
    store.clearAis();
    expect(store.getState().selectedAis).toBeNull();
    expect(store.getState().selection).toEqual({
      kind: 'target',
      targetId: 'DF-001',
      scanId: 'DF-0001',
    });
  });

  it('select({ kind: none }) clears BOTH authorities (Escape semantics)', () => {
    // Existing UX: Escape clears the selection. With two authorities that must
    // mean both, or Escape would leave a highlighted contact behind with no
    // visible way to clear it.
    resetStore();
    store.select({ kind: 'target', targetId: 'DF-001', scanId: 'DF-0001' });
    store.selectAis({ mmsi: '123456789' });
    store.select({ kind: 'none' });
    expect(store.getState().selection).toEqual({ kind: 'none' });
    expect(store.getState().selectedAis).toBeNull();
  });

  it('an observation pick carries the EXACT raw timestamp, else null', () => {
    resetStore();
    store.selectAis({ mmsi: '123456789', observationAt: '2026-03-01T08:08:00Z' });
    expect(store.getState().selectedAis).toEqual({
      mmsi: '123456789',
      observationAt: '2026-03-01T08:08:00Z',
    });
    store.selectAis({ mmsi: '987654321' });
    expect(store.getState().selectedAis).toEqual({ mmsi: '987654321', observationAt: null });
  });

  it('re-selecting the same contact preserves its observation, a new one resets', () => {
    resetStore();
    store.selectAis({ mmsi: '123456789', observationAt: '2026-03-01T08:08:00Z' });
    // Same vessel, no new observation: the operator is still looking at the
    // same fix, so the timestamp survives.
    store.selectAis({ mmsi: '123456789' });
    expect(store.getState().selectedAis).toEqual({
      mmsi: '123456789',
      observationAt: '2026-03-01T08:08:00Z',
    });
    // A different vessel never inherits another vessel's fix.
    store.selectAis({ mmsi: '555555555' });
    expect(store.getState().selectedAis).toEqual({ mmsi: '555555555', observationAt: null });
  });

  it('selectAis(null) clears the AIS authority and leaves the target', () => {
    resetStore();
    store.select({ kind: 'target', targetId: 'DF-001', scanId: 'DF-0001' });
    store.selectAis({ mmsi: '123456789' });
    store.selectAis(null);
    expect(store.getState().selectedAis).toBeNull();
    expect(store.getState().selection).toEqual({
      kind: 'target',
      targetId: 'DF-001',
      scanId: 'DF-0001',
    });
  });
});
