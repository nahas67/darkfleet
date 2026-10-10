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
  readonly sizeScore?: number | null;
  readonly compositeScore: number;
  readonly matchRadiusMeters: number;
  readonly distanceOffsetMeters: number;
  readonly timeDeltaSeconds: number;
}

export interface TargetSummaryResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly target_id: string;
  readonly classification?: string | null;
  /** True when this target id exists in more than one stored scan. */
  readonly ambiguous: boolean;
  readonly evidence: EvidenceDocument;
  readonly narrative: NarrativeEnvelope;
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

export interface InvestigationOut {
  readonly id: string;
  readonly title: string;
  readonly scan_id: string | null;
  readonly aoi: number[] | null;
  readonly created_at: string;
  readonly annotations: AnnotationOut[];
  readonly watchlist: WatchEntryOut[];
}

export interface InvestigationListOut {
  readonly investigations: InvestigationOut[];
}

export interface AnnotationOut {
  readonly id: string;
  readonly investigation_id: string;
  readonly content: string;
  readonly target_id: string | null;
  readonly created_at: string;
}

export interface WatchEntryOut {
  readonly id: string;
  readonly investigation_id: string;
  readonly target_id: string;
  readonly created_at: string;
}

export interface ScanCatalogueResponse {
  readonly scans: ScanCatalogueEntry[];
  readonly count: number;
}

export interface ViewCreate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly title: string;
  readonly snapshot: Snapshot;
}

export interface ViewReplace {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly title: string;
  readonly snapshot: Snapshot;
  readonly expected_revision: number;
}

export interface SavedViewOut {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly snapshot: Snapshot | null;
  readonly status: "OK" | "CORRUPT";
  readonly missing_resources: string[];
}

export interface SavedViewsOut {
  readonly views: SavedViewOut[];
  readonly count: number;
}

export interface GeometryCreate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly label: string;
  readonly notes?: string;
  readonly geometry: GeometryInput;
}

export interface GeometryOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly investigation_id: string;
  readonly scan_id: string | null;
  readonly provenance?: string;
  readonly label: string;
  readonly notes: string;
  readonly geometry: GeometryInput;
  readonly measurements: Measurements;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GeometryListOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly geometries: GeometryOut[];
}

export interface GeometryInput {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly kind: "point" | "polyline" | "polygon" | "range_ring";
  readonly coordinates: readonly [number, number][];
  readonly radius_m?: number | null;
}

export interface Measurements {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly ellipsoid?: "WGS84";
  readonly method: string;
  readonly length_m?: number | null;
  readonly length_km?: number | null;
  readonly length_nm?: number | null;
  readonly initial_bearing_deg?: number | null;
  readonly perimeter_m?: number | null;
  readonly perimeter_km?: number | null;
  readonly perimeter_nm?: number | null;
  readonly area_m2?: number | null;
  readonly area_km2?: number | null;
  readonly radius_m?: number | null;
  readonly radius_km?: number | null;
  readonly radius_nm?: number | null;
}

export interface MissionOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly title: string;
  readonly aoi: readonly [number, number, number, number];
  readonly status: "PLANNED" | "ACTIVE" | "PAUSED" | "CLOSED";
  readonly created_at: string;
  readonly updated_at: string;
  readonly scan_ids: string[];
  readonly rules: MissionRuleOut[];
  readonly alerts: MissionAlertOut[];
  readonly evaluations: MissionEvaluationOut[];
}

export interface InvestigationReportOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly schema_version: 1;
  readonly kind: "DARKFLEET_INVESTIGATION_EVIDENCE";
  readonly investigation: Record<string, string | null>;
  readonly source_status: "PERSISTED_REAL" | "NO_SCAN_LINKED" | "SOURCE_MISSING" | "SOURCE_UNVERIFIED";
  readonly sensor_evidence: Record<string, unknown>;
  readonly operator_material: Record<string, unknown>;
  readonly scientific_limits: string[];
  readonly warnings: string[];
  readonly content_sha256: string;
  readonly hash_algorithm: string;
}

export interface SceneCandidatesOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scenes: SceneCandidateOut[];
  readonly total_real_scans: number;
  readonly note?: string;
}

export interface SceneComparisonOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: "MEASURED" | "NOT_COMPARABLE";
  readonly reason: string;
  readonly first: SceneIdentity;
  readonly second: SceneIdentity;
  readonly metrics: ComparisonMetrics | null;
  readonly acquisition_interval_hours: number | null;
  readonly caveat?: string;
}

export interface SceneCompareRequest {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly first_scan_id: string;
  readonly second_scan_id: string;
}

export interface ImageryPairRequest {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly first_scan_id: string;
  readonly second_scan_id: string;
}

export interface ImageryPair {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly first: ImageryScene;
  readonly second: ImageryScene;
  readonly status: "READY" | "PARTIAL" | "UNAVAILABLE";
  readonly interpretation?: string;
}

export interface AnalystCaseListOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly cases: AnalystCaseBrief[];
  readonly total: number;
  readonly note?: string;
}

export interface GroundedAnalystOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly kind?: "DARKFLEET_GROUNDED_ANALYST";
  readonly case_id: string;
  readonly case_title: string;
  readonly linked_scan_id: string | null;
  readonly source_status: "PERSISTED_REAL" | "NO_SCAN_LINKED" | "SOURCE_MISSING" | "SOURCE_UNVERIFIED";
  readonly intent: "SUMMARY" | "WATCHLIST" | "SAR_AIS" | "GAPS";
  readonly focused_target_id: string | null;
  readonly model_status?: "NO_MODEL_DETERMINISTIC_OFFLINE";
  readonly claims: AnalystClaim[];
  readonly unknowns: AnalystUnknown[];
  readonly operator_note_count: number;
  readonly operator_watch_count: number;
  readonly source_canonical_sha256: string | null;
  readonly disclaimer?: string;
}

export interface MissionListOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly missions: MissionOut[];
}

export interface MissionBody {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly title: string;
  readonly aoi: readonly [number, number, number, number];
  readonly status?: "PLANNED" | "ACTIVE" | "PAUSED" | "CLOSED";
}

export interface MissionReplace {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly title: string;
  readonly aoi: readonly [number, number, number, number];
  readonly status?: "PLANNED" | "ACTIVE" | "PAUSED" | "CLOSED";
}

export interface MissionScanLink {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
}

export interface WatchRuleCreate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly investigation_id: string;
  readonly target_id: string;
  readonly minimum_sar_confidence: number;
}

export interface MissionRuleOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly mission_id: string;
  readonly investigation_id: string;
  readonly scan_id: string;
  readonly target_id: string;
  readonly kind?: "WATCHED_TARGET_SAR_CONFIDENCE";
  readonly minimum_sar_confidence: number;
  readonly created_at: string;
}

export interface MissionAlertOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly mission_id: string;
  readonly rule_id: string;
  readonly scan_id: string;
  readonly target_id: string;
  readonly minimum_sar_confidence: number;
  readonly sar_confidence: number;
  readonly classification: string | null;
  readonly rationale: string;
  readonly evidence: Record<string, unknown>;
  readonly evidence_fingerprint: string;
  readonly status: "OPEN" | "ACKNOWLEDGED";
  readonly created_at: string;
  readonly acknowledged_at: string | null;
  readonly provenance?: "PERSISTED_REAL_SAR_OPERATOR_THRESHOLD";
}

export interface MissionEvaluationOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly mission_id: string;
  readonly rule_id: string;
  readonly scan_id: string;
  readonly target_id: string;
  readonly status: "TRIGGERED" | "BELOW_THRESHOLD" | "NOT_EVALUATED";
  readonly reason: string;
  readonly evaluated_at: string;
  readonly evidence_fingerprint: string | null;
}

export interface EvaluationRunOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly mission_id: string;
  readonly evaluations: MissionEvaluationOut[];
  readonly alerts_created: number;
  readonly existing_alerts: number;
  readonly not_evaluated: number;
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
  /** Measured wake evidence; null when the detector never ran for this target. */
  readonly wakeAnalysis?: WakeEvidence | null;
  /** Polarization channel output; null when the channel never ran. Evidence only: it does not modify sar_conf, AIS association or classification. */
  readonly polarizationEvidence?: PolarizationEvidence | null;
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
  readonly evidence: EvidenceDocument;
}

export interface EvidenceDocumentResponse {
  readonly scan_id: string;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  readonly ambiguous: boolean;
  readonly candidate_scan_ids?: string[];
  readonly evidence: ScanRecordDocument;
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
  /** degrees north; null when unavailable */
  readonly lat?: number | null;
  /** degrees east; null when unavailable */
  readonly lon?: number | null;
  /** Explicit position validity: POSITION_AVAILABLE, POSITION_UNAVAILABLE, or INVALID_COORDINATE */
  readonly position_status?: PositionStatus;
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
  readonly bbox?: readonly [number, number, number, number] | null;
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

export interface SourceRef {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly provider: string;
  readonly dataset: string;
  readonly version: string;
  readonly license: LicenseKind;
  readonly attribution: string;
  readonly identifier?: string;
  readonly release_date?: string | null;
  readonly retrieved_at?: string | null;
  readonly terms_notes?: string;
  readonly limitations?: string[];
  readonly coverage_note?: string;
  readonly install_status: string;
}

export interface TargetPosition {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly latitude: number;
  readonly longitude: number;
}

export interface ZoneContext {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: ContextStatus;
  readonly zone?: MaritimeZone | null;
  readonly feature_id?: string | null;
  readonly sovereign_names?: string[];
  readonly dispute_note?: string | null;
  readonly reason?: string | null;
  readonly established?: boolean;
  readonly disputed?: boolean;
  readonly provenance?: SourceRef | null;
  readonly detail?: string;
}

export interface CoastContext {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: ContextStatus;
  readonly meters?: number | null;
  readonly method?: DistanceMethod;
  readonly sample_spacing_m?: number | null;
  readonly searched_radius_m?: number | null;
  readonly provenance?: SourceRef | null;
  readonly detail?: string;
}

export interface PortContext {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: ContextStatus;
  readonly port_id?: string | null;
  readonly name?: string | null;
  readonly country?: string | null;
  readonly harbor_type?: string | null;
  readonly harbor_size?: string | null;
  readonly longitude?: number | null;
  readonly latitude?: number | null;
  readonly meters?: number | null;
  readonly method?: DistanceMethod;
  readonly searched_radius_m?: number | null;
  readonly provenance?: SourceRef | null;
  readonly interpretation?: string;
  readonly detail?: string;
}

export interface BathymetryContext {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: ContextStatus;
  readonly meters?: number | null;
  readonly resolution_deg?: number | null;
  readonly source_type?: string | null;
  readonly provenance?: SourceRef | null;
  readonly detail?: string;
}

export interface TargetMaritimeContextResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly target_id: string;
  readonly position: TargetPosition;
  readonly maritime_zone: ZoneContext;
  readonly nearest_coast: CoastContext;
  readonly nearest_port: PortContext;
  readonly bathymetry: BathymetryContext;
  readonly generated_at: string;
  readonly context_version?: number;
}

export interface DisplayGeometryMeta {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly tolerance_deg: number;
  readonly source_vertex_count: number;
  readonly vertex_count: number;
  readonly part_count: number;
  readonly hole_count: number;
  readonly viewport_filtered?: boolean;
  readonly notice?: string;
}

export interface DisplayLine {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly coordinates: readonly [number, number][];
}

export interface DisplayPolygon {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly zone?: MaritimeZone | null;
  readonly pol_type?: string | null;
  readonly geoname?: string | null;
  readonly sovereign_names?: string[];
  readonly territory_names?: string[];
  readonly dispute_note?: string | null;
  readonly disputed?: boolean;
  readonly parts: DisplayLine[];
  readonly holes?: DisplayLine[];
}

export interface CoastlineGeometryResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly layer: string;
  readonly status: string;
  readonly detail?: string;
  readonly evidentiary?: string;
  readonly provenance?: SourceRef | null;
  readonly lines?: DisplayLine[];
  readonly meta: DisplayGeometryMeta;
  readonly bbox?: readonly [number, number, number, number];
}

export interface ZoneGeometryResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly layer: string;
  readonly status: string;
  readonly detail?: string;
  readonly evidentiary?: string;
  readonly provenance?: SourceRef | null;
  readonly polygons?: DisplayPolygon[];
  readonly meta: DisplayGeometryMeta;
  readonly bbox?: readonly [number, number, number, number];
  readonly total_feature_count?: number;
  readonly filtered_feature_count?: number;
}

export interface DatasetHealthEntry {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly label: string;
  readonly install_status: string;
  readonly usable: boolean;
  readonly blocker_reason?: string | null;
  readonly optional?: boolean;
  readonly provider: string;
  readonly dataset: string;
  readonly version: string;
  readonly version_established?: boolean;
  readonly release_date?: string | null;
  readonly retrieved_at?: string | null;
  readonly license: string;
  readonly attribution: string;
  readonly identifier?: string | null;
  readonly source_mechanism?: string;
  readonly source_service?: string | null;
  readonly source_layer?: string | null;
  readonly source_feature_count?: number | null;
  readonly installed_at?: string | null;
  readonly computed_sha256?: string | null;
  readonly expected_sha256?: string | null;
  readonly coverage_note?: string;
  readonly terms_notes?: string;
  readonly limitations?: string[];
  readonly detail?: string;
}

export interface DatasetHealthResponse {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly datasets: DatasetHealthEntry[];
  readonly generated_at: string;
  readonly usable_count: number;
  readonly verified_count: number;
}

export interface AnalystRequest {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly intent?: "SUMMARY" | "WATCHLIST" | "SAR_AIS" | "GAPS";
  readonly target_id?: string | null;
}

export interface AnnotationCreate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly content: string;
  readonly target_id?: string | null;
}

export interface InvestigationCreate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly title: string;
  readonly scan_id?: string | null;
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

export interface WatchEntryCreate {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly target_id: string;
}

export interface EvidenceDocument {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly target_id: string;
  readonly classification: "SAR_MATCHED_AIS" | "SAR_UNMATCHED" | "AIS_ONLY" | "STATIONARY_OR_INFRASTRUCTURE" | "SEA_CLUTTER" | "LOW_CONFIDENCE" | "UNRESOLVED";
  readonly designation: string | null;
  readonly ghost_vessel: GhostVesselDossier | GhostVesselNotApplicable;
  readonly observed: ObservedEvidence;
  readonly uncertainty: UncertaintyEvidence;
  readonly association: AssociationEvidence;
  readonly summary: string | null;
  readonly tags: string[];
  readonly hypotheses: EvidenceBullet[];
  readonly unknowns: EvidenceBullet[];
  readonly sar_chip: Record<string, unknown> | null;
  readonly provenance: EvidenceProvenance | null;
}

export interface NarrativeEnvelope {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: "OK" | "AI_UNAVAILABLE";
  readonly document?: NarrativeDocument | null;
  readonly reason?: string | null;
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

export interface ScanCatalogueEntry {
  readonly scan_id: string;
  readonly created_at?: string | null;
  readonly scene_id?: string | null;
  readonly acquisition_time?: string | null;
  readonly provider?: string | null;
  readonly product?: string | null;
  readonly polarization?: string | null;
  readonly runtime_mode?: "REAL";
  readonly synthetic?: false;
}

export interface Snapshot {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly schema_version?: 1;
  readonly camera?: CameraSnapshot | null;
  readonly map_source_id?: string | null;
  readonly layers?: Record<string, LayerChoice>;
  readonly scan_id?: string | null;
  readonly target?: TargetChoice | null;
  readonly contact?: ContactChoice | null;
  readonly playback_at?: string | null;
  readonly playback_speed?: number;
  readonly workspace?: "TACTICAL" | "SEARCH" | "INTELLIGENCE" | "TASKING" | "LAYERS" | "ANALYTICS" | "ADVANCED" | "REPORTS" | "SYSTEM" | "VIEWS";
  readonly aoi?: readonly [number, number, number, number] | null;
  readonly investigation_id?: string | null;
}

export interface SceneCandidateOut {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly item_id: string | null;
  readonly acquisition_time: string | null;
  readonly product: string | null;
  readonly polarization: string | null;
  readonly available_normalized_raster: boolean;
  readonly georeference_present: boolean;
}

export interface ComparisonMetrics {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly overlap_shape: number[];
  readonly offset_b_in_a_pixels: number[];
  readonly overlap_pixels: number;
  readonly valid_pair_pixels: number;
  readonly valid_pair_fraction: number;
  readonly mean_b_minus_a_db: number;
  readonly mean_absolute_difference_db: number;
  readonly root_mean_square_difference_db: number;
  readonly median_b_minus_a_db: number;
  readonly p05_b_minus_a_db: number;
  readonly p95_b_minus_a_db: number;
  readonly brighter_b_pixels: number;
  readonly darker_b_pixels: number;
  readonly equal_pixels: number;
  readonly metric?: "SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE";
}

export interface SceneIdentity {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly item_id: string | null;
  readonly acquisition_time: string | null;
  readonly product: string | null;
  readonly polarization: string | null;
  readonly crs: string | null;
  readonly window_transform: number[] | null;
  readonly raster_shape: number[] | null;
  readonly processing_version: string | null;
  readonly source?: "PERSISTED_REAL_SCAN_CALIBRATED_CACHE";
}

export interface ImageryScene {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly status: "READY" | "UNAVAILABLE";
  readonly reason: string;
  readonly item_id?: string | null;
  readonly acquisition_time?: string | null;
  readonly product?: string | null;
  readonly polarization?: string | null;
  readonly platform?: string | null;
  readonly provider?: string | null;
  readonly crs?: string | null;
  readonly transform?: number[] | null;
  readonly wgs84_corners_lon_lat?: number[][] | null;
  readonly raster_window?: number[] | null;
  readonly source_shape?: number[] | null;
  readonly preview_shape?: number[] | null;
  readonly sample_stride?: number | null;
  readonly valid_source_pixels?: number | null;
  readonly total_source_pixels?: number | null;
  readonly displayed_valid_pixels?: number | null;
  readonly image_url?: string | null;
  readonly display_window_db?: number[] | null;
  readonly source?: "PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC" | null;
}

export interface AnalystCaseBrief {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly case_id: string;
  readonly title: string;
  readonly linked_scan_id: string | null;
  readonly created_at: string;
}

export interface AnalystClaim {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly id: string;
  readonly statement: string;
  readonly value: string | number | boolean;
  readonly classification: "SENSOR_RECORD" | "OPERATOR_RECORD";
  readonly uncertainty: string;
  readonly sources: AnalystSource[];
}

export interface AnalystUnknown {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly code: string;
  readonly explanation: string;
  readonly source_id: string | null;
  readonly expected_field_path: string | null;
  readonly next_check: string;
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

export interface PolarizationEvidence {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly status: "FEATURES" | "NOT_AVAILABLE" | "FAILED";
  readonly available?: string[];
  readonly requested?: string[];
  readonly single_pol?: boolean;
  readonly per_pol?: Record<string, Record<string, number | string>>;
  readonly vh_over_vv_db?: number | null;
  readonly dual_pol_flags?: Record<string, unknown>;
  readonly calibration_domain?: string;
  readonly reason?: string | null;
  readonly notes?: string[];
}

export interface WakeEvidence {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly state?: "ANALYSED" | "NOT_ANALYSED" | "NOT_AVAILABLE" | "FAILED";
  readonly detected: boolean;
  readonly confidence: number;
  readonly error_type?: string | null;
  readonly error_message?: string | null;
  readonly heading_deg?: number | null;
  readonly wake_direction_deg?: number | null;
  readonly apparent_length_m?: number | null;
  readonly arm_angle_deg?: number | null;
  readonly arm_angle_line_deg?: number | null;
  readonly method: string;
  readonly notes: string;
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

export interface ScanRecordDocument {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly schema_version: number;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  readonly scene: ScanScene;
  readonly aoi: number[];
  readonly acquisition_time: string;
  readonly config: ScanConfigRecord;
  readonly targets: Record<string, unknown>[];
  readonly ais_only: AisOnlyTarget[];
  readonly counts: Record<string, number>;
  readonly provenance: EvidenceProvenance | null;
  readonly debug: ScanDebugBlock;
  readonly processing_time_ms: number;
  readonly created_at: string;
}

/** Explicit position validity diagnostic (DF-X9.8-H1). Distinguishes: - POSITION_AVAILABLE: a real measured latitude and longitude (including measured 0.0, 0.0) - POSITION_UNAVAILABLE: coordinates missing or null in source observation - INVALID_COORDINATE: coordinate present but non-finite or out of... */
export type PositionStatus = "POSITION_AVAILABLE" | "POSITION_UNAVAILABLE" | "INVALID_COORDINATE";

/** Whether the archive can answer a question, and how completely. */
export type AisCoverageState = "AVAILABLE" | "PARTIAL" | "NO_COVERAGE" | "NOT_CONFIGURED";

/** How a dataset may be used. Modelled rather than free-text because the distinction changes what DarkFleet is permitted to DO. "Downloadable" alone says nothing about redistribution, and reading "I could fetch it" as "I may ship it" is exactly the mistake DF-X8 §58 warns about. Marine Regions is th... */
export type LicenseKind = "PUBLIC_DOMAIN" | "CC_BY" | "CC_BY_SA" | "ODBL" | "DOWNLOAD_ONLY" | "AUTHENTICATED" | "COMMERCIAL" | "UNDETERMINED";

/** Per-channel state. Deliberately finer than InstallStatus. A channel can fail for a reason that has nothing to do with installation, and an operator needs to know which: a dataset that is installed but has no data for the Pacific is a different problem from one that was never downloaded (Â§46). */
export type ContextStatus = "AVAILABLE" | "NOT_INSTALLED" | "NO_COVERAGE" | "FAILED" | "NOT_ESTABLISHED";

/** Law of the Sea zones, as a DATASET represents them. Surfaced in the UI as a *dataset-represented* zone. DarkFleet reports a third party's representation; it does not determine sovereignty. ``DISPUTED`` and ``AMBIGUOUS`` are real answers, not failures, and neither may be collapsed into a confident... */
export type MaritimeZone = "TERRITORIAL_SEA" | "CONTIGUOUS_ZONE" | "EXCLUSIVE_ECONOMIC_ZONE" | "INTERNAL_WATERS" | "ARCHIPELAGIC_WATERS" | "HIGH_SEAS" | "DISPUTED" | "AMBIGUOUS" | "NOT_ESTABLISHED";

export type DistanceMethod = "GEODESIC_METER" | "PLANAR_DEGREE" | "DENSIFIED_POINT_METER";

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

export interface AssociationEvidence {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly mmsi: string | null;
  readonly vessel_name: string | null;
  readonly distance_offset_m: number | null;
  readonly time_delta_s: number | null;
  readonly predicted_position: PredictedPosition | null;
  readonly ais_association_confidence: number;
  readonly score_decomposition: ScoreDecomposition | null;
}

export interface EvidenceBullet {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly text: string;
}

export interface EvidenceProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly software_version: string;
  readonly processing_version: string;
  readonly classification_schema: string;
  readonly recorded_at: string;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
  readonly marine_regions: MarineRegionsProvenance;
  readonly sar: SarProvenance;
  readonly aoi: number[];
  readonly processing: ProcessingProvenance;
  readonly ais: AisProvenance;
  readonly matching: MatchingSettings;
}

export interface GhostVesselDossier {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly is_ghost_vessel: true;
  readonly designation: string;
  readonly analytical_classification: string;
  readonly semantic_warning: string;
  readonly observed: GhostObservedEvidence;
  readonly decision: GhostAssociationDecision;
  readonly hypotheses: EvidenceBullet[];
  readonly unknowns: EvidenceBullet[];
}

export interface GhostVesselNotApplicable {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly is_ghost_vessel: false;
  readonly designation: null;
  readonly analytical_classification: string;
}

export interface ObservedEvidence {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly position: ObservedPosition;
  readonly apparent_footprint_m: ApparentFootprint;
  readonly orientation_deg: number | null;
  readonly mean_backscatter_db: number;
  readonly max_backscatter_db: number;
  readonly pixel_area: number;
  readonly wake_evident: boolean | null;
  readonly sar_detection_confidence: number;
}

export interface UncertaintyEvidence {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly length_uncertainty_m: number;
  readonly match_radius_m: number | null;
  readonly propagation_note: string;
}

export interface NarrativeDocument {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly target_id: string;
  readonly observed: string[];
  readonly hypotheses: string[];
  readonly unknowns: string[];
  readonly confidence?: number | null;
  readonly summary: string;
  readonly model: NarrativeModelIdentity;
  readonly provenance: NarrativeProvenance;
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

export interface CameraSnapshot {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly position: CameraPosition;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
}

export interface ContactChoice {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly mmsi: string;
  readonly observation_at?: string | null;
}

export interface LayerChoice {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly visible: boolean;
  readonly opacity: number;
}

export interface TargetChoice {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scan_id: string;
  readonly target_id: string;
}

export interface AnalystSource {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly kind: "PERSISTED_REAL_SCAN" | "OPERATOR_CASE" | "OPERATOR_WATCHLIST";
  readonly source_id: string;
  readonly record_path: string;
  readonly field_path: string;
}

export interface ScanConfigRecord {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly config_hash: string;
  readonly training_cells: number;
  readonly guard_cells: number;
  readonly threshold_factor: number;
  readonly coastline_buffer_meters: number;
  readonly speckle_filter: string;
  readonly kernel_size: number;
  readonly min_pixels: number;
  readonly max_pixels: number;
}

export interface ScanDebugBlock {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly cache: DebugCacheInputs;
  readonly layers?: string[];
  readonly columns?: Record<string, string[]>;
  readonly runtime_mode: string;
  readonly synthetic: boolean;
}

export interface PredictedPosition {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly lat: number;
  readonly lon: number;
}

export interface AisProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly provider: string;
}

export interface MarineRegionsProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly dataset: string;
  readonly layer: string;
  readonly license: string;
  readonly attribution_required: boolean;
  readonly credit: string;
  readonly source_commit: string | null;
  readonly fetched: string | null;
  readonly feature_count: number;
  readonly known_absent: string[];
}

export interface MatchingSettings {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly weights: number[];
  readonly min_score: number;
  readonly window_s: number;
}

export interface ProcessingProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly config_hash: string;
  readonly land_mask: LandMaskProvenance;
  readonly speckle: SpeckleSettings;
  readonly cfar: CfarSettings;
}

export interface SarProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly provider: string;
  readonly collection: string;
  readonly item_id: string;
  readonly platform: string;
  readonly acquisition_time: string;
  readonly product: string;
  readonly polarization: string;
  readonly asset_href: string;
  readonly crs: string | null;
  readonly transform: number[] | null;
  readonly resolution_m: number | null;
  readonly raster_window: number[] | null;
}

export interface GhostAssociationDecision {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly candidates_considered: number | null;
  readonly acceptance_threshold: number | null;
  readonly closest_rejected_candidate: RejectedCandidate | null;
  readonly reason_no_association: string;
  readonly ais_association_confidence: number | null;
  readonly ais_coverage_state: string;
  readonly score_decomposition: ScoreDecomposition | null;
}

export interface GhostObservedEvidence {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly target_id: string | null;
  readonly position: GhostObservedPosition;
  readonly marine_region: string | null;
  readonly sar_detection_confidence: number | null;
  readonly apparent_footprint_m: ApparentFootprint;
  readonly length_uncertainty_m: number | null;
  readonly orientation_deg: number | null;
  readonly mean_backscatter_db: number | null;
  readonly max_backscatter_db: number | null;
  readonly wake_detected: boolean | null;
  readonly polarization_evidence: string | null;
  readonly multipass_evidence: string | null;
}

export interface ApparentFootprint {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly length: number;
  readonly width: number;
}

export interface ObservedPosition {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly lat: number;
  readonly lon: number;
  readonly marine_region: MarineRegionContext;
  readonly vertical_datum: VerticalDatumContext;
}

export interface NarrativeModelIdentity {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly model_id: string;
  readonly provider: string;
  readonly template_version: string;
}

export interface NarrativeProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly writer: string;
  readonly network_calls: number;
}

export interface CameraPosition {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface DebugCacheInputs {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly scene_item_id: string;
  readonly bbox: number[];
  readonly processing_config: Record<string, unknown>;
  readonly algorithm_version: string;
}

export interface CfarSettings {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly training_cells: number;
  readonly guard_cells: number;
  readonly threshold_factor: number;
  readonly min_pixels: number;
  readonly max_pixels: number;
}

export interface LandMaskProvenance {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly source: string;
  readonly water_href: string;
  readonly water_class: number;
  readonly coastline_buffer_m: number;
  readonly port_exceptions: number;
}

export interface SpeckleSettings {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly mode: string;
  readonly kernel: number;
}

export interface GhostObservedPosition {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly lat: number | null;
  readonly lon: number | null;
}

export interface MarineRegionContext {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly kind: "named_region" | "open_ocean" | "unresolved" | "invalid_position";
  readonly named_regions: string[];
  readonly primary: string | null;
  readonly basin: string | null;
  readonly note: string | null;
}

export interface VerticalDatumContext {
  /** Rejects unknown keys at runtime: this schema is additionalProperties:false. */
  readonly geoid_model: string;
  readonly ellipsoid: string;
  readonly undulation_m: number | null;
  readonly undulation_available: boolean;
  readonly altitude_measured: false;
  readonly note: string;
}

/**
 * Schemas reachable as a request body. Discovered from the OpenAPI paths,
 * not maintained by hand, so a new route's body is emitted automatically.
 */
export type ContractRequestSchemaName =
  | 'AnalystRequest'
  | 'AnnotationCreate'
  | 'GeometryCreate'
  | 'ImageryPairRequest'
  | 'InvestigationCreate'
  | 'MissionBody'
  | 'MissionReplace'
  | 'MissionScanLink'
  | 'ProbeRequest'
  | 'ScanCreateRequest'
  | 'SceneCompareRequest'
  | 'ViewCreate'
  | 'ViewReplace'
  | 'WatchEntryCreate'
  | 'WatchRuleCreate'
;

/** Schemas emitted into this file. */
export type ContractSchemaName =
  | 'ScoreDecomposition'
  | 'TargetSummaryResponse'
  | 'ProbeResponse'
  | 'RevisitPlanOut'
  | 'TracksOut'
  | 'PatternsOut'
  | 'DetectorsOut'
  | 'InvestigationOut'
  | 'InvestigationListOut'
  | 'AnnotationOut'
  | 'WatchEntryOut'
  | 'ScanCatalogueResponse'
  | 'ViewCreate'
  | 'ViewReplace'
  | 'SavedViewOut'
  | 'SavedViewsOut'
  | 'GeometryCreate'
  | 'GeometryOut'
  | 'GeometryListOut'
  | 'GeometryInput'
  | 'Measurements'
  | 'MissionOut'
  | 'InvestigationReportOut'
  | 'SceneCandidatesOut'
  | 'SceneComparisonOut'
  | 'SceneCompareRequest'
  | 'ImageryPairRequest'
  | 'ImageryPair'
  | 'AnalystCaseListOut'
  | 'GroundedAnalystOut'
  | 'MissionListOut'
  | 'MissionBody'
  | 'MissionReplace'
  | 'MissionScanLink'
  | 'WatchRuleCreate'
  | 'MissionRuleOut'
  | 'MissionAlertOut'
  | 'MissionEvaluationOut'
  | 'EvaluationRunOut'
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
  | 'SourceRef'
  | 'TargetPosition'
  | 'ZoneContext'
  | 'CoastContext'
  | 'PortContext'
  | 'BathymetryContext'
  | 'TargetMaritimeContextResponse'
  | 'DisplayGeometryMeta'
  | 'DisplayLine'
  | 'DisplayPolygon'
  | 'CoastlineGeometryResponse'
  | 'ZoneGeometryResponse'
  | 'DatasetHealthEntry'
  | 'DatasetHealthResponse'
  | 'AnalystRequest'
  | 'AnnotationCreate'
  | 'InvestigationCreate'
  | 'ProbeRequest'
  | 'ScanCreateRequest'
  | 'WatchEntryCreate'
  | 'EvidenceDocument'
  | 'NarrativeEnvelope'
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
  | 'ScanCatalogueEntry'
  | 'Snapshot'
  | 'SceneCandidateOut'
  | 'ComparisonMetrics'
  | 'SceneIdentity'
  | 'ImageryScene'
  | 'AnalystCaseBrief'
  | 'AnalystClaim'
  | 'AnalystUnknown'
  | 'RejectedCandidate'
  | 'PolarizationEvidence'
  | 'WakeEvidence'
  | 'ScanScene'
  | 'ProviderStatus'
  | 'ScanStage'
  | 'ScanRecordDocument'
  | 'PositionStatus'
  | 'AisCoverageState'
  | 'LicenseKind'
  | 'ContextStatus'
  | 'MaritimeZone'
  | 'DistanceMethod'
  | 'CfarConfig'
  | 'AssociationEvidence'
  | 'EvidenceBullet'
  | 'EvidenceProvenance'
  | 'GhostVesselDossier'
  | 'GhostVesselNotApplicable'
  | 'ObservedEvidence'
  | 'UncertaintyEvidence'
  | 'NarrativeDocument'
  | 'TrackGapOut'
  | 'TrackPointOut'
  | 'CameraSnapshot'
  | 'ContactChoice'
  | 'LayerChoice'
  | 'TargetChoice'
  | 'AnalystSource'
  | 'ScanConfigRecord'
  | 'ScanDebugBlock'
  | 'PredictedPosition'
  | 'AisProvenance'
  | 'MarineRegionsProvenance'
  | 'MatchingSettings'
  | 'ProcessingProvenance'
  | 'SarProvenance'
  | 'GhostAssociationDecision'
  | 'GhostObservedEvidence'
  | 'ApparentFootprint'
  | 'ObservedPosition'
  | 'NarrativeModelIdentity'
  | 'NarrativeProvenance'
  | 'CameraPosition'
  | 'DebugCacheInputs'
  | 'CfarSettings'
  | 'LandMaskProvenance'
  | 'SpeckleSettings'
  | 'GhostObservedPosition'
  | 'MarineRegionContext'
  | 'VerticalDatumContext'
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
 * Property names of {@link TargetSummaryResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TARGETSUMMARYRESPONSE_FIELDS = [
  'scan_id',
  'target_id',
  'classification',
  'ambiguous',
  'evidence',
  'narrative',
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
 * Property names of {@link InvestigationOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const INVESTIGATIONOUT_FIELDS = [
  'id',
  'title',
  'scan_id',
  'aoi',
  'created_at',
  'annotations',
  'watchlist',
] as const;

/**
 * Property names of {@link InvestigationListOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const INVESTIGATIONLISTOUT_FIELDS = [
  'investigations',
] as const;

/**
 * Property names of {@link AnnotationOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANNOTATIONOUT_FIELDS = [
  'id',
  'investigation_id',
  'content',
  'target_id',
  'created_at',
] as const;

/**
 * Property names of {@link WatchEntryOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const WATCHENTRYOUT_FIELDS = [
  'id',
  'investigation_id',
  'target_id',
  'created_at',
] as const;

/**
 * Property names of {@link ScanCatalogueResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANCATALOGUERESPONSE_FIELDS = [
  'scans',
  'count',
] as const;

/**
 * Property names of {@link ViewCreate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const VIEWCREATE_FIELDS = [
  'title',
  'snapshot',
] as const;

/**
 * Property names of {@link ViewReplace} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const VIEWREPLACE_FIELDS = [
  'title',
  'snapshot',
  'expected_revision',
] as const;

/**
 * Property names of {@link SavedViewOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SAVEDVIEWOUT_FIELDS = [
  'id',
  'title',
  'revision',
  'created_at',
  'updated_at',
  'snapshot',
  'status',
  'missing_resources',
] as const;

/**
 * Property names of {@link SavedViewsOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SAVEDVIEWSOUT_FIELDS = [
  'views',
  'count',
] as const;

/**
 * Property names of {@link GeometryCreate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GEOMETRYCREATE_FIELDS = [
  'label',
  'notes',
  'geometry',
] as const;

/**
 * Property names of {@link GeometryOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GEOMETRYOUT_FIELDS = [
  'id',
  'investigation_id',
  'scan_id',
  'provenance',
  'label',
  'notes',
  'geometry',
  'measurements',
  'created_at',
  'updated_at',
] as const;

/**
 * Property names of {@link GeometryListOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GEOMETRYLISTOUT_FIELDS = [
  'geometries',
] as const;

/**
 * Property names of {@link GeometryInput} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GEOMETRYINPUT_FIELDS = [
  'kind',
  'coordinates',
  'radius_m',
] as const;

/**
 * Property names of {@link Measurements} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MEASUREMENTS_FIELDS = [
  'ellipsoid',
  'method',
  'length_m',
  'length_km',
  'length_nm',
  'initial_bearing_deg',
  'perimeter_m',
  'perimeter_km',
  'perimeter_nm',
  'area_m2',
  'area_km2',
  'radius_m',
  'radius_km',
  'radius_nm',
] as const;

/**
 * Property names of {@link MissionOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONOUT_FIELDS = [
  'id',
  'title',
  'aoi',
  'status',
  'created_at',
  'updated_at',
  'scan_ids',
  'rules',
  'alerts',
  'evaluations',
] as const;

/**
 * Property names of {@link InvestigationReportOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const INVESTIGATIONREPORTOUT_FIELDS = [
  'schema_version',
  'kind',
  'investigation',
  'source_status',
  'sensor_evidence',
  'operator_material',
  'scientific_limits',
  'warnings',
  'content_sha256',
  'hash_algorithm',
] as const;

/**
 * Property names of {@link SceneCandidatesOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENECANDIDATESOUT_FIELDS = [
  'scenes',
  'total_real_scans',
  'note',
] as const;

/**
 * Property names of {@link SceneComparisonOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENECOMPARISONOUT_FIELDS = [
  'status',
  'reason',
  'first',
  'second',
  'metrics',
  'acquisition_interval_hours',
  'caveat',
] as const;

/**
 * Property names of {@link SceneCompareRequest} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENECOMPAREREQUEST_FIELDS = [
  'first_scan_id',
  'second_scan_id',
] as const;

/**
 * Property names of {@link ImageryPairRequest} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const IMAGERYPAIRREQUEST_FIELDS = [
  'first_scan_id',
  'second_scan_id',
] as const;

/**
 * Property names of {@link ImageryPair} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const IMAGERYPAIR_FIELDS = [
  'first',
  'second',
  'status',
  'interpretation',
] as const;

/**
 * Property names of {@link AnalystCaseListOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANALYSTCASELISTOUT_FIELDS = [
  'cases',
  'total',
  'note',
] as const;

/**
 * Property names of {@link GroundedAnalystOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GROUNDEDANALYSTOUT_FIELDS = [
  'kind',
  'case_id',
  'case_title',
  'linked_scan_id',
  'source_status',
  'intent',
  'focused_target_id',
  'model_status',
  'claims',
  'unknowns',
  'operator_note_count',
  'operator_watch_count',
  'source_canonical_sha256',
  'disclaimer',
] as const;

/**
 * Property names of {@link MissionListOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONLISTOUT_FIELDS = [
  'missions',
] as const;

/**
 * Property names of {@link MissionBody} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONBODY_FIELDS = [
  'title',
  'aoi',
  'status',
] as const;

/**
 * Property names of {@link MissionReplace} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONREPLACE_FIELDS = [
  'title',
  'aoi',
  'status',
] as const;

/**
 * Property names of {@link MissionScanLink} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONSCANLINK_FIELDS = [
  'scan_id',
] as const;

/**
 * Property names of {@link WatchRuleCreate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const WATCHRULECREATE_FIELDS = [
  'investigation_id',
  'target_id',
  'minimum_sar_confidence',
] as const;

/**
 * Property names of {@link MissionRuleOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONRULEOUT_FIELDS = [
  'id',
  'mission_id',
  'investigation_id',
  'scan_id',
  'target_id',
  'kind',
  'minimum_sar_confidence',
  'created_at',
] as const;

/**
 * Property names of {@link MissionAlertOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONALERTOUT_FIELDS = [
  'id',
  'mission_id',
  'rule_id',
  'scan_id',
  'target_id',
  'minimum_sar_confidence',
  'sar_confidence',
  'classification',
  'rationale',
  'evidence',
  'evidence_fingerprint',
  'status',
  'created_at',
  'acknowledged_at',
  'provenance',
] as const;

/**
 * Property names of {@link MissionEvaluationOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MISSIONEVALUATIONOUT_FIELDS = [
  'mission_id',
  'rule_id',
  'scan_id',
  'target_id',
  'status',
  'reason',
  'evaluated_at',
  'evidence_fingerprint',
] as const;

/**
 * Property names of {@link EvaluationRunOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const EVALUATIONRUNOUT_FIELDS = [
  'mission_id',
  'evaluations',
  'alerts_created',
  'existing_alerts',
  'not_evaluated',
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
  'wakeAnalysis',
  'polarizationEvidence',
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
  'position_status',
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
 * Property names of {@link SourceRef} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SOURCEREF_FIELDS = [
  'provider',
  'dataset',
  'version',
  'license',
  'attribution',
  'identifier',
  'release_date',
  'retrieved_at',
  'terms_notes',
  'limitations',
  'coverage_note',
  'install_status',
] as const;

/**
 * Property names of {@link TargetPosition} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TARGETPOSITION_FIELDS = [
  'latitude',
  'longitude',
] as const;

/**
 * Property names of {@link ZoneContext} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ZONECONTEXT_FIELDS = [
  'status',
  'zone',
  'feature_id',
  'sovereign_names',
  'dispute_note',
  'reason',
  'established',
  'disputed',
  'provenance',
  'detail',
] as const;

/**
 * Property names of {@link CoastContext} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const COASTCONTEXT_FIELDS = [
  'status',
  'meters',
  'method',
  'sample_spacing_m',
  'searched_radius_m',
  'provenance',
  'detail',
] as const;

/**
 * Property names of {@link PortContext} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PORTCONTEXT_FIELDS = [
  'status',
  'port_id',
  'name',
  'country',
  'harbor_type',
  'harbor_size',
  'longitude',
  'latitude',
  'meters',
  'method',
  'searched_radius_m',
  'provenance',
  'interpretation',
  'detail',
] as const;

/**
 * Property names of {@link BathymetryContext} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const BATHYMETRYCONTEXT_FIELDS = [
  'status',
  'meters',
  'resolution_deg',
  'source_type',
  'provenance',
  'detail',
] as const;

/**
 * Property names of {@link TargetMaritimeContextResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TARGETMARITIMECONTEXTRESPONSE_FIELDS = [
  'scan_id',
  'target_id',
  'position',
  'maritime_zone',
  'nearest_coast',
  'nearest_port',
  'bathymetry',
  'generated_at',
  'context_version',
] as const;

/**
 * Property names of {@link DisplayGeometryMeta} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DISPLAYGEOMETRYMETA_FIELDS = [
  'tolerance_deg',
  'source_vertex_count',
  'vertex_count',
  'part_count',
  'hole_count',
  'viewport_filtered',
  'notice',
] as const;

/**
 * Property names of {@link DisplayLine} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DISPLAYLINE_FIELDS = [
  'coordinates',
] as const;

/**
 * Property names of {@link DisplayPolygon} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DISPLAYPOLYGON_FIELDS = [
  'id',
  'zone',
  'pol_type',
  'geoname',
  'sovereign_names',
  'territory_names',
  'dispute_note',
  'disputed',
  'parts',
  'holes',
] as const;

/**
 * Property names of {@link CoastlineGeometryResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const COASTLINEGEOMETRYRESPONSE_FIELDS = [
  'layer',
  'status',
  'detail',
  'evidentiary',
  'provenance',
  'lines',
  'meta',
  'bbox',
] as const;

/**
 * Property names of {@link ZoneGeometryResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ZONEGEOMETRYRESPONSE_FIELDS = [
  'layer',
  'status',
  'detail',
  'evidentiary',
  'provenance',
  'polygons',
  'meta',
  'bbox',
  'total_feature_count',
  'filtered_feature_count',
] as const;

/**
 * Property names of {@link DatasetHealthEntry} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DATASETHEALTHENTRY_FIELDS = [
  'id',
  'label',
  'install_status',
  'usable',
  'blocker_reason',
  'optional',
  'provider',
  'dataset',
  'version',
  'version_established',
  'release_date',
  'retrieved_at',
  'license',
  'attribution',
  'identifier',
  'source_mechanism',
  'source_service',
  'source_layer',
  'source_feature_count',
  'installed_at',
  'computed_sha256',
  'expected_sha256',
  'coverage_note',
  'terms_notes',
  'limitations',
  'detail',
] as const;

/**
 * Property names of {@link DatasetHealthResponse} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DATASETHEALTHRESPONSE_FIELDS = [
  'datasets',
  'generated_at',
  'usable_count',
  'verified_count',
] as const;

/**
 * Property names of {@link AnalystRequest} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANALYSTREQUEST_FIELDS = [
  'intent',
  'target_id',
] as const;

/**
 * Property names of {@link AnnotationCreate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANNOTATIONCREATE_FIELDS = [
  'content',
  'target_id',
] as const;

/**
 * Property names of {@link InvestigationCreate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const INVESTIGATIONCREATE_FIELDS = [
  'title',
  'scan_id',
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
 * Property names of {@link WatchEntryCreate} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const WATCHENTRYCREATE_FIELDS = [
  'target_id',
] as const;

/**
 * Property names of {@link EvidenceDocument} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const EVIDENCEDOCUMENT_FIELDS = [
  'target_id',
  'classification',
  'designation',
  'ghost_vessel',
  'observed',
  'uncertainty',
  'association',
  'summary',
  'tags',
  'hypotheses',
  'unknowns',
  'sar_chip',
  'provenance',
] as const;

/**
 * Property names of {@link NarrativeEnvelope} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const NARRATIVEENVELOPE_FIELDS = [
  'status',
  'document',
  'reason',
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
 * Property names of {@link ScanCatalogueEntry} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANCATALOGUEENTRY_FIELDS = [
  'scan_id',
  'created_at',
  'scene_id',
  'acquisition_time',
  'provider',
  'product',
  'polarization',
  'runtime_mode',
  'synthetic',
] as const;

/**
 * Property names of {@link Snapshot} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SNAPSHOT_FIELDS = [
  'schema_version',
  'camera',
  'map_source_id',
  'layers',
  'scan_id',
  'target',
  'contact',
  'playback_at',
  'playback_speed',
  'workspace',
  'aoi',
  'investigation_id',
] as const;

/**
 * Property names of {@link SceneCandidateOut} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENECANDIDATEOUT_FIELDS = [
  'scan_id',
  'item_id',
  'acquisition_time',
  'product',
  'polarization',
  'available_normalized_raster',
  'georeference_present',
] as const;

/**
 * Property names of {@link ComparisonMetrics} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const COMPARISONMETRICS_FIELDS = [
  'overlap_shape',
  'offset_b_in_a_pixels',
  'overlap_pixels',
  'valid_pair_pixels',
  'valid_pair_fraction',
  'mean_b_minus_a_db',
  'mean_absolute_difference_db',
  'root_mean_square_difference_db',
  'median_b_minus_a_db',
  'p05_b_minus_a_db',
  'p95_b_minus_a_db',
  'brighter_b_pixels',
  'darker_b_pixels',
  'equal_pixels',
  'metric',
] as const;

/**
 * Property names of {@link SceneIdentity} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCENEIDENTITY_FIELDS = [
  'scan_id',
  'item_id',
  'acquisition_time',
  'product',
  'polarization',
  'crs',
  'window_transform',
  'raster_shape',
  'processing_version',
  'source',
] as const;

/**
 * Property names of {@link ImageryScene} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const IMAGERYSCENE_FIELDS = [
  'scan_id',
  'status',
  'reason',
  'item_id',
  'acquisition_time',
  'product',
  'polarization',
  'platform',
  'provider',
  'crs',
  'transform',
  'wgs84_corners_lon_lat',
  'raster_window',
  'source_shape',
  'preview_shape',
  'sample_stride',
  'valid_source_pixels',
  'total_source_pixels',
  'displayed_valid_pixels',
  'image_url',
  'display_window_db',
  'source',
] as const;

/**
 * Property names of {@link AnalystCaseBrief} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANALYSTCASEBRIEF_FIELDS = [
  'case_id',
  'title',
  'linked_scan_id',
  'created_at',
] as const;

/**
 * Property names of {@link AnalystClaim} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANALYSTCLAIM_FIELDS = [
  'id',
  'statement',
  'value',
  'classification',
  'uncertainty',
  'sources',
] as const;

/**
 * Property names of {@link AnalystUnknown} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANALYSTUNKNOWN_FIELDS = [
  'code',
  'explanation',
  'source_id',
  'expected_field_path',
  'next_check',
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
 * Property names of {@link PolarizationEvidence} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const POLARIZATIONEVIDENCE_FIELDS = [
  'status',
  'available',
  'requested',
  'single_pol',
  'per_pol',
  'vh_over_vv_db',
  'dual_pol_flags',
  'calibration_domain',
  'reason',
  'notes',
] as const;

/**
 * Property names of {@link WakeEvidence} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const WAKEEVIDENCE_FIELDS = [
  'state',
  'detected',
  'confidence',
  'error_type',
  'error_message',
  'heading_deg',
  'wake_direction_deg',
  'apparent_length_m',
  'arm_angle_deg',
  'arm_angle_line_deg',
  'method',
  'notes',
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
 * Property names of {@link ScanRecordDocument} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANRECORDDOCUMENT_FIELDS = [
  'scan_id',
  'schema_version',
  'runtime_mode',
  'synthetic',
  'scene',
  'aoi',
  'acquisition_time',
  'config',
  'targets',
  'ais_only',
  'counts',
  'provenance',
  'debug',
  'processing_time_ms',
  'created_at',
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
 * Property names of {@link AssociationEvidence} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ASSOCIATIONEVIDENCE_FIELDS = [
  'mmsi',
  'vessel_name',
  'distance_offset_m',
  'time_delta_s',
  'predicted_position',
  'ais_association_confidence',
  'score_decomposition',
] as const;

/**
 * Property names of {@link EvidenceBullet} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const EVIDENCEBULLET_FIELDS = [
  'text',
] as const;

/**
 * Property names of {@link EvidenceProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const EVIDENCEPROVENANCE_FIELDS = [
  'software_version',
  'processing_version',
  'classification_schema',
  'recorded_at',
  'runtime_mode',
  'synthetic',
  'marine_regions',
  'sar',
  'aoi',
  'processing',
  'ais',
  'matching',
] as const;

/**
 * Property names of {@link GhostVesselDossier} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GHOSTVESSELDOSSIER_FIELDS = [
  'is_ghost_vessel',
  'designation',
  'analytical_classification',
  'semantic_warning',
  'observed',
  'decision',
  'hypotheses',
  'unknowns',
] as const;

/**
 * Property names of {@link GhostVesselNotApplicable} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GHOSTVESSELNOTAPPLICABLE_FIELDS = [
  'is_ghost_vessel',
  'designation',
  'analytical_classification',
] as const;

/**
 * Property names of {@link ObservedEvidence} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const OBSERVEDEVIDENCE_FIELDS = [
  'position',
  'apparent_footprint_m',
  'orientation_deg',
  'mean_backscatter_db',
  'max_backscatter_db',
  'pixel_area',
  'wake_evident',
  'sar_detection_confidence',
] as const;

/**
 * Property names of {@link UncertaintyEvidence} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const UNCERTAINTYEVIDENCE_FIELDS = [
  'length_uncertainty_m',
  'match_radius_m',
  'propagation_note',
] as const;

/**
 * Property names of {@link NarrativeDocument} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const NARRATIVEDOCUMENT_FIELDS = [
  'target_id',
  'observed',
  'hypotheses',
  'unknowns',
  'confidence',
  'summary',
  'model',
  'provenance',
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
 * Property names of {@link CameraSnapshot} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const CAMERASNAPSHOT_FIELDS = [
  'position',
  'heading',
  'pitch',
  'roll',
] as const;

/**
 * Property names of {@link ContactChoice} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const CONTACTCHOICE_FIELDS = [
  'mmsi',
  'observation_at',
] as const;

/**
 * Property names of {@link LayerChoice} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const LAYERCHOICE_FIELDS = [
  'visible',
  'opacity',
] as const;

/**
 * Property names of {@link TargetChoice} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const TARGETCHOICE_FIELDS = [
  'scan_id',
  'target_id',
] as const;

/**
 * Property names of {@link AnalystSource} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const ANALYSTSOURCE_FIELDS = [
  'kind',
  'source_id',
  'record_path',
  'field_path',
] as const;

/**
 * Property names of {@link ScanConfigRecord} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANCONFIGRECORD_FIELDS = [
  'config_hash',
  'training_cells',
  'guard_cells',
  'threshold_factor',
  'coastline_buffer_meters',
  'speckle_filter',
  'kernel_size',
  'min_pixels',
  'max_pixels',
] as const;

/**
 * Property names of {@link ScanDebugBlock} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SCANDEBUGBLOCK_FIELDS = [
  'cache',
  'layers',
  'columns',
  'runtime_mode',
  'synthetic',
] as const;

/**
 * Property names of {@link PredictedPosition} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PREDICTEDPOSITION_FIELDS = [
  'lat',
  'lon',
] as const;

/**
 * Property names of {@link AisProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const AISPROVENANCE_FIELDS = [
  'provider',
] as const;

/**
 * Property names of {@link MarineRegionsProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MARINEREGIONSPROVENANCE_FIELDS = [
  'dataset',
  'layer',
  'license',
  'attribution_required',
  'credit',
  'source_commit',
  'fetched',
  'feature_count',
  'known_absent',
] as const;

/**
 * Property names of {@link MatchingSettings} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MATCHINGSETTINGS_FIELDS = [
  'weights',
  'min_score',
  'window_s',
] as const;

/**
 * Property names of {@link ProcessingProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const PROCESSINGPROVENANCE_FIELDS = [
  'config_hash',
  'land_mask',
  'speckle',
  'cfar',
] as const;

/**
 * Property names of {@link SarProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SARPROVENANCE_FIELDS = [
  'provider',
  'collection',
  'item_id',
  'platform',
  'acquisition_time',
  'product',
  'polarization',
  'asset_href',
  'crs',
  'transform',
  'resolution_m',
  'raster_window',
] as const;

/**
 * Property names of {@link GhostAssociationDecision} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GHOSTASSOCIATIONDECISION_FIELDS = [
  'candidates_considered',
  'acceptance_threshold',
  'closest_rejected_candidate',
  'reason_no_association',
  'ais_association_confidence',
  'ais_coverage_state',
  'score_decomposition',
] as const;

/**
 * Property names of {@link GhostObservedEvidence} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GHOSTOBSERVEDEVIDENCE_FIELDS = [
  'target_id',
  'position',
  'marine_region',
  'sar_detection_confidence',
  'apparent_footprint_m',
  'length_uncertainty_m',
  'orientation_deg',
  'mean_backscatter_db',
  'max_backscatter_db',
  'wake_detected',
  'polarization_evidence',
  'multipass_evidence',
] as const;

/**
 * Property names of {@link ApparentFootprint} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const APPARENTFOOTPRINT_FIELDS = [
  'length',
  'width',
] as const;

/**
 * Property names of {@link ObservedPosition} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const OBSERVEDPOSITION_FIELDS = [
  'lat',
  'lon',
  'marine_region',
  'vertical_datum',
] as const;

/**
 * Property names of {@link NarrativeModelIdentity} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const NARRATIVEMODELIDENTITY_FIELDS = [
  'model_id',
  'provider',
  'template_version',
] as const;

/**
 * Property names of {@link NarrativeProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const NARRATIVEPROVENANCE_FIELDS = [
  'writer',
  'network_calls',
] as const;

/**
 * Property names of {@link CameraPosition} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const CAMERAPOSITION_FIELDS = [
  'x',
  'y',
  'z',
] as const;

/**
 * Property names of {@link DebugCacheInputs} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const DEBUGCACHEINPUTS_FIELDS = [
  'scene_item_id',
  'bbox',
  'processing_config',
  'algorithm_version',
] as const;

/**
 * Property names of {@link CfarSettings} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const CFARSETTINGS_FIELDS = [
  'training_cells',
  'guard_cells',
  'threshold_factor',
  'min_pixels',
  'max_pixels',
] as const;

/**
 * Property names of {@link LandMaskProvenance} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const LANDMASKPROVENANCE_FIELDS = [
  'source',
  'water_href',
  'water_class',
  'coastline_buffer_m',
  'port_exceptions',
] as const;

/**
 * Property names of {@link SpeckleSettings} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const SPECKLESETTINGS_FIELDS = [
  'mode',
  'kernel',
] as const;

/**
 * Property names of {@link GhostObservedPosition} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const GHOSTOBSERVEDPOSITION_FIELDS = [
  'lat',
  'lon',
] as const;

/**
 * Property names of {@link MarineRegionContext} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const MARINEREGIONCONTEXT_FIELDS = [
  'kind',
  'named_regions',
  'primary',
  'basin',
  'note',
] as const;

/**
 * Property names of {@link VerticalDatumContext} as they appear on the wire.
 *
 * Generated. Runtime validation reads this instead of keeping its own list,
 * so the permitted keys cannot drift from the contract they enforce.
 */
export const VERTICALDATUMCONTEXT_FIELDS = [
  'geoid_model',
  'ellipsoid',
  'undulation_m',
  'undulation_available',
  'altitude_measured',
  'note',
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
