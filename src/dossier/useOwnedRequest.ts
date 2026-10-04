/**
 * Per-tab request ownership for the dossier.
 *
 * WHY A GENERATION TOKEN AND NOT JUST AN AbortController
 *
 * Aborting stops a request that has not been sent. It does not stop one that has
 * already resolved and is sitting in the microtask queue, and it does not stop a
 * response that arrived before the abort was issued. A dossier has eight
 * independently-loading tabs and an operator who changes targets faster than any
 * of them respond, so two overlapping requests for different targets are the
 * normal case rather than the exception. The sequence that matters:
 *
 *     select DF-001 -> wake request A
 *     select DF-002 -> wake request B
 *     A resolves last
 *
 * With abort alone, A is frequently already in flight when B is issued, and its
 * response lands on a dossier now headed DF-002. That is not a stale-data
 * annoyance: it is one vessel's wake analysis rendered beneath another vessel's
 * name, which is the exact failure the evidence epistemics exist to prevent.
 *
 * So every request claims a generation when issued, and may write state only if
 * its generation is still current AND the component is still mounted. Abort is an
 * optimisation that saves bandwidth; the generation counter is the guarantee.
 *
 * This mirrors `usePixelProbe`, which established the pattern for the coordinate
 * probe. Same shape on purpose, so there is one idiom in the codebase.
 *
 * FAILURES ARE TAB-LOCAL BY CONSTRUCTION
 *
 * `load` never throws. A rejected fetch becomes `{ status: 'failed' }` for THIS
 * hook and nothing else, so one tab's failure cannot blank the dossier or hide
 * the tabs around it. Optional evidence channels are exactly the case where this
 * matters: polarization or wake failing must leave SAR, AIS and correlation
 * readable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isAbort } from '../api/errors';

/**
 * The four states a dossier tab can be in.
 *
 * `failed` carries a string rather than an Error so it can be rendered beside the
 * tab without serialising a stack trace into the UI.
 */
export type Owned<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; reason: string };

export type Loadable<T> = (signal: AbortSignal) => Promise<T>;

export type OwnedRequest<T> = {
  state: Owned<T>;
  /**
   * Issue a request, superseding anything in flight.
   *
   * `fetcher` receives the signal and must thread it into the fetch. Aborts are
   * swallowed: a superseded request is not a failure and must not paint an error.
   */
  load: (fetcher: Loadable<T>) => void;
  /** Abort in flight and return to idle. */
  reset: () => void;
  /** True while a request is in flight, for a tab-level spinner. */
  loading: boolean;
  /** Aborts the in-flight request without changing state, for unmount. */
  dispose: () => void;
};

export function useOwnedRequest<T>(): OwnedRequest<T> {
  const [state, setState] = useState<Owned<T>>({ status: 'idle' });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Bumping the generation here is what makes an unmount safe: any response
      // still in flight now fails the currency check, so it cannot call
      // setState on a component that no longer exists.
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  const load = useCallback((fetcher: Loadable<T>) => {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    const ticket = ++generation.current;

    setState({ status: 'loading' });

    void (async () => {
      try {
        const value = await fetcher(own.signal);
        if (ticket !== generation.current || !mounted.current) return;
        setState({ status: 'ready', value });
      } catch (error: unknown) {
        if (ticket !== generation.current || !mounted.current) return;
        if (isAbort(error)) return;
        setState({ status: 'failed', reason: describe(error) });
      }
    })();
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setState({ status: 'idle' });
  }, []);

  const dispose = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);

  return { state, load, reset, loading: state.status === 'loading', dispose };
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The request failed for a reason the client could not describe.';
}