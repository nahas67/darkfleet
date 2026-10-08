/**
 * AIS CAMERA OWNER tests (DF-X9.6 sections 20-45, 53-59).
 *
 * The single `AisCameraController` owns every follow/frame behaviour. These tests prove the
 * contract against FAKE camera/store ports, so no WebGL context is needed:
 *
 *   - offset retention is pure vector arithmetic on the RETAINED camera offset;
 *   - follow tracks the contact DISPLAY position only (never a predicted marker, never a
 *     remembered position);
 *   - manual camera motion releases FOLLOW, while the controller's own writes never self-cancel;
 *   - switching contacts retargets, and a removed contact or a switched-off layer releases;
 *   - listener counts return to baseline over on/off cycles, switches and clear.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AisCameraController,
  applyOffset,
  offsetBetween,
  planFrameTrack,
  resolveFollowStatus,
  type AisCameraCameraPort,
  type AisCameraStorePort,
  type CameraPose,
  type FollowMode,
  type LatLon,
  type Vec3,
} from './aisCamera';

/* ------------------------------------------------------------------ fakes */

const A_POS: LatLon = { lat: 1.0, lon: 103.0 };
const B_POS: LatLon = { lat: 2.5, lon: 104.5 };

function makeCamera(): {
  port: AisCameraCameraPort;
  calls: string[];
  positions: Map<string, LatLon>;
  predicted: Map<string, LatLon>;
  fireMoveStart: () => void;
  fireMoveEnd: () => void;
  fireInput: () => void;
  getPose: () => CameraPose;
  /**
   * One render frame, as Cesium's loop performs it: raise moveStart the first time the camera
   * is seen to have CHANGED, then moveEnd once it settles.
   *
   * `startFired` mirrors Cesium's `_cameraStartFired` latch, which is why a camera that changes
   * on every frame raises moveStart once, not once per frame. Modelling the latch matters: an
   * un-latched double would fire moveStart every render and hide a different class of bug.
   */
  flushRender: () => void;
} {
  const calls: string[] = [];
  let pendingMove = false;
  let startFired = false;
  const positions = new Map<string, LatLon>([['A', A_POS]]);
  // Predicted markers exist in the product but the controller must never read them: the port
  // exposes no predicted accessor at all, and this map proves the fake HAS a different
  // analytical position the controller cannot reach.
  const predicted = new Map<string, LatLon>([['A', { lat: 9.9, lon: 109.9 }]]);
  let pose: CameraPose = {
    position: { x: 103.0, y: 1.0, z: 1000 },
    orientation: { heading: 0, pitch: -1.0, roll: 0 },
  };
  const moveStartCbs = new Set<() => void>();
  const moveEndCbs = new Set<() => void>();
  // Press-level input is a SEPARATE channel from camera motion: programmatic camera writes
  // raise moveStart/moveEnd but never input events, which is exactly why the input release
  // path needs no guard. Conflating the two here would make every own flight self-cancel.
  const inputCbs = new Set<() => void>();
  const equirect = (p: LatLon): Vec3 => ({ x: p.lon, y: p.lat, z: 0 });
  const port: AisCameraCameraPort = {
    displayPositionOf: (mmsi) => {
      calls.push('displayPositionOf');
      return positions.get(mmsi) ?? null;
    },
    getCameraPose: () => {
      calls.push('getCameraPose');
      return pose;
    },
    cartesianOf: (p) => {
      calls.push('cartesianOf');
      return equirect(p);
    },
    setView: (next) => {
      calls.push('setView');
      pose = next;
      // FAITHFUL TO CESIUM (DF-X9.8B). A setView does NOT raise moveStart. The single
      // `moveStart.raiseEvent` in the shipped Cesium bundle lives in
      // `View.checkForCameraUpdates`, which the RENDER LOOP calls on a later frame. An earlier
      // revision of this double raised moveStart/moveEnd synchronously here, which is not what
      // Cesium does -- and that wrong emulation is precisely why the real
      // "follow cancels itself the moment the camera moves" defect survived 82 passing tests.
      // `flushRender()` below is the render loop; tests drive it explicitly.
      pendingMove = true;
      startFired = false;
    },
    flyTo: () => {
      calls.push('flyTo');
      for (const cb of [...moveStartCbs]) cb();
    },
    onMoveStart: (cb) => {
      calls.push('onMoveStart');
      moveStartCbs.add(cb);
      return () => {
        moveStartCbs.delete(cb);
      };
    },
    onMoveEnd: (cb) => {
      calls.push('onMoveEnd');
      moveEndCbs.add(cb);
      return () => {
        moveEndCbs.delete(cb);
      };
    },
    onUserInput: (cb) => {
      calls.push('onUserInput');
      inputCbs.add(cb);
      return () => {
        inputCbs.delete(cb);
      };
    },
  };
  return {
    port,
    calls,
    positions,
    predicted,
    fireMoveStart: () => {
      for (const cb of [...moveStartCbs]) cb();
    },
    fireInput: () => {
      for (const cb of [...inputCbs]) cb();
    },
    fireMoveEnd: () => {
      for (const cb of [...moveEndCbs]) cb();
    },
    getPose: () => pose,
    flushRender: () => {
      if (pendingMove && !startFired) {
        startFired = true;
        for (const cb of [...moveStartCbs]) cb();
        // Still moving, so no moveEnd yet -- the camera has not settled.
        return;
      }
      if (pendingMove) {
        pendingMove = false;
        for (const cb of [...moveEndCbs]) cb();
      }
    },
  };
}

function makeStore(): {
  port: AisCameraStorePort;
  selectedMmsi: { value: string | null };
  mode: { value: FollowMode };
  visible: { value: boolean };
  known: Set<string>;
  subscribes: { count: number };
  unsubscribes: { count: number };
  fire: () => void;
} {
  const selectedMmsi = { value: null as string | null };
  const mode = { value: 'OFF' as FollowMode };
  const visible = { value: true };
  const known = new Set<string>(['A', 'B']);
  const subscribes = { count: 0 };
  const unsubscribes = { count: 0 };
  const listeners = new Set<() => void>();
  const port: AisCameraStorePort = {
    getSelectedMmsi: () => selectedMmsi.value,
    getFollowMode: () => mode.value,
    setFollowMode: (m) => {
      mode.value = m;
    },
    isContactsVisible: () => visible.value,
    contactKnown: (mmsi) => known.has(mmsi),
    subscribe: (cb) => {
      subscribes.count += 1;
      listeners.add(cb);
      return () => {
        unsubscribes.count += 1;
        listeners.delete(cb);
      };
    },
  };
  return {
    port,
    selectedMmsi,
    mode,
    visible,
    known,
    subscribes,
    unsubscribes,
    fire: () => {
      for (const cb of [...listeners]) cb();
    },
  };
}

function wired(): {
  controller: AisCameraController;
  camera: ReturnType<typeof makeCamera>;
  store: ReturnType<typeof makeStore>;
} {
  const camera = makeCamera();
  const store = makeStore();
  const controller = new AisCameraController(camera.port, store.port);
  return { controller, camera, store };
}

/* ================================================================================================
 * PURE OFFSET MATH
 * ============================================================================================== */

describe('offset retention math', () => {
  it('round-trips: applying a captured offset at a new target preserves the relative view', () => {
    const cam: Vec3 = { x: 10, y: 20, z: 30 };
    const target: Vec3 = { x: 1, y: 2, z: 3 };
    const offset = offsetBetween(cam, target);
    expect(offset).toEqual({ x: 9, y: 18, z: 27 });
    const moved: Vec3 = { x: 11, y: 12, z: 3 };
    // The camera rides WITH the target: same displacement, no re-aiming, no rescaling.
    expect(applyOffset(moved, offset)).toEqual({ x: 20, y: 30, z: 30 });
  });

  it('a zero offset keeps the camera exactly over the target', () => {
    const target: Vec3 = { x: 5, y: 5, z: 5 };
    expect(applyOffset(target, offsetBetween(target, target))).toEqual(target);
  });
});

/* ================================================================================================
 * FOLLOW AVAILABILITY (pure planner)
 * ============================================================================================== */

describe('resolveFollowStatus', () => {
  const base = {
    mode: 'FOLLOW' as FollowMode,
    selectedMmsi: 'A',
    contactsVisible: true,
    contactKnown: true,
    hasPosition: true,
    displayState: 'OBSERVED',
    inGap: false,
    isAfterLast: false,
  };

  it('tracks an observed display position', () => {
    const step = resolveFollowStatus(base);
    expect(step.action).toBe('TRACK');
    expect(step.label).toBe('TRACKING');
  });

  it('tracks through an interpolation interval at the display position', () => {
    const step = resolveFollowStatus({ ...base, displayState: 'INTERPOLATED_DISPLAY' });
    expect(step.action).toBe('TRACK');
    expect(step.label).toBe('TRACKING');
  });

  it('suspends when there is no drawn position, and never falls back to a remembered one', () => {
    const step = resolveFollowStatus({ ...base, hasPosition: false, displayState: 'NOT_YET_OBSERVED' });
    expect(step.action).toBe('SUSPEND');
    expect(step.label).toBe('SUSPENDED');
    expect(step.useRememberedPosition).toBe(false);
  });

  it('holds the displayed position through a gap with the GAP state shown', () => {
    const step = resolveFollowStatus({ ...base, inGap: true });
    expect(step.action).toBe('TRACK');
    expect(step.label).toBe('HOLD_GAP');
  });

  it('holds the final position after the last observation with no motion implied', () => {
    const step = resolveFollowStatus({ ...base, isAfterLast: true, displayState: 'STALE' });
    expect(step.action).toBe('TRACK');
    expect(step.label).toBe('HOLD_FINAL');
  });

  it('releases when the layer is off, the contact is gone, or nothing is selected', () => {
    expect(resolveFollowStatus({ ...base, contactsVisible: false }).action).toBe('RELEASE');
    expect(resolveFollowStatus({ ...base, contactKnown: false }).action).toBe('RELEASE');
    expect(
      resolveFollowStatus({ ...base, selectedMmsi: null }).action,
    ).toBe('RELEASE');
  });

  it('is idle when the mode is OFF', () => {
    expect(resolveFollowStatus({ ...base, mode: 'OFF' }).action).toBe('IDLE');
  });
});

/* ================================================================================================
 * FRAME TRACK plans (whole-globe zoom is forbidden)
 * ============================================================================================== */

describe('frame track plans', () => {
  it('frames a normal track tightly', () => {
    const plan = planFrameTrack({
      points: [
        { lat: 1.0, lon: 103.0 },
        { lat: 1.4, lon: 103.6 },
      ],
    });
    expect(plan).not.toBeNull();
    expect(plan!.wrapped).toBe(false);
    expect(plan!.halfWidthDeg).toBeLessThan(5);
    expect(plan!.halfHeightDeg).toBeLessThan(5);
  });

  it('frames an antimeridian track on its short extent, never the whole globe', () => {
    const plan = planFrameTrack({
      points: [
        { lat: 10.0, lon: 179.8 },
        { lat: 10.1, lon: -179.9 },
      ],
    });
    expect(plan).not.toBeNull();
    expect(plan!.wrapped).toBe(true);
    // A 0.3-degree crossing framed as 359 degrees is the defect; the short extent is ~0.3.
    expect(plan!.halfWidthDeg).toBeLessThan(2);
  });

  it('never frames the whole globe at high latitude either', () => {
    const plan = planFrameTrack({
      points: [
        { lat: 78.0, lon: -40.0 },
        { lat: 80.0, lon: 60.0 },
      ],
    });
    expect(plan).not.toBeNull();
    expect(plan!.halfWidthDeg).toBeLessThan(180);
    expect(plan!.halfHeightDeg).toBeLessThan(90);
  });

  it('gives a single fix a usable non-degenerate extent', () => {
    const plan = planFrameTrack({ points: [{ lat: 1.0, lon: 103.0 }] });
    expect(plan).not.toBeNull();
    expect(plan!.halfWidthDeg).toBeGreaterThan(0);
    expect(plan!.halfHeightDeg).toBeGreaterThan(0);
  });

  it('returns null for no usable points rather than framing the globe by default', () => {
    expect(planFrameTrack({ points: [] })).toBeNull();
  });
});

/* ================================================================================================
 * CONTROLLER: no own clock
 * ============================================================================================== */

describe('controller owns no clock', () => {
  it('creates no timer, animation frame or worker of its own', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'aisCamera.ts'), 'utf8');
    for (const forbidden of [
      'setInterval',
      'setTimeout',
      'requestAnimationFrame',
      'new Worker',
      'viewer.clock',
    ]) {
      expect(source, `aisCamera.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* ================================================================================================
 * CONTROLLER: follow behaviour on fakes
 * ============================================================================================== */

describe('follow on fake ports', () => {
  it('moves per tick with setView, never with an animated flyTo', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    camera.calls.length = 0;
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    expect(camera.calls).toContain('setView');
    expect(camera.calls).not.toContain('flyTo');
    expect(store.mode.value).toBe('FOLLOW');
    expect(controller.status.label).toBe('TRACKING');
  });

  it('follows the contact display position, never the predicted marker', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    const pose = camera.getPose();
    // cartesianOf maps lon->x, lat->y in the fake: the anchor must be A_POS, not the
    // far-away predicted fix at (9.9, 109.9).
    const predictedX = 109.9;
    expect(pose.position.x).not.toBeCloseTo(predictedX, 6);
    expect(camera.positions.get('A')).toEqual(A_POS);
  });

  it('suspends with no glyph and never uses a remembered position', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    const held = camera.getPose().position;
    camera.positions.delete('A');
    camera.calls.length = 0;
    controller.tick({ displayState: 'NOT_YET_OBSERVED', inGap: false, isAfterLast: false });
    expect(camera.calls).not.toContain('setView');
    expect(camera.getPose().position).toEqual(held);
    expect(controller.status.label).toBe('SUSPENDED');
    expect(store.mode.value).toBe('FOLLOW');
  });

  it('holds the final position with no repeated motion once the anchor stops moving', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'STALE', inGap: false, isAfterLast: true });
    expect(controller.status.label).toBe('HOLD_FINAL');
    camera.calls.length = 0;
    controller.tick({ displayState: 'STALE', inGap: false, isAfterLast: true });
    // Same anchor: no further camera write. Holding final means no motion.
    expect(camera.calls).not.toContain('setView');
  });

  it('holds through a gap at the displayed position with the GAP state shown', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: true, isAfterLast: false });
    expect(camera.calls).toContain('setView');
    expect(controller.status.label).toBe('HOLD_GAP');
  });

  it('retargets from A to B when the selection changes while following', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    camera.positions.set('B', B_POS);
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    const atA = camera.getPose().position;
    store.selectedMmsi.value = 'B';
    store.fire();
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    const atB = camera.getPose().position;
    // Same retained offset, new anchor: the camera rides by exactly the anchor delta.
    expect(atB.x - atA.x).toBeCloseTo(B_POS.lon - A_POS.lon, 9);
    expect(atB.y - atA.y).toBeCloseTo(B_POS.lat - A_POS.lat, 9);
    expect(store.mode.value).toBe('FOLLOW');
    expect(controller.status.mmsi).toBe('B');
  });
});

/* ================================================================================================
 * CONTROLLER: status latching across unrelated store writes (S58 defect)
 * ============================================================================================== */

describe('status latching', () => {
  it('an unrelated store write keeps the latched HOLD_GAP instead of resetting to TRACKING', () => {
    // Live defect: ANY store write (camera-altitude telemetry from zoom inertia,
    // cursor moves) refreshed status with an EMPTY context, so HOLD_GAP flipped
    // to TRACKING 1.5 s after the tick proved the gap. The camera held correctly;
    // only the label lied.
    const { controller, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: true, isAfterLast: false });
    expect(controller.status.label).toBe('HOLD_GAP');
    store.fire();
    expect(controller.status.label).toBe('HOLD_GAP');
  });

  it('an unrelated store write keeps the latched HOLD_FINAL', () => {
    const { controller, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'STALE', inGap: false, isAfterLast: true });
    expect(controller.status.label).toBe('HOLD_FINAL');
    store.fire();
    expect(controller.status.label).toBe('HOLD_FINAL');
  });
});

/* ================================================================================================
 * CONTROLLER: frame contact
 * ============================================================================================== */

describe('frame contact', () => {
  it('is unavailable with no selection, and moves nothing', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = null;
    const result = controller.frameContact();
    expect(result.ok).toBe(false);
    expect(camera.calls).not.toContain('flyTo');
  });

  it('is unavailable when the contact has no drawn position, and never uses stale coordinates', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    camera.positions.delete('A');
    const result = controller.frameContact();
    expect(result.ok).toBe(false);
    expect(camera.calls).not.toContain('flyTo');
  });

  it('flies once to the CURRENT display position, not a remembered one', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    const first = controller.frameContact();
    expect(first.ok).toBe(true);
    expect(camera.calls.filter((c) => c === 'flyTo')).toHaveLength(1);
    // The contact moves; framing again must aim at the new display truth.
    camera.positions.set('A', { lat: 3.0, lon: 105.0 });
    const second = controller.frameContact();
    expect(second.ok).toBe(true);
    expect(camera.calls.filter((c) => c === 'flyTo')).toHaveLength(2);
    expect(second.at).toEqual({ lat: 3.0, lon: 105.0 });
  });
});

/* ================================================================================================
 * CONTROLLER: manual release + programmatic guard
 * ============================================================================================== */

describe('manual release', () => {
  it('camera motion the controller did not write releases FOLLOW to OFF', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    expect(store.mode.value).toBe('FOLLOW');
    camera.fireMoveStart();
    expect(store.mode.value).toBe('OFF');
    expect(controller.status.label).toBe('OFF');
  });

  it('press-level input also releases FOLLOW to OFF', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    camera.fireInput();
    expect(store.mode.value).toBe('OFF');
  });

  it('the controller’s own per-tick write does not self-cancel once Cesium actually raises moveStart', () => {
    // THE REGRESSION THAT MATTERS (DF-X9.8B). This test previously asserted the same thing
    // against a double that raised moveStart synchronously inside setView -- which Cesium never
    // does. The real sequence is: tick writes the camera, the render loop notices on a LATER
    // frame and raises moveStart, by which time the synchronous guard has been cleared.
    //
    // Browser evidence for why this is not theoretical, at f7e940e with FOLLOW engaged:
    //   camera holding, playback paused  -> mode=ON  status=TRACKING
    //   playhead advances, camera moves  -> mode=OFF status=OFF
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);

    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    // The render loop's first look at the changed camera.
    camera.flushRender();
    expect(store.mode.value).toBe('FOLLOW');

    // Sustained follow across many ticks and renders, each tick moving the vessel on.
    for (let i = 0; i < 5; i += 1) {
      camera.positions.set('A', { lat: A_POS.lat + (i + 1) * 0.01, lon: A_POS.lon });
      controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
      camera.flushRender();
      camera.flushRender(); // settle
      expect(store.mode.value).toBe('FOLLOW');
    }
    expect(store.mode.value).toBe('FOLLOW');
  });

  it('survives the settle-then-drift moveStart that a single write provokes twice', () => {
    // DF-X9.8B browser timeline. One setView raises moveStart more than once: once as the camera
    // moves, and again after `_cameraStartFired` resets because the camera stopped changing.
    // Guarding only the first echo released follow ~1.9 s in, mid-HOLD_GAP, with the reason
    // "Released: the camera was moved." -- an echo of our own write read as an operator drag.
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: true, isAfterLast: false });

    camera.flushRender(); // camera moving -> moveStart (echo)
    expect(store.mode.value).toBe('FOLLOW');
    camera.flushRender(); // settled -> moveEnd, latch resets
    camera.flushRender(); // post-settle drift -> moveStart AGAIN, still our pose
    camera.flushRender();
    camera.flushRender();
    expect(store.mode.value).toBe('FOLLOW');
    expect(store.mode.value).not.toBe('OFF');
  });

  it('recognises the FIRST write when a second write was recorded before its echo', () => {
    // The failure the browser actually showed, at a7cb6f1 mid-HOLD_GAP. Altitude stepped
    // 931,839 -> 632,034 -> 450,000 m over ~1.5 s: TWO writes, because the anchor moves as the
    // renderer catches up with a seek. A single-slot guard overwrote itself, so the FIRST
    // write's moveStart was compared against the SECOND pose, failed to match, and released
    // follow with the reason "Released: the camera was moved."
    //
    // So the guard must hold a history and retire only up to the pose it matched.
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);

    controller.tick({ displayState: 'OBSERVED', inGap: true, isAfterLast: false }); // write P1
    const firstWritten = camera.getPose();
    camera.positions.set('A', { lat: A_POS.lat + 0.02, lon: A_POS.lon });
    controller.tick({ displayState: 'OBSERVED', inGap: true, isAfterLast: false }); // write P2

    // The render loop reports the camera at P1 -- the first write, not the newest.
    camera.port.setView({
      position: { ...firstWritten.position },
      orientation: firstWritten.orientation,
    });
    camera.flushRender();
    expect(store.mode.value).toBe('FOLLOW');
  });

  it('but an operator drag that changes the pose still releases', () => {
    // The guard above recognises OUR OWN echo by pose. It must not become "ignore moveStart
    // while following", which would make the operator unable to take the camera back.
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    camera.flushRender();
    expect(store.mode.value).toBe('FOLLOW');

    // The operator moves the camera somewhere else entirely.
    camera.getPose();
    const dragged = camera.port.getCameraPose();
    expect(dragged).not.toBeNull();
    camera.port.setView({
      position: { x: dragged!.position.x + 5_000_000, y: dragged!.position.y, z: dragged!.position.z },
      orientation: dragged!.orientation,
    });
    camera.flushRender();

    expect(store.mode.value).toBe('OFF');
  });

  it('the controller’s own frame flight does not self-cancel', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.frameContact();
    // flyTo raises moveStart synchronously in the fake; the flight guard must hold.
    expect(store.mode.value).toBe('FOLLOW');
    camera.fireMoveEnd();
    // Ending the flight settles the guard; a LATER foreign motion still releases.
    camera.fireMoveStart();
    expect(store.mode.value).toBe('OFF');
  });
});

/* ================================================================================================
 * CONTROLLER: release on selection / layer / removal
 * ============================================================================================== */

describe('follow release rules', () => {
  it('clearing the selection releases FOLLOW with no dangling MMSI', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    store.selectedMmsi.value = null;
    store.fire();
    expect(store.mode.value).toBe('OFF');
    expect(controller.status.mmsi).toBeNull();
    camera.calls.length = 0;
    controller.tick({ displayState: null, inGap: false, isAfterLast: false });
    expect(camera.calls).not.toContain('setView');
  });

  it('switching the AIS contacts layer off releases FOLLOW', () => {
    const { controller, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    store.visible.value = false;
    store.fire();
    expect(store.mode.value).toBe('OFF');
    expect(controller.status.label).toBe('UNAVAILABLE');
  });

  it('a contact that is removed or filtered away releases FOLLOW', () => {
    const { controller, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    controller.setFollow(true);
    store.known.delete('A');
    store.fire();
    expect(store.mode.value).toBe('OFF');
  });
});

/* ================================================================================================
 * CONTROLLER: listener ownership
 * ============================================================================================== */

describe('listener ownership', () => {
  it('attach adds a bounded set and detach returns to baseline', () => {
    const { controller, camera, store } = wired();
    const cameraSubs = () =>
      camera.calls.filter((c) => c === 'onMoveStart' || c === 'onMoveEnd' || c === 'onUserInput')
        .length;
    controller.attach();
    expect(store.subscribes.count).toBe(1);
    expect(cameraSubs()).toBe(3);
    expect(controller.listenerCount).toBe(4);
    controller.detach();
    expect(store.unsubscribes.count).toBe(1);
    expect(controller.listenerCount).toBe(0);
  });

  it('on/off cycles, contact switches and clear do not accumulate listeners', () => {
    const { controller, camera, store } = wired();
    controller.attach();
    store.selectedMmsi.value = 'A';
    for (let i = 0; i < 3; i += 1) {
      controller.setFollow(true);
      controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
      controller.setFollow(false);
    }
    store.selectedMmsi.value = 'B';
    store.fire();
    controller.setFollow(true);
    controller.tick({ displayState: 'OBSERVED', inGap: false, isAfterLast: false });
    store.selectedMmsi.value = null;
    store.fire();
    expect(controller.listenerCount).toBe(4);
    expect(store.subscribes.count).toBe(1);
    controller.detach();
    controller.attach();
    expect(store.subscribes.count).toBe(2);
    expect(controller.listenerCount).toBe(4);
    controller.detach();
    expect(controller.listenerCount).toBe(0);
    expect(store.unsubscribes.count).toBe(2);
    // The camera port received no viewer reconstruction: only subscription calls plus the
    // per-tick reads and writes the behaviour above required.
    const forbidden = camera.calls.filter((c) => c === 'init' || c === 'recreate' || c === 'destroy');
    expect(forbidden).toHaveLength(0);
  });

  it('double attach is idempotent and dispose cleans everything', () => {
    const { controller, store } = wired();
    controller.attach();
    controller.attach();
    expect(store.subscribes.count).toBe(1);
    expect(controller.listenerCount).toBe(4);
    controller.dispose();
    expect(controller.listenerCount).toBe(0);
    expect(store.mode.value).toBe('OFF');
  });
});
