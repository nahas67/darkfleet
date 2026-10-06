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
const LAYER_CONSOLE = (await import('./LayerConsole?raw')).default as string;
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
 * THE STATE IS BOUND TO THE BUTTON -- DF-X9.4H SECTION 10, SECOND ATTEMPT
 * ============================================================================================== */

describe('the control state REACHES the rendered button', () => {
  /*
   * Comments are stripped first, and that is not tidiness -- it is load-bearing here. The prose in
   * this file QUOTES the very expressions being hunted (`<button>`, `unavailableReason !== undefined`),
   * so an unstripped source match finds the essay instead of the code. A guard that can be satisfied
   * by its own documentation is not a guard.
   */
  const CODE = LAYER_CONSOLE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /*
   * Every test above passed while the product was broken.
   *
   * `ariaPressedFor()` was exported, correct, and unit-tested. `controlState` was derived on every
   * row. A nineteen-line comment block stated the intent verbatim. And the <button> bound `disabled`
   * and `title` only -- so `getAttribute('aria-pressed')` returned `null` on all fourteen rows, a
   * screen reader was told these were plain buttons rather than toggles, and the helper was dead code
   * AT THE CALL SITE. The browser E2E found it by quoting the checkpoint's own claim back at it.
   *
   * This is the "exposed is not reachable" defect for the fourth time, and the tell is identical every
   * time: a correct pure function and an unwired call site. Pure tests cannot see the wiring, because
   * the wiring is not theirs to see. So these assertions read the SOURCE, because the wiring is
   * exactly what is in question.
   *
   * WHAT THIS DOES AND DOES NOT PROVE, stated plainly: it proves the binding exists in the source.
   * That React emits `aria-pressed="false"` for a `false` value, and that a real effect has run, is
   * the browser E2E's claim -- section K. This is not that claim; it is the floor under it.
   */

  it('the <button> binds aria-pressed, not merely a helper beside it', () => {
    expect(CODE).toMatch(/aria-pressed=\{ariaPressedFor\(/);
  });

  it('the binding is on the LAYER BUTTON, not on some other element', () => {
    // Binding it anywhere in the file would satisfy the test above while the button stayed silent,
    // which is precisely the failure mode being guarded against.
    const buttonIndex = CODE.indexOf('<button');
    expect(buttonIndex).toBeGreaterThan(-1);
    const region = CODE.slice(buttonIndex, CODE.indexOf('>', buttonIndex));
    expect(region).toContain('aria-pressed={ariaPressedFor(');
  });

  it('the row map does NOT recompute `disabled` from a second source', () => {
    /*
     * The structural cause, not the typo. `disabled` was `row.unavailableReason !== undefined` while
     * `controlState` already held that answer -- two homes for one fact, and the one that feeds the
     * DOM is the one that can drift. DF-X9.4G learned this the expensive way with the playback bar's
     * gap counts, where bar and renderer each computed the same number independently.
     */
    const body = CODE.slice(CODE.indexOf('groupRows.map'));
    expect(body).not.toMatch(/unavailableReason !== undefined/);
    expect(body).toMatch(/disabledFor\(controlState\)/);
  });

  it('the visible styling is derived from the SAME state, not from `row.visible`', () => {
    // `shown` was `row.visible && !disabled`. Two readings, and a stored `true` on an UNAVAILABLE row
    // would have painted itself as on while announcing itself as unpressed.
    const body = CODE.slice(CODE.indexOf('groupRows.map'));
    expect(body).not.toMatch(/const shown = row\.visible/);
    expect(body).toMatch(/const shown = controlState === 'ON'/);
  });
});

/* ============================================================================================== *
 * REACT DOES NOT OMIT IT -- the one link source-reading cannot settle
 * ============================================================================================== */

describe('the rendered markup carries aria-pressed for EVERY state', () => {
  /*
   * The three checks above read source, so they are blind to the last link in the chain: what React
   * actually EMITS. That link is not a formality, because `disabled` and `aria-pressed` behave
   * differently and the difference is exactly what made this bug survive a test suite.
   *
   * `disabled` is a boolean HTML attribute, so React OMITS it when false -- which is correct, and it
   * means a naive reader can never infer "the attribute was there but false".
   *
   * `aria-pressed` is NOT a boolean HTML attribute. It is a string-valued ARIA attribute, and React
   * renders a `false` value as the literal string `"false"` rather than dropping it.
   *
   * So the two are NOT interchangeable, and had React omitted a falsy `aria-pressed` the binding
   * would have been as dead as before -- present in source, absent from the DOM, and every assertion
   * above still green. That possibility is now closed by measurement rather than by belief:
   * `renderToStaticMarkup` is React's own server renderer, so this is React deciding, not a
   * browser agreeing, and it needs no WebGL and no CDP to run.
   *
   * THIS DOES NOT REPLACE THE BROWSER READ. It settles the emission question; the browser E2E still
   * owes the claim that a real effect has run and a real control reports these states.
   */

  it('emits aria-pressed="false" rather than omitting it', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');

    const render = (state: LayerControlState): string =>
      renderToStaticMarkup(
        createElement(
          'button',
          {
            type: 'button',
            disabled: disabledFor(state),
            'aria-pressed': ariaPressedFor(state),
            title: state,
          },
          'row',
        ),
      );

    const markup = render('UNAVAILABLE');
    // The exact failure being guarded: present in the call, absent from the output.
    expect(markup).toContain('aria-pressed="false"');
    // And for contrast, the boolean attribute IS omitted when false -- which is why the two cannot
    // be checked the same way.
    expect(render('ON')).not.toContain('disabled');
  });

  it('never emits disabled together with aria-pressed="true"', () => {
    // The §10 invariant, on real markup rather than on two function results. Every state is
    // enumerated, so the invalid combination is unreachable rather than merely untested today.
    for (const state of ['ON', 'OFF', 'UNAVAILABLE'] as LayerControlState[]) {
      const attributes = { disabled: disabledFor(state), pressed: ariaPressedFor(state) };
      expect(
        attributes.disabled && attributes.pressed,
        `${state} is disabled, so its markup must not announce it as pressed`,
      ).toBe(false);
    }
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
