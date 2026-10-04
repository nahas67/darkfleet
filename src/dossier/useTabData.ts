/**
 * Per-tab data loading for the dossier.
 *
 * A thin wrapper over `useOwnedRequest` that adds the one thing every tab needs
 * and none of them should reimplement: reload when the target changes, and never
 * show the previous target's answer under the new target's header.
 *
 * The dependency is the target's identity KEY, not the target object. Passing the
 * object would refetch on every unrelated store write that produces a new object
 * reference, which for a 200-r-per-second globe cursor is every frame.
 */

import { useEffect, useMemo } from 'react';

import type { TargetRef } from '../intelligence/targetRef';
import { useOwnedRequest, type Loadable, type Owned } from './useOwnedRequest';
import { targetRefKey } from '../intelligence/targetRef';

export type TabState<T> = Owned<T>;

/**
 * Load a branch for a target, resetting whenever the target changes.
 *
 * `enabled: false` keeps the tab idle without issuing a request, which is what a
 * tab that has not been opened should do. Fetching eleven branches for eleven
 * unopened tabs would be eleven requests an operator never asked for.
 */
export function useTabData<T>(
  ref: TargetRef | null,
  fetcher: Loadable<T>,
  enabled = true,
): TabState<T> {
  const owned = useOwnedRequest<T>();
  const key = useMemo(() => targetRefKey(ref), [ref]);

  // `fetcher` is intentionally not a dependency: tabs build it inline, so it is a
  // new closure every render and depending on it would loop forever. The key is
  // what actually determines whether the answer is still the right answer.
  useEffect(() => {
    if (!enabled || ref === null) return;
    owned.load(fetcher);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return owned.state;
}

/**
 * Load a branch that is NOT target-scoped, once per mount.
 *
 * Used by the cross-scan projections (`/tracks`, `/patterns`), which describe the
 * archive rather than one target. They still get generation-token protection, so
 * a tab switched away and back cannot render a stale archive.
 */
export function useArchiveData<T>(fetcher: Loadable<T>, enabled = true): TabState<T> {
  const owned = useOwnedRequest<T>();
  useEffect(() => {
    if (!enabled) return;
    owned.load(fetcher);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return owned.state;
}