/**
 * DarkFleet camera suite (UI-026).
 *
 * Every command is a Cesium `camera.flyTo` with an explicit easing function, so
 * no preset snaps. The suite is written against the WIRE contract in
 * `src/types/api.ts` (`VesselTarget` with flat `lat`/`lon`/`hdg`/`lenM`), not the
 * legacy `types/darkfleet.ts` shape.
 *
 * The one hard rule: FOLLOWING NEVER WINS OVER THE OPERATOR. `followTarget`
 * marks each programmatic flight, and any camera move the user starts on their
 * own immediately stops the follow. Following resumes only when the operator
 * explicitly engages it again with `followTarget`.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Cartesian3, EasingFunction, Math as CesiumMath, Rectangle, Viewer } from 'cesium';
import type { BoundingBox, SarScene, VesselTarget } from '../types/api.ts';

/** Smooth in-out easing used by every preset. */
export const CAMERA_EASING = EasingFunction.QUADRATIC_IN_OUT;

export interface CameraOptions {
  /** Flight duration in seconds. */
  readonly duration?: number;
  /** Override the easing function (tests may pass a constant). */
  readonly easingFunction?: (fraction: number) => number;
  /** Override the clock; the follow controller uses it to bound its own moves. */
  readonly now?: () => number;
}

export interface CameraDefaults {
  readonly world: number;
  readonly aoi: number;
  readonly scene: number;
  readonly target: number;
  readonly inspect: number;
  readonly preset: number;
}

export const CAMERA_DEFAULTS: CameraDefaults = {
  world: 2.4,
  aoi: 2,
  scene: 2,
  target: 1.5,
  inspect: 1.2,
  preset: 1,
};

/** Altitude the globe sits at for a whole-world view. */
export const WORLD_ALTITUDE_M = 18_000_000;

/** Closest the target camera ever gets, in metres. */
export const TARGET_ALTITUDE_M = 8_500;

/** Altitude for the close inspection pass, in metres. */
export const INSPECT_ALTITUDE_M = 2_800;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Normalise the wire `aoi` array or a bbox tuple; null when unusable. */
export function sceneBbox(value: unknown): BoundingBox | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(finite)) return null;
  const [minLon, minLat, maxLon, maxLat] = value as number[];
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return null;
  if (maxLon < minLon || maxLat < minLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/** Heading in degrees clockwise from north; non-finite falls back to due north. */
function headingRadians(target: { hdg: number }): number {
  return CesiumMath.toRadians(finite(target.hdg) ? target.hdg : 0);
}

/**
 * Frame a bbox that may be sub-metre or span a pole: the height is derived from
 * the angular extent, and a degenerate box still gets a usable altitude.
 */
function altitudeForBbox(bbox: BoundingBox): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonSpan = Math.abs(maxLon - minLon);
  const latSpan = Math.abs(maxLat - minLat);
  const span = Math.max(lonSpan, latSpan, 1e-6);
  return Math.max(1_200, Math.min(30_000_000, span * 6_000_000));
}

function flyOptions(options: CameraOptions | undefined, duration: number): {
  duration: number;
  easingFunction: (fraction: number) => number;
} {
  return {
    duration: finite(options?.duration) ? (options?.duration as number) : duration,
    easingFunction: options?.easingFunction ?? CAMERA_EASING,
  };
}

// --------------------------------------------------------------- presets

/** Whole-globe top-down framing. */
export function flyToWorld(viewer: Viewer, options?: CameraOptions): boolean {
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(100, 15, WORLD_ALTITUDE_M),
    orientation: {
      heading: 0,
      pitch: CesiumMath.toRadians(-90),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.world),
  });
  return true;
}

/** Frame an area of interest. Returns false when the bbox is unusable. */
export function flyToAOI(viewer: Viewer, bbox: BoundingBox, options?: CameraOptions): boolean {
  const box = sceneBbox(bbox);
  if (!box) return false;
  const [minLon, minLat, maxLon, maxLat] = box;
  viewer.camera.flyTo({
    destination: Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat),
    orientation: {
      heading: 0,
      pitch: CesiumMath.toRadians(-70),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.aoi),
  });
  return true;
}

/**
 * Frame a scene. Accepts a `SarScene` (which has no geometry of its own) or
 * anything carrying `aoi`/`bbox`. With no geometry the command does nothing
 * rather than inventing an extent.
 */
export function flyToScene(
  viewer: Viewer,
  scene: SarScene | { aoi?: unknown; bbox?: unknown },
  options?: CameraOptions,
): boolean {
  const candidate = scene as { aoi?: unknown; bbox?: unknown };
  const box = sceneBbox(candidate.bbox) ?? sceneBbox(candidate.aoi);
  if (!box) return false;
  const [minLon, minLat, maxLon, maxLat] = box;
  viewer.camera.flyTo({
    destination: Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat),
    orientation: {
      heading: 0,
      pitch: CesiumMath.toRadians(-65),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.scene),
  });
  return true;
}

/** Standard target framing: pulled back and offset, aligned to the heading. */
export function flyToTarget(viewer: Viewer, target: VesselTarget, options?: CameraOptions): boolean {
  if (!finite(target?.lat) || !finite(target?.lon)) return false;
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(target.lon, target.lat - 0.04, TARGET_ALTITUDE_M),
    orientation: {
      heading: headingRadians(target),
      pitch: CesiumMath.toRadians(-55),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.target),
  });
  return true;
}

/** Close-in inspection pass for evidence work. */
export function inspectTarget(
  viewer: Viewer,
  target: VesselTarget,
  options?: CameraOptions,
): boolean {
  if (!finite(target?.lat) || !finite(target?.lon)) return false;
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(target.lon, target.lat - 0.015, INSPECT_ALTITUDE_M),
    orientation: {
      heading: headingRadians(target),
      pitch: CesiumMath.toRadians(-45),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.inspect),
  });
  return true;
}

/** Orbit to an oblique angle without changing what is on screen. */
export function oblique(viewer: Viewer, options?: CameraOptions): boolean {
  const current = viewer.camera.positionCartographic;
  if (!current) return false;
  const lon = CesiumMath.toDegrees(current.longitude);
  const lat = CesiumMath.toDegrees(current.latitude);
  const height = Math.min(current.height, 45_000);
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat - 0.15, height),
    orientation: {
      heading: viewer.camera.heading,
      pitch: CesiumMath.toRadians(-35),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.preset),
  });
  return true;
}

/** Straight down over the current position. */
export function topDown(viewer: Viewer, options?: CameraOptions): boolean {
  const current = viewer.camera.positionCartographic;
  if (!current) return false;
  const lon = CesiumMath.toDegrees(current.longitude);
  const lat = CesiumMath.toDegrees(current.latitude);
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat, current.height),
    orientation: {
      heading: viewer.camera.heading,
      pitch: CesiumMath.toRadians(-90),
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.preset),
  });
  return true;
}

/** Keep the current footprint but rotate the map so north is up. */
export function northUp(viewer: Viewer, options?: CameraOptions): boolean {
  const current = viewer.camera.positionCartographic;
  if (!current) return false;
  const lon = CesiumMath.toDegrees(current.longitude);
  const lat = CesiumMath.toDegrees(current.latitude);
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat, current.height),
    orientation: {
      heading: 0,
      pitch: viewer.camera.pitch,
      roll: 0,
    },
    ...flyOptions(options, CAMERA_DEFAULTS.preset),
  });
  return true;
}

/** Reset is the whole-globe preset. */
export function reset(viewer: Viewer, options?: CameraOptions): boolean {
  return flyToWorld(viewer, options);
}

// ---------------------------------------------------------------- follow

export interface FollowHandle {
  readonly targetId: string;
  /** True while the follow is engaged and still driving the camera. */
  isActive(): boolean;
  /** False once the operator navigated; the follow then needs re-engaging. */
  isEngaged(): boolean;
  /** Re-aim at a moved target. Ignored when the follow is no longer engaged. */
  updateTarget(target: VesselTarget): void;
  /** Stop following and release the controller. Safe to call repeatedly. */
  stop(): void;
}

export interface FollowOptions extends CameraOptions {
  /** Re-aim interval in ms. 0 disables the timer (aim once on engage). */
  readonly tickMs?: number;
  /** Injectable timers, so tests never wait on real time. */
  readonly setTimer?: (handler: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Grace window that lets our own flight register as "ours" on moveStart. */
export const FOLLOW_MOVE_GRACE_MS = 250;

interface FollowEvent {
  addEventListener(handler: () => void): () => void;
  removeEventListener(handler: () => void): void;
}

/** One follow per viewer; `releaseTarget` needs to find it again. */
const follows = new WeakMap<object, FollowHandle>();

function cameraEvent(camera: unknown, key: 'moveStart' | 'moveEnd'): FollowEvent | null {
  if (!camera || typeof camera !== 'object') return null;
  const event = (camera as Record<string, unknown>)[key];
  if (
    event &&
    typeof (event as FollowEvent).addEventListener === 'function' &&
    typeof (event as FollowEvent).removeEventListener === 'function'
  ) {
    return event as FollowEvent;
  }
  return null;
}

/**
 * Follow a target until the operator touches the camera.
 *
 * The controller never forces a move: each re-aim opens a short grace window in
 * which `moveStart` is understood as our own flight. A move started outside that
 * window is the operator, and it stops the follow immediately.
 */
export function followTarget(
  viewer: Viewer,
  target: VesselTarget,
  options: FollowOptions = {},
): FollowHandle | null {
  if (!finite(target?.lat) || !finite(target?.lon)) return null;
  // A second engagement replaces the first: no stacked controllers.
  follows.get(viewer as unknown as object)?.stop();

  const now = options.now ?? Date.now;
  const duration = finite(options.duration) ? (options.duration as number) : 0.4;
  const tickMs = finite(options.tickMs) ? (options.tickMs as number) : 1000;
  const setTimer =
    options.setTimer ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  const moveStart = cameraEvent(viewer.camera, 'moveStart');
  const moveEnd = cameraEvent(viewer.camera, 'moveEnd');

  let engaged = true;
  let timer: unknown = null;
  let current: VesselTarget = target;
  let graceUntil = 0;
  let lastLat = target.lat;
  let lastLon = target.lon;

  const removeMoveStart = moveStart
    ? moveStart.addEventListener(() => {
        if (!engaged) return;
        if (now() <= graceUntil) return; // our own flight
        engaged = false;
        stopTimer();
        handle.stop();
      })
    : () => undefined;
  const removeMoveEnd = moveEnd
    ? moveEnd.addEventListener(() => {
        graceUntil = 0;
      })
    : () => undefined;

  function stopTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  const handle: FollowHandle = {
    targetId: target.id,
    isActive: () => engaged,
    isEngaged: () => engaged,
    updateTarget: (next: VesselTarget) => {
      current = next;
      if (!engaged || !finite(next?.lat) || !finite(next?.lon)) return;
      lastLat = next.lat;
      lastLon = next.lon;
      aim();
    },
    stop: () => {
      if (!engaged && timer === null) {
        follows.delete(viewer as unknown as object);
        return;
      }
      engaged = false;
      stopTimer();
      removeMoveStart();
      removeMoveEnd();
      follows.delete(viewer as unknown as object);
    },
  };

  function aim(): void {
    graceUntil = now() + duration * 1000 + FOLLOW_MOVE_GRACE_MS;
    flyToTarget(viewer, current, { ...options, duration });
  }

  function tick(): void {
    if (!engaged) return;
    if (current.lat === lastLat && current.lon === lastLon) return;
    lastLat = current.lat;
    lastLon = current.lon;
    aim();
  }

  aim();
  if (tickMs > 0) {
    timer = setTimer(tick, tickMs);
  }
  follows.set(viewer as unknown as object, handle);
  return handle;
}

/** True while a follow is engaged for this viewer. */
export function isFollowing(viewer: Viewer): boolean {
  const handle = follows.get(viewer as unknown as object);
  return Boolean(handle && handle.isEngaged());
}

/** The active follow handle for a viewer, if any. */
export function followHandle(viewer: Viewer): FollowHandle | null {
  return follows.get(viewer as unknown as object) ?? null;
}

/**
 * Stop following and pull back. Without an AOI the camera returns to the
 * straight-down preset; nothing is invented about what is off-screen.
 */
export function releaseTarget(
  viewer: Viewer,
  bbox?: BoundingBox | null,
  options?: CameraOptions,
): boolean {
  follows.get(viewer as unknown as object)?.stop();
  if (bbox) return flyToAOI(viewer, bbox, options);
  return topDown(viewer, options);
}

// -------------------------------------------- legacy command-name aliases

/** Alias kept for the shell's existing `setTopDown` call sites. */
export const setTopDown = topDown;

/** Alias kept for the shell's existing `setOrbit` call sites. */
export const setOrbit = oblique;

/** Alias kept for the shell's existing `resetGlobe` call sites. */
export const resetGlobe = reset;

/** Altitude helper exported for the shell's altitude readout. */
export function altitudeForArea(bbox: BoundingBox): number {
  return altitudeForBbox(sceneBbox(bbox) ?? bbox);
}