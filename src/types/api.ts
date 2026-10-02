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
// ---------------------------------------------------------------------------
// WIRE CONTRACT - GENERATED, DO NOT HAND-EDIT
//
// Every shape below comes from src/api/contract.ts, which is generated from the
// FastAPI OpenAPI schema by `python -m tools.export_contract`. It used to be
// written out by hand here, and it drifted: the frontend declared
// `classification` while the backend emitted `cls`, so a detection's class was
// `undefined` in every live render path. Two hand-written mirrors of one shape
// will always drift eventually.
//
// Regenerate:  python -m tools.export_contract
// Prove current: python -m tools.export_contract --check
// ---------------------------------------------------------------------------
export { CLASSIFICATION_VALUES } from '../api/contract.ts';

export type {
  AisAssociation,
  AisOnlyTarget,
  DebugLayerResponse,
  EvidenceDocumentResponse,
  HealthResponse,
  LayerStats,
  ProviderHealthEntry,
  ScanAccepted,
  ScanStateResponse,
  ScanTargetsResponse,
  SceneListResponse,
  SceneSummary,
  ScoreDecomposition,
  StageEventOut,
  VesselTarget,
} from '../api/contract.ts';

import type {
  AisOnlyTarget,
  ProviderHealthEntry,
  ProviderStatus as ProviderState,
  ScanScene,
  TargetClassification,
  VesselTarget,
} from '../api/contract.ts';

// Re-export the two names this module's own consumers import from `types/api.ts`,
// so `types/api.ts` stays the single import site for the frontend.
export type { ProviderState, TargetClassification };



/**
 * Runtime mode as REPORTED BY THE BACKEND.
 *
 * The synthetic ("DEMO") runtime was removed from the product: there is no
 * synthetic mode to select, `POST /api/scans` rejects `runtime_mode` as an
 * unknown field, and every scan is a real query against a live provider. This
 * union therefore has a single member.
 *
 * It is kept rather than deleted because the backend still reports the field on
 * scan, job and persisted-record payloads as provenance. Only the REQUEST side
 * of `runtime_mode` is gone — see {@link ScanRequest}.
 */
export type RuntimeMode = 'REAL';

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
// The provider status set is GENERATED (see src/api/contract.ts), not restated
// here. The previous hand-written union carried a seventh value,
// 'NO_COVERAGE', that the backend can never emit -- so the UI could display a
// status no real probe produces. Absence of coverage is reported by the backend
// as NOT_CONFIGURED or UNAVAILABLE with an explanatory `detail`.
export type BoundingBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

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
  /**
   * The scene the scan read. Typed as the GENERATED `ScanScene`, not `SarScene`.
   *
   * `SarScene` describes a row from `/api/scenes` (a discovery result). This is the
   * scene a specific scan actually opened, declared by the backend as `ScanScene`.
   * They are different payloads; conflating them is how the timeline ended up
   * reading `scene.item_id` off a type that did not guarantee the field.
   */
  scene: ScanScene | Record<string, never>;
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

/**
 * Scan creation request.
 *
 * `runtime_mode` is deliberately ABSENT: the backend rejects it with 422
 * `extra_forbidden`, because there is no synthetic mode to ask for. The client
 * must never send it — a scan is always a real provider query.
 */
export interface ScanRequest {
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
 * WAKE_GEOMETRY, ML_OUTPUT, TEMPORAL_ANOMALIES) are DECLARED HERE BUT HAVE NO
 * DATA SOURCE — the backend does not serve any of them, so the registry marks
 * them `capabilityState: NOT_AVAILABLE` and the UI shows them disabled with a
 * reason instead of fabricating data (UI-029/030, correction #8). The gate is
 * the missing source, not a pending milestone: nothing in the frontend can
 * enable them.
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