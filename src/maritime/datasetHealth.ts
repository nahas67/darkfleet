/**
 * Local reference-dataset state, shown only where it belongs.
 *
 * WHY THIS IS NOT `state.providers`
 *
 * `/api/providers/health` answers "can this deployment REACH its remote sources" and has
 * a live-uptime meaning. `/api/maritime/datasets` answers "what files are on this disk and
 * can a query read them". Merging them would let a healthy basemap imply healthy reference
 * data, or a failed SAR provider imply the local coastline is broken. Neither is a real
 * dependency.
 *
 * THREE AXES, DELIBERATELY NOT MERGED
 *
 *   install_status   what is on disk
 *   usable           whether a query may read it
 *   blocker_reason   why it is absent, when it is
 *
 * A single merged word would have to say either "OK" for a dataset with no publisher
 * checksum recorded, or "unverified" for one that answers correctly. Both are wrong. So
 * `CHECKSUM_UNRECORDED` renders as itself and is visually distinct from `READY`: a weaker
 * guarantee stays visible rather than being rounded up.
 *
 * `blocker_reason` is separate again because NOT_INSTALLED is the NORMAL state for an
 * optional dataset and is not a fault -- while for the World Port Index it is a recorded
 * external blocker. Without that distinction the panel would tell an operator nothing is
 * wrong with the port data, which is not what happened.
 *
 * The hook is mounted once and re-probed on demand. It is deliberately NOT polled: dataset
 * state only changes when a human runs an install, so a timer would burn requests to
 * re-report a fact that cannot have moved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, isAbort } from '../api/errors';
import {
  DATASETHEALTHRESPONSE_FIELDS,
  type DatasetHealthEntry,
  type DatasetHealthResponse,
} from '../api/contract';
import { contractValidator } from '../api/validateGenerated';

const validateHealth = contractValidator<DatasetHealthResponse>(
  DATASETHEALTHRESPONSE_FIELDS,
  'DatasetHealthResponse',
);

export type DatasetHealth =
  | { status: 'loading' }
  | { status: 'ready'; value: DatasetHealthResponse }
  | { status: 'failed'; reason: string };

/**
 * How an entry's install state should read.
 *
 * `CHECKSUM_UNRECORDED` is deliberately NOT collapsed into "verified". The data parses and
 * answers correctly, and the publisher published no checksum to check against -- which is a
 * weaker guarantee that must stay legible, because "unverified" read as "verified" is
 * exactly the substitution this product refuses.
 */
export function installStatusLabel(entry: DatasetHealthEntry): string {
  switch (entry.install_status) {
    case 'READY':
      return 'INSTALLED / VERIFIED';
    case 'CHECKSUM_UNRECORDED':
      return 'INSTALLED / NO PUBLISHER CHECKSUM';
    case 'NOT_INSTALLED':
      return entry.optional ? 'NOT INSTALLED (OPTIONAL)' : 'NOT INSTALLED';
    case 'CHECKSUM_MISMATCH':
      return 'CHECKSUM MISMATCH';
    case 'INVALID':
      return 'PRESENT BUT UNREADABLE';
    case 'VERSION_UNKNOWN':
      return 'UNKNOWN VERSION ON DISK';
    default:
      return entry.install_status.replace(/_/g, ' ');
  }
}

/**
 * The version string to display.
 *
 * Returns null when the version was not established, and the caller must then show the
 * retrieval timestamp instead. A service snapshot whose publisher never published a
 * per-layer version must not be labelled with one -- and specifically must not inherit
 * "v12" from a separate bulk release, which is a different product from a different URL.
 */
export function versionLabel(entry: DatasetHealthEntry): string | null {
  if (entry.version_established) return entry.version;
  return null;
}

export function useDatasetHealth(): DatasetHealth & { reload: () => void } {
  const [state, setState] = useState<DatasetHealth>({ status: 'loading' });
  const generation = useRef(0);

  const reload = useCallback(() => {
    generation.current += 1;
    const ticket = generation.current;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        const raw = await api.get<unknown>('/api/maritime/datasets', controller.signal);
        if (ticket !== generation.current) return;
        setState({ status: 'ready', value: validateHealth(raw) });
      } catch (error) {
        if (ticket !== generation.current) return;
        if (isAbort(error)) return;
        setState({
          status: 'failed',
          // "Could not ask" is not "nothing is installed". Those are different facts and
          // conflating them would tell an operator their reference data is missing when the
          // only failure was the request.
          reason: error instanceof Error ? error.message : 'The dataset probe failed.',
        });
      }
    })();
  }, []);

  useEffect(() => {
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { ...state, reload };
}
