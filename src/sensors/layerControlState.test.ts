/**
 * DF-X9.4H CLOSURE TESTS: control states, timeline synchronisation, and the highlight.
 *
 * ================================ WHY THESE ARE PURE ================================
 *
 * The control-state model and the timeline's identity rule are both pure decisions that a DOM test
 * would only obscure: a `jsdom` render proves that React put a string on an attribute, not that the
 * string is the right one. What the DOM genuinely adds -- that a real effect has run and a real
 * control reports these states -- is the browser E2E's job, and section K asserts it there AFTER
 * React's effect has settled.
 *
 * So the split is deliberate: pure semantics here, real DOM in the browser. Neither claims the other's
 * coverage.
 */

import { describe, expect, it } from 'vitest';

import {
  ariaPressedFor,
  disabledFor,
  layerControlState,
  type LayerControlState,
} from './LayerConsole';

/**
 * Module-scope raw sources.
 *
 * HOISTED, and for the second time in this session: `await import` inside a `describe` or `it` body
 * is a PARSE ERROR, and the whole file fails to transform -- so the failure looks like a broken suite
 * rather than a mistake in one test. `await` is allowed at module top level and nowhere else.
 */
const TIMELINE = (await import('../timeline/MissionTimeline?raw')).default as string;
const RENDERER = (await import('../globe/aisRenderer?raw')).default as string;
const ENGINE = (await import('../globe/engine?raw')).default as string;

/* ============================================================================================== *
 * CONTROL STATES -- DF-X9.4H SECTION 10
 * ============================================================================================== */

describe('layer control states', () => {
  it('the three states are DISTINCT and exhaustive', () => {
    // DF-X9.4H section 10 names them: enabled+on, enabled+off, disabled+unavailable. A two-boolean
    // model admits four combinations, and the fourth -- disabled AND on -- is the incoherence the E2E
    // found. A three-state model cannot express it.
    expect(layerControlState(true, null)).toBe('ON');
    expect(layerControlState(false, null)).toBe('OFF');
    expect(layerControlState(true, 'no data')).toBe('UNAVAILABLE');
    expect(layerControlState(false, 'no data')).toBe('UNAVAILABLE');
  });

  it('UNAVAILABLE OUTRANKS VISIBILITY, in both directions', () => {
    // The case the E2E caught: `AIS_PREDICTED` had `defaultVisibility: true`, was disabled with a
    // stated refusal, and still announced `aria-pressed="true"`. Visibility must not survive the
    // refusal.
    expect(layerControlState(true, 'No predicted position exists.')).toBe('UNAVAILABLE');
  });

  it('a DISABLED control is NEVER pressed', () => {
    // The assertion DF-X9.4H section 10 requires, stated once for every state so the invalid
    // combination is impossible to reach.
    const states: LayerControlState[] = ['ON', 'OFF', 'UNAVAILABLE'];
    for (const state of states) {
      if (disabledFor(state)) {
        expect(
          ariaPressedFor(state),
          `${state} is disabled, so it must not report itself as pressed`,
        ).toBe(false);
      }
    }
    expect(ariaPressedFor('UNAVAILABLE')).toBe(false);
    expect(disabledFor('UNAVAILABLE')).toBe(true);
  });

  it('an enabled control reports pressed exactly when it is ON', () => {
    expect(ariaPressedFor('ON')).toBe(true);
    expect(ariaPressedFor('OFF')).toBe(false);
    expect(disabledFor('ON')).toBe(false);
    expect(disabledFor('OFF')).toBe(false);
  });

  it('an EMPTY refusal string is a refusal, not an absence', () => {
    /*
     * A layer that produced an empty reason has still declined, so the state is UNAVAILABLE. The row
     * builder omits the field entirely for an empty reason (`...(unavailableReason ? {} : {})`), so in
     * practice the field is `undefined` rather than `''` -- but `layerControlState` must not depend on
     * that coincidence, or a caller passing `''` directly would get 'ON' for a layer that said no.
     */
    expect(layerControlState(true, '')).toBe('UNAVAILABLE');
    expect(layerControlState(false, '')).toBe('UNAVAILABLE');
  });

  it('undefined and null both mean USABLE -- no reason was given', () => {
    /*
     * MY PREVIOUS VERSION OF THIS TEST ASSERTED THE OPPOSITE of what its own title said, and failed for
     * exactly that reason. `layerControlState(true, undefined)` is 'ON', correctly: `undefined` is how
     * the row builder expresses "no refusal", and treating it as one would disable EVERY layer in the
     * product.
     *
     * Recorded because a self-contradictory test is worse than a missing one -- it looks like coverage,
     * and its failure sends you looking in the implementation instead of at the assertion.
     */
    expect(layerControlState(true, undefined)).toBe('ON');
    expect(layerControlState(false, undefined)).toBe('OFF');
    expect(layerControlState(true, null)).toBe('ON');
    expect(layerControlState(false, null)).toBe('OFF');
  });
});

/* ============================================================================================== *
 * TIMELINE IDENTITY -- DF-X9.4H SECTIONS 23, 24
 * ============================================================================================== */

describe('timeline AIS event identity', () => {

  it('an AIS event carries the MMSI as DATA, not only inside its key string', () => {
    /*
     * The identity used to live only in `key: \`ais-${fix.mmsi}-${fix.timestamp}\``, which the timeline
     * displayed but could not act on. An event you can see but not select is a read-only affordance
     * that looks interactive.
     */
    const code = TIMELINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The event construction assigns `mmsi` as a field.
    expect(code).toMatch(/kind:\s*'AIS_OBSERVATION',[\s\S]{0,220}mmsi:\s*fix\.mmsi/);
    // And the type declares it.
    expect(code).toMatch(/mmsi\?:\s*string/);
  });

  it('selecting an AIS event SEEKS the one shared authority', () => {
    // Not a second clock. The mission timeline drives the playhead; it does not keep its own.
    const code = TIMELINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('temporal.seek(');
    expect(code).toContain("from '../temporal/TemporalController'");
  });

  it('the seek is GUARDED against an unparseable timestamp', () => {
    // `Date.parse` of a bad string is `NaN`, and `NaN` into `clampTo` is a playhead at a position
    // nothing was ever observed at. The conversion must be checked.
    const code = TIMELINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/Date\.parse\(event\.at\)/);
    expect(code).toMatch(/Number\.isFinite\(atMs\)/);
  });

  it('selecting an AIS event selects the VESSEL, not a SAR target', () => {
    // DF-X9.4H section 40 / the TargetRef separation: playing an AIS vessel must not overwrite the
    // selected SAR target. `store.select({ kind: 'mmsi' })` is the AIS selection; the SAR path is a
    // separate `kind: 'target'` branch that must remain.
    const code = TIMELINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain("store.select({ kind: 'mmsi', mmsi: event.mmsi })");
    expect(code).toMatch(/store\.select\(\{\s*kind: 'target'/);
  });

  it('it also records WHICH observation, by MMSI and timestamp', () => {
    // Not a row index. The archive's read order is not guaranteed, so an index would point at a
    // different observation the moment the rows were read differently.
    const code = TIMELINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('highlightedObservation: { mmsi: event.mmsi, at: event.at }');
  });

  it('the mission timeline is NOT animated -- the existing rule survives', () => {
    // DF-X9.4H section 22. The timeline remains discrete event navigation. It gained the ability to
    // seek the AIS authority; it must not have gained an interval or its own clock.
    const code = TIMELINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/setInterval/);
    expect(code).not.toMatch(/requestAnimationFrame/);
    expect(TIMELINE).toContain('There is no playback');
  });
});

/* ============================================================================================== *
 * THE HIGHLIGHT IS DRAWN, NOT JUST STORED -- DF-X9.4H SECTION 24
 * ============================================================================================== */

describe('the observation highlight reaches a primitive', () => {

  it('the renderer DRAWS the highlighted marker differently', () => {
    /*
     * A `highlightedObservation` in the store that no primitive reflects would be the "exposed is not
     * reachable" defect a third time, in a field whose very name promises this.
     */
    expect(RENDERER).toContain('HIGHLIGHTED_DOT');
    expect(RENDERER).toMatch(/isHighlighted \? 15 : 7/);
    // And the match is on IDENTITY, not position: a vessel at anchor has several fixes at one
    // position, and matching on coordinates would highlight all of them.
    expect(RENDERER).toMatch(/highlighted\.mmsi === marker\.mmsi && highlighted\.at === marker\.at/);
  });

  it('the highlight is a different SHAPE as well as a different size', () => {
    // Colour and size alone leave the highlight indistinguishable in greyscale or to a
    // colour-vision-deficient reader. The outer ring reads as "selected" without depending on either.
    expect(RENDERER).toMatch(/ctx\.arc\(mid, mid, 13/);
  });

  it('the engine FORWARDS the highlight, rather than holding it internally', () => {
    expect(ENGINE).toMatch(/get highlightedAisObservation\(/);
    expect(ENGINE).toContain('highlightedObservation: options?.highlightedObservation ?? null');
  });

  it('the store starts with no highlight, so nothing is emphasised by default', async () => {
    const { store } = await import('../state/store');
    expect(store.getState().highlightedObservation).toBeNull();
  });
});
