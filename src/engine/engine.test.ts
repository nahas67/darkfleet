/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { geodesicDistance, dynamicMatchRadius, propagateDeadReckoning } from './geodesy.ts';
import { formatAnalyticalProtocolJSON, generateGeoJSON, generateKML } from './export.ts';
import { ScanResult } from '../types/darkfleet.ts';
import { SENTINEL1_SCENES_CATALOG } from '../data/scenes.ts';

describe('Geodesy & Kinematics', () => {
  it('computes accurate geodesic distance between two points', () => {
    // Singapore strait test coordinates (~1.1 km apart)
    const d = geodesicDistance(1.20, 103.80, 1.21, 103.80);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1200);
  });

  it('calculates adaptive dynamic match radius based on speed and time delta', () => {
    const r1 = dynamicMatchRadius(250, 60, 15, 2000);
    expect(r1).toBeGreaterThan(250);
    expect(r1).toBeLessThanOrEqual(2000);

    const rStationary = dynamicMatchRadius(250, 0, 0);
    expect(rStationary).toBe(250);
  });

  it('projects dead-reckoning position along heading vector', () => {
    const start = { lat: 1.20, lon: 103.80 };
    const projected = propagateDeadReckoning(start.lat, start.lon, 20, 90, 60); // Eastbound
    expect(projected.lon).toBeGreaterThan(start.lon);
  });
});

describe('Export Formats & Provenance', () => {
  const mockScan: ScanResult = {
    scanId: 'SCAN-TEST-001',
    runtimeMode: 'DEMO',
    scene: SENTINEL1_SCENES_CATALOG[0],
    aoi: [103.65, 1.10, 104.05, 1.40],
    timestamp: '2026-10-01T10:05:00Z',
    cfarConfig: {
      trainingCells: 16,
      guardCells: 4,
      thresholdFactor: 3.5,
      coastlineBufferMeters: 150,
      speckleFilter: 'median',
      kernelSize: 3,
      minPixels: 3,
      maxPixels: 1000,
    },
    detectionsCount: 1,
    unmatchedCount: 1,
    matchedCount: 0,
    staticCount: 0,
    aisOnlyCount: 0,
    scanConfidence: 0.94,
    vessels: [
      {
        id: 'DF-001',
        scanId: 'SCAN-TEST-001',
        position: { lat: 1.25, lon: 103.85 },
        pixelCentroid: { x: 50, y: 50 },
        box2d: [300, 400, 350, 450],
        classification: 'SAR_UNMATCHED',
        confidence: 0.91,
        sarConfidence: 0.95,
        aisMatchConfidence: 0.0,
        estimatedLengthMeters: 280,
        apparentWidthMeters: 45,
        lengthUncertaintyMeters: 15,
        estimatedHeadingDeg: 120,
        wakeVisible: true,
        meanBackscatterDb: -8.5,
        maxBackscatterDb: 2.1,
        pixelArea: 84,
        aisCorrelation: {
          matched: false,
          mmsi: null,
          vesselName: null,
          flag: null,
          shipType: null,
          distanceOffsetMeters: null,
          timeDeltaSeconds: null,
          sogKnots: null,
          cogDeg: null,
          navStatus: null,
          callsign: null,
          imo: null,
          predictedLat: null,
          predictedLon: null,
          reportedLengthMeters: null,
        },
        tacticalAssessment: 'Unmatched surface radar return (~280m).',
        tags: ['SAR_UNMATCHED', 'UNDERWAY'],
      },
    ],
    aisObservations: [],
    areaSummary: 'Test sector summary.',
    processingTimeMs: 120,
    dataSource: {
      mode: 'DEMO',
      sarSource: 'Synthetic C-Band GRD (Simulation)',
      aisSource: 'Kinematic AIS Archive (Simulation)',
      satellitePlatform: 'Sentinel-1C',
      sensorMode: 'IW',
      polarization: 'VV+VH',
      isSynthetic: true,
    },
    provenance: {
      runtimeMode: 'DEMO',
      sarSource: 'Synthetic Sentinel-1',
      sarSceneId: 'SIM-S1C-MALACCA-001',
      aisSource: 'S-AIS Regional Archive',
      acquisitionTimestamp: '2026-10-01T10:00:00Z',
      processingTimestamp: '2026-10-01T10:05:00Z',
      processingVersion: 'DarkFleet-Core 3.0.0',
      classificationSchemaVersion: 'DarkFleet-Neutral-v1',
      synthetic: true,
      cfarConfig: {
        trainingCells: 16,
        guardCells: 4,
        thresholdFactor: 3.5,
        coastlineBufferMeters: 150,
        speckleFilter: 'median',
        kernelSize: 3,
        minPixels: 3,
        maxPixels: 1000,
      },
    },
  };

  it('generates valid GeoJSON FeatureCollection with provenance', () => {
    const geojson: any = generateGeoJSON(mockScan);
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.metadata.runtimeMode).toBe('DEMO');
    expect(geojson.metadata.unmatchedCount).toBe(1);
    expect(geojson.features.length).toBeGreaterThan(0);
  });

  it('generates standard KML document', () => {
    const kml = generateKML(mockScan);
    expect(kml).toContain('<kml');
    expect(kml).toContain('SCAN-TEST-001');
    expect(kml).toContain('SAR_UNMATCHED');
  });

  it('formats analytical protocol JSON adhering to domain schema', () => {
    const proto: any = formatAnalyticalProtocolJSON(mockScan);
    expect(proto.scan_id).toBe('SCAN-TEST-001');
    expect(proto.runtime_mode).toBe('DEMO');
    expect(proto.vessels[0].classification).toBe('SAR_UNMATCHED');
  });
});
