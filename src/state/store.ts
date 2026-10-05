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

export type AisContact = {
  mmsi: string;
  lat: number;
  lon: number;
  timestamp: string;
  shipName: string | null;
  sog: number | null;
  cog: number | null;
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
  /** A target the camera should keep on, or null for free navigation. */
  followingMmsi: string | null;
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
  aisOnly: AisContact[];
  scene: ScanScene | null;
  rasterLoaded: boolean;
  rasterLoading: boolean;
  rasterError: string | null;

  /* --- AIS --- */
  track: VesselTrack | null;
  trackLoading: boolean;
  aisCoverage: Coverage | null;

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
  followingMmsi: null,
  cameraAltitude: null,

  scanId: null,
  scanStage: 'QUEUED',
  scanStageHistory: [],
  streamState: 'IDLE',
  scanError: null,

  targets: [],
  targetDetail: [],
  aisOnly: [],
  scene: null,
  rasterLoaded: false,
  rasterLoading: false,
  rasterError: null,

  track: null,
  trackLoading: false,
  aisCoverage: null,

  scenes: [],
  scenesLoading: false,

  providers: [],
  providersLoading: false,
  datasetHealth: null,
  datasetHealthLoading: false,
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
    this.set({ selection, followingMmsi: selection.kind === 'mmsi' ? selection.mmsi : null });
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