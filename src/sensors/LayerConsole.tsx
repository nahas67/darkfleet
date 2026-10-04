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

/**
 * What a layer needs before it has anything to draw.
 *
 * Derived from real state at render time. A layer whose backing data is absent is
 * DISABLED WITH A REASON -- never shown as an enabled toggle that draws nothing,
 * and never silently dropped from the list.
 */
type Requirement = 'scan' | 'ais' | 'raster';

const REQUIREMENT: Partial<Record<LayerId, Requirement>> = {
  SAR_RASTER: 'raster',
  SAR_SCENE_FOOTPRINT: 'scan',
  SAR_DETECTIONS: 'scan',
  UNCERTAINTY_RADII: 'scan',
  AIS_CONTACTS: 'ais',
  AIS_TRACKS: 'ais',
  AIS_PREDICTED: 'ais',
  CORRELATION_LINKS: 'scan',
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
export function deriveLayers(state: ReturnType<typeof useStore>): LayerRow[] {
  const hasScan = state.scanId !== null && state.targets.length > 0;
  // Both must hold: the artifact exists AND it is actually on the globe.
  const hasRaster = state.rasterLoaded && state.scanId !== null;
  const hasAis = state.aisOnly.length > 0 || state.track !== null;
  const satisfied: Record<Requirement, boolean> = { scan: hasScan, ais: hasAis, raster: hasRaster };

  const reasons: Record<Requirement, string> = {
    scan: 'No completed scan has produced detections.',
    ais: 'No AIS source has answered for the current selection.',
    raster: 'This scan has no rendered raster artifact.',
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
  const rows = deriveLayers(state);

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