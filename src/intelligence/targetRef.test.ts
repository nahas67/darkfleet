/**
 * Target identity, and the collision it exists to prevent.
 *
 * Target ids are assigned per scan: `correlate()` numbers components `DF-{index+1:03d}`
 * within ONE scan. So `DF-002` in stored scan DF-0001 and `DF-002` in stored scan
 * DF-0035 are different vessels in different places, and an archive makes that the
 * normal case rather than an edge case.
 *
 * These tests exist because the collision is silent. Nothing throws when a bare id
 * is used; the product simply shows the wrong vessel's data under the right vessel's
 * name.
 */

import { describe, expect, it } from 'vitest';

import { sameTargetRef, scanQuery, targetPath, targetRefKey, targetRefOf } from './targetRef';

describe('targetRefOf reads only target selections', () => {
  it('returns null for a non-target selection', () => {
    // Returning a partial ref for an MMSI selection would let a caller read
    // `targetId` off something that has none.
    expect(targetRefOf({ kind: 'none' })).toBeNull();
    expect(targetRefOf({ kind: 'mmsi', mmsi: '477421900' })).toBeNull();
    expect(targetRefOf({ kind: 'scene', sceneId: 'S1A_X' })).toBeNull();
  });

  it('normalises a missing scan id to null rather than undefined', () => {
    // Two refs built the same way must compare equal, and `undefined !== null` under
    // Object.is, so the normalisation has to happen here rather than at each call.
    const withUndefined = targetRefOf({ kind: 'target', targetId: 'DF-002' });
    const withNull = targetRefOf({ kind: 'target', targetId: 'DF-002', scanId: null });
    expect(withUndefined).toEqual({ targetId: 'DF-002', scanId: null });
    expect(withUndefined).toEqual(withNull);
  });
});

describe('sameTargetRef treats a missing scan as a distinct target', () => {
  it('refuses to match an unscoped id against a scoped one', () => {
    /*
     * THE defect. Treating a missing scan as a wildcard would reintroduce exactly
     * the collision this type exists to prevent, and it would do so silently: the
     * dossier would show scan A's DF-002 while the operator believes they selected
     * scan B's DF-002.
     */
    expect(
      sameTargetRef({ targetId: 'DF-002', scanId: null }, { targetId: 'DF-002', scanId: 'DF-0001' }),
    ).toBe(false);
  });

  it('matches two refs with the same id and the same scan', () => {
    expect(
      sameTargetRef({ targetId: 'DF-002', scanId: 'DF-0001' }, { targetId: 'DF-002', scanId: 'DF-0001' }),
    ).toBe(true);
  });

  it('separates the same id in two different scans', () => {
    // The core case: identical target id, different owning scan.
    expect(
      sameTargetRef({ targetId: 'DF-002', scanId: 'DF-0001' }, { targetId: 'DF-002', scanId: 'DF-0035' }),
    ).toBe(false);
  });

  it('separates two ids within one scan', () => {
    expect(
      sameTargetRef({ targetId: 'DF-002', scanId: 'DF-0001' }, { targetId: 'DF-003', scanId: 'DF-0001' }),
    ).toBe(false);
  });

  it('treats two nulls as equal and null against a value as unequal', () => {
    expect(sameTargetRef(null, null)).toBe(true);
    expect(sameTargetRef(null, { targetId: 'DF-002', scanId: 'DF-0001' })).toBe(false);
    expect(sameTargetRef({ targetId: 'DF-002', scanId: null }, null)).toBe(false);
  });
});

describe('targetRefKey is stable and collision-free', () => {
  it('gives different keys to the same id in different scans', () => {
    // Used as a cache and generation key, so a collision here would reuse one
    // target's cached answer for another.
    expect(targetRefKey({ targetId: 'DF-002', scanId: 'DF-0001' })).not.toBe(
      targetRefKey({ targetId: 'DF-002', scanId: 'DF-0035' }),
    );
  });

  it('gives the same key to equal refs built with and without an explicit null', () => {
    expect(targetRefKey({ targetId: 'DF-002', scanId: null })).toBe(
      targetRefKey(targetRefOf({ kind: 'target', targetId: 'DF-002' })),
    );
  });

  it('does not let an id containing the separator forge another key', () => {
    // `DF-002@DF-0001` as an id would otherwise collide with id `DF-002` in scan
    // `DF-0001`. Scan ids are `DF-NNNN`, so this is defensive rather than observed.
    expect(targetRefKey({ targetId: 'DF-002@DF-0001', scanId: null })).not.toBe(
      targetRefKey({ targetId: 'DF-002', scanId: 'DF-0001' }),
    );
  });

  it('names the empty selection distinctly', () => {
    expect(targetRefKey(null)).toBe('none');
  });
});

describe('scanQuery pins the owning scan', () => {
  it('returns the scan when one is known', () => {
    expect(scanQuery({ targetId: 'DF-002', scanId: 'DF-0001' })).toBe('DF-0001');
  });

  it('returns null when no scan is known', () => {
    // The backend then resolves the id across every stored scan and answers
    // `ambiguous: true`, which is the honest outcome for an unpinned id.
    expect(scanQuery({ targetId: 'DF-002', scanId: null })).toBeNull();
    expect(scanQuery(null)).toBeNull();
  });
});

describe('targetPath encodes rather than interpolates', () => {
  it('refuses to build a path with no target selected', () => {
    expect(() => targetPath(null)).toThrow();
  });

  it('percent-encodes the id', () => {
    // An unencoded id is a path-injection vector, not a display detail.
    expect(targetPath({ targetId: 'DF/../scans', scanId: null })).toBe('DF%2F..%2Fscans');
  });

  it('leaves an ordinary id unchanged', () => {
    expect(targetPath({ targetId: 'DF-002', scanId: null })).toBe('DF-002');
  });
});