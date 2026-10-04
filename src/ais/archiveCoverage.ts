/**
 * AIS archive coverage -- a DEPLOYMENT fact, shown only where it belongs.
 *
 * WHY THIS IS NOT ON THE DOSSIER AIS TAB
 *
 * `/targets/{id}/ais-observations` carries a coverage block, but it is scoped to
 * that target's acquisition window. `/ais/coverage` answers a different question:
 * does this deployment have an AIS archive AT ALL, regardless of place or time.
 *
 * Those two routinely disagree, and the disagreement is the point. A deployment
 * with a healthy archive can still report NO_COVERAGE for a target, because no
 * receiver covered that patch of water at that minute. An operator who saw only
 * the deployment-level fact would conclude AIS works; one who saw only the
 * window-level fact would conclude AIS is broken. Neither is supported.
 *
 * So both are reported, on surfaces where the scope is obvious. Putting the
 * deployment probe beside a window-scoped reading would invite exactly the
 * conflation that makes both misleading.
 *
 * The route is probed rather than assumed, and the states are kept distinct:
 * NOT_CONFIGURED means this deployment has no archive, which is emphatically not
 * the same as an empty sea.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, isAbort } from '../api/errors';
import { AISCOVERAGEOUT_FIELDS, type AisCoverageOut } from '../api/contract';
import { contractValidator } from '../api/validateGenerated';

const validateCoverage = contractValidator<AisCoverageOut>(AISCOVERAGEOUT_FIELDS, 'AisCoverageOut');

export type ArchiveCoverage =
  | { status: 'loading' }
  | { status: 'ready'; value: AisCoverageOut }
  | { status: 'failed'; reason: string };

export function useArchiveCoverage(): ArchiveCoverage & { reload: () => void } {
  const [state, setState] = useState<ArchiveCoverage>({ status: 'loading' });
  const generation = useRef(0);

  const reload = useCallback(() => {
    generation.current += 1;
    const ticket = generation.current;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        const raw = await api.get<unknown>('/api/ais/coverage', controller.signal);
        if (ticket !== generation.current) return;
        setState({ status: 'ready', value: validateCoverage(raw) });
      } catch (error) {
        if (ticket !== generation.current) return;
        if (isAbort(error)) return;
        setState({
          status: 'failed',
          reason: error instanceof Error ? error.message : 'The archive probe failed.',
        });
      }
    })();
  }, []);

  useEffect(() => {
    reload();
    return () => {
      // Invalidate rather than only abort: a response already in flight must not
      // write to a component that has gone.
      generation.current += 1;
    };
  }, [reload]);

  return { ...state, reload };
}
