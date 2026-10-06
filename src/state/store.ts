/**
 * Domain state.
 *
 * Built around one idea the retired UI did not have: a single selected domain
 * object, referenced from every surface. Selection is bidirectional -- globe,
 * contact list, intelligence workspace and timeline all read and write
 * `selection`. Nothing owns a private copy, so there is nothing to fall out of
 * sync.
 *
 * The store is a small observable rather than a framework. React subscribes with
 * `useSyncExternalStore`; non-React consumers (the globe engine) subscribe
 * directly. That keeps the Cesium layer independent of the view tree, which is
 * what lets the globe run without being re-rendered by a panel update.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { sameTargetRef, targetRefOf } from '../intelligence/targetRef';

import {
  EMPTY_AIS_DIAGNOSTICS,
  type AisDiagnostics,
} from '../diagnostics/aisDiagnostics';

import type {
  AisCoverageState,
  AisObservationOut,
  ProviderHealthEntry,
  DatasetHealthResponse,
  ScanStage,
  ScanScene,
  SceneSummary,
  TargetClassification,
  VesselTarget,
} from '../api/contract';

/* ------------------------------------------------------------------ domain */

export type BBox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number];

/**
 * Validate an untrusted bbox into a BBox.
 *
 * The contract types `bbox` as `number[]`, which says nothing about its length or
 * ordering. Casting it straight to a BBox would let a two-element or inverted
 * array reach the camera, so the check lives here and every caller uses it.
 */
export function toBBox(value: readonly number[] | null | undefined): BBox | null {
  if (!value || value.length !== 4) return null;
  const [minLon, minLat, maxLon, maxLat] = value;
  const all = [minLon, minLat, maxLon, maxLat];
  if (!all.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [lo0, la0, lo1, la1] = all as [number, number, number, number];
  if (lo0 >= lo1 || la0 >= la1) return null;
  if (Math.abs(la0) > 90 || Math.abs(la1) > 90) return null;
  if (Math.abs(lo0) > 180 || Math.abs(lo1) > 180) return null;
  return [lo0, la0, lo1, la1];
}

export type SarTarget = {
  id: string;
  classification: TargetClassification | string;
  lat: number;
  lon: number;
  sarConf: number;
  aisConf: number;
  /** MMSI when the correlation associated one; null when it did not. */
  mmsi: string | null;
  distanceOffsetMeters: number | null;
  matchRadiusMeters: number | null;
  /** Geolocation uncertainty in metres, when the product supports a figure. */
  geolocationUncertaintyM: number | null;
  /**
   * GEO-CORR's sub-pixel centroid in the window raster, `[col, row]`.
   *
   * The analytical anchor: what makes this target mappable onto the raster it was
   * detected in. Null when the scan predates the field or the centroid was never
   * measured -- never (0, 0), which would place the target at the raster corner.
   */
  geoPixelCentroid: [number, number] | null;
  /** The pixel-centre offset that produced the coordinate. 0.5 = pixel centre. */
  geoCentreOffset: number | null;
  sceneItemId?: string | null;
};

/**
 * One vessel, projected for the globe.
 *
 * A PROJECTION, not evidence. Every field is a pass-through from an archive observation
 * (`AisObservationOut`); nothing here is derived, and nothing here is smoothed. The renderer
 * computes display state separately -- see `ais/displayState.ts` -- precisely so this type can
 * stay a faithful copy of what was observed.
 *
 * The three kinematics fields are nullable and `null` means ONE thing only: the vessel did not
 * report it. `0` is a real measurement in all three cases (course 0 is due north, speed 0 is at
 * anchor, heading 0 is north). `AisObservation` in the backend goes to explicit lengths to keep
 * those distinguishable, and this projection preserves the distinction rather than collapsing
 * it -- `AisTab` reads `heading` and `cog` in separate columns for exactly that reason.
 */
export type AisContact = {
  mmsi: string;
  lat: number;
  lon: number;
  timestamp: string;
  shipName: string | null;
  /** knots, or null when not reported */
  sog: number | null;
  /** degrees true, or null when not reported */
  cog: number | null;
  /**
   * degrees true, or null when not reported.
   *
   * Added by DF-X9. It was absent from this type entirely, so the renderer had no way to prefer
   * a vessel's own heading over its course over ground -- which is the distinction DF-X9 §12
   * requires, because they are not interchangeable.
   */
  heading: number | null;
};

/**
 * A vessel track, split into what was measured and what was inferred.
 *
 * The split is the point. A propagated position is arithmetic from a speed and a
 * course; drawing it with the same solid line as an observed fix would present a
 * hypothesis as a measurement.
 */
export type VesselTrack = {
  mmsi: string;
  identity: {
    shipName: string | null;
    callsign: string | null;
    imo: string | null;
    shipType: string | null;
  };
  /** Observed positions, in archive time order. */
  observed: AisObservationOut[];
  /** Coverage state of the source that answered. Never inferred. */
  coverage: {
    state: AisCoverageState | string;
    detail: string;
    observationCount: number | null;
  };
};

export type LayerGroup = 'SENSORS' | 'CONTACTS' | 'REFERENCE' | 'ANALYSIS';

/**
 * The layer id union is INFERRED from the registry, not restated here.
 *
 * It used to be a hand-written union here. That is a second declaration of the same
 * fact, and the reason nothing could detect drift: a layer added to the engine but
 * forgotten here compiled cleanly and simply never rendered. One declaration, in the
 * registry, which is also where the renderer name lives.
 */
import { defaultLayerState, type LayerId as RegistryLayerId } from '../globe/layerRegistry';

export type LayerId = RegistryLayerId;

/** Per-layer operator choices. Only what the operator chose lives here. */
export type LayerStateMap = Record<
  LayerId,
  { visible: boolean; opacity: number; unavailableReason?: string }
>;

export type LayerState = {
  id: LayerId;
  group: LayerGroup;
  label: string;
  visible: boolean;
  opacity: number;
  /** Why this layer cannot be shown, when it cannot. Never a silent false. */
  unavailableReason?: string;
};

export type ViewMode = 'GLOBAL' | 'THEATER' | 'TOP_DOWN' | 'OBLIQUE' | 'NORTH_UP';

export type Coverage = {
  state: AisCoverageState | string;
  detail: string;
  observationCount: number | null;
};

export type State = {
  /* --- selection: the single shared reference --- */
  selection:
    | { kind: 'none' }
    /**
     * A SAR target.
     *
     * `scanId` is part of the identity, not decoration. Target ids are assigned
     * per scan as `DF-{index+1:03d}`, so `DF-002` in one stored scan is a
     * completely different vessel from `DF-002` in another. Selecting on
     * `targetId` alone can therefore address two distinct targets, and a dossier
     * that fetched by id alone could render one vessel's header above another
     * vessel's evidence.
     *
     * Optional so that existing writers keep compiling, but every surface that
     * knows the owning scan should supply it, and `targetRefOf` is the only
     * sanctioned way to read the pair.
     */
    | { kind: 'target'; targetId: string; scanId?: string | null }
    | { kind: 'mmsi'; mmsi: string }
    | { kind: 'scene'; sceneId: string };

  /* --- spatial --- */
  aoi: BBox | null;
  /**
   * The AOI as typed.
   *
   * Held in the store rather than component state because `ScanWorkflow`
   * mounts at two different positions in the tree (TACTICAL and TASKING), so
   * local state was destroyed on every workspace switch and the operator lost
   * the area they had typed -- along with the scene list resolved for it.
   */
  aoiText: string;
  savedAois: Array<{ name: string; bbox: BBox }>;
  cursor: { lat: number; lon: number } | null;
  viewMode: ViewMode;
  /**
   * AIS camera-follow mode. DEFERRED TO DF-X9.6, AND NO CONTROL SETS IT.
   *
   * This field previously existed as `followingMmsi` and was written from two places --
   * `select()` set it on every AIS selection, and the `H` key cleared it -- while NO code ever
   * READ it. The camera did not follow anything.
   *
   * Two ways to remove a dead write were available: wire it fully, or make the absence visible.
   * Full follow needs chase and oblique camera modes, manual-release semantics and a temporal
   * tick driving it, which is DF-X9.6's whole scope and explicitly deferred from DF-X9.3. So the
   * field is RENAMED to describe what it now is -- a declared intent with no consumer -- and both
   * writes are removed rather than left doing nothing.
   *
   * A rename is chosen over deletion because a future implementer needs somewhere to land, and a
   * comment saying "there is no control for this" is discoverable in a way that an absent field is
   * not. No UI element writes it: there is no shipped operator control that appears to do
   * something and does nothing, which is what DF-X9.3 section 66 forbids.
   */
  aisFollowMode: 'OFF' | 'CENTER' | 'FOLLOW' | 'CHASE';
  /** Camera altitude in metres, metres; null until the camera reports one. */
  cameraAltitude: number | null;

  /* --- scan --- */
  scanId: string | null;
  scanStage: ScanStage | string;
  scanStageHistory: Array<{ stage: string; timestamp: string; detail: string }>;
  streamState: 'IDLE' | 'CONNECTING' | 'STREAMING' | 'CLOSED' | 'ERROR';
  scanError: string | null;

  /* --- results --- */
  targets: SarTarget[];
  /**
   * The full contract record for each detected target.
   *
   * `targets` is a deliberate REDUCTION -- what the globe and the contact list need
   * in order to draw a marker. The dossier needs everything that reduction drops:
   * correlation decomposition, wake analysis, polarization evidence, backscatter,
   * footprint and heading. Both are populated from the same validated response, so
   * the reduced form can never disagree with the authority it was derived from.
   *
   * Kept rather than re-fetched per tab: eleven tabs each asking the server for a
   * payload the client already holds is eleven avoidable round trips and eleven
   * chances to render two different answers.
   */
  targetDetail: VesselTarget[];
  /**
   * One marker per vessel, projected from `aisObservations`.
   *
   * Populated by `loadScanAis` from the AIS ARCHIVE, not from `payload.ais_only` in the scan
   * targets response. Those are different sources with different fields: `AisOnlyTarget` has no
   * `sog`, `cog` or `heading` at all, which is why every contact used to arrive with no
   * kinematics to orient it by.
   */
  aisOnly: AisContact[];
  /**
   * Every observation in the scan's AIS window, verbatim.
   *
   * Added by DF-X9 so a track can be drawn and a contact oriented without a second request.
   * This is a read-only copy of what the archive already holds -- no field is computed, rounded
   * or smoothed on the way in. `aisOnly` is derived from it; it is never the other way round.
   */
  aisObservations: AisObservationOut[];
  scene: ScanScene | null;
  rasterLoaded: boolean;
  rasterLoading: boolean;
  rasterError: string | null;

  /* --- AIS --- */
  track: VesselTrack | null;
  trackLoading: boolean;
  aisCoverage: Coverage | null;
  /**
   * The EXPLICIT instant the product is analysing, as an ISO string.
   *
   * This is the temporal authority for every freshness and interpolation decision, and it is
   * deliberately NOT a wall clock. The deployment has no live AIS feed -- `/api/scans/{id}/events`
   * carries scan-stage lifecycle only, and `GET /api/ais/coverage` reports `NOT_CONFIGURED` -- so
   * measuring freshness against `Date.now()` would mark every archived contact stale and assert that
   * every vessel stopped transmitting. That is a confident false claim about a machine that has
   * never claimed live tracking.
   *
   * RESOLUTION, exactly as `loadScanAis` implements it:
   *
   *   1. the scan's acquisition time, from the AIS response or the loaded scene
   *   2. the END of the AIS window the response itself declares
   *   3. null
   *
   * There is NO operator-chosen timeline position. An earlier version of this comment claimed one
   * existed; it does not, and adding a timeline cursor is DF-X9.4's temporal-playback work.
   *
   * The window END rather than its START: the start would place the reference before the contacts it
   * is meant to describe, making every one of them read as from the future.
   *
   * A null reference time means freshness is UNKNOWN rather than CURRENT, because a contact cannot
   * be shown to be current against an instant nobody has established.
   */
  aisReferenceTime: string | null;
  /**
   * AIS renderer diagnostics, AS DRAWN.
   *
   * Not a debugging aid. These are the counts and gap records the operator's questions are actually
   * answered by -- "how many gaps, which vessel, how long", and "is this contact really drawn" -- and
   * they come from the RENDERER rather than being re-derived in a component.
   *
   * That distinction is the point. The playback bar previously computed its own gap count from the
   * archive, so the number on screen and the geometry on the globe were two answers to one question
   * computed twice. They could disagree, and nothing would have said so. Reading the renderer's record
   * makes a disagreement impossible rather than merely unlikely.
   *
   * `aisRenderFailureReason` was DEAD from DF-X9.3 until now: written by the engine, read by nothing.
   * This field is what closes that, and `diagnostics/aisDiagnostics.ts` registers it with a named
   * consumer so the next instance is caught before the browser run rather than during it.
   */
  aisDiagnostics: AisDiagnostics;
  /**
   * The observation the operator has singled out, or null.
   *
   * STABLE IDENTITY: MMSI plus the observation's own timestamp, never a row index. An index would
   * point at a different observation the moment the archive were read in a different order, which is
   * the failure mode DF-X9.4H section 23 names.
   *
   * Set by selecting an AIS event on the mission timeline. Distinct from `selection`, which names a
   * VESSEL: selecting a vessel says which ship is under examination, and this says which of its
   * recorded fixes is being looked at. They are separate because they are separate questions, and
   * collapsing them would make selecting a vessel appear to single out one observation arbitrarily.
   */
  highlightedObservation: { mmsi: string; at: string } | null;

  /* --- catalogue --- */
  scenes: SceneSummary[];
  scenesLoading: boolean;

  /* --- system --- */
  providers: ProviderHealthEntry[];
  providersLoading: boolean;
  /**
   * Local reference-dataset state, read from `/api/maritime/datasets`.
   *
   * IN THE STORE, NOT IN A HOOK, because two panels need it. `LayerConsole` reads it to
   * decide whether a maritime layer is drawable, and `SystemPanel` renders it. As two
   * independent hook instances they issued two requests for one fact -- and could disagree,
   * which the DF-X8.5 browser E2E caught: the layer console showed "the store has not been
   * read yet" while the system panel had rendered the whole list seconds earlier. An operator
   * seeing both would conclude the console was broken.
   *
   * `null` means not yet read, and every consumer treats it as "unknown", never as "absent".
   * That distinction is the same one the API itself makes.
   */
  datasetHealth: DatasetHealthResponse | null;
  datasetHealthLoading: boolean;
  /**
   * Why each MARITIME layer declined to draw, keyed by layer id. Empty string means no
   * recorded problem.
   *
   * PRESENT BECAUSE A SILENT REFUSAL IS A DEFECT. The EEZ layer's toggle read
   * `aria-pressed="true"`, the console showed it enabled, and the globe drew nothing -- no
   * error, no reason anywhere. An operator's only available conclusion was that the product
   * was broken.
   *
   * A layer can have a real renderer, the fetch can succeed, and the render can still be
   * DECLINED because the served provenance does not match what the registry declares. Every
   * one of those outcomes used to be invisible.
   */
  maritimeLayerRefusals: Record<string, string>;
  /**
   * Why the dataset-health read failed, or null.
   *
   * A failure to READ the store is not the same as an empty store, and conflating them would
   * tell an operator their reference data is missing when the only fault was the request.
   */
  datasetHealthError: string | null;

  /* --- presentation --- */
  /**
   * Layer visibility and opacity, keyed by registry id.
   *
   * The single layer-state authority (DF-X8 §9). A map rather than the previous array
   * of `{id, group, label, visible, opacity}` because that array carried `label` and
   * `group` as DATA -- properties of the registry -- so every consumer trusted a
   * second copy of them and nothing detected the two disagreeing. Here the map holds
   * only what the operator chose; label, category and renderer are looked up.
   *
   * Initialised from the registry rather than `[]`, so every declared layer has an
   * entry before anything toggles it. A missing key then means "never initialised",
   * which is a bug, rather than silently defaulting.
   */
  layerState: LayerStateMap;
  workspace: string;
};

/* ------------------------------------------------------------------ store */

const initialState: State = {
  selection: { kind: 'none' },
  aoi: null,
  aoiText: '',
  savedAois: [],
  cursor: null,
  viewMode: 'OBLIQUE',
  aisFollowMode: 'OFF',
  cameraAltitude: null,

  scanId: null,
  scanStage: 'QUEUED',
  scanStageHistory: [],
  streamState: 'IDLE',
  scanError: null,

  targets: [],
  targetDetail: [],
  aisOnly: [],
  aisObservations: [],
  scene: null,
  rasterLoaded: false,
  rasterLoading: false,
  rasterError: null,

  track: null,
  trackLoading: false,
  aisCoverage: null,
  aisReferenceTime: null,
  aisDiagnostics: EMPTY_AIS_DIAGNOSTICS,
  highlightedObservation: null,

  scenes: [],
  scenesLoading: false,

  providers: [],
  providersLoading: false,
  datasetHealth: null,
  datasetHealthLoading: false,
  maritimeLayerRefusals: {},
  datasetHealthError: null,

  layerState: defaultLayerState(),
  workspace: 'TACTICAL',
};

type Listener = () => void;

/**
 * One-level structural equality.
 *
 * Deep comparison would be wrong here -- it would walk large arrays like
 * `targets` on every write. One level is enough because every patch value in this
 * store is a primitive, a flat tuple, or a small flat record.
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    Object.is(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

class Store {
  #state: State = initialState;
  #listeners = new Set<Listener>();

  getState = (): State => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Apply a partial update.
   *
   * A no-op update does not notify. This matters because cursor telemetry is
   * written at frame rate: `set({ cursor: { lat, lon } })` allocates a new
   * object every time, so an identity comparison alone would notify on every
   * frame and re-render the whole tree continuously. Object-valued patches are
   * therefore compared one level deep.
   */
  set = (patch: Partial<State> | ((prev: State) => Partial<State>)): void => {
    const next = typeof patch === 'function' ? patch(this.#state) : patch;
    let changed = false;
    for (const key of Object.keys(next) as Array<keyof State>) {
      if (!shallowEqual(this.#state[key], next[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  };

  /**
   * Select a domain object. The one place selection changes.
   *
   * Every surface routes through here, which is what makes selection
   * bidirectional: selecting in the contact list and selecting on the globe are
   * the same transition.
   */
  select = (selection: State['selection']): void => {
    const current = this.#state.selection;
    if (current.kind === selection.kind) {
      // Compare the identity payload of both sides rather than reaching for one
      // variant's fields, which the compiler cannot narrow from kind alone.
      if (Object.is(current, selection)) return;
      // Target identity is the PAIR. Comparing targetId alone made selecting
      // `DF-002` in a second scan a silent no-op, so the dossier kept rendering
      // the first scan's vessel under a header the operator had just changed.
      if ('targetId' in current && 'targetId' in selection) {
        if (sameTargetRef(targetRefOf(current), targetRefOf(selection))) return;
      }
      if ('mmsi' in current && 'mmsi' in selection && current.mmsi === selection.mmsi) return;
      if ('sceneId' in current && 'sceneId' in selection && current.sceneId === selection.sceneId) return;
      if (current.kind === 'none') return;
    }
    /*
     * Selecting a contact does NOT move the camera, and selection must not imply follow.
     *
     * This used to write `followingMmsi` here, on the reasoning that selecting a vessel should
     * start following it. Nothing ever read it, so selecting a contact appeared to arm a follow
     * mode that did not exist -- an operator-visible implication with no behaviour behind it.
     * Camera follow is DF-X9.6, and it will be driven by an explicit operator control rather than
     * as a side effect of selecting something.
     */
    this.set({ selection });
  };
}

export const store = new Store();

/** Subscribe a component to the whole store. */
export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * Subscribe to a derived slice.
 *
 * `selector` must return a stable value for unchanged input -- an object literal
 * would re-render on every store change, so callers deriving objects must memoise
 * or select primitives.
 */
export function useStoreSelector<T>(selector: (state: State) => T): T {
  const getSnapshot = useCallback(() => selector(store.getState()), [selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Test seam. Resets to the initial state without recreating the store identity. */
export function resetStore(): void {
  store.set(initialState);
}