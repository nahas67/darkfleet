/**
 * Layer console.
 *
 * NOW DRIVEN BY THE REGISTRY, NOT BY A LOCAL LIST.
 *
 * This component previously held its own `DEFINITIONS` array of eleven layers, its
 * own `LayerGroup` enum, and derived `visible` from data availability on every
 * render. The result was three defects:
 *
 *   1. `visible` was RECOMPUTED, so a toggle wrote to the store and snapped back. Ten
 *      of eleven controls did nothing while looking operational.
 *   2. Labels, groups and the id union existed here AND in the engine AND in the
 *      store. Nothing compared them, so they drifted silently.
 *   3. Only GRATICULE reached the engine, via a hardcoded `if`.
 *
 * Now: the registry declares every layer's label, category and renderer; the store
 * holds only the operator's choices; `engine.setLayerVisibility` is the sole path to
 * Cesium. There is no group enum here and no `if (id === ...)` special case.
 *
 * Availability is still DERIVED rather than stored, because a stored capability flag
 * drifts out of step with the data and ends up offering an empty layer. But a derived
 * unavailability is now only a reason to DISABLE the control -- it no longer
 * overrides the operator's choice, which is what made toggles non-sticky.
 */

import { useStore, store, type LayerId } from '../state/store';
import {
  asDefinition,
  listLayers,
  type LayerCategory,
  type LayerEntry,
} from '../globe/layerRegistry';
import { groupColor } from '../design/tokens';
import { useDatasetHealth } from '../maritime/datasetHealth';
import type { DatasetHealthResponse } from '../api/contract';

/**
 * What a layer needs before it has anything to draw.
 *
 * Derived from real state at render time. A layer whose backing data is absent is
 * DISABLED WITH A REASON -- never shown as an enabled toggle that draws nothing,
 * and never silently dropped from the list.
 */
type Requirement = 'scan' | 'ais' | 'raster' | 'maritime';

const REQUIREMENT: Partial<Record<LayerId, Requirement>> = {
  SAR_RASTER: 'raster',
  SAR_SCENE_FOOTPRINT: 'scan',
  SAR_DETECTIONS: 'scan',
  UNCERTAINTY_RADII: 'scan',
  AIS_CONTACTS: 'ais',
  AIS_TRACKS: 'ais',
  AIS_PREDICTED: 'ais',
  CORRELATION_LINKS: 'scan',
  // Maritime reference layers are gated on the LOCAL DATASET STORE, not on a scan.
  REFERENCE_COASTLINE: 'maritime',
  EEZ_BOUNDARIES: 'maritime',
  HIGH_SEAS: 'maritime',
};

/**
 * Per-layer reasons a maritime reference layer cannot draw, keyed by layer id.
 *
 * DISTINGUISHING THE THREE FAILURES, because they need different actions
 * ---------------------------------------------------------------------
 *   not installed here    the operator may install it -- an actionable step
 *   not installed, blocked  the operator CANNOT install it; retrying will not help
 *   corrupt                something is wrong on disk and the payload digest did not match
 *
 * A single "reference data unavailable" string would be wrong in all three cases: it would
 * invite an operator to keep retrying a download that cannot succeed, and it would hide a
 * disk fault behind what looks like a missing optional dataset.
 *
 * The reason is read from the dataset-health response, which is the backend's own account
 * of the store. It is not reconstructed from the layer id, so a dataset that becomes
 * installed mid-session reports correctly without this file changing.
 */
export function maritimeLayerReason(
  health: DatasetHealthResponse | null,
  datasetId: string,
): string | undefined {
  if (health === null) {
    // Null covers both "still loading" and "the probe failed", because neither case may
    // enable a toggle for data whose presence is unknown. The console shows a disabled row
    // either way, and the SYSTEM panel carries the specific reason.
    return 'The local reference-data store has not been read yet.';
  }
  const entry = (health.datasets ?? []).find((candidate) => candidate.id === datasetId);
  if (entry === undefined) {
    return `${datasetId} is not a registered dataset.`;
  }
  if (entry.usable) return undefined;

  if (entry.install_status === 'CHECKSUM_MISMATCH' || entry.install_status === 'INVALID') {
    return (
      `${entry.label} is present on disk but does not match its recorded checksum. ` +
      'Re-install it; the local copy has been altered or truncated.'
    );
  }
  if (entry.blocker_reason) {
    // Not actionable by the operator. The full cause is rendered in the SYSTEM panel; here
    // it is shortened so the console row stays one line.
    return `${entry.label} — TRUSTED SOURCE UNAVAILABLE. See SYSTEM for the recorded reason.`;
  }
  if (entry.optional) {
    return `${entry.label} is optional and not installed.`;
  }
  return `${entry.label} is not installed.`;
}

/** Which dataset each maritime layer draws from. Mirrors the registry's source paths. */
const LAYER_DATASET: Partial<Record<LayerId, string>> = {
  REFERENCE_COASTLINE: 'natural_earth_coastline',
  EEZ_BOUNDARIES: 'marine_regions_eez_wfs',
  HIGH_SEAS: 'marine_regions_high_seas_wfs',
};

/**
 * Layers the globe cannot show as a simultaneous overlay, with the reason.
 *
 * Kept as a declared block rather than a `notImplemented` flag on the definition,
 * because these are not missing features -- the capability exists and is rendered
 * server-side in ANALYTICS. The globe attaches ONE raster at a time.
 */
const BLOCKED: Partial<Record<LayerId, string>> = {
  LAND_MASK:
    'The globe draws one SAR raster at a time. View the land mask in ANALYTICS, or run it as the raster layer.',
  CFAR_DEBUG:
    'The globe draws one SAR raster at a time. View the CFAR threshold in ANALYTICS, or run it as the raster layer.',
};

/** Display order. Categories with no layers are simply absent from the panel. */
const CATEGORY_ORDER: readonly LayerCategory[] = [
  'SENSOR',
  'CONTACT',
  'MARITIME_BOUNDARY',
  'MARITIME_REFERENCE',
  'SEABED',
  'ANALYSIS',
  'OPERATIONAL',
];

export type LayerRow = {
  id: LayerId;
  label: string;
  category: LayerCategory;
  /** The operator's stored choice. Not recomputed. */
  visible: boolean;
  opacity: number;
  supportsOpacity: boolean;
  /** Why this layer cannot be shown, when it cannot. Absence means usable. */
  unavailableReason?: string;
};

/**
 * Derive the console rows: registry order, real availability, stored choices.
 *
 * The important property is that `visible` here is READ, not derived. An earlier
 * version computed it as `unavailableReason === undefined`, which is precisely why
 * toggles could not stick.
 */
export function deriveLayers(
  state: ReturnType<typeof useStore>,
  maritimeHealth: DatasetHealthResponse | null = null,
): LayerRow[] {
  const hasScan = state.scanId !== null && state.targets.length > 0;
  // Both must hold: the artifact exists AND it is actually on the globe.
  const hasRaster = state.rasterLoaded && state.scanId !== null;
  const hasAis = state.aisOnly.length > 0 || state.track !== null;
  // Maritime layers do NOT require a scan. A coastline is the same whether or not a vessel
  // was detected in it, and gating reference context on a detection would mean the sea is
  // invisible on an empty scan -- which is exactly when an operator wants to see it.
  const satisfied: Record<Requirement, boolean> = {
    scan: hasScan,
    ais: hasAis,
    raster: hasRaster,
    maritime: true,
  };

  const reasons: Record<Requirement, string> = {
    scan: 'No completed scan has produced detections.',
    ais: 'No AIS source has answered for the current selection.',
    raster: 'This scan has no rendered raster artifact.',
    maritime: '',
  };

  return listLayers().map((entry: LayerEntry) => {
    const id = entry.id as LayerId;
    const choice = state.layerState[id];
    const required = REQUIREMENT[id];
    const blockedReason = BLOCKED[id];

    let unavailableReason = blockedReason;
    if (!unavailableReason && required !== undefined && !satisfied[required]) {
      unavailableReason = reasons[required];
    }

    // Maritime availability is read per LAYER from the backend's dataset-health account,
    // because the three maritime layers come from three different datasets and only one of
    // them could be missing while the others draw.
    const datasetId = LAYER_DATASET[id];
    if (!unavailableReason && datasetId !== undefined) {
      unavailableReason = maritimeLayerReason(maritimeHealth, datasetId);
    }

    return {
      id,
      label: entry.label,
      category: entry.category,
      visible: choice?.visible ?? entry.defaultVisibility,
      opacity: choice?.opacity ?? 1,
      // Opacity on a point or vector layer has no meaning, so the control is not
      // rendered. A slider that does nothing is an inert control.
      supportsOpacity: entry.supportsOpacity,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}

export function LayerConsole() {
  const state = useStore();
  /*
   * ONE health fetch for the panel, not one per layer.
   *
   * The three maritime layers all read the same response. Fetching per layer would triple
   * the requests for one fact and could show two layers enabled while the third was
   * disabled, if the responses disagreed -- which they would, being separate snapshots of
   * the same store.
   *
   * A FAILED probe leaves `null`, which disables the maritime rows with "the store has not
   * been read yet" rather than enabling them optimistically. Offering a toggle for data
   * whose presence is unknown is the inert-control failure in a new place.
   */
  const health = useDatasetHealth();
  const healthValue = health.status === 'ready' ? health.value : null;
  const rows = deriveLayers(state, healthValue);

  /**
   * Write one layer's choice to the store.
   *
   * The store is the single authority and the engine reads it from
   * `TacticalWorld`'s layer effect, so this component does NOT call the engine. That
   * is the difference between one path and two: an earlier version drove GRATICULE
   * here directly while every other layer went nowhere.
   */
  const commit = (id: LayerId, patch: { visible?: boolean; opacity?: number }) => {
    store.set((prev) => ({
      layerState: {
        ...prev.layerState,
        [id]: {
          visible: patch.visible ?? prev.layerState[id].visible,
          opacity: patch.opacity ?? prev.layerState[id].opacity,
          ...(prev.layerState[id].unavailableReason
            ? { unavailableReason: prev.layerState[id].unavailableReason }
            : {}),
        },
      },
    }));
  };

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="LAYERS">
      <header className="df-panel-head">
        <span className="df-label">Active layers</span>
      </header>
      <div className="p-3">
        {CATEGORY_ORDER.map((category) => {
          const groupRows = rows.filter((row) => row.category === category);
          if (groupRows.length === 0) return null;
          return (
            <div key={category} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-0.5"
                  style={{ background: groupColor[category] }}
                />
                <span className="df-label text-[10px]">{category}</span>
              </div>
              <ul className="space-y-1">
                {groupRows.map((row) => {
                  const disabled = row.unavailableReason !== undefined;
                  const shown = row.visible && !disabled;
                  return (
                    <li key={row.id} data-df-layer={row.id}>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="df-btn flex-1 justify-start"
                          style={
                            shown
                              ? { color: 'var(--df-text)', borderColor: 'var(--df-structural-bright)' }
                              : undefined
                          }
                          aria-pressed={shown}
                          disabled={disabled}
                          title={row.unavailableReason ?? row.label}
                          onClick={() => commit(row.id, { visible: !row.visible })}
                        >
                          <span className="df-mono text-[10px]">{shown ? '◉' : '○'}</span>
                          <span className="truncate normal-case tracking-normal">{row.label}</span>
                        </button>
                        {row.supportsOpacity && !disabled ? (
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={row.opacity}
                            aria-label={`${row.label} opacity`}
                            className="w-16 accent-[var(--df-cyan)]"
                            onChange={(event) =>
                              commit(row.id, { opacity: Number(event.target.value) })
                            }
                          />
                        ) : (
                          <span className="df-num w-16 text-right text-ink-dim">
                            {row.supportsOpacity ? 'n/a' : '—'}
                          </span>
                        )}
                      </div>
                      {disabled ? (
                        <p className="df-num mt-0.5 pl-1 text-[10px] text-ink-dim">
                          {row.unavailableReason}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Re-exported so drift checks can compare what the registry declares against what the
 * engine can actually render. `asDefinition` keeps the optional `notImplemented` key
 * readable off the literal-typed entries.
 */
export { asDefinition };