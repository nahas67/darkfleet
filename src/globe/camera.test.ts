/**
 * Camera suite tests (UI-026).
 *
 * Two rules get the most attention here:
 *  1. every command issues exactly the Cesium call it promises, with easing, and
 *  2. FOLLOWING NEVER OVERRIDES THE OPERATOR — the first user-initiated camera
 *     move stops the follow, and only a fresh `followTarget` restarts it.
 *
 * A fake Viewer records `camera.flyTo` calls; `camera.moveStart` / `moveEnd` are
 * raised by the test to simulate Cesium's camera events. No WebGL, no network.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Cartesian3, Cartographic, EasingFunction, Rectangle } from 'cesium';
import type { Viewer } from 'cesium';
import {
  CAMERA_DEFAULTS,
  FOLLOW_MOVE_GRACE_MS,
  altitudeForArea,
  flyToAOI,
  flyToScene,
  flyToTarget,
  flyToWorld,
  followHandle,
  followTarget,
  inspectTarget,
  isFollowing,
  northUp,
  oblique,
  releaseTarget,
  reset,
  sceneBbox,
  setOrbit,
  setTopDown,
  topDown,
} from './camera.ts';
import type { BoundingBox, SarScene, VesselTarget } from '../types/api.ts';

// ------------------------------------------------------------------- fakes

class FakeEvent {
  private handlers = new Set<() => void>();
  addEventListener(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  removeEventListener(handler: () => void): void {
    this.handlers.delete(handler);
  }
  raise(): void {
    for (const handler of [...this.handlers]) handler();
  }
  get listenerCount(): number {
    return this.handlers.size;
  }
}

interface FlyCall {
  destination: unknown;
  orientation: { heading: number; pitch: number; roll: number };
  duration: number;
  easingFunction: unknown;
}

interface FakeViewer {
  camera: {
    flyTo(options: FlyCall): void;
    positionCartographic: Cartographic;
    heading: number;
    pitch: number;
    moveStart: FakeEvent;
    moveEnd: FakeEvent;
  };
  calls: FlyCall[];
}

function fakeViewer(latDeg = 1.2644, lonDeg = 103.84, height = 20_000): FakeViewer {
  const calls: FlyCall[] = [];
  return {
    calls,
    camera: {
      flyTo(options: FlyCall) {
        calls.push(options);
      },
      positionCartographic: Cartographic.fromDegrees(lonDeg, latDeg, height),
      heading: 0.5,
      pitch: -1.1,
      moveStart: new FakeEvent(),
      moveEnd: new FakeEvent(),
    },
  };
}

function asViewer(viewer: FakeViewer): Viewer {
  return viewer as unknown as Viewer;
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function target(overrides: Partial<VesselTarget> = {}): VesselTarget {
  return {
    id: 'DF-T01',
    classification: 'SAR_MATCHED_AIS',
    lat: 1.2644,
    lon: 103.84,
    sarConf: 0.91,
    aisConf: 0.83,
    lenM: 88,
    widM: 12,
    lenUncM: 6,
    hdg: 90,
    wake: false,
    meanDb: -14,
    maxDb: 3.2,
    area: 41,
    corr: {
      matched: true,
      mmsi: '563000111',
      vesselName: 'STELLAR',
      distanceOffsetMeters: 120,
      timeDeltaSeconds: 90,
      predictedLat: 1.2651,
      predictedLon: 103.8422,
      aisAssociationConfidence: 0.83,
      scoreDecomposition: null,
    },
    assessment: '',
    tags: [],
    ...overrides,
  };
}

const AOI: BoundingBox = [103.7, 1.2, 103.95, 1.35];

const SCENE: SarScene = {
  provider: 'pc',
  collection: 'sentinel-1-grd',
  item_id: 'S1A_IW_GRDH_1SDV_20260201T0000',
  platform: 'Sentinel-1A',
  acquisition_time: '2026-02-01T00:00:00Z',
  product: 'GRD',
  polarization: 'VV',
  asset_href: '/api/debug/DF-0001/raw.png',
  crs: 'EPSG:4326',
  resolution_m: 10,
};

// ------------------------------------------------------------------- tests

describe('sceneBbox', () => {
  it('accepts a well-formed tuple or aoi array and rejects the rest', () => {
    expect(sceneBbox([103.7, 1.2, 103.95, 1.35])).toEqual(AOI);
    expect(sceneBbox([103.7, 1.2])).toBeNull();
    expect(sceneBbox([103.95, 1.2, 103.7, 1.35])).toBeNull();
    expect(sceneBbox([103.7, 1.2, 103.95, 200])).toBeNull();
    expect(sceneBbox('nope')).toBeNull();
    expect(sceneBbox([Number.NaN, 1, 2, 3])).toBeNull();
  });
});

describe('presets', () => {
  it('flyToWorld frames the globe top-down with easing', () => {
    const viewer = fakeViewer();
    expect(flyToWorld(asViewer(viewer))).toBe(true);
    expect(viewer.calls).toHaveLength(1);
    const call = viewer.calls[0];
    expect(call.duration).toBe(CAMERA_DEFAULTS.world);
    const easing = call.easingFunction as (fraction: number) => number;
    expect(easing).toBe(EasingFunction.QUADRATIC_IN_OUT);
    expect(easing(0.5)).toBeCloseTo(EasingFunction.QUADRATIC_IN_OUT(0.5), 9);
    expect(degrees(call.orientation.pitch)).toBe(-90);
    expect(call.orientation.heading).toBe(0);
    const geo = Cartographic.fromCartesian(call.destination as Cartesian3);
    expect(degrees(geo.longitude)).toBeCloseTo(100, 6);
    expect(degrees(geo.latitude)).toBeCloseTo(15, 6);
    expect(geo.height).toBe(18_000_000);
  });

  it('reset is the whole-globe preset and keeps its aliases wired', () => {
    const viewer = fakeViewer();
    reset(asViewer(viewer));
    expect(viewer.calls).toHaveLength(1);
    expect(viewer.calls[0].duration).toBe(CAMERA_DEFAULTS.world);
    setTopDown(asViewer(viewer));
    setOrbit(asViewer(viewer));
    expect(viewer.calls).toHaveLength(3);
  });

  it('flyToAOI frames a rectangle and refuses a malformed box', () => {
    const viewer = fakeViewer();
    expect(flyToAOI(asViewer(viewer), AOI)).toBe(true);
    expect(viewer.calls[0].destination).toBeInstanceOf(Rectangle);
    expect(degrees(viewer.calls[0].orientation.pitch)).toBe(-70);
    expect(flyToAOI(asViewer(viewer), [9, 9, 1, 1] as unknown as BoundingBox)).toBe(false);
    expect(viewer.calls).toHaveLength(1);
  });

  it('flyToScene uses the AOI the backend sent and invents nothing without one', () => {
    const viewer = fakeViewer();
    expect(flyToScene(asViewer(viewer), { ...SCENE, aoi: AOI })).toBe(true);
    expect(viewer.calls[0].destination).toBeInstanceOf(Rectangle);
    // A bare SarScene carries no geometry: no flight, no invented extent.
    expect(flyToScene(asViewer(viewer), SCENE)).toBe(false);
    expect(viewer.calls).toHaveLength(1);
  });

  it('flyToTarget aligns the heading with the backend heading', () => {
    const viewer = fakeViewer();
    expect(flyToTarget(asViewer(viewer), target({ hdg: 90 }))).toBe(true);
    const call = viewer.calls[0];
    expect(degrees(call.orientation.heading)).toBeCloseTo(90, 6);
    expect(degrees(call.orientation.pitch)).toBe(-55);
    expect(call.duration).toBe(CAMERA_DEFAULTS.target);
    const destination = call.destination as Cartesian3;
    const geo = Cartographic.fromCartesian(destination);
    expect(degrees(geo.longitude)).toBeCloseTo(103.84, 6);
    expect(degrees(geo.latitude)).toBeCloseTo(1.2644 - 0.04, 6);
    expect(geo.height).toBeCloseTo(8_500, 3);
  });

  it('a target with a non-finite position never flies the camera', () => {
    const viewer = fakeViewer();
    expect(flyToTarget(asViewer(viewer), target({ lat: Number.NaN }))).toBe(false);
    expect(inspectTarget(asViewer(viewer), { lon: Number.NaN } as VesselTarget)).toBe(false);
    expect(viewer.calls).toHaveLength(0);
  });

  it('inspectTarget is closer and steeper than flyToTarget', () => {
    const viewer = fakeViewer();
    flyToTarget(asViewer(viewer), target());
    inspectTarget(asViewer(viewer), target());
    const focus = Cartographic.fromCartesian(viewer.calls[0].destination as Cartesian3);
    const inspect = Cartographic.fromCartesian(viewer.calls[1].destination as Cartesian3);
    expect(inspect.height).toBeLessThan(focus.height);
    expect(inspect.height).toBeCloseTo(2_800, 3);
    expect(degrees(viewer.calls[1].orientation.pitch)).toBe(-45);
    expect(viewer.calls[1].duration).toBe(CAMERA_DEFAULTS.inspect);
  });

  it('orientation presets keep the current footprint', () => {
    const viewer = fakeViewer(1.2644, 103.84, 90_000);
    expect(topDown(asViewer(viewer))).toBe(true);
    expect(degrees(viewer.calls[0].orientation.pitch)).toBe(-90);
    expect(viewer.calls[0].destination).toBeInstanceOf(Cartesian3);

    const north = fakeViewer();
    expect(northUp(asViewer(north))).toBe(true);
    expect(north.calls[0].orientation.heading).toBe(0);
    expect(north.calls[0].orientation.pitch).toBe(-1.1);

    const orb = fakeViewer(1.2644, 103.84, 90_000);
    expect(oblique(asViewer(orb))).toBe(true);
    expect(degrees(orb.calls[0].orientation.pitch)).toBe(-35);
    // oblique clamps a 90 km standoff down to 45 km.
    expect(
      Cartographic.fromCartesian(orb.calls[0].destination as Cartesian3).height,
    ).toBeCloseTo(45_000, 3);
  });

  it('altitudeForArea scales with the framed extent', () => {
    expect(altitudeForArea(AOI)).toBeGreaterThan(1_000);
    expect(altitudeForArea([0, 0, 0.001, 0.001])).toBeLessThan(altitudeForArea(AOI));
  });

  it('honours a caller-supplied duration and easing function', () => {
    const viewer = fakeViewer();
    const easing = (fraction: number): number => fraction;
    flyToWorld(asViewer(viewer), { duration: 0.25, easingFunction: easing });
    expect(viewer.calls[0].duration).toBe(0.25);
    expect(viewer.calls[0].easingFunction).toBe(easing);
  });
});

describe('followTarget', () => {
  it('engages, aims once, and reports itself active', () => {
    const viewer = fakeViewer();
    const handle = followTarget(asViewer(viewer), target(), { tickMs: 0 });
    expect(handle).not.toBeNull();
    expect(handle!.isActive()).toBe(true);
    expect(isFollowing(asViewer(viewer))).toBe(true);
    expect(followHandle(asViewer(viewer))).toBe(handle);
    expect(viewer.calls).toHaveLength(1);
    expect(viewer.calls[0].duration).toBe(0.4);
    handle!.stop();
    expect(isFollowing(asViewer(viewer))).toBe(false);
  });

  it('ignores the moveStart raised by its own flight', () => {
    const viewer = fakeViewer();
    const handle = followTarget(asViewer(viewer), target(), { tickMs: 0 })!;
    viewer.camera.moveStart.raise();
    expect(handle.isEngaged()).toBe(true);
  });

  it('STOPS as soon as the operator moves the camera', () => {
    let now = 0;
    const viewer = fakeViewer();
    const handle = followTarget(asViewer(viewer), target(), {
      tickMs: 1000,
      now: () => now,
    })!;
    // Our own flight finishes, then the operator drags.
    now = 10_000;
    viewer.camera.moveEnd.raise();
    viewer.camera.moveStart.raise();
    expect(handle.isEngaged()).toBe(false);
    expect(handle.isActive()).toBe(false);
    expect(isFollowing(asViewer(viewer))).toBe(false);
    // The camera is never moved again by the dead controller.
    const before = viewer.calls.length;
    viewer.camera.moveStart.raise();
    expect(viewer.calls).toHaveLength(before);
  });

  it('stops the follow without needing moveEnd when the grace window has passed', () => {
    let now = 0;
    const viewer = fakeViewer();
    const handle = followTarget(asViewer(viewer), target(), {
      tickMs: 0,
      now: () => now,
      duration: 0.4,
    })!;
    now = 0.4 * 1000 + FOLLOW_MOVE_GRACE_MS + 1;
    viewer.camera.moveStart.raise();
    expect(handle.isEngaged()).toBe(false);
  });

  it('re-engages only when the operator asks again', () => {
    let now = 0;
    const viewer = fakeViewer();
    const first = followTarget(asViewer(viewer), target(), { tickMs: 0, now: () => now })!;
    now = 10_000;
    viewer.camera.moveEnd.raise();
    viewer.camera.moveStart.raise();
    expect(first.isEngaged()).toBe(false);
    const second = followTarget(asViewer(viewer), target({ id: 'DF-T02' }), {
      tickMs: 0,
      now: () => now,
    })!;
    expect(second.isEngaged()).toBe(true);
    expect(second.targetId).toBe('DF-T02');
    second.stop();
  });

  it('a second engagement replaces the first controller', () => {
    let now = 0;
    const viewer = fakeViewer();
    const first = followTarget(asViewer(viewer), target(), { tickMs: 0, now: () => now })!;
    const second = followTarget(asViewer(viewer), target(), { tickMs: 0, now: () => now })!;
    expect(first.isEngaged()).toBe(false);
    expect(second.isEngaged()).toBe(true);
    expect(viewer.camera.moveStart.listenerCount).toBe(1);
    second.stop();
    expect(viewer.camera.moveStart.listenerCount).toBe(0);
  });

  it('re-aims only when the target actually moved', () => {
    let now = 0;
    const viewer = fakeViewer();
    const ticks: Array<() => void> = [];
    const handle = followTarget(asViewer(viewer), target(), {
      now: () => now,
      setTimer: (handler) => {
        ticks.push(handler);
        return ticks.length;
      },
      clearTimer: () => undefined,
    })!;
    expect(viewer.calls).toHaveLength(1);
    ticks[0]();
    expect(viewer.calls).toHaveLength(1);
    handle.updateTarget(target({ lat: 1.3, lon: 103.9 }));
    expect(viewer.calls).toHaveLength(2);
    ticks[0]();
    expect(viewer.calls).toHaveLength(2);
    handle.stop();
  });

  it('a dead controller never aims again', () => {
    let now = 0;
    const viewer = fakeViewer();
    const ticks: Array<() => void> = [];
    const handle = followTarget(asViewer(viewer), target(), {
      now: () => now,
      setTimer: (handler) => {
        ticks.push(handler);
        return ticks.length;
      },
      clearTimer: () => undefined,
    })!;
    now = 10_000;
    viewer.camera.moveEnd.raise();
    viewer.camera.moveStart.raise();
    handle.updateTarget(target({ lat: 1.3 }));
    ticks[0]();
    expect(viewer.calls).toHaveLength(1);
  });

  it('refuses a target with no position', () => {
    const viewer = fakeViewer();
    expect(followTarget(asViewer(viewer), target({ lon: Number.NaN }))).toBeNull();
    expect(viewer.calls).toHaveLength(0);
  });

  it('stop is idempotent', () => {
    const viewer = fakeViewer();
    const handle = followTarget(asViewer(viewer), target(), { tickMs: 0 })!;
    handle.stop();
    handle.stop();
    expect(isFollowing(asViewer(viewer))).toBe(false);
    expect(viewer.camera.moveStart.listenerCount).toBe(0);
  });
});

describe('releaseTarget', () => {
  it('stops the follow and pulls back top-down', () => {
    let now = 0;
    const viewer = fakeViewer();
    const handle = followTarget(asViewer(viewer), target(), { tickMs: 0, now: () => now })!;
    expect(releaseTarget(asViewer(viewer))).toBe(true);
    expect(handle.isEngaged()).toBe(false);
    expect(degrees(viewer.calls[viewer.calls.length - 1].orientation.pitch)).toBe(-90);
  });

  it('returns to the supplied AOI when the caller has one', () => {
    const viewer = fakeViewer();
    expect(releaseTarget(asViewer(viewer), AOI)).toBe(true);
    expect(viewer.calls[viewer.calls.length - 1].destination).toBeInstanceOf(Rectangle);
    expect(isFollowing(asViewer(viewer))).toBe(false);
  });
});