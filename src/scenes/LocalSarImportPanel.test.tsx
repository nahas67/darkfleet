import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LocalSarImportDetail, LocalSarImportPanel, explainLocalSarError,
  getLocalSarImport, getLocalSarStatus, listLocalSarImports, localSarPreviewUrl,
  prepareLocalSarRequest, readLocalSarImport, readLocalSarStatus, submitLocalSarImport,
  validateLocalSarPath,
} from './LocalSarImportPanel';
import { ApiError } from '../api/errors';

const id = 'a'.repeat(32);
const sha = 'b'.repeat(64);
const status = {
  status: 'READY', enabled: true, inbox_name: 'local-sar-inbox',
  max_file_bytes: 67108864, max_pixels: 8000000,
  scope: 'LOOPBACK_ONLY', analysis: 'IMPORT_ONLY',
};
const imported = {
  import_id: id, status: 'IMPORTED_NOT_ANALYZED', sha256: sha,
  source: { relative_path: 'real-scene.tif', sha256: sha, origin: 'OPERATOR_LOCAL_INBOX' },
  source_integrity: 'VERIFIED', snapshot_integrity: 'VERIFIED',
  metadata: {
    product: 'GRD', polarization: 'VV', acquisition_time: null,
    calibration: 'RAW_DN', width: 128, height: 64,
    crs: 'EPSG:4326', transform: [0.1, 0, 30, 0, -0.1, 10],
    pixel_center_wgs84_lon_lat: [30.05, 9.95],
    preview_shape: [64, 128], preview_sample_stride: 1,
    valid_pixels: 8192, total_pixels: 8192,
  },
  limitations: [
    'IMPORTED_NOT_ANALYZED: no detection, target, AIS match or completed scan was created.',
    'Calibration and provenance are operator declarations, not independently verified.',
  ],
  image_url: `/api/sar/local/imports/${id}/image`,
};

function json(data: unknown, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code, headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('DF-X10 local-only SAR import console', () => {
  it('exposes server configuration and never presents import as analysis', () => {
    expect(readLocalSarStatus(status)).toEqual({
      available: true, inbox: 'local-sar-inbox', note: null,
      max_file_bytes: 67108864, max_pixels: 8000000,
    });
    const html = renderToStaticMarkup(<LocalSarImportPanel />);
    expect(html).toContain('data-df-local-sar-import-panel');
    expect(html).toContain('data-df-local-sar-path');
    expect(html).toContain('data-df-local-sar-product');
    expect(html).toContain('data-df-local-sar-calibration');
    expect(html).toContain('data-df-local-sar-select');
    expect(html).toContain('IMPORTED_NOT_ANALYZED');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('Scan complete');
  });

  it('treats backend-unavailable states and unauthorized scope as unavailable or invalid', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      ...status, status: 'UNAVAILABLE', enabled: false,
    })).mockResolvedValueOnce(json({ detail: {
      error: 'LOCAL_SAR_IMPORT_ERROR', status: 'DIRECTORY_UNAVAILABLE',
      message: 'DIRECTORY_UNAVAILABLE',
    } }, 503));
    vi.stubGlobal('fetch', fetchMock);
    expect((await getLocalSarStatus()).available).toBe(false);
    await expect(getLocalSarStatus()).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/sar/local/status', '/api/sar/local/status',
    ]);
    expect(explainLocalSarError(new ApiError(503, 'HTTP_503', 'Server responded', {
      detail: { status: 'DIRECTORY_UNAVAILABLE' },
    }))).toContain('DIRECTORY_UNAVAILABLE');
    expect(() => readLocalSarStatus({ ...status, scope: 'REMOTE' })).toThrow(/authority/);
    expect(() => readLocalSarStatus({ ...status, enabled: false })).toThrow(/Contradictory/);
  });

  it('surfaces the safe actual FastAPI refusal status rather than only HTTP 404', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      detail: {
        error: 'LOCAL_SAR_IMPORT_ERROR',
        status: 'SOURCE_NOT_FOUND',
        message: 'internal-path-details-must-not-be-rendered',
      },
    }, 404));
    vi.stubGlobal('fetch', fetchMock);
    let received: unknown;
    try {
      await submitLocalSarImport({ relative_path: 'missing.tif', product: 'RTC' });
    } catch (cause) { received = cause; }
    expect(received).toBeInstanceOf(ApiError);
    expect((received as ApiError).detail).toEqual({
      error: 'LOCAL_SAR_IMPORT_ERROR', status: 'SOURCE_NOT_FOUND',
      message: 'internal-path-details-must-not-be-rendered',
    });
    expect(explainLocalSarError(received)).toBe('Local SAR request refused: SOURCE_NOT_FOUND.');
    expect(explainLocalSarError(received)).not.toContain('internal-path');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts only one safe GeoTIFF basename; validates timezone and calibration before POST', () => {
    expect(validateLocalSarPath('sar_scene_01.TIFF')).toBe('sar_scene_01.TIFF');
    for (const value of [
      '../secret.tif', '..\\secret.tif', 'missions/scene.tif', 'C:\\geo\\scene.tif',
      'https://host/scene.tif', '\\\\server\\share.tiff', '/tmp/scene.tif',
      'scene.png', 'foo..tif', '.hidden.tif', 'bad?.tif',
    ]) {
      expect(() => validateLocalSarPath(value), value).toThrow();
    }
    expect(prepareLocalSarRequest({ relative_path: 'scene.tif', product: 'RTC' })).toEqual({
      relative_path: 'scene.tif', product: 'RTC',
    });
    expect(prepareLocalSarRequest({
      relative_path: 'scene.tif', product: 'GRD', polarization: 'VH',
      acquisition_time: '2026-10-11T00:15:00+05:30', calibration: 'RAW_DN',
    })).toEqual({
      relative_path: 'scene.tif', product: 'GRD', polarization: 'VH',
      acquisition_time: '2026-10-11T00:15:00+05:30', calibration: 'RAW_DN',
    });
    expect(() => prepareLocalSarRequest({ relative_path: 'scene.tif', product: 'RTC', acquisition_time: '2026-10-11T00:15:00' })).toThrow(/timezone/);
    expect(() => prepareLocalSarRequest({ relative_path: 'scene.tif', product: 'RTC', calibration: '{"gamma":"fake"}' })).toThrow(/calibration/);
    expect(() => prepareLocalSarRequest({ relative_path: 'scene.tif', product: 'RAW' })).toThrow(/RTC or GRD/);
  });

  it('POST registers source without requesting analysis, then validates its receipt and detail', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(imported, 201))
      .mockResolvedValueOnce(json(imported));
    vi.stubGlobal('fetch', fetchMock);
    const result = await submitLocalSarImport({
      relative_path: 'real-scene.tif', product: 'GRD', polarization: 'VV',
      calibration: 'RAW_DN', acquisition_time: '2026-10-10T12:00:00Z',
    });
    expect(result.status).toBe('IMPORTED_NOT_ANALYZED');
    expect(result.product).toBe('GRD');
    expect(result.sha256).toBe(sha);
    expect((await getLocalSarImport(id)).import_id).toBe(id);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sar/local/import');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      relative_path: 'real-scene.tif', product: 'GRD', polarization: 'VV',
      calibration: 'RAW_DN', acquisition_time: '2026-10-10T12:00:00Z',
    });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/sar/local/imports/${id}`);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('/api/scans');
  });

  it('rejects unsafe input without making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitLocalSarImport({ relative_path: '../private.tif', product: 'RTC' })).rejects.toThrow(/basename/);
    await expect(getLocalSarImport('../../bad')).rejects.toThrow(/identifier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reloads saved imports independently after a restart and checks detail identity', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      status: 'READY', total: 1, imports: [imported],
    })).mockResolvedValueOnce(json({ ...imported, import_id: 'f'.repeat(32),
      image_url: `/api/sar/local/imports/${'f'.repeat(32)}/image`,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const records = await listLocalSarImports();
    expect(records).toHaveLength(1);
    expect(records[0].relative_path).toBe('real-scene.tif');
    expect(records[0].snapshot_integrity).toBe('VERIFIED');
    await expect(getLocalSarImport(id)).rejects.toThrow(/another import/);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sar/local/imports');
  });

  it('rejects invented completion, inconsistent checksums and nonlocal preview URLs', () => {
    expect(() => readLocalSarImport({ ...imported, status: 'COMPLETE' })).toThrow(/completed analysis/);
    expect(() => readLocalSarImport({ ...imported, sha256: 'f'.repeat(64) })).toThrow(/consistent SHA/);
    expect(() => readLocalSarImport({ ...imported, image_url: 'https://evil.example/preview.png' })).toThrow(/same-origin/);
    expect(() => readLocalSarImport({ ...imported, metadata: { ...imported.metadata, pixel_center_wgs84_lon_lat: [200, 90] } })).toThrow(/geolocated/);
    expect(() => readLocalSarImport({ ...imported, source_integrity: 'FABRICATED' })).toThrow(/integrity/);
    expect(localSarPreviewUrl(id)).toBe(`/api/sar/local/imports/${id}/image`);
    expect(() => localSarPreviewUrl('../secret')).toThrow(/identifier/);
  });

  it('renders a verified snapshot despite original source drift, but suppresses a damaged snapshot', () => {
    const changed = readLocalSarImport({ ...imported, source_integrity: 'CHANGED' });
    const snapshotHtml = renderToStaticMarkup(<LocalSarImportDetail entry={changed} />);
    expect(snapshotHtml).toContain('SOURCE CHANGED');
    expect(snapshotHtml).toContain('data-df-local-sar-preview');
    expect(snapshotHtml).toContain(localSarPreviewUrl(id));
    expect(snapshotHtml).toContain('IMPORTED_NOT_ANALYZED');
    expect(snapshotHtml).toContain('Documented limitations');

    const unusable = readLocalSarImport({
      ...imported, source_integrity: 'MISSING', snapshot_integrity: 'CHANGED',
      metadata: { ...imported.metadata, crs: null, pixel_center_wgs84_lon_lat: null },
    });
    const unavailableHtml = renderToStaticMarkup(<LocalSarImportDetail entry={unusable} />);
    expect(unavailableHtml).toContain('SOURCE MISSING');
    expect(unavailableHtml).toContain('SNAPSHOT CHANGED');
    expect(unavailableHtml).toContain('MISSING — geolocation unavailable');
    expect(unavailableHtml).not.toContain('data-df-local-sar-preview');
  });
});
