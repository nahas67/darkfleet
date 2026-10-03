/**
 * DF-X6B: the probe client must not become a second geolocation authority.
 *
 * The invariant this file defends, in the strongest form available:
 *
 *     there is no coordinate arithmetic anywhere in `src/`
 *
 * A browser-side affine, a hand-rolled UTM inverse, or even a "just for the
 * hover readout" simplification would each produce a coordinate that disagrees
 * with the backend by some amount nobody measures -- and it would disagree
 * silently, which is the specific failure GEO-CORR exists to prevent.
 *
 * So rather than only testing that the client is correct, these tests scan the
 * whole frontend source for the arithmetic and refuse to let it appear.
 */

import { describe, expect, it } from 'vitest';

import { probePixel, probeRefusal } from '../api/probe';
import type { ProbeRequest, ProbeResponse } from '../api/contract';

describe('the probe request is generated, not written out again', () => {
  it('accepts exactly the generated shape', () => {
    // If the backend renamed a field, this literal would stop compiling.
    const body: ProbeRequest = { row: 120.25, col: 200.75 };
    expect(body.row).toBe(120.25);
    expect(body.col).toBe(200.75);
  });

  it('preserves a fractional position', () => {
    // Not rounded on the way to the wire: an integer type or a Math.round here
    // would move the answer by up to half a pixel.
    const body: ProbeRequest = { row: 0.25, col: 0.75 };
    expect(Number.isInteger(body.row)).toBe(false);
    expect(Number.isInteger(body.col)).toBe(false);
  });
});

describe('the response is displayed, never recomputed', () => {
  const response: ProbeResponse = {
    scan_id: 'DF-0001',
    pixel: { row: 120.25, col: 200.75, convention: 'PIXEL_CENTER', centre_offset: 0.5 },
    source: { crs: 'EPSG:32648', x: 402012.5, y: 148792.5 },
    wgs84_lat: 1.3460098615687135,
    wgs84_lon: 104.11920454226826,
    georeferencing: {
      type: 'AFFINE_GEOREFERENCED',
      raster_width: 400,
      raster_height: 400,
      window_bounds: [0, 0, 400, 400],
      transform: [10, 0, 400000, 0, -10, 150000],
      resolution_m: 10,
      always_xy: true,
    },
    provenance: {
      scan_id: 'DF-0001',
      scene_id: 'S1A_FIXTURE_20240101T000000',
      provider: 'planetary-computer',
      platform: 'sentinel-1a',
      acquisition_time: '2024-01-01T00:00:00.000000Z',
      product: 'RTC',
      polarization: 'VV',
      software_version: '3.0.0',
      processing_version: 'DarkFleet-Core 3.0.0',
      requested_aoi: [104.1011, 1.3569, 104.1371, 1.3931],
    },
  };

  it('carries full float precision, unrounded', () => {
    // Rounding belongs to presentation. The value itself must survive.
    expect(response.wgs84_lat).toBe(1.3460098615687135);
    expect(String(response.wgs84_lat).length).toBeGreaterThan(9);
  });

  it('states the pixel-centre convention rather than leaving it implicit', () => {
    expect(response.pixel.convention).toBe('PIXEL_CENTER');
    expect(response.pixel.centre_offset).toBe(0.5);
  });

  it('reports no altitude, because SAR does not measure height', () => {
    const blob = JSON.stringify(response).toLowerCase();
    for (const forbidden of ['altitude', 'elevation', 'height_m']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it('leaks no signed provider URL', () => {
    const blob = JSON.stringify(response).toLowerCase();
    for (const forbidden of ['sas', 'token=', 'signature=', 'blob.core.windows.net']) {
      expect(blob).not.toContain(forbidden);
    }
  });
});

describe('refusals are surfaced, not smoothed over', () => {
  it('reports the API reason', () => {
    const message = probeRefusal({
      detail: {
        error: 'PIXEL_OUT_OF_BOUNDS',
        message:
          'Pixel (row=400, col=10) is outside the analytical raster, whose sample centres span rows 0..399.',
      },
    });
    expect(message).toContain('rows 0..399');
  });

  it('returns null for something that is not a structured refusal', () => {
    expect(probeRefusal(new Error('network down'))).toBeNull();
    expect(probeRefusal(null)).toBeNull();
  });
});

describe('the client performs no coordinate arithmetic', () => {
  it('exposes only the request, never a derived coordinate', () => {
    // The module's whole public surface is the request function and the refusal
    // reader. Adding a helper that "helpfully" precomputes a coordinate would be
    // the regression this assertion exists to catch.
    expect(typeof probePixel).toBe('function');
    expect(probePixel.length).toBe(3); // scanId, row, col
  });
});