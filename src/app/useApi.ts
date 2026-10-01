/**
 * DarkFleet typed API client — the ONLY place in the frontend that fetches.
 *
 * Response shapes mirror `backend/darkfleet/api/models.py` exactly. This module
 * deliberately contains no detection, correlation, scoring or classification
 * logic: the Python backend is the single analytical authority (API-011). The
 * helpers here only re-type, re-group and re-label what the backend already
 * decided.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BoundingBox,
  DebugLayerId,
  ProviderHealthEntry,
  ProvidersHealth,
  ProviderState,
  RuntimeMode,
  ScanRequest,
} from '../types/api.ts';

export const API_BASE = '/api';

// ------------------------------------------------------------- wire responses
// These mirror the backend Pydantic response models. snake_case is intentional:
// renaming here would break the contract with the server.

export interface ScanAccepted {
  scan_id: string;
  status: string;
  runtime_mode: RuntimeMode;
  synthetic: boolean;
}

export interface StageEventOut {
  stage: string;
  timestamp: string;
  detail: string;
  terminal: boolean;
}

export interface ScanStateResponse {
  scan_id: string;
  stage: string;
  terminal: boolean;
  runtime_mode: string;
  synthetic: boolean;
  known: boolean;
  source: 'runner' | 'run_store';
  started_at: string | null;
  finished_at: string | null;
  failed_at: string | null;
  error: string | null;
  history: StageEventOut[];
  record_persisted: boolean;
}

export interface ScanTargetsResponse {
  scan_id: string;
  stage: string;
  runtime_mode: string;
  synthetic: boolean;
  count: number;
  ais_only_count: number;
  counts: Record<string, number>;
  targets: Array<Record<string, unknown>>;
  ais_only: Array<Record<string, unknown>>;
  provenance: Record<string, unknown>;
}

export interface SceneSummary {
  id: string;
  provider: string;
  platform: string;
  product: string;
  polarization: string;
  acquisition_time: string;
  bbox: number[];
  resolution_meters: number | null;
  georeferencing: string | null;
  sea_clutter_level: string | null;
  runtime_mode: RuntimeMode;
  synthetic: boolean;
}

export interface SceneListResponse {
  runtime_mode: RuntimeMode;
  synthetic: boolean;
  provider: string;
  status: string;
  note: string | null;
  count: number;
  scenes: SceneSummary[];
}

/** One live provider probe. `detail` is redacted by the backend. */
export interface ProviderProbe {
  provider: string;
  status: string;
  detail: string;
  last_check: string;
  latency_ms: number | null;
  error: string | null;
  capabilities: string[];
}

export interface HealthResponse {
  checked_at: string;
  runtime_mode: string;
  probe: string;
  providers: ProviderProbe[];
}

export interface TargetEvidenceResponse {
  scan_id: string;
  runtime_mode: string;
  synthetic: boolean;
  ambiguous: boolean;
  candidate_scan_ids: string[];
  evidence: Record<string, unknown>;
}

export interface EvidenceDocumentResponse {
  scan_id: string;
  runtime_mode: string;
  synthetic: boolean;
  ambiguous: boolean;
  candidate_scan_ids: string[];
  evidence: Record<string, unknown>;
}

export interface LayerStats {
  size: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  std: number | null;
  p01: number | null;
  p50: number | null;
  p99: number | null;
  nan_count: number;
  finite_fraction: number;
  true_count: number | null;
}

export interface DebugLayerResponse {
  scan_id: string;
  layer: DebugLayerId;
  kind: 'array' | 'table';
  source: string | null;
  shape: number[];
  dtype: string | null;
  stats: LayerStats | null;
  columns: string[] | null;
  rows: number | null;
  row_limit: number | null;
  truncated: boolean;
  grid_size: number | null;
  grid: number[][] | null;
}

export interface SceneQuery {
  bbox?: BoundingBox;
  datetime?: string;
  provider?: string;
  runtime_mode?: RuntimeMode;
}

export type ExportFormat = 'json' | 'csv' | 'geojson';

// -------------------------------------------------------------------- errors

/** Non-2xx backend response, carrying the server's own error code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function messageOf(status: number, body: unknown): { code: string; message: string } {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record.error === 'string' ? record.error : 'HTTP_ERROR';
    const message =
      typeof record.message === 'string' && record.message ? record.message : code;
    return { code, message };
  }
  return { code: 'HTTP_ERROR', message: `Request failed with status ${status}` };
}

// ------------------------------------------------------------------ the URLs
// Stream and export endpoints are consumed as URLs, not JSON bodies.

export function scanEventsUrl(scanId: string): string {
  return `${API_BASE}/scans/${encodeURIComponent(scanId)}/events`;
}

export function scanExportUrl(scanId: string, format: ExportFormat): string {
  return `${API_BASE}/scans/${encodeURIComponent(scanId)}/export/${encodeURIComponent(format)}`;
}

export function scenesUrl(query: SceneQuery = {}): string {
  const params = new URLSearchParams();
  if (query.bbox) params.set('bbox', query.bbox.join(','));
  if (query.datetime) params.set('datetime', query.datetime);
  if (query.provider) params.set('provider', query.provider);
  if (query.runtime_mode) params.set('runtime_mode', query.runtime_mode);
  const qs = params.toString();
  return qs ? `${API_BASE}/scenes?${qs}` : `${API_BASE}/scenes`;
}

// -------------------------------------------------------------------- client

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  createScan(request: ScanRequest): Promise<ScanAccepted>;
  getScanState(scanId: string): Promise<ScanStateResponse>;
  getScanTargets(scanId: string): Promise<ScanTargetsResponse>;
  getScenes(query?: SceneQuery): Promise<SceneListResponse>;
  getProvidersHealth(): Promise<HealthResponse>;
  getTargetEvidence(targetId: string): Promise<TargetEvidenceResponse>;
  getEvidenceDocument(targetId: string): Promise<EvidenceDocumentResponse>;
  getDebugLayer(scanId: string, layer: DebugLayerId): Promise<DebugLayerResponse>;
  scanEventsUrl(scanId: string): string;
  scanExportUrl(scanId: string, format: ExportFormat): string;
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', err instanceof Error ? err.message : 'Network error');
  }
  return readJson<T>(response);
}

/**
 * Build a client. `fetchImpl` defaults to the platform fetch; tests inject a
 * stub so no test ever touches the network.
 */
export function createApiClient(fetchImpl?: FetchLike): ApiClient {
  const doFetch: FetchLike =
    fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const postJson = <T,>(path: string, body: unknown): Promise<T> =>
    requestJson<T>(doFetch, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    createScan: (request) => postJson<ScanAccepted>(`${API_BASE}/scans`, request),

    getScanState: (scanId) =>
      requestJson<ScanStateResponse>(doFetch, `${API_BASE}/scans/${encodeURIComponent(scanId)}`),

    getScanTargets: (scanId) =>
      requestJson<ScanTargetsResponse>(
        doFetch,
        `${API_BASE}/scans/${encodeURIComponent(scanId)}/targets`,
      ),

    getScenes: (query = {}) =>
      requestJson<SceneListResponse>(doFetch, scenesUrl(query)),

    getProvidersHealth: () =>
      requestJson<HealthResponse>(doFetch, `${API_BASE}/providers/health`),

    getTargetEvidence: (targetId) =>
      requestJson<TargetEvidenceResponse>(
        doFetch,
        `${API_BASE}/targets/${encodeURIComponent(targetId)}`,
      ),

    getEvidenceDocument: (targetId) =>
      requestJson<EvidenceDocumentResponse>(
        doFetch,
        `${API_BASE}/evidence/${encodeURIComponent(targetId)}`,
      ),

    getDebugLayer: (scanId, layer) =>
      requestJson<DebugLayerResponse>(
        doFetch,
        `${API_BASE}/debug/${encodeURIComponent(scanId)}/${encodeURIComponent(layer)}`,
      ),

    scanEventsUrl,
    scanExportUrl,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const { code, message } = messageOf(response.status, body);
    throw new ApiError(response.status, code, message);
  }
  if (body === null) {
    throw new ApiError(response.status, 'EMPTY_RESPONSE', 'Backend returned no JSON body.');
  }
  return body as T;
}

// ------------------------------------------------------- provider adaptation
// The backend probes a flat provider list; the frontend groups it into the
// declared `ProvidersHealth` shape. Nothing is invented: an unrecognised status
// degrades to UNAVAILABLE and the raw string is preserved in the message.

const PROVIDER_STATES: readonly ProviderState[] = [
  'AVAILABLE',
  'DEGRADED',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'NO_COVERAGE',
  'UNAVAILABLE',
  'NOT_CONFIGURED',
];

export function isProviderState(value: string): value is ProviderState {
  return (PROVIDER_STATES as readonly string[]).includes(value);
}

/** The AIS archive probe is the only `*ais*` provider the backend registers. */
export function isAisProvider(probe: ProviderProbe): boolean {
  return (
    probe.provider.toLowerCase().includes('ais') ||
    probe.capabilities.some((c) => c.toLowerCase().includes('ais'))
  );
}

export function toProviderHealthEntry(probe: ProviderProbe): ProviderHealthEntry {
  const status = isProviderState(probe.status) ? probe.status : 'UNAVAILABLE';
  const detail = isProviderState(probe.status)
    ? probe.detail
    : `Unrecognised provider status "${probe.status}": ${probe.detail}`;
  return {
    provider: probe.provider,
    status,
    message: detail,
    last_check: probe.last_check,
    error: probe.error,
    coverage: probe.capabilities.length ? probe.capabilities.join(', ') : null,
  };
}

export function toProvidersHealth(response: HealthResponse): ProvidersHealth {
  const sar: ProviderHealthEntry[] = [];
  const ais: ProviderHealthEntry[] = [];
  for (const probe of response.providers) {
    (isAisProvider(probe) ? ais : sar).push(toProviderHealthEntry(probe));
  }
  return { sar, ais };
}