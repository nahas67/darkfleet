/**
 * FRAME TRACK -- a ONE-SHOT camera fit, not a follow mode.
 *
 * ================================ WHY THIS IS ITS OWN MODULE ================================
 *
 * Two independent reasons, and both of them are about a defect that has already happened.
 *
 * 1. WRAP-AWARE BOUNDS. A track at 179.8E-179.9W has a naive longitude extent of 359.8 degrees. The
 *    camera code's own `toBBox` takes plain min/max, so framing such a track zooms out to the entire
 *    Earth to contain a vessel that moved 40 km. The fix cannot live in the camera, because the
 *    camera has no idea it is being asked about a crossing.
 *
 * 2. IT IS NOT FOLLOW. DF-X9.4 section 84 defers continuous FOLLOW, CHASE and oblique tracking to
 *    DF-X9.6. A one-shot fit and a follow mode look similar in code and behave completely
 *    differently: one moves the camera once and hands control straight back, the other takes it.
 *    Keeping them in separate modules makes it impossible to grow follow mode here by accident.
 */

import { wrappedBounds, type LatLon, type WrappedBounds } from './trackGeometry';

/**
 * What `frameTrack` needs. Kept to geometry so this module is testable without a Cesium viewer.
 */
export type FrameTrackRequest = {
  /** Every point the camera must contain. */
  points: readonly LatLon[];
  /**
   * Extra margin as a FRACTION of the track's own extent.
   *
   * A fraction rather than a fixed distance, because a fixed padding dominates a 200 m track and is
   * invisible on a 200 km one. Clamped below so a zero-extent track -- a vessel at anchor -- still
   * gets a usable view instead of a degenerate one.
   */
  paddingFraction?: number;
  /** Smallest half-extent in degrees, so a single fix is framable. */
  minimumHalfExtentDeg?: number;
};

export type FrameTrackPlan = {
  centerLat: number;
  centerLon: number;
  /** Half-extents in degrees, each at least `minimumHalfExtentDeg`. */
  halfHeightDeg: number;
  halfWidthDeg: number;
  bounds: WrappedBounds;
  /** True when the track spans the antimeridian and was NOT framed across the whole world. */
  wrapped: boolean;
};

/** Defaults chosen so the common cases need no tuning and the degenerate ones stay usable. */
const DEFAULT_PADDING = 0.25;
const DEFAULT_MIN_HALF_EXTENT_DEG = 0.005; // roughly 550 m of latitude

/**
 * Compute where the camera must go. PURE -- no viewer, no camera, no side effects.
 *
 * Returning a PLAN rather than moving the camera is what makes this testable: the assertions that
 * matter ("an antimeridian track does not frame the globe") are geometry, and a geometry claim
 * tested through a camera would only be testing that Cesium moves.
 */
export function planFrameTrack(request: FrameTrackRequest): FrameTrackPlan | null {
  const points = request.points.filter(
    (p) => typeof p.lat === 'number' && typeof p.lon === 'number'
      && Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  if (points.length === 0) return null;

  const bounds = wrappedBounds(points.map((p) => p.lat), points.map((p) => p.lon));
  if (!bounds) return null;

  const padding = request.paddingFraction ?? DEFAULT_PADDING;
  const minHalf = request.minimumHalfExtentDeg ?? DEFAULT_MIN_HALF_EXTENT_DEG;

  /*
   * PADDING IS APPLIED ON THE WRAPPED WIDTH, NEVER THE RAW ONE.
   *
   * `bounds.widthDeg` is already the SHORT extent across a crossing. Multiplying a 359.8-degree raw
   * extent by 1.25 is what produces the globe-wide zoom, and it is the single most likely way this
   * function could ship the bug it exists to prevent.
   */
  const halfWidth = Math.max(minHalf, (bounds.widthDeg * (1 + padding)) / 2);
  const halfHeight = Math.max(minHalf, (bounds.heightDeg * (1 + padding)) / 2);

  return {
    // The centre may legitimately sit outside [-180, 180] for a crossing track: reporting -180 for a
    // track centred on the antimeridian would aim the camera a full turn away from the vessel.
    centerLat: bounds.centerLat,
    centerLon: bounds.centerLon,
    halfHeightDeg: halfHeight,
    halfWidthDeg: halfWidth,
    bounds,
    wrapped: bounds.crossesAntimeridian,
  };
}

/** The bbox a Cesium camera should contain, as the product's existing `toBBox` shape. */
export function planToBBox(plan: FrameTrackPlan): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  return {
    // NOT normalised. `toBBox` takes plain numbers and the camera reads them as degrees, so a centre
    // at 180 with a half-width of 0.2 must reach 180.2 rather than folding back to -179.8.
    west: plan.centerLon - plan.halfWidthDeg,
    east: plan.centerLon + plan.halfWidthDeg,
    south: plan.centerLat - plan.halfHeightDeg,
    north: plan.centerLat + plan.halfHeightDeg,
  };
}

/**
 * Move the camera to fit a track, ONCE.
 *
 * The camera is handed straight back afterwards: there is no per-frame hook here and no subscription
 * to the playhead, which is what makes this a one-shot fit rather than the follow mode DF-X9.6 owns.
 */
export function frameTrack(
  flyTo: (lat: number, lon: number, halfHeightDeg: number, halfWidthDeg: number) => void,
  request: FrameTrackRequest,
): boolean {
  const plan = planFrameTrack(request);
  if (!plan) return false;
  flyTo(plan.centerLat, plan.centerLon, plan.halfHeightDeg, plan.halfWidthDeg);
  return true;
}

/** Points of a track's segments, deduplicated by observation index, for framing. */
export function pointsOfSegments(
  segments: ReadonlyArray<{ points: ReadonlyArray<LatLon & { observationIndex: number }> }>,
): LatLon[] {
  const seen = new Set<number>();
  const out: LatLon[] = [];
  for (const segment of segments) {
    for (const point of segment.points) {
      if (seen.has(point.observationIndex)) continue;
      seen.add(point.observationIndex);
      out.push({ lat: point.lat, lon: point.lon });
    }
  }
  return out;
}
