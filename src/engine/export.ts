/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Geospatial Export Module
 * Generates GeoJSON FeatureCollection, KML, and DarkFleet-Core Analytical JSON format
 * with explicit data provenance and canonical classifications.
 */

import { ScanResult } from '../types/darkfleet.ts';

export function generateGeoJSON(scan: ScanResult): object {
  const features: any[] = [];

  // 1. Detection Point Features
  scan.vessels.forEach((v) => {
    features.push({
      type: 'Feature',
      id: v.id,
      geometry: {
        type: 'Point',
        coordinates: [v.position.lon, v.position.lat],
      },
      properties: {
        targetId: v.id,
        classification: v.classification,
        sarConfidence: v.sarConfidence,
        aisMatchConfidence: v.aisMatchConfidence,
        apparentLengthMeters: v.estimatedLengthMeters,
        apparentWidthMeters: v.apparentWidthMeters,
        lengthUncertaintyMeters: v.lengthUncertaintyMeters,
        orientationDegrees: v.estimatedHeadingDeg,
        wakeVisible: v.wakeVisible,
        wakeHeadingDeg: v.wakeHeadingDeg ?? null,
        maxBackscatterDb: v.maxBackscatterDb,
        meanBackscatterDb: v.meanBackscatterDb,
        pixelArea: v.pixelArea,
        aisMatched: v.aisCorrelation.matched,
        mmsi: v.aisCorrelation.mmsi,
        vesselName: v.aisCorrelation.vesselName,
        flag: v.aisCorrelation.flag,
        shipType: v.aisCorrelation.shipType,
        distanceOffsetMeters: v.aisCorrelation.distanceOffsetMeters,
        timeDeltaSeconds: v.aisCorrelation.timeDeltaSeconds,
        scoreDecomposition: v.aisCorrelation.scoreDecomposition ?? null,
        observation: v.tacticalAssessment,
        box2d: v.box2d,
        proximityPartnerId: v.proximityPartnerId ?? null,
        synthetic: scan.provenance.synthetic,
      },
    });

    // 2. Correlation Tether Line (if AIS matched and predicted position exists)
    if (v.aisCorrelation.matched && v.aisCorrelation.predictedLat && v.aisCorrelation.predictedLon) {
      features.push({
        type: 'Feature',
        id: `${v.id}-ais-link`,
        geometry: {
          type: 'LineString',
          coordinates: [
            [v.position.lon, v.position.lat],
            [v.aisCorrelation.predictedLon, v.aisCorrelation.predictedLat],
          ],
        },
        properties: {
          type: 'correlation_vector',
          targetId: v.id,
          distanceMeters: v.aisCorrelation.distanceOffsetMeters,
          timeDeltaSeconds: v.aisCorrelation.timeDeltaSeconds,
          mmsi: v.aisCorrelation.mmsi,
        },
      });
    }
  });

  // 3. Scan Bounding Box polygon
  const [minLon, minLat, maxLon, maxLat] = scan.aoi;
  features.push({
    type: 'Feature',
    id: `aoi-${scan.scanId}`,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ]],
    },
    properties: {
      type: 'aoi_footprint',
      scanId: scan.scanId,
      sceneId: scan.scene.id,
      platform: scan.scene.platform,
      polarization: scan.scene.polarization,
      acquisitionTime: scan.scene.acquisitionTime,
      runtimeMode: scan.runtimeMode,
      synthetic: scan.provenance.synthetic,
    },
  });

  return {
    type: 'FeatureCollection',
    metadata: {
      scanId: scan.scanId,
      runtimeMode: scan.runtimeMode,
      synthetic: scan.provenance.synthetic,
      provenance: scan.provenance,
      sceneId: scan.scene.id,
      timestamp: scan.timestamp,
      detectionsCount: scan.detectionsCount,
      unmatchedCount: scan.unmatchedCount,
      matchedCount: scan.matchedCount,
      staticCount: scan.staticCount,
      aisOnlyCount: scan.aisOnlyCount,
      generatedAt: new Date().toISOString(),
      software: 'DarkFleet-Core v3.0.0 (Spatial Intelligence)',
    },
    features,
  };
}

export function generateKML(scan: ScanResult): string {
  const placemarks = scan.vessels
    .map((v) => {
      let color = 'ffffc76b'; // Amber default
      if (v.classification === 'SAR_MATCHED_AIS') {
        color = 'ff5cffc6'; // Emerald/cyan
      } else if (v.classification === 'SAR_UNMATCHED') {
        color = 'ff6b6bff'; // Coral/red
      } else if (v.classification === 'STATIONARY_OR_INFRASTRUCTURE') {
        color = 'fff8bd38'; // Sky blue
      }

      return `
    <Placemark>
      <name>${v.id}: ${v.classification}</name>
      <description><![CDATA[
        <b>Classification:</b> ${v.classification}<br/>
        <b>Apparent Length:</b> ${v.estimatedLengthMeters}m &plusmn;${v.lengthUncertaintyMeters}m<br/>
        <b>Orientation:</b> ${v.estimatedHeadingDeg}&deg;<br/>
        <b>Peak Backscatter:</b> ${v.maxBackscatterDb} dB<br/>
        <b>AIS MMSI:</b> ${v.aisCorrelation.mmsi || 'UNASSOCIATED'}<br/>
        <b>Observation:</b> ${v.tacticalAssessment}<br/>
        <b>Provenance:</b> ${scan.provenance.synthetic ? 'SYNTHETIC / DEMO' : 'OBSERVED SATELLITE / REAL'}
      ]]></description>
      <Style>
        <IconStyle>
          <color>${color}</color>
          <scale>1.1</scale>
          <Icon>
            <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
          </Icon>
        </IconStyle>
      </Style>
      <Point>
        <coordinates>${v.position.lon},${v.position.lat},0</coordinates>
      </Point>
    </Placemark>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>DarkFleet Scan - ${scan.scanId} [${scan.runtimeMode}]</name>
    <description>Sentinel-1 SAR + AIS Vessel Correlation Dataset (Mode: ${scan.runtimeMode}, Synthetic: ${scan.provenance.synthetic})</description>
    ${placemarks}
  </Document>
</kml>`;
}

export function formatAnalyticalProtocolJSON(scan: ScanResult): object {
  return {
    scan_id: scan.scanId,
    runtime_mode: scan.runtimeMode,
    synthetic: scan.provenance.synthetic,
    provenance: scan.provenance,
    detections_count: scan.detectionsCount,
    unmatched_count: scan.unmatchedCount,
    matched_count: scan.matchedCount,
    static_count: scan.staticCount,
    ais_only_count: scan.aisOnlyCount,
    data_source: scan.dataSource,
    vessels: scan.vessels.map((v) => ({
      id: v.id,
      box_2d: v.box2d,
      classification: v.classification,
      confidence: v.confidence,
      sar_confidence: v.sarConfidence,
      ais_match_confidence: v.aisMatchConfidence,
      estimated_length_meters: v.estimatedLengthMeters,
      apparent_width_meters: v.apparentWidthMeters,
      length_uncertainty_meters: v.lengthUncertaintyMeters,
      estimated_heading_deg: v.estimatedHeadingDeg,
      wake_visible: v.wakeVisible,
      wake_heading_deg: v.wakeHeadingDeg ?? null,
      max_backscatter_db: v.maxBackscatterDb,
      mean_backscatter_db: v.meanBackscatterDb,
      ais_correlation: {
        matched: v.aisCorrelation.matched,
        mmsi: v.aisCorrelation.mmsi,
        vessel_name: v.aisCorrelation.vesselName,
        flag: v.aisCorrelation.flag,
        ship_type: v.aisCorrelation.shipType,
        distance_offset_meters: v.aisCorrelation.distanceOffsetMeters,
        time_delta_seconds: v.aisCorrelation.timeDeltaSeconds,
        score_decomposition: v.aisCorrelation.scoreDecomposition ?? null,
      },
      assessment: v.tacticalAssessment,
      tags: v.tags,
    })),
    area_summary: scan.areaSummary,
  };
}
