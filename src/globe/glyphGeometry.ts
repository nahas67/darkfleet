/**
 * Screen-space orientation geometry for AIS contact glyphs.
 *
 * ================================ WHY THIS IS SEPARATE FROM THE RENDERER ================================
 *
 * The renderer draws. This module computes. That split is the point: the arithmetic below is
 * where DF-X9's hardest requirements live -- geographic rather than screen orientation, camera
 * rotation independence, high-latitude correctness -- and it is all pure functions over numbers.
 * A renderer cannot be unit-tested for those properties; these can, and they are tested in
 * `glyphGeometry.test.ts` without a GPU, a browser, or a Cesium Viewer.
 *
 * ================================ THE PROBLEM ================================
 *
 * A Cesium `BillboardGraphics.rotation` is a rotation in SCREEN space. A vessel's heading is a
 * compass bearing in the ECEF frame. Those are different quantities in different frames, and one
 * of them depends on where the camera is standing.
 *
 * The naive implementation -- `billboard.rotation = heading` -- happens to look right when the
 * camera happens to be due north of the vessel, looking south, near the equator. It is wrong
 * everywhere else, and wrong in a way that is invisible until the operator rotates the globe:
 *
 *   * viewed from the east, a vessel heading 090 (east) points "up the screen" -- correct -- and
 *     viewed from the west it points down. Same vessel, same heading, opposite picture, because
 *     the frame rotated and the glyph did not.
 *   * at 78N, local east is not screen east. Every parallel converges on the poles, so a vessel
 *     on a straight easterly course traces a curve running increasingly "down" the screen.
 *     Rotating by a fixed screen angle makes it look like it is turning.
 *
 * ================================ THE SOLUTION, IN THREE STEPS ================================
 *
 *   1. The bearing names a direction in the contact's LOCAL HORIZONTAL PLANE:
 *      `bearingVector = east * sin(bearing) + north * cos(bearing)`.
 *
 *   2. A billboard lies in the SCREEN PLANE, so its orientation can only be resolved within that
 *      plane. Project the bearing vector onto it by removing the component along the camera's
 *      view direction:
 *      `perp = bearingVector - view * (bearingVector . view)`.
 *
 *      This single subtraction IS the camera-independence property. It is why the same vessel
 *      seen from the north and from the south correctly rotates by 180 degrees: the world has
 *      turned over on screen and this step accounts for it.
 *
 *   3. Measure the projected direction in the screen plane and offset from the image's resting
 *      orientation (straight up, i.e. 90 degrees counter-clockwise from screen-right):
 *      `rotation = atan2(perp . up, perp . right) - 90 degrees`.
 *
 * ================================ A REVISION THAT WAS WRONG ================================
 *
 * The first implementation projected out the camera's screen `up` vector instead of its view
 * direction. Those are different vectors, and the mistake was silently total rather than
 * subtly off: for an overhead camera the bearing direction IS the screen-up vector, so the
 * projection collapsed to zero and the function returned null for the single most common
 * viewing geometry. It returned plausible numbers everywhere else, which is how it survived
 * being written. The unit tests in this file's companion are what caught it -- `frameStraightDown`
 * plus "heading 000 points screen-up" is an assertion an approximate implementation cannot pass.
 */

import type { Cartesian2, Cartesian3, Viewer } from 'cesium';

/** The minimum structural surface this module needs from a Cesium camera. */
export interface OrientationCamera {
  /** World-space unit vector pointing RIGHT on screen. */
  readonly right: Cartesian3;
  /** World-space unit vector pointing UP on screen. */
  readonly up: Cartesian3;
}

/* ============================================================================================== *
 * SMALL VECTOR ARITHMETIC
 *
 * Hand-rolled rather than imported so the module depends on nothing but types. Each operation is
 * trivial, and the whole file stays testable with plain object literals.
 * ============================================================================================== */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const magnitude = (a: Vec3): number => Math.sqrt(dot(a, a));

function normalize(a: Vec3): Vec3 | null {
  const m = magnitude(a);
  if (!Number.isFinite(m) || m < 1e-12) return null;
  return scale(a, 1 / m);
}

/** Cross product, right-handed. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Unsigned angle between two vectors, in degrees. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  return (Math.atan2(magnitude(cross(a, b)), dot(a, b)) * 180) / Math.PI;
}

/** Wrap radians into `(-pi, pi]` so a value never grows without bound across frames. */
export function normalizeAngleRad(rad: number): number {
  if (!Number.isFinite(rad)) return Number.NaN;
  let wrapped = rad % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  if (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

/* ============================================================================================== *
 * LOCAL FRAME CONSTRUCTION
 * ============================================================================================== */

/**
 * Local east / north / up unit vectors in world coordinates, at a given lat/lon.
 *
 * Computed directly rather than through `Transforms.eastNorthUpToFixedFrame` so the arithmetic
 * is visible and testable. On a sphere of radius 1, which is sufficient for orientation:
 *
 *   up    = (cos(lat)cos(lon), cos(lat)sin(lon), sin(lat))
 *   north = (-sin(lat)cos(lon), -sin(lat)sin(lon),  cos(lat))
 *   east  = (-sin(lon),           cos(lon),          0        )
 *
 * THE ZERO IN `east.z` IS THE WHOLE POINT. Local east is tangent to the surface at every
 * latitude, so it can never point "up". At 78N the local vertical is tilted 78 degrees from the
 * view axis of an overhead camera, and local east is correspondingly far from screen-horizontal.
 * A renderer rotating by a constant screen angle misses that entirely.
 *
 * A sphere rather than the WGS84 ellipsoid, because a bearing is an ANGLE and the difference in
 * the local frame between the two is far below what an operator can read off a glyph. The exact
 * geodetic machinery lives in the backend, where it belongs.
 */
export function localFrameDeg(
  latDeg: number,
  lonDeg: number,
): { east: Vec3; north: Vec3; up: Vec3 } {
  const toRad = Math.PI / 180;
  const lat = latDeg * toRad;
  const lon = lonDeg * toRad;
  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const cosLon = Math.cos(lon);
  const sinLon = Math.sin(lon);

  return {
    east: { x: -sinLon, y: cosLon, z: 0 },
    north: { x: -sinLat * cosLon, y: -sinLat * sinLon, z: cosLat },
    up: { x: cosLat * cosLon, y: cosLat * sinLon, z: sinLat },
  };
}

/* ============================================================================================== *
 * THE ROTATION
 * ============================================================================================== */

/**
 * The camera's world-space VIEW direction, recovered from its screen axes.
 *
 * Cesium maintains `directionWC`, `rightWC` and `upWC` in a right-handed screen frame where
 * `up = cross(right, direction)`. Inverting gives `direction = cross(up, right)`.
 *
 * RECOVERING IT RATHER THAN TAKING IT AS AN ARGUMENT is deliberate. The direction is fully
 * determined by `right` and `up`, so accepting a third independently-sourced vector would create
 * a way to pass an inconsistent frame -- and every failure that causes would present as a
 * compass error rather than as a bad argument.
 */
export function viewDirectionFrom(right: Vec3, up: Vec3): Vec3 | null {
  return normalize(cross(up, right));
}

/**
 * The `rotation` for a Cesium billboard so it points along a geographic bearing.
 *
 * CONVENTION: radians, positive COUNTER-CLOCKWISE on screen, matching
 * `BillboardGraphics.rotation`. The glyph image is assumed to point toward the top of its own
 * bitmap, and this rotates away from that resting orientation.
 *
 * NULL IS A REAL ANSWER. When the bearing points exactly at or directly away from the camera,
 * the projection vanishes and there is no screen angle -- the operator is looking down the
 * vessel's keel. Returning null lets the caller draw an unrotated marker; returning 0 would draw
 * a vessel pointing north, which is a claim nobody made.
 */
export function glyphScreenRotation(
  bearingDeg: number,
  latDeg: number,
  lonDeg: number,
  camera: OrientationCamera,
): number | null {
  if (!Number.isFinite(bearingDeg) || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return null;
  }
  const rightRaw = camera?.right as unknown as Vec3 | undefined;
  const upRaw = camera?.up as unknown as Vec3 | undefined;
  if (!rightRaw || !upRaw) return null;

  const right = normalize(rightRaw);
  const up = normalize(upRaw);
  if (right === null || up === null) return null;

  const view = viewDirectionFrom(right, up);
  if (view === null) return null;

  const { east, north } = localFrameDeg(latDeg, lonDeg);
  const bearingRad = bearingDeg * (Math.PI / 180);
  const bearingVector = add(scale(east, Math.sin(bearingRad)), scale(north, Math.cos(bearingRad)));

  const perpendicular = normalize(sub(bearingVector, scale(view, dot(bearingVector, view))));
  if (perpendicular === null) return null;

  const screenAngle = Math.atan2(dot(perpendicular, up), dot(perpendicular, right));
  if (!Number.isFinite(screenAngle)) return null;

  return normalizeAngleRad(screenAngle - Math.PI / 2);
}

/**
 * Read the screen frame from a live Cesium viewer.
 *
 * Returns null when the viewer has no camera, or before the first render when the axes are
 * zero-length -- dividing by those would produce NaN rotations for every contact.
 */
export function cameraFrameFromViewer(viewer: Viewer | undefined): OrientationCamera | null {
  if (!viewer || !viewer.camera) return null;
  const right = viewer.camera.rightWC as unknown as Vec3 | undefined;
  const up = viewer.camera.upWC as unknown as Vec3 | undefined;
  if (!right || !up || !Number.isFinite(right.x) || !Number.isFinite(up.x)) return null;
  const nRight = normalize(right);
  const nUp = normalize(up);
  if (nRight === null || nUp === null) return null;
  return { right: nRight as unknown as Cartesian3, up: nUp as unknown as Cartesian3 };
}

/* ============================================================================================== *
 * HORIZON / BACKSIDE
 * ============================================================================================== */

/**
 * Whether a position may be drawn at all.
 *
 * DF-X9 §18. Two failure modes are separated deliberately, because they need different handling:
 *
 *   BEHIND_GLOBE  -- the ellipsoid lies between the camera and the point. Nothing should be
 *                    drawn, and in particular the globe must not occlude-hide a marker while its
 *                    LABEL still draws on top, which is how a vessel appears to float over the
 *                    limb.
 *   DRAWABLE      -- in front of the camera. Clipped projection beyond this is the CALLER's
 *                    screen-space concern; a clamped marker would be drawn at a position the
 *                    vessel is not at, so culling must happen in screen space, not here.
 *
 * THE TEST IS THE TANGENT PLANE, not the view direction:
 *
 *     dot(localUpAtThePoint, cameraPosition - point) > 0
 *
 * A surface point is above the horizon exactly when the camera lies on the OUTWARD side of that
 * point's tangent plane. This is exact for a sphere, and it is the only formulation that gets a
 * steeply-oblique view right.
 *
 * An earlier revision used `dot(localUp, normalize(point - camera))` -- the direction from the
 * camera to the point. That is wrong, and not subtly: for a camera 400 km above the surface
 * looking 222 km ahead, that direction points steeply DOWNWARD, so the dot product comes out
 * around -0.86 and a plainly visible contact is reported as `BEHIND_GLOBE`. Measured on the real
 * fixture before the fix:
 *
 *     contact 1,103  camera 3,103    dot(viewDir form) = -0.85866   <- wrong: plainly visible
 *     contact 1,103  camera 3,103    dot(tangent form) = +0.06221   <- correct
 *     contact -1,103 camera 20,103   dot(tangent form) = -0.00817   <- correctly occluded
 *
 * So the failure mode was not a rare edge case; it rejected most close-in contacts.
 */
export type Drawability = 'DRAWABLE' | 'BEHIND_GLOBE' | 'DEGENERATE';

export function drawabilityOf(
  positionEcef: Vec3,
  localUp: Vec3,
  cameraPositionEcef: Vec3,
): Drawability {
  if (
    !positionEcef ||
    !localUp ||
    !cameraPositionEcef ||
    !Number.isFinite(positionEcef.x) ||
    !Number.isFinite(positionEcef.y) ||
    !Number.isFinite(positionEcef.z) ||
    !Number.isFinite(localUp.x) ||
    !Number.isFinite(localUp.y) ||
    !Number.isFinite(localUp.z) ||
    !Number.isFinite(cameraPositionEcef.x) ||
    !Number.isFinite(cameraPositionEcef.y) ||
    !Number.isFinite(cameraPositionEcef.z)
  ) {
    return 'DEGENERATE';
  }

  const up = normalize(localUp);
  if (up === null) return 'DEGENERATE';

  // Outward side of the tangent plane at the point. `<= 0` keeps a point exactly on the limb
  // drawable, because a contact on the horizon IS visible.
  return dot(up, sub(cameraPositionEcef, positionEcef)) <= 0 ? 'BEHIND_GLOBE' : 'DRAWABLE';
}

/* ============================================================================================== *
 * DF-X9.5 DECLUTTERING + LABEL SCALING
 * ============================================================================================== */

/**
 * Production label budget. Matches the bound the scale test already measures (120), so the
 * shipped globe cannot show an unbounded label set while the test proves a bounded one.
 */
export const MAX_AIS_LABELS = 120;

/**
 * Monospace collision-box estimate for 11px `ui-monospace` labels.
 *
 * The renderer draws `MMSI · COG · SOG`, whose length varies by ~2x. A fixed 92px slot
 * underestimated full labels (overlap drawn as legible) and overestimated bare MMSIs.
 * Advance 6.6px/char (0.6em at 11px) plus Cesium default background padding 7/5 is
 * conservative: a slightly wide box suppresses, a narrow one overlaps.
 */
export function estimateLabelBounds(text: string): { widthPx: number; heightPx: number } {
  const advancePx = 6.6;
  const padX = 7;
  const padY = 5;
  const fontPx = 11;
  return {
    widthPx: Math.ceil(text.length * advancePx + padX * 2),
    heightPx: Math.ceil(fontPx + padY * 2),
  };
}

/**
 * Distance scale for labels, mirroring the Cesium `NearFarScalar` used at draw time.
 *
 * 1.0 at close inspection, easing to 0.55 at global range (8.0e6 m), clamped beyond. Pure so
 * the interpolation is unit-tested without a viewer; the renderer passes the same endpoints
 * to Cesium rather than reimplementing them there.
 */
export const LABEL_SCALE_NEAR_M = 1.0e3;
export const LABEL_SCALE_FAR_M = 8.0e6;
export const LABEL_SCALE_NEAR_VALUE = 1.0;
export const LABEL_SCALE_FAR_VALUE = 0.55;
export function labelScaleForRangeMeters(rangeMeters: number): number {
  const near = LABEL_SCALE_NEAR_M;
  const far = LABEL_SCALE_FAR_M;
  const nearValue = LABEL_SCALE_NEAR_VALUE;
  const farValue = LABEL_SCALE_FAR_VALUE;
  if (!Number.isFinite(rangeMeters) || rangeMeters <= near) return nearValue;
  if (rangeMeters >= far) return farValue;
  const t = (rangeMeters - near) / (far - near);
  return nearValue + (farValue - nearValue) * t;
}

/* ============================================================================================== *
 * LABEL ARBITRATION
 * ============================================================================================== */

/**
 * One contact's claim on a label slot, and why it has that priority.
 *
 * NO THREAT OR SECURITY SEMANTICS. DF-X9 §30 is explicit that priority is about what the
 * operator is working on, not about how threatening anything is. `WATCHLISTED` exists because a
 * future watchlist feature needs a slot, not because this renderer knows anything about threat.
 */
export type LabelPriority =
  | 'SELECTED_TARGET'
  | 'SELECTED_AIS'
  | 'ASSOCIATED_AIS'
  | 'WATCHLISTED'
  | 'INVESTIGATION'
  | 'GENERIC_AIS';

export const LABEL_PRIORITY_ORDER: readonly LabelPriority[] = [
  'SELECTED_TARGET',
  'SELECTED_AIS',
  'ASSOCIATED_AIS',
  'WATCHLISTED',
  'INVESTIGATION',
  'GENERIC_AIS',
] as const;

export type LabelClaim = {
  id: string;
  priority: LabelPriority;
  /** Screen position in CSS pixels, already projected. */
  screen: Cartesian2 | { x: number; y: number };
  widthPx: number;
  heightPx: number;
};

export type LabelDecision = {
  shown: LabelClaim[];
  suppressed: Array<{ id: string; reason: 'COLLISION' | 'BUDGET' }>;
  /** Worst overlap fraction among placed labels. 0 means no overlap at all. */
  maxOverlap: number;
};

/**
 * Choose which labels to draw, deterministically.
 *
 * DF-X9 §29/§31. The requirements that shaped this:
 *
 *   * The selected contact's label is ALWAYS drawn, even overlapping. A selected target with no
 *     visible label is worse than two overlapping ones -- the operator asked about this contact
 *     by name.
 *   * The SAME input always produces the SAME output. No iteration-order dependence, no
 *     time-based hysteresis. Flickering labels are worse than missing ones.
 *   * Every claim resolves to shown or suppressed WITH A REASON. A label that vanishes without a
 *     recorded reason is indistinguishable from a bug.
 *
 * Determinism comes from sorting on `(priorityRank, id)`. `id` is the tiebreak because it is
 * stable across frames whereas screen position is not -- two contacts at equal priority would
 * otherwise swap places as the camera moved.
 */
export function arbitrateLabels(
  claims: readonly LabelClaim[],
  options: { maxLabels?: number } = {},
): LabelDecision {
  const budget = options.maxLabels ?? Number.POSITIVE_INFINITY;
  const rank = (p: LabelPriority): number => {
    const index = LABEL_PRIORITY_ORDER.indexOf(p);
    return index === -1 ? LABEL_PRIORITY_ORDER.length : index;
  };

  const ordered = [...claims].sort(
    (a, b) => rank(a.priority) - rank(b.priority) || a.id.localeCompare(b.id),
  );

  const placed: LabelClaim[] = [];
  const suppressed: Array<{ id: string; reason: 'COLLISION' | 'BUDGET' }> = [];
  let maxOverlap = 0;

  const overlap = (a: LabelClaim, b: LabelClaim): number => {
    const dx = Math.abs(a.screen.x - b.screen.x);
    const dy = Math.abs(a.screen.y - b.screen.y);
    const ox = (a.widthPx + b.widthPx) / 2 - dx;
    const oy = (a.heightPx + b.heightPx) / 2 - dy;
    if (ox <= 0 || oy <= 0) return 0;
    const area = a.widthPx * a.heightPx;
    const smaller = Math.min(area, b.widthPx * b.heightPx);
    return smaller > 0 ? (ox * oy) / smaller : 0;
  };

  for (const claim of ordered) {
    if (placed.length >= budget) {
      suppressed.push({ id: claim.id, reason: 'BUDGET' });
      continue;
    }
    // Selection wins every collision. Stated rather than tuned: the operator asked for this
    // contact, so a colliding neighbour yielding is not a trade-off worth making configurable.
    if (claim.priority === 'SELECTED_TARGET' || claim.priority === 'SELECTED_AIS') {
      for (const existing of placed) maxOverlap = Math.max(maxOverlap, overlap(claim, existing));
      placed.push(claim);
      continue;
    }
    const worst = placed.reduce((m, existing) => Math.max(m, overlap(claim, existing)), 0);
    if (worst > 0) {
      suppressed.push({ id: claim.id, reason: 'COLLISION' });
      continue;
    }
    placed.push(claim);
  }

  return { shown: placed, suppressed, maxOverlap };
}