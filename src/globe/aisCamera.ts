/**
 * THE AIS CAMERA OWNER: FRAME CONTACT, FRAME TRACK planning, and FOLLOW (DF-X9.6 §20-45, 53-59).
 *
 * ================================ ONE OWNER, ONE MODE FIELD ================================
 *
 * Every follow/frame behaviour lives in `AisCameraController`. The store's `aisFollowMode` is
 * the mode authority and this controller (plus the single UI surface that drives it,
 * `AisPlaybackBar`) is its ONLY writer: no selection handler, no keyboard shortcut and no
 * timeline writes it. Follow IDENTITY is `selectedAis.mmsi` -- the AIS selection authority --
 * and no second MMSI field exists.
 *
 * Mode semantics, each one real (no declared-but-dead value):
 *
 *   OFF     No camera control. The operator owns the camera outright.
 *   FOLLOW  Continuous per-tick tracking: the retained camera offset vector is re-applied at
 *           each new DISPLAY position via a setView-style move (no animation per tick).
 *   CENTER  The last action was a one-shot centering (FRAME CONTACT). No per-tick moves; it
 *           persists only as the record of that action and clears under the same release
 *           rules as FOLLOW.
 *   CHASE   Reserved. No writer sets it; the controller treats it as OFF. Documented rather
 *           than deleted so a future lane knows the value was considered, not forgotten.
 *
 * ================================ WHAT FOLLOW TRACKS ================================
 *
 * The contact DISPLAY position only -- the retained billboard, which already includes
 * interpolation -- read fresh every tick through `displayPositionOf`. Consequences, each
 * enforced below and tested in `aisCamera.test.ts`:
 *
 *   NOT_YET_OBSERVED (no glyph) -> SUSPENDED. Never a remembered position (§26): a contact
 *           with no drawn position moves nothing, and no stale coordinate is ever reused.
 *   Gap interval            -> the display truth already holds at the earlier fix, so
 *           following it HOLDS the last valid displayed position; the status reads HOLD_GAP.
 *   After the last fix       -> the display truth is the final fix; following it holds
 *           final with no repeated motion (writes stop once the anchor stops moving).
 *   Interpolation interval  -> the display position between the bracketing fixes is followed.
 *   Predicted marker         -> never read. The camera port exposes no predicted accessor,
 *           so reaching it is unrepresentable, not merely avoided (§45).
 *
 * ================================ DRIVE, NOT CLOCK ================================
 *
 * The controller owns NO clock, NO RAF loop and NO Cesium clock: `tick()` is called by
 * `TacticalWorld`'s per-tick AIS render effect AFTER `setAisContacts`, so the billboard it
 * reads is the current tick's, never the previous one's. Subscribing to the temporal
 * controller independently would race that render and read one tick stale, which is why the
 * render effect -- not a subscription -- is the driver.
 *
 * ================================ MANUAL RELEASE (§32-34) ================================
 *
 * Any camera motion the controller did not write releases FOLLOW/CENTER to OFF: the operator
 * took the camera. Detection is MOTION-based (`moveStart`), not press-based, deliberately:
 * a press-based listener would release on the mouse-down of a click that SELECTS contact B
 * while following A -- destroying the switch-contact retarget the product requires. A plain
 * click moves nothing, so it never releases; a drag, rotate, zoom or tilt moves the camera
 * and always does.
 *
 * The controller's own writes are wrapped in a programmatic guard (synchronous flag for
 * setView-style moves, a flight counter settled by moveEnd for animated flights), so they
 * never self-cancel. A foreign programmatic move (FRAME TRACK fit, H-key reset) IS a
 * release: someone aimed the camera elsewhere, and follow silently yanking it back would
 * take the camera away without anyone deciding to.
 *
 * Switch-contact while following RETARGETS: the retained offset vector is kept and applied
 * at the new contact's display position. Contact cleared, removed/filtered, or the
 * AIS_CONTACTS layer switched off releases to OFF with no dangling MMSI (§58-59).
 *
 * Pure parts (`offsetBetween`/`applyOffset`, `resolveFollowStatus`, `planFrameTrack`
 * re-export) carry the unit proofs; the class is exercised against fake ports.
 */

import { planFrameTrack as planTrackFit, type FrameTrackRequest } from '../temporal/framing';
import { store, type State } from '../state/store';
import { engine } from './engine';

/* ============================================================================================== *
 * PLAIN GEOMETRY (no Cesium import: unit tests run in node)
 * ============================================================================================== */

export type LatLon = { lat: number; lon: number };
export type Vec3 = { x: number; y: number; z: number };
export type CameraOrientation = { heading: number; pitch: number; roll: number };
export type CameraPose = { position: Vec3; orientation: CameraOrientation };

/**
 * The retained offset: camera position minus target position, in world coordinates.
 *
 * Captured once (when FOLLOW engages or the first display position arrives) and re-applied
 * every tick. World-vector form, not lat/lon deltas, so high-latitude following does not
 * inherit meridian-convergence distortion.
 */
export function offsetBetween(cameraPosition: Vec3, targetPosition: Vec3): Vec3 {
  return {
    x: cameraPosition.x - targetPosition.x,
    y: cameraPosition.y - targetPosition.y,
    z: cameraPosition.z - targetPosition.z,
  };
}

/** Re-apply a retained offset at a new target: the camera rides WITH the contact. */
export function applyOffset(targetPosition: Vec3, offset: Vec3): Vec3 {
  return {
    x: targetPosition.x + offset.x,
    y: targetPosition.y + offset.y,
    z: targetPosition.z + offset.z,
  };
}

/* ============================================================================================== *
 * FOLLOW AVAILABILITY (pure planner)
 * ============================================================================================== */

export type FollowMode = State['aisFollowMode'];

export type FollowStatusLabel =
  | 'OFF'
  | 'CENTERED'
  | 'TRACKING'
  | 'HOLD_GAP'
  | 'HOLD_FINAL'
  | 'SUSPENDED'
  | 'UNAVAILABLE';

export type FollowStep = {
  action: 'IDLE' | 'TRACK' | 'SUSPEND' | 'RELEASE';
  label: FollowStatusLabel;
  /** False for SUSPEND: a suspended follow must never move on a remembered position. */
  useRememberedPosition: boolean;
  reason: string;
};

export type FollowStatus = {
  mode: FollowMode;
  label: FollowStatusLabel;
  mmsi: string | null;
  reason: string;
};

export type FollowTickContext = {
  /** The contact's display state vocabulary, or null when unknown. */
  displayState: string | null;
  /** True when the reference instant sits inside a reporting gap. */
  inGap: boolean;
  /** True when the reference instant is at or past the contact's last observation. */
  isAfterLast: boolean;
};

/**
 * Decide what one follow tick does. PURE: ports and camera stay in the controller.
 *
 * Behaviour needs only the display position (null = nothing drawn = suspend); the label
 * additionally needs the gap/after-last facts, which the caller computes from the archive.
 */
export function resolveFollowStatus(input: {
  mode: FollowMode;
  selectedMmsi: string | null;
  contactsVisible: boolean;
  contactKnown: boolean;
  hasPosition: boolean;
  displayState: string | null;
  inGap: boolean;
  isAfterLast: boolean;
}): FollowStep {
  if (input.mode === 'OFF' || input.mode === 'CHASE') {
    return {
      action: 'IDLE',
      label: 'OFF',
      useRememberedPosition: false,
      reason: 'Follow is off.',
    };
  }
  if (input.selectedMmsi === null) {
    return {
      action: 'RELEASE',
      label: 'UNAVAILABLE',
      useRememberedPosition: false,
      reason: 'No contact selected.',
    };
  }
  if (!input.contactsVisible) {
    return {
      action: 'RELEASE',
      label: 'UNAVAILABLE',
      useRememberedPosition: false,
      reason: 'The AIS contacts layer is off.',
    };
  }
  if (!input.contactKnown) {
    return {
      action: 'RELEASE',
      label: 'UNAVAILABLE',
      useRememberedPosition: false,
      reason: 'The selected contact is no longer present.',
    };
  }
  if (!input.hasPosition) {
    // NOT_YET_OBSERVED or otherwise undrawable. Suspend WITHOUT moving: the camera stays
    // where it is, and no remembered coordinate is ever used for motion (§26).
    return {
      action: 'SUSPEND',
      label: 'SUSPENDED',
      useRememberedPosition: false,
      reason: 'The selected contact has no drawn position yet.',
    };
  }
  if (input.inGap) {
    return {
      action: 'TRACK',
      label: 'HOLD_GAP',
      useRememberedPosition: false,
      reason: 'Holding the last reported position through a data gap.',
    };
  }
  if (input.isAfterLast) {
    return {
      action: 'TRACK',
      label: 'HOLD_FINAL',
      useRememberedPosition: false,
      reason: 'Holding the final reported position.',
    };
  }
  return {
    action: 'TRACK',
    label: 'TRACKING',
    useRememberedPosition: false,
    reason: `Following ${input.selectedMmsi}.`,
  };
}

/** FRAME TRACK planning, re-exported so the one camera owner is also the one framing owner. */
export function planFrameTrack(request: FrameTrackRequest) {
  return planTrackFit(request);
}

/* ============================================================================================== *
 * PORTS (what the controller needs; the engine implements the real ones)
 * ============================================================================================== */

export type AisCameraCameraPort = {
  /** Retained display position of a drawn contact glyph; null when it has no glyph. */
  displayPositionOf: (mmsi: string) => LatLon | null;
  getCameraPose: () => CameraPose | null;
  cartesianOf: (position: LatLon) => Vec3;
  /** setView-style move: immediate, no animation. What per-tick follow uses. */
  setView: (pose: CameraPose) => void;
  /** Animated one-shot. What FRAME CONTACT uses. */
  flyTo: (position: LatLon) => void;
  onMoveStart: (cb: () => void) => () => void;
  onMoveEnd: (cb: () => void) => () => void;
  onUserInput: (cb: () => void) => () => void;
};

export type AisCameraStorePort = {
  getSelectedMmsi: () => string | null;
  getFollowMode: () => FollowMode;
  setFollowMode: (mode: FollowMode) => void;
  isContactsVisible: () => boolean;
  contactKnown: (mmsi: string) => boolean;
  subscribe: (cb: () => void) => () => void;
};

function defaultCameraPort(): AisCameraCameraPort {
  return {
    displayPositionOf: (mmsi) => engine.displayPositionOf(mmsi),
    getCameraPose: () => {
      const pose = engine.getCameraPose();
      if (pose === null) return null;
      return {
        position: pose.position,
        orientation: { heading: pose.heading, pitch: pose.pitch, roll: pose.roll },
      };
    },
    cartesianOf: (position) => engine.cartesianOf(position.lat, position.lon),
    setView: (pose) => engine.setCameraPose(pose.position, pose.orientation),
    flyTo: (position) => engine.flyTo(position.lat, position.lon),
    onMoveStart: (cb) => engine.onCameraMoveStart(cb),
    onMoveEnd: (cb) => engine.onCameraMoveEnd(cb),
    onUserInput: (cb) => engine.onCameraUserInput(cb),
  };
}

function defaultStorePort(): AisCameraStorePort {
  return {
    getSelectedMmsi: () => store.getState().selectedAis?.mmsi ?? null,
    getFollowMode: () => store.getState().aisFollowMode,
    setFollowMode: (mode) => store.set({ aisFollowMode: mode }),
    isContactsVisible: () => store.getState().layerState.AIS_CONTACTS?.visible ?? true,
    contactKnown: (mmsi) => {
      const state = store.getState();
      return (
        state.aisOnly.some((c) => c.mmsi === mmsi) ||
        state.aisObservations.some((o) => o.mmsi === mmsi)
      );
    },
    subscribe: (cb) => store.subscribe(cb),
  };
}

/* ============================================================================================== *
 * THE CONTROLLER
 * ============================================================================================== */

export class AisCameraController {
  #camera: AisCameraCameraPort;
  #store: AisCameraStorePort;
  #unsubscribers: Array<() => void> = [];
  #offset: Vec3 | null = null;
  #offsetMmsi: string | null = null;
  #lastApplied: LatLon | null = null;
  #programmaticSync = false;
  #ownFlights = 0;
  #recaptureAfterFlight = false;
  #status: FollowStatus = { mode: 'OFF', label: 'OFF', mmsi: null, reason: 'Follow is off.' };

  constructor(camera?: AisCameraCameraPort | null, storePort?: AisCameraStorePort | null) {
    this.#camera = camera ?? defaultCameraPort();
    this.#store = storePort ?? defaultStorePort();
  }

  get attached(): boolean {
    return this.#unsubscribers.length > 0;
  }

  /** Owned subscriptions, so a leak is observable rather than inferred. */
  get listenerCount(): number {
    return this.#unsubscribers.length;
  }

  get status(): FollowStatus {
    return { ...this.#status };
  }

  /**
   * Attach camera + input + store subscriptions. Idempotent: attaching twice changes nothing.
   *
   * The viewer is NEVER reconstructed here -- the controller holds ports, not a Viewer, and
   * has no method that creates one.
   */
  attach(): void {
    if (this.attached) return;
    this.#unsubscribers = [
      this.#store.subscribe(() => this.#onStoreChange()),
      this.#camera.onMoveStart(() => this.#onCameraMoveStart()),
      this.#camera.onMoveEnd(() => this.#onCameraMoveEnd()),
      this.#camera.onUserInput(() => this.#onManualInput()),
    ];
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* already detached */
      }
    }
    this.#unsubscribers = [];
  }

  /** Detach and release follow state. The viewer is untouched. */
  dispose(): void {
    this.detach();
    this.#store.setFollowMode('OFF');
    this.#offset = null;
    this.#offsetMmsi = null;
    this.#lastApplied = null;
    this.#ownFlights = 0;
    this.#recaptureAfterFlight = false;
    this.#status = { mode: 'OFF', label: 'OFF', mmsi: null, reason: 'Follow is off.' };
  }

  /**
   * Engage or release FOLLOW from the single UI toggle.
   *
   * Engaging captures nothing yet: the offset is captured lazily on the first tick that has
   * both a camera pose and a display position, so enabling before the first observation
   * suspends honestly instead of aiming from a guessed geometry.
   */
  setFollow(on: boolean): void {
    if (on) {
      if (this.#store.getFollowMode() === 'FOLLOW') return;
      this.#store.setFollowMode('FOLLOW');
      this.#offset = null;
      this.#offsetMmsi = null;
      this.#lastApplied = null;
      this.#refreshStatus({ displayState: null, inGap: false, isAfterLast: false });
      return;
    }
    if (this.#store.getFollowMode() === 'OFF') return;
    this.#store.setFollowMode('OFF');
    this.#offset = null;
    this.#offsetMmsi = null;
    this.#lastApplied = null;
    this.#recaptureAfterFlight = false;
    this.#refreshStatus({ displayState: null, inGap: false, isAfterLast: false });
  }

  /**
   * FRAME CONTACT: one animated shot at the selected contact's CURRENT display position.
   *
   * Reads display truth at click time -- never a stored or remembered coordinate (§25-26).
   * Unavailable (ok:false, no camera write) when nothing is selected or the contact has no
   * drawn position. Preserves FOLLOW when active (the offset is re-captured after the
   * flight); otherwise records the CENTER one-shot.
   */
  frameContact(): { ok: boolean; reason: string; at?: LatLon } {
    const mmsi = this.#store.getSelectedMmsi();
    if (mmsi === null) {
      return { ok: false, reason: 'No contact selected.' };
    }
    const position = this.#camera.displayPositionOf(mmsi);
    if (position === null) {
      return { ok: false, reason: 'The selected contact has no drawn position.' };
    }
    const mode = this.#store.getFollowMode();
    if (mode === 'FOLLOW') {
      this.#recaptureAfterFlight = true;
    } else {
      this.#store.setFollowMode('CENTER');
    }
    this.#ownFlights += 1;
    try {
      this.#camera.flyTo({ lat: position.lat, lon: position.lon });
    } catch {
      this.#ownFlights = Math.max(0, this.#ownFlights - 1);
      this.#recaptureAfterFlight = false;
      return { ok: false, reason: 'The camera move could not start.' };
    }
    this.#refreshStatus({ displayState: null, inGap: false, isAfterLast: false });
    return { ok: true, reason: mode === 'FOLLOW' ? `Following ${mmsi}.` : `Centered on ${mmsi}.`, at: position };
  }

  /**
   * ONE FOLLOW TICK. Called by TacticalWorld's per-tick AIS render effect, after the
   * renderer has drawn the current instant. Never called by a clock owned here.
   */
  tick(ctx: FollowTickContext): void {
    const mode = this.#store.getFollowMode();
    if (mode !== 'FOLLOW') {
      this.#refreshStatus(ctx);
      return;
    }
    const mmsi = this.#store.getSelectedMmsi();
    const step = resolveFollowStatus({
      mode,
      selectedMmsi: mmsi,
      contactsVisible: this.#store.isContactsVisible(),
      contactKnown: mmsi === null ? false : this.#store.contactKnown(mmsi),
      hasPosition: mmsi === null ? false : this.#camera.displayPositionOf(mmsi) !== null,
      displayState: ctx.displayState,
      inGap: ctx.inGap,
      isAfterLast: ctx.isAfterLast,
    });
    if (step.action === 'IDLE') {
      this.#refreshStatus(ctx);
      return;
    }
    if (step.action === 'RELEASE') {
      // No dangling MMSI: releasing clears the mode AND the retained geometry. The status
      // keeps the cause (UNAVAILABLE with the reason) rather than resetting to a generic
      // OFF that would hide why follow ended.
      this.#store.setFollowMode('OFF');
      this.#offset = null;
      this.#offsetMmsi = null;
      this.#lastApplied = null;
      this.#status = { mode: 'OFF', label: 'UNAVAILABLE', mmsi: null, reason: step.reason };
      return;
    }
    if (step.action === 'SUSPEND' || mmsi === null) {
      this.#refreshStatus(ctx);
      return;
    }
    // TRACK. The position was read above; read it once more as the anchor so the move aims
    // at display truth, not at anything remembered.
    const anchor = this.#camera.displayPositionOf(mmsi);
    if (anchor === null) {
      this.#refreshStatus(ctx);
      return;
    }
    // The anchor stopped moving (paused, or holding final): no repeated motion.
    if (
      this.#lastApplied !== null &&
      this.#lastApplied.lat === anchor.lat &&
      this.#lastApplied.lon === anchor.lon
    ) {
      this.#refreshStatus(ctx);
      return;
    }
    const pose = this.#camera.getCameraPose();
    if (pose === null) {
      this.#refreshStatus(ctx);
      return;
    }
    // Retarget keeps the retained offset vector: A->B rides by exactly the anchor delta.
    // First acquisition captures it from the live camera.
    if (this.#offset === null) {
      this.#offset = offsetBetween(pose.position, this.#camera.cartesianOf(anchor));
      this.#offsetMmsi = mmsi;
    }
    const next: CameraPose = {
      position: applyOffset(this.#camera.cartesianOf(anchor), this.#offset),
      orientation: pose.orientation,
    };
    this.#programmaticSync = true;
    try {
      this.#camera.setView(next);
    } finally {
      this.#programmaticSync = false;
    }
    this.#lastApplied = { lat: anchor.lat, lon: anchor.lon };
    this.#refreshStatus(ctx);
  }

  /* ------------------------------------------------------------ events */

  #onStoreChange(): void {
    const mode = this.#store.getFollowMode();
    if (mode !== 'FOLLOW' && mode !== 'CENTER') {
      this.#refreshStatus({ displayState: null, inGap: false, isAfterLast: false });
      return;
    }
    const mmsi = this.#store.getSelectedMmsi();
    if (mmsi === null || !this.#store.isContactsVisible() || !this.#store.contactKnown(mmsi)) {
      // Selection cleared, layer off, or contact gone: release, no dangling MMSI. The cause
      // is kept in the status so the UI can say WHY follow ended, not just that it did.
      const cause =
        mmsi === null
          ? 'No contact selected.'
          : !this.#store.isContactsVisible()
            ? 'The AIS contacts layer is off.'
            : 'The selected contact is no longer present.';
      this.#store.setFollowMode('OFF');
      this.#offset = null;
      this.#offsetMmsi = null;
      this.#lastApplied = null;
      this.#recaptureAfterFlight = false;
      this.#status = { mode: 'OFF', label: 'UNAVAILABLE', mmsi: null, reason: cause };
      return;
    }
    this.#refreshStatus({ displayState: null, inGap: false, isAfterLast: false });
  }

  #onCameraMoveStart(): void {
    // Own writes never self-cancel: synchronous setView moves and in-flight animations
    // are both guarded. Everything else moved the camera, so the operator (or another
    // surface acting for them) took it -- release.
    if (this.#programmaticSync || this.#ownFlights > 0) return;
    const mode = this.#store.getFollowMode();
    if (mode !== 'FOLLOW' && mode !== 'CENTER') return;
    this.#releaseToOperator('Released: the camera was moved.');
  }

  #onCameraMoveEnd(): void {
    if (this.#ownFlights > 0) {
      this.#ownFlights -= 1;
      if (this.#recaptureAfterFlight && this.#store.getFollowMode() === 'FOLLOW') {
        // A FRAME CONTACT during FOLLOW re-aimed the camera; the retained offset belongs
        // to the new framing, not the old one.
        //
        // KNOWN EDGE, DOCUMENTED NOT FIXED: an operator drag DURING the ~1.4 s flight has
        // its moveStart suppressed by the flight guard, so the mode stays FOLLOW -- but the
        // outcome is still honest, not a yank-back. Cesium cancels the flight on input, this
        // moveEnd re-anchors the offset at the operator's dragged pose, and follow continues
        // from there. Press-level wheel/pinch during the flight releases immediately through
        // the input path regardless.
        this.#offset = null;
        this.#offsetMmsi = null;
        this.#lastApplied = null;
        this.#recaptureAfterFlight = false;
      }
    }
  }

  #onManualInput(): void {
    // Press-level input (mouse-down, wheel, pinch): the operator is taking the camera.
    // Same release as motion, through the same single transition. Own writes generate no
    // input events, so this path cannot self-cancel and needs no guard.
    const mode = this.#store.getFollowMode();
    if (mode !== 'FOLLOW' && mode !== 'CENTER') return;
    this.#releaseToOperator('Released: operator input took the camera.');
  }

  /** One transition for every operator-takes-the-camera release. */
  #releaseToOperator(reason: string): void {
    this.#store.setFollowMode('OFF');
    this.#offset = null;
    this.#offsetMmsi = null;
    this.#lastApplied = null;
    this.#recaptureAfterFlight = false;
    this.#status = { mode: 'OFF', label: 'OFF', mmsi: null, reason };
  }

  #refreshStatus(ctx: FollowTickContext): void {
    const mode = this.#store.getFollowMode();
    const mmsi = this.#store.getSelectedMmsi();
    if (mode === 'OFF' || mode === 'CHASE') {
      this.#status = { mode, label: 'OFF', mmsi: null, reason: 'Follow is off.' };
      return;
    }
    if (mode === 'CENTER') {
      this.#status = {
        mode,
        label: 'CENTERED',
        mmsi,
        reason: mmsi === null ? 'Centered; no contact selected.' : `Centered on ${mmsi}.`,
      };
      return;
    }
    const step = resolveFollowStatus({
      mode,
      selectedMmsi: mmsi,
      contactsVisible: this.#store.isContactsVisible(),
      contactKnown: mmsi === null ? false : this.#store.contactKnown(mmsi),
      // Status only: whether a glyph exists is read without moving anything. A null here
      // while a tick just tracked is a one-render race, and SUSPENDED is the honest label.
      hasPosition: mmsi === null ? false : this.#camera.displayPositionOf(mmsi) !== null,
      displayState: ctx.displayState,
      inGap: ctx.inGap,
      isAfterLast: ctx.isAfterLast,
    });
    this.#status = { mode, label: step.label, mmsi, reason: step.reason };
  }
}

/**
 * The product singleton, bound lazily to the engine and the store.
 *
 * Ports are resolved PER CALL inside the default port closures, so constructing this before
 * the viewer exists is safe: every method no-ops until there is a viewer, exactly like the
 * engine methods it forwards to.
 */
export const aisCamera = new AisCameraController();
