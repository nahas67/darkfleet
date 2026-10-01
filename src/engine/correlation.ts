/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spatio-Temporal Correlation Engine
 * Correlates SAR Radar Detections with AIS Transponder Telemetry.
 * Produces objective, explainable states:
 * - MATCHED_AIS: Radar target correlates with valid AIS transponder
 * - UNMATCHED_SAR: Radar target has no confident AIS association
 * - STATIC_RETURN: Fixed infrastructure (oil rig, buoy, wind turbine)
 * - AIS_ONLY: Transponder broadcasting without detected radar signature
 */

import {
  AISObservation,
  BoundingBox,
  Sentinel1Scene,
  TargetClassification,
  VesselTarget,
} from '../types/darkfleet.ts';
import { ExtractedComponent } from './cfar.ts';
import {
  dynamicMatchRadius,
  geodesicDistance,
  orientationAngularDifference,
  propagateDeadReckoning,
} from './geodesy.ts';

const METERS_PER_NAUTICAL_MILE = 1852;

/**
 * Maps pixel coordinates (x, y) on the SAR grid to WGS-84 (lat, lon)
 */
export function pixelToGeo(
  x: number,
  y: number,
  width: number,
  height: number,
  bbox: BoundingBox
): { lat: number; lon: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lon = minLon + (x / width) * (maxLon - minLon);
  const lat = maxLat - (y / height) * (maxLat - minLat); // y=0 is north
  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
  };
}

/**
 * Maps geographic coordinates (lat, lon) to normalized 0-1000 scale [ymin, xmin, ymax, xmax]
 */
export function computeBox2D(
  comp: ExtractedComponent,
  width: number,
  height: number
): [number, number, number, number] {
  const { minX, minY, maxX, maxY } = comp.boundingBox;
  const pad = 2;

  const xmin = Math.max(0, Math.min(1000, Math.round(((minX - pad) / width) * 1000)));
  const ymin = Math.max(0, Math.min(1000, Math.round(((minY - pad) / height) * 1000)));
  const xmax = Math.max(0, Math.min(1000, Math.round(((maxX + pad) / width) * 1000)));
  const ymax = Math.max(0, Math.min(1000, Math.round(((maxY + pad) / height) * 1000)));

  return [ymin, xmin, ymax, xmax];
}

/**
 * Runs the correlation pipeline matching SAR radar components against AIS observations.
 */
export function correlateDetections(
  components: ExtractedComponent[],
  aisObservations: AISObservation[],
  scene: Sentinel1Scene,
  gridWidth: number,
  gridHeight: number,
  scanId: string
): {
  targets: VesselTarget[];
  aisOnlyCount: number;
} {
  const targets: VesselTarget[] = [];
  const sarAcquisitionDate = new Date(scene.acquisitionTime).getTime();
  const matchedAisMmsis = new Set<string>();

  // 1. Pre-calculate candidate associations between radar components and AIS
  interface CandidateMatch {
    compIdx: number;
    ais: AISObservation;
    score: number;
    distM: number;
    projected: { lat: number; lon: number };
    deltaSec: number;
    spatialScore: number;
    temporalScore: number;
    headingScore: number;
    sizeScore: number;
    matchRadius: number;
  }

  const allCandidates: CandidateMatch[] = [];

  components.forEach((comp, compIdx) => {
    const geo = pixelToGeo(comp.centroidX, comp.centroidY, gridWidth, gridHeight, scene.bbox);
    const apparentLengthM = Math.round(comp.majorAxisPx * scene.resolutionMeters);

    for (const ais of aisObservations) {
      const aisTime = new Date(ais.timestamp).getTime();
      const deltaSec = (sarAcquisitionDate - aisTime) / 1000;

      // Overpass window: +/- 15 minutes (900 seconds)
      if (Math.abs(deltaSec) > 900) continue;

      const projected = propagateDeadReckoning(ais.lat, ais.lon, ais.sog, ais.cog, deltaSec);
      const distM = geodesicDistance(geo.lat, geo.lon, projected.lat, projected.lon);
      const matchRadius = dynamicMatchRadius(1200, deltaSec, ais.sog, 2800);

      if (distM <= matchRadius) {
        const spatialScore = Math.max(0, 1 - distM / matchRadius);
        const temporalScore = Math.max(0, 1 - Math.abs(deltaSec) / 900);

        const effectiveHeading = comp.wakeVisible && comp.wakeHeadingDeg !== undefined
          ? comp.wakeHeadingDeg
          : comp.orientationDeg;
        const headingDiff = orientationAngularDifference(effectiveHeading, ais.cog, comp.wakeVisible);
        const headingScore = Math.max(0, 1 - headingDiff / 90);

        let sizeScore = 0.8;
        if (ais.length > 0) {
          const lengthDelta = Math.abs(apparentLengthM - ais.length);
          sizeScore = Math.max(0, 1 - lengthDelta / Math.max(ais.length, 50));
        }

        const compositeScore =
          0.45 * spatialScore +
          0.25 * temporalScore +
          0.15 * headingScore +
          0.15 * sizeScore;

        if (compositeScore >= 0.40) {
          allCandidates.push({
            compIdx,
            ais,
            score: compositeScore,
            distM,
            projected,
            deltaSec: Math.round(deltaSec),
            spatialScore,
            temporalScore,
            headingScore,
            sizeScore,
            matchRadius,
          });
        }
      }
    }
  });

  // Bipartite greedy 1-to-1 association
  allCandidates.sort((a, b) => b.score - a.score);

  const matchedCompIndices = new Map<number, CandidateMatch>();
  const assignedMmsis = new Set<string>();

  for (const cand of allCandidates) {
    if (!matchedCompIndices.has(cand.compIdx) && !assignedMmsis.has(cand.ais.mmsi)) {
      matchedCompIndices.set(cand.compIdx, cand);
      assignedMmsis.add(cand.ais.mmsi);
      matchedAisMmsis.add(cand.ais.mmsi);
    }
  }

  // 2. Build Target Objects for each component
  components.forEach((comp, idx) => {
    const geo = pixelToGeo(comp.centroidX, comp.centroidY, gridWidth, gridHeight, scene.bbox);
    const box2d = computeBox2D(comp, gridWidth, gridHeight);

    // Apparent footprint estimation
    const apparentLengthM = Math.round(comp.majorAxisPx * scene.resolutionMeters);
    const apparentWidthM = Math.round(comp.minorAxisPx * scene.resolutionMeters);
    const lengthUncertaintyM = Math.max(10, Math.round(apparentLengthM * 0.22));

    // SAR Confidence: based on SNR (peak backscatter over clutter) and pixel cohesion
    const snrDb = comp.maxBackscatterDb - comp.chip.clutterMeanDb;
    let sarConf = Math.min(0.98, Math.max(0.35, 0.45 + (snrDb / 35) * 0.45));
    if (comp.pixelArea < 4) sarConf *= 0.8;
    if (comp.wakeVisible) sarConf = Math.min(0.99, sarConf + 0.08);

    // Fixed offshore platform check: high backscatter, circular aspect ratio, no kinematic wake
    const aspectRatio = comp.majorAxisPx / Math.max(1.0, comp.minorAxisPx);
    const isStationaryCandidate = comp.maxBackscatterDb > 2.0 && aspectRatio < 1.4 && !comp.wakeVisible;

    const match = matchedCompIndices.get(idx);
    const bestAis = match?.ais ?? null;
    const bestMatchScore = match?.score ?? 0;
    const minDistanceM = match?.distM ?? null;
    const bestPredictedCoords = match?.projected ?? null;
    const bestTimeDeltaSec = match?.deltaSec ?? null;

    let classification: TargetClassification;
    let tacticalAssessment = '';
    const tags: string[] = [];

    if (isStationaryCandidate && (!bestAis || (minDistanceM !== null && minDistanceM > 1000))) {
      classification = 'STATIONARY_OR_INFRASTRUCTURE';
      tacticalAssessment = `Stationary radar return at ${geo.lat.toFixed(4)}°N, ${geo.lon.toFixed(4)}°E. High point-backscatter (${comp.maxBackscatterDb} dB) with no wake line; characteristic of fixed offshore infrastructure.`;
      tags.push('STATIC_INFRASTRUCTURE', 'HIGH_RCS');
    } else if (bestAis && bestMatchScore >= 0.40) {
      classification = 'SAR_MATCHED_AIS';
      tacticalAssessment = `Correlated with AIS transponder MMSI ${bestAis.mmsi} (${bestAis.shipName || 'Unregistered'}). Spatial delta ${minDistanceM !== null ? Math.round(minDistanceM) : 0}m at Δt ${bestTimeDeltaSec ?? 0}s.`;
      tags.push('CORRELATED_AIS', bestAis.shipType.toUpperCase().replace(/\s+/g, '_'));
    } else {
      classification = 'SAR_UNMATCHED';
      tags.push('SAR_UNMATCHED', 'AIS_UNASSOCIATED', 'NO_CONFIDENT_AIS_ASSOCIATION');

      if (comp.wakeVisible) {
        tacticalAssessment = `Unmatched surface radar return (~${apparentLengthM}m) with apparent wake heading ${comp.wakeHeadingDeg ?? comp.orientationDeg}°. No matching AIS observation was found in the available correlation window.`;
        tags.push('UNDERWAY', 'WAKE_EVIDENT');
      } else {
        tacticalAssessment = `Unmatched surface radar return (~${apparentLengthM}m) without correlated transponder broadcast in overpass window. Low kinematic displacement.`;
        tags.push('UNASSOCIATED');
      }
    }

    const targetId = `DF-${String(idx + 1).padStart(3, '0')}`;

    targets.push({
      id: targetId,
      scanId,
      position: geo,
      pixelCentroid: { x: Math.round(comp.centroidX), y: Math.round(comp.centroidY) },
      box2d,
      classification,
      confidence: Number(sarConf.toFixed(2)),
      sarConfidence: Number(sarConf.toFixed(2)),
      aisMatchConfidence: bestAis ? Number(bestMatchScore.toFixed(2)) : 0.0,
      estimatedLengthMeters: apparentLengthM,
      apparentWidthMeters: apparentWidthM,
      lengthUncertaintyMeters: lengthUncertaintyM,
      estimatedHeadingDeg: comp.wakeVisible && comp.wakeHeadingDeg !== undefined ? comp.wakeHeadingDeg : comp.orientationDeg,
      wakeVisible: comp.wakeVisible,
      wakeHeadingDeg: comp.wakeHeadingDeg,
      meanBackscatterDb: comp.meanBackscatterDb,
      maxBackscatterDb: comp.maxBackscatterDb,
      pixelArea: comp.pixelArea,
      aisCorrelation: {
        matched: Boolean(bestAis && bestMatchScore >= 0.40),
        mmsi: bestAis?.mmsi ?? null,
        vesselName: bestAis?.shipName ?? null,
        callsign: bestAis?.callsign ?? null,
        imo: bestAis?.imo ?? null,
        flag: bestAis?.flag ?? null,
        shipType: bestAis?.shipType ?? null,
        sogKnots: bestAis?.sog ?? null,
        cogDeg: bestAis?.cog ?? null,
        navStatus: bestAis?.navStatus ?? null,
        distanceOffsetMeters: bestAis && minDistanceM !== null ? Math.round(minDistanceM) : null,
        timeDeltaSeconds: bestTimeDeltaSec,
        predictedLat: bestPredictedCoords?.lat ?? null,
        predictedLon: bestPredictedCoords?.lon ?? null,
        reportedLengthMeters: bestAis?.length ?? null,
        scoreDecomposition: match ? {
          spatialScore: Number(match.spatialScore.toFixed(3)),
          temporalScore: Number(match.temporalScore.toFixed(3)),
          headingScore: Number(match.headingScore.toFixed(3)),
          sizeScore: Number(match.sizeScore.toFixed(3)),
          compositeScore: Number(match.score.toFixed(3)),
          matchRadiusMeters: Math.round(match.matchRadius),
          distanceOffsetMeters: Math.round(match.distM),
          timeDeltaSeconds: match.deltaSec,
        } : null,
      },
      tacticalAssessment,
      tags,
      sarChip: comp.chip,
    });
  });

  // 3. Proximity detection (vessels operating within 1.5 NM of each other)
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const t1 = targets[i];
      const t2 = targets[j];
      const distM = geodesicDistance(t1.position.lat, t1.position.lon, t2.position.lat, t2.position.lon);

      if (distM < 1.5 * METERS_PER_NAUTICAL_MILE) {
        t1.proximityPartnerId = t2.id;
        t2.proximityPartnerId = t1.id;
        t1.tags.push('PROXIMITY_PAIR');
        t2.tags.push('PROXIMITY_PAIR');
      }
    }
  }

  // 4. Count AIS-only targets (transmitting in bbox without matching SAR return)
  let aisOnlyCount = 0;
  for (const ais of aisObservations) {
    if (!matchedAisMmsis.has(ais.mmsi)) {
      aisOnlyCount++;
    }
  }

  return { targets, aisOnlyCount };
}
