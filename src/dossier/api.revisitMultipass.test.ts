import { describe, expect, it, vi } from 'vitest';
import type { TracksOut } from '../api/contract';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../api/errors', () => ({ api: { get: mocks.get } }));
vi.mock('../api/validateGenerated', () => ({
  contractValidator: () => (data: unknown) => data,
  validateShape: (data: unknown) => data,
}));

import { loadRevisitAround, tracksForPosition } from './api';

describe('area and track queries at the antimeridian', () => {
  it.each([
    [179.995, 179.985, -179.995],
    [-179.995, 179.995, -179.985],
    [103.8, 103.79, 103.81],
  ])('uses the actual symmetric 0.01° bbox around longitude %s', async (longitude, left, right) => {
    mocks.get.mockReset().mockResolvedValue({ acquisition_count: 0 });
    await loadRevisitAround(
      { scanId: 'SCAN-1', targetId: 'DF-001' }, { lat: 1.25, lon: longitude },
    )(new AbortController().signal);
    const path: string = mocks.get.mock.calls[0][0];
    const bbox = new URL(path, 'https://local.invalid').searchParams.get('bbox');
    expect(bbox).not.toBeNull();
    const coordinates = bbox!.split(',').map(Number);
    expect(coordinates[0]).toBeCloseTo(left, 8);
    expect(coordinates[1]).toBeCloseTo(1.24, 8);
    expect(coordinates[2]).toBeCloseTo(right, 8);
    expect(coordinates[3]).toBeCloseTo(1.26, 8);
  });

  it('finds a real nearby track across the +180/-180 seam', () => {
    const tracks = { tracks: [
      { track_id: 'near', points: [{ lat: 1.0, lon: -179.999 }] },
      { track_id: 'far', points: [{ lat: 1.0, lon: -179.9 }] },
    ] } as unknown as TracksOut;
    expect(tracksForPosition(tracks, { lat: 1.0, lon: 179.999 }, 400)
      .map((t) => t.track_id)).toEqual(['near']);
  });
});
