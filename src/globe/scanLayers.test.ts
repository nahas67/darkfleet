/**
 * Globe drawing decisions for real scan results.
 *
 * These tests guard the refusals, not the geometry. A layer that drew a mark at
 * (0, 0) for a target with no position, or drew a tight uncertainty circle for
 * a detection whose uncertainty was never measured, would look correct and be
 * worse than drawing nothing.
 *
 * The Cesium adapter itself is not exercised here: it needs a WebGL context. What
 * is asserted is that the decisions handed to it are the right ones.
 */

import { describe, expect, it } from 'vitest';

import {
  aisMarks,
  confidenceAlpha,
  detectionMarks,
  footprint,
  linkMarks,
} from './scanLayers.ts';
import type { ScanResult, VesselTarget } from '../types/api.ts';

function target(over: Partial<VesselTarget> = {}): VesselTarget {
  return {
    id: 'DF-001',
    classification: 'SAR_UNMATCHED',
    lat: 1.267269,
    lon: 103.85533,
    sarConf: 0.72,
    aisConf: 0,
    lenM: 18.4,
    widM: 4.1,
    lenUncM: 6.2,
    hdg: 118,
    wake: false,
    meanDb: -8.4,
    maxDb: -1.2,
    area: 12,
    corr: {
      matched: false,
      mmsi: null,
      vesselName: null,
      distanceOffsetMeters: null,
      timeDeltaSeconds: null,
      predictedLat: null,
      predictedLon: null,
      aisAssociationConfidence: 0,
      scoreDecomposition: null,
    },
    assessment: null,
    tags: [],
    ...over,
  };
}

function result(over: Partial<ScanResult> = {}): ScanResult {
  return {
    scan_id: 'DF-0001',
    runtime_mode: 'REAL',
    synthetic: false,
    scene: {} as ScanResult['scene'],
    aoi: [103.8, 1.24, 103.86, 1.28],
    acquisition_time: '2026-09-27T11:24:58.180786Z',
    config: {},
    targets: [],
    ais_only: [],
    counts: {},
    provenance: {} as ScanResult['provenance'],
    processing_time_ms: 1234,
    created_at: '2026-10-02T00:00:00Z',
    ...over,
  };
}

const MATCHED_CORR = {
  matched: true,
  mmsi: '565123456',
  vesselName: 'STRAIT VOYAGER',
  distanceOffsetMeters: 14.2,
  timeDeltaSeconds: 3.1,
  predictedLat: 1.267511,
  predictedLon: 103.855401,
  aisAssociationConfidence: 0.88,
  scoreDecomposition: null,
};

// ---------------------------------------------------------- detection marks

describe('detectionMarks', () => {
  it('returns one mark per real target, in backend order', () => {
    const marks = detectionMarks([
      target({ id: 'DF-001' }),
      target({ id: 'DF-002', lat: 1.3, lon: 103.9 }),
    ]);
    expect(marks.map((m) => m.targetId)).toEqual(['DF-001', 'DF-002']);
    expect(marks[0].lat).toBeCloseTo(1.267269, 6);
    expect(marks[0].lon).toBeCloseTo(103.85533, 6);
  });

  it('skips a target with no position rather than placing it at the origin', () => {
    // (0, 0) is in the Gulf of Guinea. A mark drawn there reads as a detection.
    const marks = detectionMarks([
      target({ id: 'NULL_LAT', lat: null as unknown as number }),
      target({ id: 'NAN', lat: Number.NaN }),
      target({ id: 'ZERO', lat: 0, lon: 0 }),
      target({ id: 'REAL', lat: 1.5, lon: 103.8 }),
    ]);
    expect(marks.map((m) => m.targetId)).toEqual(['REAL']);
  });

  it('rejects an out-of-range position as corrupt', () => {
    const marks = detectionMarks([
      target({ id: 'BAD_LAT', lat: 120 }),
      target({ id: 'BAD_LON', lon: -400 }),
    ]);
    expect(marks).toHaveLength(0);
  });

  it('carries the measured uncertainty radius', () => {
    const [mark] = detectionMarks([target({ lenUncM: 6.2 })]);
    expect(mark.uncertaintyRadiusM).toBeCloseTo(6.2, 6);
  });

  it('reports absent uncertainty as null, never as zero', () => {
    // A zero radius would render as a confident point-sized circle.
    const zero = detectionMarks([target({ lenUncM: 0 })]);
    const negative = detectionMarks([target({ lenUncM: -5 })]);
    const missing = detectionMarks([target({ lenUncM: null as unknown as number })]);
    for (const marks of [zero, negative, missing]) {
      expect(marks).toHaveLength(1);
      expect(marks[0].uncertaintyRadiusM).toBeNull();
    }
  });

  it('defaults a non-numeric confidence to zero, not NaN', () => {
    const [mark] = detectionMarks([
      target({ sarConf: Number.NaN, aisConf: undefined as unknown as number }),
    ]);
    expect(mark.sarConfidence).toBe(0);
    expect(mark.aisConfidence).toBe(0);
  });

  it('does not relabel a classification', () => {
    const marks = detectionMarks([target({ classification: 'SEA_CLUTTER' })]);
    expect(marks[0].classification).toBe('SEA_CLUTTER');
  });

  it('survives an empty or malformed target list', () => {
    expect(detectionMarks([])).toEqual([]);
    expect(detectionMarks([null as unknown as VesselTarget, target()])).toHaveLength(1);
  });
});

// --------------------------------------------------------------- ais marks

describe('aisMarks', () => {
  it('reports an associated vessel as matched', () => {
    const marks = aisMarks(
      result({ targets: [target({ corr: MATCHED_CORR, aisConf: 0.88 })] }),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      mmsi: '565123456',
      name: 'STRAIT VOYAGER',
      matched: true,
    });
    expect(marks[0].lat).toBeCloseTo(1.267511, 6);
  });

  it('reports an AIS-only contact as unmatched, at its own position', () => {
    const marks = aisMarks(
      result({
        ais_only: [
          {
            cls: 'AIS_ONLY',
            mmsi: '999888777',
            vesselName: null,
            lat: 1.25,
            lon: 103.83,
            timestamp: '2026-09-27T11:20:00Z',
          },
        ],
      }),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].matched).toBe(false);
    expect(marks[0].name).toBeNull();
  });

  it('does not draw an association the backend did not make', () => {
    const marks = aisMarks(
      result({
        targets: [
          target({
            corr: { ...MATCHED_CORR, matched: false, mmsi: '111222333' },
          }),
        ],
      }),
    );
    expect(marks).toHaveLength(0);
  });

  it('skips an association with no placeable position', () => {
    // matched=true but the vessel could not be placed. Real finding, but there
    // is no coordinate to draw, so no mark is invented for it.
    const marks = aisMarks(
      result({
        targets: [
          target({
            corr: { ...MATCHED_CORR, predictedLat: null, predictedLon: null },
          }),
        ],
      }),
    );
    expect(marks).toHaveLength(0);
  });

  it('draws one mark per MMSI even if it appears twice', () => {
    const marks = aisMarks(
      result({
        targets: [target({ corr: MATCHED_CORR })],
        ais_only: [
          {
            cls: 'AIS_ONLY',
            mmsi: '565123456',
            vesselName: 'STRAIT VOYAGER',
            lat: 1.267511,
            lon: 103.855401,
            timestamp: '2026-09-27T11:20:00Z',
          },
        ],
      }),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].matched).toBe(true);
  });
});

// --------------------------------------------------------------- link marks

describe('linkMarks', () => {
  it('links a detection to its associated AIS position', () => {
    const links = linkMarks([target({ corr: MATCHED_CORR })]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ targetId: 'DF-001', mmsi: '565123456' });
    expect(links[0].fromLat).toBeCloseTo(1.267269, 6);
    expect(links[0].toLat).toBeCloseTo(1.267511, 6);
    expect(links[0].confidence).toBeCloseTo(0.88, 6);
  });

  it('draws no link for an unmatched detection', () => {
    expect(linkMarks([target()])).toHaveLength(0);
  });

  it('draws no link when either end is missing', () => {
    expect(
      linkMarks([target({ corr: { ...MATCHED_CORR, predictedLon: null } })]),
    ).toHaveLength(0);
    expect(
      linkMarks([target({ corr: MATCHED_CORR, lat: Number.NaN })]),
    ).toHaveLength(0);
  });

  it('never substitutes a position for a missing endpoint', () => {
    // The specific failure this guards: a line drawn from the detection to (0, 0)
    // or to the AOI centre, which would read as a real measured offset.
    const links = linkMarks([
      target({ corr: { ...MATCHED_CORR, predictedLat: null, predictedLon: null } }),
    ]);
    for (const link of links) {
      expect(link.toLat).not.toBe(0);
      expect(link.toLon).not.toBe(0);
    }
    expect(links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- footprint

describe('footprint', () => {
  it('returns the scan AOI when it is a usable bbox', () => {
    expect(footprint(result())).toEqual([103.8, 1.24, 103.86, 1.28]);
  });

  it('returns null rather than guessing an extent', () => {
    expect(footprint(result({ aoi: [] }))).toBeNull();
    expect(footprint(result({ aoi: [1, 2, 3] }))).toBeNull();
    expect(footprint(result({ aoi: [1, 2, Number.NaN, 4] }))).toBeNull();
    expect(footprint(result({ aoi: undefined as unknown as number[] }))).toBeNull();
  });

  it('rejects an inverted bbox', () => {
    expect(footprint(result({ aoi: [103.86, 1.28, 103.8, 1.24] }))).toBeNull();
  });
});

// ------------------------------------------------------------------ styling

describe('confidenceAlpha', () => {
  it('maps 0..1 onto a visible range, so low confidence is faint not hidden', () => {
    expect(confidenceAlpha(0)).toBeCloseTo(0.25, 6);
    expect(confidenceAlpha(1)).toBeCloseTo(1, 6);
    expect(confidenceAlpha(0.5)).toBeCloseTo(0.625, 6);
  });

  it('clamps and defaults rather than producing NaN alpha', () => {
    expect(confidenceAlpha(-4)).toBeCloseTo(0.25, 6);
    expect(confidenceAlpha(9)).toBeCloseTo(1, 6);
    expect(confidenceAlpha(Number.NaN)).toBeCloseTo(0.25, 6);
  });
});