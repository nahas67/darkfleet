/**
 * DarkFleet shared application store for the vNext spatial shell.
 *
 * Everything in this module is pure or a synchronous store: reducers, selectors
 * and the event-handler factories the shell binds. That keeps the shell's
 * behaviour testable without a DOM and keeps the render layer declarative.
 *
 * Rules encoded here (UI-011, UI-021, UI-029/030, API-011):
 *  - There is NO runtime mode. The synthetic runtime was removed from the
 *    product, so the store holds nothing to switch and no surface offers a
 *    choice: every scan is a real query against a live provider.
 *  - NOT_AVAILABLE layers can never be made visible or emitted; reducers are
 *    a no-op for them so no surface can fabricate an advanced layer.
 *  - No analytics are computed here. Counters shown by the shell are passed
 *    through verbatim from the Python backend.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import { LAYER_DEFS } from '../globe/registry.ts';
import type {
  CapabilityState,
  LayerConfig,
  LayerId,
  ProviderHealthEntry,
  ProvidersHealth,
  ProviderState,
  ScanResult,
} from '../types/api.ts';

/** Every floating contextual surface the shell can open. */
export type SurfaceId =
  | 'SEARCH'
  | 'LAYERS'
  | 'SAR'
  | 'AIS'
  | 'CORRELATE'
  | 'ANALYTICS'
  | 'MORE'
  | 'SCAN'
  | 'TIME'
  | 'VIEW';

export type NavItem = {
  readonly id: SurfaceId;
  /** Unique accessible name. Icon-only controls rely on this. */
  readonly label: string;
  readonly hint: string;
};

/** Left icon rail, in render order. */
export const RAIL_ITEMS: readonly NavItem[] = [
  { id: 'SEARCH', label: 'Spatial search', hint: 'Search candidate SAR scenes' },
  { id: 'LAYERS', label: 'Display layers', hint: 'Toggle globe layers' },
  { id: 'SAR', label: 'SAR imagery', hint: 'Active SAR scene and providers' },
  { id: 'AIS', label: 'AIS contacts', hint: 'AIS source status and counts' },
  { id: 'CORRELATE', label: 'Correlate', hint: 'Backend correlation summary' },
  { id: 'ANALYTICS', label: 'Analytics', hint: 'Backend counters and provenance' },
  { id: 'MORE', label: 'More tools', hint: 'Exports, settings and provenance' },
] as const;

/** Bottom-centre floating command dock, in render order. */
export const DOCK_ITEMS: readonly NavItem[] = [
  { id: 'SEARCH', label: 'Command: search scenes', hint: 'Search candidate SAR scenes' },
  { id: 'SCAN', label: 'Command: run scan', hint: 'Create a backend scan job' },
  { id: 'TIME', label: 'Command: timeline', hint: 'Temporal playback' },
  { id: 'LAYERS', label: 'Command: display layers', hint: 'Toggle globe layers' },
  { id: 'VIEW', label: 'Command: camera view', hint: 'Camera presets' },
] as const;

/** Human title used by the floating surface header and its aria-label. */
export const SURFACE_TITLES: Readonly<Record<SurfaceId, string>> = {
  SEARCH: 'Spatial search',
  LAYERS: 'Layers',
  SAR: 'SAR',
  AIS: 'AIS',
  CORRELATE: 'Correlate',
  ANALYTICS: 'Analytics',
  MORE: 'More',
  SCAN: 'Scan',
  TIME: 'Timeline',
  VIEW: 'View',
};

/** Layer groups in the exact order the Layers surface renders them. */
export const LAYER_GROUP_ORDER = [
  'IMAGERY',
  'CONTACTS',
  'ANALYSIS',
  'REFERENCE',
  'INTELLIGENCE',
] as const;

export type LayerGroupId = (typeof LAYER_GROUP_ORDER)[number];

/**
 * Advanced layers declared by the registry WITHOUT a data source. The backend
 * serves none of them, so they stay `NOT_AVAILABLE` and are surfaced as an
 * explicit disabled list. The gate is the missing source, not a pending
 * milestone — they are never fabricated.
 */
export const ADVANCED_LAYER_IDS: readonly LayerId[] = [
  'MULTIPASS_TRACKS',
  'WAKE_GEOMETRY',
  'ML_OUTPUT',
  'TEMPORAL_ANOMALIES',
] as const;

export interface LayerState {
  readonly id: LayerId;
  readonly title: string;
  readonly group: LayerGroupId;
  readonly visible: boolean;
  readonly opacity: number;
  readonly source: string;
  readonly capabilityState: CapabilityState;
  readonly supportsOpacity: boolean;
}

export interface AppState {
  /** At most one floating surface is open at a time. */
  readonly openSurface: SurfaceId | null;
  readonly layers: Readonly<Record<LayerId, LayerState>>;
  readonly selectedTargetId: string | null;
  readonly activeScanId: string | null;
  /**
   * The completed scan whose detections belong on the globe.
   *
   * Held in the store rather than in the shell so the globe bridge can subscribe
   * to it. That keeps Cesium out of `SpatialShell`, which is the rule the shell's
   * own header states: the shell owns layout and state, the globe owns drawing.
   *
   * Null means nothing has been scanned yet, or the scan was cleared — the
   * bridge treats it as "draw nothing", never as "keep the last scan up".
   */
  readonly scanResult: ScanResult | null;
  readonly providers: ProvidersHealth | null;
  readonly providersCheckedAt: string | null;
  readonly providersError: string | null;
}

export function initialLayerStates(): Record<LayerId, LayerState> {
  const out = {} as Record<LayerId, LayerState>;
  for (const def of LAYER_DEFS) {
    out[def.id] = {
      id: def.id,
      title: def.title,
      group: def.group,
      visible: def.visible,
      opacity: def.opacity,
      source: def.source,
      capabilityState: def.capabilityState,
      supportsOpacity: def.supportsOpacity,
    };
  }
  return out;
}

export function initialState(overrides: Partial<AppState> = {}): AppState {
  return {
    openSurface: null,
    layers: initialLayerStates(),
    selectedTargetId: null,
    activeScanId: null,
    scanResult: null,
    providers: null,
    providersCheckedAt: null,
    providersError: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------ reducers
// Every reducer returns the SAME object when nothing changes, so a store that
// compares by identity never notifies subscribers for a no-op.

export function withOpenSurface(state: AppState, id: SurfaceId | null): AppState {
  return state.openSurface === id ? state : { ...state, openSurface: id };
}

/** Selecting the already-open rail entry closes its surface. */
export function withToggledSurface(state: AppState, id: SurfaceId): AppState {
  return withOpenSurface(state, state.openSurface === id ? null : id);
}

export function withClosedSurface(state: AppState): AppState {
  return withOpenSurface(state, null);
}

/**
 * Escape closes the open surface. Returns the identical state object for any
 * other key so the shell can skip work.
 */
export function withSurfaceKey(state: AppState, key: string): AppState {
  if (key !== 'Escape') return state;
  return withClosedSurface(state);
}

/** Capability gate: a NOT_AVAILABLE layer can never change state. */
export function isLayerAvailable(state: AppState, id: LayerId): boolean {
  return state.layers[id]?.capabilityState === 'AVAILABLE';
}

export function withLayerVisible(
  state: AppState,
  id: LayerId,
  visible: boolean,
): AppState {
  const layer = state.layers[id];
  if (!layer || layer.capabilityState !== 'AVAILABLE') return state;
  if (layer.visible === visible) return state;
  return { ...state, layers: { ...state.layers, [id]: { ...layer, visible } } };
}

export function withLayerOpacity(state: AppState, id: LayerId, opacity: number): AppState {
  const layer = state.layers[id];
  if (!layer || layer.capabilityState !== 'AVAILABLE' || !layer.supportsOpacity) {
    return state;
  }
  const clamped = Math.max(0, Math.min(1, opacity));
  if (layer.opacity === clamped) return state;
  return { ...state, layers: { ...state.layers, [id]: { ...layer, opacity: clamped } } };
}

export function withToggledLayer(state: AppState, id: LayerId): AppState {
  const layer = state.layers[id];
  if (!layer || layer.capabilityState !== 'AVAILABLE') return state;
  return withLayerVisible(state, id, !layer.visible);
}

export function withSelectedTarget(state: AppState, id: string | null): AppState {
  return state.selectedTargetId === id ? state : { ...state, selectedTargetId: id };
}

export function withActiveScan(state: AppState, id: string | null): AppState {
  return state.activeScanId === id ? state : { ...state, activeScanId: id };
}

/**
 * Record the scan whose detections belong on the globe.
 *
 * Switching scans clears the globe. `withActiveScan` deliberately does NOT do
 * this: the AOI and the detections are separate facts, and a caller that changes
 * the active scan without loading its result should get an empty globe rather
 * than the previous scan's marks sitting over a different AOI.
 */
export function withScanResult(state: AppState, result: ScanResult | null): AppState {
  if (state.scanResult === result) return state;
  return { ...state, scanResult: result };
}

export function withProviders(
  state: AppState,
  providers: ProvidersHealth | null,
  checkedAt: string | null,
  error: string | null,
): AppState {
  return { ...state, providers, providersCheckedAt: checkedAt, providersError: error };
}

// ----------------------------------------------------------------- selectors

export function isLayerEnabled(state: AppState, id: LayerId): boolean {
  const layer = state.layers[id];
  return Boolean(layer && layer.capabilityState === 'AVAILABLE' && layer.visible);
}

/** Layer ids the globe may render: available AND visible. Never advanced. */
export function visibleLayerIds(state: AppState): LayerId[] {
  return LAYER_DEFS.filter((def) => isLayerEnabled(state, def.id)).map((def) => def.id);
}

export function availableLayerConfigs(state: AppState): LayerConfig[] {
  return LAYER_DEFS.filter((def) => state.layers[def.id]?.capabilityState === 'AVAILABLE');
}

export interface LayerGroup {
  readonly group: LayerGroupId;
  readonly items: LayerState[];
}

export function visibleLayerGroups(state: AppState): LayerGroup[] {
  return LAYER_GROUP_ORDER.map((group) => ({
    group,
    items: availableLayerConfigs(state)
      .filter((def) => def.group === group)
      .map((def) => state.layers[def.id]),
  })).filter((entry) => entry.items.length > 0);
}

/** Declared-but-gated layers, rendered as an explicit "not available" list. */
export function unavailableLayers(state: AppState): LayerState[] {
  return ADVANCED_LAYER_IDS.map((id) => state.layers[id]).filter(
    (layer): layer is LayerState => Boolean(layer) && layer.capabilityState !== 'AVAILABLE',
  );
}

// ------------------------------------------------------- provider summarising

/**
 * Severity ranking, best -> worst. A bucket reports its worst member so a
 * single failing provider is never hidden behind a healthy sibling.
 */
const PROVIDER_SEVERITY: readonly ProviderState[] = [
  'AVAILABLE',
  'DEGRADED',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'NO_COVERAGE',
  'UNAVAILABLE',
  'NOT_CONFIGURED',
];

export interface ProviderSummary {
  readonly state: ProviderState;
  readonly label: string;
  readonly detail: string;
  readonly checked: boolean;
}

export const PROVIDER_UNKNOWN: ProviderSummary = {
  state: 'NOT_CONFIGURED',
  label: 'Unknown',
  detail: 'No live provider probe has completed yet.',
  checked: false,
};

export function summarizeProviders(
  entries: readonly ProviderHealthEntry[] | undefined,
): ProviderSummary {
  if (!entries || entries.length === 0) return PROVIDER_UNKNOWN;
  let worst = entries[0];
  for (const entry of entries) {
    if (PROVIDER_SEVERITY.indexOf(entry.status) > PROVIDER_SEVERITY.indexOf(worst.status)) {
      worst = entry;
    }
  }
  return {
    state: worst.status,
    label: providerLabel(worst.status),
    detail: entries.map((e) => `${e.provider}: ${e.message}`).join(' | '),
    checked: true,
  };
}

export function providerLabel(status: ProviderState): string {
  switch (status) {
    case 'AVAILABLE':
      return 'Online';
    case 'DEGRADED':
      return 'Degraded';
    case 'AUTH_REQUIRED':
      return 'Auth required';
    case 'RATE_LIMITED':
      return 'Rate limited';
    case 'NO_COVERAGE':
      return 'No coverage';
    case 'UNAVAILABLE':
      return 'Unavailable';
    case 'NOT_CONFIGURED':
      return 'Not configured';
    default:
      return 'Unknown';
  }
}

export function providerTone(status: ProviderState): 'ok' | 'warn' | 'bad' | 'idle' {
  switch (status) {
    case 'AVAILABLE':
      return 'ok';
    case 'DEGRADED':
    case 'RATE_LIMITED':
    case 'AUTH_REQUIRED':
    case 'NO_COVERAGE':
      return 'warn';
    case 'UNAVAILABLE':
      return 'bad';
    default:
      return 'idle';
  }
}

// -------------------------------------------------------------------- store

export interface AppStore {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  openSurface(id: SurfaceId): void;
  toggleSurface(id: SurfaceId): void;
  closeSurface(): void;
  handleKey(key: string): void;
  setLayerVisible(id: LayerId, visible: boolean): void;
  setLayerOpacity(id: LayerId, opacity: number): void;
  toggleLayer(id: LayerId): void;
  selectTarget(id: string | null): void;
  setActiveScanId(id: string | null): void;
  /** Push a completed scan onto the globe. `null` clears it. */
  setScanResult(result: ScanResult | null): void;
  setProviders(providers: ProvidersHealth | null, checkedAt: string | null, error: string | null): void;
}

export function createStore(overrides: Partial<AppState> = {}): AppStore {
  let state = initialState(overrides);
  const listeners = new Set<() => void>();

  const set = (next: AppState): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const getState = (): AppState => state;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getState,
    subscribe,
    openSurface: (id) => set(withOpenSurface(state, id)),
    toggleSurface: (id) => set(withToggledSurface(state, id)),
    closeSurface: () => set(withClosedSurface(state)),
    handleKey: (key) => set(withSurfaceKey(state, key)),
    setLayerVisible: (id, visible) => set(withLayerVisible(state, id, visible)),
    setLayerOpacity: (id, opacity) => set(withLayerOpacity(state, id, opacity)),
    toggleLayer: (id) => set(withToggledLayer(state, id)),
    selectTarget: (id) => set(withSelectedTarget(state, id)),
    setActiveScanId: (id) => set(withActiveScan(state, id)),
    setScanResult: (result) => set(withScanResult(state, result)),
    setProviders: (providers, checkedAt, error) =>
      set(withProviders(state, providers, checkedAt, error)),
  };
}

/** Process-wide store used by the shell unless a test injects its own. */
export const appStore: AppStore = createStore();

/**
 * Subscribe to a store. `getState` is stable per store, so the snapshot is
 * referentially equal between notifications and never loops.
 */
export function useStoreState(store: AppStore): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

// ----------------------------------------------------- bound handler factories
// Exported so the exact functions bound to DOM listeners are unit testable.

export function makeSurfaceHandler(store: AppStore, id: SurfaceId): () => void {
  return () => store.toggleSurface(id);
}

export function makeCloseHandler(store: AppStore): () => void {
  return () => store.closeSurface();
}

/** Escape closes the open surface; every other key is ignored here. */
export function shellKeyHandler(store: AppStore): (event: { key: string }) => void {
  return (event) => {
    if (event.key === 'Escape') store.closeSurface();
  };
}

export function makeLayerVisibilityHandler(
  store: AppStore,
  id: LayerId,
): (visible: boolean) => void {
  return (visible) => store.setLayerVisible(id, visible);
}

export function makeLayerOpacityHandler(store: AppStore, id: LayerId): (value: string) => void {
  return (value) => {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) store.setLayerOpacity(id, parsed);
  };
}

// -------------------------------------------------------------------- format

const pad = (n: number): string => String(n).padStart(2, '0');

/** `HH:MM:SSZ` from a millisecond timestamp. Locale independent. */
export function formatUtc(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** `YYYY-MM-DD HH:MM:SSZ` from an ISO string. Falls back to the raw string. */
export function formatUtcStamp(iso: string | null): string {
  if (!iso) return '--';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}