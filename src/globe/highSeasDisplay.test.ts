import { describe, expect, it } from 'vitest';
import type { ZoneGeometryResponse } from '../api/contract';
import { highSeasDisplay } from './maritimeGeometry';

const parts = [
  { coordinates: [[179.8, 1], [179.9, 2], [179.7, 1]] as [number, number][] },
  { coordinates: [[-179.9, 3], [-179.8, 4], [-179.7, 3]] as [number, number][] },
];
const zones: ZoneGeometryResponse = {
  layer: 'HIGH_SEAS', status: 'AVAILABLE',
  polygons: [{ id: 'high-seas', parts }],
  meta: { tolerance_deg: 0.02, source_vertex_count: 6, vertex_count: 6, part_count: 2, hole_count: 0 },
};

describe('HIGH_SEAS display handoff', () => {
  it('passes nonempty multipart polygons to the existing outline-only zone renderer', () => {
    // The defect: the loader put the only polygon into `lines`, set polygons:[], and the
    // TacticalWorld caller forwarded ONLY polygons. A 200 response and visible attribution
    // therefore accompanied zero high-seas entities. Keeping each part separate also prevents
    // spurious straight crossings over the sea when disconnected rings are flattened.
    const display = highSeasDisplay(zones);
    expect(display.lines).toEqual([]);
    expect(display.polygons).toHaveLength(1);
    expect(display.polygons[0].parts).toEqual(parts);
    expect(display.polygons[0].parts).toHaveLength(2);
  });
  it('keeps absence explicit rather than inventing geometry', () => {
    expect(highSeasDisplay({ ...zones, polygons: [] }).polygons).toEqual([]);
  });
  it('the live loader and TacticalWorld actually USE the preserved polygons', async () => {
    // A correct helper imported by tests only is the same dead-capability defect as before.
    const loader = (await import('./maritimeGeometry?raw')).default as string;
    const caller = (await import('../tactical/TacticalWorld?raw')).default as string;
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code(loader)).toContain('...highSeasDisplay(zones)');
    expect(code(caller)).toMatch(/engine\.setZoneBoundaries\(\s*highSeas\.polygons\.map/);
  });
});
