/**
 * Spatial search surface (UI-007).
 *
 * One query box over: `lat,lon`, a sector name, a scene id, a target id, an
 * MMSI, or a scan id. Results are built from what the caller actually holds —
 * backend scenes from `ApiClient.getScenes()` and the active scan's targets and
 * AIS contacts. Nothing is invented: an unknown query shows an explicit empty
 * state, and a scene without a bbox cannot be flown to.
 *
 * Results drive the camera directly (`flyToAOI` for an area or a coordinate,
 * `flyToTarget` for a contact) so the operator never loses their viewport.
 *
 * Rendering is deliberately DOM-light so it is testable without jsdom: the
 * parsing, matching, keyboard and camera helpers are exported as pure functions
 * and bound through handler factories, exactly like `src/app/state.ts` does.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X, Crosshair, Radio, Radar, Compass, ScanLine } from 'lucide-react';
import type { Viewer } from 'cesium';
import { appStore } from '../app/state.ts';
import type { AppStore } from '../app/state.ts';
import { createApiClient } from '../app/useApi.ts';
import type { ApiClient, SceneSummary } from '../app/useApi.ts';
import { flyToAOI, flyToTarget } from '../globe/camera.ts';
import type { BoundingBox, AisOnlyTarget, VesselTarget } from '../types/api.ts';

// ------------------------------------------------------------------ parsing

export type SearchQueryKind =
  | 'EMPTY'
  | 'COORD'
  | 'MMSI'
  | 'ID'
  | 'TEXT';

export interface ParsedQuery {
  readonly kind: SearchQueryKind;
  /** The raw query, trimmed. */
  readonly raw: string;
  /** Lowercase haystack for text matching. */
  readonly needle: string;
  readonly lat?: number;
  readonly lon?: number;
}

const COORD_SPLIT = /[\s,;]+/;
/** An identifier looks like `DF-0001` or `SIM-S1C-001`: letters plus a digit. */
const ID_PATTERN = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._-]{1,}$/;
const MMSI_PATTERN = /^\d{9}$/;

/**
 * Parse a query string. Coordinates accept `lat,lon` in either separator, and
 * ranges are validated: an out-of-range value is NOT a coordinate.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { kind: 'EMPTY', raw: '', needle: '' };

  const parts = trimmed.split(COORD_SPLIT).filter(Boolean);
  if (parts.length === 2) {
    const lat = Number.parseFloat(parts[0]);
    const lon = Number.parseFloat(parts[1]);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    ) {
      return { kind: 'COORD', raw: trimmed, needle: trimmed, lat, lon };
    }
  }

  if (MMSI_PATTERN.test(trimmed)) {
    return { kind: 'MMSI', raw: trimmed, needle: trimmed };
  }
  if (ID_PATTERN.test(trimmed)) {
    return { kind: 'ID', raw: trimmed, needle: trimmed.toLowerCase() };
  }
  return { kind: 'TEXT', raw: trimmed, needle: trimmed.toLowerCase() };
}

// ----------------------------------------------------------------- matching

export type SearchRowKind = 'COORD' | 'SCENE' | 'SECTOR' | 'TARGET' | 'MMSI' | 'SCAN';

export interface SearchRow {
  readonly key: string;
  readonly kind: SearchRowKind;
  readonly title: string;
  readonly detail: string;
  readonly bbox?: BoundingBox;
  readonly lat?: number;
  readonly lon?: number;
  readonly target?: VesselTarget;
  readonly mmsi?: string;
  readonly scanId?: string;
}

export interface SearchData {
  /** Scenes the backend reported. Empty means "no scenes yet", not "fake ones". */
  readonly scenes?: readonly SceneSummary[];
  /** Targets from the active scan. */
  readonly targets?: readonly VesselTarget[];
  /** AIS-only contacts from the active scan. */
  readonly aisOnly?: readonly AisOnlyTarget[];
  /** The active scan id, if any. */
  readonly scanId?: string | null;
  /** Free-text sector names the operator already has on screen. */
  readonly sectors?: readonly string[];
}

function sceneBboxOf(scene: SceneSummary): BoundingBox | null {
  const bbox = scene.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  if (!bbox.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (bbox[2] < bbox[0] || bbox[3] < bbox[1]) return null;
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle);
}

function sceneRow(scene: SceneSummary, kind: 'SCENE' | 'SECTOR', sector: string): SearchRow {
  const bbox = sceneBboxOf(scene) ?? undefined;
  return {
    key: `${kind}:${scene.id}`,
    kind,
    title: `${scene.platform} ${scene.product}`.trim() || scene.id,
    detail: [scene.id, sector, scene.acquisition_time, scene.synthetic ? 'DEMO' : 'REAL']
      .filter(Boolean)
      .join(' · '),
    ...(bbox ? { bbox } : {}),
  };
}

/**
 * Build the result rows for a parsed query. Rows are deterministic and ordered:
 * coordinate first, then scans, targets, MMSI, scenes, sectors.
 */
export function buildSearchRows(query: ParsedQuery, data: SearchData): SearchRow[] {
  if (query.kind === 'EMPTY') return [];

  const rows: SearchRow[] = [];

  if (query.kind === 'COORD') {
    rows.push({
      key: `COORD:${query.lat},${query.lon}`,
      kind: 'COORD',
      title: `Fly to ${query.lat.toFixed(4)}, ${query.lon.toFixed(4)}`,
      detail: 'Framed from the query as a camera viewport, not as survey data',
    });
    return rows;
  }

  const scenes = data.scenes ?? [];
  const targets = data.targets ?? [];
  const aisOnly = data.aisOnly ?? [];

  // An explicit scan id selects that scan; nothing else is invented about it.
  if (query.kind === 'ID' && data.scanId && query.needle === data.scanId.toLowerCase()) {
    rows.push({
      key: `SCAN:${data.scanId}`,
      kind: 'SCAN',
      title: `Scan ${data.scanId}`,
      detail: 'Active scan — show its detections',
      scanId: data.scanId,
    });
  }

  // Sector names the caller already supplied.
  for (const sector of data.sectors ?? []) {
    if (contains(sector, query.needle)) {
      const match = scenes.find((scene) => contains(scene.id, sector) || sector.includes(scene.id));
      rows.push(
        match
          ? sceneRow(match, 'SECTOR', sector)
          : {
              key: `SECTOR:${sector}`,
              kind: 'SECTOR',
              title: sector,
              detail: 'Named sector — no scene extent supplied',
            },
      );
    }
  }

  for (const target of targets) {
    const idHit = contains(target.id, query.needle);
    const mmsiHit = contains(target.corr?.mmsi, query.needle);
    const nameHit = contains(target.corr?.vesselName, query.needle);
    if (!idHit && !mmsiHit && !nameHit) continue;
    rows.push({
      key: `TARGET:${target.id}`,
      kind: query.kind === 'MMSI' || mmsiHit ? 'MMSI' : 'TARGET',
      title: `${target.id} · ${target.classification}`,
      detail: [
        target.corr?.mmsi ? `MMSI ${target.corr.mmsi}` : null,
        target.corr?.vesselName,
        `${target.lat.toFixed(4)}, ${target.lon.toFixed(4)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      target,
      ...(target.corr?.mmsi ? { mmsi: target.corr.mmsi } : {}),
    });
  }

  if (query.kind === 'MMSI') {
    for (const contact of aisOnly) {
      if (contact.mmsi !== query.raw) continue;
      rows.push({
        key: `AIS:${contact.mmsi}`,
        kind: 'MMSI',
        title: contact.vesselName ? `${contact.vesselName} ${contact.mmsi}` : contact.mmsi,
        detail: `AIS-only contact · ${contact.timestamp}`,
        mmsi: contact.mmsi,
        bbox: coordBbox(contact.lat, contact.lon),
      });
    }
  }

  for (const scene of scenes) {
    const idHit = contains(scene.id, query.needle);
    const platformHit = contains(scene.platform, query.needle);
    if (!idHit && !platformHit) continue;
    rows.push(sceneRow(scene, 'SCENE', ''));
  }

  return rows;
}

/** Camera viewport around a queried point, in degrees. Framing, not data. */
export const COORD_SPAN_DEG = 0.25;

export function coordBbox(lat: number, lon: number, span = COORD_SPAN_DEG): BoundingBox {
  const half = Math.max(span, 1e-6) / 2;
  return [
    Math.max(-180, lon - half),
    Math.max(-90, lat - half),
    Math.min(180, lon + half),
    Math.min(90, lat + half),
  ];
}

// -------------------------------------------------------------------- camera

/**
 * Act on a row. Returns a description of what actually happened so callers (and
 * tests) can prove the camera command ran — or that nothing was flyable.
 */
export type SearchOutcome =
  | { readonly action: 'FLY_TO_AOI'; readonly bbox: BoundingBox }
  | { readonly action: 'FLY_TO_TARGET'; readonly targetId: string }
  | { readonly action: 'SELECT_SCAN'; readonly scanId: string }
  | { readonly action: 'NONE' };

export function runSearchRow(
  row: SearchRow,
  ctx: { viewer?: Viewer | null; store?: AppStore },
): SearchOutcome {
  const { viewer, store } = ctx;
  if (row.kind === 'COORD' && viewer) {
    const bbox = coordBbox(row.lat ?? 0, row.lon ?? 0);
    return flyToAOI(viewer, bbox)
      ? { action: 'FLY_TO_AOI', bbox }
      : { action: 'NONE' };
  }
  if (row.target && viewer) {
    return flyToTarget(viewer, row.target)
      ? { action: 'FLY_TO_TARGET', targetId: row.target.id }
      : { action: 'NONE' };
  }
  if (row.bbox && viewer) {
    return flyToAOI(viewer, row.bbox)
      ? { action: 'FLY_TO_AOI', bbox: row.bbox }
      : { action: 'NONE' };
  }
  if (row.scanId) {
    store?.setActiveScanId(row.scanId);
    return { action: 'SELECT_SCAN', scanId: row.scanId };
  }
  if (row.target) {
    store?.selectTarget(row.target.id);
    return { action: 'NONE' };
  }
  return { action: 'NONE' };
}

// ----------------------------------------------------------------- keyboard

/** Wrapping list navigation for the results list. */
export function moveActiveRow(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return ((base + delta) % count + count) % count;
}

export type SearchKeyAction =
  | { readonly type: 'MOVE'; readonly delta: number }
  | { readonly type: 'ACTIVATE' }
  | { readonly type: 'CLOSE' }
  | { readonly type: 'NONE' };

/** Arrow keys move, Enter activates, Escape closes. Everything else is inert. */
export function searchKeyAction(key: string): SearchKeyAction {
  switch (key) {
    case 'ArrowDown':
      return { type: 'MOVE', delta: 1 };
    case 'ArrowUp':
      return { type: 'MOVE', delta: -1 };
    case 'Home':
      return { type: 'MOVE', delta: -Number.MAX_SAFE_INTEGER };
    case 'Enter':
      return { type: 'ACTIVATE' };
    case 'Escape':
      return { type: 'CLOSE' };
    default:
      return { type: 'NONE' };
  }
}

/** The exact handler bound to the input's `onKeyDown`. */
export function makeSearchKeyHandler(handlers: {
  onMove: (delta: number) => void;
  onActivate: () => void;
  onClose: () => void;
}): (event: { key: string; preventDefault?: () => void }) => void {
  return (event) => {
    const action = searchKeyAction(event.key);
    switch (action.type) {
      case 'MOVE':
        event.preventDefault?.();
        handlers.onMove(action.delta);
        return;
      case 'ACTIVATE':
        event.preventDefault?.();
        handlers.onActivate();
        return;
      case 'CLOSE':
        handlers.onClose();
        return;
      default:
        return;
    }
  };
}

/** Escape closes the surface through the store, exactly like the shell root. */
export function closeSearchSurface(store: AppStore): void {
  store.handleKey('Escape');
}

// ------------------------------------------------------------------ helpers

/** Stable DOM ids for `aria-activedescendant`. */
export const SEARCH_LISTBOX_ID = 'df-search-listbox';

export function searchOptionId(index: number): string {
  return `df-search-option-${index}`;
}

function kindIcon(kind: SearchRowKind): React.ReactElement {
  const props = { className: 'h-3 w-3 shrink-0', 'aria-hidden': true } as const;
  switch (kind) {
    case 'COORD':
      return <Crosshair {...props} />;
    case 'TARGET':
    case 'MMSI':
      return <Radio {...props} />;
    case 'SCENE':
      return <Radar {...props} />;
    case 'SCAN':
      return <ScanLine {...props} />;
    default:
      return <Compass {...props} />;
  }
}

export interface SpatialSearchProps {
  /** Injectable store; defaults to the process store. */
  readonly store?: AppStore;
  /** Injectable client; defaults to a fetch-backed one. Tests inject a stub. */
  readonly client?: ApiClient;
  /** Targets and contacts of the active scan. */
  readonly targets?: readonly VesselTarget[];
  readonly aisOnly?: readonly AisOnlyTarget[];
  readonly scanId?: string | null;
  readonly sectors?: readonly string[];
  /** Cesium Viewer used to fly the camera. Null renders, but never flies. */
  readonly viewer?: Viewer | null;
  /** Called after every result activation, for shell-level bookkeeping. */
  readonly onOutcome?: (outcome: SearchOutcome) => void;
  readonly onClose?: () => void;
}

// ------------------------------------------------------------------ surface

export function SpatialSearch({
  store = appStore,
  client,
  targets = [],
  aisOnly = [],
  scanId = null,
  sectors = [],
  viewer = null,
  onOutcome,
  onClose,
}: SpatialSearchProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [scenes, setScenes] = useState<readonly SceneSummary[]>([]);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [queried, setQueried] = useState(false);

  const resolved = useMemo(() => client ?? createApiClient(), [client]);

  useEffect(() => {
    let cancelled = false;
    resolved
      .getScenes()
      .then((response) => {
        if (cancelled) return;
        setScenes(response.scenes ?? []);
        setSceneError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setScenes([]);
        setSceneError(err instanceof Error ? err.message : 'Scene query failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [resolved]);

  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const rows = useMemo(
    () => buildSearchRows(parsed, { scenes, targets, aisOnly, scanId, sectors }),
    [parsed, scenes, targets, aisOnly, scanId, sectors],
  );

  const close = useCallback(() => {
    closeSearchSurface(store);
    onClose?.();
  }, [store, onClose]);

  const activate = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      const outcome = runSearchRow(row, { viewer, store });
      if (row.target) store.selectTarget(row.target.id);
      setQueried(true);
      onOutcome?.(outcome);
    },
    [rows, viewer, store, onOutcome],
  );

  const keyHandler = useMemo(
    () =>
      makeSearchKeyHandler({
        onMove: (delta) => setActive((current) => moveActiveRow(current, delta, rows.length)),
        onActivate: () => activate(active >= 0 ? active : rows.length > 0 ? 0 : -1),
        onClose: close,
      }),
    [rows.length, active, activate, close],
  );

  const inputId = 'df-search-input';

  return (
    <div data-df-search className="space-y-3">
      <div className="flex items-center gap-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--df-accent)]" aria-hidden />
        <input
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={rows.length > 0}
          aria-controls={SEARCH_LISTBOX_ID}
          aria-label="Spatial search: coordinates, sector, scene, target id, MMSI or scan id"
          placeholder="1.2644, 103.8400 · sector · scene · DF-0001 · 9-digit MMSI"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
            setQueried(true);
          }}
          onKeyDown={keyHandler}
          className="w-full bg-transparent font-mono text-[11px] text-[var(--df-text)] outline-none placeholder:text-[var(--df-text-dim)]"
        />
        <button
          type="button"
          onClick={close}
          aria-label="Close spatial search"
          className="rounded-[6px] p-1 text-[var(--df-text-dim)] transition hover:text-[var(--df-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {sceneError && (
        <p role="status" className="text-[10px] text-[var(--df-danger)]">
          Scene query failed: {sceneError}
        </p>
      )}

      <ul
        id={SEARCH_LISTBOX_ID}
        role="listbox"
        aria-label="Spatial search results"
        aria-activedescendant={active >= 0 ? searchOptionId(active) : undefined}
        className="max-h-64 space-y-1 overflow-y-auto"
      >
        {rows.map((row, index) => (
          <li
            key={row.key}
            id={searchOptionId(index)}
            role="option"
            aria-selected={index === active}
            data-df-search-row={row.kind}
            className={[
              'flex w-full cursor-pointer items-center gap-2 rounded-[6px] border px-2 py-1.5 text-left text-[10px] transition',
              index === active
                ? 'border-[var(--df-border-active)] bg-[var(--df-accent-soft)]'
                : 'border-transparent hover:bg-[var(--df-accent-soft)]',
            ].join(' ')}
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={() => activate(index)}
              aria-label={`${row.title} — ${row.kind.toLowerCase()}`}
              className="flex w-full items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
            >
              {kindIcon(row.kind)}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[var(--df-text)]">{row.title}</span>
                <span className="block truncate font-mono text-[9px] text-[var(--df-text-dim)]">
                  {row.detail}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {rows.length === 0 && (
        <p data-df-search-empty role="status" className="font-mono text-[10px] text-[var(--df-text-dim)]">
          {queried
            ? `No match for "${query.trim()}". Nothing is searched, so nothing is shown.`
            : 'Enter lat,lon, a sector, a scene id, a target id, a 9-digit MMSI or a scan id.'}
        </p>
      )}

      {rows.length > 0 && (
        <p className="font-mono text-[9px] text-[var(--df-text-dim)]">
          Arrow keys move · Enter flies the camera · Escape closes
        </p>
      )}
    </div>
  );
}

export default SpatialSearch;