/**
 * Tests for the AIS contact renderer.
 *
 * The renderer draws. It must never compute correlation, match acceptance, Ghost Vessel
 * classification, or the analytical predicted SAR position -- those are backend-authoritative and
 * read from the scan record. Several tests below assert that boundary directly, because a
 * renderer that quietly grew a dead-reckoning projection would be indistinguishable from the
 * analytical one on screen.
 *
 * The glyph, orientation, drawability and label arbitration arithmetic is NOT tested here. That
 * lives in `glyphGeometry.test.ts` and `displayState.test.ts`, where it can be checked as pure
 * mathematics without a WebGL context. What is tested here is the renderer's OWN responsibilities:
 * collection ownership, retained identity, layer independence, and the vocabulary it renders.
 */

import { describe, expect, it } from 'vitest';

import type { RenderableContact } from './aisRenderer';
import {
  decideContactGlyph,
  selectGlyph,
  type GlyphDecision,
} from './aisRenderer';
import { cameraFrameFromViewer, glyphScreenRotation, localFrameDeg } from './glyphGeometry';
import {
  MAX_INTERPOLATION_INTERVAL_S,
  displayStateOf,
  predictedDisplayState,
  segmentTrack,
  type DisplayContactState,
} from '../ais/displayState';

/* ------------------------------------------------------------------ glyph-decision helpers */

/**
 * A north-up camera frame at the contact, for the rotation helper.
 *
 * Supplied rather than read from a live viewer, because `cameraFrameFromViewer` needs Cesium and the
 * decision under test -- which glyph, and whether a rotation exists at all -- does not.
 */
const FRAME = (() => {
  const { east, north } = localFrameDeg(1.0, 103.0);
  return { right: east, up: north } as never;
})();

/** The glyph decision the renderer would make for a contact built from these observations. */
function decideFor(input: {
  series: ReturnType<typeof observation>[];
  atTimeIso: string;
}): GlyphDecision {
  const state = displayStateOf(input.series, input.atTimeIso);
  return decideContactGlyph({
    degrees: state.orientation.degrees,
    previousDisplayDeg: null,
    lat: state.lat ?? 0,
    lon: state.lon ?? 0,
    frame: FRAME,
    maxStepDeg: 6,
    deadbandDeg: 2,
  });
}

/* ------------------------------------------------------------------ fixtures */

const T0 = '2026-03-01T12:00:00Z';
const at = (minutes: number): string =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();
/** A timestamp `seconds` after T0. Written as a function because string + number concatenates. */
const atSeconds = (seconds: number): string =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();

function observation(over: Partial<Parameters<typeof displayStateOf>[0][number]> = {}) {
  return {
    timestamp: T0,
    mmsi: '257000000',
    lat: 1.0,
    lon: 103.0,
    sog: null,
    cog: null,
    heading: null,
    nav_status: null,
    ship_name: null,
    callsign: null,
    imo: null,
    ship_type: null,
    length_m: null,
    width_m: null,
    source: 'aistream',
    ...over,
  };
}

function contact(
  mmsi: string,
  series: ReturnType<typeof observation>[],
  atTimeIso: string,
  flags: { selected?: boolean; associated?: boolean } = {},
): RenderableContact {
  return {
    mmsi,
    state: displayStateOf(series, atTimeIso) as DisplayContactState,
    selected: flags.selected ?? false,
    associated: flags.associated ?? false,
  };
}

/* ================================================================================================
 * COLLECTION OWNERSHIP
 * ============================================================================================== */

describe('collection ownership', () => {
  it('the renderer declares five separate collections, one per AIS layer concern', () => {
    // DF-X9 section 23. Contacts, labels, observation markers, tracks and predicted markers each
    // get their own. Sharing is what made `AIS_PREDICTED` inseparable from `AIS_TRACKS` before.
    //
    // Asserted on the source rather than at runtime, because a live check would need a real
    // WebGL context and this is a structural property: the numbers cannot drift.
    const collections = [
      'this.#contacts =',
      'this.#labels =',
      'this.#observations =',
      'this.#track =',
      'this.#predicted =',
    ];
    for (const declaration of collections) {
      expect(AIS_RENDERER_CODE).toContain(declaration);
    }
  });

  it('no AIS collection is created inside the per-tick render path', () => {
    // The collection-churn requirement. Building a collection per tick reallocates every GPU
    // buffer per frame; at 5,000 contacts that is the difference between smooth and stuttering.
    const renderBody = AIS_RENDERER_CODE.slice(
      AIS_RENDERER_CODE.indexOf('render(options:'),
      AIS_RENDERER_CODE.indexOf('Labels, arbitrated'),
    );
    for (const ctor of ['new BillboardCollection(', 'new LabelCollection(', 'new PolylineCollection(']) {
      expect(renderBody).not.toContain(ctor);
    }
  });

  it('the AIS collections are not shared with any other engine array', () => {
    // DF-X8 had to fix exactly this: `uncertainty` and `correlation` once shared one array, so a
    // toggle of one cleared the other. The names must be private to this renderer.
    expect(AIS_RENDERER_CODE).not.toMatch(/#uncertainty/);
    expect(AIS_RENDERER_CODE).not.toMatch(/#link/);
    expect(AIS_RENDERER_CODE).not.toMatch(/#coastline/);
    expect(AIS_RENDERER_CODE).not.toMatch(/#eez/);
  });
});

/* ================================================================================================
 * CONTACT IDENTITY
 * ============================================================================================== */

describe('contact identity', () => {
  it('contacts are keyed by MMSI', () => {
    expect(AIS_RENDERER_CODE).toContain('#billboards = new Map<string, Billboard>()');
    expect(AIS_RENDERER_CODE).toContain('this.#billboards.set(contact.mmsi');
  });

  it('the retained object is the Billboard, never a collection index', () => {
    // A collection index is invalidated by every `remove`. Holding one and reverse-looking it up
    // later -- which picking does -- would select the wrong vessel after the first departure.
    expect(AIS_RENDERER_CODE).toContain('new Map<string, Billboard>()');
    // Scoped to the declaration site, because `Map<string, number>` appears elsewhere for
    // legitimately numeric maps -- asserting on the whole file would be asserting on unrelated
    // code.
    const declaration = AIS_RENDERER_CODE.slice(
      AIS_RENDERER_CODE.indexOf('#billboards ='),
      AIS_RENDERER_CODE.indexOf('#glyphKind ='),
    );
    expect(declaration).toContain('new Map<string, Billboard>()');
    expect(declaration).not.toContain('number');
  });

  it('identity survives a contact leaving and another arriving', () => {
    // Ordering is irrelevant: a contact's identity comes from its MMSI, not its position in the
    // list it happened to arrive in.
    const series = [observation({ mmsi: '257000001' }), observation({ mmsi: '257000002' })];
    const a = contact('257000001', series, T0);
    const b = contact('257000002', series, T0);
    expect(a.mmsi).not.toBe(b.mmsi);
    // Reversing the input order must not change either identity.
    expect(contact('257000001', series, T0).mmsi).toBe('257000001');
    expect(contact('257000002', series, T0).mmsi).toBe('257000002');
  });
});

/* ================================================================================================
 * DISPLAY STATE PASSED THROUGH, NOT RECOMPUTED
 * ============================================================================================== */

describe('the renderer consumes display state rather than deriving it', () => {
  it('takes its state from displayState, so the renderer cannot invent one', () => {
    // The renderer has no interpolation or staleness logic of its own. Everything temporal arrives
    // in `DisplayContactState`, which carries its own provenance.
    expect(AIS_RENDERER_CODE).not.toMatch(/Date\.now\(\)/);
    expect(AIS_RENDERER_CODE).toContain('DisplayContactState');
  });

  it('an observed state arrives at the observation coordinates exactly', () => {
    // DF-X9 section 25. No smoothing offset, no averaging, no prediction.
    const series = [observation({ lat: 1.0, lon: 103.0 })];
    const state = displayStateOf(series, at(0));
    expect(state.state).toBe('OBSERVED');
    expect(state.lat).toBe(1.0);
    expect(state.lon).toBe(103.0);
  });

  it('an interpolated state still carries both source observations', () => {
    // DF-X9 section 26. The renderer's input is traceable back to the measurements it came from.
    const series = [observation({ timestamp: at(0), lat: 1.0 }), observation({ timestamp: at(4), lat: 1.004 })];
    const state = displayStateOf(series, at(2));
    expect(state.state).toBe('INTERPOLATED_DISPLAY');
    expect(state.sourceObservationTimestamps).toEqual([at(0), at(4)]);
  });

  it('a predicted point is a separate state and carries no source observations', () => {
    // DF-X9 section 27. The prediction is passed in from the backend and drawn as its own
    // geometry. It is never an animated contact.
    const series = [observation({ timestamp: at(0), lat: 1.0, sog: 10, cog: 90 })];
    const predicted = predictedDisplayState('257000000', { lat: 1.05, lon: 103.0 }, series, at(4));
    expect(predicted.state).toBe('PREDICTED');
    expect(predicted.sourceObservationTimestamps).toEqual([]);
  });

  it('the renderer never derives a predicted position itself', () => {
    // The frontend science boundary. A client-side dead-reckoning projection would be a second
    // prediction competing with the analytical one.
    // No `propagate`-shaped arithmetic: no distance-from-speed, no course-to-bearing projection.
    expect(AIS_RENDERER_CODE).not.toMatch(/KNOTS_TO_MPS|0\.51444/);
    expect(AIS_RENDERER_CODE).toContain('PredictedPoint');
  });
});

/* ================================================================================================
 * LABEL VOCABULARY
 * ============================================================================================== */

describe('label vocabulary', () => {
  it('an absent course renders NOT ESTABLISHED, never 0 degrees', () => {
    // DF-X9 section 17. This is the visual half of the analytical fix: `COG 0` would assert a real
    // course due north, putting the defect straight back into the interface.
    const state = displayStateOf([observation({ timestamp: at(0) })], at(0));
    expect(state.reported!.cogDegrees).toBeNull();
    // The renderer reads `cogDegrees ?? null` and only formats a number when there is one.
    expect(state.reported!.cogDegrees).not.toBe(0);
  });

  it('a measured zero course stays zero', () => {
    const state = displayStateOf([observation({ timestamp: at(0), cog: 0, sog: 5 })], at(0));
    expect(state.reported!.cogDegrees).toBe(0);
  });

  it('the label renderer only formats numbers it actually has', () => {
    // The `?? null` guard is the mechanism, and it is asserted here because the alternative --
    // formatting `undefined` -- produces "NaN" in the interface rather than an absence.
    expect(AIS_RENDERER_CODE).toContain('reported?.cogDegrees ?? null');
    expect(AIS_RENDERER_CODE).toContain('NOT ESTABLISHED');
  });

  it('never renders a bare zero for an absent measurement', () => {
    // A template literal that formats a possibly-null value would produce "null" or "NaN". The
    // label is assembled from explicitly guarded parts, so it cannot.
    const start = AIS_RENDERER_CODE.indexOf('function labelTextFor');
    const labelBody = AIS_RENDERER_CODE.slice(start, AIS_RENDERER_CODE.indexOf('function makeIcon', start));
    expect(labelBody).toContain('cog !== null');
    expect(labelBody).toContain('sog !== null');
  });
});

/* ================================================================================================
 * VISUAL VOCABULARY
 * ============================================================================================== */

describe('retention is keyed on contacts actually DRAWN', () => {
  /*
   * THE DEFECT THE BROWSER E2E CAUGHT, AND THE ONE A UNIT TEST HAD TO BE BUILT FOR.
   *
   * The renderer used to add each MMSI to `seen` BEFORE the null-position check, `continue` past a
   * contact with no drawable position, and then remove only the MMSIs absent from `seen`. So a
   * contact in `NOT_YET_OBSERVED` kept the billboard drawn one tick earlier, frozen at its last known
   * position.
   *
   * That is not a styling detail. It is the back-propagation fabrication DF-X9.4A claimed to have
   * eliminated, still on screen: the display-state arithmetic was fixed and the renderer kept drawing
   * the old answer. The probe caught it via `engine.drawnAisMmsis()` still listing the MMSI.
   *
   * The bug was in the ORDER of two operations in a loop that needs a Viewer to run, so it cannot be
   * observed from a unit test directly. What CAN be pinned is the retention invariant the fix rests
   * on, stated so a future edit that reintroduces the ordering breaks it.
   */
  it('the retained set is named `drawn`, not `seen`', () => {
    // A name that says what it means. `seen` invites exactly the bug that happened: "was mentioned"
    // is not "was drawn".
    expect(AIS_RENDERER_CODE).toContain('const drawn = new Set<string>()');
    expect(AIS_RENDERER_CODE).not.toMatch(/const seen = new Set/);
  });

  it('the null-position check PRECEDES any retention bookkeeping', () => {
    // The ordering IS the defect. If a MMSI is recorded as drawn before its position is known to
    // exist, the removal pass can never reclaim its billboard.
    const loop = AIS_RENDERER_CODE.slice(
      AIS_RENDERER_CODE.indexOf('stats.contacts += 1'),
      AIS_RENDERER_CODE.indexOf('Remove everything not drawn'),
    );
    const nullCheck = loop.indexOf('state.lat === null || state.lon === null');
    const firstRetention = loop.indexOf('drawn.add(');
    expect(nullCheck).toBeGreaterThan(-1);
    expect(firstRetention).toBeGreaterThan(-1);
    expect(nullCheck).toBeLessThan(firstRetention);
  });

  it('removal is keyed on `drawn`, so an undrawn contact loses its billboard', () => {
    expect(AIS_RENDERER_CODE).toMatch(/if \(drawn\.has\(mmsi\)\) continue;/);
  });

  it('a state with NO POSITION is a real, reachable state, not a hypothetical', () => {
    // The premise of the whole fix. If `displayStateOf` could never return a null position, the
    // renderer bug would be unreachable and this test would be guarding nothing.
    const state = displayStateOf([observation({ timestamp: at(8) })], at(0));
    expect(state.state).toBe('NOT_YET_OBSERVED');
    expect(state.lat).toBeNull();
    expect(state.lon).toBeNull();
  });

  it('the engine FORWARDS the gap record, rather than exposing it where nothing holds a reference', () => {
    /*
     * `get gaps()` existed on AisContactRenderer and the commit claimed it made DF-X9.4 section 68
     * provable "by COUNT". The E2E reported it unreachable, which is correct: a getter on an object
     * nobody holds a reference to is a comment about one, not a verification affordance.
     *
     * This asserts the ENGINE forwards it -- the second time in two checkpoints that "exposed" was
     * mistaken for "reachable".
     */
    expect(ENGINE_SOURCE).toMatch(/get aisGaps\(/);
    expect(ENGINE_SOURCE).toContain('this.#aisRenderer?.gaps ?? []');
  });
});

describe('gap segmentation', () => {
  /*
   * THE DEFECT THIS GUARDS.
   *
   * The renderer's first version added ONE polyline through every fix, guarded only by
   * `fixes.length < 2`. That reproduces the exact defect `segmentTrack` was written to prevent --
   * a two-hour reporting hole rendered as confidently as a two-minute interval -- while the correct
   * implementation sat in `displayState.ts` with NO production caller at all.
   *
   * A gap must be a visible break. Asserted through `segmentTrack`, which is what the renderer calls,
   * so removing the call from the renderer is a mutation this suite cannot see -- but REMOVING the
   * segmentation from `segmentTrack` is, and that is the behaviour that matters.
   */
  it('two well-spaced fixes are one continuous observed segment', () => {
    const segments = segmentTrack([
      { timestamp: at(0), mmsi: 'm', lat: 1.0, lon: 103.0 },
      { timestamp: at(4), mmsi: 'm', lat: 1.004, lon: 103.0 },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('OBSERVED');
    expect(segments[0].points).toHaveLength(2);
  });

  it('a gap beyond the interpolation interval BREAKS the track', () => {
    const gapAt = MAX_INTERPOLATION_INTERVAL_S + 1800;
    const segments = segmentTrack([
      { timestamp: at(0), mmsi: 'm', lat: 1.0, lon: 103.0 },
      { timestamp: at(4), mmsi: 'm', lat: 1.004, lon: 103.0 },
      { timestamp: atSeconds(gapAt), mmsi: 'm', lat: 2.0, lon: 104.0 },
      { timestamp: atSeconds(gapAt + 240), mmsi: 'm', lat: 2.004, lon: 104.0 },
    ]);
    // Two observed stretches AND an explicit gap: the break is represented, not smoothed over.
    expect(segments.filter((s) => s.kind === 'OBSERVED')).toHaveLength(2);
    expect(segments.filter((s) => s.kind === 'GAP')).toHaveLength(1);
  });

  it('the renderer CONSUMES the segment model rather than deciding gaps itself', () => {
    /*
     * UPDATED BY DF-X9.4B->C: this previously pinned `segmentTrack(`, which the renderer no longer
     * calls. The rename hides the real change, which is WHY the call changed.
     *
     * The renderer used to slice the fixes itself and call `segmentTrack` on a hand-shaped array.
     * That put the gap rule in TWO places -- the renderer and `trackBuilder` -- and two places
     * deciding whether an interval was joinable would eventually disagree, producing a glyph that
     * refuses to interpolate across an interval its own track draws as solid.
     *
     * So the renderer now consumes `buildTrack`, the single authority, and `displayRunsFor` for the
     * antimeridian split. A behavioural test cannot reach `render` without a WebGL context, so this
     * is what holds the CALLS in place; the tests above hold the BEHAVIOUR they delegate to.
     */
    expect(AIS_RENDERER_CODE).toContain('buildTrack(');
    expect(AIS_RENDERER_CODE).toContain('displayRunsFor(');

    // And the gap rule is NOT reimplemented in the renderer: no second threshold.
    const trackBody = AIS_RENDERER_CODE.slice(
      AIS_RENDERER_CODE.indexOf('renderTracks('),
      AIS_RENDERER_CODE.indexOf('get gaps'),
    );
    expect(trackBody).not.toMatch(/MAX_INTERPOLATION_INTERVAL_S/);
    expect(trackBody).not.toMatch(/spanSeconds\s*<=\s*/);
    // Nor a whole-track polyline built from the raw fixes.
    expect(trackBody).not.toMatch(/points: fixes/);
  });

  it('a gap is drawn DASHED, not merely tinted', () => {
    // Colour alone is not an encoding (DF-X9.4 section 46). A tinted solid line still reads as
    // continuous observation to anyone not told otherwise, and the endpoints are real fixes with
    // everything between them missing.
    expect(AIS_RENDERER_CODE).toContain("Material.fromType('PolylineDash'");
    expect(AIS_RENDERER_CODE).toContain('dashLength');
  });
});

describe('visual vocabulary carries the temporal state', () => {
  it('the UNKNOWN-orientation glyph is a ring, not a north-pointing chevron', () => {
    /*
     * A FIRST VERSION OF THIS TEST WAS VACUOUS, AND A MUTATION PROVED IT.
     *
     * It asserted the renderer's source text contained `unknownGlyphImage` and `if (hasDirection)
     * {`. Forcing `hasDirection` to be permanently true -- so the ring is never drawn and every
     * contact points north -- left BOTH strings present and the suite green, 33/33.
     *
     * That is the visual half of DF-X9 section 17 going completely unguarded, caught only by
     * mutation testing rather than by reading. The assertion below is behavioural: it builds a
     * contact with no orientation and checks the GLYPH SELECTION that comes out, rather than
     * checking that a variable name appears in the file.
     */
    expect(decideFor({ series: [observation({ timestamp: at(0) })], atTimeIso: at(0) }).selection)
      .toBe('UNKNOWN');
    // And a contact WITH an orientation gets the directional glyph.
    expect(
      decideFor({
        series: [observation({ timestamp: at(0), sog: 9, cog: 45 })],
        atTimeIso: at(0),
      }).selection,
    ).toBe('DIRECTIONAL');
  });

  it('an UNKNOWN contact carries no rotation at all', () => {
    // Not merely a different image: NO rotation is produced. A rotated ring tells the operator
    // nothing, but a chevron inheriting a stale rotation would tell them something false.
    const decision = decideFor({ series: [observation({ timestamp: at(0) })], atTimeIso: at(0) });
    expect(decision.selection).toBe('UNKNOWN');
    expect(decision.displayDegrees).toBeNull();
    expect(decision.rotation).toBeNull();
  });

  it('a MEASURED ZERO course is DIRECTIONAL, not UNKNOWN', () => {
    // Course 0 is due north: a real measurement. Swallowing it into UNKNOWN would discard a real
    // observation, which is the mirror-image of the defect this whole model prevents.
    expect(
      decideFor({
        series: [observation({ timestamp: at(0), sog: 9, cog: 0, heading: 0 })],
        atTimeIso: at(0),
      }).selection,
    ).toBe('DIRECTIONAL');
    // And it produces a real rotation, pointing the glyph north.
    expect(
      decideFor({
        series: [observation({ timestamp: at(0), sog: 9, cog: 0, heading: 0 })],
        atTimeIso: at(0),
      }).rotation,
    ).not.toBeNull();
  });

  it('losing the heading produces NO rotation rather than a stale one', () => {
    // The case a per-field check cannot catch: a vessel that reported a course and then stops.
    // `previousDisplayDeg` is the angle last DRAWN, and it must not be carried into an unknown state.
    const first = decideContactGlyph({
      degrees: 90, previousDisplayDeg: null, lat: 1, lon: 103, frame: FRAME,
      maxStepDeg: 6, deadbandDeg: 2,
    });
    expect(first.selection).toBe('DIRECTIONAL');
    const lost = decideContactGlyph({
      degrees: null, previousDisplayDeg: first.displayDegrees, lat: 1, lon: 103, frame: FRAME,
      maxStepDeg: 6, deadbandDeg: 2,
    });
    expect(lost.rotation).toBeNull();
    expect(lost.displayDegrees).toBeNull();
  });

  it('a predicted marker is hollow and a different SHAPE from an observed one', () => {
    // DF-X9 section 29. The distinction must survive greyscale and colour-vision deficiency, so it
    // is carried by shape as well as colour rather than by colour alone.
    expect(AIS_RENDERER_CODE).toContain('PREDICTED_DIAMOND');
    expect(AIS_RENDERER_CODE).toContain('OBSERVATION_DOT');
    // The distinction is carried by SHAPE, not by colour alone, so it survives greyscale and a
    // printed report. An observed marker is a filled circle (`arc` + `fill`); a predicted one is a
    // stroked diamond (four `lineTo` vertices, no fill).
    expect(AIS_RENDERER_CODE).toMatch(/ctx\.fill\(\)/);
    const diamond = AIS_RENDERER_CODE.slice(
      AIS_RENDERER_CODE.indexOf('const PREDICTED_DIAMOND'),
    );
    expect(diamond).toMatch(/lineTo\(size - 4, mid\)/);
    expect(diamond).not.toMatch(/ctx\.fill\(\)/);
  });

  it('carries no threat or suspicion semantics', () => {
    // DF-X9 section 15. DarkFleet classifies radar returns; nothing in an AIS renderer establishes
    // intent, and a colour palette implying otherwise would be a claim the product cannot support.
    expect(AIS_RENDERER_CODE).not.toMatch(/threat|danger|hostile|suspicious|enemy/i);
    expect(AIS_RENDERER_CODE).not.toMatch(/#FF0000|#FF3333|#DC143C/);
  });

  it('a stale contact is desaturated, not hidden and not alarming', () => {
    // DF-X9 sections 33 and 28. The operator should still see a contact that has gone quiet, and
    // the styling must not imply the transmitter was switched off.
    expect(AIS_RENDERER_CODE).toContain('COLOUR_STALE');
    expect(AIS_RENDERER_CODE).toMatch(/freshness === 'STALE' \|\| freshness === 'LOST'/);
  });
});

/* ================================================================================================
 * LAYER INDEPENDENCE
 * ============================================================================================== */

describe('layer independence', () => {
  it('each AIS collection is toggled by exactly one layer id', () => {
    // DF-X9 sections 28 and 49. The permanent regression after DF-X8's shared-storage defect.
    expect(AIS_RENDERER_CODE).toContain("visibility.contacts !== undefined");
    expect(AIS_RENDERER_CODE).toContain("visibility.tracks !== undefined");
    expect(AIS_RENDERER_CODE).toContain("visibility.predicted !== undefined");
  });

  it('toggling contacts leaves tracks and predicted alone', () => {
    // Asserted on the guard structure: each visibility flag is applied under its own `if`, with
    // no fall-through and no shared branch, so a false for one cannot clear another.
    const applyStart = AIS_RENDERER_CODE.indexOf('applyVisibility(');
    const applyBody = AIS_RENDERER_CODE.slice(
      applyStart,
      AIS_RENDERER_CODE.indexOf('Exposed for the browser E2E'),
    );
    const contactsBlock = applyBody.slice(
      applyBody.indexOf('if (visibility.contacts'),
      applyBody.indexOf('if (visibility.tracks'),
    );
    expect(contactsBlock).not.toContain('#track');
    expect(contactsBlock).not.toContain('#predicted');
  });

  it('the contacts toggle also controls labels, which belong to the contact layer', () => {
    // Deliberate, and stated: a label with no contact beside it is a label pointing at nothing.
    const contactsBlock = AIS_RENDERER_CODE.slice(
      AIS_RENDERER_CODE.indexOf('if (visibility.contacts'),
      AIS_RENDERER_CODE.indexOf('if (visibility.tracks'),
    );
    expect(contactsBlock).toContain('this.#labels.show');
  });
});

/* ================================================================================================
 * DRAWABILITY
 * ============================================================================================== */

describe('drawability integration', () => {
  it('the renderer does not disable depth testing on contact glyphs', () => {
    // DF-X9 section 18. The old `PointGraphics` used `disableDepthTestDistance: Infinity`, which
    // drew contacts THROUGH the globe -- a marker floating over the limb. A billboard is a real
    // 3D primitive and is depth-tested by default, so simply not setting it is the fix.
    expect(AIS_RENDERER_CODE).not.toContain('disableDepthTestDistance: Number.POSITIVE_INFINITY');
    expect(AIS_RENDERER_CODE).not.toContain('disableDepthTestDistance: Infinity');
  });

  it('an off-screen or unprojectable contact gets no label', () => {
    // Not clamped to a viewport edge, which would assert the contact is somewhere it is not.
    const start = AIS_RENDERER_CODE.indexOf('project(lon: number, lat: number)');
    const projectBody = AIS_RENDERER_CODE.slice(
      start,
      AIS_RENDERER_CODE.indexOf('renderObservationMarkers', start),
    );
    expect(projectBody).toContain('return null');
    expect(projectBody).not.toMatch(/Math\.max\(0, Math\.min\(/);
  });
});

/* ================================================================================================
 * REFERENCE TIME
 * ============================================================================================== */

describe('reference time', () => {
  it('no wall clock is read anywhere in the renderer', () => {
    // DF-X9 section 11. Freshness is measured against an explicit reference instant. With no live
    // feed, wall-clock freshness would label the entire archive stale.
    expect(AIS_RENDERER_CODE).not.toMatch(/Date\.now\(\)/);
    expect(AIS_RENDERER_CODE).not.toMatch(/new Date\(\)/);
  });

  it('the reference instant is a required render input, not an optional one', () => {
    expect(AIS_RENDERER_CODE).toContain('referenceTimeIso: string');
  });
});

/* ================================================================================================
 * SOURCE
 * ============================================================================================== */

/**
 * The renderer's own source, read at test time.
 *
 * Several requirements above are STRUCTURAL -- that a collection is not created per tick, that no
 * wall clock is read, that no threat vocabulary exists -- and cannot be observed from the outside
 * without a WebGL context and a browser. Reading the source is the honest way to assert them, and
 * it is honest precisely because these are claims about the file rather than about a running
 * scene. Behavioural claims are asserted against `displayState` and `glyphGeometry` instead.
 */
const AIS_RENDERER_SOURCE = (await import('./aisRenderer?raw')).default as string;

/**
 * The EXECUTABLE source, with every comment removed.
 *
 * Several requirements below are claims about the CODE -- no wall clock, no threat vocabulary, no
 * depth-test disable -- and the renderer's own documentation discusses every one of them by name.
 * Matching against the commented source therefore fails on the file explaining itself, which is the
 * opposite of the intent. Stripping comments first makes these assertions about what the renderer
 * DOES.
 *
 * `performance.now()` survives, and is used for the build-duration measurement, which is a timing
 * measurement rather than a temporal authority.
 */
const AIS_RENDERER_CODE = AIS_RENDERER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The ENGINE's source, for the reachability assertion.
 *
 * Module scope, because an `await import` inside a non-async `it()` callback is a parse error --
 * which is exactly what happened when this was first written, and the whole suite failed to
 * transform rather than failing one assertion.
 */
const ENGINE_SOURCE = (await import('./engine?raw')).default as string;
