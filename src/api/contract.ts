// GENERATED FILE - DO NOT EDIT BY HAND.
//
// Produced by `python -m tools.export_contract` from the FastAPI OpenAPI schema.
// `src/api/contract.ts` is the single source of truth for every wire shape the
// frontend consumes; the backend validates against the same declarations.
//
// Regenerate after any API change, or run with --check to prove it is current.
//
// This file was generated because two hand-written mirrors of one shape had
// drifted: the frontend declared `classification` while the backend emitted `cls`,
// and a detection's class was undefined in every live render path.

/* eslint-disable */

export const CLASSIFICATION_VALUES = [
  'SAR_MATCHED_AIS',
  'SAR_UNMATCHED',
  'AIS_ONLY',
  'STATIONARY_OR_INFRASTRUCTURE',
  'SEA_CLUTTER',
  'LOW_CONFIDENCE',
  'UNRESOLVED',
] as const;

export type TargetClassification = (typeof CLASSIFICATION_VALUES)[number];


export interface ScoreDecomposition {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly spatialScore: number;
  readonly temporalScore: number;
  readonly headingScore: number;
  readonly sizeScore: number;
  readonly compositeScore: number;
  readonly matchRadiusMeters: number;
  readonly distanceOffsetMeters: number;
  readonly timeDeltaSeconds: number;
}

export interface AisAssociation {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly matched: boolean;
  readonly mmsi?: string | null;
  readonly vesselName?: string | null;
  readonly distanceOffsetMeters?: number | null;
  readonly timeDeltaSeconds?: number | null;
  readonly predictedLat?: number | null;
  readonly predictedLon?: number | null;
  readonly aisAssociationConfidence?: number;
  readonly scoreDecomposition?: ScoreDecomposition | null;
}

export interface VesselTarget {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly classification: "SAR_MATCHED_AIS" | "SAR_UNMATCHED" | "AIS_ONLY" | "STATIONARY_OR_INFRASTRUCTURE" | "SEA_CLUTTER" | "LOW_CONFIDENCE" | "UNRESOLVED";
  readonly lat: number;
  readonly lon: number;
  readonly sarConf: number;
  readonly aisConf: number;
  readonly lenM: number;
  readonly widM: number;
  readonly lenUncM: number;
  readonly hdg: number | null;
  readonly wake: boolean;
  readonly meanDb: number;
  readonly maxDb: number;
  readonly area: number;
  readonly corr: AisAssociation;
  readonly assessment: string | null;
  readonly tags: string[];
}

export interface AisOnlyTarget {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly cls?: "AIS_ONLY";
  readonly mmsi: string;
  readonly vesselName?: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly timestamp: string;
}

export interface ScanTargetsResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly stage: string;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  readonly aoi: number[];
  readonly count: number;
  readonly ais_only_count: number;
  readonly counts: Record<string, number>;
  readonly targets: VesselTarget[];
  readonly ais_only: AisOnlyTarget[];
  readonly provenance?: Record<string, unknown>;
  readonly scene?: ScanScene | null;
  readonly acquisition_time?: string | null;
}

export interface SceneSummary {
  readonly id: string;
  readonly provider: string;
  readonly platform: string;
  readonly product: string;
  readonly polarization: string;
  readonly acquisition_time: string;
  readonly bbox: number[];
  readonly resolution_meters?: number | null;
  readonly georeferencing?: string | null;
  readonly sea_clutter_level?: string | null;
  readonly runtime_mode: "REAL";
  readonly synthetic: boolean;
}

export interface SceneListResponse {
  readonly runtime_mode: "REAL";
  readonly synthetic: boolean;
  readonly provider: string;
  /** ProviderStatus value for the probe behind these scenes. */
  readonly status: ProviderStatus;
  readonly note?: string | null;
  readonly count: number;
  readonly scenes?: SceneSummary[];
}

export interface ScanAccepted {
  readonly scan_id: string;
  /** ScanStage the job was accepted in (always QUEUED). */
  readonly status: string;
  readonly runtime_mode: "REAL";
  readonly synthetic: boolean;
}

export interface StageEventOut {
  readonly stage: ScanStage;
  readonly timestamp: string;
  readonly detail: string;
  readonly terminal: boolean;
}

export interface ScanStateResponse {
  readonly scan_id: string;
  readonly stage: ScanStage;
  readonly terminal: boolean;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  /** False when the record was recovered from disk only. */
  readonly known: boolean;
  readonly source?: "runner" | "run_store";
  readonly started_at?: string | null;
  readonly finished_at?: string | null;
  /** Pipeline stage that was in flight when the job failed. */
  readonly failed_at?: ScanStage | null;
  readonly error?: string | null;
  readonly history?: StageEventOut[];
  readonly record_persisted?: boolean;
}

export interface ProviderHealthEntry {
  readonly provider: string;
  /** ProviderStatus value. */
  readonly status: ProviderStatus;
  readonly detail: string;
  readonly last_check: string;
  readonly latency_ms?: number | null;
  readonly error?: string | null;
  readonly capabilities?: string[];
}

export interface HealthResponse {
  readonly checked_at: string;
  readonly runtime_mode: string;
  /** Always 'live': statuses come from real requests. */
  readonly probe?: string;
  readonly providers?: ProviderHealthEntry[];
}

export interface TargetEvidenceResponse {
  readonly scan_id: string;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  /** True when the target id exists in more than one stored scan. */
  readonly ambiguous: boolean;
  readonly candidate_scan_ids?: string[];
  readonly evidence: Record<string, unknown>;
}

export interface EvidenceDocumentResponse {
  readonly scan_id: string;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  readonly ambiguous: boolean;
  readonly candidate_scan_ids?: string[];
  readonly evidence: Record<string, unknown>;
}

export interface DebugLayerResponse {
  readonly scan_id: string;
  readonly layer: string;
  readonly kind: "array" | "table";
  /** Pipeline artifact the layer was derived from. */
  readonly source?: string | null;
  readonly shape?: number[];
  readonly dtype?: string | null;
  readonly stats?: LayerStats | null;
  readonly columns?: string[] | null;
  readonly rows?: number | null;
  readonly row_limit?: number | null;
  readonly truncated?: boolean;
  /** Side length of the returned grid. */
  readonly grid_size?: number | null;
  readonly grid?: number[][] | null;
  readonly notes?: string[];
}

export interface LayerStats {
  readonly size: number;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly mean?: number | null;
  readonly std?: number | null;
  readonly p01?: number | null;
  readonly p50?: number | null;
  readonly p99?: number | null;
  readonly nan_count?: number;
  readonly finite_fraction?: number;
  /** Set for boolean layers: number of True pixels. */
  readonly true_count?: number | null;
}

export interface AisObservationOut {
  readonly timestamp: string;
  readonly mmsi: string;
  readonly lat: number;
  readonly lon: number;
  /** knots; null when not reported */
  readonly sog?: number | null;
  /** degrees true; null when not reported */
  readonly cog?: number | null;
  /** degrees true; null when not reported or the AIS 511 sentinel was sent */
  readonly heading?: number | null;
  readonly nav_status?: string | null;
  readonly ship_name?: string | null;
  readonly callsign?: string | null;
  readonly imo?: string | null;
  readonly ship_type?: string | null;
  readonly length_m?: number | null;
  readonly width_m?: number | null;
  readonly source?: string | null;
}

export interface AisCoverageOut {
  readonly state: AisCoverageState;
  readonly detail: string;
  readonly observation_count?: number | null;
  readonly window_start?: string | null;
  readonly window_end?: string | null;
  readonly archive_oldest?: string | null;
  readonly archive_newest?: string | null;
  readonly sources?: string[];
}

export interface ScanAisWindow {
  readonly start: string;
  readonly end: string;
}

export interface ScanAisResponse {
  readonly scan_id: string;
  readonly coverage: AisCoverageOut;
  readonly window?: ScanAisWindow | null;
  readonly bbox?: unknown[] | null;
  readonly observations?: AisObservationOut[];
  readonly note: string;
}

export interface TargetAisResponse {
  readonly target_id: string;
  readonly mmsi?: string | null;
  readonly associated: boolean;
  readonly coverage: AisCoverageOut;
  readonly window?: ScanAisWindow | null;
  readonly observations?: AisObservationOut[];
  readonly note: string;
}

export interface VesselTrackResponse {
  readonly mmsi: string;
  readonly coverage: AisCoverageOut;
  readonly ship_name?: string | null;
  readonly callsign?: string | null;
  readonly imo?: string | null;
  readonly ship_type?: string | null;
  readonly length_m?: number | null;
  readonly width_m?: number | null;
  readonly observations?: AisObservationOut[];
  readonly note: string;
}

export interface ScanScene {
  readonly provider?: string;
  readonly collection?: string;
  readonly item_id?: string;
  readonly platform?: string;
  readonly acquisition_time?: string;
  readonly product?: string;
  readonly polarization?: string;
  readonly asset_href?: string;
  readonly crs?: string | null;
  readonly resolution_m?: number | null;
}

export type ProviderStatus = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "AUTH_REQUIRED" | "RATE_LIMITED" | "NOT_CONFIGURED";

/** The 16 states of a scan, declared in pipeline order. */
export type ScanStage = "QUEUED" | "SEARCHING_SCENE" | "READING_SAR" | "PREPROCESSING" | "MASKING" | "FILTERING" | "DETECTING" | "EXTRACTING" | "GEOLOCATING" | "LOADING_AIS" | "ALIGNING" | "CORRELATING" | "SCORING" | "PERSISTING" | "COMPLETE" | "FAILED";

/** Whether the archive can answer a question, and how completely. */
export type AisCoverageState = "AVAILABLE" | "PARTIAL" | "NO_COVERAGE" | "NOT_CONFIGURED";

/** Schemas emitted into this file. */
export type ContractSchemaName =
  | 'ScoreDecomposition'
  | 'AisAssociation'
  | 'VesselTarget'
  | 'AisOnlyTarget'
  | 'ScanTargetsResponse'
  | 'SceneSummary'
  | 'SceneListResponse'
  | 'ScanAccepted'
  | 'StageEventOut'
  | 'ScanStateResponse'
  | 'ProviderHealthEntry'
  | 'HealthResponse'
  | 'TargetEvidenceResponse'
  | 'EvidenceDocumentResponse'
  | 'DebugLayerResponse'
  | 'LayerStats'
  | 'AisObservationOut'
  | 'AisCoverageOut'
  | 'ScanAisWindow'
  | 'ScanAisResponse'
  | 'TargetAisResponse'
  | 'VesselTrackResponse'
  | 'ScanScene'
  | 'ProviderStatus'
  | 'ScanStage'
  | 'AisCoverageState'
;

/**
 * ScanStage values in the backend's declared pipeline order.
 *
 * Generated. Consumers must not extend or reorder this.
 */
export const SCAN_STAGE_ORDER = [
  'QUEUED',
  'SEARCHING_SCENE',
  'READING_SAR',
  'PREPROCESSING',
  'MASKING',
  'FILTERING',
  'DETECTING',
  'EXTRACTING',
  'GEOLOCATING',
  'LOADING_AIS',
  'ALIGNING',
  'CORRELATING',
  'SCORING',
  'PERSISTING',
  'COMPLETE',
  'FAILED',
] as const;
