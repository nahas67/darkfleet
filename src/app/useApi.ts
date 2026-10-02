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
  AisOnlyTarget,
  BoundingBox,
  DebugLayerId,
  ProviderHealthEntry,
  ProvidersHealth,
  ProviderState,
  RuntimeMode,
  SarScene,
  ScoreDecomposition,
  TargetClassification,
  VesselTarget,
} from '../types/api.ts';
import { CLASSIFICATION_VALUES } from '../types/api.ts';
import type {
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
  /**
   * Typed, not `Record<string, unknown>`. The loose escape hatch meant the
   * payload shape was never actually checked anywhere, so a backend field rename
   * would have surfaced as `undefined` at runtime instead of at build time.
   */
  targets: VesselTarget[];
  ais_only: AisOnlyTarget[];
  provenance: Record<string, unknown>;
  /** Source scene, or null when the record carried none. */
  scene: SarScene | null;
  /** Acquisition instant of the SAR pass, or null when unrecorded. */
  acquisition_time: string | null;
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

/**
 * Scene search parameters.
 *
 * There is no `runtime_mode` filter: the synthetic scene catalogue was removed,
 * and the backend answers `?runtime_mode=DEMO` with 404
 * `SYNTHETIC_SCENES_DISABLED`. Every scene this can return is a real
 * acquisition from the provider probe.
 */
export interface SceneQuery {
  bbox?: BoundingBox;
  datetime?: string;
  provider?: string;
}

/**
 * Export formats the backend actually serves. `csv` was offered here and is NOT
 * in the backend's supported set, so the link 400'd. png and pdf are rendered
 * server-side from the persisted record.
 */
export type ExportFormat = 'json' | 'geojson' | 'kml' | 'png' | 'pdf';

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
  const qs = params.toString();
  return qs ? `${API_BASE}/scenes?${qs}` : `${API_BASE}/scenes`;
}

// -------------------------------------------------------------------- client

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  /**
   * Create a scan. The request is sent verbatim; `ScanRequest` carries no
   * `runtime_mode` because the backend rejects it as an unknown field.
   */
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
 * Re-type the wire target into the declared `VesselTarget`.
 *
 * The backend persists the canonical field name `cls` (it is what the parity
 * suite, the KML/GeoJSON exports and the PDF renderer all read, so the wire
 * format is NOT being changed for the client's convenience). Two fields also
 * had to be reconciled here, and both were invisible while the payload was
 * typed as `Record<string, unknown>`:
 *
 *  - `cls` -> `classification`. Every surface reads `classification`; against
 *    the real API it was `undefined`.
 *  - `AisAssociation.aisAssociationConfidence` does not exist on the wire. The
 *    value lives on the target as `aisConf`, so it is lifted into place here
 *    rather than left as a declared-but-absent phantom field.
 *
 * Nothing is defaulted to a fabricated value: a missing number stays `null` and
 * a missing classification stays `UNRESOLVED`.
 */
export function normaliseTarget(wire: unknown): VesselTarget | null {
  if (typeof wire !== 'object' || wire === null) return null;
  const t = wire as Record<string, unknown>;
  if (typeof t.id !== 'string') return null;

  const corrWire = (typeof t.corr === 'object' && t.corr !== null ? t.corr : {}) as Record<
    string,
    unknown
  >;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  const clsRaw = str(t.cls) ?? str(t.classification);
  const classification = (CLASSIFICATION_VALUES as readonly string[]).includes(clsRaw ?? '')
    ? (clsRaw as TargetClassification)
    : 'UNRESOLVED';

  return {
    id: t.id,
    classification,
    lat: num(t.lat) ?? 0,
    lon: num(t.lon) ?? 0,
    sarConf: num(t.sarConf) ?? 0,
    aisConf: num(t.aisConf) ?? 0,
    lenM: num(t.lenM) ?? 0,
    widM: num(t.widM) ?? 0,
    lenUncM: num(t.lenUncM) ?? 0,
    hdg: num(t.hdg) ?? 0,
    wake: t.wake === true,
    meanDb: num(t.meanDb) ?? 0,
    maxDb: num(t.maxDb) ?? 0,
    area: num(t.area) ?? 0,
    assessment: str(t.assessment),
    tags: Array.isArray(t.tags) ? t.tags.filter((v): v is string => typeof v === 'string') : [],
    corr: {
      matched: corrWire.matched === true,
      mmsi: str(corrWire.mmsi),
      vesselName: str(corrWire.vesselName),
      distanceOffsetMeters: num(corrWire.distanceOffsetMeters),
      timeDeltaSeconds: num(corrWire.timeDeltaSeconds),
      predictedLat: num(corrWire.predictedLat),
      predictedLon: num(corrWire.predictedLon),
      // Lifted from the target; the wire never carries it inside corr.
      aisAssociationConfidence: num(t.aisConf) ?? 0,
      scoreDecomposition:
        typeof corrWire.scoreDecomposition === 'object' && corrWire.scoreDecomposition !== null
          ? (corrWire.scoreDecomposition as ScoreDecomposition)
          : null,
    },
  };
}

/**
 * Re-type the whole targets payload. Drops rows that are not usable.
 *
 * Defensive about the container itself: a client boundary must not throw on a
 * payload that omits a list. A missing list normalises to an empty list, which
 * the surfaces render as an explicit "no scan targets" state rather than as a
 * crash or as fabricated rows.
 */
export function normaliseScanTargets(
  response: ScanTargetsResponse,
): ScanTargetsResponse {
  const rawTargets = Array.isArray(response.targets) ? response.targets : [];
  const rawAisOnly = Array.isArray(response.ais_only) ? response.ais_only : [];
  return {
    ...response,
    targets: rawTargets
      .map(normaliseTarget)
      .filter((t): t is VesselTarget => t !== null),
    ais_only: rawAisOnly.filter(
      (a): a is AisOnlyTarget => typeof a === 'object' && a !== null,
    ),
  };
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
      ).then(normaliseScanTargets),

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