/**
 * Contact list.
 *
 * The keyboard-navigable equivalent of the globe. Every mark on the tactical
 * world is reachable here, which is what makes the product usable without a
 * mouse and what keeps the map from being the only way to select anything.
 *
 * Selection is bidirectional: activating a row drives the globe, and selecting
 * on the globe highlights the row.
 */

import { useMemo, useState } from 'react';

import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';
import { classificationColor } from '../design/tokens';
import { fmt, fmtConfidence, fmtLatLon, NOT_ESTABLISHED } from '../design/format';

type SortKey = 'id' | 'classification' | 'confidence' | 'distance';
type Row = {
  kind: 'sar' | 'ais';
  key: string;
  id: string;
  mmsi: string | null;
  classification: string;
  lat: number;
  lon: number;
  confidence: number;
  distance: number | null;
};

const FILTERS: ReadonlyArray<{ id: string; label: string; match: (row: Row) => boolean }> = [
  { id: 'MATCHED', label: 'Matched', match: (r) => r.classification === 'SAR_MATCHED_AIS' },
  /*
   * Labelled GHOST VESSELS rather than "Unmatched" because that is the designation
   * the product uses everywhere else for this class, and an operator who has read
   * "GHOST VESSEL" in the dossier should be able to find the same set here.
   *
   * The predicate stays the canonical classification. There is deliberately no
   * second Ghost Vessel data model and no persisted count: a stored count would be
   * able to disagree with the classifications it was derived from.
   */
  { id: 'UNMATCHED', label: 'Ghost vessels', match: (r) => r.classification === 'SAR_UNMATCHED' },
  {
    id: 'INFRA',
    label: 'Infrastructure',
    match: (r) => r.classification === 'STATIONARY_OR_INFRASTRUCTURE',
  },
  {
    id: 'LOW_CONF',
    label: 'Low confidence',
    match: (r) => r.classification === 'LOW_CONFIDENCE' || r.classification === 'UNRESOLVED',
  },
];

function buildRows(state: ReturnType<typeof useStore>): Row[] {
  const sar: Row[] = state.targets.map((target) => ({
    kind: 'sar',
    key: `sar:${target.id}`,
    id: target.id,
    mmsi: target.mmsi,
    classification: target.classification,
    lat: target.lat,
    lon: target.lon,
    confidence: target.sarConf,
    distance: target.distanceOffsetMeters,
  }));
  const ais: Row[] = state.aisOnly.map((contact) => ({
    kind: 'ais',
    key: `ais:${contact.mmsi}`,
    id: contact.mmsi,
    mmsi: contact.mmsi,
    classification: 'AIS_ONLY',
    lat: contact.lat,
    lon: contact.lon,
    confidence: 0,
    distance: null,
  }));
  return [...sar, ...ais];
}

/** Absent values sort last in BOTH directions -- an unknown is not "the smallest". */
function compare(a: Row, b: Row, key: SortKey): number {
  switch (key) {
    case 'id':
      return a.id.localeCompare(b.id);
    case 'classification':
      return a.classification.localeCompare(b.classification);
    case 'confidence':
      return b.confidence - a.confidence;
    case 'distance': {
      if (a.distance === null && b.distance === null) return a.id.localeCompare(b.id);
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    }
  }
}

export function ContactList() {
  const state = useStore();
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'id', asc: true });
  const [query, setQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => buildRows(state), [state.targets, state.aisOnly]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = rows;
    // Filters combine as a union: any selected class passes.
    if (activeFilters.size > 0) {
      list = list.filter((row) =>
        FILTERS.some((filter) => activeFilters.has(filter.id) && filter.match(row)),
      );
    }
    if (needle) {
      list = list.filter(
        (row) =>
          row.id.toLowerCase().includes(needle) ||
          (row.mmsi ?? '').includes(needle) ||
          row.classification.toLowerCase().includes(needle),
      );
    }
    const sorted = [...list].sort((a, b) => compare(a, b, sort.key));
    return sort.asc ? sorted : sorted.reverse();
  }, [rows, query, activeFilters, sort]);

  const selectedSarId =
    state.selection.kind === 'target' ? state.selection.targetId : null;
  const selectedAisMmsi = state.selectedAis?.mmsi ?? null;

  const activate = (row: Row) => {
    if (row.kind === 'sar') {
      // scanId travels with the id: target ids are per-scan, so DF-002 in one stored
    // scan is a different vessel from DF-002 in another.
    store.select({ kind: 'target', targetId: row.id, scanId: store.getState().scanId });
      engine.flyTo(row.lat, row.lon);
    } else {
      // AIS authority, beside -- not instead of -- the SAR target (DF-X9.6 §7).
      store.selectAis({ mmsi: row.mmsi as string });
      engine.flyTo(row.lat, row.lon);
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((prev) => ({ key, asc: prev.key === key ? !prev.asc : true }));

  const noScan = state.scanId === null;
  const noDetections = !noScan && state.targets.length === 0 && state.aisOnly.length === 0;

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="CONTACTS">
      <header className="df-panel-head sticky top-0 z-10 justify-between">
        <span className="df-label">Contacts</span>
        <span className="df-num text-ink-dim">
          {visible.length}/{rows.length}
        </span>
      </header>

      <div className="space-y-2 p-2">
        <input
          type="search"
          className="df-input w-full"
          placeholder="id, mmsi, class"
          aria-label="Filter contacts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((filter) => {
            const active = activeFilters.has(filter.id);
            return (
              <button
                key={filter.id}
                type="button"
                className="df-btn normal-case tracking-normal"
                aria-pressed={active}
                data-df-contact-filter={filter.id}
                onClick={() => {
                  const next = new Set(activeFilters);
                  if (next.has(filter.id)) next.delete(filter.id);
                  else next.add(filter.id);
                  setActiveFilters(next);
                }}
              >
                {filter.label}
                {/*
                  The count is recomputed from the canonical classifications on every
                  render, never stored. A persisted Ghost Vessel count could disagree
                  with the classifications it was derived from, and then both would look
                  authoritative while meaning different things.
                */}
                <span className="df-num ml-1 text-[10px] text-ink-dim" data-df-ghost-count-for={filter.id}>
                  {rows.filter(filter.match).length}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="df-rule" />

      <table className="w-full border-collapse text-left">
        <caption className="df-sr-only">
          SAR detections and AIS-only contacts. Activate a row to select it on the globe.
        </caption>
        <thead>
          <tr>
            {(
              [
                ['id', 'ID'],
                ['classification', 'CLASS'],
                ['confidence', 'CONF'],
                ['distance', 'DIST'],
              ] as ReadonlyArray<readonly [SortKey, string]>
            ).map(([key, label]) => (
              <th
                key={key}
                scope="col"
                aria-sort={
                  sort.key === key ? (sort.asc ? 'ascending' : 'descending') : 'none'
                }
                className="px-2 py-1.5"
              >
                <button
                  type="button"
                  className="df-label text-[10px] hover:text-ink"
                  onClick={() => toggleSort(key)}
                >
                  {label}
                  <span aria-hidden="true" className="ml-0.5">
                    {sort.key === key ? (sort.asc ? '▲' : '▼') : '↕'}
                  </span>
                  <span className="df-sr-only">
                    {sort.key === key
                      ? sort.asc
                        ? ' currently ascending'
                        : ' currently descending'
                      : ''}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            // SAR and AIS highlight independently: the two authorities coexist
            // (DF-X9.6 §7), so a selected target and a selected contact each
            // mark their own row.
            const selected =
              row.kind === 'sar' ? row.id === selectedSarId : row.mmsi === selectedAisMmsi;
            return (
              <tr
                key={row.key}
                data-df-contact-row={row.key}
                data-df-selected={selected ? 'true' : undefined}
                aria-current={selected ? 'true' : undefined}
                tabIndex={0}
                className="cursor-pointer border-t border-structural/60 hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-info"
                style={selected ? { background: 'color-mix(in srgb, var(--df-cyan) 12%, transparent)' } : undefined}
                onClick={() => activate(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate(row);
                  }
                }}
              >
                <td className="df-num px-2 py-1.5">
                  <span
                    aria-hidden="true"
                    className="mr-1.5 inline-block h-2 w-2"
                    style={{
                      background: classificationColor[row.classification] ?? 'var(--df-text-dim)',
                    }}
                  />
                  {row.id}
                  {selected ? <span className="df-sr-only"> (selected)</span> : null}
                </td>
                <td className="df-num px-2 py-1.5 text-ink-2">
                  {row.classification.replace(/_/g, ' ')}
                </td>
                <td className="df-num px-2 py-1.5">
                  {row.kind === 'ais' ? '—' : fmtConfidence(row.confidence)}
                </td>
                <td className="df-num px-2 py-1.5 text-ink-2">
                  {row.distance === null ? '—' : `${row.distance.toFixed(0)} m`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {noScan ? (
        <p className="p-3 text-[11px] text-ink-dim" data-df-contacts-empty="no-scan">
          No scan has run. Contacts appear when an analysis completes.
        </p>
      ) : null}
      {noDetections ? (
        <p className="p-3 text-[11px] text-ink-dim" data-df-contacts-empty="no-detections">
          This scan reported no SAR detections and no AIS-only contacts.
        </p>
      ) : null}
      {!noScan && !noDetections && visible.length === 0 ? (
        <p className="p-3 text-[11px] text-ink-dim" data-df-contacts-empty="filtered">
          No row matches the current filters. Clear them to see the {rows.length} row
          {rows.length === 1 ? '' : 's'} the backend returned.
        </p>
      ) : null}
    </section>
  );
}

export { fmt, fmtLatLon, NOT_ESTABLISHED };