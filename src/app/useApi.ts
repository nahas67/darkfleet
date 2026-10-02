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

// ---------------------------------------------------------------------------
// WIRE CONTRACT - GENERATED, RE-EXPORTED
//
// The seven interfaces below used to be written out by hand here. They were
// removed in IR1: the backend validates them, the OpenAPI schema declares them,
// and src/api/contract.ts is generated from that schema. Two hand-written
// mirrors of one shape is exactly how the `cls` / `classification` drift shipped
// undetected -- the frontend declared a field the backend never sent, and a
// detection's class was `undefined` in every live render path.
//
// The Revisit* family below is deliberately NOT generated, because /api/revisit
// still returns an untyped JSON body. Giving it a declared response model is a
// tracked follow-up, not something to pretend already exists.
//
// A local `ProviderProbe` used to sit here as "the raw probe that gets normalised
// into ProviderHealthEntry". Once ProviderHealthEntry became generated, the two
// were the same shape -- the /api/providers/health row IS the probe -- so the
// duplicate was deleted rather than kept in sync by hand.
// ---------------------------------------------------------------------------
export type {
  DebugLayerResponse,
  HealthResponse,
  LayerStats,
  ScanAccepted,
  ScanStateResponse,
  ScanTargetsResponse,
  SceneListResponse,
  SceneSummary,
} from '../types/api.ts';
import type {
  DebugLayerResponse,
  HealthResponse,
  LayerStats,
  ScanAccepted,
  ScanStateResponse,
  ScanTargetsResponse,
  SceneListResponse,
  SceneSummary,
} from '../types/api.ts';

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

export interface StageEventOut {
  stage: string;
  timestamp: string;
  detail: string;
  terminal: boolean;
}

/** One live provider probe. `detail` is redacted by the backend. */

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


/**
 * Scene search parameters.
 *
 * There is no `runtime_mode` filter: the synthetic scene catalogue was removed
 * and there is no mode to select. The endpoint ignores an unrecognised
 * `runtime_mode` query parameter rather than erroring on it, so a stale caller
 * asking for `?runtime_mode=DEMO` still receives real provider scenes and never
 * a substitute. Every scene this can return is a real acquisition from the
 * provider probe.
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

/** One real acquisition the provider catalogue holds (GEO-002). */
export interface RevisitAcquisition {
  readonly item_id: string;
  readonly acquisition_time: string;
  readonly platform: string;
  readonly collection: string;
  readonly polarizations: readonly string[];
}

/** A measured interval between consecutive acquisitions. */
export interface RevisitGap {
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly window_edge: boolean;
  readonly exceeds_nominal: boolean;
}

/**
 * `null` here is a real answer from the backend meaning "not enough
 * acquisitions to say". It must never be coerced to 0.
 */
export interface RevisitStatistics {
  readonly platform_count: number;
  readonly acquisitions_per_platform: Readonly<Record<string, number>>;
  readonly interior_gap_count: number;
  readonly median_revisit_days: number | null;
  readonly min_revisit_days: number | null;
  readonly max_revisit_days: number | null;
  readonly flagged_gap_count: number;
  readonly nominal_repeat_days: number;
}

export interface RevisitPlan {
  readonly acquisition_count: number;
  readonly acquisitions: readonly RevisitAcquisition[];
  readonly gaps: readonly RevisitGap[];
  readonly statistics: RevisitStatistics;
  readonly window: { readonly start: string | null; readonly end: string | null };
  readonly next_after: RevisitAcquisition | null;
  readonly limitations: readonly string[];
  readonly provider: string;
  readonly collection: string;
  readonly requested_bbox: readonly number[];
}

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
  /** SAR acquisition plan for an area (GEO-002). Measured from the catalogue. */
  getRevisitPlan(
    bbox: readonly number[],
    options?: { provider?: string; historyDays?: number; horizonDays?: number },
  ): Promise<RevisitPlan>;
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

    getRevisitPlan: (bbox, options = {}) => {
      const params = new URLSearchParams({ bbox: bbox.join(',') });
      if (options.provider) params.set('provider', options.provider);
      params.set('history_days', String(options.historyDays ?? 120));
      params.set('horizon_days', String(options.horizonDays ?? 30));
      return requestJson<RevisitPlan>(doFetch, `${API_BASE}/revisit?${params.toString()}`);
    },

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
  'UNAVAILABLE',
  'NOT_CONFIGURED',
];

export function isProviderState(value: string): value is ProviderState {
  return (PROVIDER_STATES as readonly string[]).includes(value);
}

/** The AIS archive probe is the only `*ais*` provider the backend registers. */
export function isAisProvider(probe: ProviderHealthEntry): boolean {
  return (
    probe.provider.toLowerCase().includes('ais') ||
    (probe.capabilities ?? []).some((c) => c.toLowerCase().includes('ais'))
  );
}

export function toProviderHealthEntry(probe: ProviderHealthEntry): ProviderHealthEntry {
  const status = isProviderState(probe.status) ? probe.status : 'UNAVAILABLE';
  const detail = isProviderState(probe.status)
    ? probe.detail
    : `Unrecognised provider status "${probe.status}": ${probe.detail}`;
  // `detail` carries the human reason and is always present; `error` carries
  // the raw failure when there is one. The previous adapter invented a
  // `message` field the contract never declared, so every consumer reading
  // `.message` rendered an empty reason for every provider.
  return {
    provider: probe.provider,
    status,
    detail,
    last_check: probe.last_check,
    error: probe.error,
    // `capabilities` is the contract's name. The adapter previously invented a
    // `coverage` string, which was neither in the contract nor a capability list,
    // and every consumer of it silently read undefined.
    capabilities: probe.capabilities,
  };
}

export function toProvidersHealth(response: HealthResponse): ProvidersHealth {
  const sar: ProviderHealthEntry[] = [];
  const ais: ProviderHealthEntry[] = [];
  // `providers` is optional in the contract: the backend omits it when no
  // probe was attempted. An absent list is an absent list, not an empty
  // panel claiming every provider was checked and found nothing.
  for (const probe of response.providers ?? []) {
    (isAisProvider(probe) ? ais : sar).push(toProviderHealthEntry(probe));
  }
  return { sar, ais };
}