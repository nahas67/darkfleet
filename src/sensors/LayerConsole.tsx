/**
 * Layer console.
 *
 * Groups map to what a source actually provides. A layer that cannot be shown is
 * disabled AND carries the reason -- a greyed-out toggle with no explanation
 * reads as a bug, and an enabled toggle that draws nothing reads as a lie.
 */

import { useStore, store, type LayerGroup, type LayerId, type LayerState } from '../state/store';
import { groupColor } from '../design/tokens';

type Definition = {
  id: LayerId;
  group: LayerGroup;
  label: string;
  /** Why this layer is unavailable, when it is. Absence of a reason means usable. */
  requires?: 'scan' | 'ais' | 'raster';
};

const DEFINITIONS: readonly Definition[] = [
  { id: 'SAR_RASTER', group: 'SENSORS', label: 'Sentinel-1 SAR raster', requires: 'raster' },
  { id: 'SAR_SCENE_FOOTPRINT', group: 'SENSORS', label: 'Scene footprint', requires: 'scan' },
  { id: 'SAR_DETECTIONS', group: 'CONTACTS', label: 'SAR detections', requires: 'scan' },
  { id: 'UNCERTAINTY_RADII', group: 'ANALYSIS', label: 'Geolocation uncertainty', requires: 'scan' },
  { id: 'AIS_CONTACTS', group: 'CONTACTS', label: 'AIS contacts', requires: 'ais' },
  { id: 'AIS_TRACKS', group: 'CONTACTS', label: 'AIS observed track', requires: 'ais' },
  { id: 'AIS_PREDICTED', group: 'CONTACTS', label: 'AIS predicted segment', requires: 'ais' },
  { id: 'CORRELATION_LINKS', group: 'ANALYSIS', label: 'Correlation links', requires: 'scan' },
  { id: 'LAND_MASK', group: 'ANALYSIS', label: 'Land mask', requires: 'raster' },
  { id: 'CFAR_DEBUG', group: 'ANALYSIS', label: 'CFAR threshold', requires: 'raster' },
  { id: 'GRATICULE', group: 'REFERENCE', label: 'Graticule' },
];

const GROUP_ORDER: readonly LayerGroup[] = ['SENSORS', 'CONTACTS', 'REFERENCE', 'ANALYSIS'];

/**
 * Derive layer availability from real state.
 *
 * Capability is computed, not stored: a flag that can drift out of step with the
 * data is how a product ends up offering an empty layer.
 */
export function deriveLayers(state: ReturnType<typeof useStore>): LayerState[] {
  const hasScan = state.scanId !== null && state.targets.length > 0;
  // Both must hold: the artifact exists AND it is actually on the globe.
  const hasRaster = state.rasterLoaded && state.scanId !== null;
  const hasAis = state.aisOnly.length > 0 || state.track !== null;

  return DEFINITIONS.map((definition) => {
    let unavailableReason: string | undefined;
    if (definition.requires === 'scan' && !hasScan) {
      unavailableReason = 'No completed scan has produced detections.';
    } else if (definition.requires === 'raster' && !hasRaster) {
      unavailableReason = 'This scan has no rendered raster artifact.';
    } else if (definition.requires === 'ais' && !hasAis) {
      unavailableReason = 'No AIS source has answered for the current selection.';
    }
    // Visibility defaults on when the layer is usable, and off when it is not, so
    // the operator never has to enable something that has nothing to draw.
    const visible = unavailableReason === undefined;
    return {
      id: definition.id,
      group: definition.group,
      label: definition.label,
      visible,
      opacity: 1,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}

export function LayerConsole() {
  const state = useStore();
  const layers = deriveLayers(state);

  const commit = (next: LayerState[]) => {
    store.set({ layers: next });
  };

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="LAYERS">
      <header className="df-panel-head">
        <span className="df-label">Active layers</span>
      </header>
      <div className="p-3">
        {GROUP_ORDER.map((group) => {
          const rows = layers.filter((layer) => layer.group === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-0.5"
                  style={{ background: groupColor[group] }}
                />
                <span className="df-label text-[10px]">{group}</span>
              </div>
              <ul className="space-y-1">
                {rows.map((layer) => {
                  const disabled = layer.unavailableReason !== undefined;
                  return (
                    <li key={layer.id} data-df-layer={layer.id}>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="df-btn flex-1 justify-start"
                          style={
                            layer.visible && !disabled
                              ? { color: 'var(--df-text)', borderColor: 'var(--df-structural-bright)' }
                              : undefined
                          }
                          aria-pressed={layer.visible && !disabled}
                          disabled={disabled}
                          title={layer.unavailableReason ?? layer.label}
                          onClick={() =>
                            commit(
                              layers.map((l) =>
                                l.id === layer.id ? { ...l, visible: !l.visible } : l,
                              ),
                            )
                          }
                        >
                          <span className="df-mono text-[10px]">
                            {layer.visible && !disabled ? '◉' : '○'}
                          </span>
                          <span className="truncate normal-case tracking-normal">{layer.label}</span>
                        </button>
                        {!disabled ? (
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={layer.opacity}
                            aria-label={`${layer.label} opacity`}
                            className="w-16 accent-[var(--df-cyan)]"
                            onChange={(event) =>
                              commit(
                                layers.map((l) =>
                                  l.id === layer.id
                                    ? { ...l, opacity: Number(event.target.value) }
                                    : l,
                                ),
                              )
                            }
                          />
                        ) : (
                          <span className="df-num w-16 text-right text-ink-dim">n/a</span>
                        )}
                      </div>
                      {disabled ? (
                        <p className="df-num mt-0.5 pl-1 text-[10px] text-ink-dim">
                          {layer.unavailableReason}
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