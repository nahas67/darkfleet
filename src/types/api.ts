/**
 * DarkFleet wire contracts — mirror of the backend Pydantic models.
 *
 * These are TYPES ONLY. The frontend holds no detector, correlation,
 * classification or evidence logic: the Python backend is the single
 * authoritative implementation (API-011). Anything that must be computed
 * analytically belongs in `backend/darkfleet/`.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** The 7 canonical classifications. No dark_vessel / threatLevel aliases. */
export type TargetClassification =
  | 'SAR_MATCHED_AIS'
  | 'SAR_UNMATCHED'
  | 'AIS_ONLY'
  | 'STATIONARY_OR_INFRASTRUCTURE'
  | 'SEA_CLUTTER'
  | 'LOW_CONFIDENCE'
  | 'UNRESOLVED';

export type RuntimeMode = 'DEMO' | 'REAL';

/** The 15 canonical job stages, in pipeline order. */
export type ScanStage =
  | 'QUEUED'
  | 'SEARCHING_SCENE'
  | 'READING_SAR'
  | 'PREPROCESSING'
  | 'MASKING'
  | 'FILTERING'
  | 'DETECTING'
  | 'EXTRACTING'
  | 'LOADING_AIS'
  | 'ALIGNING'
  | 'CORRELATING'
  | 'SCORING'
  | 'PERSISTING'
  | 'COMPLETE'
  | 'FAILED';

export const SCAN_PIPELINE: ScanStage[] = [
  'QUEUED', 'SEARCHING_SCENE', 'READING_SAR', 'PREPROCESSING', 'MASKING',
  'FILTERING', 'DETECTING', 'EXTRACTING', 'LOADING_AIS', 'ALIGNING',
  'CORRELATING', 'SCORING', 'PERSISTING', 'COMPLETE',
];

/** Provider capability states. NEVER inferred from the presence of an env var. */
export type ProviderState =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NO_COVERAGE'
  | 'UNAVAILABLE'
  | 'NOT_CONFIGURED';

export type BoundingBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export interface ProviderHealthEntry {
  provider: string;
  status: ProviderState;
  message: string;
  last_check?: string | null;
  error?: string | null;
  coverage?: string | null;
}

export interface ProvidersHealth {
  sar: ProviderHealthEntry[];
  ais: ProviderHealthEntry[];
}

export interface SarScene {
  provider: string;
  collection: string;
  item_id: string;
  platform: string;
  acquisition_time: string;
  product: 'GRD' | 'RTC' | 'SIM' | string;
  polarization: string;
  asset_href: string;
  crs: string | null;
  resolution_m: number | null;
}

export interface ScoreDecomposition {
  spatialScore: number;
  temporalScore: number;
  headingScore: number;
  sizeScore: number;
  compositeScore: number;
  matchRadiusMeters: number;
  distanceOffsetMeters: number;
  timeDeltaSeconds: number;
}

export interface AisAssociation {
  matched: boolean;
  mmsi: string | null;
  vesselName: string | null;
  distanceOffsetMeters: number | null;
  timeDeltaSeconds: number | null;
  predictedLat: number | null;
  predictedLon: number | null;
  aisAssociationConfidence: number;
  scoreDecomposition: ScoreDecomposition | null;
}

export interface VesselTarget {
  id: string;
  classification: TargetClassification;
  lat: number;
  lon: number;
  /** SAR detection confidence, 0..1, explainable via the evidence endpoint. */
  sarConf: number;
  /** AIS association confidence, 0 when no association was established. */
  aisConf: number;
  /** Apparent SAR footprint length in metres (NOT an exact vessel length). */
  lenM: number;
  /** Apparent SAR footprint width in metres. */
  widM: number;
  /** Explicit uncertainty on the apparent footprint. Never dropped. */
  lenUncM: number;
  hdg: number;
  wake: boolean;
  meanDb: number;
  maxDb: number;
  area: number;
  corr: AisAssociation;
  assessment: string;
  tags: string[];
}

export interface AisOnlyTarget {
  cls: 'AIS_ONLY';
  mmsi: string;
  vesselName: string | null;
  lat: number;
  lon: number;
  timestamp: string;
}

export interface Provenance {
  software_version: string;
  processing_version: string;
  classification_schema: string;
  recorded_at: string;
  runtime_mode: RuntimeMode;
  synthetic: boolean;
  sar: Record<string, unknown>;
  aoi: number[];
  processing: {
    config_hash: string;
    land_mask: Record<string, unknown>;
    speckle: Record<string, unknown>;
    cfar: Record<string, unknown>;
  };
  ais: { provider: string };
  matching: Record<string, unknown>;
}

export interface ScanResult {
  scan_id: string;
  runtime_mode: RuntimeMode;
  synthetic: boolean;
  scene: SarScene;
  aoi: number[];
  acquisition_time: string;
  config: Record<string, unknown>;
  targets: VesselTarget[];
  ais_only: AisOnlyTarget[];
  counts: Record<string, number>;
  provenance: Provenance;
  processing_time_ms: number;
  created_at: string;
}

export interface StageEvent {
  stage: ScanStage;
  timestamp: string;
  detail: string;
}

export interface JobState {
  scan_id: string;
  stage: ScanStage;
  history: StageEvent[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
  runtime_mode: RuntimeMode;
  synthetic: boolean;
}

export interface ScanRequest {
  runtime_mode: RuntimeMode;
  bbox: BoundingBox;
  scene_id?: string;
  datetime_range?: string;
  provider?: string;
  product?: string;
  cfar_config?: Record<string, number | string>;
}

export interface TargetEvidence {
  target_id: string;
  classification: TargetClassification;
  observed: Record<string, unknown>;
  uncertainty: Record<string, unknown>;
  association: Record<string, unknown>;
  summary: string | null;
  tags: string[];
  sar_chip: Record<string, unknown> | null;
  provenance: Provenance;
}

export type DisplayMode = 'WORLD' | 'SAR' | 'SAR_CONTRAST' | 'CORRELATION' | 'ANALYSIS';

/**
 * Authoritative layer registry ids. Advanced layers (MULTIPASS_TRACKS,
 * WAKE_GEOMETRY, ML_OUTPUT, TEMPORAL_ANOMALIES) are declared here but carry
 * `capabilityState: NOT_AVAILABLE` until CP15 implements them, so the UI
 * hides/disables them instead of fabricating data (UI-029/030, correction #8).
 */
export type LayerId =
  | 'BASE_WORLD'
  | 'SAR_RASTER'
  | 'SAR_SCENE_FOOTPRINT'
  | 'LAND_MASK'
  | 'SAR_DETECTIONS'
  | 'AIS_CONTACTS'
  | 'AIS_TRAILS'
  | 'CORRELATION_LINKS'
  | 'UNCERTAINTY_RADII'
  | 'SELECTED_TARGET'
  | 'CFAR_DEBUG'
  | 'MULTIPASS_TRACKS'
  | 'WAKE_GEOMETRY'
  | 'ML_OUTPUT'
  | 'TEMPORAL_ANOMALIES';

export type CapabilityState = 'AVAILABLE' | 'NOT_AVAILABLE' | 'STUB';

export interface LayerConfig {
  id: LayerId;
  title: string;
  group: 'IMAGERY' | 'CONTACTS' | 'ANALYSIS' | 'REFERENCE' | 'INTELLIGENCE';
  visible: boolean;
  opacity: number;
  source: string;
  capabilityState: CapabilityState;
  supportsOpacity: boolean;
}

export type DebugLayerId =
  | 'raw'
  | 'normalized'
  | 'landmask'
  | 'filtered'
  | 'cfar_threshold'
  | 'detection_mask'
  | 'components'
  | 'centroids'
  | 'ais_observations'
  | 'ais_predicted'
  | 'match_radius'
  | 'correlation_lines'
  | 'score_decomposition';