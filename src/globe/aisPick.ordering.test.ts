import { describe, expect, it } from 'vitest';
import {
  aisContactTag,
  aisObservationTag,
  aisTrackTag,
  decodeAisClickStack,
  decodeAisPick,
} from './aisPick';

/**
 * Pure decoder regression only. These tests do NOT simulate a Cesium pointer
 * click or claim that a historical billboard can be hit on the live canvas.
 * Physical marker reachability is owned by ais_observation_pointer_e2e.py.
 */
describe('AIS decoder source identity during adverse click ordering', () => {
  const mmsi = '257771001';
  const early = '2026-10-10T12:04:00Z';
  const late = '2026-10-10T12:08:00Z';

  it('returns an exact historical source timestamp, not the latest fix or playback instant', () => {
    const tagged = { id: aisObservationTag(mmsi, early), primitive: {} };
    expect(decodeAisPick(tagged)).toEqual({ kind: 'AIS_OBSERVATION', mmsi, at: early });
    expect(decodeAisPick({ id: aisObservationTag(mmsi, late) })).toEqual({
      kind: 'AIS_OBSERVATION', mmsi, at: late,
    });
    // Input is not mutated: repeated clicks never relabel the earlier source.
    expect(tagged.id).toEqual({ domain: 'AIS_OBSERVATION', mmsi, at: early });
  });

  it('contact/track/observation picks remain independent when rapidly interleaved', () => {
    const input = [
      { id: aisObservationTag(mmsi, early) },
      { id: aisContactTag(mmsi) },
      { id: aisTrackTag(mmsi) },
      { id: aisObservationTag(mmsi, late) },
      { id: aisObservationTag(mmsi, early) },
    ];
    expect(input.map((p) => decodeAisPick(p))).toEqual([
      { kind: 'AIS_OBSERVATION', mmsi, at: early },
      { kind: 'AIS_CONTACT', mmsi },
      { kind: 'AIS_TRACK', mmsi },
      { kind: 'AIS_OBSERVATION', mmsi, at: late },
      { kind: 'AIS_OBSERVATION', mmsi, at: early },
    ]);
  });

  it('never infers observation identity from a previous click or untagged contact', () => {
    const fallback = () => mmsi;
    expect(decodeAisPick({ id: aisObservationTag(mmsi, early) }, fallback)).toEqual({
      kind: 'AIS_OBSERVATION', mmsi, at: early,
    });
    expect(decodeAisPick({ primitive: {} }, fallback)).toEqual({ kind: 'AIS_CONTACT', mmsi });
    expect(decodeAisPick({ id: { domain: 'AIS_OBSERVATION', mmsi } }, fallback)).toEqual({
      kind: 'UNKNOWN',
    });
    expect(decodeAisPick(null, fallback)).toEqual({ kind: 'UNKNOWN' });
  });

  it('prefers one exact observed source fix beneath a same-MMSI track at the SAME picked pixel', () => {
    const top = { id: aisTrackTag(mmsi) };
    const stack = [top, { id: aisObservationTag(mmsi, early) }];
    expect(decodeAisClickStack(top, stack, true)).toEqual({
      kind: 'AIS_OBSERVATION', mmsi, at: early,
    });
    // Repeated clicks do not cycle observation identities or use playback time.
    expect(decodeAisClickStack(top, stack, true)).toEqual({
      kind: 'AIS_OBSERVATION', mmsi, at: early,
    });
    expect(decodeAisClickStack(top, stack, false)).toEqual({ kind: 'AIS_TRACK', mmsi });
  });

  it('never steals a direct contact, SAR target, prediction or foreign overlay click', () => {
    const marker = { id: aisObservationTag(mmsi, early) };
    const under = [marker];
    expect(decodeAisClickStack({ id: aisContactTag(mmsi) }, under, true)).toEqual({
      kind: 'AIS_CONTACT', mmsi,
    });
    expect(decodeAisClickStack({ id: { name: 'target:SAR-01' } }, under, true)).toEqual({
      kind: 'SAR_TARGET', targetId: 'SAR-01',
    });
    expect(decodeAisClickStack({ id: { domain: 'AIS_PREDICTION', mmsi } }, under, true))
      .toEqual({ kind: 'AIS_PREDICTION', mmsi });
    expect(decodeAisClickStack({ id: { domain: 'EEZ' } }, under, true))
      .toEqual({ kind: 'UNKNOWN' });
  });

  it('rejects conflicting fixes at one pixel and cross-vessel/invalid observation tags', () => {
    const top = { id: aisTrackTag(mmsi) };
    expect(decodeAisClickStack(top, [
      { id: aisObservationTag(mmsi, early) },
      { id: aisObservationTag(mmsi, late) },
    ], true)).toEqual({ kind: 'AIS_TRACK', mmsi });
    expect(decodeAisClickStack(top, [
      { id: aisObservationTag('257771002', early) },
      { id: { domain: 'AIS_OBSERVATION', mmsi } },
    ], true)).toEqual({ kind: 'AIS_TRACK', mmsi });
    // Duplicate primitive hits naming the SAME raw timestamp are not ambiguous.
    expect(decodeAisClickStack(top, [
      { id: aisObservationTag(mmsi, late) },
      { id: aisObservationTag(mmsi, late) },
    ], true)).toEqual({ kind: 'AIS_OBSERVATION', mmsi, at: late });
  });
});
