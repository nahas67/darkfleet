/**
 * Debug-layer client and per-layer load state (DF-X6C).
 *
 * Four states, because the four are analytically different and the interface has
 * to be able to say which one it is showing:
 *
 *   IDLE      not requested yet
 *   LOADING   in flight
 *   READY     the backend answered
 *   FAILED    the backend answered with an error
 *
 * `READY` with zero rows is NOT the same as `FAILED`, and neither is the same as
 * a layer that was never generated. Conflating them is how an operator ends up
 * reading "the detector found nothing" when the truth is "this layer was not
 * produced".
 */

import { api } from './errors';
import type { DebugLayerResponse } from './contract';
import type { DebugLayerId } from './debugLayers';

/** One layer's state. Cached per scan, because scan artifacts are immutable. */
export type LayerState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: DebugLayerResponse }
  | { readonly status: 'failed'; readonly detail: string };

export const IDLE: LayerState = { status: 'idle' };

/** Grid size for array previews. 8 is enough to show structure without a payload. */
const PREVIEW_GRID = 32;

/**
 * Fetch one debug layer.
 *
 * `limit` bounds a TABLE layer's row window. It is not sent for an array layer,
 * because the array path returns statistics plus an optional downsampled grid --
 * never the raster.
 *
 * A truncated table is returned as-is, with `truncated` set. The caller is
 * expected to say "showing N of M"; silently presenting the prefix as the whole
 * set would make 500 rows read as "500 components".
 */
export async function loadDebugLayer(
  scanId: string,
  layer: DebugLayerId,
  options: { readonly limit?: number; readonly grid?: number } = {},
): Promise<LayerState> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.grid !== undefined) params.set('grid', String(options.grid));

  const query = params.toString();
  // The layer route is mounted at the API ROOT: `/debug/{scan_id}/{layer}`.
  //
  // The probe is the odd one out -- `POST /scans/{scan_id}/debug/probe` is
  // nested under the scan -- so the two paths genuinely differ, and writing
  // `/scans/${scanId}/debug/${layer}` returns 404 while looking correct. Verified
  // against the running backend rather than assumed from the nesting of the probe.
  const path = `/api/debug/${scanId}/${layer}${query ? `?${query}` : ''}`;

  try {
    const data = await api.get<DebugLayerResponse>(path);
    return { status: 'ready', data };
  } catch (error) {
    return { status: 'failed', detail: describeFailure(error) };
  }
}

/** Load an array layer for its preview grid. */
export function loadArrayLayer(scanId: string, layer: DebugLayerId): Promise<LayerState> {
  return loadDebugLayer(scanId, layer, { grid: PREVIEW_GRID });
}

/** Load a table layer with a row window. */
export function loadTableLayer(
  scanId: string,
  layer: DebugLayerId,
  limit = 200,
): Promise<LayerState> {
  return loadDebugLayer(scanId, layer, { limit });
}

function describeFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const detail = (error as { detail?: { message?: string; error?: string } }).detail;
    if (detail?.message) return detail.message;
    if (detail?.error) return detail.error;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ------------------------------------------------------------------ reading */

/** One row of a table layer, keyed by the backend's declared column names. */
export type TableRow = Record<string, unknown>;

export function tableRows(state: LayerState): TableRow[] {
  if (state.status !== 'ready' || state.data.kind !== 'table') return [];
  return (state.data.data ?? []) as TableRow[];
}

export function tableColumns(state: LayerState): readonly string[] {
  if (state.status !== 'ready') return [];
  return state.data.columns ?? [];
}

/**
 * The row window, phrased for a human.
 *
 * `500 components` when 2817 exist is a false statement. This returns
 * `SHOWING 500 OF 2,817` instead, and only collapses to a plain count when the
 * window really is the whole set.
 */
export function rowWindowLabel(state: LayerState): string | null {
  if (state.status !== 'ready' || state.data.kind !== 'table') return null;
  const total = state.data.rows ?? 0;
  const shown = state.data.data?.length ?? 0;
  if (total === 0) return 'NO ROWS';
  if (state.data.truncated || shown < total) {
    return `SHOWING ${shown.toLocaleString('en-US')} OF ${total.toLocaleString('en-US')}`;
  }
  return `${total.toLocaleString('en-US')} ROWS`;
}

/** Whether the table was truncated, so the caller can state it visibly. */
export function isTruncated(state: LayerState): boolean {
  return state.status === 'ready' && state.data.truncated === true;
}

/** The backend's own notes for a layer. Provenance the interface must not paraphrase away. */
export function layerNotes(state: LayerState): readonly string[] {
  return state.status === 'ready' ? (state.data.notes ?? []) : [];
}

/* ------------------------------------------------------------------- cells */

/**
 * Render one table cell without inventing precision or units.
 *
 * A null is "not established", never 0. A float is shown at a fixed precision that
 * is finer than the measurement, not coarser.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** True when the cell holds a measured number rather than an absence. */
export function cellIsMeasured(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}