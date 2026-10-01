/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Geodesy & Kinematic Propagation Engine
 * Implements high-precision geodesic distance (WGS-84) and dead-reckoning trajectory projection.
 */

const WGS84_A = 6378137.0; // semi-major axis (meters)
const KNOTS_TO_MPS = 0.514444444; // 1 knot in m/s

/**
 * Computes great-circle geodesic distance between two WGS-84 coordinates in meters
 * using the Haversine formula.
 */
export function geodesicDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(radLat1) * Math.cos(radLat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return WGS84_A * c;
}

/**
 * Computes forward azimuth (bearing) from coordinate 1 to coordinate 2 in degrees (0..360)
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x =
    Math.cos(radLat1) * Math.sin(radLat2) -
    Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);

  const initialBearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (initialBearing + 360) % 360;
}

/**
 * Kinematic Dead-Reckoning Propagation:
 * Projects a vessel's position forward or backward in time from AIS timestamp to SAR acquisition timestamp.
 * 
 * @param lat AIS latitude in degrees
 * @param lon AIS longitude in degrees
 * @param sogKnots Speed Over Ground in knots
 * @param cogDeg Course Over Ground in degrees (0..360)
 * @param deltaSeconds Time delta (t_sar - t_ais) in seconds (can be positive or negative)
 */
export function propagateDeadReckoning(
  lat: number,
  lon: number,
  sogKnots: number,
  cogDeg: number,
  deltaSeconds: number
): { lat: number; lon: number; projectedDistanceMeters: number } {
  if (Math.abs(deltaSeconds) < 1 || sogKnots < 0.1) {
    return { lat, lon, projectedDistanceMeters: 0 };
  }

  // Distance in meters (speed * time)
  const speedMps = sogKnots * KNOTS_TO_MPS;
  const distanceMeters = Math.abs(speedMps * deltaSeconds);
  // If moving backward in time (negative delta), heading is flipped 180 degrees
  const effectiveBearing = deltaSeconds >= 0 ? cogDeg : (cogDeg + 180) % 360;

  // Angular distance in radians
  const angularDist = distanceMeters / WGS84_A;
  const radLat = (lat * Math.PI) / 180;
  const radLon = (lon * Math.PI) / 180;
  const radBearing = (effectiveBearing * Math.PI) / 180;

  const projectedRadLat = Math.asin(
    Math.sin(radLat) * Math.cos(angularDist) +
      Math.cos(radLat) * Math.sin(angularDist) * Math.cos(radBearing)
  );

  const projectedRadLon =
    radLon +
    Math.atan2(
      Math.sin(radBearing) * Math.sin(angularDist) * Math.cos(radLat),
      Math.cos(angularDist) - Math.sin(radLat) * Math.sin(projectedRadLat)
    );

  const newLat = (projectedRadLat * 180) / Math.PI;
  const newLon = (((projectedRadLon * 180) / Math.PI + 540) % 360) - 180;

  return {
    lat: Number(newLat.toFixed(6)),
    lon: Number(newLon.toFixed(6)),
    projectedDistanceMeters: distanceMeters,
  };
}

/**
 * Calculates adaptive dynamic match radius in meters based on:
 * - base radar resolution & sensor geolocation uncertainty (typically ~250m)
 * - AIS broadcast latency uncertainty (drift during time delta)
 * - vessel maneuverability margin
 */
export function dynamicMatchRadius(
  baseRadiusM: number,
  deltaSeconds: number,
  sogKnots: number,
  maxRadiusM: number = 1500
): number {
  const timeDriftMeters = Math.abs(deltaSeconds) * (sogKnots * KNOTS_TO_MPS) * 0.20; // 20% kinematic variance
  const radius = baseRadiusM + timeDriftMeters;
  return Math.min(radius, maxRadiusM);
}

/**
 * Normalizes heading difference to 0..90 degrees for undirected axis comparison
 * (since hull major axis has 180-degree ambiguity without Kelvin wake).
 */
export function orientationAngularDifference(deg1: number, deg2: number, wakeVisible: boolean): number {
  if (wakeVisible) {
    // Directed comparison (0..180)
    let diff = Math.abs(deg1 - deg2) % 360;
    return diff > 180 ? 360 - diff : diff;
  }
  // Undirected axis comparison (0..90)
  let diff = Math.abs(deg1 - deg2) % 180;
  return diff > 90 ? 180 - diff : diff;
}
