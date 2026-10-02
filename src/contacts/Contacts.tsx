/**
 * Merged telemetry contacts surface (UI-021, UI-024).
 *
 * Two tabs over the same scan payload: SAR TARGETS (backend detections) and AIS
 * CONTACTS (backend AIS-only records). The legacy table had no sorting at all;
 * this one has sortable columns, class filters and search.
 *
 * Rules this file encodes:
 *  - No analytics are computed client-side. Every count, confidence, dimension
 *    and offset is passed through from the payload. The only derived values are
 *    ordering, filtering and formatting — never a number the backend did not send.
 *  - Never fabricate. No targets and no AIS contacts means an empty state that
 *    says why; a filter that matches nothing says so too. Neither becomes a
 *    placeholder row.
 *  - UI-024. Status is never colour alone: every classification renders a TEXT
 *    label and a distinct ICON next to the tone.
 *  - Bidirectional selection is prop-driven. A row activation calls
 *    `onSelectTarget`; `selectedTargetId` highlights the matching row. There is
 *    no Cesium dependency, so the whole surface is testable in a node
 *    environment.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Radio, Ruler, Search, Ship, X } from 'lucide-react';
import { classificationIcon, classificationLabel, classificationTone } from '../evidence/TargetInspector.tsx';
import { NOT_ESTABLISHED, formatDegrees, formatFootprint, formatLatLon } from '../timeline/Timeline.tsx';
import type { AisOnlyTarget, TargetClassification, VesselTarget } from '../types/api.ts';

// Re-exported so a consumer of this surface gets the missing-value wording from
// the same place the cells render it.
export { NOT_ESTABLISHED };

type IconComponent = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
type Tone = 'ok' | 'warn' | 'bad' | 'idle';

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  ok: 'text-[var(--df-success)]',
  warn: 'text-[var(--df-warning)]',
  bad: 'text-[var(--df-danger)]',
  idle: 'text-[var(--df-text-secondary)]',
};

// ------------------------------------------------------------------- models

export interface SarContactRow {
  readonly kind: 'SAR_TARGET';
  readonly key: string;
  readonly id: string;
  readonly classification: TargetClassification;
  readonly mmsi: string | null;
  readonly vesselName: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly sarConf: number;
  readonly aisConf: number;
  readonly lenM: number;
  readonly lenUncM: number;
  readonly hdg: number;
}

export interface AisContactRow {
  readonly kind: 'AIS_CONTACT';
  readonly key: string;
  readonly mmsi: string;
  readonly vesselName: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly timestamp: string;
}

export type ContactRow = SarContactRow | AisContactRow;

/** Flatten backend detections into rows. Identity mapping, no derivation. */
export function buildSarRows(targets: readonly VesselTarget[] | null | undefined): SarContactRow[] {
  if (!targets) return [];
  return targets.map((target) => ({
    kind: 'SAR_TARGET' as const,
    key: `SAR_TARGET:${target.id}`,
    id: target.id,
    classification: target.classification,
    mmsi: target.corr?.mmsi ?? null,
    vesselName: target.corr?.vesselName ?? null,
    lat: target.lat,
    lon: target.lon,
    sarConf: target.sarConf,
    aisConf: target.aisConf,
    lenM: target.lenM,
    lenUncM: target.lenUncM,
    hdg: target.hdg,
  }));
}

/** Flatten backend AIS-only records into rows. */
export function buildAisRows(
  contacts: readonly AisOnlyTarget[] | null | undefined,
): AisContactRow[] {
  if (!contacts) return [];
  return contacts.map((contact) => ({
    kind: 'AIS_CONTACT' as const,
    key: `AIS_CONTACT:${contact.mmsi}:${contact.timestamp}`,
    mmsi: contact.mmsi,
    vesselName: contact.vesselName ?? null,
    lat: contact.lat,
    lon: contact.lon,
    timestamp: contact.timestamp,
  }));
}

// ------------------------------------------------------------------ columns

export type ContactsTab = 'SAR_TARGETS' | 'AIS_CONTACTS';

export const CONTACTS_TABS: readonly ContactsTab[] = ['SAR_TARGETS', 'AIS_CONTACTS'];

export const CONTACTS_TAB_LABELS: Readonly<Record<ContactsTab, string>> = {
  SAR_TARGETS: 'SAR targets',
  AIS_CONTACTS: 'AIS contacts',
};

export type ContactsColumn =
  | 'CLASSIFICATION'
  | 'ID'
  | 'MMSI'
  | 'VESSEL'
  | 'LOCATION'
  | 'SAR_CONFIDENCE'
  | 'AIS_CONFIDENCE'
  | 'APPARENT_LENGTH'
  | 'HEADING';

export interface ColumnDef {
  readonly id: ContactsColumn;
  readonly label: string;
  /** Which tab the column belongs to. `null` means both. */
  readonly tabs: readonly ContactsTab[] | null;
}

/** Column order is fixed; the legacy table had no headers at all. */
export const CONTACT_COLUMNS: readonly ColumnDef[] = [
  { id: 'CLASSIFICATION', label: 'Classification', tabs: ['SAR_TARGETS'] },
  { id: 'ID', label: 'Target ID', tabs: ['SAR_TARGETS'] },
  { id: 'MMSI', label: 'MMSI', tabs: null },
  { id: 'VESSEL', label: 'Vessel', tabs: null },
  { id: 'LOCATION', label: 'Location', tabs: null },
  { id: 'SAR_CONFIDENCE', label: 'SAR conf.', tabs: ['SAR_TARGETS'] },
  // An AIS-only record carries no SAR detection, so the confidence columns stay
  // on the SAR tab rather than rendering "not established" in every row.
  { id: 'AIS_CONFIDENCE', label: 'AIS conf.', tabs: ['SAR_TARGETS'] },
  { id: 'APPARENT_LENGTH', label: 'Apparent length', tabs: ['SAR_TARGETS'] },
  { id: 'HEADING', label: 'Heading', tabs: ['SAR_TARGETS'] },
];

export function columnsForTab(tab: ContactsTab): ColumnDef[] {
  return CONTACT_COLUMNS.filter((column) => column.tabs === null || column.tabs.includes(tab));
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly column: ContactsColumn;
  readonly direction: SortDirection;
}

/**
 * Header-click toggle. Clicking the active column flips direction; clicking a
 * different column starts ascending. `null` state means "unsorted".
 */
export function nextSortState(
  current: SortState | null,
  column: ContactsColumn,
): SortState {
  if (current && current.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column, direction: 'asc' };
}

/** `aria-sort` value for a column header. */
export function ariaSortFor(sort: SortState | null, column: ContactsColumn): 'ascending' | 'descending' | 'none' {
  if (!sort || sort.column !== column) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/** Accessible name for a header button, so the current direction is announced. */
export function sortButtonLabel(column: ColumnDef, sort: SortState | null): string {
  const state = ariaSortFor(sort, column.id);
  if (state === 'ascending') return `Sort by ${column.label}, currently ascending`;
  if (state === 'descending') return `Sort by ${column.label}, currently descending`;
  return `Sort by ${column.label}`;
}

// ------------------------------------------------------------------ compare

function cellValue(row: ContactRow, column: ContactsColumn): string | number | null {
  switch (column) {
    case 'CLASSIFICATION':
      return row.kind === 'SAR_TARGET' ? row.classification : null;
    case 'ID':
      return row.kind === 'SAR_TARGET' ? row.id : null;
    case 'MMSI':
      return row.mmsi;
    case 'VESSEL':
      return row.vesselName;
    case 'LOCATION':
      return row.lat;
    case 'SAR_CONFIDENCE':
      return row.kind === 'SAR_TARGET' ? row.sarConf : null;
    case 'AIS_CONFIDENCE':
      return row.kind === 'SAR_TARGET' ? row.aisConf : null;
    case 'APPARENT_LENGTH':
      return row.kind === 'SAR_TARGET' ? row.lenM : null;
    case 'HEADING':
      return row.kind === 'SAR_TARGET' ? row.hdg : null;
    default:
      return null;
  }
}

/** Compare two rows on one column. Missing values sort last in BOTH directions. */
export function compareRows(a: ContactRow, b: ContactRow, column: ContactsColumn): number {
  const left = cellValue(a, column);
  const right = cellValue(b, column);
  if (left === null && right === null) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return left - right;
  }
  const l = String(left).toLowerCase();
  const r = String(right).toLowerCase();
  if (l === r) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return l < r ? -1 : 1;
}

/**
 * Sort rows. Stable: equal keys keep their incoming order through the `key`
 * tie-break, so a render is deterministic. `null` state preserves input order.
 */
export function sortRows(
  rows: readonly ContactRow[],
  sort: SortState | null,
): ContactRow[] {
  if (!sort) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * compareRows(a, b, sort.column));
}

// ------------------------------------------------------------------ filters

export type ContactsFilterId =
  | 'MATCHED'
  | 'UNMATCHED'
  | 'AIS_ONLY'
  | 'INFRASTRUCTURE'
  | 'LOW_CONFIDENCE';

export interface FilterDef {
  readonly id: ContactsFilterId;
  readonly label: string;
  readonly matches: (row: ContactRow) => boolean;
}

const classificationIs =
  (value: TargetClassification) =>
  (row: ContactRow): boolean =>
    row.kind === 'SAR_TARGET' && row.classification === value;

/** Filter order is fixed so the toolbar never reorders under the operator. */
export const CONTACTS_FILTERS: readonly FilterDef[] = [
  { id: 'MATCHED', label: 'Matched', matches: classificationIs('SAR_MATCHED_AIS') },
  { id: 'UNMATCHED', label: 'Unmatched', matches: classificationIs('SAR_UNMATCHED') },
  {
    id: 'AIS_ONLY',
    label: 'AIS only',
    matches: (row) => row.kind === 'AIS_CONTACT' || classificationIs('AIS_ONLY')(row),
  },
  {
    id: 'INFRASTRUCTURE',
    label: 'Infrastructure',
    matches: classificationIs('STATIONARY_OR_INFRASTRUCTURE'),
  },
  { id: 'LOW_CONFIDENCE', label: 'Low confidence', matches: classificationIs('LOW_CONFIDENCE') },
];

/**
 * Apply the active filters. They combine as a UNION: a row passes when it
 * satisfies ANY selected class, which is what an operator toggling two class
 * chips expects.
 */
export function filterRows(
  rows: readonly ContactRow[],
  filters: readonly ContactsFilterId[],
): ContactRow[] {
  if (filters.length === 0) return [...rows];
  const defs = CONTACTS_FILTERS.filter((def) => filters.includes(def.id));
  if (defs.length === 0) return [...rows];
  return rows.filter((row) => defs.some((def) => def.matches(row)));
}

/** Toggle one filter chip. */
export function toggleFilter(
  filters: readonly ContactsFilterId[],
  id: ContactsFilterId,
): ContactsFilterId[] {
  return filters.includes(id) ? filters.filter((entry) => entry !== id) : [...filters, id];
}

/** Search by target id, MMSI or vessel name. Case-insensitive substring. */
export function matchesQuery(row: ContactRow, query: string): boolean {
  const needle = (query ?? '').trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    row.kind === 'SAR_TARGET' ? row.id : null,
    row.mmsi,
    row.vesselName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

export function searchRows(rows: readonly ContactRow[], query: string): ContactRow[] {
  if (!(query ?? '').trim()) return [...rows];
  return rows.filter((row) => matchesQuery(row, query));
}

// ---------------------------------------------------------------- handlers

/** The exact function bound to a row's `onClick`. Exported so it is testable. */
export function makeRowActivateHandler(handlers: {
  onSelectTarget?: (id: string | null) => void;
  onSelectMmsi?: (mmsi: string) => void;
}): (row: ContactRow) => void {
  return (row) => {
    // An AIS-only contact has no SAR target, so it never invents a target id.
    if (row.kind === 'SAR_TARGET') handlers.onSelectTarget?.(row.id);
    else handlers.onSelectMmsi?.(row.mmsi);
  };
}

export type RowKeyAction =
  | { readonly type: 'ACTIVATE' }
  | { readonly type: 'CLOSE' }
  | { readonly type: 'NONE' };

/** Enter and Space activate a row. Escape closes the surface. */
export function rowKeyAction(key: string): RowKeyAction {
  if (key === 'Enter' || key === ' ') return { type: 'ACTIVATE' };
  if (key === 'Escape') return { type: 'CLOSE' };
  return { type: 'NONE' };
}

/** The exact handler bound to a row's `onKeyDown`. */
export function makeRowKeyHandler(handlers: {
  activate: (row: ContactRow) => void;
  close: () => void;
}): (event: {
  key: string;
  preventDefault?: () => void;
  /** The row this event came from; React does not expose it on the event. */
  row?: ContactRow;
}) => void {
  return (event) => {
    const action = rowKeyAction(event.key);
    if (action.type === 'ACTIVATE') {
      event.preventDefault?.();
      if (event.row) handlers.activate(event.row);
      return;
    }
    if (action.type === 'CLOSE') handlers.close();
  };
}

/** The exact handler bound to a column header's `onClick`. */
export function makeSortHandler(
  apply: (next: SortState) => void,
): (current: SortState | null) => (column: ContactsColumn) => void {
  return (current) => (column) => apply(nextSortState(current, column));
}

// ------------------------------------------------------------------- cells

/** UI-024: text label + icon, never colour alone. */
export function ClassificationCell({ classification }: { classification: TargetClassification }) {
  const Icon = classificationIcon(classification);
  return (
    <span
      data-df-classification={classification}
      className={`inline-flex items-center gap-1 font-mono text-[10px] ${TONE_TEXT[classificationTone(classification)]}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {classificationLabel(classification)}
    </span>
  );
}

function cellText(row: ContactRow, column: ContactsColumn): string {
  switch (column) {
    case 'CLASSIFICATION':
      return row.kind === 'SAR_TARGET' ? row.classification : NOT_ESTABLISHED;
    case 'ID':
      return row.kind === 'SAR_TARGET' ? row.id : NOT_ESTABLISHED;
    case 'MMSI':
      return row.mmsi ?? NOT_ESTABLISHED;
    case 'VESSEL':
      return row.vesselName ?? NOT_ESTABLISHED;
    case 'LOCATION':
      return formatLatLon(row.lat, row.lon);
    case 'SAR_CONFIDENCE':
      return row.kind === 'SAR_TARGET' ? row.sarConf.toFixed(2) : NOT_ESTABLISHED;
    case 'AIS_CONFIDENCE':
      return row.kind === 'SAR_TARGET' ? row.aisConf.toFixed(2) : NOT_ESTABLISHED;
    case 'APPARENT_LENGTH':
      return row.kind === 'SAR_TARGET' ? formatFootprint(row.lenM, row.lenUncM) : NOT_ESTABLISHED;
    case 'HEADING':
      return row.kind === 'SAR_TARGET' ? formatDegrees(row.hdg) : NOT_ESTABLISHED;
    default:
      return NOT_ESTABLISHED;
  }
}

// ---------------------------------------------------------------- component

export interface ContactsProps {
  /** Backend detections for the active scan. */
  readonly targets?: readonly VesselTarget[] | null;
  /** Backend AIS-only records for the active scan. */
  readonly aisOnly?: readonly AisOnlyTarget[] | null;
  /** Currently selected target id; the matching row is highlighted. */
  readonly selectedTargetId?: string | null;
  /** Called when a SAR row is activated. `null` clears the selection. */
  readonly onSelectTarget?: (id: string | null) => void;
  /** Called when an AIS-only row is activated. */
  readonly onSelectMmsi?: (mmsi: string) => void;
  readonly initialTab?: ContactsTab;
  readonly onClose?: () => void;
}

export function Contacts({
  targets = null,
  aisOnly = null,
  selectedTargetId = null,
  onSelectTarget,
  onSelectMmsi,
  initialTab = 'SAR_TARGETS',
  onClose,
}: ContactsProps): React.ReactElement {
  const [tab, setTab] = useState<ContactsTab>(initialTab);
  const [sort, setSort] = useState<SortState | null>(null);
  const [filters, setFilters] = useState<ContactsFilterId[]>([]);
  const [query, setQuery] = useState('');

  const sarRows = useMemo(() => buildSarRows(targets), [targets]);
  const aisRows = useMemo(() => buildAisRows(aisOnly), [aisOnly]);

  const sourceRows = useMemo<ContactRow[]>(
    () => (tab === 'SAR_TARGETS' ? sarRows : [...aisRows]),
    [tab, sarRows, aisRows],
  );

  const visibleRows = useMemo(
    () => sortRows(searchRows(filterRows(sourceRows, filters), query), sort),
    [sourceRows, filters, query, sort],
  );

  const columns = useMemo(() => columnsForTab(tab), [tab]);

  const activate = useMemo(
    () => makeRowActivateHandler({ onSelectTarget, onSelectMmsi }),
    [onSelectTarget, onSelectMmsi],
  );

  const applySort = useCallback((next: SortState) => setSort(next), []);
  const changeSort = useMemo(() => makeSortHandler(applySort), [applySort]);

  const close = useCallback(() => {
    onClose?.();
  }, [onClose]);

  // Escape closes the surface when it owns one.
  useEffect(() => {
    if (typeof window === 'undefined' || !onClose) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, onClose]);

  const hasAnyData = sarRows.length > 0 || aisRows.length > 0;
  const tabEmpty =
    (tab === 'SAR_TARGETS' && sarRows.length === 0) || (tab === 'AIS_CONTACTS' && aisRows.length === 0);

  return (
    <section
      data-df-contacts
      role="region"
      aria-label="Telemetry contacts"
      className="df-glass-strong flex max-h-[calc(100vh-6rem)] w-[54rem] flex-col rounded-[var(--df-panel-radius)] p-3"
    >
      <header className="mb-2 flex items-center justify-between gap-2 border-b border-[var(--df-border)] pb-2">
        <div role="tablist" aria-label="Contact sources" className="flex gap-1">
          {CONTACTS_TABS.map((entry) => {
            const selected = entry === tab;
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                id={`df-contacts-tab-${entry}`}
                aria-selected={selected}
                aria-controls="df-contacts-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(entry)}
                data-df-contacts-tab={entry}
                className={[
                  'rounded-[6px] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]',
                  'motion-reduce:transition-none',
                  selected
                    ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent)]'
                    : 'text-[var(--df-text-dim)] hover:text-[var(--df-text-secondary)]',
                ].join(' ')}
              >
                {CONTACTS_TAB_LABELS[entry]}
              </button>
            );
          })}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={close}
            aria-label="Close contacts"
            className="rounded-[6px] p-1 text-[var(--df-text-dim)] transition hover:text-[var(--df-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)] motion-reduce:transition-none"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </header>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-[6px] border border-[var(--df-border)] px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--df-text-dim)]" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search contacts by target ID, MMSI or vessel name"
            placeholder="Target ID · MMSI · vessel name"
            className="w-full bg-transparent font-mono text-[11px] text-[var(--df-text)] outline-none placeholder:text-[var(--df-text-dim)]"
          />
        </div>

        <div role="group" aria-label="Filter contacts by classification" className="flex flex-wrap gap-1">
          {CONTACTS_FILTERS.map((filter) => {
            const active = filters.includes(filter.id);
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => setFilters((current) => toggleFilter(current, filter.id))}
                aria-pressed={active}
                aria-label={`Filter: ${filter.label}`}
                data-df-contacts-filter={filter.id}
                className={[
                  'rounded-[6px] border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] transition',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]',
                  'motion-reduce:transition-none',
                  active
                    ? 'border-[var(--df-border-active)] bg-[var(--df-accent-soft)] text-[var(--df-accent)]'
                    : 'border-[var(--df-border)] text-[var(--df-text-dim)] hover:text-[var(--df-text-secondary)]',
                ].join(' ')}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id="df-contacts-panel"
        role="tabpanel"
        aria-labelledby={`df-contacts-tab-${tab}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
      >
        {!hasAnyData ? (
          <EmptyContactsState />
        ) : tabEmpty ? (
          <p data-df-contacts-tab-empty role="status" className="py-4 text-center text-[10px] text-[var(--df-text-dim)]">
            {tab === 'SAR_TARGETS'
              ? 'This scan reported no SAR detections, so there are no targets to list. Nothing was searched, so no row is invented.'
              : 'This scan reported no AIS-only contacts. Nothing is listed because the backend returned none.'}
          </p>
        ) : visibleRows.length === 0 ? (
          <p data-df-contacts-no-match role="status" className="py-4 text-center text-[10px] text-[var(--df-text-dim)]">
            No row matches the current filter and search. Clear them to see the{' '}
            {sourceRows.length} row{sourceRows.length === 1 ? '' : 's'} the backend returned.
          </p>
        ) : (
          <table data-df-contacts-table className="w-full border-collapse text-left">
            <caption className="sr-only">
              {CONTACTS_TAB_LABELS[tab]}, {visibleRows.length} of {sourceRows.length} rows shown
            </caption>
            <thead>
              <tr className="border-b border-[var(--df-border)]">
                {columns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    data-df-contacts-column={column.id}
                    aria-sort={ariaSortFor(sort, column.id)}
                    className="py-1 pr-2 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--df-text-dim)]"
                  >
                    <button
                      type="button"
                      onClick={() => changeSort(sort)(column.id)}
                      aria-label={sortButtonLabel(column, sort)}
                      className="flex items-center gap-1 rounded-[4px] px-1 py-0.5 transition hover:text-[var(--df-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)] motion-reduce:transition-none"
                    >
                      {column.label}
                      <SortIcon column={column.id} sort={sort} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const selected =
                  row.kind === 'SAR_TARGET' && selectedTargetId !== null && row.id === selectedTargetId;
                const keyHandler = makeRowKeyHandler({ activate, close });
                return (
                  <tr
                    key={row.key}
                    data-df-contact-row={row.kind}
                    data-df-contact-id={row.kind === 'SAR_TARGET' ? row.id : row.mmsi}
                    data-df-selected={selected ? 'true' : 'false'}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => activate(row)}
                    onKeyDown={(event) => {
                      // React events do not carry the row; bind it explicitly.
                      keyHandler({ key: event.key, preventDefault: () => event.preventDefault(), row });
                    }}
                    tabIndex={0}
                    className={[
                      'cursor-pointer border-b border-[var(--df-border)] transition',
                      'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--df-accent)]',
                      'motion-reduce:transition-none',
                      selected
                        ? 'bg-[var(--df-accent-soft)] outline outline-1 outline-[var(--df-border-active)]'
                        : 'hover:bg-[var(--df-accent-soft)]',
                    ].join(' ')}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        data-df-contact-cell={column.id}
                        className="py-1 pr-2 align-middle font-mono text-[10px] text-[var(--df-text)]"
                      >
                        {column.id === 'CLASSIFICATION' && row.kind === 'SAR_TARGET' ? (
                          <ClassificationCell classification={row.classification} />
                        ) : (
                          cellText(row, column.id)
                        )}
                        {/* Selection is announced in text, not by colour alone. */}
                        {selected && column.id === columns[0].id && (
                          <span className="sr-only"> (selected)</span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-2 text-[9px] leading-snug text-[var(--df-text-dim)]">
        Values are read from the backend payload. Sorting, filtering and search reorder what is on
        screen; they never change a number.
      </p>
    </section>
  );
}

/** Sort affordance. Glyph AND `aria-sort` carry the state, not colour. */
function SortIcon({ column, sort }: { column: ContactsColumn; sort: SortState | null }) {
  const state = ariaSortFor(sort, column);
  const Icon = state === 'ascending' ? ArrowUp : state === 'descending' ? ArrowDown : ArrowUpDown;
  return <Icon className="h-3 w-3 shrink-0" aria-hidden />;
}

/** Explicit empty state. Never a placeholder row. */
function EmptyContactsState() {
  return (
    <div data-df-contacts-empty className="space-y-2 py-4">
      <p className="flex items-start justify-center gap-1.5 text-[10px] text-[var(--df-text-dim)]">
        <Ruler className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        No scan targets have been loaded, so there is nothing to list.
      </p>
      <p className="text-center text-[10px] leading-snug text-[var(--df-text-dim)]">
        Run a scan from the command dock, or select one, and the backend detections and AIS contacts
        for it appear here. No row is shown for a scan that has not run.
      </p>
      <p className="flex items-start justify-center gap-1.5 text-[10px] text-[var(--df-text-dim)]">
        <Ship className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        The surface stays empty on purpose: a placeholder contact would be invented data.
      </p>
      <p className="flex items-start justify-center gap-1.5 text-[10px] text-[var(--df-text-dim)]">
        <Radio className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        Every contact below would otherwise come from a source, and no source has reported.
      </p>
    </div>
  );
}

export default Contacts;