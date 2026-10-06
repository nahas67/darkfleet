/**
 * TRACK GEOMETRY: the shared, wrap-aware authority.
 *
 * ================================ WHY ONE AUTHORITY ================================
 *
 * DF-X9.4 section 28 requires this, and it exists because the alternative has already caused a
 * real bug. A track crossing 180 degrees renders as a line straight across the middle of the world,
 * which asserts a journey of ~20,000 km that no vessel made.
 *
 * The wrong fix is to sprinkle `if (Math.abs(lon1 - lon2) > 180)` at each use site. That logic is
 * subtle -- it is wrong for points, wrong again for segments spanning the pole, and wrong a third
 * time for bounding boxes -- and duplicated subtle logic diverges. So there is exactly ONE
 * implementation of wrap handling here, and everything else calls it.
 *
 * ================================ WHAT WRAPPING ACTUALLY REQUIRES ================================
 *
 * NOT UNWRAPPING. It is tempting to carry longitudes past +/-180 so the numbers stay continuous,
 * but `Cartesian3.fromDegrees` normalises longitude back into [-180, 180] -- so an unwrapped value
 * still draws the long way round. Continuous NUMBERS do not produce continuous GEOMETRY.
 *
 * The only correct display strategy is to SPLIT a logical segment wherever it crosses the
 * antimeridian and draw each piece separately. That is display geometry only: the stored
 * observation coordinates are never modified, and a segment that crosses still reports its real
 * start and end.
 */

/* ============================================================================================== *
 * VALIDITY
 * ============================================================================================== */

/**
 * Whether a coordinate is usable.
 *
 * `Number.isFinite` alone is not enough: `null` passed through arithmetic becomes `0`, which is a
 * real place off the coast of Ghana. DF-X9.4 section 51 requires invalid points not be moved to
 * `(0, 0)`, so the check is on the TYPE as well as the value.
 */
export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Fold a longitude into [-180, 180]. Input outside that range is corrected, not rejected. */
export function normalizeLongitude(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const folded = ((((lon + 180) % 360) + 360) % 360) - 180;
  // -180 and 180 are the same meridian; canonicalising avoids two representations of one line.
  return folded === -180 ? 180 : folded;
}

/* ============================================================================================== *
 * THE WRAP ARITHMETIC
 * ============================================================================================== */

/**
 * The SHORTEST signed longitude difference from `a` to `b`, in (-180, 180].
 *
 * `b - a` is wrong across the antimeridian: from 179.9E to 179.9W the naive difference is -359.8,
 * which says the vessel travelled 359.8 degrees west rather than 0.2 east.
 */
export function longitudeDelta(fromLon: number, toLon: number): number {
  return ((((toLon - fromLon) % 360) + 540) % 360) - 180;
}

/**
 * Whether the shortest path between two longitudes crosses the antimeridian.
 *
 * THE RAW DIFFERENCE, NOT THE SHORTEST ONE. This is the single most consequential line in the module,
 * and the first version of it was wrong in a way that was invisible:
 *
 *     Math.abs(longitudeDelta(a, b)) > 180
 *
 * `longitudeDelta` returns the SHORTEST signed arc, which is by construction always within
 * (-180, 180]. Testing it for `> 180` is therefore self-contradictory -- it can essentially never be
 * true. The function returned `false` for every input, so `splitAtAntimeridian` never split anything,
 * `wrappedBounds` reported antimeridian crossings as ordinary, and every antimeridian guarantee in
 * the product was silently disabled while the type signatures still looked correct. Six tests failed
 * and the cause was one comparison.
 *
 * The correct test uses the RAW difference. A shortest arc is at most 180 degrees, so the naive
 * difference exceeds 180 only when the direct route is the long way round -- which is a crossing.
 */
export function crossesAntimeridian(fromLon: number, toLon: number): boolean {
  if (!Number.isFinite(fromLon) || !Number.isFinite(toLon)) return false;
  /*
   * NORMALISED EQUALITY, NOT RAW. 180 and -180 are the SAME meridian, so a track between them has not
   * crossed anything -- it has not moved. A raw `fromLon === toLon` guard misses this, because the
   * two spellings are different numbers, and the 360-degree raw difference then reads as a full
   * crossing. Normalising first makes both spellings 180, which is what they are.
   */
  if (normalizeLongitude(fromLon) === normalizeLongitude(toLon)) return false;
  // The RAW difference, deliberately, and the reason is in the doc comment above: a shortest arc is
  // always within (-180, 180], so it can never exceed 180 and testing it for that is self-contradictory.
  return Math.abs(toLon - fromLon) > 180;
}

/* ============================================================================================== *
 * SPLITTING
 * ============================================================================================== */

export type LatLon = { lat: number; lon: number };

/**
 * Split points into runs that do NOT cross the antimeridian.
 *
 * A new run starts whenever consecutive points would cross. Each returned run is a contiguous slice
 * of the input, and concatenating every run reproduces the input order exactly -- so no point is
 * reordered, dropped, or duplicated.
 *
 * A run of length 1 is legal and meaningful: it is a fix at the very edge of the antimeridian whose
 * partner is across it. Dropping such runs would erase observations from the display.
 */
export function splitAtAntimeridian(points: readonly LatLon[]): LatLon[][] {
  if (points.length === 0) return [];
  const runs: LatLon[][] = [[points[0]]];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (crossesAntimeridian(previous.lon, current.lon)) {
      runs.push([current]);
    } else {
      runs[runs.length - 1].push(current);
    }
  }
  return runs;
}

/* ============================================================================================== *
 * BOUNDING -- WRAP-AWARE, FOR FRAME TRACK
 * ============================================================================================== */

/**
 * A wrap-aware bounding region.
 *
 * `centerLon` may lie outside [-180, 180] when that is the honest centre of a crossing track -- for a
 * track at 179.9E to 179.9W the centre is 180, and reporting -180 would put the camera on the far
 * side of the world from the vessel.
 */
export type WrappedBounds = {
  centerLat: number;
  centerLon: number;
  /** Extent in degrees, each >= 0 and never more than 360. */
  widthDeg: number;
  heightDeg: number;
  /** True when the region spans the antimeridian. */
  crossesAntimeridian: boolean;
};

/**
 * Bounding region of a point set, computed on the CIRCLE rather than the interval.
 *
 * The naive approach takes `min(lon)` and `max(lon)`. For a track at 179.8E, 179.9E, 179.9W and
 * 179.7W that yields [-179.9, +179.9] -- a width of 359.8 degrees, so `frameTrack` zooms out to the
 * entire Earth to contain a vessel that moved 40 km.
 *
 * So the longitudes are UNWRAPPED onto a continuous axis before min/max. The axis is then shifted
 * back into [-180, 180] by subtracting a whole number of turns, which preserves the width exactly.
 */
export function wrappedBounds(lats: readonly number[], lons: readonly number[]): WrappedBounds | null {
  if (lats.length === 0 || lons.length === 0 || lats.length !== lons.length) return null;

  /*
   * STEP 1 -- CONTINUOUS AXIS.
   *
   * Each longitude is shifted onto the axis nearest its predecessor, so a sequence that crosses the
   * antimeridian becomes monotonic instead of jumping by ~360.
   */
  const axis: number[] = [normalizeLongitude(lons[0])];
  for (let i = 1; i < lons.length; i += 1) {
    const step = longitudeDelta(axis[i - 1], normalizeLongitude(lons[i]));
    axis.push(axis[i - 1] + step);
  }

  let lo = axis[0];
  let hi = axis[0];
  let minLat = lats[0];
  let maxLat = lats[0];
  for (let i = 1; i < axis.length; i += 1) {
    if (axis[i] < lo) lo = axis[i];
    if (axis[i] > hi) hi = axis[i];
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
  }

  /*
   * STEP 2 -- CENTRE FIRST, THEN FOLD.
   *
   * Folding each endpoint independently would move them in OPPOSITE directions and inflate the
   * width, so the centre is computed on the continuous axis and only then folded. A centre of exactly
   * 180 folds to 180 rather than -180, which is the same meridian and the side the vessel is on.
   */
  const centerLonRaw = (lo + hi) / 2;
  return {
    centerLat: (minLat + maxLat) / 2,
    centerLon: normalizeLongitude(centerLonRaw),
    widthDeg: hi - lo,
    heightDeg: maxLat - minLat,
    crossesAntimeridian: crossesAntimeridian(normalizeLongitude(lo), normalizeLongitude(hi)),
  };
}

/* ============================================================================================== *
 * INTERPOLATION -- AND ITS DOCUMENTED DOMAIN
 * ============================================================================================== *
 *
 * DF-X9.4 section 31 asks this explicitly, and the answer is that linear lat/lon interpolation is
 * correct ENOUGH for this product, with the arithmetic:
 *
 *   The product only interpolates across intervals of at most `MAX_INTERPOLATION_INTERVAL_S` = 600 s.
 *   At the fastest plausible AIS speed -- a laden container ship at 25 kn, 12.9 m/s -- that is
 *   7,730 m.
 *
 *   Linear interpolation of latitude/longitude over 7.7 km deviates from the great-circle geodesic by
 *   roughly d^2 / (2R), where d is the arc length and R the Earth's radius. For a chord of 7,730 m:
 *
 *       7730^2 / (2 x 6,371,009) = 4.7 m
 *
 *   That is under five metres on a track drawn in metres-to-kilometres, and it is bounded, known and
 *   monotonic rather than a source of divergence at the antimeridian.
 *
 *   So the chosen domain is EXPLICIT: local, sub-10 km, short intervals. Full great-circle
 *   interpolation is NOT implemented, and adding it would be over-engineering for a case the product
 *   never produces -- while introducing its own failure modes at the poles and the antimeridian.
 *
 *   The ONE case where it would matter is a legitimately long interval, and those are exactly the
 *   intervals this product REFUSES to interpolate across: they become GAP segments instead. The
 *   domain limit and the correctness limit are the same limit.
 */

/**
 * Interpolate between two positions at `fraction` in [0, 1].
 *
 * Linear in latitude, and SHORTEST-ARC in longitude -- so an eastbound vessel crossing 179.9E to
 * 179.9W continues east rather than appearing to reverse.
 *
 * Returns null for a non-finite fraction or invalid endpoints, rather than a NaN position that
 * would propagate silently into a Cesium primitive.
 */
export function interpolateAlongTrack(
  from: LatLon,
  to: LatLon,
  fraction: number,
): LatLon | null {
  if (!Number.isFinite(fraction) || !isValidLatLon(from.lat, from.lon) || !isValidLatLon(to.lat, to.lon)) {
    return null;
  }
  const t = Math.min(1, Math.max(0, fraction));
  const lon = from.lon + longitudeDelta(from.lon, to.lon) * t;
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    // Folded back into range so a Cesium primitive receives a legal longitude. The SHORTEST-ARC
    // interpolation above is what makes the path correct; this fold is only so the value is valid.
    lon: normalizeLongitude(lon),
  };
}
