/**
 * Contacts surface tests (UI-021, UI-024).
 *
 * DOM-free by design, matching `src/search/SpatialSearch.test.tsx`: vitest runs
 * in a `node` environment with no jsdom, so markup comes from
 * `react-dom/server` and every interaction path goes through an exported pure
 * function or handler factory. Selection is fully prop-driven, so the surface is
 * exercised without Cesium and without a network.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONTACT_COLUMNS,
  CONTACTS_FILTERS,
  CONTACTS_TABS,
  NOT_ESTABLISHED,
  Contacts,
  ClassificationCell,
  ariaSortFor,
  buildAisRows,
  buildSarRows,
  columnsForTab,
  compareRows,
  filterRows,
  matchesQuery,
  makeRowActivateHandler,
  makeRowKeyHandler,
  makeSortHandler,
  nextSortState,
  rowKeyAction,
  searchRows,
  sortRows,
  toggleFilter,
} from './Contacts.tsx';
import type { ContactRow, SortState } from './Contacts.tsx';
import type { AisOnlyTarget, TargetClassification, VesselTarget } from '../types/api.ts';

// ------------------------------------------------------------------ fixtures

function target(overrides: Partial<VesselTarget> = {}): VesselTarget {
  return {
    id: 'DF-001',
    classification: 'SAR_MATCHED_AIS',
    lat: 1.2644,
    lon: 103.84,
    sarConf: 0.9,
    aisConf: 0.8,
    lenM: 88,
    widM: 12,
    lenUncM: 6,
    hdg: 90,
    wake: false,
    meanDb: -14.2,
    maxDb: 3.1,
    area: 41,
    corr: {
      matched: true,
      mmsi: '563000111',
      vesselName: 'STELLAR',
      distanceOffsetMeters: 120,
      timeDeltaSeconds: -90,
      predictedLat: 1.2651,
      predictedLon: 103.8422,
      aisAssociationConfidence: 0.8,
      scoreDecomposition: null,
    },
    assessment: '',
    tags: [],
    ...overrides,
  };
}

const UNMATCHED = target({
  id: 'DF-002',
  classification: 'SAR_UNMATCHED',
  sarConf: 0.55,
  aisConf: 0,
  corr: {
    matched: false,
    mmsi: null,
    vesselName: null,
    distanceOffsetMeters: null,
    timeDeltaSeconds: null,
    predictedLat: null,
    predictedLon: null,
    aisAssociationConfidence: 0,
    scoreDecomposition: null,
  },
});

const PLATFORM = target({
  id: 'DF-003',
  classification: 'STATIONARY_OR_INFRASTRUCTURE',
  sarConf: 0.7,
  aisConf: 0,
  lenM: 40,
  corr: { ...target().corr, matched: false, mmsi: null, vesselName: null },
});

const CLUTTER = target({
  id: 'DF-004',
  classification: 'SEA_CLUTTER',
  sarConf: 0.4,
  aisConf: 0,
  lenM: 12,
  corr: { ...target().corr, matched: false, mmsi: null, vesselName: null },
});

const WEAK = target({
  id: 'DF-005',
  classification: 'LOW_CONFIDENCE',
  sarConf: 0.42,
  aisConf: 0.35,
  lenM: 70,
  corr: { ...target().corr, matched: false, mmsi: '563000999', vesselName: 'ORION' },
});

const TARGETS = [target(), UNMATCHED, PLATFORM, CLUTTER, WEAK];

const AIS_ONLY: AisOnlyTarget[] = [
  {
    cls: 'AIS_ONLY',
    mmsi: '563000777',
    vesselName: 'MERIDIAN',
    lat: 1.3,
    lon: 103.9,
    timestamp: '2026-02-01T12:00:00Z',
  },
  {
    cls: 'AIS_ONLY',
    mmsi: '563000888',
    vesselName: null,
    lat: 1.31,
    lon: 103.91,
    timestamp: '2026-02-01T12:01:00Z',
  },
];

const ROWS = buildSarRows(TARGETS);

// ----------------------------------------------------------------- utilities

function render(props: Partial<Parameters<typeof Contacts>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(Contacts, { targets: TARGETS, aisOnly: AIS_ONLY, ...props }),
  );
}

function idsOf(html: string): string[] {
  return [...html.matchAll(/data-df-contact-id="([^"]*)"/g)].map((match) => match[1]);
}

function unnamedControls(html: string): string[] {
  const failures: string[] = [];
  const open = /<(button|a|input|select|textarea)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const close = html.indexOf(`</${tag}`, match.index + match[0].length);
    const inner = close === -1 ? '' : html.slice(match.index + match[0].length, close);
    let name = /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (!name && /aria-labelledby="([^"]*)"/.test(attrs)) name = 'labelledby';
    if (!name) {
      const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
      if (id && html.includes(`for="${id}"`)) name = 'label';
    }
    if (!name) name = inner.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim();
    if (!name) failures.push(`${tag} ${match[0].slice(0, 90)}`);
  }
  return failures;
}

// ------------------------------------------------------------------- rows

describe('row builders', () => {
  it('passes every backend field through unchanged', () => {
    const [row] = buildSarRows([target()]);
    expect(row).toMatchObject({
      kind: 'SAR_TARGET',
      id: 'DF-001',
      classification: 'SAR_MATCHED_AIS',
      mmsi: '563000111',
      vesselName: 'STELLAR',
      sarConf: 0.9,
      aisConf: 0.8,
      lenM: 88,
      lenUncM: 6,
      hdg: 90,
    });
  });

  it('keeps a null MMSI null rather than coercing it', () => {
    const [row] = buildSarRows([UNMATCHED]);
    expect(row.mmsi).toBeNull();
    expect(row.vesselName).toBeNull();
  });

  it('builds AIS-only rows with a unique key per record', () => {
    const rows = buildAisRows(AIS_ONLY);
    expect(rows.map((row) => row.mmsi)).toEqual(['563000777', '563000888']);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('returns nothing for an absent payload instead of inventing rows', () => {
    expect(buildSarRows(null)).toEqual([]);
    expect(buildAisRows(undefined)).toEqual([]);
  });
});

// ----------------------------------------------------------------- sorting

describe('sorting', () => {
  it('starts ascending on a new column and toggles direction on a repeat click', () => {
    expect(nextSortState(null, 'SAR_CONFIDENCE')).toEqual({ column: 'SAR_CONFIDENCE', direction: 'asc' });
    expect(nextSortState({ column: 'SAR_CONFIDENCE', direction: 'asc' }, 'SAR_CONFIDENCE')).toEqual({
      column: 'SAR_CONFIDENCE',
      direction: 'desc',
    });
    expect(nextSortState({ column: 'SAR_CONFIDENCE', direction: 'desc' }, 'SAR_CONFIDENCE')).toEqual({
      column: 'SAR_CONFIDENCE',
      direction: 'asc',
    });
    expect(nextSortState({ column: 'SAR_CONFIDENCE', direction: 'asc' }, 'HEADING')).toEqual({
      column: 'HEADING',
      direction: 'asc',
    });
  });

  it('sorts ascending and descending on the same column', () => {
    const asc = sortRows(ROWS, { column: 'SAR_CONFIDENCE', direction: 'asc' });
    expect(asc.map((row) => (row as { sarConf: number }).sarConf)).toEqual([0.4, 0.42, 0.55, 0.7, 0.9]);

    const desc = sortRows(ROWS, { column: 'SAR_CONFIDENCE', direction: 'desc' });
    expect(desc.map((row) => (row as { sarConf: number }).sarConf)).toEqual([0.9, 0.7, 0.55, 0.42, 0.4]);
  });

  it('sorts text columns case-insensitively and keeps missing values last', () => {
    const ais = buildAisRows(AIS_ONLY);
    expect(sortRows(ais, { column: 'VESSEL', direction: 'asc' }).map((row) => row.mmsi)).toEqual([
      '563000777',
      '563000888',
    ]);
    expect(sortRows(ais, { column: 'VESSEL', direction: 'desc' }).map((row) => row.mmsi)).toEqual([
      '563000888',
      '563000777',
    ]);
  });

  it('sorts apparent length, which keeps its uncertainty in the rendered cell', () => {
    const order = sortRows(ROWS, { column: 'APPARENT_LENGTH', direction: 'asc' }).map((row) =>
      (row as { id: string }).id,
    );
    expect(order).toEqual(['DF-004', 'DF-003', 'DF-005', 'DF-001', 'DF-002']);
  });

  it('is deterministic and does not mutate its input', () => {
    const before = ROWS.map((row) => row.key);
    const first = sortRows(ROWS, { column: 'LOCATION', direction: 'desc' }).map((row) => row.key);
    const second = sortRows(ROWS, { column: 'LOCATION', direction: 'desc' }).map((row) => row.key);
    expect(first).toEqual(second);
    expect(ROWS.map((row) => row.key)).toEqual(before);
  });

  it('preserves input order when unsorted', () => {
    expect(sortRows(ROWS, null).map((row) => row.key)).toEqual(ROWS.map((row) => row.key));
  });

  it('sorts equal values by key so the order never flickers', () => {
    const tied: ContactRow[] = [
      { ...ROWS[0], key: 'B' },
      { ...ROWS[0], key: 'A' },
    ];
    expect(compareRows(tied[0], tied[1], 'SAR_CONFIDENCE')).toBeGreaterThan(0);
    expect(sortRows(tied, { column: 'SAR_CONFIDENCE', direction: 'asc' }).map((row) => row.key)).toEqual([
      'A',
      'B',
    ]);
  });

  it('drives the sort through the bound header handler', () => {
    const apply = vi.fn();
    const changeSort = makeSortHandler(apply);
    changeSort({ column: 'HEADING', direction: 'desc' })('SAR_CONFIDENCE');
    expect(apply).toHaveBeenCalledWith({ column: 'SAR_CONFIDENCE', direction: 'asc' });
    changeSort({ column: 'SAR_CONFIDENCE', direction: 'asc' })('SAR_CONFIDENCE');
    expect(apply).toHaveBeenLastCalledWith({ column: 'SAR_CONFIDENCE', direction: 'desc' });
  });
});

// ----------------------------------------------------------------- filters

describe('filters', () => {
  it('offers exactly the five required facets', () => {
    expect(CONTACTS_FILTERS.map((filter) => filter.id)).toEqual([
      'MATCHED',
      'UNMATCHED',
      'AIS_ONLY',
      'INFRASTRUCTURE',
      'LOW_CONFIDENCE',
    ]);
  });

  it('keeps only the rows of the selected class', () => {
    const cases: Array<[Parameters<typeof filterRows>[1][number], string[]]> = [
      ['MATCHED', ['DF-001']],
      ['UNMATCHED', ['DF-002']],
      ['INFRASTRUCTURE', ['DF-003']],
      ['LOW_CONFIDENCE', ['DF-005']],
    ];
    for (const [id, expected] of cases) {
      const filtered = filterRows(ROWS, [id]);
      expect(filtered.map((row) => (row as { id: string }).id)).toEqual(expected);
    }
  });

  it('includes AIS-only rows under the AIS-only facet', () => {
    const all: ContactRow[] = [...ROWS, ...buildAisRows(AIS_ONLY)];
    const filtered = filterRows(all, ['AIS_ONLY']);
    expect(filtered.map((row) => row.mmsi)).toEqual(['563000777', '563000888']);
  });

  it('combines selected facets as a union, never an empty intersection', () => {
    const filtered = filterRows(ROWS, ['MATCHED', 'INFRASTRUCTURE']);
    expect(filtered.map((row) => (row as { id: string }).id)).toEqual(['DF-001', 'DF-003']);
  });

  it('passes everything through when nothing is selected', () => {
    expect(filterRows(ROWS, [])).toHaveLength(ROWS.length);
  });

  it('toggles a facet on and back off', () => {
    const on = toggleFilter([], 'MATCHED');
    expect(on).toEqual(['MATCHED']);
    expect(toggleFilter(on, 'MATCHED')).toEqual([]);
  });
});

// ------------------------------------------------------------------ search

describe('search', () => {
  it('matches target id, MMSI and vessel name, case-insensitively', () => {
    expect(matchesQuery(ROWS[0], 'df-002')).toBe(false);
    expect(matchesQuery(ROWS[1], 'DF-002')).toBe(true);
    expect(matchesQuery(ROWS[0], '563000111')).toBe(true);
    expect(matchesQuery(ROWS[0], 'stellar')).toBe(true);
    expect(matchesQuery(ROWS[1], 'STELLAR')).toBe(false);
  });

  it('matches an AIS-only row by MMSI', () => {
    const [row] = buildAisRows(AIS_ONLY);
    expect(matchesQuery(row, '563000777')).toBe(true);
    expect(matchesQuery(row, 'meridian')).toBe(true);
  });

  it('treats an empty query as no filter rather than as a non-match', () => {
    expect(searchRows(ROWS, '')).toHaveLength(ROWS.length);
    expect(searchRows(ROWS, '   ')).toHaveLength(ROWS.length);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchRows(ROWS, 'zzzz-nothing')).toEqual([]);
  });
});

// -------------------------------------------------------------- selection

describe('bidirectional selection', () => {
  it('reports the target id upward when a SAR row is activated', () => {
    const onSelectTarget = vi.fn();
    const activate = makeRowActivateHandler({ onSelectTarget });
    activate(ROWS[1]);
    expect(onSelectTarget).toHaveBeenCalledWith('DF-002');
  });

  it('never invents a target id for an AIS-only row', () => {
    const onSelectTarget = vi.fn();
    const onSelectMmsi = vi.fn();
    const activate = makeRowActivateHandler({ onSelectTarget, onSelectMmsi });
    activate(buildAisRows(AIS_ONLY)[0]);
    expect(onSelectTarget).not.toHaveBeenCalled();
    expect(onSelectMmsi).toHaveBeenCalledWith('563000777');
  });

  it('activates on Enter and Space, and closes on Escape', () => {
    expect(rowKeyAction('Enter')).toEqual({ type: 'ACTIVATE' });
    expect(rowKeyAction(' ')).toEqual({ type: 'ACTIVATE' });
    expect(rowKeyAction('Escape')).toEqual({ type: 'CLOSE' });
    expect(rowKeyAction('a')).toEqual({ type: 'NONE' });
  });

  it('drives activation and close through the bound key handler', () => {
    const activate = vi.fn();
    const close = vi.fn();
    const preventDefault = vi.fn();
    const handler = makeRowKeyHandler({ activate, close });

    handler({ key: 'Enter', preventDefault, row: ROWS[2] });
    expect(activate).toHaveBeenCalledWith(ROWS[2]);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    handler({ key: 'Escape', preventDefault, row: ROWS[2] });
    expect(close).toHaveBeenCalledTimes(1);

    handler({ key: 'q', preventDefault, row: ROWS[2] });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('highlights the row the caller selected, and only that row', () => {
    const html = render({ selectedTargetId: 'DF-003' });
    const rows = [...html.matchAll(/data-df-contact-id="([^"]*)" data-df-selected="([^"]*)"/g)];
    expect(rows.map((match) => `${match[1]}:${match[2]}`)).toEqual([
      'DF-001:false',
      'DF-002:false',
      'DF-003:true',
      'DF-004:false',
      'DF-005:false',
    ]);
    expect(html).toContain('aria-current="true"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('(selected)');
  });

  it('highlights nothing when no target is selected', () => {
    const html = render({ selectedTargetId: null });
    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toContain('data-df-selected="true"');
  });

  it('marks rows keyboard reachable', () => {
    expect(render()).toContain('tabindex="0"');
  });
});

// ----------------------------------------------------- non-colour status

describe('status differentiation (UI-024)', () => {
  it('gives every classification a text label and an icon in the markup', () => {
    const html = render();
    for (const classification of [
      'SAR_MATCHED_AIS',
      'SAR_UNMATCHED',
      'STATIONARY_OR_INFRASTRUCTURE',
      'SEA_CLUTTER',
      'LOW_CONFIDENCE',
    ] as TargetClassification[]) {
      expect(html).toContain(`data-df-classification="${classification}"`);
    }
    expect(html).toContain('SAR matched to AIS');
    expect(html).toContain('SAR return, unmatched');
    expect(html).toContain('Stationary return or infrastructure');
    expect(html).toContain('Sea clutter return');
    expect(html).toContain('Low confidence return');
  });

  it('renders an icon alongside the label, never colour alone', () => {
    const html = renderToStaticMarkup(
      createElement(ClassificationCell, { classification: 'SAR_UNMATCHED' }),
    );
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('SAR return, unmatched');
  });

  it('gives each classification its own icon', () => {
    const iconOf = (classification: TargetClassification): string =>
      /lucide lucide-([a-z-]+)/.exec(
        renderToStaticMarkup(createElement(ClassificationCell, { classification })),
      )?.[1] ?? '';

    const seen = (Object.keys({
      SAR_MATCHED_AIS: 1,
      SAR_UNMATCHED: 1,
      AIS_ONLY: 1,
      STATIONARY_OR_INFRASTRUCTURE: 1,
      SEA_CLUTTER: 1,
      LOW_CONFIDENCE: 1,
      UNRESOLVED: 1,
    }) as TargetClassification[]).map(iconOf);

    for (const icon of seen) expect(icon.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('renders a distinct icon per row inside the table markup', () => {
    const icons = [
      ...render().matchAll(/data-df-classification="[A-Z_]+"[^>]*>\s*<svg[^>]*lucide lucide-([a-z-]+)/g),
    ];
    expect(icons.map((match) => match[1])).toEqual([
      'circle-check',
      'circle-slash',
      'anchor',
      'waves',
      'triangle-alert',
    ]);
  });
});

// ---------------------------------------------------------------- columns

describe('columns', () => {
  it('gives the SAR tab the detection columns', () => {
    expect(columnsForTab('SAR_TARGETS').map((column) => column.id)).toEqual([
      'CLASSIFICATION',
      'ID',
      'MMSI',
      'VESSEL',
      'LOCATION',
      'SAR_CONFIDENCE',
      'AIS_CONFIDENCE',
      'APPARENT_LENGTH',
      'HEADING',
    ]);
  });

  it('gives the AIS tab only the columns that exist on an AIS record', () => {
    expect(columnsForTab('AIS_CONTACTS').map((column) => column.id)).toEqual([
      'MMSI',
      'VESSEL',
      'LOCATION',
    ]);
  });

  it('gives every column a non-empty label', () => {
    for (const column of CONTACT_COLUMNS) expect(column.label.length).toBeGreaterThan(0);
  });

  it('reports an unsorted column honestly', () => {
    const sort: SortState = { column: 'HEADING', direction: 'desc' };
    expect(ariaSortFor(sort, 'HEADING')).toBe('descending');
    expect(ariaSortFor(sort, 'MMSI')).toBe('none');
    expect(ariaSortFor(null, 'HEADING')).toBe('none');
  });
});

// ---------------------------------------------------------------- markup

describe('Contacts markup', () => {
  it('exposes the two tabs with proper roles', () => {
    const html = render();
    expect([...CONTACTS_TABS]).toEqual(['SAR_TARGETS', 'AIS_CONTACTS']);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('data-df-contacts-tab="SAR_TARGETS"');
    expect(html).toContain('data-df-contacts-tab="AIS_CONTACTS"');
    expect(html).toContain('SAR targets');
    expect(html).toContain('AIS contacts');
  });

  it('renders one row per backend detection with sortable headers', () => {
    const html = render();
    expect(html).toContain('data-df-contacts-table');
    expect(idsOf(html)).toEqual(['DF-001', 'DF-002', 'DF-003', 'DF-004', 'DF-005']);
    for (const column of CONTACT_COLUMNS) {
      if (column.tabs && !column.tabs.includes('SAR_TARGETS')) continue;
      expect(html).toContain(`data-df-contacts-column="${column.id}"`);
    }
    expect(html.match(/aria-sort="none"/g)?.length).toBe(9);
  });

  it('renders the AIS-only tab from the AIS payload', () => {
    const html = render({ initialTab: 'AIS_CONTACTS' });
    expect(idsOf(html)).toEqual(['563000777', '563000888']);
    expect(html).toContain('MERIDIAN');
    expect(html).not.toContain('DF-001');
    expect(html).not.toContain('data-df-contacts-column="HEADING"');
  });

  it('renders "not established" for an absent vessel name, never an empty cell', () => {
    const html = render({ initialTab: 'AIS_CONTACTS' });
    expect(html).toContain(NOT_ESTABLISHED);
    expect(html).not.toContain('>null<');
    expect(html).not.toContain('>undefined<');
  });

  it('explains an empty payload instead of adding a placeholder row', () => {
    const html = render({ targets: null, aisOnly: null });
    expect(html).toContain('data-df-contacts-empty');
    expect(html).toContain('No scan targets have been loaded');
    expect(html).toContain('a placeholder contact would be invented data');
    expect(html).not.toContain('data-df-contacts-table');
    expect(html).not.toContain('data-df-contact-row');
    expect(html).not.toContain('<tr');
  });

  it('explains an empty tab separately from an empty scan', () => {
    // Targets exist, so the SAR tab lists them: no scan-level empty state.
    const sarTab = render({ aisOnly: [] });
    expect(sarTab).not.toContain('data-df-contacts-empty');
    expect(sarTab).toContain('data-df-contacts-table');

    // The AIS tab is empty for this scan and says so, without a placeholder row.
    const aisTab = render({ initialTab: 'AIS_CONTACTS', aisOnly: [] });
    expect(aisTab).toContain('data-df-contacts-tab-empty');
    expect(aisTab).toContain('the backend returned none');
    expect(aisTab).not.toContain('<tr');
    expect(aisTab).not.toContain('data-df-contact-row');
  });

  it('labels the search box and the filter group', () => {
    const html = render();
    expect(html).toContain('aria-label="Search contacts by target ID, MMSI or vessel name"');
    expect(html).toContain('aria-label="Filter contacts by classification"');
    for (const filter of CONTACTS_FILTERS) {
      expect(html).toContain(`aria-label="Filter: ${filter.label}"`);
    }
  });

  it('announces the sort direction in every header control name', () => {
    const html = render();
    expect(html).toContain('aria-label="Sort by Target ID"');
    expect(html).toContain('aria-label="Sort by SAR conf."');
    expect(html).not.toContain('currently ascending');
  });

  it('gives every icon-only control an accessible name on both tabs', () => {
    expect(unnamedControls(render())).toEqual([]);
    expect(unnamedControls(render({ initialTab: 'AIS_CONTACTS' }))).toEqual([]);
    expect(unnamedControls(render({ targets: null, aisOnly: null }))).toEqual([]);
    expect(unnamedControls(render({ targets: [], aisOnly: [] }))).toEqual([]);
  });

  it('respects reduced motion on every animated control', () => {
    const animated = render().match(/class="[^"]*\btransition\b[^"]*"/g) ?? [];
    expect(animated.length).toBeGreaterThan(0);
    for (const cls of animated) expect(cls).toContain('motion-reduce:transition-none');
  });

  it('names the close control when the surface is closeable', () => {
    expect(render()).not.toContain('Close contacts');
    expect(render({ onClose: () => undefined })).toContain('aria-label="Close contacts"');
  });
});