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

export interface ProbeResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly pixel: ProbePixel;
  readonly source: ProbeSource;
  readonly wgs84_lat: number;
  readonly wgs84_lon: number;
  readonly georeferencing: ProbeGeoreferencing;
  readonly provenance: ProbeProvenance;
}

export interface RevisitPlanOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly acquisition_count?: number;
  readonly acquisitions?: AcquisitionOut[];
  readonly gaps?: RevisitGapOut[];
  readonly statistics: RevisitStatisticsOut;
  readonly window?: Record<string, string | null>;
  readonly next_after?: AcquisitionOut | null;
  readonly limitations?: string[];
  readonly provider: string;
  readonly collection: string;
  readonly requested_bbox?: number[];
}

export interface TracksOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scans_considered?: number;
  readonly observations_considered?: number;
  readonly track_count?: number;
  readonly tracks?: TrackHypothesisOut[];
  readonly note?: string;
}

export interface PatternsOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scans_considered?: number;
  readonly observations_considered?: number;
  readonly pattern_count?: number;
  readonly patterns?: PatternOut[];
  readonly note?: string;
}

export interface DetectorsOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly default: string;
  readonly detectors?: DetectorCardOut[];
  readonly note?: string;
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
  /** AIS candidates evaluated for this detection, accepted or not. */
  readonly candidatesConsidered?: number;
  /** Composite score a candidate needed to be accepted. */
  readonly acceptanceThreshold?: number;
  /** Best candidate that was NOT accepted. Null means the search found nothing at all, which is a different finding from a near miss. */
  readonly closestRejected?: RejectedCandidate | null;
  readonly scoreDecomposition?: ScoreDecomposition | null;
}

export interface VesselTarget {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly classification: "SAR_MATCHED_AIS" | "SAR_UNMATCHED" | "AIS_ONLY" | "STATIONARY_OR_INFRASTRUCTURE" | "SEA_CLUTTER" | "LOW_CONFIDENCE" | "UNRESOLVED";
  readonly lat: number;
  readonly lon: number;
  /** Sub-pixel [col, row] centroid in the window raster; null when unmeasured. */
  readonly geoPixelCentroid?: number[] | null;
  /** Pixel-centre offset applied by the geolocation authority. */
  readonly geoCentreOffset?: number | null;
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
  /** Total rows in the layer. */
  readonly rows?: number | null;
  /** Rows returned in `data`. */
  readonly row_limit?: number | null;
  readonly truncated?: boolean;
  /** Row objects keyed by `columns`. Null for an array layer, which returns `grid` instead. Never empty-and-null for a table with rows. */
  readonly data?: Record<string, unknown>[] | null;
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

export interface ProbeRequest {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  /** Row index in the window raster; 0 is the first row. */
  readonly row: number;
  /** Column index in the window raster; 0 is the first column. */
  readonly col: number;
}

export interface ScanCreateRequest {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  /** [min_lon, min_lat, max_lon, max_lat] in decimal degrees */
  readonly bbox: number[];
  /** STAC datetime interval, e.g. '2026-01-01T00:00:00Z/2026-01-31T00:00:00Z'. */
  readonly datetime_range?: string | null;
  /** Pin one catalogue acquisition by item id. The match is exact: an id that does not intersect this area fails the scan rather than silently processing whatever scene happened to come back. */
  readonly sceneId?: string | null;
  readonly provider?: string;
  readonly product?: "rtc" | "grd";
  /** Overrides for the CA-CFAR/speckle configuration; unset keys keep pipeline defaults. */
  readonly cfar_config?: CfarConfig | null;
}

export interface ProbeGeoreferencing {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly type: "AFFINE_GEOREFERENCED" | "GCP_GEOREFERENCED" | "UNREFERENCED";
  readonly raster_width: number;
  readonly raster_height: number;
  /** [col_min, row_min, col_max, row_max] read from the source raster. */
  readonly window_bounds?: number[];
  readonly transform?: number[];
  readonly resolution_m?: number | null;
  readonly always_xy?: boolean;
}

export interface ProbePixel {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly row: number;
  readonly col: number;
  readonly convention?: "PIXEL_CENTER";
  /** Sample-index to sample-centre offset that was applied. */
  readonly centre_offset?: number;
}

export interface ProbeProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly scene_id?: string | null;
  readonly provider?: string | null;
  readonly platform?: string | null;
  readonly acquisition_time?: string | null;
  readonly product?: string | null;
  readonly polarization?: string | null;
  readonly software_version?: string | null;
  readonly processing_version?: string | null;
  readonly requested_aoi?: number[];
}

export interface ProbeSource {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly crs: string;
  readonly x: number;
  readonly y: number;
}

export interface AcquisitionOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly item_id: string;
  readonly acquisition_time: string;
  readonly platform: string;
  readonly collection: string;
  readonly polarizations?: string[];
}

export interface RevisitGapOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly window_edge?: boolean;
  readonly exceeds_nominal?: boolean;
}

export interface RevisitStatisticsOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly platform_count?: number;
  readonly acquisitions_per_platform?: Record<string, number>;
  readonly interior_gap_count?: number;
  readonly median_revisit_days?: number | null;
  readonly min_revisit_days?: number | null;
  readonly max_revisit_days?: number | null;
  readonly flagged_gap_count?: number;
  readonly nominal_repeat_days: number;
}

export interface TrackHypothesisOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly track_id: string;
  readonly points?: TrackPointOut[];
  readonly gaps?: TrackGapOut[];
  readonly supporting_evidence?: string[];
  readonly contradicting_evidence?: string[];
  readonly identity_strength?: number;
  readonly confidence_statement?: string;
}

export interface PatternOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly pattern_id: string;
  readonly kind: string;
  readonly observed: string;
  readonly hypothesis: string;
  readonly confidence?: number;
  readonly unknowns?: string[];
  readonly evidence?: string[];
}

export interface DetectorCardOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly name: string;
  readonly kind: string;
  readonly training_domain?: string;
  readonly input_product?: string;
  readonly validation_data?: string;
  readonly limitations?: string;
  /** Digest of learned weights; None for deterministic detectors. */
  readonly weights_digest?: string | null;
}

export interface RejectedCandidate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly mmsi: string;
  readonly vesselName?: string | null;
  readonly score: number;
  readonly distanceMeters: number;
  readonly timeDeltaSeconds: number;
  /** How far below the acceptance threshold this candidate scored. */
  readonly shortfall: number;
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

export interface CfarConfig {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  /** N_train: reference ring width in cells. */
  readonly trainingCells?: number | null;
  /** N_guard: inner guard ring width in cells. */
  readonly guardCells?: number | null;
  /** Multiplier on the background estimate (P_fa control). */
  readonly thresholdFactor?: number | null;
  /** Smallest connected component kept as a candidate target, in pixels. */
  readonly minPixels?: number | null;
  /** Largest component kept; anything larger is treated as a structure. */
  readonly maxPixels?: number | null;
  /** Pre-detection speckle filter. */
  readonly speckleFilter?: "none" | "median" | "lee" | null;
  /** Speckle kernel side. */
  readonly kernelSize?: number | null;
  /** Coastline exclusion distance in metres. */
  readonly coastlineBufferMeters?: number | null;
}

export interface TrackGapOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly seconds: number;
  readonly implied_speed_knots?: number | null;
  readonly plausible?: boolean;
  readonly note?: string;
}

export interface TrackPointOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly item_id: string;
  readonly acquisition_time: string;
  readonly lat: number;
  readonly lon: number;
  readonly sar_conf: number;
  readonly classification: string;
  readonly apparent_length_m: number;
  readonly length_unc_m: number;
}

/**
 * Schemas reachable as a request body. Discovered from the OpenAPI paths,
 * not maintained by hand, so a new route's body is emitted automatically.
 */
export type ContractRequestSchemaName =
  | 'ProbeRequest'
  | 'ScanCreateRequest'
;

/** Schemas emitted into this file. */
export type ContractSchemaName =
  | 'ScoreDecomposition'
  | 'ProbeResponse'
  | 'RevisitPlanOut'
  | 'TracksOut'
  | 'PatternsOut'
  | 'DetectorsOut'
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
  | 'ProbeRequest'
  | 'ScanCreateRequest'
  | 'ProbeGeoreferencing'
  | 'ProbePixel'
  | 'ProbeProvenance'
  | 'ProbeSource'
  | 'AcquisitionOut'
  | 'RevisitGapOut'
  | 'RevisitStatisticsOut'
  | 'TrackHypothesisOut'
  | 'PatternOut'
  | 'DetectorCardOut'
  | 'RejectedCandidate'
  | 'ScanScene'
  | 'ProviderStatus'
  | 'ScanStage'
  | 'AisCoverageState'
  | 'CfarConfig'
  | 'TrackGapOut'
  | 'TrackPointOut'
;

/**
 * Property names of {@link ScoreDecomposition} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCOREDECOMPOSITION_FIELDS = [
  'spatialScore',
  'temporalScore',
  'headingScore',
  'sizeScore',
  'compositeScore',
  'matchRadiusMeters',
  'distanceOffsetMeters',
  'timeDeltaSeconds',
] as const;

/**
 * Property names of {@link ProbeResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROBERESPONSE_FIELDS = [
  'scan_id',
  'pixel',
  'source',
  'wgs84_lat',
  'wgs84_lon',
  'georeferencing',
  'provenance',
] as const;

/**
 * Property names of {@link RevisitPlanOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const REVISITPLANOUT_FIELDS = [
  'acquisition_count',
  'acquisitions',
  'gaps',
  'statistics',
  'window',
  'next_after',
  'limitations',
  'provider',
  'collection',
  'requested_bbox',
] as const;

/**
 * Property names of {@link TracksOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TRACKSOUT_FIELDS = [
  'scans_considered',
  'observations_considered',
  'track_count',
  'tracks',
  'note',
] as const;

/**
 * Property names of {@link PatternsOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PATTERNSOUT_FIELDS = [
  'scans_considered',
  'observations_considered',
  'pattern_count',
  'patterns',
  'note',
] as const;

/**
 * Property names of {@link DetectorsOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DETECTORSOUT_FIELDS = [
  'default',
  'detectors',
  'note',
] as const;

/**
 * Property names of {@link AisAssociation} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const AISASSOCIATION_FIELDS = [
  'matched',
  'mmsi',
  'vesselName',
  'distanceOffsetMeters',
  'timeDeltaSeconds',
  'predictedLat',
  'predictedLon',
  'aisAssociationConfidence',
  'candidatesConsidered',
  'acceptanceThreshold',
  'closestRejected',
  'scoreDecomposition',
] as const;

/**
 * Property names of {@link VesselTarget} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const VESSELTARGET_FIELDS = [
  'id',
  'classification',
  'lat',
  'lon',
  'geoPixelCentroid',
  'geoCentreOffset',
  'sarConf',
  'aisConf',
  'lenM',
  'widM',
  'lenUncM',
  'hdg',
  'wake',
  'meanDb',
  'maxDb',
  'area',
  'corr',
  'assessment',
  'tags',
] as const;

/**
 * Property names of {@link AisOnlyTarget} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const AISONLYTARGET_FIELDS = [
  'cls',
  'mmsi',
  'vesselName',
  'lat',
  'lon',
  'timestamp',
] as const;

/**
 * Property names of {@link ScanTargetsResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANTARGETSRESPONSE_FIELDS = [
  'scan_id',
  'stage',
  'runtime_mode',
  'synthetic',
  'aoi',
  'count',
  'ais_only_count',
  'counts',
  'targets',
  'ais_only',
  'provenance',
  'scene',
  'acquisition_time',
] as const;

/**
 * Property names of {@link SceneSummary} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENESUMMARY_FIELDS = [
  'id',
  'provider',
  'platform',
  'product',
  'polarization',
  'acquisition_time',
  'bbox',
  'resolution_meters',
  'georeferencing',
  'sea_clutter_level',
  'runtime_mode',
  'synthetic',
] as const;

/**
 * Property names of {@link SceneListResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENELISTRESPONSE_FIELDS = [
  'runtime_mode',
  'synthetic',
  'provider',
  'status',
  'note',
  'count',
  'scenes',
] as const;

/**
 * Property names of {@link ScanAccepted} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANACCEPTED_FIELDS = [
  'scan_id',
  'status',
  'runtime_mode',
  'synthetic',
] as const;

/**
 * Property names of {@link StageEventOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const STAGEEVENTOUT_FIELDS = [
  'stage',
  'timestamp',
  'detail',
  'terminal',
] as const;

/**
 * Property names of {@link ScanStateResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANSTATERESPONSE_FIELDS = [
  'scan_id',
  'stage',
  'terminal',
  'runtime_mode',
  'synthetic',
  'known',
  'source',
  'started_at',
  'finished_at',
  'failed_at',
  'error',
  'history',
  'record_persisted',
] as const;

/**
 * Property names of {@link ProviderHealthEntry} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROVIDERHEALTHENTRY_FIELDS = [
  'provider',
  'status',
  'detail',
  'last_check',
  'latency_ms',
  'error',
  'capabilities',
] as const;

/**
 * Property names of {@link HealthResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const HEALTHRESPONSE_FIELDS = [
  'checked_at',
  'runtime_mode',
  'probe',
  'providers',
] as const;

/**
 * Property names of {@link TargetEvidenceResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TARGETEVIDENCERESPONSE_FIELDS = [
  'scan_id',
  'runtime_mode',
  'synthetic',
  'ambiguous',
  'candidate_scan_ids',
  'evidence',
] as const;

/**
 * Property names of {@link EvidenceDocumentResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const EVIDENCEDOCUMENTRESPONSE_FIELDS = [
  'scan_id',
  'runtime_mode',
  'synthetic',
  'ambiguous',
  'candidate_scan_ids',
  'evidence',
] as const;

/**
 * Property names of {@link DebugLayerResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DEBUGLAYERRESPONSE_FIELDS = [
  'scan_id',
  'layer',
  'kind',
  'source',
  'shape',
  'dtype',
  'stats',
  'columns',
  'rows',
  'row_limit',
  'truncated',
  'data',
  'grid_size',
  'grid',
  'notes',
] as const;

/**
 * Property names of {@link LayerStats} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const LAYERSTATS_FIELDS = [
  'size',
  'min',
  'max',
  'mean',
  'std',
  'p01',
  'p50',
  'p99',
  'nan_count',
  'finite_fraction',
  'true_count',
] as const;

/**
 * Property names of {@link AisObservationOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const AISOBSERVATIONOUT_FIELDS = [
  'timestamp',
  'mmsi',
  'lat',
  'lon',
  'sog',
  'cog',
  'heading',
  'nav_status',
  'ship_name',
  'callsign',
  'imo',
  'ship_type',
  'length_m',
  'width_m',
  'source',
] as const;

/**
 * Property names of {@link AisCoverageOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const AISCOVERAGEOUT_FIELDS = [
  'state',
  'detail',
  'observation_count',
  'window_start',
  'window_end',
  'archive_oldest',
  'archive_newest',
  'sources',
] as const;

/**
 * Property names of {@link ScanAisWindow} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANAISWINDOW_FIELDS = [
  'start',
  'end',
] as const;

/**
 * Property names of {@link ScanAisResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANAISRESPONSE_FIELDS = [
  'scan_id',
  'coverage',
  'window',
  'bbox',
  'observations',
  'note',
] as const;

/**
 * Property names of {@link TargetAisResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TARGETAISRESPONSE_FIELDS = [
  'target_id',
  'mmsi',
  'associated',
  'coverage',
  'window',
  'observations',
  'note',
] as const;

/**
 * Property names of {@link VesselTrackResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const VESSELTRACKRESPONSE_FIELDS = [
  'mmsi',
  'coverage',
  'ship_name',
  'callsign',
  'imo',
  'ship_type',
  'length_m',
  'width_m',
  'observations',
  'note',
] as const;

/**
 * Property names of {@link ProbeRequest} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROBEREQUEST_FIELDS = [
  'row',
  'col',
] as const;

/**
 * Property names of {@link ScanCreateRequest} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANCREATEREQUEST_FIELDS = [
  'bbox',
  'datetime_range',
  'sceneId',
  'provider',
  'product',
  'cfar_config',
] as const;

/**
 * Property names of {@link ProbeGeoreferencing} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROBEGEOREFERENCING_FIELDS = [
  'type',
  'raster_width',
  'raster_height',
  'window_bounds',
  'transform',
  'resolution_m',
  'always_xy',
] as const;

/**
 * Property names of {@link ProbePixel} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROBEPIXEL_FIELDS = [
  'row',
  'col',
  'convention',
  'centre_offset',
] as const;

/**
 * Property names of {@link ProbeProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROBEPROVENANCE_FIELDS = [
  'scan_id',
  'scene_id',
  'provider',
  'platform',
  'acquisition_time',
  'product',
  'polarization',
  'software_version',
  'processing_version',
  'requested_aoi',
] as const;

/**
 * Property names of {@link ProbeSource} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROBESOURCE_FIELDS = [
  'crs',
  'x',
  'y',
] as const;

/**
 * Property names of {@link AcquisitionOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ACQUISITIONOUT_FIELDS = [
  'item_id',
  'acquisition_time',
  'platform',
  'collection',
  'polarizations',
] as const;

/**
 * Property names of {@link RevisitGapOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const REVISITGAPOUT_FIELDS = [
  'start',
  'end',
  'days',
  'window_edge',
  'exceeds_nominal',
] as const;

/**
 * Property names of {@link RevisitStatisticsOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const REVISITSTATISTICSOUT_FIELDS = [
  'platform_count',
  'acquisitions_per_platform',
  'interior_gap_count',
  'median_revisit_days',
  'min_revisit_days',
  'max_revisit_days',
  'flagged_gap_count',
  'nominal_repeat_days',
] as const;

/**
 * Property names of {@link TrackHypothesisOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TRACKHYPOTHESISOUT_FIELDS = [
  'track_id',
  'points',
  'gaps',
  'supporting_evidence',
  'contradicting_evidence',
  'identity_strength',
  'confidence_statement',
] as const;

/**
 * Property names of {@link PatternOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PATTERNOUT_FIELDS = [
  'pattern_id',
  'kind',
  'observed',
  'hypothesis',
  'confidence',
  'unknowns',
  'evidence',
] as const;

/**
 * Property names of {@link DetectorCardOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DETECTORCARDOUT_FIELDS = [
  'name',
  'kind',
  'training_domain',
  'input_product',
  'validation_data',
  'limitations',
  'weights_digest',
] as const;

/**
 * Property names of {@link RejectedCandidate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const REJECTEDCANDIDATE_FIELDS = [
  'mmsi',
  'vesselName',
  'score',
  'distanceMeters',
  'timeDeltaSeconds',
  'shortfall',
] as const;

/**
 * Property names of {@link ScanScene} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANSCENE_FIELDS = [
  'provider',
  'collection',
  'item_id',
  'platform',
  'acquisition_time',
  'product',
  'polarization',
  'asset_href',
  'crs',
  'resolution_m',
] as const;

/**
 * Property names of {@link CfarConfig} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const CFARCONFIG_FIELDS = [
  'trainingCells',
  'guardCells',
  'thresholdFactor',
  'minPixels',
  'maxPixels',
  'speckleFilter',
  'kernelSize',
  'coastlineBufferMeters',
] as const;

/**
 * Property names of {@link TrackGapOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TRACKGAPOUT_FIELDS = [
  'seconds',
  'implied_speed_knots',
  'plausible',
  'note',
] as const;

/**
 * Property names of {@link TrackPointOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TRACKPOINTOUT_FIELDS = [
  'scan_id',
  'item_id',
  'acquisition_time',
  'lat',
  'lon',
  'sar_conf',
  'classification',
  'apparent_length_m',
  'length_unc_m',
] as const;

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
