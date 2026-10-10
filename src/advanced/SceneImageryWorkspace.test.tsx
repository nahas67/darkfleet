import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SceneImageryWorkspace, listImageryCandidates, loadImageryPair, readImageryPair,
  type ImageryScene,
} from './SceneImageryWorkspace';

const first: ImageryScene = {
  scan_id: 'ONE', status: 'READY', reason: 'CHECKSUM_VERIFIED_REAL_RTC_SOURCE',
  item_id: 's1-one', acquisition_time: '2026-09-01T00:00:00Z', product: 'RTC',
  polarization: 'VV', platform: 'sentinel-1a', provider: 'planetary-computer',
  crs: 'EPSG:4326', transform: [0.1, 0, 100, 0, -0.1, 10],
  wgs84_corners_lon_lat: [[100, 10], [100.3, 10], [100.3, 9.8], [100, 9.8]],
  raster_window: [5, 6, 2, 3], source_shape: [2, 3], preview_shape: [2, 3],
  sample_stride: 1, valid_source_pixels: 5, total_source_pixels: 6,
  displayed_valid_pixels: 5, image_url: '/api/sar/imagery/scans/ONE/image',
  display_window_db: [-30, 5], source: 'PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC',
};
const second: ImageryScene = {
  ...first, scan_id: 'TWO', item_id: 's1-two', polarization: 'VH',
  crs: 'EPSG:3857', transform: [10, 0, 1000, 0, -10, 1000],
  wgs84_corners_lon_lat: [[0.01, 0.01], [0.0103, 0.01], [0.0103, 0.0098], [0.01, 0.0098]],
  image_url: '/api/sar/imagery/scans/TWO/image',
};
const result = {
  first, second, status: 'READY',
  interpretation: 'Independent RTC display. No pixel alignment or inferred change.',
};
const candidateList = {
  scenes: ['ONE', 'TWO'].map((scan_id) => ({
    scan_id, item_id: `s1-${scan_id}`, acquisition_time: '2026-09-01T00:00:00Z',
    product: 'RTC', polarization: 'VV', available_normalized_raster: true,
    georeference_present: true,
  })), total_real_scans: 2, note: 'Persisted REAL scans only',
};
const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
afterEach(() => vi.unstubAllGlobals());

describe('DF-X21 persisted two-scene SAR imagery', () => {
  it('accepts two independent, incompatible geographic grids without claiming any change', () => {
    expect(readImageryPair(result, 'ONE', 'TWO').first.source_shape).toEqual([2, 3]);
    expect(readImageryPair(result, 'ONE', 'TWO').second.crs).toBe('EPSG:3857');
    expect(readImageryPair(result, 'ONE', 'TWO').status).toBe('READY');
  });

  it('rejects unverified sources, remote image urls, invalid geometry and false availability', () => {
    expect(() => readImageryPair({ ...result, first: { ...first, source: 'SYNTHETIC' } },
      'ONE', 'TWO')).toThrow(/REAL RTC/);
    expect(() => readImageryPair({ ...result, first: { ...first,
      image_url: 'https://example.com/fake.png' } }, 'ONE', 'TWO')).toThrow(/local scan-specific/);
    expect(() => readImageryPair({ ...result, first: { ...first,
      total_source_pixels: 12 } }, 'ONE', 'TWO')).toThrow(/inconsistent/);
    expect(() => readImageryPair({ ...result, first: { ...first,
      raster_window: [0, 0, 3, 2] } }, 'ONE', 'TWO')).toThrow(/inconsistent/);
    expect(() => readImageryPair({ ...result, first: { ...first,
      wgs84_corners_lon_lat: [[181, 0], [0, 0], [0, 0], [0, 0]] } },
    'ONE', 'TWO')).toThrow(/inconsistent/);
    expect(() => readImageryPair(result, 'OTHER', 'TWO')).toThrow(/identity mismatch/);
    expect(() => readImageryPair({ ...result, status: 'PARTIAL' },
      'ONE', 'TWO')).toThrow(/does not match/);
  });

  it('keeps source/image absent when one recorded acquisition cannot be rendered', () => {
    const unavailable = {
      ...first, status: 'UNAVAILABLE', reason: 'CALIBRATED_CACHE_MISSING_OR_CORRUPT',
      source: null, image_url: null,
    };
    expect(readImageryPair({ ...result, first: unavailable, status: 'PARTIAL' },
      'ONE', 'TWO').first.status).toBe('UNAVAILABLE');
    expect(() => readImageryPair({ ...result, first: { ...unavailable,
      image_url: 'https://bad/image' }, status: 'PARTIAL' }, 'ONE', 'TWO'))
      .toThrow(/no source assertion or image URL/);
  });

  it('uses only locally persisted scan catalogue and selected scan IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(candidateList))
      .mockResolvedValueOnce(response(result));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listImageryCandidates()).length).toBe(2);
    expect((await loadImageryPair('ONE', 'TWO')).status).toBe('READY');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/sar/imagery/scans', '/api/sar/imagery/pair',
    ]);
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      first_scan_id: 'ONE', second_scan_id: 'TWO',
    });
    await expect(loadImageryPair('ONE', '../TWO')).rejects.toThrow(/different persisted REAL/);
  });

  it('renders explicit scientific limits and disabled controls until verified image exists', () => {
    const markup = renderToStaticMarkup(<SceneImageryWorkspace />);
    expect(markup).toContain('data-df-scene-imagery-workspace');
    expect(markup).toContain('data-df-imagery-load');
    expect(markup).toContain('independently controlled pan and zoom');
    expect(markup).toContain('not');
    expect(markup).not.toContain('data-df-imagery-provenance');
  });
});
