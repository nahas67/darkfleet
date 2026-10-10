import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SceneComparisonWorkbench, comparePersistedScenes,
  listPersistedSceneCandidates, readSceneCandidates, readSceneComparison,
  type SceneComparison,
} from './SceneComparisonWorkbench';

const identity = (scanId: string) => ({
  scan_id: scanId, item_id: 'sentinel-' + scanId,
  acquisition_time: '2026-09-01T00:00:00Z',
  product: 'RTC', polarization: 'VV', crs: 'EPSG:4326',
  window_transform: [0.1, 0, 100, 0, -0.1, 10],
  raster_shape: [3, 3], processing_version: 'science-v1',
  source: 'PERSISTED_REAL_SCAN_CALIBRATED_CACHE' as const,
});
const measured: SceneComparison = {
  status: 'MEASURED',
  reason: 'EXACT_SAME_AFFINE_PIXEL_LATTICE_RTC_GAMMA0_DB',
  first: identity('A'), second: identity('B'),
  acquisition_interval_hours: 24,
  caveat: 'These are only recorded per-pixel backscatter differences, not tracked changes.',
  metrics: {
    overlap_shape: [3, 3], offset_b_in_a_pixels: [0, 0],
    overlap_pixels: 9, valid_pair_pixels: 8, valid_pair_fraction: 8 / 9,
    mean_b_minus_a_db: 1, mean_absolute_difference_db: 1,
    root_mean_square_difference_db: 1, median_b_minus_a_db: 1,
    p05_b_minus_a_db: 1, p95_b_minus_a_db: 1,
    brighter_b_pixels: 8, darker_b_pixels: 0, equal_pixels: 0,
    metric: 'SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE',
  },
};
const candidates = {
  scenes: ['A', 'B'].map((id) => ({
    scan_id: id, item_id: 'sentinel-' + id,
    acquisition_time: '2026-09-01T00:00:00Z',
    product: 'RTC', polarization: 'VV',
    available_normalized_raster: true, georeference_present: true,
  })),
  total_real_scans: 2,
  note: 'Persisted REAL records only',
};
const response = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
afterEach(() => vi.unstubAllGlobals());

describe('DF-X10/X11 scientific scene comparison contracts', () => {
  it('retains explicit inability to compare, never inventing a delta', () => {
    expect(readSceneComparison({
      ...measured, status: 'NOT_COMPARABLE', metrics: null,
      reason: 'AFFINE_GRIDS_NOT_IDENTICAL_NO_COREGISTRATION',
    }).metrics).toBeNull();
    expect(() => readSceneComparison({
      ...measured, status: 'NOT_COMPARABLE',
    })).toThrow(/Unsupported grids cannot have a measurement/);
    expect(() => readSceneComparison({
      ...measured, status: 'MEASURED', metrics: null,
    })).toThrow(/MEASURED without samples/);
    expect(() => readSceneComparison({
      ...measured, first: { ...measured.first, source: 'SYNTHETIC' },
    })).toThrow(/Real persisted source assertion missing/);
  });

  it('checks finite physical pixel statistics and source fields', () => {
    expect(readSceneComparison(measured).metrics?.valid_pair_pixels).toBe(8);
    expect(() => readSceneComparison({
      ...measured, metrics: { ...measured.metrics, mean_b_minus_a_db: 'not-measured' },
    })).toThrow(/mean_b_minus_a_db/);
    expect(() => readSceneComparison({
      ...measured, metrics: { ...measured.metrics, valid_pair_pixels: 10 },
    })).toThrow(/Impossible overlap counts/);
    expect(() => readSceneCandidates({
      ...candidates, scenes: [{ ...candidates.scenes[0], available_normalized_raster: 'yes' }],
    })).toThrow(/available_normalized_raster/);
  });

  it('loads independently persisted REAL candidates and posts only chosen IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(candidates))
      .mockResolvedValueOnce(response(measured));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listPersistedSceneCandidates()).map((row) => row.scan_id)).toEqual(['A', 'B']);
    expect((await comparePersistedScenes('A', 'B')).status).toBe('MEASURED');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/sar/compare/scans?limit=100', '/api/sar/compare',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      first_scan_id: 'A', second_scan_id: 'B',
    });
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
  });

  it('refuses mismatched source identities even when server returns measured metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...measured, second: { ...measured.second, scan_id: 'OTHER' },
    })));
    await expect(comparePersistedScenes('A', 'B')).rejects.toThrow(/different scans/);
    await expect(comparePersistedScenes('A', 'A')).rejects.toThrow(/different persisted REAL/);
  });

  it('presents comparison controls and calibration warning even before any scan', () => {
    const html = renderToStaticMarkup(<SceneComparisonWorkbench />);
    expect(html).toContain('data-df-scene-comparison-workbench');
    expect(html).toContain('data-df-sar-first');
    expect(html).toContain('data-df-sar-second');
    expect(html).toContain('data-df-sar-compare');
    expect(html).toContain('No automatic warping');
    expect(html).not.toContain('data-df-sar-metrics');
  });
});
