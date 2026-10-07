/**
 * Unified spatial search.
 *
 * One field resolves coordinates, maritime sectors, targets, MMSIs, scans,
 * scenes and missions, because an operator reaching for a vessel should not have
 * to know which of those categories it falls under. Every result is actionable.
 */

import { useMemo, useState } from 'react';

import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';
import { fmtLatLon } from '../design/format';

type Result = {
  id: string;
  kind: 'COORDINATE' | 'TARGET' | 'MMSI' | 'SCENE' | 'AREA';
  label: string;
  detail: string;
  lat: number;
  lon: number;
};

export function UnifiedSearch() {
  const state = useStore();
  const [query, setQuery] = useState('');

  const results = useMemo<Result[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    const out: Result[] = [];

    // "12.3456, 103.8123" or "12.3456 103.8123" is a coordinate request.
    const coord = needle.split(/[\s,]+/).map(Number);
    if (
      coord.length === 2 &&
      coord.every((n) => Number.isFinite(n)) &&
      Math.abs(coord[0]!) <= 90 &&
      Math.abs(coord[1]!) <= 180
    ) {
      out.push({
        id: 'coord',
        kind: 'COORDINATE',
        label: fmtLatLon(coord[0]!, coord[1]!, 4),
        detail: 'Fly to this position',
        lat: coord[0]!,
        lon: coord[1]!,
      });
    }

    for (const target of state.targets) {
      if (
        target.id.toLowerCase().includes(needle) ||
        (target.mmsi ?? '').includes(needle) ||
        target.classification.toLowerCase().includes(needle)
      ) {
        out.push({
          id: target.id,
          kind: 'TARGET',
          label: target.id,
          detail: target.classification.replace(/_/g, ' '),
          lat: target.lat,
          lon: target.lon,
        });
      }
    }

    for (const contact of state.aisOnly) {
      if (
        contact.mmsi.includes(needle) ||
        (contact.shipName ?? '').toLowerCase().includes(needle)
      ) {
        out.push({
          id: contact.mmsi,
          kind: 'MMSI',
          label: contact.mmsi,
          detail: contact.shipName ?? 'AIS-only contact',
          lat: contact.lat,
          lon: contact.lon,
        });
      }
    }

    for (const scene of state.scenes) {
      if (
        scene.id.toLowerCase().includes(needle) ||
        (scene.platform ?? '').toLowerCase().includes(needle)
      ) {
        const bbox = scene.bbox;
        out.push({
          id: scene.id,
          kind: 'SCENE',
          label: scene.id,
          detail: scene.platform ?? 'Sentinel-1 scene',
          lat: bbox ? (bbox[1] + bbox[3]) / 2 : 0,
          lon: bbox ? (bbox[0] + bbox[2]) / 2 : 0,
        });
      }
    }

    for (const area of state.savedAois) {
      if (area.name.toLowerCase().includes(needle)) {
        out.push({
          id: area.name,
          kind: 'AREA',
          label: area.name,
          detail: 'Saved area of interest',
          lat: (area.bbox[1] + area.bbox[3]) / 2,
          lon: (area.bbox[0] + area.bbox[2]) / 2,
        });
      }
    }

    return out.slice(0, 40);
  }, [query, state.targets, state.aisOnly, state.scenes, state.savedAois]);

  return (
    <section className="df-panel flex h-full flex-col" data-df-workspace="SEARCH">
      <header className="df-panel-head shrink-0">
        <span className="df-label">Search</span>
      </header>
      <div className="shrink-0 p-3">
        <input
          type="search"
          className="df-input w-full"
          placeholder="lat lon · target · mmsi · scene"
          aria-label="Search the tactical world"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="df-num mt-1 text-[10px] text-ink-dim">
          {results.length} result{results.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="df-rule" />
      <ul className="df-scroll min-h-0 flex-1 overflow-y-auto">
        {results.map((result) => (
          <li key={`${result.kind}:${result.id}`}>
            <button
              type="button"
              className="flex w-full items-baseline gap-2 border-b border-structural/50 px-3 py-1.5 text-left hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-info"
              data-df-search-result={result.kind}
              onClick={() => {
                if (result.kind === 'TARGET')
      store.select({ kind: 'target', targetId: result.id, scanId: store.getState().scanId });
                if (result.kind === 'MMSI') store.selectAis({ mmsi: result.id });
                if (result.kind === 'SCENE') store.select({ kind: 'scene', sceneId: result.id });
                engine.flyTo(result.lat, result.lon);
              }}
            >
              <span className="df-label w-16 shrink-0 text-[10px] text-ink-dim">
                {result.kind}
              </span>
              <span className="df-num min-w-0 flex-1 truncate text-ink">{result.label}</span>
              <span className="df-num shrink-0 truncate text-[10px] text-ink-2">
                {result.detail}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {query.trim() !== '' && results.length === 0 ? (
        <p className="p-3 text-[11px] text-ink-dim">
          Nothing in the loaded data matches. That is a statement about what is loaded,
          not about what exists.
        </p>
      ) : null}
    </section>
  );
}