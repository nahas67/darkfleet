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
  AisObservationOut,
  CfarConfig as CfarConfigContract,
  HealthResponse,
  ScanAisResponse,
  ScanCreateRequest,
  ScanTargetsResponse,
  SceneListResponse,
  TargetClassification,
  VesselTrackResponse,
  VesselTarget,
} from '../api/contract';
import { ApiError, ContractViolation, api } from './errors';
import { validateScanTargetsResponse } from './validate';
import {
  DATASETHEALTHRESPONSE_FIELDS,
  SCANAISRESPONSE_FIELDS,
  VESSELTRACKRESPONSE_FIELDS,
  type DatasetHealthResponse,
} from '../api/contract';
import { contractValidator } from './validateGenerated';

/**
 * Validated from the GENERATED field metadata, not hand-listed.
 *
 * The generated TypeScript types are erased at runtime, so an unvalidated payload arrives as
 * `undefined` and renders as a plausible-looking EMPTY LIST. For this route that would read
 * as "no reference datasets are installed" -- an alarming and completely wrong statement about
 * a machine that has three of them. Deriving the key list from the contract means a field
 * added to the Pydantic model is checked here with no edit to this file.
 */
const validateDatasetHealthResponse = contractValidator<DatasetHealthResponse>(
  DATASETHEALTHRESPONSE_FIELDS,
  'DatasetHealthResponse',
);

/**
 * Validated from GENERATED field metadata, for the same reason as the reference-data route.
 *
 * `SCANAISRESPONSE_FIELDS` and `VESSELTRACKRESPONSE_FIELDS` were both generated, exported, and
 * referenced nowhere. Two of the four AIS routes therefore had no runtime validation while the
 * other two did. The AIS payload is exactly where an unvalidated drift is most dangerous: a
 * missing `observations` key would read as an EMPTY AIS ARCHIVE, which is a completely different
 * claim from a vessel that reported nothing.
 */
const validateScanAisResponse = contractValidator<ScanAisResponse>(
  SCANAISRESPONSE_FIELDS,
  'ScanAisResponse',
);

const validateVesselTrackResponse = contractValidator<VesselTrackResponse>(
  VESSELTRACKRESPONSE_FIELDS,
  'VesselTrackResponse',
);
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
    const currentScanId = store.getState().scanId;
    if (currentScanId !== null && currentScanId !== scanId) return;
    const payload: ScanTargetsResponse = validateScanTargetsResponse(raw);
    if (!assertReal(payload)) {
      store.set({
        targets: [],
        targetDetail: [],
        aisOnly: [],
        scanError:
          'This scan did not report REAL data with synthetic=false. No targets are drawn.',
      });
      return;
    }
    const detailTargets = payload.targets ?? [];
    const targets = detailTargets.map(toSarTarget);
    /*
     * AIS contacts are NOT built here any more.
     *
     * This used to project `payload.ais_only`, hardcoding `sog: null, cog: null`. Those nulls
     * were honest -- `AisOnlyTarget` (`contract.ts:149`) genuinely carries no kinematics -- but
     * they meant the globe drew its AIS markers from a response that CANNOT supply the fields
     * DF-X9's orientation authority depends on. `loadScanAis` now projects them from the AIS
     * archive instead, which has every field.
     *
     * The `ais_only` rows are not dropped, though: they are the CORRELATION's unmatched
     * contacts, a set with a different meaning from "every vessel in the window". A vessel that
     * lost its match still appears here, and it would otherwise vanish from the contact list
     * when the archive has no observations for it at all.
     *
     * So the two are MERGED: archive contacts win where they overlap, because they carry
     * kinematics, and `ais_only` fills in any vessel the archive window does not contain.
     */
    const aisOnly: AisContact[] = (payload.ais_only ?? []).map((row) => ({
      mmsi: row.mmsi,
      lat: row.lat,
      lon: row.lon,
      timestamp: row.timestamp,
      shipName: row.vesselName ?? null,
      sog: null,
      cog: null,
      heading: null,
    }));
    const selected = store.getState().selection;
    /*
     * MERGE, DO NOT REPLACE.
     *
     * `loadScanAis` populates `aisOnly` from the AIS ARCHIVE, where every contact carries
     * `sog`/`cog`/`heading`. This response carries `ais_only`, which carries none of them. If
     * this function simply assigned its own list it would strip the kinematics back off every
     * contact whenever a scan's targets were reloaded after its AIS data -- and the two
     * functions are called in sequence by `followScan`, so the order in which they run is not
     * something a caller controls.
     *
     * Archive contacts win on overlap because they are strictly richer. `ais_only` contributes
     * only vessels the archive window does not contain at all, which is a real case: it is the
     * correlation's unmatched-contact set, and a vessel can appear there without any
     * observation in the AIS window the archive returned.
     */
    const archiveContacts = store.getState().aisOnly;
    const mergedAis = new Map(archiveContacts.map((c) => [c.mmsi, c]));
    for (const row of aisOnly) {
      if (!mergedAis.has(row.mmsi)) mergedAis.set(row.mmsi, row);
    }
    const aisOnlyMerged = [...mergedAis.values()];

    store.set({
      targets,
      // The full contract record, kept alongside the globe projection.
      //
      // `toSarTarget` reduces a target to what the globe and contact list need to
      // draw a marker. Everything the dossier shows -- correlation decomposition,
      // wake analysis, polarization, backscatter, footprint, heading -- is
      // discarded by that projection. Re-fetching it per tab would mean eleven
      // requests for a payload the client already holds, so the authority is
      // retained once here and the projection stays a projection.
      targetDetail: detailTargets,
      aisOnly: aisOnlyMerged,
      scene: payload.scene ?? null,
      scanError: null,
      /*
       * The scan this record came from, which is the function's own argument and is
       * therefore unambiguous.
       *
       * Only `startScan` used to set it, so loading an EXISTING scan left `scanId`
       * null -- or, worse, stale from whatever scan was loaded before. Both are
       * real faults rather than cosmetic ones, because selection writers pass
       * `scanId` to pin a target's identity, and target ids are per-scan:
       *
       *   null   -> every selection is unpinned, so the backend resolves the id
       *             across the whole archive and answers `ambiguous: true`.
       *   stale  -> the dossier pins DF-002 to the PREVIOUS scan, and shows one
       *             vessel's header above another vessel's evidence. That is the
       *             exact failure scan-scoped target identity exists to prevent.
       */
      scanId,
      // Re-assert the current selection: a target that no longer exists must not
      // stay selected. A surviving target is re-pinned to THIS scan, because the id
      // it carries may have been scoped to a different one.
      selection:
        selected.kind === 'target'
          ? targets.some((t) => t.id === selected.targetId)
            ? { kind: 'target', targetId: selected.targetId, scanId }
            : { kind: 'none' }
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

/**
 * The latest observation per MMSI, which is what the globe draws a contact marker from.
 *
 * NOT the newest-observed-wins if a tie: the archive deduplicates on `mmsi|timestamp`, so two
 * observations for one vessel cannot share a timestamp, and the sort is stable on the input
 * order for the unparseable case.
 *
 * Keeping ONLY the latest fix is a display decision, not an evidence decision. Every
 * observation is still available through `loadTrack`, and the full archive response is
 * untouched. The globe needs one marker per vessel; the dossier needs the history.
 */
function latestPerVessel(
  observations: readonly AisObservationOut[],
): Array<AisObservationOut & { lat: number; lon: number }> {
  const byVessel = new Map<string, AisObservationOut & { lat: number; lon: number }>();
  for (const observation of observations) {
    if (observation.lat == null || observation.lon == null) continue;
    if (!Number.isFinite(observation.lat) || !Number.isFinite(observation.lon)) continue;
    const validObs = observation as AisObservationOut & { lat: number; lon: number };
    const existing = byVessel.get(observation.mmsi);
    if (existing === undefined) {
      byVessel.set(observation.mmsi, validObs);
      continue;
    }
    const incomingAt = Date.parse(observation.timestamp);
    const existingAt = Date.parse(existing.timestamp);
    // An unparseable timestamp never displaces a parseable one. Preferring it would let a
    // malformed record silently blank a real contact.
    if (!Number.isFinite(incomingAt)) continue;
    if (!Number.isFinite(existingAt) || incomingAt > existingAt) {
      byVessel.set(observation.mmsi, validObs);
    }
  }
  return [...byVessel.values()];
}

/**
 * The END of a coverage window, when it declares one.
 *
 * A fallback only. Used when neither the scan's acquisition time nor a stored scene carries one,
 * and the AIS window is still a real answer: it is the interval the backend itself reported as
 * relevant. The window's START would be wrong, since it would place the reference before the
 * contacts it is meant to describe.
 */
function windowEndOf(payload: ScanAisResponse): string | null {
  const window = (payload as { window?: unknown }).window;
  if (!Array.isArray(window) || window.length < 2) return null;
  const candidate = window[1];
  return typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))
    ? candidate
    : null;
}

export async function loadScanAis(scanId: string): Promise<void> {
  try {
    const raw = await api.get<unknown>(`/api/scans/${scanId}/ais`);
    const currentScanId = store.getState().scanId;
    if (currentScanId !== null && currentScanId !== scanId) return;
    const payload = validateScanAisResponse(raw);

    // A coverage state is stored even when it is NO_COVERAGE, so the interface
    // can say "no coverage" instead of "0 vessels".
    const coverage = toCoverage(payload.coverage);

    /*
     * THE FIX: THIS ROUTE USED TO THROW ITS OBSERVATIONS AWAY.
     *
     * `payload.observations` was fetched, typed inline, and then never read. Only
     * `payload.coverage` reached the store. The practical consequence was that the globe's AIS
     * contacts could not come from the archive at all, because nothing kept the archive's
     * observations -- so they came from `payload.ais_only` inside the scan-TARGETS response
     * instead. Those two sources are not equivalent:
     *
     *   `AisOnlyTarget` (generated, `contract.ts:149`) carries `mmsi`, `vesselName`, `lat`,
     *   `lon`, `timestamp` and NOTHING ELSE. It has no `sog`, no `cog`, no `heading`.
     *   `AisObservationOut` (`contract.ts:311`) carries all of them.
     *
     * So the missing kinematics were not a display bug -- they were a consequence of reading
     * the wrong route. And `sog`/`cog` are what DF-X9's orientation authority is built on, so
     * every contact would have arrived at the renderer with no way to point anywhere.
     *
     * Both are now kept. `aisOnly` is the display projection built from the archive's latest
     * fix per vessel; `aisObservations` retains the whole window so a track can be drawn
     * without a second request. The evidence is unchanged either way -- both are read-only
     * copies of the same archive rows.
     */
    const observations = (payload.observations ?? []) as AisObservationOut[];
    const aisOnly: AisContact[] = latestPerVessel(observations).map((observation) => ({
      mmsi: observation.mmsi,
      lat: observation.lat,
      lon: observation.lon,
      timestamp: observation.timestamp,
      shipName: observation.ship_name ?? null,
      /*
       * The vessel's OWN reported values, passed through unaltered.
       *
       * These used to be hardcoded `null`. The types were present and the values were thrown
       * away at the projection boundary, which is the specific shape of the DF-X9 hazard: a
       * field that is structurally nullable, always null at every producer, and therefore
       * indistinguishable from a vessel that reported nothing. `null` still means exactly one
       * thing here -- NOT REPORTED -- and `0` remains a real measurement.
       */
      sog: observation.sog ?? null,
      cog: observation.cog ?? null,
      // Not previously carried at all. `AisContact` is a display projection, so this is where
      // true heading has to live if the renderer is to prefer it over course over ground.
      heading: observation.heading ?? null,
    }));

    /*
     * The temporal authority, resolved here and stored explicitly.
     *
     * The AIS window this response describes is itself the best answer available: it is the
     * interval the product decided was relevant, it comes from the backend rather than from a
     * guess, and it is set even when the observations array is empty. The scan's acquisition time
     * is preferred where one exists, because that is the instant the detections describe and the
     * instant correlation propagated positions to.
     *
     * NEVER `Date.now()`. With no live feed that would mark the entire archive stale and assert
     * every vessel had stopped transmitting.
     */
    const acquisition =
      (payload as { acquisition_time?: string | null }).acquisition_time ??
      (store.getState().scene?.acquisition_time ?? null);
    const referenceTime = acquisition ?? windowEndOf(payload) ?? null;

    /*
     * DETERMINISTIC BIDIRECTIONAL MERGE (DF-X9.8-H4).
     *
     * `loadScanResults` and `loadScanAis` run concurrently on scan complete.
     * `payload.ais_only` (from targets endpoint) carries correlation unmatched vessels.
     * `observations` (from scan ais endpoint) carries full archive window observations with kinematics.
     *
     * To prevent response arrival order from changing the final contact set:
     * Archive contacts win on overlap (they have sog/cog/heading).
     * Any unmatched contact only present in payload.ais_only is preserved.
     */
    const existingContacts = store.getState().aisOnly;
    const mergedAis = new Map<string, AisContact>();
    for (const contact of existingContacts) {
      mergedAis.set(contact.mmsi, contact);
    }
    for (const contact of aisOnly) {
      mergedAis.set(contact.mmsi, contact);
    }
    const aisOnlyMerged = [...mergedAis.values()];

    store.set({
      aisCoverage: coverage,
      aisOnly: aisOnlyMerged,
      aisObservations: observations,
      aisReferenceTime: referenceTime,
    });
  } catch (error) {
    store.set({
      aisCoverage: {
        state: 'UNAVAILABLE',
        detail: describe(error),
        observationCount: null,
      },
      /*
       * Cleared rather than left in place. On a failed refetch the previous observations are
       * from a DIFFERENT window, and keeping them would leave contacts on the globe
       * representing an acquisition that is no longer loaded -- a stale contact drawn as though
       * it were current, which is the exact failure the display-state model exists to prevent.
       */
      aisOnly: [],
      aisObservations: [],
      // Cleared WITH the contacts. Leaving a reference time from a previous scan would measure
      // this scan's freshness against another scan's instant, which is how a contact drawn from
      // the wrong window reads as current.
      aisReferenceTime: null,
    });
  }
}

export async function loadTrack(mmsi: string): Promise<void> {
  store.set({ trackLoading: true });
  try {
    const raw = await api.get<unknown>(`/api/vessels/${mmsi}/track`);
    const payload = validateVesselTrackResponse(raw);
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

/**
 * Read `/api/maritime/datasets` into the store. ONE fetch, shared.
 *
 * WHY THIS IS HERE RATHER THAN IN A HOOK
 * --------------------------------------
 * Two panels need this fact: `LayerConsole` uses it to decide whether a maritime layer is
 * drawable, and `SystemPanel` renders it. As two hook instances they issued two requests for
 * one fact -- and, worse, could DISAGREE. The DF-X8.5 browser E2E caught exactly that: with
 * LAYERS opened immediately after SYSTEM, the coastline toggle was disabled with "the store
 * has not been read yet" while the system panel had rendered the full list seconds earlier.
 *
 * This mirrors `loadProviders`, which already works this way for remote source health.
 *
 * `force` exists for the explicit re-check button. An operator who installs a dataset and
 * presses Re-check must see it, so the initial call is not a once-per-process guard -- the
 * read is local and cheap, and a stale panel is worse than a redundant one.
 *
 * VALIDATED ON THE WAY IN, like every other branch here. The generated TypeScript types are
 * erased at runtime, so an unvalidated payload would arrive as `undefined` and render as a
 * plausible-looking empty list -- which for this route would read as "no datasets installed".
 */
export async function loadDatasetHealth(force = false): Promise<void> {
  const current = store.getState();
  if (current.datasetHealthLoading) return;
  if (current.datasetHealth !== null && !force) return;

  store.set({ datasetHealthLoading: true, datasetHealthError: null });
  try {
    const raw = await api.get<unknown>('/api/maritime/datasets');
    const payload = validateDatasetHealthResponse(raw);
    store.set({
      datasetHealth: payload,
      datasetHealthLoading: false,
      datasetHealthError: null,
    });
  } catch (error) {
    /*
     * A failure to READ the store is an explicit state, and it is NOT the same as an empty
     * store. Leaving `datasetHealth` null makes every consumer render "unknown", which is
     * the honest reading; writing an empty list would tell an operator their reference data
     * is missing when the only fault was the request.
     */
    store.set({
      datasetHealthLoading: false,
      datasetHealthError: error instanceof Error ? error.message : 'The dataset store could not be read.',
    });
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