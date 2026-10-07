/**
 * Target identity, and the one rule for reading it.
 *
 * WHY THIS EXISTS
 *
 * Target ids are assigned per scan. `correlate()` numbers components as
 * `DF-{index+1:03d}` within a single scan, so `DF-002` in stored scan DF-0001 and
 * `DF-002` in stored scan DF-0035 are different vessels in different places, and a
 * stored archive makes that collision the normal case rather than an edge case.
 *
 * That has a consequence which is easy to get wrong in a way no type system
 * catches: a target id on its own is not an identity. Anything that keys a fetch,
 * a cache entry, a request-generation token or a render on `targetId` alone can
 * legitimately serve one vessel's header above another vessel's evidence, and it
 * will do so without complaining.
 *
 * `TargetRef` is the pair. `targetRefOf` is the only sanctioned way to read it, so
 * the pairing rule is stated once instead of being re-derived at each call site
 * with a slightly different mistake.
 *
 * This module is deliberately pure and DOM-free so it can be tested directly.
 */

/** A target's full identity: which target, in which scan. */
export type TargetRef = {
  readonly targetId: string;
  readonly scanId: string | null;
};

export type SelectionLike =
  | { kind: 'none' }
  | { kind: 'target'; targetId: string; scanId?: string | null }
  | { kind: 'scene'; sceneId: string };

/**
 * The target ref a selection denotes, or null when it denotes no target.
 *
 * Returns null rather than a partial ref for non-target selections so that a
 * caller cannot accidentally read `targetId` off a scene selection. AIS
 * contacts never reach this function at all: they live in `selectedAis`, a
 * separate authority, so there is no MMSI variant to misread here.
 */
export function targetRefOf(selection: SelectionLike): TargetRef | null {
  if (selection.kind !== 'target') return null;
  return {
    targetId: selection.targetId,
    // A missing scan id is normalised to null rather than left undefined, so that
    // two refs built the same way always compare equal.
    scanId: selection.scanId ?? null,
  };
}

/**
 * Do two refs name the same target?
 *
 * Both ids must match. A ref with no scan is NOT treated as a wildcard: matching
 * `DF-002`-with-no-scan against `DF-002`-in-scan-0001 would reintroduce exactly
 * the collision this type exists to prevent, and it would do so silently.
 */
export function sameTargetRef(a: TargetRef | null, b: TargetRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.targetId === b.targetId && a.scanId === b.scanId;
}

/**
 * A stable string key for a ref, for use as a cache or generation key.
 *
 * The separator cannot appear in a scan id, so `a:b` and `ab:` cannot collide.
 */
export function targetRefKey(ref: TargetRef | null): string {
  if (ref === null) return 'none';
  return `${ref.targetId}@${ref.scanId ?? '-'}`;
}

/**
 * Build the `scan_id` query parameter for a target-scoped route.
 *
 * The backend resolves a bare target id across every stored scan and reports
 * `ambiguous: true` when it matches more than one. With an archive of thirty-odd
 * scans that is the normal response, not a rare one, so a dossier that omits the
 * scan id will show a target whose identity it could not actually establish.
 */
export function scanQuery(ref: TargetRef | null): string | null {
  return ref === null ? null : ref.scanId;
}

/**
 * The path segment for a target-scoped route.
 *
 * Encoded because a scan id is interpolated into a URL, and an unencoded id is a
 * path-injection vector rather than a display detail.
 */
export function targetPath(ref: TargetRef | null): string {
  if (ref === null) throw new Error('targetPath called with no target selected');
  return encodeURIComponent(ref.targetId);
}