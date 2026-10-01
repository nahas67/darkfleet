/**
 * Layer registry tests: authoritative definition, capability gating, and the
 * no-leak guarantee across repeated scans (UI-006, correction #8).
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { LayerRegistry, LAYER_DEFS, bboxPolygon } from './registry.ts';
import type { RegisteredLayer } from './registry.ts';
import type { LayerId } from '../types/api.ts';

function fakeLayer(id: LayerId, log: string[]): RegisteredLayer {
  return {
    config: LAYER_DEFS.find((l) => l.id === id)!,
    mount: vi.fn(() => log.push(`mount:${id}`)),
    update: vi.fn(() => log.push(`update:${id}`)),
    setVisible: vi.fn(() => log.push(`visible:${id}`)),
    setOpacity: vi.fn(() => log.push(`opacity:${id}`)),
    dispose: vi.fn(() => log.push(`dispose:${id}`)),
  };
}

/** Minimal viewer stand-in: the registry only forwards calls to layers. */
const viewer = {} as never;

describe('LayerRegistry', () => {
  it('declares every required layer exactly once', () => {
    const ids = LAYER_DEFS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of [
      'BASE_WORLD', 'SAR_RASTER', 'SAR_SCENE_FOOTPRINT', 'LAND_MASK',
      'SAR_DETECTIONS', 'AIS_CONTACTS', 'AIS_TRAILS', 'CORRELATION_LINKS',
      'UNCERTAINTY_RADII', 'SELECTED_TARGET', 'CFAR_DEBUG',
      'MULTIPASS_TRACKS', 'WAKE_GEOMETRY', 'ML_OUTPUT', 'TEMPORAL_ANOMALIES',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it('marks unimplemented advanced layers NOT_AVAILABLE and hides them', () => {
    const reg = new LayerRegistry();
    const available = reg.available().map((l) => l.id);
    // Advanced features are NOT_AVAILABLE before CP15 — never rendered as fake data.
    const advanced: LayerId[] = ['MULTIPASS_TRACKS', 'WAKE_GEOMETRY', 'ML_OUTPUT', 'TEMPORAL_ANOMALIES'];
    for (const id of advanced) {
      expect(available).not.toContain(id);
      expect(reg.capability(id)).toBe('NOT_AVAILABLE');
    }
    expect(available).toContain('SAR_DETECTIONS');
  });

  it('never updates a layer whose capability is not available', () => {
    const log: string[] = [];
    const reg = new LayerRegistry();
    const layer = fakeLayer('MULTIPASS_TRACKS', log);
    reg.register(layer);
    reg.setViewer(viewer);
    log.length = 0;
    reg.update('MULTIPASS_TRACKS', { tracks: [{ lat: 1, lon: 1 }] });
    expect(layer.update).not.toHaveBeenCalled();
  });

  it('re-registering a layer disposes the previous instance (no leak)', () => {
    const log: string[] = [];
    const reg = new LayerRegistry();
    const first = fakeLayer('SAR_DETECTIONS', log);
    reg.register(first);
    reg.setViewer(viewer);
    log.length = 0;
    const second = fakeLayer('SAR_DETECTIONS', log);
    reg.register(second);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    reg.setViewer(viewer);
    expect(second.mount).toHaveBeenCalled();
  });

  it('disposeAll releases every registered layer exactly once', () => {
    const log: string[] = [];
    const reg = new LayerRegistry();
    const a = fakeLayer('SAR_DETECTIONS', log);
    const b = fakeLayer('AIS_CONTACTS', log);
    reg.register(a);
    reg.register(b);
    reg.setViewer(viewer);
    log.length = 0;
    reg.disposeAll();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
  });

  it('repeated scans do not accumulate layers', () => {
    const reg = new LayerRegistry();
    for (let scan = 0; scan < 5; scan++) {
      const log: string[] = [];
      reg.register(fakeLayer('SAR_DETECTIONS', log));
      reg.register(fakeLayer('CORRELATION_LINKS', log));
    }
    expect(reg.size).toBe(2);
  });

  it('ignores opacity on layers that do not support it', () => {
    const log: string[] = [];
    const reg = new LayerRegistry();
    const layer = fakeLayer('BASE_WORLD', log);
    reg.register(layer);
    reg.setViewer(viewer);
    reg.setOpacity('BASE_WORLD', 0.5);
    expect(layer.setOpacity).not.toHaveBeenCalled();
  });

  it('builds a closed AOI polygon', () => {
    const poly = bboxPolygon([103.65, 1.1, 104.05, 1.4]);
    expect(poly).toHaveLength(5);
    expect(poly[0].equals(poly[4])).toBe(true);
  });
});