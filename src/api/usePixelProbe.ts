/**
 * Coordinate probe, with strict request ownership (DF-X6C).
 *
 * The backend answers "what coordinate is this analytical pixel?". This hook
 * decides WHEN to ask and which answer to keep. It performs no geolocation of
 * its own: it receives a row/col and displays what the backend returns.
 *
 * LATEST-REQUEST OWNERSHIP
 *
 * Probes are not idempotent in practice. Click A then click B, and if A's
 * response arrives second, a naive implementation leaves A's coordinate on screen
 * next to B's marker -- which reads as a confident statement about the wrong
 * water. Two independent guards:
 *
 *   1. a monotonically increasing generation, so a late response for an older
 *      generation is discarded rather than rendered;
 *   2. an AbortController, so the superseded request is actually cancelled
 *      instead of merely ignored.
 *
 * HOVER DOES NOT PROBE
 *
 * Hover resolves a row/col locally and shows nothing but the pixel address.
 * Only an explicit click or a locked probe asks the backend. Hammering an
 * analytical endpoint on every mousemove would be wasteful and would make the
 * request log useless for provenance.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { probePixel, probeRefusal } from './probe';
import type { ProbeResponse } from './contract';
import type { AnalyticalPixel } from '../analytics/pixelMapping';

export type ProbeState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly pixel: AnalyticalPixel }
  | { readonly status: 'ready'; readonly pixel: AnalyticalPixel; readonly result: ProbeResponse }
  | { readonly status: 'refused'; readonly pixel: AnalyticalPixel; readonly reason: string };

export interface ProbeController {
  readonly state: ProbeState;
  /** Row/col only. No request. */
  readonly hover: (pixel: AnalyticalPixel | null) => void;
  /** Ask the backend. Cancels any superseded probe. */
  readonly lock: (pixel: AnalyticalPixel) => void;
  readonly clear: () => void;
  readonly hovered: AnalyticalPixel | null;
}

export function usePixelProbe(scanId: string | null): ProbeController {
  const [state, setState] = useState<ProbeState>({ status: 'idle' });
  const [hovered, setHovered] = useState<AnalyticalPixel | null>(null);

  // Generation counter: only the newest request may write state.
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const hover = useCallback((pixel: AnalyticalPixel | null) => {
    setHovered(pixel);
  }, []);

  const clear = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setState({ status: 'idle' });
    setHovered(null);
  }, []);

  const lock = useCallback(
    (pixel: AnalyticalPixel) => {
      if (!scanId) return;

      // Supersede: abort the previous request AND claim a new generation, so a
      // response already in flight can neither land nor cancel the new one.
      controller.current?.abort();
      const next = ++generation.current;
      const abort = new AbortController();
      controller.current = abort;

      setState({ status: 'pending', pixel });
      setHovered(pixel);

      void probePixel(scanId, pixel.row, pixel.col, abort.signal)
        .then((result) => {
          // Stale: a newer probe has been issued. Discard without touching state.
          if (next !== generation.current || !mounted.current) return;
          setState({ status: 'ready', pixel, result });
        })
        .catch((error: unknown) => {
          if (next !== generation.current || !mounted.current) return;
          // An abort is a supersession, not a failure: a newer probe is in flight.
          if (isAbort(error)) return;
          setState({
            status: 'refused',
            pixel,
            reason: probeRefusal(error) ?? describeUnknown(error),
          });
        });
    },
    [scanId],
  );

  return { state, hover, lock, clear, hovered };
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}