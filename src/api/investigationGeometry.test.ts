import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeoAnnotation, deleteGeoAnnotation, listGeoAnnotations, parseLonLatLines,
  readGeoAnnotation, updateGeoAnnotation, type GeoAnnotation,
} from './investigationGeometry';

const saved: GeoAnnotation = {
  id: 'geo-1',
  investigation_id: 'case-1',
  scan_id: 'REAL-001',
  provenance: 'OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE',
  label: 'Transit crossing',
  notes: 'Only operator coordinates',
  geometry: { kind: 'polyline', coordinates: [[179.5, 0], [-179.5, 0]], radius_m: null },
  measurements: {
    ellipsoid: 'WGS84', method: 'WGS84 ellipsoidal inverse geodesic segments',
    length_m: 111319.49, length_km: 111.31949, length_nm: 60.10772,
    initial_bearing_deg: 90,
    perimeter_m: null, perimeter_km: null, perimeter_nm: null,
    area_m2: null, area_km2: null, radius_m: null, radius_km: null, radius_nm: null,
  },
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
};
const reply = (payload: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('operator geometry API client', () => {
  it('handles server-backed list, create, replace and delete with correct request identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ geometries: [saved] }))
      .mockResolvedValueOnce(reply(saved, 201))
      .mockResolvedValueOnce(reply({ ...saved, label: 'Updated boundary' }))
      .mockResolvedValueOnce(reply(null, 204));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listGeoAnnotations('case-1')).toEqual([saved]);
    const draft = {
      label: 'Transit crossing', notes: 'Only operator coordinates',
      geometry: saved.geometry,
    };
    expect((await createGeoAnnotation('case-1', draft)).id).toBe('geo-1');
    expect((await updateGeoAnnotation('case-1', 'geo-1', draft)).label).toBe('Updated boundary');
    await deleteGeoAnnotation('case-1', 'geo-1');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/investigations/case-1/geometries',
      '/api/investigations/case-1/geometries',
      '/api/investigations/case-1/geometries/geo-1',
      '/api/investigations/case-1/geometries/geo-1',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual([
      'GET', 'POST', 'PUT', 'DELETE',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(draft);
  });

  it('rejects missing collection instead of treating it as no geometry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ geom: [] })));
    await expect(listGeoAnnotations('case-1')).rejects.toThrow(/missing required key.*geometries/);
  });

  it('rejects invented measured values, invalid geographic coordinates and missing operator provenance', () => {
    expect(() => readGeoAnnotation({
      ...saved, provenance: 'SAR_OBSERVED',
    })).toThrow(/provenance/);
    expect(() => readGeoAnnotation({
      ...saved, measurements: { ...saved.measurements, ellipsoid: 'SCREEN_PIXELS' },
    })).toThrow(/WGS84/);
    expect(() => readGeoAnnotation({
      ...saved, geometry: { ...saved.geometry, coordinates: [[1000, 0]] },
    })).toThrow(/WGS84 lon\/lat/);
    expect(() => readGeoAnnotation({
      ...saved, measurements: { ...saved.measurements, length_m: 'approx' },
    })).toThrow(/finite number/);
  });
});

describe('WGS84 form coordinate state validation', () => {
  it('parses longitude-first signed degrees and antimeridian vertices', () => {
    expect(parseLonLatLines('179.5, 0\n-179.5, -0.25')).toEqual([
      [179.5, 0], [-179.5, -0.25],
    ]);
    expect(parseLonLatLines('  103.801 1.28 ;\n'.replace(';', ''))).toEqual([[103.801, 1.28]]);
  });

  it('refuses screen pixel/unprojected, nonexistent and nonfinite positions locally', () => {
    for (const value of [
      '', '1920,1080', '-181,0', '0,91', 'NaN,0', 'foo,1', '0,1,4', 'Infinity,3',
    ]) expect(() => parseLonLatLines(value)).toThrow();
  });
});
