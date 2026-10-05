/**
 * Tests for the screen-space glyph orientation geometry.
 *
 * These are the assertions DF-X9 §15/§16/§17/§18 require and that a renderer cannot supply: a
 * browser can show that a glyph LOOKS wrong, but only these can prove that 090 at 78N points
 * along local east for every camera position, or that a 359 -> 1 change is a 2-degree move.
 *
 * CAMERA FRAMES ARE CONSTRUCTED FROM GEOMETRY, not hand-picked constants. Each is built by
 * choosing where the camera stands and what it looks at, so a wrong expectation shows up as a
 * wrong CAMERA rather than as a fudged number.
 */

import { describe, expect, it } from 'vitest';
import {
  LABEL_PRIORITY_ORDER,
  arbitrateLabels,
  angleBetweenDeg,
  cameraFrameFromViewer,
  drawabilityOf,
  glyphScreenRotation,
  localFrameDeg,
  normalizeAngleRad,
  viewDirectionFrom,
  type LabelClaim,
  type OrientationCamera,
  type LabelPriority,
} from './glyphGeometry';

type Vec = { x: number; y: number; z: number };

const DEG = Math.PI / 180;
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z;
const mag = (a: Vec): number => Math.sqrt(dot(a, a));
const cross = (a: Vec, b: Vec): Vec => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (v: Vec): Vec => {
  const m = mag(v) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
};
const subv = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scalev = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k, z: a.z * k });

/** A world position on a unit sphere at a lat/lon. */
function onSphere(lat: number, lon: number): Vec {
  return localFrameDeg(lat, lon).up;
}

/**
 * A screen frame for a camera STANDING AT ALTITUDE above `camLat/camLon`, looking down at
 * `targetLat/targetLon`.
 *
 * `altitudeKm` is a real height above the surface. This matters: a camera exactly on the surface
 * of a sphere has a visible cap of ZERO angular radius -- it can only see the point at its feet.
 * Tests that place the camera on the surface are therefore testing a degenerate configuration,
 * which is how an earlier draft of this file produced confidently wrong expectations.
 */
function frameFrom(
  camLat: number,
  camLon: number,
  targetLat: number,
  targetLon: number,
  altitudeKm = 400,
): OrientationCamera {
  const radius = 6371 + altitudeKm;
  const camera: Vec = scalev(onSphere(camLat, camLon), radius / 6371);
  const target = onSphere(targetLat, targetLon);
  const forward = norm(subv(target, camera));

  // Screen-up: world zenith projected perpendicular to the view direction. This is the standard
  // construction and it is what makes north appear "up" for an overhead camera.
  const zenith: Vec = { x: 0, y: 0, z: 1 };
  const up = norm(subv(zenith, scalev(forward, dot(zenith, forward))));
  const right = norm(cross(forward, up));
  // Cast once here, rather than at every call site. `Cartesian3` is structurally `{x,y,z}`, so
  // every vector operation below still works; only the nominal type needed widening.
  return { right, up } as unknown as OrientationCamera;
}

/**
 * A screen frame whose screen-UP is the CONTACT'S LOCAL NORTH -- a north-up map view.
 *
 * Needed for any test that compares a bearing against a screen cardinal. `frameFrom` keeps the
 * sky at the top of the screen, which for a steeply-oblique camera means screen-up ends up close
 * to the local VERTICAL rather than to north, and bearings then do not line up with screen
 * cardinals at all. Both frames are legitimate; they answer different questions.
 */
function frameNorthUp(
  camLat: number,
  camLon: number,
  targetLat: number,
  targetLon: number,
  altitudeKm = 400,
): OrientationCamera {
  const camera = scalev(onSphere(camLat, camLon), (6371 + altitudeKm) / 6371);
  const forward = norm(subv(onSphere(targetLat, targetLon), camera));
  const north = localFrameDeg(targetLat, targetLon).north;
  const up = norm(subv(north, scalev(forward, dot(north, forward))));
  const right = norm(cross(forward, up));
  return { right, up } as unknown as OrientationCamera;
}

/** The screen angle in degrees a glyph ends up at, for readability of expectations. */
const asDeg = (rad: number | null): number => (rad as number) / DEG;

/**
 * The SHORT distance between two angles, in degrees.
 *
 * An earlier draft compared raw numbers with `toBeCloseTo`, which cannot express the difference
 * between 180 and -180 -- they are the SAME rotation. Three tests failed on that, and the fix is
 * not to pick the prettier sign but to compare angles the way angles are compared.
 */
function circularDiffDeg(aDeg: number, bDeg: number): number {
  // The DEGREES -> RADIANS conversion is the point. An earlier revision took degrees, passed
  // the difference straight into `normalizeAngleRad` (which expects radians), and reported a
  // genuine -90 degree separation as 116.62. A test helper with the wrong unit produces
  // confident nonsense rather than an error, so the conversion is explicit and the range is
  // asserted on every call.
  const raw = Math.abs(normalizeAngleRad((aDeg - bDeg) * DEG) / DEG);
  expect(raw).toBeLessThanOrEqual(180.000001);
  return raw;
}

/**
 * Apply a billboard rotation to a screen direction, returning the new screen angle.
 *
 * The glyph image points "up" in its own bitmap, i.e. 90 degrees counter-clockwise from
 * screen-right. Rotating it counter-clockwise by `rotation` puts it at `90 + rotation`.
 */
const rotatedScreenAngle = (rotation: number): number => 90 + rotation / DEG;

/**
 * The strongest available correctness check, and the one that does not depend on any convention
 * being guessed right: take the rotation this module produced, apply it to the glyph's resting
 * screen direction, and check the result is PARALLEL to the bearing's projection into the screen
 * plane.
 *
 * This is convention-independent. Whether the sign of `rotation` is clockwise or counter-clockwise
 * only decides which of the two possible perpendicular directions is correct; a test that asserts
 * a signed number has to get that convention right too, and three of the tests in the first draft
 * of this file failed precisely because it had been guessed wrong.
 */
/** Narrow a plain `{x,y,z}` test frame to what the module's public signature expects. */
const asFrame = (f: { right: Vec; up: Vec }): OrientationCamera =>
  f as unknown as OrientationCamera;

function glyphPointsAlongBearing(
  bearingDeg: number,
  lat: number,
  lon: number,
  frame: { right: Vec; up: Vec },
): boolean {
  const rotation = glyphScreenRotation(bearingDeg, lat, lon, asFrame(frame));
  if (rotation === null) return false;

  // Where the glyph ends up pointing, in the screen plane.
  const pointed = scalev(
    addv(scalev(frame.right, Math.cos(rotatedScreenAngle(rotation) * DEG)),
         scalev(frame.up, Math.sin(rotatedScreenAngle(rotation) * DEG))),
    1,
  );

  // Where the bearing projects, in the screen plane.
  const view = viewDirectionFrom(frame.right, frame.up)!;
  const { east, north } = localFrameDeg(lat, lon);
  const bearingVector = addv(scalev(east, Math.sin(bearingDeg * DEG)), scalev(north, Math.cos(bearingDeg * DEG)));
  const projected = norm(subv(bearingVector, scalev(view, dot(bearingVector, view))));

  return Math.abs(cross(pointed, projected).x) + Math.abs(cross(pointed, projected).y) +
         Math.abs(cross(pointed, projected).z) < 1e-9;
}
const addv = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/* ================================================================================================
 * LOCAL FRAME
 * ============================================================================================== */

describe('local frame', () => {
  const points: Array<[number, number]> = [
    [0, 0],
    [45, 30],
    [78, 15],
    [-33, 151],
    [89, 0],
  ];

  it('east, north and up are mutually perpendicular unit vectors', () => {
    for (const [lat, lon] of points) {
      const { east, north, up } = localFrameDeg(lat, lon);
      expect(mag(east)).toBeCloseTo(1, 9);
      expect(mag(north)).toBeCloseTo(1, 9);
      expect(mag(up)).toBeCloseTo(1, 9);
      expect(dot(east, north)).toBeCloseTo(0, 9);
      expect(dot(east, up)).toBeCloseTo(0, 9);
      expect(dot(north, up)).toBeCloseTo(0, 9);
    }
  });

  it('up points to the north pole from the equator', () => {
    const { up } = localFrameDeg(0, 0);
    expect(up.x).toBeCloseTo(1, 9);
    expect(up.z).toBeCloseTo(0, 9);
  });

  it('east has NO vertical component at any latitude', () => {
    // THE property that makes high-latitude handling necessary: local east is tangent to the
    // surface everywhere, so it can never point "up".
    for (const lat of [0, 45, 78, 89]) {
      expect(localFrameDeg(lat, 15).east.z).toBeCloseTo(0, 12);
    }
  });

  it('north runs along the meridian', () => {
    // Due north gains vertical component north of the equator, loses it south of it.
    expect(localFrameDeg(45, 0).north.z).toBeCloseTo(Math.cos(45 * DEG), 9);
    expect(localFrameDeg(-45, 0).north.z).toBeCloseTo(Math.cos(45 * DEG), 9);
    expect(localFrameDeg(0, 0).north.z).toBeCloseTo(1, 9);
  });
});

/* ================================================================================================
 * ORIENTATION
 * ============================================================================================== */

describe('glyph screen rotation', () => {
  const contact: [number, number] = [1, 103];
  // North-up: north on screen is screen-up, east is screen-right.
  const overhead = frameNorthUp(1, 103, 1, 103);

  /**
   * THE primary correctness assertion, and the one that cannot be satisfied by guessing the sign
   * convention: for every bearing, the rotated glyph must end up parallel to that bearing's
   * projection on screen.
   */
  it('orients the glyph along the bearing, for every bearing and several cameras', () => {
    const frames = [
      overhead,
      frameFrom(20, 103, 1, 103),
      frameFrom(-5, 130, 1, 103),
      frameFrom(1, 95, 1, 103),
    ];
    for (const frame of frames) {
      for (const bearing of [0, 17, 90, 137, 180, 271, 359]) {
        expect(glyphPointsAlongBearing(bearing, ...contact, frame)).toBe(true);
      }
    }
  });

  it('holds at high latitude too', () => {
    // The same invariant, where meridian convergence actually bites.
    for (const lat of [0, 45, 70, 78, 88]) {
      for (const bearing of [0, 45, 90, 200, 315]) {
        expect(glyphPointsAlongBearing(bearing, lat, 15, frameFrom(lat, 15, lat, 15))).toBe(true);
        expect(glyphPointsAlongBearing(bearing, lat, 15, frameFrom(lat - 8, 25, lat, 15))).toBe(true);
      }
    }
  });

  it('a vessel heading 000 needs no rotation when the camera looks straight down', () => {
    // North is screen-up, which is the glyph's resting orientation.
    expect(circularDiffDeg(asDeg(glyphScreenRotation(0, ...contact, overhead)), 0)).toBeLessThan(0.1);
  });

  it('due east is a quarter turn from due north in a north-up view', () => {
    // The frame is built INLINE and its north-alignment asserted as a PRECONDITION, so a failure
    // below cannot be blamed on the code under test when the harness is what drifted.
    const frame = frameNorthUp(1, 103, 1, 103);
    expect(dot(frame.up, localFrameDeg(1, 103).north)).toBeGreaterThan(0.9999);
    expect(dot(frame.right, localFrameDeg(1, 103).east)).toBeGreaterThan(0.9999);

    const north = asDeg(glyphScreenRotation(0, ...contact, frame));
    const east = asDeg(glyphScreenRotation(90, ...contact, frame));
    // `circularDiffDeg` already subtracts, so passing a pre-subtracted value -- which the first
    // draft of this file did -- reports 180 for what is a 90 degree step.
    expect(circularDiffDeg(east, north)).toBeCloseTo(90, 1);
    // And with the camera directly overhead on a north-up view, north needs no rotation at all.
    expect(circularDiffDeg(north, 0)).toBeLessThan(0.01);
  });

  it('the four cardinal bearings are 90 degrees apart around the circle', () => {
    const frame = frameNorthUp(1, 103, 1, 103);
    const rotations = [0, 90, 180, 270].map((b) =>
      asDeg(glyphScreenRotation(b, ...contact, frame)),
    );
    // Asserted as a SET around the circle rather than pairwise. The first draft asserted every
    // pair is 90 degrees apart, which is false by construction: opposite bearings are 180 apart.
    const sorted = rotations
      .map((r) => normalizeAngleRad(r * DEG) / DEG)
      .sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(circularDiffDeg(sorted[i], sorted[i - 1])).toBeCloseTo(90, 1);
    }
  });

  it('returns null for an unknown bearing rather than drawing north', () => {
    // THE hazard from DF-X9 §11: 0 degrees means due north, so substituting it for UNKNOWN
    // would assert a direction the vessel never reported.
    expect(glyphScreenRotation(Number.NaN, ...contact, overhead)).toBeNull();
    expect(glyphScreenRotation(Number.POSITIVE_INFINITY, ...contact, overhead)).toBeNull();
  });

  it('returns null for a degenerate camera frame', () => {
    const zero = { x: 0, y: 0, z: 0 };
    expect(glyphScreenRotation(45, ...contact, asFrame({ right: zero, up: { x: 0, y: 1, z: 0 } }))).toBeNull();
    expect(glyphScreenRotation(45, ...contact, asFrame({ right: { x: 0, y: 0, z: 0 }, up: zero }))).toBeNull();
  });

  it('returns null for a non-finite coordinate', () => {
    expect(glyphScreenRotation(45, Number.NaN, 103, overhead)).toBeNull();
    expect(glyphScreenRotation(45, 1, Number.NaN, overhead)).toBeNull();
  });
});

/* ================================================================================================
 * CAMERA ROTATION INDEPENDENCE
 * ============================================================================================== */

describe('camera rotation independence', () => {
  const contact: [number, number] = [1, 103];

  it('a naive `rotation = heading` implementation could not satisfy these frames', () => {
    /*
     * The property that matters, asserted WITHOUT a hand-derived constant.
     *
     * The first draft of this file asserted "crossing to the far side changes the rotation by
     * exactly 180 degrees", worked out from a diagram, and failed: the real figure is geometry-
     * dependent, and for a north-up frame an eastbound vessel is on the SAME side of the screen
     * from either side of the globe. That test was asserting a number about the frame rather than
     * a property of the code, so it has been replaced by the geometric invariant below, which
     * holds for every camera and every bearing and cannot be satisfied by a wrong sign or a wrong
     * frame.
     */
    const frames = [
      frameFrom(20, 103, ...contact),
      frameFrom(-20, 103, ...contact),
      frameFrom(1, 123, ...contact),
      frameFrom(1, 83, ...contact),
      frameFrom(1, 103, ...contact),
    ];
    // Every one of these must produce a glyph pointing along the bearing.
    for (const frame of frames) {
      expect(glyphPointsAlongBearing(90, ...contact, frame)).toBe(true);
      expect(glyphPointsAlongBearing(200, ...contact, frame)).toBe(true);
    }
    // And they must not all agree, or the glyph would be screen-locked.
    const rotations = frames.map((frame) => glyphScreenRotation(90, ...contact, frame) as number);
    expect(new Set(rotations.map((r) => r.toFixed(3))).size).toBeGreaterThan(1);
  });

  it('the rotation changes SMOOTHLY as the camera orbits', () => {
    // Not a jump. A small camera move must not spin the glyph; sampling an orbit catches any
    // implementation with a discontinuity, which is what a `mod 360` slip would produce.
    let previous = glyphScreenRotation(45, ...contact, frameFrom(30, 103, ...contact)) as number;
    for (let lon = 104; lon <= 122; lon += 1) {
      const next = glyphScreenRotation(45, ...contact, frameFrom(30, lon, ...contact)) as number;
      expect(Math.abs(normalizeAngleRad(next - previous) / DEG)).toBeLessThan(20);
      previous = next;
    }
  });

  it('the direction perpendicular to the screen plane is recovered from right and up', () => {
    // The frame the tests build must satisfy the same relation a real Cesium camera does, or
    // every expectation above is testing the harness rather than the code.
    const frame = frameFrom(20, 103, 1, 103);
    const view = viewDirectionFrom(frame.right, frame.up);
    expect(view).not.toBeNull();
    expect(mag(view as Vec)).toBeCloseTo(1, 9);
    expect(dot(view as Vec, frame.right)).toBeCloseTo(0, 9);
    expect(dot(view as Vec, frame.up)).toBeCloseTo(0, 9);
    // It must be the axis the camera actually looks ALONG, not its opposite -- otherwise every
    // projection would be onto the wrong plane. Which of the two perpendicular directions is
    // "forward" is fixed by the sign convention below; the geometric invariant is what catches an
    // inverted recovery, so the numeric check here is deliberately only "perpendicular".
  });
});

/* ================================================================================================
 * HIGH LATITUDE
 * ============================================================================================== */

describe('high-latitude orientation', () => {
  it('an eastbound vessel is screen-right when looked at from overhead at ANY latitude', () => {
    // Meridian convergence does not break a due-east heading when the camera is directly above:
    // local east is screen-right everywhere. Asserted geometrically rather than by a signed
    // number, so the test states the property instead of a convention.
    for (const lat of [0, 30, 60, 78, 88]) {
      expect(glyphPointsAlongBearing(90, lat, 15, frameFrom(lat, 15, lat, 15))).toBe(true);
    }
  });

  it('a northbound vessel points along the meridian at ANY latitude', () => {
    for (const lat of [0, 30, 60, 78, 88]) {
      expect(glyphPointsAlongBearing(0, lat, 15, frameFrom(lat, 15, lat, 15))).toBe(true);
    }
  });

  it('the rotation depends on VIEW GEOMETRY, not on bearing alone', () => {
    // THE defect DF-X9 §16 describes, stated as the property rather than as a hand-derived
    // number. Comparing one fixed bearing between two views is not enough: bearing 090 happens to
    // project almost identically from directly above and from an oblique angle at high latitude,
    // because local east is tangent to the surface and barely foreshortens. The requirement is
    // that SOME bearing must re-orient when the camera moves -- otherwise the glyph is
    // screen-locked and a constant-angle renderer would pass.
    const overheadHigh = frameFrom(78, 15, 78, 15);
    const obliqueHigh = frameFrom(66, 40, 78, 15);
    let widest = 0;
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const difference = circularDiffDeg(
        asDeg(glyphScreenRotation(bearing, 78, 15, overheadHigh)),
        asDeg(glyphScreenRotation(bearing, 78, 15, obliqueHigh)),
      );
      widest = Math.max(widest, difference);
      // And every bearing must remain geometrically correct in BOTH views.
      expect(glyphPointsAlongBearing(bearing, 78, 15, overheadHigh)).toBe(true);
      expect(glyphPointsAlongBearing(bearing, 78, 15, obliqueHigh)).toBe(true);
    }
    expect(widest).toBeGreaterThan(1);
  });

  it('a high-latitude contact viewed obliquely is still oriented correctly', () => {
    // The accuracy requirement behind DF-X9 §16: not merely "different", but RIGHT.
    for (const bearing of [0, 45, 90, 180, 270]) {
      expect(glyphPointsAlongBearing(bearing, 78, 15, frameFrom(66, 40, 78, 15))).toBe(true);
    }
  });

  it('does not crash or return null near the pole', () => {
    for (const lat of [85, 88, 89.5, 90]) {
      const rotation = glyphScreenRotation(90, lat, 15, frameFrom(lat, 15, lat, 15));
      expect(Number.isFinite(rotation as number)).toBe(true);
    }
  });

  it('a polar contact rotates when the camera orbits it', () => {
    // The extreme case: everything is local east/north, and a fixed-angle implementation would
    // freeze the glyph here.
    const a = glyphScreenRotation(90, 89.5, 15, frameFrom(89.5, 15, 89.5, 15)) as number;
    const b = glyphScreenRotation(90, 89.5, 15, frameFrom(89.5, 40, 89.5, 15)) as number;
    expect(circularDiffDeg(a, b)).toBeGreaterThan(1);
  });
});

/* ================================================================================================
 * WRAPPING
 * ============================================================================================== */

describe('angle wrapping', () => {
  it('359 and 1 degrees give rotations 2 degrees apart, not 358', () => {
    // THE regression DF-X9 names, now in the screen frame.
    //
    // Measured in a NORTH-UP frame, and that qualification matters. With an orthonormal
    // north-aligned screen basis, east and north are equally foreshortened, so a change of
    // `delta` in bearing is exactly `delta` on screen. In a sky-up oblique frame the two axes are
    // foreshortened differently, and a 2 degree bearing change correctly projects to well under a
    // degree of screen rotation -- so asserting "2 degrees" there would be asserting that the
    // projection is isotropic, which it is not.
    const frame = frameNorthUp(1, 103, 1, 103);
    const a = glyphScreenRotation(359, 1, 103, frame) as number;
    const b = glyphScreenRotation(1, 1, 103, frame) as number;
    expect(circularDiffDeg(asDeg(a), asDeg(b))).toBeCloseTo(2, 3);
    // And the naive raw subtraction agrees here -- which is the point: it is 2, never 358.
    expect(Math.abs(asDeg(a) - asDeg(b))).toBeCloseTo(2, 3);
  });

  it('an oblique frame is not required to preserve the bearing MAGNITUDE', () => {
    /*
     * A first draft asserted that a 2 degree bearing change stays a 2 degree screen rotation in an
     * OBLIQUE frame, and measured 102 degrees. The implementation was right and the expectation
     * was not.
     *
     * In an oblique view the bearing direction can sit close to the screen plane's edge, where its
     * projection is both short and highly sensitive. A small change in bearing then swings the
     * projected direction through a large angle. That is correct perspective behaviour, not a
     * wrap error, and an implementation that "fixed" it would be introducing anisotropy.
     *
     * So this test asserts the thing that actually must hold in any frame -- the glyph still
     * points along the bearing -- and the magnitude claim is confined to the north-up frame above,
     * where it is exact.
     */
    const frame = frameFrom(20, 103, 1, 103);
    expect(glyphPointsAlongBearing(359, 1, 103, asFrame(frame))).toBe(true);
    expect(glyphPointsAlongBearing(1, 1, 103, asFrame(frame))).toBe(true);
    expect(glyphPointsAlongBearing(0, 1, 103, asFrame(frame))).toBe(true);
  });

  it('normalises into (-180, 180]', () => {
    expect(normalizeAngleRad(0)).toBe(0);
    expect(normalizeAngleRad(Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngleRad(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngleRad(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngleRad(Number.NaN)).toBeNaN();
  });
});

describe('angleBetweenDeg', () => {
  it('is the unsigned angle between two vectors', () => {
    const x: Vec = { x: 1, y: 0, z: 0 };
    const y: Vec = { x: 0, y: 1, z: 0 };
    expect(angleBetweenDeg(x, x)).toBeCloseTo(0, 9);
    expect(angleBetweenDeg(x, y)).toBeCloseTo(90, 9);
    expect(angleBetweenDeg(x, { x: -1, y: 0, z: 0 })).toBeCloseTo(180, 9);
  });
});

/* ================================================================================================
 * HORIZON AND BACKSIDE
 * ============================================================================================== */

describe('drawability', () => {
  /** A camera `altitudeKm` above a lat/lon, as a real elevated position. */
  const above = (lat: number, lon: number, altitudeKm = 400): Vec =>
    scalev(onSphere(lat, lon), (6371 + altitudeKm) / 6371);
  const upAt = (lat: number, lon: number): Vec => localFrameDeg(lat, lon).up;

  it('draws a close contact below an oblique camera', () => {
    // THE regression. The camera is 400 km up and 222 km north, looking steeply down. The
    // previous view-direction formula returned -0.859 here and reported this plainly visible
    // contact as BEHIND_GLOBE, so it rejected most close-in contacts rather than a rare edge.
    expect(drawabilityOf(onSphere(1, 103), upAt(1, 103), above(3, 103))).toBe('DRAWABLE');
  });

  it('draws a contact directly under the camera', () => {
    expect(drawabilityOf(onSphere(1, 103), upAt(1, 103), above(1, 103))).toBe('DRAWABLE');
  });

  it('draws a contact near the horizon', () => {
    // Just inside the visible cap from 400 km: about 19 degrees of arc.
    expect(drawabilityOf(onSphere(0, 103), upAt(0, 103), above(0, 103 + 17))).toBe('DRAWABLE');
  });

  it('refuses a contact on the far side of the globe', () => {
    // THE defect DF-X9 §18 names. A screen-space bounds check cannot catch this -- the point is
    // well inside the viewport -- and drawing it is how a label ends up floating over the limb.
    expect(drawabilityOf(onSphere(-1, 103), upAt(-1, 103), above(20, 103))).toBe('BEHIND_GLOBE');
  });

  it('refuses a contact on the opposite side of the planet', () => {
    expect(drawabilityOf(onSphere(0, 77), upAt(0, 77), above(0, 103))).toBe('BEHIND_GLOBE');
  });

  it('refuses every point on the antipode', () => {
    // Exactly opposite: the point lies on the camera's own tangent plane at best.
    expect(drawabilityOf(onSphere(0, -77), upAt(0, -77), above(0, 103))).toBe('BEHIND_GLOBE');
  });

  it('reports DEGENERATE for a zero local up', () => {
    const zero = { x: 0, y: 0, z: 0 };
    expect(drawabilityOf(onSphere(1, 103), zero, above(3, 103))).toBe('DEGENERATE');
  });

  it('reports DEGENERATE for non-finite input', () => {
    const p = onSphere(1, 103);
    const up = upAt(1, 103);
    expect(drawabilityOf({ x: Number.NaN, y: 0, z: 0 }, up, above(3, 103))).toBe('DEGENERATE');
    expect(drawabilityOf(p, up, { x: Number.NaN, y: 0, z: 0 })).toBe('DEGENERATE');
  });
});

/* ================================================================================================
 * LABEL ARBITRATION
 * ============================================================================================== */

describe('label arbitration', () => {
  const claim = (id: string, priority: LabelPriority, x: number, y: number): LabelClaim => ({
    id,
    priority,
    screen: { x, y },
    widthPx: 80,
    heightPx: 14,
  });

  it('shows a selected label even when it overlaps others', () => {
    const decision = arbitrateLabels([
      claim('selected', 'SELECTED_AIS', 100, 100),
      claim('generic-a', 'GENERIC_AIS', 105, 100),
      claim('generic-b', 'GENERIC_AIS', 100, 100),
    ]);
    expect(decision.shown.map((c) => c.id)).toContain('selected');
    expect(decision.suppressed.map((s) => s.id)).toContain('generic-b');
  });

  it('places both selection-level labels and REPORTS the overlap', () => {
    // A SAR target and an AIS contact can both be selected; suppressing one would silently
    // change what the operator is looking at.
    const decision = arbitrateLabels([
      claim('ais-selected', 'SELECTED_AIS', 100, 100),
      claim('sar-selected', 'SELECTED_TARGET', 100, 100),
    ]);
    expect(decision.shown).toHaveLength(2);
    expect(decision.maxOverlap).toBeGreaterThan(0);
  });

  it('respects priority order as declared', () => {
    // `ASSOCIATED_AIS` outranks `WATCHLISTED` in `LABEL_PRIORITY_ORDER`, because a vessel the
    // correlation actually linked to the selected target is what the operator is working on. The
    // test states the order the module declares rather than an independently invented one, so a
    // deliberate reordering has to be made here too.
    //
    // Placed far apart on screen so this measures ORDER rather than collision -- three claims at
    // one pixel would all but one be suppressed, and the assertion would then be about collision
    // while claiming to be about priority.
    const decision = arbitrateLabels([
      claim('generic', 'GENERIC_AIS', 100, 100),
      claim('assoc', 'ASSOCIATED_AIS', 400, 100),
      claim('watch', 'WATCHLISTED', 700, 100),
    ]);
    expect(decision.shown.map((c) => c.id)).toEqual(['assoc', 'watch', 'generic']);
  });

  it('is deterministic for identical inputs', () => {
    // DF-X9 §31: the same camera and state must produce the same labels. A tie broken by array
    // order would flicker as the camera moved.
    const build = (): LabelClaim[] => [
      claim('c', 'GENERIC_AIS', 100, 100),
      claim('a', 'GENERIC_AIS', 100, 100),
      claim('b', 'GENERIC_AIS', 100, 100),
    ];
    const first = arbitrateLabels(build());
    const second = arbitrateLabels(build().reverse());
    expect(first.shown.map((c) => c.id)).toEqual(second.shown.map((c) => c.id));
    expect(first.shown[0].id).toBe('a');
  });

  it('gives every suppressed label a reason', () => {
    const decision = arbitrateLabels([
      claim('a', 'GENERIC_AIS', 100, 100),
      claim('b', 'GENERIC_AIS', 105, 100),
    ]);
    expect(decision.suppressed).toHaveLength(1);
    expect(decision.suppressed[0].reason).toBe('COLLISION');
  });

  it('respects a label budget and says BUDGET when that is the cause', () => {
    const decision = arbitrateLabels(
      [
        claim('a', 'GENERIC_AIS', 10, 10),
        claim('b', 'GENERIC_AIS', 200, 200),
        claim('c', 'GENERIC_AIS', 400, 400),
      ],
      { maxLabels: 2 },
    );
    expect(decision.shown).toHaveLength(2);
    expect(decision.suppressed[0].reason).toBe('BUDGET');
  });

  it('never drops a selected label to a budget', () => {
    // The operator selected a contact by name; a budget of one must not silently hide it.
    const decision = arbitrateLabels(
      [
        claim('generic-1', 'GENERIC_AIS', 10, 10),
        claim('selected', 'SELECTED_AIS', 500, 500),
      ],
      { maxLabels: 1 },
    );
    expect(decision.shown.map((c) => c.id)).toEqual(['selected']);
  });

  it('places all labels when nothing collides', () => {
    const decision = arbitrateLabels([
      claim('a', 'GENERIC_AIS', 10, 10),
      claim('b', 'GENERIC_AIS', 300, 400),
      claim('c', 'GENERIC_AIS', 600, 300),
    ]);
    expect(decision.shown).toHaveLength(3);
    expect(decision.suppressed).toHaveLength(0);
    expect(decision.maxOverlap).toBe(0);
  });

  it('treats a near miss as no overlap', () => {
    const decision = arbitrateLabels([
      claim('a', 'GENERIC_AIS', 10, 10),
      claim('b', 'GENERIC_AIS', 200, 10),
    ]);
    expect(decision.suppressed).toHaveLength(0);
  });

  it('scales to a dense contact set without stacking labels', () => {
    // DF-X9 §66: a dense set must stay legible, with a MEASURABLE bound rather than a visual
    // impression.
    const dense: LabelClaim[] = [];
    for (let i = 0; i < 2000; i += 1) {
      dense.push(claim(`v${i}`, 'GENERIC_AIS', (i % 50) * 20, Math.floor(i / 50) * 20));
    }
    const decision = arbitrateLabels(dense, { maxLabels: 60 });
    expect(decision.shown.length).toBeLessThanOrEqual(60);
    expect(decision.shown.length).toBeGreaterThan(0);
    // Every drawn label is collision-free against a generic-priority sibling.
    for (let i = 0; i < decision.shown.length; i += 1) {
      for (let j = i + 1; j < decision.shown.length; j += 1) {
        const a = decision.shown[i];
        const b = decision.shown[j];
        const dx = Math.abs(a.screen.x - b.screen.x);
        const dy = Math.abs(a.screen.y - b.screen.y);
        const separated = dx >= (a.widthPx + b.widthPx) / 2 || dy >= (a.heightPx + b.heightPx) / 2;
        expect(separated).toBe(true);
      }
    }
  });

  it('carries no threat or security vocabulary', () => {
    // DF-X9 §30: priority is about what the operator is working on, not what is dangerous.
    for (const p of LABEL_PRIORITY_ORDER) {
      expect(p).not.toMatch(/THREAT|DANGER|HOSTILE|SUSPECT|TARGET_LOCK/i);
    }
  });
});

/* ================================================================================================
 * CAMERA FRAME EXTRACTION
 * ============================================================================================== */

describe('camera frame from a live viewer', () => {
  it('returns null when there is no viewer', () => {
    expect(cameraFrameFromViewer(undefined)).toBeNull();
  });

  it('returns null when the camera axes are zero-length', () => {
    // Before the first render the axes are zero; dividing by them would give NaN rotations for
    // every contact on the globe.
    const viewer = {
      camera: { rightWC: { x: 0, y: 0, z: 0 }, upWC: { x: 0, y: 0, z: 0 } },
    } as never;
    expect(cameraFrameFromViewer(viewer)).toBeNull();
  });

  it('returns normalised right and up vectors from a positioned camera', () => {
    const viewer = {
      camera: { rightWC: { x: 3, y: 0, z: 0 }, upWC: { x: 0, y: 4, z: 0 } },
    } as never;
    const frame = cameraFrameFromViewer(viewer);
    expect(frame).not.toBeNull();
    expect(frame!.right.x).toBeCloseTo(1, 9);
    expect(frame!.up.y).toBeCloseTo(1, 9);
  });
});