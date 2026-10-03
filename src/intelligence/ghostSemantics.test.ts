/**
 * GFST gate, frontend half: Ghost Vessel semantics must hold in product copy.
 *
 * The backend has an equivalent gate. Both exist because the risk in this
 * designation is not the code — it is a future panel quietly rephrasing the
 * warning into an accusation. These assertions run over the strings the product
 * actually renders.
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_INFERENCES,
  GHOST_CLASSIFICATION,
  GHOST_LABEL,
  GHOST_WARNING,
  HYPOTHESES,
  UNKNOWNS,
  isGhostVessel,
} from '../ghost_vessel';

const RENDERED = [
  GHOST_LABEL,
  GHOST_WARNING,
  ...HYPOTHESES,
  ...UNKNOWNS,
];

describe('Ghost Vessel designation', () => {
  it('keeps the analytical class intact', () => {
    expect(GHOST_CLASSIFICATION).toBe('SAR_UNMATCHED');
    expect(GHOST_LABEL).not.toBe(GHOST_CLASSIFICATION);
  });

  it('disclaims causation', () => {
    expect(GHOST_WARNING).toMatch(/does not establish why/i);
  });

  it('names only SAR_UNMATCHED', () => {
    expect(isGhostVessel('SAR_UNMATCHED')).toBe(true);
    for (const other of [
      'SAR_MATCHED_AIS',
      'AIS_ONLY',
      'SEA_CLUTTER',
      'LOW_CONFIDENCE',
      'UNRESOLVED',
      'STATIONARY_OR_INFRASTRUCTURE',
      undefined,
      null,
    ]) {
      expect(isGhostVessel(other)).toBe(false);
    }
  });
});

describe('product copy carries no accusatory inference', () => {
  it('no rendered string contains a forbidden inference', () => {
    const blob = RENDERED.join(' \n ').toLowerCase();
    for (const phrase of FORBIDDEN_INFERENCES) {
      expect(blob, `"${phrase}" must not appear in Ghost Vessel copy`).not.toContain(
        phrase.toLowerCase(),
      );
    }
  });

  it('hypotheses are about observation, never about intent', () => {
    const blob = HYPOTHESES.join(' ').toLowerCase();
    for (const marker of ['coverage', 'not broadcasting', 'clutter', 'incidence', 'stale']) {
      expect(blob).toContain(marker);
    }
  });

  it('unknowns include identity and intent', () => {
    const blob = UNKNOWNS.join(' ').toLowerCase();
    expect(blob).toContain('identity');
    expect(blob).toContain('intent');
  });

  it('hypotheses and unknowns are not the same list', () => {
    expect(HYPOTHESES).not.toEqual(UNKNOWNS);
  });
});

describe('absence is preserved', () => {
  it('both evidence vocabularies are non-empty', () => {
    // An empty block is not an option: "nothing found" must be distinguishable
    // from "not examined", so the panel always has something to render.
    expect(HYPOTHESES.length).toBeGreaterThan(0);
    expect(UNKNOWNS.length).toBeGreaterThan(0);
  });
});