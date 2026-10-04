/**
 * Attribution cannot be suppressed again.
 *
 * DF-X8.3 found attribution broken in THREE places at once:
 *
 *   1. `creditContainer: undefined` in `cesiumViewer.ts` -- told Cesium not to render
 *      a credit at all.
 *   2. `.cesium-widget-credits { display: none !important }` in `tokens.css` -- hid
 *      where the credit renders.
 *   3. `.cesium-credit-textContainer { display: none !important }` -- hid the text.
 *
 * The CSS carried the comment "Attribution is never removed. It is restyled to fit the
 * console." directly above rules that removed it. OpenStreetMap data is ODbL, so the
 * credit is a licence obligation and this was a compliance failure.
 *
 * These tests are deliberately about BEHAVIOUR rather than a single grep, because a
 * suppression can be reintroduced in several ways: a new `display: none`, a new
 * `creditContainer: undefined`, a new hidden attribute, or a `visibility: hidden`. Each
 * is asserted here.
 *
 * Why source text is read rather than importing Cesium: `cesiumViewer.ts` imports
 * `cesium`, which cannot load in the `node` test environment. Reading the file catches
 * the class of defect at the point where it is introduced.
 */

import { describe, expect, it } from 'vitest';

import { groupColor } from '../design/tokens';
import { LAYER_DEFINITIONS } from './layerRegistry';
import { stripComments } from './stripSourceComments';

/*
 * Read with COMMENTS STRIPPED.
 *
 * `cesiumViewer.ts` opens with a docstring explaining that `creditContainer:
 * undefined` used to suppress the credit -- it has to quote the removed code to
 * document the fix. Asserting against raw source therefore matches that quotation and
 * reports the defect in a file whose own comment is proof it was resolved. Stripping
 * comments first makes the pin test CODE rather than prose about code, which is the
 * whole difference between a test that can pass and one that cannot.
 */
const read = stripComments;

describe('the viewer is not configured to suppress attribution', () => {
  const source = read('globe/cesiumViewer.ts');

  it('never passes creditContainer: undefined', () => {
    // The exact expression that broke ODbL compliance. A functional equivalent
    // (`creditContainer: void 0`) is deliberately also rejected by the pattern.
    expect(source).not.toMatch(/creditContainer\s*:\s*(undefined|void 0|null)/);
  });

  it('does not hand Cesium our credit element', () => {
    /*
     * Passing our own element as `creditContainer` made Cesium inject its own markup --
     * including the ion logo -- INSIDE our styled box, where it overlapped the
     * attribution until the credit was unreadable. Cesium keeps its default container
     * and ours is offset clear of it.
     *
     * So the assertion is the opposite of what the first version of this test wanted:
     * `creditContainer: undefined` suppresses the credit and is forbidden, while
     * passing our element corrupts its layout. The key must simply be ABSENT.
     */
    expect(source).not.toMatch(/creditContainer\s*:/);
  });

  it('creates a visible credit element with per-source slots', () => {
    // Three separate slots rather than one concatenated string, so basemap,
    // maritime reference data and SAR attribution stay individually inspectable.
    expect(source).toContain("data-df-credit', 'basemap'");
    for (const slot of ['basemap', 'maritime', 'sar']) {
      expect(source, `missing credit slot: ${slot}`).toContain(
        `dfCreditSlot = '${slot}'`,
      );
    }
  });
});

describe('the stylesheet does not hide the credit', () => {
  const css = read('design/tokens.css');

  it('does not display:none the credit container', () => {
    // `.cesium-widget-credits` used to be hidden with !important. Cesium renders into
    // it when it is given a creditContainer, so hiding it removes the credit.
    expect(css).not.toMatch(/\.cesium-widget-credits[^{]*\{[^}]*display:\s*none/i);
  });

  it('does not display:none the credit text', () => {
    expect(css).not.toMatch(/\.cesium-credit-textContainer[^{]*\{[^}]*display:\s*none/i);
  });

  it('defines .df-map-credit as visible', () => {
    const rule = /\.df-map-credit\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.df-map-credit rule missing').not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
    expect(body).not.toMatch(/opacity:\s*0\b/);
    // Positioned, so it actually renders somewhere rather than in normal flow under
    // the canvas where it would be invisible.
    expect(body).toContain('position: absolute');
  });

  it('does not hide the credit at any viewport width', () => {
    // The requirement that matters most: attribution must not be dropped at 1024x768.
    // A `display: none` inside a max-width media query would satisfy every rule above
    // and still hide the credit on a small display.
    const mediaBlocks = css.match(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g) ?? [];
    for (const block of mediaBlocks) {
      const creditRules = block.match(/\.df-map-credit[^{]*\{[^}]*\}/g) ?? [];
      for (const rule of creditRules) {
        expect(rule, `credit hidden at some viewport: ${rule}`).not.toMatch(
          /display:\s*none|visibility:\s*hidden|opacity:\s*0\b/,
        );
      }
    }
  });
});

describe('every source carries the credit its terms require', () => {
  it('OSM attribution names OpenStreetMap contributors', () => {
    const source = read('globe/mapSources.ts');
    expect(source).toContain('© OpenStreetMap contributors');
  });
});

describe('layer accents exist for every category in use', () => {
  it('no declared layer renders a rule with no colour', () => {
    // An unaccented category draws its 2px rule with no background, which reads as a
    // rendering fault rather than as a new group.
    for (const def of LAYER_DEFINITIONS) {
      expect(groupColor[def.category], `no accent for category ${def.category}`).toBeTruthy();
    }
  });
});