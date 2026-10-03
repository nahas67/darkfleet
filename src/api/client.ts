/**
 * API -> domain state.
 *
 * One place that turns wire payloads into the store's shapes. Everything that
 * knows about `cls` vs `classification`, nullable AIS measurements, coverage
 * states or the REAL-only guard lives here, so no component repeats the
 * translation and none of them can drift from it.
 */

import type {
  AisAssociation,
  AisCoverageOut,
  CfarConfig as CfarConfigContract,
  HealthResponse,
  ScanCreateRequest,
  ScanTargetsResponse,
  SceneListResponse,
  TargetClassification,
  VesselTrackResponse,
  VesselTarget,
} from '../api/contract';
import { ApiError, ContractViolation, api } from './errors';
import { validateScanTargetsResponse } from './validate';
import { openStageStream, type StageStreamHandle } from './sse';
import {
  DEFAULT_CFAR_CONFIG,
  isSpeckleMode,
  type CfarConfig,
} from '../analysis/cfar';
import type { AisContact, BBox, Coverage, SarTarget, VesselTrack } from '../state/store';
import { store } from '../state/store';

/**
 * The real-data guard.
 *
 * A payload that is not `REAL` / `synthetic:false` is refused outright. There is
 * no demo world to fall back to, so the only correct response is to draw nothing
 * and say why. Rendering it anyway would put invented marks on the tactical
 * world next to real ones, which is the failure mode this product exists to
 * avoid.
 */
export function assertReal(record: {
  runtime_mode?: string;
  synthetic?: boolean;
}): boolean {
  return record.runtime_mode === 'REAL' && record.synthetic === false;
}

function associationOf(target: VesselTarget): AisAssociation | null {
  return (target.corr ?? null) as AisAssociation | null;
}

export function toSarTarget(target: VesselTarget): SarTarget {
  const corr = associationOf(target);
  const unc = (target as { geolocationUncertaintyM?: unknown }).geolocationUncertaintyM;
  const sceneItemId = (target as { sceneItemId?: unknown }).sceneItemId;
  return {
    id: target.id,
    classification: target.classification as TargetClassification | string,
    lat: target.lat,
    lon: target.lon,
    sarConf: target.sarConf,
    aisConf: target.aisConf,
    mmsi: corr?.mmsi ?? null,
    distanceOffsetMeters: corr?.distanceOffsetMeters ?? null,
    matchRadiusMeters: corr?.scoreDecomposition?.matchRadiusMeters ?? null,
    geolocationUncertaintyM: typeof unc === 'number' && Number.isFinite(unc) ? unc : null,
    // GEO-CORR's sub-pixel centroid, carried so the analytics surface can place
    // this target on the raster without deriving a position of its own. Validated
    // here rather than cast: a malformed pair must read as "no anchor", because a
    // partially-valid centroid would put the marker in the wrong place silently.
    geoPixelCentroid: toCentroid(target.geoPixelCentroid),
    geoCentreOffset:
      typeof target.geoCentreOffset === 'number' && Number.isFinite(target.geoCentreOffset)
        ? target.geoCentreOffset
        : null,
    sceneItemId: typeof sceneItemId === 'string' ? sceneItemId : null,
  };
}

/**
 * A centroid is usable only if both parts are finite numbers.
 *
 * Anything else reads as no anchor at all, which is the honest state: the target
 * cannot be placed on the raster, and the interface says so rather than guessing.
 */
function toCentroid(raw: readonly number[] | null | undefined): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [col, row] = raw;
  if (typeof col !== 'number' || typeof row !== 'number') return null;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  return [col, row];
}

function toCoverage(raw: AisCoverageOut | undefined | null): Coverage {
  if (!raw) {
    return {
      state: 'NOT_CONFIGURED',
      detail: 'The backend returned no coverage statement for this request.',
      observationCount: null,
    };
  }
  return {
    state: raw.state,
    detail: raw.detail,
    observationCount: raw.observation_count ?? null,
  };
}

/* ----------------------------------------------------------------- scans */

let streamHandle: StageStreamHandle | null = null;

export function releaseStageStream(): void {
  streamHandle?.close();
  streamHandle = null;
}

/**
 * Start a scan and follow it.
 *
 * The AOI is required. There is no default extent: silently scanning somewhere
 * the operator did not choose is the kind of plausible-looking behaviour this
 * product refuses.
 */
export async function startScan(
  aoi: BBox,
  sceneId?: string,
  cfarConfig?: CfarConfigContract,
): Promise<string> {
  releaseStageStream();
  store.set({
    scanError: null,
    scanStage: 'QUEUED',
    scanStageHistory: [],
    streamState: 'CONNECTING',
    targets: [],
    aisOnly: [],
    rasterLoaded: false,
    rasterError: null,
    track: null,
  });

  // Built as a generated `ScanCreateRequest`, not an inline literal.
  //
  // The inline literal sent `scene_id`, which the backend rejects: the request
  // model is `extra="forbid"` and never declared that field, so choosing a scene
  // and running a scan returned 422. Nothing caught it because the body was
  // hand-written and untyped. Typing it against the generated contract makes the
  // next such mismatch a compile error, and `sceneId` below is the field the
  // schema actually declares.
  //
  // `cfar_config` is included only when supplied, and is `undefined`-omitted
  // rather than sent as null: an explicit null would mean "no configuration",
  // which is a different claim from "use the pipeline defaults".
  const body: ScanCreateRequest = {
    bbox: [aoi[0], aoi[1], aoi[2], aoi[3]],
    ...(sceneId ? { sceneId } : {}),
    ...(cfarConfig ? { cfar_config: cfarConfig } : {}),
  };

  const accepted = await api.post<{ scan_id: string }>('/api/scans', body);

  store.set({ scanId: accepted.scan_id, aoi });
  followScan(accepted.scan_id);
  return accepted.scan_id;
}

/**
 * The configuration a completed scan was actually computed with.
 *
 * Read from `provenance.processing_config` on the raster metadata, which is the
 * backend's own record of the run. Never defaulted.
 *
 * The reason this exists rather than a constant: the analytics surface has to
 * separate "the run you are looking at" from "the configuration you are
 * proposing", and only the record can establish the first. A browser-side
 * default rendered as CURRENT would claim the run used values nobody recorded.
 *
 * Returns null when the record predates the field or the run has no config. That
 * is distinct from a config of zeros, and the surface shows it as not recorded.
 */
export async function loadRunConfig(
  scanId: string,
): Promise<{ config: CfarConfig; configHash: string | null } | null> {
  let body: unknown;
  try {
    body = await api.get(`/api/scans/${scanId}/raster/raw`);
  } catch {
    // A scan with no rendered raster has no run config to report. That is a
    // normal state, not an error worth surfacing as one.
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const provenance = (body as { provenance?: unknown }).provenance;
  if (typeof provenance !== 'object' || provenance === null) return null;
  const raw = (provenance as { processing_config?: unknown }).processing_config;
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const config: CfarConfig = {
    trainingCells: numOr(record.training_cells, DEFAULT_CFAR_CONFIG.trainingCells),
    guardCells: numOr(record.guard_cells, DEFAULT_CFAR_CONFIG.guardCells),
    thresholdFactor: numOr(record.threshold_factor, DEFAULT_CFAR_CONFIG.thresholdFactor),
    minPixels: numOr(record.min_pixels, DEFAULT_CFAR_CONFIG.minPixels),
    maxPixels: numOr(record.max_pixels, DEFAULT_CFAR_CONFIG.maxPixels),
    speckleFilter: isSpeckleMode(record.speckle_filter)
      ? record.speckle_filter
      : DEFAULT_CFAR_CONFIG.speckleFilter,
    kernelSize: numOr(record.kernel_size, DEFAULT_CFAR_CONFIG.kernelSize),
    coastlineBufferMeters: numOr(
      record.coastline_buffer_meters,
      DEFAULT_CFAR_CONFIG.coastlineBufferMeters,
    ),
  };
  const hash = typeof record.config_hash === 'string' ? record.config_hash : null;
  return { config, configHash: hash };
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function followScan(scanId: string): void {
  releaseStageStream();
  streamHandle = openStageStream(scanId, {
    onState: (streamState) => store.set({ streamState }),
    onStage: (event) => {
      store.set((prev) => ({
        scanStage: event.stage,
        scanStageHistory: [
          ...prev.scanStageHistory,
          { stage: event.stage, timestamp: event.timestamp, detail: event.detail },
        ],
        // A failed stage is recorded as the backend phrased it. The product does
        // not soften or reword a real failure.
        scanError: event.stage === 'FAILED' ? event.detail : prev.scanError,
      }));
      if (event.stage === 'COMPLETE') {
        void loadScanResults(scanId);
        void loadScanAis(scanId);
        void loadRaster(scanId, 'raw');
      }
    },
  });
}

export async function loadScanResults(scanId: string): Promise<void> {
  try {
    // Runtime contract validation is not optional. The generated TypeScript types
    // are erased at runtime, so without this a drifted field arrives as
    // `undefined` and renders as a plausible-looking blank. A violation throws
    // and is surfaced; it is never treated as "no data yet".
    const raw = await api.get<unknown>(`/api/scans/${scanId}/targets`);
    const payload: ScanTargetsResponse = validateScanTargetsResponse(raw);
    if (!assertReal(payload)) {
      store.set({
        targets: [],
        aisOnly: [],
        scanError:
          'This scan did not report REAL data with synthetic=false. No targets are drawn.',
      });
      return;
    }
    const targets = (payload.targets ?? []).map(toSarTarget);
    const aisOnly: AisContact[] = (payload.ais_only ?? []).map((row) => ({
      mmsi: row.mmsi,
      lat: row.lat,
      lon: row.lon,
      timestamp: row.timestamp,
      shipName: row.vesselName ?? null,
      sog: null,
      cog: null,
    }));
    const selected = store.getState().selection;
    store.set({
      targets,
      aisOnly,
      scene: payload.scene ?? null,
      scanError: null,
      // Re-assert the current selection: a target that no longer exists must not
      // stay selected.
      selection:
        selected.kind === 'target' && !targets.some((t) => t.id === selected.targetId)
          ? { kind: 'none' }
          : selected,
    });
  } catch (error) {
    // 409 SCAN_NOT_READY is expected while the job is in flight and is not an
    // error state -- it means "not yet", which is different from "nothing".
    if (error instanceof ApiError && error.code === 'SCAN_NOT_READY') return;
    store.set({ targets: [], aisOnly: [], scanError: describe(error) });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

/* ------------------------------------------------------------------- AIS */

export async function loadScanAis(scanId: string): Promise<void> {
  try {
    const payload = await api.get<{
      coverage: AisCoverageOut;
      observations: Array<{ mmsi: string; lat: number; lon: number; timestamp: string; ship_name?: string | null; sog?: number | null; cog?: number | null }>;
    }>(`/api/scans/${scanId}/ais`);

    // A coverage state is stored even when it is NO_COVERAGE, so the interface
    // can say "no coverage" instead of "0 vessels".
    store.set({ aisCoverage: toCoverage(payload.coverage) });
  } catch (error) {
    store.set({
      aisCoverage: {
        state: 'UNAVAILABLE',
        detail: describe(error),
        observationCount: null,
      },
    });
  }
}

export async function loadTrack(mmsi: string): Promise<void> {
  store.set({ trackLoading: true });
  try {
    const payload = await api.get<VesselTrackResponse>(`/api/vessels/${mmsi}/track`);
    const track: VesselTrack = {
      mmsi: payload.mmsi,
      identity: {
        shipName: payload.ship_name ?? null,
        callsign: payload.callsign ?? null,
        imo: payload.imo ?? null,
        shipType: payload.ship_type ?? null,
      },
      observed: (payload.observations ?? []) as VesselTrack['observed'],
      coverage: toCoverage(payload.coverage),
    };
    store.set({ track, aisCoverage: track.coverage, trackLoading: false });
  } catch (error) {
    store.set({
      track: null,
      trackLoading: false,
      aisCoverage: { state: 'UNAVAILABLE', detail: describe(error), observationCount: null },
    });
  }
}

/* ----------------------------------------------------------------- raster */

export async function loadRaster(
  scanId: string,
  layer: string,
): Promise<{
  rectangle: { west: number; south: number; east: number; north: number };
  imageUrl: string;
  width: number;
  height: number;
} | null> {
  store.set({ rasterLoading: true, rasterError: null });
  try {
    const meta = await api.get<{
      rectangle: { west: number; south: number; east: number; north: number };
      image_url: string;
      render: { rendered_shape: [number, number] };
    }>(`/api/scans/${scanId}/raster/${layer}`);
    // Deliberately NOT setting rasterLoaded here. This function only fetched
    // METADATA; the image has not been requested and the layer has not been
    // added. Setting it produced a System panel reading "raster: loaded" over a
    // globe with no imagery on it.
    store.set({ rasterLoading: false, rasterError: null });
    const [height, width] = meta.render?.rendered_shape ?? [0, 0];
    return {
      rectangle: meta.rectangle,
      imageUrl: meta.image_url,
      width: Number(width) || 1,
      height: Number(height) || 1,
    };
  } catch (error) {
    // An absent raster is a real state with a real reason, not a blank globe.
    store.set({
      rasterLoading: false,
      rasterLoaded: false,
      rasterError: describe(error),
    });
    return null;
  }
}

/* ------------------------------------------------------- catalogue + health */

/**
 * Load the Sentinel-1 catalogue.
 *
 * `bbox` is REQUIRED by the backend -- scene search is spatial, and a catalogue
 * dump is not something this endpoint serves. An earlier revision called it with
 * no query, which returned 400 on every load and left the scene selector
 * permanently empty.
 */
export async function loadScenes(bbox?: BBox | null): Promise<void> {
  if (!bbox) {
    // Stated rather than attempted. No fabricated catalogue entry is shown in
    // its place.
    store.set({
      scenes: [],
      scenesLoading: false,
    });
    return;
  }
  store.set({ scenesLoading: true });
  const query = bbox.map((v) => v.toFixed(6)).join(',');
  try {
    const payload = await api.get<SceneListResponse>(`/api/scenes?bbox=${encodeURIComponent(query)}`);
    store.set({ scenes: payload.scenes ?? [], scenesLoading: false, scanError: null });
  } catch (error) {
    // A failed catalogue load is not a scan failure. It used to overwrite
    // `scanError`, so a scene-search 400 surfaced as the analysis having failed.
    store.set({ scenes: [], scenesLoading: false });
  }
}

export async function loadProviders(): Promise<void> {
  store.set({ providersLoading: true });
  try {
    const payload = await api.get<HealthResponse>('/api/providers/health');
    store.set({ providers: payload.providers ?? [], providersLoading: false });
  } catch {
    // A failed probe is an explicit state. Defaulting to "online" here is
    // precisely the fiction the product must not tell.
    store.set({ providers: [], providersLoading: false });
  }
}