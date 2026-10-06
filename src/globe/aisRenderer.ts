/**
 * The AIS CONTACT RENDERER: a retained `BillboardCollection` with directional vessel glyphs.
 *
 * ================================ WHY A COLLECTION, NOT AN ENTITY PER CONTACT ================================
 *
 * The previous renderer added one Cesium `Entity` per contact, each with a `PointGraphics` and a
 * `LabelGraphics`. `PointGraphics` has no `rotation` at all, which is the mechanical reason a
 * directional glyph was impossible before -- not a styling oversight but a primitive that cannot
 * point anywhere.
 *
 * `BillboardCollection` is retained for two reasons, and the second is the important one:
 *
 *   1. `BillboardGraphics` HAS `rotation`, so the glyph can be oriented.
 *   2. It batches thousands of billboards into ONE draw call. A thousand `Entity` objects means a
 *      thousand `DataSource` entries, a thousand `Property` graphs and a thousand objects for
 *      Cesium's entity collection to diff on every frame.
 *
 * THE IDENTITY RULE IS WHAT MAKES THE SECOND REASON MATTER. Contacts are keyed by MMSI in a
 * `Map`, and an update to an existing contact MUTATES the retained billboard's position and
 * rotation rather than destroying and recreating it. Creating a collection per tick was measured
 * as the difference between a smooth globe and a stuttering one.
 *
 * ================================ WHAT THIS MODULE MUST NOT DO ================================
 *
 * It must not compute correlation, match acceptance, Ghost Vessel classification, or the
 * analytical predicted SAR-time position. Those are backend-authoritative and are read from the
 * scan record; this module only decides how to DRAW what it is handed.
 *
 * In particular the predicted position is passed IN and drawn as its own geometry. It is never
 * derived here. A client-side dead-reckoning projection would be a second prediction competing
 * with the analytical one, and the operator could not tell which they were looking at.
 */

import {
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  Material,
  HorizontalOrigin,
  LabelCollection,
  PolylineCollection,
  VerticalOrigin,
  type Billboard,
  type Viewer,
} from 'cesium';

import {
  arbitrateLabels,
  cameraFrameFromViewer,
  glyphScreenRotation,
  type LabelClaim,
  type LabelPriority,
} from './glyphGeometry';
import {
  stabilizeOrientation,
  type ContactDisplayState,
  type DisplayContactState,
  type Freshness,
} from '../ais/displayState';
import { buildTrack, displayRunsFor } from '../temporal/trackBuilder';

/* ============================================================================================== *
 * VISUAL VOCABULARY
 *
 * Taken from the product's existing token set rather than invented here, so AIS glyphs read as
 * part of the same interface as everything else.
 *
 * NO THREAT OR SUSPICION COLOURS. DF-X9 section 15 is explicit about this, and it is also the
 * honest choice: DarkFleet classifies radar returns, and nothing here establishes intent.
 * ============================================================================================== */

const COLOUR_CONTACT = Color.fromCssColorString('#3FA9C4');
const COLOUR_SELECTED = Color.fromCssColorString('#8FE3C4');
const COLOUR_STALE = Color.fromCssColorString('#8A9BA8');
const COLOUR_PREDICTED = Color.fromCssColorString('#C9A227');

/**
 * A contact's display state, as the RENDERER sees it.
 *
 * `state` is the FULL `DisplayContactState`, not a structural subset of it. An earlier version of
 * this comment claimed it was a subset "so this module cannot accidentally reach an analytical
 * field", and that protection did not exist -- the field was an alias. The alias is kept because it
 * is genuinely the right type: the renderer needs the whole state, including `sourceObservation
 * Timestamps`, to decide what it is allowed to draw. The separation that DOES matter is enforced
 * structurally instead: `displayState.ts` is pure and imports nothing from this module, so there is
 * no path by which an analytical value reaches a Cesium primitive.
 */
export type RenderableContact = {
  mmsi: string;
  state: DisplayContactState;
  /** Whether the operator has this contact selected. */
  selected: boolean;
  /** Whether this contact is associated with the selected SAR target. */
  associated: boolean;
};

/**
 * The analytical predicted position, passed IN.
 *
 * Nullable, and null is a normal state -- not every contact has a predicted point, and the
 * `AIS_PREDICTED` layer must say so rather than drawing a placeholder.
 */
export type PredictedPoint = {
  mmsi: string;
  lat: number;
  lon: number;
  /** The SAR acquisition time this prediction is for. */
  atSarTime: string;
};

/* ============================================================================================== *
 * GLYPH GEOMETRY
 * ============================================================================================== */

/**
 * Draw the vessel glyph pointing along its bow.
 *
 * The image is authored pointing UP the bitmap, so the renderer's `rotation` is applied to a shape
 * whose nose is already at 12 o'clock. A chevron rather than a symmetric arrow, because a
 * symmetric arrow has no bow and would read identically whichever way the vessel faces -- which
 * would make the entire orientation system decorative.
 *
 * Rendered to a canvas at module scope rather than per call: a contact update happens on every
 * temporal tick, and allocating a 48x48 canvas per tick per contact would dominate the frame.
 */
const GLYPH_SIZE = 48;
const glyphImage = ((): HTMLCanvasElement | undefined => {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_SIZE;
  canvas.height = GLYPH_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const mid = GLYPH_SIZE / 2;

  // Hull: a forward-pointing wedge. Wide at the stern, tapering to the bow.
  ctx.beginPath();
  ctx.moveTo(mid, 5); // bow
  ctx.lineTo(GLYPH_SIZE - 8, GLYPH_SIZE - 9); // starboard quarter
  ctx.lineTo(mid, GLYPH_SIZE - 15); // stern
  ctx.lineTo(8, GLYPH_SIZE - 9); // port quarter
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Outline, so the glyph stays legible over both dark ocean and bright clutter.
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#040705';
  ctx.stroke();

  // A centreline, so the operator can see the bow direction even at 12 px.
  ctx.beginPath();
  ctx.moveTo(mid, 8);
  ctx.lineTo(mid, GLYPH_SIZE - 14);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#040705';
  ctx.stroke();

  return canvas;
})();

/**
 * The glyph for UNKNOWN orientation: a ring, with no direction at all.
 *
 * NOT a north-pointing chevron. A vessel that reported no heading and no course has no known
 * direction, and drawing one pointing north would assert a course nobody gave -- which is the
 * exact defect DF-X9 section 17 forbids, reintroduced in visual form.
 */
const unknownGlyphImage = ((): HTMLCanvasElement | undefined => {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_SIZE;
  canvas.height = GLYPH_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const mid = GLYPH_SIZE / 2;

  ctx.beginPath();
  ctx.arc(mid, mid, GLYPH_SIZE / 2 - 9, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#040705';
  ctx.stroke();

  // A short horizontal bar: marks the glyph as "no direction" rather than "pointing sideways",
  // which a bare ring does not distinguish from a vessel pointing due east at a glance.
  ctx.beginPath();
  ctx.moveTo(mid - 9, mid);
  ctx.lineTo(mid + 9, mid);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#040705';
  ctx.stroke();

  return canvas;
})();

/* ============================================================================================== *
 * DISPLAY STABILISATION STATE
 * ============================================================================================== */

/**
 * Rate limiting for the DRAWN angle, in degrees per update.
 *
 * A vessel on a steady course reports 091 then 092, and rotating a glyph by that is visible
 * twitching. 6 degrees per update is enough that a real turn still animates smoothly and slow
 * enough that a 1-degree wobble never moves the glyph at all.
 *
 * These are DISPLAY values. The raw reported heading is never modified and remains available in
 * the dossier -- the stabilised angle is not written back anywhere.
 */
const MAX_ROTATION_STEP_DEG = 6;

/*
 * The scope of "update in place", stated precisely.
 *
 * It applies to CONTACT GLYPHS ONLY. Labels, observation markers, predicted markers and track
 * polylines are rebuilt each render, because each is derived from a changing SET rather than
 * mutated: a label's text changes with freshness, and a marker exists only while its contact has
 * observations. Module-level and engine-level restatements of this rule previously implied all five
 * collections were retained in place, which is not true.
 */

/** Below this, a change is AIS noise rather than a turn. */
const ROTATION_DEADBAND_DEG = 2;

/** Label typeface. Matches the contact list and dossier, so a vessel reads as one object. */
const LABEL_FONT = '11px "JetBrains Mono", monospace';

/* ============================================================================================== *
 * THE RENDERER
 * ============================================================================================== */

export type ContactRenderStats = {
  contacts: number;
  billboards: number;
  labels: number;
  labelsShown: number;
  labelsSuppressed: number;
  /** True when every update reused retained primitives rather than rebuilding. */
  reusedBillboards: number;
  createdBillboards: number;
  removedBillboards: number;
  lastBuildMs: number;
};

/**
 * Owns the AIS collections for one viewer.
 *
 * COLLECTION OWNERSHIP IS EXPLICIT AND NON-SHARING. Five separate collections, each owned here:
 *
 *   contacts      -> AIS_CONTACTS
 *   labels        -> AIS_CONTACTS
 *   observations  -> AIS_TRACKS
 *   track         -> AIS_TRACKS
 *   predicted     -> AIS_PREDICTED
 *
 * None of them is shared with the uncertainty radii, the correlation links, or any maritime
 * reference layer. DF-X8 already had to fix that exact defect -- `uncertainty` and `correlation`
 * once shared one array, so toggling one cleared the other -- and DF-X9.3D requires that the AIS
 * layers not repeat it. Separate collections make independence structural rather than a naming
 * convention that a future edit could quietly break.
 */
/* ============================================================================================== *
 * PURE DECISIONS
 *
 * Extracted from `render` so they can be tested as functions rather than as source text.
 *
 * The first version of the test suite asserted that this file CONTAINED the string
 * `if (hasDirection) {`. A mutation that forced `hasDirection` to be permanently true -- so the
 * UNKNOWN glyph was never drawn and every contact pointed north -- left that string present and the
 * whole suite green. The visual guarantee DF-X9 section 17 depends on was entirely unguarded, and
 * only a mutation revealed it.
 *
 * `render` calls these two functions, so a test of them tests the behaviour rather than the spelling.
 * ============================================================================================== */

/** Which glyph a contact is drawn with. `UNKNOWN` is the ring, which has no direction at all. */
export type GlyphSelection = 'DIRECTIONAL' | 'UNKNOWN';

/**
 * The glyph for an orientation.
 *
 * `degrees === null` is UNKNOWN, and ONLY that is. A bearing of 0 is a real course due north and
 * gets the directional glyph; conflating the two is the defect this model exists to prevent.
 */
export function selectGlyph(degrees: number | null | undefined): GlyphSelection {
  return degrees === null || degrees === undefined || !Number.isFinite(degrees)
    ? 'UNKNOWN'
    : 'DIRECTIONAL';
}

/**
 * Everything `render` needs to know about ONE contact's orientation, decided in one place.
 *
 * WHY THIS IS ONE FUNCTION AND NOT THREE. The renderer's first version computed
 * `hasDirection = selectGlyph(degrees) === 'DIRECTIONAL'` itself and then branched on it twice:
 * once to pick the image and once to compute a rotation. That left a SECOND copy of the decision
 * inside `render`, and a mutation setting it to `true` -- so the UNKNOWN ring was never drawn --
 * passed the whole suite. The test could not catch it because the test called `selectGlyph` while
 * the mutation was somewhere else.
 *
 * So the decision now happens HERE, once, and `render` consumes the result without re-deriving it.
 * There is no second copy to diverge, which is a structural fix rather than a stronger assertion.
 *
 * Note honestly what this does and does not guarantee: the pure function is fully covered, and
 * `render` no longer contains orientation logic to mutate. It cannot prove that `render` CALLS this
 * function -- that needs a WebGL context and is the browser E2E's job.
 */
export type GlyphDecision = {
  selection: GlyphSelection;
  /** The STABILISED angle actually drawn. Null when unknown. Never the reported value. */
  displayDegrees: number | null;
  /** Screen rotation in radians, or null when unknown or the camera frame is unavailable. */
  rotation: number | null;
};

export function decideContactGlyph(input: {
  /** The vessel's reported bearing in degrees true, or null when none was reported. */
  degrees: number | null | undefined;
  /** The angle last DRAWN for this contact, for rate limiting. */
  previousDisplayDeg: number | null;
  lat: number;
  lon: number;
  frame: ReturnType<typeof cameraFrameFromViewer>;
  maxStepDeg: number;
  deadbandDeg: number;
}): GlyphDecision {
  const selection = selectGlyph(input.degrees);
  if (selection === 'UNKNOWN') {
    // No bearing. No stabilised angle is recorded, and no rotation is produced -- so a contact that
    // LOSES its heading cannot inherit a rotation from when it had one.
    return { selection, displayDegrees: null, rotation: null };
  }

  const stabilised = stabilizeOrientation(
    input.previousDisplayDeg,
    input.degrees as number,
    input.maxStepDeg,
    input.deadbandDeg,
  );
  const rotation =
    input.frame === null ? null : glyphScreenRotation(stabilised as number, input.lat, input.lon, input.frame);
  return { selection, displayDegrees: stabilised, rotation };
}

/* ============================================================================================== *
 * THE RENDERER
 * ============================================================================================== */

export class AisContactRenderer {
  #viewer: Viewer;
  #contacts: BillboardCollection;
  #labels: LabelCollection;
  #observations: BillboardCollection;
  #track: PolylineCollection;
  #predicted: BillboardCollection;

  /** Keyed by MMSI, holding the Billboard OBJECT. Stable identity, never array index. */
  #billboards = new Map<string, Billboard>();
  /**
   * Which glyph each contact currently shows: `true` = directional, `false` = unknown-ring.
   *
   * Tracked so the image is only reassigned when it CHANGES. See the update-in-place note in
   * `render` for why that matters.
   */
  #glyphKind = new Map<string, boolean>();
  /**
   * Gaps currently drawn, rebuilt from the tracks on every render.
   *
   * Held separately from the polylines because a GAP IS NOT A TRACK -- it is the absence of one.
   * Keeping it as its own record is what lets the browser E2E COUNT gaps and prove the track
   * visibly breaks, rather than inferring it from a line that merely looks shorter.
   */
  /** The highlighted observation, so a probe can see the highlight exist. */
  #highlighted: { mmsi: string; at: string } | null = null;
  #gaps: Array<{
    mmsi: string;
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
    spanSeconds: number | null;
  }> = [];
  /** Last DRAWN angle per MMSI, for the stabiliser. Never the reported value. */
  #drawnRotation = new Map<string, number>();
  #lastStats: ContactRenderStats = {
    contacts: 0, billboards: 0, labels: 0, labelsShown: 0, labelsSuppressed: 0,
    reusedBillboards: 0, createdBillboards: 0, removedBillboards: 0, lastBuildMs: 0,
  };

  constructor(viewer: Viewer) {
    this.#viewer = viewer;
    /*
     * `scene.primitives` RETAINS ownership, so the collections live as long as the viewer and are
     * torn down with it.
     *
     * Built once, in the constructor. A collection per temporal tick was the alternative and is
     * exactly what DF-X9 section 57 forbids: it reallocates every GPU buffer on every update. The
     * measured CPU-side saving is in `aisRenderer.perf.test.ts`; the GPU-side consequence is what the
     * browser E2E measures, and no frame-rate claim is made here because none has been measured.
     */
    this.#contacts = viewer.scene.primitives.add(new BillboardCollection({ scene: viewer.scene }));
    this.#observations = viewer.scene.primitives.add(
      new BillboardCollection({ scene: viewer.scene }),
    );
    this.#predicted = viewer.scene.primitives.add(new BillboardCollection({ scene: viewer.scene }));
    // `PolylineCollection` takes no `scene` option -- it inherits the scene from the primitive
    // collection it is added to, unlike the billboard collections.
    this.#track = viewer.scene.primitives.add(new PolylineCollection());
    this.#labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
  }

  /**
   * Draw the contacts, their observation markers, and their tracks.
   *
   * IDEMPOTENT AND UPDATE-IN-PLACE. Called on every temporal tick, so rebuilding the collections
   * each time is what DF-X9 section 57 forbids. An existing contact's billboard has its position
   * and rotation written; only genuinely new and genuinely departed contacts touch
   * `BillboardCollection.remove`.
   */
  render(options: {
    contacts: readonly RenderableContact[];
    predicted: readonly PredictedPoint[];
    /** ISO instant the operator is looking at. Never `Date.now()`. */
    referenceTimeIso: string;
    observationMarkers?: readonly {
      mmsi: string;
      lat: number;
      lon: number;
      at: string;
    }[];
    /** The observation singled out by a timeline selection, drawn emphasised. */
    highlightedObservation?: { mmsi: string; at: string } | null;
    /**
     * Per-MMSI ordered observed fixes, used to draw track polylines.
     *
     * `at` is REQUIRED, not decorative: without it the renderer cannot tell an observed interval
     * from a reporting gap, and would draw one confident line through both.
     */
    tracks?: ReadonlyMap<string, ReadonlyArray<{ lat: number; lon: number; at: string }>>;
    visibility?: { contacts?: boolean; tracks?: boolean; predicted?: boolean };
  }): ContactRenderStats {
    const started = performance.now();
    const stats: ContactRenderStats = {
      contacts: 0, billboards: 0, labels: 0, labelsShown: 0, labelsSuppressed: 0,
      reusedBillboards: 0, createdBillboards: 0, removedBillboards: 0, lastBuildMs: 0,
    };

    const frame = cameraFrameFromViewer(this.#viewer);
    /** MMSIs actually given a glyph this pass. The retention key. */
    const drawn = new Set<string>();

    for (const contact of options.contacts) {
      const state = contact.state;
      stats.contacts += 1;

      /*
       * NO POSITION MEANS NO GLYPH -- AND THE PREVIOUS ONE MUST GO.
       *
       * This is a DEFECT THE BROWSER E2E CAUGHT, and it contradicted DF-X9.4A's central claim.
       *
       * DF-X9.4A correctly changed `displayStateOf` so a reference time before a contact's first
       * observation yields `NOT_YET_OBSERVED` with a null position. That fixed the ARITHMETIC. It did
       * not reach the RENDERER: the MMSI was added to `seen` BEFORE the null check, the loop then
       * `continue`d, and the removal pass only drops MMSIs absent from `seen`. So the billboard drawn
       * one tick earlier stayed exactly where it was -- frozen at the vessel's last known position,
       * which is the back-propagation fabrication DF-X9.4A said it had eliminated.
       *
       * The browser probe found it via `engine.drawnAisMmsis()`, which still contained the MMSI:
       *
       *   [FAIL] the glyph is GENUINELY ABSENT from the contacts collection, not merely faded:
       *          engine.drawnAisMmsis() does not contain it
       *
       * So the retained set is keyed on contacts that were ACTUALLY DRAWN, not on contacts that were
       * merely mentioned. A contact with no position is not retained, and its billboard is removed.
       */
      if (state.lat === null || state.lon === null) continue;

      const position = Cartesian3.fromDegrees(state.lon, state.lat);

      /*
       * THE ONE ORIENTATION DECISION, delegated.
       *
       * Glyph selection, stabilisation and screen rotation are decided together by
       * `decideContactGlyph` and consumed here without re-deriving anything. A previous version
       * branched on `hasDirection` in this method, which put a second copy of the decision outside
       * the tested function -- and a mutation of that copy passed the entire suite.
       *
       * So: UNKNOWN stays unknown (the ring, and no rotation at all); the drawn angle is stabilised
       * against the last DRAWN angle so jitter does not twitch the glyph; and the rotation is the
       * geographic bearing projected through the camera, because `rotation = bearing` would treat a
       * screen-space quantity as a compass one.
       */
      const decision = decideContactGlyph({
        degrees: state.orientation.degrees,
        previousDisplayDeg: this.#drawnRotation.get(contact.mmsi) ?? null,
        lat: state.lat,
        lon: state.lon,
        frame,
        maxStepDeg: MAX_ROTATION_STEP_DEG,
        deadbandDeg: ROTATION_DEADBAND_DEG,
      });
      const hasDirection = decision.selection === 'DIRECTIONAL';
      if (decision.displayDegrees !== null) {
        this.#drawnRotation.set(contact.mmsi, decision.displayDegrees);
      }
      const rotation = decision.rotation ?? undefined;

      /*
       * UPDATE IN PLACE. This is the whole performance argument, so it is worth being explicit
       * about what is and is not retained:
       *
       *   RETAINED across ticks  -- the BillboardCollection itself, the Billboard object, and its
       *                              GPU texture. Only `position`, `rotation` and `color` are
       *                              written.
       *   NOT retained           -- the per-tick decision of WHICH glyph image to use. Cesium's
       *                              `Billboard.image` setter re-uploads a texture on assignment, so
       *                              writing it every tick for every contact would re-upload 5,000
       *                              textures per frame.
       *
       * So the image is only assigned when it actually CHANGES -- which is exactly when a contact
       * gains or loses a known orientation. A vessel holding a steady course never re-uploads.
       */
      const image = hasDirection ? glyphImage : unknownGlyphImage;
      const existing = this.#billboards.get(contact.mmsi);

      if (existing !== undefined) {
        // The Billboard OBJECT is retained, not its index. A collection index is invalidated by
        // every `remove`, so holding one and reverse-looking it up later -- which is what picking
        // does -- would select the wrong vessel after the first contact left. Holding the object
        // makes identity structural.
        const changedGlyph = this.#glyphKind.get(contact.mmsi) !== hasDirection;
        existing.position = position;
        if (changedGlyph && image !== undefined) {
          existing.image = image as unknown as string;
          this.#glyphKind.set(contact.mmsi, hasDirection);
        }
        if (rotation !== undefined) existing.rotation = rotation;
        existing.color = colourFor(contact, state.freshness.tier);
        drawn.add(contact.mmsi);
        stats.reusedBillboards += 1;
        continue;
      }

      if (image === undefined) continue;
      const added = this.#contacts.add({
        position,
        image: image as unknown as string,
        // 34 px reads as a vessel at theatre zoom; the previous 8 px point could not carry a
        // direction even in principle.
        width: 34,
        height: 34,
        // Not disabled: DF-X9 section 18 requires contacts behind the globe to disappear rather
        // than show through it. `disableDepthTestDistance: Infinity` on the old point primitive
        // was what let a marker float over the limb.
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
      });
      this.#billboards.set(contact.mmsi, added);
      this.#glyphKind.set(contact.mmsi, hasDirection);
      drawn.add(contact.mmsi);
      stats.createdBillboards += 1;
    }

    /*
     * REMOVE EVERYTHING NOT DRAWN THIS PASS.
     *
     * Keyed on `drawn`, not on "mentioned this pass". A contact that is in the fleet but has no
     * drawable position -- `NOT_YET_OBSERVED`, or no usable fix at all -- is NOT drawn, so its
     * retained billboard must go rather than persist at a stale coordinate.
     */
    for (const [mmsi, billboard] of this.#billboards) {
      if (drawn.has(mmsi)) continue;
      this.#contacts.remove(billboard);
      this.#billboards.delete(mmsi);
      this.#glyphKind.delete(mmsi);
      this.#drawnRotation.delete(mmsi);
      stats.removedBillboards += 1;
    }

    this.#renderLabels(options.contacts, frame, stats);
    this.#highlighted = options.highlightedObservation ?? null;
    this.#renderObservationMarkers(options.observationMarkers ?? [], this.#highlighted);
    this.#renderPredicted(options.predicted);
    this.#renderTracks(options.tracks ?? new Map());
    this.#applyVisibility(options.visibility);

    stats.billboards = this.#contacts.length;
    stats.labels = this.#labels.length;
    stats.lastBuildMs = performance.now() - started;
    this.#lastStats = stats;
    return stats;
  }

  /**
   * Labels, arbitrated.
   *
   * DF-X9 section 35: deterministic, so the same camera and state produce the same labels and the
   * set does not flicker. The selected contact's label always wins a collision, because an operator
   * who selected a contact by name must be able to see it.
   */
  #renderLabels(
    contacts: readonly RenderableContact[],
    frame: ReturnType<typeof cameraFrameFromViewer>,
    stats: ContactRenderStats,
  ): void {
    this.#labels.removeAll();
    // No camera frame means no screen position, and a label whose position cannot be computed is a
    // label that would have to be faked somewhere. Before the first render Cesium reports zero
    // camera axes, and projecting then yields NaN rather than a position.
    if (frame === null) return;

    const claims: LabelClaim[] = [];
    for (const contact of contacts) {
      const state = contact.state;
      if (state.lat === null || state.lon === null) continue;
      const screen = this.#project(state.lon, state.lat);
      // Off-screen or behind the globe: no label. Not clamped to an edge, because a clamped label
      // asserts the contact is somewhere it is not.
      if (screen === null) continue;

      const priority: LabelPriority = contact.selected
        ? 'SELECTED_AIS'
        : contact.associated
          ? 'ASSOCIATED_AIS'
          : 'GENERIC_AIS';
      claims.push({
        id: contact.mmsi,
        priority,
        screen,
        widthPx: 92,
        heightPx: 15,
      });
    }

    const decision = arbitrateLabels(claims);
    stats.labelsShown = decision.shown.length;
    stats.labelsSuppressed = decision.suppressed.length;

    for (const claim of decision.shown) {
      const contact = contacts.find((c) => c.mmsi === claim.id);
      if (!contact) continue;
      const state = contact.state;
      this.#labels.add({
        position: Cartesian3.fromDegrees(state.lon as number, state.lat as number),
        text: labelTextFor(contact),
        font: LABEL_FONT,
        fillColor: colourFor(contact, state.freshness.tier),
        outlineColor: Color.fromCssColorString('#040705'),
        outlineWidth: 2,
        style: 2, // LabelStyle.FILL_AND_OUTLINE
        // Above and to the right of the glyph, so it never covers the bow the operator is reading.
        pixelOffset: new Cartesian2(26, -22),
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.BOTTOM,
        showBackground: true,
        backgroundColor: Color.fromCssColorString('#040705').withAlpha(0.55),
      });
    }
  }

  /**
   * Project a lon/lat to screen pixels, or null when it cannot be drawn.
   *
   * Uses `scene.cartesianToCanvasCoordinates`. An earlier version of this comment described
   * `SceneTransforms.worldToWindowCoordinates`, which is not what the code calls -- and which is not
   * imported at all.
   *
   * Either way a non-null result is NOT sufficient: points behind the camera and points far
   * off-screen both project to coordinates outside the viewport, so an explicit bounds test is
   * required rather than trusting the projection.
   */
  #project(lon: number, lat: number): Cartesian2 | null {
    const scene = this.#viewer.scene;
    const window = this.#viewer.canvas;
    if (!window || window.clientWidth === 0 || window.clientHeight === 0) return null;
    const point = this.#viewer.scene.cartesianToCanvasCoordinates(
      Cartesian3.fromDegrees(lon, lat),
    );
    if (!point) return null;
    if (point.x < 0 || point.y < 0) return null;
    if (point.x > window.clientWidth || point.y > window.clientHeight) return null;
    return point;
  }

  /**
   * The actual recorded fixes, as small inspectable markers.
   *
   * THE HIGHLIGHTED OBSERVATION IS DRAWN DIFFERENTLY, and that is the whole point of threading it
   * through here rather than storing it and hoping. A `highlightedObservation` in the store that no
   * primitive reflects is the "exposed is not reachable" defect a third time, in a field whose name
   * promises exactly this.
   *
   * THE HIGHLIGHT MATCHES ON MMSI **AND** TIMESTAMP. Matching on position would highlight whichever
   * observation happens to sit there, which for a vessel at anchor is several of them at once; and
   * matching on a row index would point at a different observation the moment the archive were read in
   * a different order.
   */
  #renderObservationMarkers(
    markers: ReadonlyArray<{ mmsi: string; lat: number; lon: number; at: string }>,
    highlighted: { mmsi: string; at: string } | null,
  ): void {
    this.#observations.removeAll();
    for (const marker of markers) {
      const isHighlighted =
        highlighted !== null && highlighted.mmsi === marker.mmsi && highlighted.at === marker.at;
      this.#observations.add({
        position: Cartesian3.fromDegrees(marker.lon, marker.lat),
        image: isHighlighted ? HIGHLIGHTED_DOT : OBSERVATION_DOT,
        // Larger AND brighter. Both, because a size change alone is easy to miss on a dense track
        // and a brightness change alone is easy to miss on a dark one.
        width: isHighlighted ? 15 : 7,
        height: isHighlighted ? 15 : 7,
        color: (isHighlighted ? COLOUR_SELECTED : COLOUR_CONTACT).withAlpha(
          isHighlighted ? 1 : 0.85,
        ),
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
      });
    }
  }

  /** MMSI + timestamp of the observation currently drawn as highlighted, or null. */
  get highlightedObservation(): { mmsi: string; at: string } | null {
    return this.#highlighted;
  }

  /**
   * The analytical predicted positions.
   *
   * Its OWN collection, so `AIS_PREDICTED` can be toggled without touching the observed contacts
   * or their tracks. DF-X9.3D exists because `AIS_PREDICTED` shared a renderer with `AIS_TRACKS`
   * and could only be distinguished by entity NAME, which made it an inert toggle in practice:
   * the only caller passed `predicted = null`.
   *
   * Drawn as a HOLLOW DIAMOND rather than a filled shape, so the distinction from an observed
   * contact survives greyscale, colour-vision deficiency and a screenshot in a report. Colour
   * alone is not an encoding.
   */
  #renderPredicted(points: readonly PredictedPoint[]): void {
    this.#predicted.removeAll();
    for (const point of points) {
      this.#predicted.add({
        position: Cartesian3.fromDegrees(point.lon, point.lat),
        image: PREDICTED_DIAMOND,
        width: 22,
        height: 22,
        color: COLOUR_PREDICTED.withAlpha(0.95),
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
      });
    }
  }

  /**
   * Observed track segments.
   *
   * SEGMENTED AGAINST THE INTERPOLATION INTERVAL, NOT DRAWN AS ONE LINE.
   *
   * A first version of this renderer added a single polyline through every fix, guarded only by
   * `fixes.length < 2`. That reproduces the exact defect `segmentTrack` in `displayState.ts` was
   * written to prevent, and it was reproduced while the correct implementation sat unused with no
   * production caller. A two-hour hole in a vessel's reporting rendered as confidently as a
   * two-minute interval, which is a claim about data the product does not have.
   *
   * `segmentTrack` returns `OBSERVED` stretches and explicit `GAP` segments. Only the observed
   * stretches become polylines. A gap is drawn as a short dashed connector so the break is VISIBLE
   * -- the operator can see that the track stopped -- rather than the line silently ceasing with no
   * indication that anything was missed.
   */
  #renderTracks(
    tracks: ReadonlyMap<string, ReadonlyArray<{ lat: number; lon: number; at: string }>>,
  ): void {
    this.#track.removeAll();
    this.#gaps = [];

    for (const [mmsi, fixes] of tracks) {
      /*
       * BUILT BY `buildTrack`, NOT BY HAND.
       *
       * This method used to slice the fixes itself and call `segmentTrack` on a hand-shaped object
       * array. That put the gap rule in the RENDERER while the authoritative implementation lived in
       * `trackBuilder`, so there were two places deciding whether an interval was joinable, and they
       * would eventually disagree -- producing a glyph that refuses to interpolate across an
       * interval its own track draws as solid.
       *
       * The renderer now CONSUMES the segment model. It decides nothing about evidence; it only
       * decides how each segment is DRAWN.
       */
      const build = buildTrack(
        fixes.map((fix) => ({
          timestamp: fix.at,
          mmsi,
          lat: fix.lat,
          lon: fix.lon,
          sog: null,
          cog: null,
          heading: null,
          ship_name: null,
          source: null,
        })),
      );

      /*
       * ONE OBSERVATION IS EVIDENCE, NOT A TRACK.
       *
       * No polyline is drawn -- there is nothing to connect. The observation MARKER still draws from
       * `#renderObservationMarkers`, because dropping the only position a contact has would lose real
       * evidence. The count is exported so the UI can say '1 OBSERVATION' rather than implying a
       * track exists and is merely invisible.
       */
      if (build.status !== 'TRACK') continue;

      for (const segment of build.segments) {
        /*
         * ANTIMERIDIAN SPLIT, HERE AND ONLY HERE.
         *
         * A segment crossing +/-180 must be drawn as SEPARATE polylines. `Cartesian3.fromDegrees`
         * normalises longitude into [-180, 180] whatever value it is handed, so unwrapping cannot
         * help and one polyline across a crossing becomes a line around the world.
         *
         * Each display run is a contiguous slice and the concatenation reproduces the segment exactly:
         * no point reordered, dropped or duplicated, stored coordinates untouched.
         */
        for (const run of displayRunsFor(segment)) {
          if (run.length < 2) continue;
          const positions = run.map((point) => Cartesian3.fromDegrees(point.lon, point.lat));

          if (segment.kind === 'GAP') {
            /*
             * A GAP IS DRAWN BROKEN AND RECORDED AS A GAP.
             *
             * Dashes are the point: colour alone is not an encoding (DF-X9.4 section 46). And the gap
             * is RECORDED so the browser E2E can count it -- counting is what distinguishes a break
             * from a solid line, because a gap connector is still exactly one polyline. That length
             * ambiguity is precisely why the DF-X9.3E finding "the track polyline crosses the gap
             * unbroken" could not be settled by measurement the first time.
             */
            this.#track.add({
              positions,
              width: 1.5,
              /*
               * `Material.fromType('PolylineDash')`, not a colour. The dash IS the encoding: the
               * segment's endpoints are real observations and everything between them is missing, and
               * a tinted solid line still reads as continuous observation to anyone not told
               * otherwise. Colour alone is not an encoding.
               */
              material: Material.fromType('PolylineDash', {
                color: COLOUR_STALE.withAlpha(0.7),
                gapColor: Color.TRANSPARENT,
                gapAlpha: 0,
                dashLength: 12,
              }),
            });
            this.#gaps.push({
              mmsi,
              from: { lat: segment.points[0].lat, lon: segment.points[0].lon },
              to: {
                lat: segment.points[segment.points.length - 1].lat,
                lon: segment.points[segment.points.length - 1].lon,
              },
              spanSeconds: segment.spanSeconds,
            });
            continue;
          }

          this.#track.add({
            positions,
            color: COLOUR_CONTACT.withAlpha(0.75),
            width: 2,
          });
        }
      }
    }
  }

  /**
   * Every gap currently drawn, for the browser E2E.
   *
   * Exposed so DF-X9.4 section 68 is provable by COUNT rather than by looking at a screenshot, which
   * is the only way a break can be distinguished from a solid line of the same length.
   */
  get gaps(): ReadonlyArray<{
    mmsi: string;
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
    spanSeconds: number | null;
  }> {
    return [...this.#gaps];
  }

  #applyVisibility(
    visibility: { contacts?: boolean; tracks?: boolean; predicted?: boolean } | undefined,
  ): void {
    if (!visibility) return;
    if (visibility.contacts !== undefined) {
      this.#contacts.show = visibility.contacts;
      this.#labels.show = visibility.contacts;
    }
    if (visibility.tracks !== undefined) {
      this.#track.show = visibility.tracks;
      this.#observations.show = visibility.tracks;
    }
    if (visibility.predicted !== undefined) this.#predicted.show = visibility.predicted;
  }

  /**
   * Apply layer visibility alone, with no render.
   *
   * SEPARATE FROM `render` ON PURPOSE. A layer toggle must not rebuild geometry: it changes one
   * boolean per collection, and nothing else. Routing a toggle through `render` would re-project
   * every label, re-upload any glyph whose image changed, and re-add every polyline -- which is
   * exactly the churn DF-X9 section 57 forbids for a time tick and would be worse for a toggle the
   * operator may flick rapidly.
   */
  setVisibility(visibility: {
    contacts?: boolean;
    tracks?: boolean;
    predicted?: boolean;
  }): void {
    this.#applyVisibility(visibility);
  }

  /** Exposed for the browser E2E and the performance harness. */
  get stats(): ContactRenderStats {
    return { ...this.#lastStats, billboards: this.#contacts.length, labels: this.#labels.length };
  }

  /**
   * The MMSI whose billboard is a given `Billboard`.
   *
   * Takes the OBJECT rather than an index, because a collection index is invalidated by every
   * `remove`: reverse-mapping a stale index would silently select the wrong vessel, which is the
   * defect DF-X9 section 34 forbids by requiring stable identity.
   *
   * NO CALLER YET. Globe picking is still wired to `viewer.entities` targets only, so AIS contacts
   * are not clickable on the globe -- that is a real gap, recorded rather than papered over, and
   * this method is the seam it will use. An earlier version of this comment claimed a pick handler
   * already called it, which was not true.
   */
  mmsiOf(billboard: unknown): string | null {
    for (const [mmsi, retained] of this.#billboards) {
      if (retained === billboard) return mmsi;
    }
    return null;
  }

  /**
   * Observation markers currently drawn.
   *
   * A COUNT and not the collection, so no raw Cesium object escapes this class. DF-X9.4H section 7 is
   * explicit that the product surface exposes typed domain state; handing out a BillboardCollection
   * would let a consumer mutate the renderer's internals through a diagnostic getter, which is the
   * reachability fix reintroduced as a write hole.
   */
  drawnObservationCount(): number {
    return this.#observations.length;
  }

  /** Track polylines currently drawn, including gap connectors. */
  drawnTrackPrimitiveCount(): number {
    return this.#track.length;
  }

  /** Predicted markers currently drawn. */
  drawnPredictedCount(): number {
    return this.#predicted.length;
  }

  /** All MMSIs currently drawn, in stable MMSI order. For the browser E2E. */
  drawnMmsis(): string[] {
    return [...this.#billboards.keys()].sort();
  }

  destroy(): void {
    this.#contacts.destroy();
    this.#labels.destroy();
    this.#observations.destroy();
    this.#track.destroy();
    this.#predicted.destroy();
    this.#billboards.clear();
    // All THREE per-contact maps, not two. A first version cleared `#billboards` and
    // `#drawnRotation` and left `#glyphKind`, while the engine's own teardown comment justifies
    // explicit destruction precisely by "a per-contact Map".
    this.#glyphKind.clear();
    this.#drawnRotation.clear();
    this.#gaps = [];
  }
}

/* ============================================================================================== *
 * APPEARANCE
 * ============================================================================================== */

function colourFor(contact: RenderableContact, freshness: Freshness): Color {
  if (contact.selected) return COLOUR_SELECTED;
  // A stale or lost contact is drawn in a desaturated tone. Not hidden, and not alarming: the
  // operator should still see it, and DF-X9 section 28 forbids implying the transmitter is off.
  if (freshness === 'STALE' || freshness === 'LOST') return COLOUR_STALE;
  return COLOUR_CONTACT;
}

function labelTextFor(contact: RenderableContact): string {
  const state = contact.state;
  const reported = state.reported;
  /*
   * NO ZERO PLACEHOLDERS, EVER.
   *
   * A vessel that reported no course must not render "COG 0" -- 0 degrees is a real course, due
   * north, and writing it here would put the analytical defect straight back into the visual
   * layer. `NOT ESTABLISHED` is the product's existing vocabulary for a measurement nobody made.
   */
  const cog = reported?.cogDegrees ?? null;
  const sog = reported?.sogKnots ?? null;
  const parts: string[] = [contact.mmsi];
  if (cog !== null) parts.push(`${Math.round(cog)}°`);
  else parts.push('NOT ESTABLISHED');
  if (sog !== null) parts.push(`${sog.toFixed(1)} kn`);
  return parts.join(' · ');
}

/* ============================================================================================== *
 * SMALL CANVAS ICONS
 * ============================================================================================== */

function makeIcon(draw: (ctx: CanvasRenderingContext2D, size: number) => void): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  draw(ctx, size);
  return canvas;
}

/**
 * The highlighted observation: a ring around the dot.
 *
 * A DIFFERENT SHAPE, not just a bigger brighter dot. Colour and size alone would leave the highlight
 * indistinguishable in greyscale or to a colour-vision-deficient reader, and the outer ring reads as
 * "selected" without depending on either.
 */
const HIGHLIGHTED_DOT = makeIcon((ctx, size) => {
  const mid = size / 2;
  ctx.beginPath();
  ctx.arc(mid, mid, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#040705';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mid, mid, 13, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
});

/** A small filled dot: an actual recorded observation. */
const OBSERVATION_DOT = makeIcon((ctx, size) => {
  const mid = size / 2;
  ctx.beginPath();
  ctx.arc(mid, mid, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#040705';
  ctx.stroke();
});

/**
 * A hollow diamond: a predicted position.
 *
 * HOLLOW and a different SHAPE from the observed dot, deliberately. The two must be
 * distinguishable without colour, because a screenshot has to carry the distinction and a printed
 * report has none.
 */
const PREDICTED_DIAMOND = makeIcon((ctx, size) => {
  const mid = size / 2;
  ctx.beginPath();
  ctx.moveTo(mid, 4);
  ctx.lineTo(size - 4, mid);
  ctx.lineTo(mid, size - 4);
  ctx.lineTo(4, mid);
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#040705';
  ctx.stroke();
});