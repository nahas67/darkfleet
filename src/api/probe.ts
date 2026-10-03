/**
 * Probe client: the frontend asks, the backend answers.
 *
 * DF-X6B proves the vertical path exists end to end without building the raster
 * canvas, which is DF-X6C's job. What matters here is that the request and
 * response types come from the GENERATED contract rather than being written out
 * again, so a backend rename becomes a compile error.
 *
 * There is deliberately no coordinate arithmetic in this file. No affine, no CRS
 * conversion, no interpolation. The browser asks "what coordinate is this
 * analytical pixel?" and displays what it is told.
 */

import { api } from './errors';
import type { ProbeRequest, ProbeResponse } from './contract';

/**
 * Ask the backend where one analytical pixel is.
 *
 * `row`/`col` are positions in the scan's WINDOW raster, in that raster's own
 * pixel space. They are floats on purpose: connected-component centroids are not
 * whole pixels, and an integer type here would invite a `Math.round` that
 * discards up to half a pixel -- about 5 m at 10 m resolution, which is larger
 * than the geolocation uncertainty this product reports.
 *
 * The response is the ONLY source of the coordinate. Nothing here derives one.
 *
 * `signal` lets a superseded probe be cancelled. Cancellation is not merely
 * ignored: a stale response must not be able to overwrite a newer one, which is
 * what `usePixelProbe`'s generation counter guarantees.
 */
export async function probePixel(
  scanId: string,
  row: number,
  col: number,
  signal?: AbortSignal,
): Promise<ProbeResponse> {
  const body: ProbeRequest = { row, col };
  return api.post<ProbeResponse>(`/api/scans/${scanId}/debug/probe`, body, signal);
}

/** Why a probe was refused, in the API's own words. */
export function probeRefusal(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const detail = (error as { detail?: { error?: string; message?: string } }).detail;
  if (!detail || typeof detail.error !== 'string') return null;
  return detail.message ?? detail.error;
}