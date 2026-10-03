/**
 * Advanced analysis delivery (ADV-007..012).
 *
 * Four capabilities the backend had fully implemented and no operator could
 * reach: revisit planning, multi-pass track hypotheses, longitudinal patterns,
 * and the detector registry. Their routes answered with a bare `dict[str, Any]`,
 * so the contract generator had no schema to translate and the only way to
 * render them would have been a hand-written mirror of the payload.
 *
 * The backend now declares response models and these functions are typed from
 * the generated contract, so the wire shape has exactly one authority.
 *
 * The truthfulness rule that shapes every function here: a failed request sets an
 * explicit error state. It never falls back to an empty-but-successful result,
 * because "the provider could not answer" and "there is nothing there" are
 * different findings and the interface has to be able to say which.
 */

import { api } from './errors';
import type { DetectorsOut, PatternsOut, RevisitPlanOut, TracksOut } from './contract';

/** No coverage, no absence of effort. Distinguishes the two on every panel. */
export type Loadable<T> =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly data: T }
  | { readonly state: 'failed'; readonly detail: string };

const IDLE = { state: 'idle' } as const;

/**
 * Acquisition planning for an area.
 *
 * `bbox` is REQUIRED, exactly as with scene search: the backend plans a real
 * window over a real place, and a global "plan" would be a catalogue dump
 * wearing a planning label.
 *
 * The plan is built from the provider catalogue, never from an orbit
 * prediction. Every entry is an acquisition that genuinely exists.
 */
export async function loadRevisit(bbox: readonly number[] | null): Promise<Loadable<RevisitPlanOut>> {
  if (!bbox || bbox.length !== 4) return IDLE;
  const query = bbox.map((v) => v.toFixed(6)).join(',');
  try {
    const data = await api.get<RevisitPlanOut>(
      `/api/revisit?bbox=${encodeURIComponent(query)}`,
    );
    return { state: 'ready', data };
  } catch (error) {
    // A provider failure stays a failure. There is no simulated plan and no
    // predicted pass to fall back to.
    return { state: 'failed', detail: describe(error) };
  }
}

/**
 * Multi-pass track HYPOTHESES over the persisted history.
 *
 * A single stored scan legitimately yields zero tracks, which is why the counts
 * of what was considered travel with the result: zero tracks over one scan is
 * an answer, not a failure to compute.
 */
export async function loadTracks(maxScans = 50): Promise<Loadable<TracksOut>> {
  try {
    const data = await api.get<TracksOut>(`/api/tracks?max_scans=${maxScans}`);
    return { state: 'ready', data };
  } catch (error) {
    return { state: 'failed', detail: describe(error) };
  }
}

/**
 * Longitudinal behaviour patterns.
 *
 * Each pattern carries its observation, its hypothesis, a bounded confidence
 * and its explicit unknowns as four separate fields. A pattern is something to
 * investigate; it is never a finding about conduct.
 */
export async function loadPatterns(maxScans = 50): Promise<Loadable<PatternsOut>> {
  try {
    const data = await api.get<PatternsOut>(`/api/patterns?max_scans=${maxScans}`);
    return { state: 'ready', data };
  } catch (error) {
    return { state: 'failed', detail: describe(error) };
  }
}

/**
 * The detector registry.
 *
 * An ML or ensemble adapter without a declared training domain and validation
 * data is refused at registration, so a card appearing in this list is itself
 * the evidence that the provenance requirements were met.
 */
export async function loadDetectors(): Promise<Loadable<DetectorsOut>> {
  try {
    const data = await api.get<DetectorsOut>('/api/detectors');
    return { state: 'ready', data };
  } catch (error) {
    return { state: 'failed', detail: describe(error) };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}