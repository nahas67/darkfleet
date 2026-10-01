/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet Core Data Types & Schema
 * Canonical Domain Model for SAR/AIS Maritime Spatial Intelligence
 */

export type BoundingBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export type RuntimeMode = 'DEMO' | 'REAL';

export type DisplayMode = 'WORLD' | 'SAR' | 'SAR_CONTRAST' | 'CORRELATION' | 'ANALYSIS';

export type ScanStage =
  | 'QUEUED'
  | 'SEARCHING_SCENE'
  | 'LOADING_SAR'
  | 'PREPROCESSING'
  | 'DETECTING'
  | 'LOADING_AIS'
  | 'ALIGNING_AIS'
  | 'CORRELATING'
  | 'SCORING'
  | 'COMPLETE'
  | 'FAILED';

export interface ScanProgressEvent {
  stage: ScanStage;
  message: string;
  step: number;
  totalSteps: number;
  timestamp: string;
}

export type ScanEventSink = (event: ScanProgressEvent) => void;

/**
 * Scientifically neutral detection classification.
 * An unmatched radar return indicates absence of correlated transponder in available
 * observations, NOT proof of illicit intent or covert activity.
 */
export type TargetClassification = 
  | 'SAR_MATCHED_AIS' 
  | 'SAR_UNMATCHED' 
  | 'AIS_ONLY' 
  | 'STATIONARY_OR_INFRASTRUCTURE' 
  | 'SEA_CLUTTER' 
  | 'LOW_CONFIDENCE' 
  | 'UNRESOLVED';

export interface DataSourceStatus {
  mode: RuntimeMode;
  sarSource: string;
  aisSource: string;
  satellitePlatform: string;
  sensorMode: string;
  polarization: string;
  isSynthetic: boolean;
}

export interface ScanProvenance {
  runtimeMode: RuntimeMode;
  sarSource: string;
  sarSceneId: string;
  aisSource: string;
  acquisitionTimestamp: string;
  processingTimestamp: string;
  processingVersion: string;
  classificationSchemaVersion: string;
  synthetic: boolean;
  cfarConfig: CFARConfig;
}

export interface SourceHealth {
  sar: {
    status: 'available' | 'degraded' | 'unavailable';
    provider: string;
    message?: string;
  };
  ais: {
    status: 'available' | 'degraded' | 'unavailable';
    provider: string;
    historicalCoverage?: string;
    message?: string;
  };
}

export interface Sentinel1Scene {
  id: string; // e.g. "SIM-S1C-MALACCA-001" or real STAC Item ID
  platform: 'Sentinel-1A' | 'Sentinel-1C' | 'Sentinel-1D' | 'Simulation';
  mode: 'IW' | 'EW' | 'SM';
  productType: 'GRD' | 'RTC';
  polarization: 'VV' | 'VH' | 'VV+VH';
  orbitDirection: 'ASCENDING' | 'DESCENDING';
  acquisitionTime: string; // ISO 8601
  incidenceAngle: number; // degrees
  resolutionMeters: number; // nominal pixel spacing
  bbox: BoundingBox;
  regionName: string;
  subRegion: string;
  isSimulation: boolean;
  stacAssetUrl?: string;
  seaClutterLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'SEVERE';
}

export interface CFARConfig {
  trainingCells: number; // N_train (surrounding reference window)
  guardCells: number; // N_guard (guard window to avoid target self-masking)
  thresholdFactor: number; // alpha multiplier for P_fa
  coastlineBufferMeters: number; // exclusion distance from land
  speckleFilter: 'median' | 'lee' | 'none';
  kernelSize: number; // e.g. 3x3
  minPixels: number; // minimum connected component area
  maxPixels: number; // maximum pixel area before discarding as island/land sliver
}

export interface SARChip {
  matrix: number[][]; // normalized backscatter in dB (-30 to +5 dB)
  width: number;
  height: number;
  maxDb: number;
  meanDb: number;
  clutterMeanDb: number;
  cornerReflectors: Array<{ x: number; y: number; intensity: number }>;
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

export interface AISCorrelation {
  matched: boolean;
  mmsi: string | null;
  vesselName: string | null;
  callsign: string | null;
  imo: string | null;
  flag: string | null;
  shipType: string | null;
  sogKnots: number | null;
  cogDeg: number | null;
  navStatus: string | null;
  distanceOffsetMeters: number | null;
  timeDeltaSeconds: number | null;
  predictedLat: number | null;
  predictedLon: number | null;
  reportedLengthMeters: number | null;
  scoreDecomposition?: ScoreDecomposition | null;
}

export interface VesselTarget {
  id: string; // e.g. "DF-001"
  scanId: string;
  position: {
    lat: number;
    lon: number;
  };
  pixelCentroid: {
    x: number;
    y: number;
  };
  box2d: [ymin: number, xmin: number, ymax: number, xmax: number]; // normalized 0-1000
  classification: TargetClassification;
  confidence: number; // 0.0 - 1.0 (overall confidence)
  sarConfidence: number; // detection confidence from radar SNR
  aisMatchConfidence: number; // association confidence
  estimatedLengthMeters: number;
  apparentWidthMeters: number;
  lengthUncertaintyMeters: number;
  estimatedHeadingDeg: number;
  wakeVisible: boolean;
  wakeHeadingDeg?: number;
  meanBackscatterDb: number;
  maxBackscatterDb: number;
  pixelArea: number;
  aisCorrelation: AISCorrelation;
  tacticalAssessment: string; // Objective evidence-based observation
  tags: string[];
  sarChip?: SARChip;
  proximityPartnerId?: string | null; // Nearby vessel ID within proximity threshold
}

export interface AISObservation {
  mmsi: string;
  shipName: string;
  callsign: string;
  imo: string;
  flag: string;
  shipType: string;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number;
  navStatus: string;
  length: number;
  width: number;
  timestamp: string;
  isCorrelatedWithSar?: boolean;
}

export interface ScanResult {
  scanId: string;
  runtimeMode: RuntimeMode;
  scene: Sentinel1Scene;
  aoi: BoundingBox;
  timestamp: string;
  cfarConfig: CFARConfig;
  detectionsCount: number;
  unmatchedCount: number;
  matchedCount: number;
  staticCount: number;
  aisOnlyCount: number;
  scanConfidence: number;
  vessels: VesselTarget[];
  aisObservations: AISObservation[];
  areaSummary: string;
  processingTimeMs: number;
  dataSource: DataSourceStatus;
  provenance: ScanProvenance;
}

export interface RegionScenario {
  id: string;
  name: string;
  chokepoint: string;
  center: [lat: number, lon: number];
  zoom: number;
  bbox: BoundingBox;
  description: string;
  strategicContext: string;
  satellitePass: string;
  defaultSceneId: string;
}

export type LayerId =
  | 'BASE_WORLD'
  | 'SAR_RASTER'
  | 'SAR_HEATMAP'
  | 'SAR_FOOTPRINT'
  | 'SAR_DETECTIONS'
  | 'AIS_CONTACTS'
  | 'AIS_TRAILS'
  | 'CORRELATION_LINKS'
  | 'UNCERTAINTY'
  | 'SELECTED_TARGET'
  | 'LAND_MASK';

export interface LayerConfig {
  id: LayerId;
  title: string;
  group: 'BASE' | 'SAR' | 'AIS' | 'CORRELATION';
  visible: boolean;
  opacity?: number;
  source: string;
  loading?: boolean;
  error?: string | null;
}

export interface DisplayOptions {
  showSarOverlay: boolean;
  showLandMask: boolean;
  showDetections: boolean;
  showAisTracks: boolean;
  showCorrelationLinks: boolean;
  showWakes: boolean;
  showSceneFootprint: boolean;
  showUncertaintyRings: boolean;
  sarColorMode: 'sar-mono' | 'contrast' | 'thermal';
  showHeatmapOverlay: boolean;
  heatmapOpacity: number;
  heatmapPalette?: 'turbo' | 'thermal' | 'plasma';
}

export interface SceneQuery {
  bbox?: BoundingBox;
  startDate?: string;
  endDate?: string;
  platform?: string;
}

export interface SceneSearchResult {
  scenes: Sentinel1Scene[];
  regions: RegionScenario[];
  source: string;
  totalAvailable: number;
}

export interface ScanRequest {
  sceneId: string;
  bbox?: BoundingBox;
  cfarConfig?: CFARConfig;
  runtimeMode?: RuntimeMode;
}
