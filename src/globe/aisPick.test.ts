/**
 * DF-X9.6 sections 3-19, 46-52: AIS primitive click-selection through real `scene.pick`.
 *
 * Written FIRST, against a renderer and engine that do not tag or decode anything, so every
 * behavioural block below fails until the lane lands. The structure mirrors the existing
 * `?raw`/source-text patterns where a live viewer is unavailable: the decoder itself is a pure
 * function tested behaviourally, and the wiring (renderer tags, engine dispatch, bar surface) is
 * bound by source assertions that name the exact symbols.
 *
 * WHAT IS BEHAVIOURAL AND WHAT IS SOURCE-BOUND
 *
 *   behavioural   `decodeAisPick` over synthetic pick objects, `arbitrateLabels` over 121 claims.
 *   source-bound  the five renderer `.add()` calls carry `id` tags, the engine LEFT_CLICK path
 *                 decodes and writes `selectedAis`, the bar renders the selected-contact section.
 *                 A live `Viewer.scene.pick` needs WebGL and is the browser E2E's job.
 */

import { describe, expect, it } from 'vitest';

import { decodeAisPick } from './aisPick';
import { arbitrateLabels, MAX_AIS_LABELS, type LabelClaim } from './glyphGeometry';

/* ============================================================================================== *
 * THE DECODER
 * ============================================================================================== */

describe('decodeAisPick: typed AIS tags', () => {
  it('a contact tag decodes to AIS_CONTACT with its MMSI', () => {
    expect(
      decodeAisPick({ id: { domain: 'AIS_CONTACT', mmsi: '257000001' }, primitive: {} }),
    ).toEqual({ kind: 'AIS_CONTACT', mmsi: '257000001' });
  });

  it('an observation tag decodes with the EXACT raw timestamp, unnormalised', () => {
    // The timestamp travels verbatim: it must match the archive row for the marker highlight,
    // and any normalisation here would break that identity.
    const at = '2026-03-01T08:08:00.000Z';
    expect(
      decodeAisPick({ id: { domain: 'AIS_OBSERVATION', mmsi: '257000003', at }, primitive: {} }),
    ).toEqual({ kind: 'AIS_OBSERVATION', mmsi: '257000003', at });
  });

  it('track and prediction tags decode to their kinds', () => {
    expect(
      decodeAisPick({ id: { domain: 'AIS_TRACK', mmsi: '257000001' }, primitive: {} }),
    ).toEqual({ kind: 'AIS_TRACK', mmsi: '257000001' });
    expect(
      decodeAisPick({ id: { domain: 'AIS_PREDICTION', mmsi: '257000001' }, primitive: {} }),
    ).toEqual({ kind: 'AIS_PREDICTION', mmsi: '257000001' });
  });

  it('a label pick decodes as its contact: labels carry the contact tag, never text', () => {
    // Section 17. The label is the contact's name on screen, so clicking it selects the contact.
    expect(
      decodeAisPick({ id: { domain: 'AIS_CONTACT', mmsi: '257000002' }, primitive: {} }),
    ).toEqual({ kind: 'AIS_CONTACT', mmsi: '257000002' });
  });
});

describe('decodeAisPick: the SAR entity path is unchanged', () => {
  it('a target: entity name decodes to SAR_TARGET', () => {
    expect(
      decodeAisPick({ id: { name: 'target:DF-001' }, primitive: {} }),
    ).toEqual({ kind: 'SAR_TARGET', targetId: 'DF-001' });
  });

  it('a Cesium Property name (getValue) decodes the same way', () => {
    // `Entity.name` may arrive as a Property rather than a string; the engine's own
    // `#entityName` already reads it defensively, and the decoder must too.
    expect(
      decodeAisPick({ id: { name: { getValue: () => 'target:DF-002' } }, primitive: {} }),
    ).toEqual({ kind: 'SAR_TARGET', targetId: 'DF-002' });
  });

  it('the SAR path never consults the billboard fallback', () => {
    let calls = 0;
    const resolver = (): string | null => {
      calls += 1;
      return '999999999';
    };
    expect(decodeAisPick({ id: { name: 'target:DF-001' }, primitive: {} }, resolver)).toEqual({
      kind: 'SAR_TARGET',
      targetId: 'DF-001',
    });
    expect(calls).toBe(0);
  });
});

describe('decodeAisPick: unknown is unknown, never a guessed MMSI', () => {
  it('null, undefined and non-objects decode to UNKNOWN', () => {
    expect(decodeAisPick(null)).toEqual({ kind: 'UNKNOWN' });
    expect(decodeAisPick(undefined)).toEqual({ kind: 'UNKNOWN' });
    expect(decodeAisPick('257000001')).toEqual({ kind: 'UNKNOWN' });
    expect(decodeAisPick(3)).toEqual({ kind: 'UNKNOWN' });
  });

  it('a collection index never selects a vessel', () => {
    // Section 4. A stale index would silently select the wrong vessel after the first
    // contact left, which is why identity is by object and tag, never by number.
    expect(decodeAisPick({ id: 3, primitive: {} })).toEqual({ kind: 'UNKNOWN' });
  });

  it('label text never selects a vessel', () => {
    // Section 4. Parsing "257000001 · 45° · 9.0 kn" back into an MMSI would couple
    // picking to a display format.
    expect(decodeAisPick({ id: '257000001 · 45° · 9.0 kn', primitive: {} })).toEqual({
      kind: 'UNKNOWN',
    });
  });

  it('a malformed tag is UNKNOWN, not a partial selection', () => {
    expect(decodeAisPick({ id: { domain: 'AIS_CONTACT' }, primitive: {} })).toEqual({
      kind: 'UNKNOWN',
    });
    expect(decodeAisPick({ id: { domain: 'AIS_CONTACT', mmsi: '' }, primitive: {} })).toEqual({
      kind: 'UNKNOWN',
    });
    expect(
      decodeAisPick({ id: { domain: 'AIS_OBSERVATION', mmsi: '257000001' }, primitive: {} }),
    ).toEqual({ kind: 'UNKNOWN' });
    expect(
      decodeAisPick({
        id: { domain: 'AIS_OBSERVATION', mmsi: '257000001', at: '' },
        primitive: {},
      }),
    ).toEqual({ kind: 'UNKNOWN' });
  });

  it('a foreign domain is UNKNOWN', () => {
    expect(decodeAisPick({ id: { domain: 'SOMETHING_ELSE', mmsi: '1' }, primitive: {} })).toEqual({
      kind: 'UNKNOWN',
    });
  });

  it('a non-target entity is UNKNOWN', () => {
    expect(decodeAisPick({ id: { name: 'maritime-coastline' }, primitive: {} })).toEqual({
      kind: 'UNKNOWN',
    });
    expect(decodeAisPick({ id: { name: 'ais-fix' }, primitive: {} })).toEqual({
      kind: 'UNKNOWN',
    });
  });
});

describe('decodeAisPick: the untagged-billboard fallback (mmsiOf)', () => {
  /*
   * Tagging covers every primitive the renderer creates, so this path fires only for billboards
   * from elsewhere -- a foreign collection, or a primitive created before tagging. It is kept
   * because deleting the object-identity scan silently would leave those clicks dead with no
   * record of why, and it is a FALLBACK: a present tag always wins over it.
   */

  /** An object-identity scan over a retained map, mirroring `AisContactRenderer.mmsiOf`. */
  function identityResolver(entries: ReadonlyMap<string, object>) {
    return (primitive: unknown): string | null => {
      for (const [mmsi, retained] of entries) {
        if (retained === primitive) return mmsi;
      }
      return null;
    };
  }

  it('an untagged billboard resolves by object identity', () => {
    const billboard = {};
    const resolver = identityResolver(new Map([['257000007', billboard]]));
    expect(decodeAisPick({ primitive: billboard }, resolver)).toEqual({
      kind: 'AIS_CONTACT',
      mmsi: '257000007',
    });
  });

  it('an unrecognised primitive stays UNKNOWN even with a resolver', () => {
    const resolver = identityResolver(new Map([['257000007', {}]]));
    expect(decodeAisPick({ primitive: {} }, resolver)).toEqual({ kind: 'UNKNOWN' });
  });

  it('a present tag wins over the fallback, even when they disagree', () => {
    const billboard = {};
    const resolver = identityResolver(new Map([['999999999', billboard]]));
    expect(
      decodeAisPick(
        { id: { domain: 'AIS_CONTACT', mmsi: '257000001' }, primitive: billboard },
        resolver,
      ),
    ).toEqual({ kind: 'AIS_CONTACT', mmsi: '257000001' });
  });

  it('an untagged pick with no resolver is UNKNOWN', () => {
    expect(decodeAisPick({ primitive: {} })).toEqual({ kind: 'UNKNOWN' });
    expect(decodeAisPick({})).toEqual({ kind: 'UNKNOWN' });
  });
});

/* ============================================================================================== *
 * SELECTED LABEL ARBITRATION UNDER BUDGET PRESSURE (§19)
 * ============================================================================================== */

describe('the selected contact wins label arbitration with >120 competing claims', () => {
  it('one SELECTED_AIS among 122 claims is shown, winning both collision and budget', () => {
    // Production budget is MAX_AIS_LABELS (120). 121 generics plus one selected contact force
    // BOTH suppression reasons at once: the selected label sits exactly on a generic's cell
    // (a collision it must win) while the total overflows the budget (a cut it must survive).
    const claims: LabelClaim[] = [];
    for (let i = 0; i < MAX_AIS_LABELS + 1; i += 1) {
      const mmsi = `257${String(100000 + i).padStart(6, '0')}`;
      claims.push({
        id: mmsi,
        priority: 'GENERIC_AIS',
        // Spread on a grid so generics do not collide with each other: the pressures under
        // test are the SELECTED collision and the BUDGET, not a pile-up at one pixel.
        screen: { x: (i % 11) * 200, y: Math.floor(i / 11) * 40 },
        widthPx: 120,
        heightPx: 21,
      });
    }
    // Exactly on generic i=60's cell: a collision the selection must win, not merely survive.
    claims.push({
      id: '257000001',
      priority: 'SELECTED_AIS',
      screen: { x: (60 % 11) * 200, y: Math.floor(60 / 11) * 40 },
      widthPx: 120,
      heightPx: 21,
    });

    const decision = arbitrateLabels(claims, { maxLabels: MAX_AIS_LABELS });
    expect(decision.shown.map((c) => c.id)).toContain('257000001');
    expect(decision.shown).toHaveLength(MAX_AIS_LABELS);
    // Two suppressions: the overlapped generic yields by COLLISION, the overflow generic by
    // BUDGET -- and the selected contact is neither.
    expect(decision.suppressed).toHaveLength(2);
    const byId = new Map(decision.suppressed.map((s) => [s.id, s.reason]));
    expect(byId.get('257100060')).toBe('COLLISION');
    expect(byId.get('257100120')).toBe('BUDGET');
    expect(byId.has('257000001')).toBe(false);
  });

  it('the arbitration is deterministic across runs', () => {
    const claims: LabelClaim[] = [];
    for (let i = 0; i < MAX_AIS_LABELS; i += 1) {
      claims.push({
        id: `257${String(100000 + i).padStart(6, '0')}`,
        priority: 'GENERIC_AIS',
        screen: { x: (i % 11) * 200, y: Math.floor(i / 11) * 40 },
        widthPx: 120,
        heightPx: 21,
      });
    }
    claims.push({
      id: '257000001',
      priority: 'SELECTED_AIS',
      screen: { x: 5 * 200, y: 5 * 40 },
      widthPx: 120,
      heightPx: 21,
    });
    const first = arbitrateLabels(claims, { maxLabels: MAX_AIS_LABELS });
    const second = arbitrateLabels([...claims].reverse(), { maxLabels: MAX_AIS_LABELS });
    expect(second.shown.map((c) => c.id).sort()).toEqual(
      first.shown.map((c) => c.id).sort(),
    );
  });
});

/* ============================================================================================== *
 * THE REACHABILITY CHAIN: primitive id -> decode -> store -> UI selector
 * ============================================================================================== */

describe('the pick chain is wired end to end (source-bound, no live viewer)', () => {
  it('the renderer tags every pickable primitive kind at creation', () => {
    // One assertion per primitive the decoder claims to understand. The tag SHAPE lives in
    // `aisPick.ts` (asserted below); the renderer calls the factories at each `.add()` site --
    // never an index, never label text.
    expect(PICK_CODE).toContain("domain: 'AIS_CONTACT'");
    expect(PICK_CODE).toContain("domain: 'AIS_OBSERVATION'");
    expect(PICK_CODE).toContain("domain: 'AIS_TRACK'");
    expect(PICK_CODE).toContain("domain: 'AIS_PREDICTION'");
    expect(RENDERER_CODE).toContain('aisObservationTag(');
    expect(RENDERER_CODE).toContain('aisTrackTag(');
    expect(RENDERER_CODE).toContain('aisPredictionTag(');
    // Contacts AND labels carry the contact tag: the glyph and its name select the vessel.
    expect(RENDERER_CODE).toContain('aisContactTag(');
    // The label carries its contact's tag (section 17): asserted on the label add path.
    const labelAdd = RENDERER_CODE.slice(
      RENDERER_CODE.indexOf('this.#labels.add('),
      RENDERER_CODE.indexOf('drawnMmsis', RENDERER_CODE.indexOf('this.#labels.add(')),
    );
    expect(labelAdd).toContain('aisContactTag(');
  });

  it('mmsiOf still exists as the decoder fallback, and the engine wires it', () => {
    // Tagging covers 100% of renderer-created primitives; mmsiOf is RETAINED (not deleted)
    // for untagged foreign billboards, and the engine passes it as the fallback resolver.
    expect(RENDERER_CODE).toContain('mmsiOf(billboard');
    expect(ENGINE_CODE).toContain('decodeAisPick');
    expect(ENGINE_CODE).toContain('.mmsiOf(');
  });

  it('the engine LEFT_CLICK path decodes and writes the AIS authority, never the target', () => {
    const definition = ENGINE_CODE.indexOf('#installPicking(): void');
    expect(definition).toBeGreaterThan(-1);
    const pickPath = ENGINE_CODE.slice(definition, definition + 6000);
    expect(pickPath).toContain('decodeAisPick');
    expect(pickPath).toContain('store.selectAis');
    expect(pickPath).toContain('highlightedObservation');
    // The SAR path survives beside it: target entities still resolve to handles.
    expect(pickPath).toContain('target:');
    // An unknown or empty click clears ONLY the AIS side: no `select({` write in the pick path.
    expect(pickPath).not.toContain('store.select({');
  });

  it('the selected-contact readout is rendered on exactly one surface', () => {
    // AisPlaybackBar owns it: it already shows AIS state (diagnostics, FRAME TRACK, gap/MMSI
    // readout), and a second surface would be a second answer to one question.
    expect(BAR_CODE).toContain('data-df-ais-selected');
    expect(BAR_CODE).toContain('data-df-ais-selected-observation');
  });
});

/* ============================================================================================== *
 * SOURCES, READ AT TEST TIME
 * ============================================================================================== */

/** Executable source with comments stripped, so prose cannot satisfy a code check. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const RENDERER_SOURCE = (await import('./aisRenderer?raw')).default as string;
const RENDERER_CODE = codeOf(RENDERER_SOURCE);

const PICK_SOURCE = (await import('./aisPick?raw')).default as string;
const PICK_CODE = codeOf(PICK_SOURCE);

const ENGINE_SOURCE = (await import('./engine?raw')).default as string;
const ENGINE_CODE = codeOf(ENGINE_SOURCE);

const BAR_SOURCE = (await import('../temporal/AisPlaybackBar?raw')).default as string;
const BAR_CODE = codeOf(BAR_SOURCE);
