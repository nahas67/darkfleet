/**
 * Scene browser.
 *
 * A catalogue read is not a browser. This selects a scene, frames its footprint
 * and hands it to the scan workflow, which is what makes it usable rather than
 * decorative.
 */

import { useEffect } from 'react';

import { loadScenes } from '../api/client';
import { engine } from '../globe/engine';
import { store, toBBox, useStore } from '../state/store';
import { fmtInstant } from '../design/format';

export function SceneBrowser() {
  const state = useStore();

  // Requires an AOI: the backend refuses an unbounded catalogue query.
  useEffect(() => {
    if (!state.aoi) {
      store.set({ scenes: [] });
      return;
    }
    void loadScenes(state.aoi);
  }, [state.aoi]);

  const selectedScene =
    state.selection.kind === 'scene' ? state.selection.sceneId : null;

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="SCENES">
      <header className="df-panel-head justify-between">
        <span className="df-label">Sentinel-1 scenes</span>
        <span className="df-num text-ink-dim">{state.scenes.length}</span>
      </header>

      <ul>
        {state.scenes.map((scene) => {
          const selected = scene.id === selectedScene;
          return (
            // VV and VH of one acquisition share an item_id, so the
            // polarization is part of the row's identity.
            <li key={`${scene.id}:${scene.polarization}`}>
              <button
                type="button"
                className="w-full border-b border-structural/50 px-3 py-2 text-left hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-info"
                style={
                  selected
                    ? { background: 'color-mix(in srgb, var(--df-cyan) 12%, transparent)' }
                    : undefined
                }
                aria-current={selected ? 'true' : undefined}
                data-df-scene={scene.id}
                onClick={() => {
                  store.select({ kind: 'scene', sceneId: scene.id });
                  const bbox = toBBox(scene.bbox);
                  if (bbox) {
                    engine.setAoi(bbox);
                    engine.flyToBbox(bbox);
                  }
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="df-num truncate text-[11px] text-ink">{scene.id}</span>
                  <span className="df-num shrink-0 text-[10px] text-ink-2">
                    {fmtInstant(scene.acquisition_time)}
                  </span>
                </div>
                <p className="df-num mt-0.5 text-[10px] text-ink-dim">
                  {scene.platform ?? 'platform not established'} ·{' '}
                  {scene.product ?? 'product not established'} ·{' '}
                  {scene.polarization ?? 'polarization not established'}
                </p>
              </button>
            </li>
          );
        })}
      </ul>

      {state.scenes.length === 0 && !state.scenesLoading ? (
        <p className="p-3 text-[11px] text-ink-dim" data-df-scenes-empty>
          {state.aoi
            ? 'No Sentinel-1 acquisition in the catalogue covers this area. That is not evidence that the area is never observed — the catalogue is not the full archive.'
            : 'Set an area of interest to search the Sentinel-1 catalogue. Scene search is spatial and cannot be run unbounded.'}
        </p>
      ) : null}
    </section>
  );
}