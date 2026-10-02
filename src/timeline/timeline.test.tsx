/**
 * Timeline tests (UI-013, UI-024) plus the shared presentation vocabulary that
 * `TargetInspector` and `Contacts` also depend on.
 *
 * DOM-free by design, matching `src/search/SpatialSearch.test.tsx`: vitest runs
 * in a `node` environment with no jsdom, so markup comes from
 * `react-dom/server` and every interaction path goes through an exported pure
 * function or handler factory. No network: payloads are literals.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FORBIDDEN_UNMATCHED_TERMS,
  MULTIPASS_UNAVAILABLE,
  NO_ASSOCIATION_STATEMENT,
  NOT_ESTABLISHED,
  WAKE_GEOMETRY_SOURCE,
  WAKE_GEOMETRY_UNAVAILABLE,
  Timeline,
  buildTimelineEvents,
  clampScrubIndex,
  correlationWindowLabel,
  formatConfidence,
  formatDb,
  formatDegrees,
  formatDeltaSeconds,
  formatFootprint,
  formatKnots,
  formatLatLon,
  formatMeters,
  sortEvents,
  timelineInstants,
  timelinePosition,
  timelineSpan,
} from './Timeline.tsx';
import type { AisObservation, TimelineScanInput, TimelineTarget } from './Timeline.tsx';

// ------------------------------------------------------------------ payload

const ACQ = '2026-02-01T12:00:00Z';

const MATCHED: TimelineTarget = {
  id: 'DF-001',
  classification: 'SAR_MATCHED_AIS',
  corr: {
    matched: true,
    mmsi: '563000111',
    vesselName: 'STELLAR',
    distanceOffsetMeters: 120,
    timeDeltaSeconds: -90,
    predictedLat: 1.2651,
    predictedLon: 103.8422,
    scoreDecomposition: { matchRadiusMeters: 1200 },
  },
};

const UNMATCHED: TimelineTarget = {
  id: 'DF-002',
  classification: 'SAR_UNMATCHED',
  corr: {
    matched: false,
    mmsi: null,
    vesselName: null,
    distanceOffsetMeters: null,
    timeDeltaSeconds: null,
    predictedLat: null,
    predictedLon: null,
    scoreDecomposition: null,
  },
};

const OBSERVATIONS: AisObservation[] = [
  {
    mmsi: '563000111',
    timestamp: '2026-02-01T11:52:00Z', // acquisition - 480 s
    lat: 1.26,
    lon: 103.83,
    sog: 6.2,
    cog: 88,
    heading: 88,
    source: 'ais_archive',
  },
  {
    mmsi: '563000111',
    timestamp: '2026-02-01T12:05:00Z', // acquisition + 300 s
    lat: 1.27,
    lon: 103.85,
    sog: 6.4,
    cog: 90,
    heading: 90,
    source: 'ais_archive',
  },
  { mmsi: '999999999', timestamp: '2026-02-01T12:02:00Z', lat: 9, lon: 9 },
];

const SCAN: TimelineScanInput = {
  scan_id: 'DF-0001',
  acquisition_time: ACQ,
  scene: { acquisition_time: ACQ, item_id: 'SIM-S1C-001', polarization: 'VV', product: 'GRD' },
  targets: [MATCHED, UNMATCHED],
  ais_observations: OBSERVATIONS,
};

// -------------------------------------------------------------------- order

describe('buildTimelineEvents', () => {
  it('orders events by instant and labels every Δt', () => {
    const events = buildTimelineEvents(SCAN, 'DF-001');
    expect(events.map((event) => `${event.kind}@${event.deltaLabel}`)).toEqual([
      'AIS_OBSERVATION@-480 s',
      'SAR_ACQUISITION@0 s',
      'PROJECTED_POSITION@0 s',
      'AIS_OBSERVATION@+300 s',
    ]);
  });

  it('places the acquisition before the projection at the same instant', () => {
    const events = buildTimelineEvents(SCAN, 'DF-001');
    const sameInstant = events.filter((event) => event.deltaSeconds === 0);
    expect(sameInstant.map((event) => event.kind)).toEqual(['SAR_ACQUISITION', 'PROJECTED_POSITION']);
  });

  it('returns the events already sorted, so sortEvents is a no-op on them', () => {
    const events = buildTimelineEvents(SCAN, 'DF-001');
    expect(sortEvents(events).map((event) => event.key)).toEqual(events.map((event) => event.key));
  });

  it('never invents an AIS observation for an unassociated target', () => {
    const events = buildTimelineEvents(SCAN, 'DF-002');
    expect(events.map((event) => event.kind)).toEqual(['SAR_ACQUISITION']);
    expect(events.some((event) => event.kind === 'AIS_OBSERVATION')).toBe(false);
    expect(events.some((event) => event.kind === 'PROJECTED_POSITION')).toBe(false);
  });

  it('omits observations belonging to a different MMSI', () => {
    const events = buildTimelineEvents(SCAN, 'DF-001');
    expect(events.filter((e) => e.kind === 'AIS_OBSERVATION').every((e) => e.mmsi === '563000111')).toBe(
      true,
    );
  });

  it('still shows the acquisition for an unknown or absent target id', () => {
    expect(buildTimelineEvents(SCAN, 'DF-999').map((e) => e.kind)).toEqual(['SAR_ACQUISITION']);
    expect(buildTimelineEvents(SCAN, null).map((e) => e.kind)).toEqual(['SAR_ACQUISITION']);
    expect(buildTimelineEvents(null, 'DF-001')).toEqual([]);
  });

  it('drops the projection when the backend sent no predicted position', () => {
    const partial: TimelineScanInput = {
      ...SCAN,
      targets: [{ ...MATCHED, corr: { ...MATCHED.corr, predictedLat: null, predictedLon: null } }],
    };
    expect(buildTimelineEvents(partial, 'DF-001').some((e) => e.kind === 'PROJECTED_POSITION')).toBe(false);
  });

  it('keeps an unparseable acquisition stamp verbatim instead of faking a time', () => {
    const events = buildTimelineEvents(
      { scene: { acquisition_time: 'not-a-date' }, targets: [] },
      null,
    );
    expect(events).toHaveLength(1);
    expect(events[0].atMs).toBeNull();
    expect(events[0].atLabel).toBe('not-a-date');
  });

  it('produces a deterministic key per event', () => {
    const keys = buildTimelineEvents(SCAN, 'DF-001').map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------- correlation window

describe('correlationWindowLabel', () => {
  it('states the achieved offset and the applied radius for an association', () => {
    const label = correlationWindowLabel(MATCHED);
    expect(label).toContain('achieved Δt -90 s');
    expect(label).toContain('match radius 1200 m');
  });

  it('uses the neutral sentence when no association was established', () => {
    expect(correlationWindowLabel(UNMATCHED)).toBe(NO_ASSOCIATION_STATEMENT);
    expect(correlationWindowLabel(null)).toBe(NO_ASSOCIATION_STATEMENT);
  });

  it('says not established rather than guessing the backend window', () => {
    const bare: TimelineTarget = { id: 'DF-003', corr: { matched: false, mmsi: '111222333' } };
    expect(correlationWindowLabel(bare)).toBe(NOT_ESTABLISHED);
  });

  it('is neutral: no forbidden wording anywhere in the unmatched label', () => {
    const lower = correlationWindowLabel(UNMATCHED).toLowerCase();
    for (const term of FORBIDDEN_UNMATCHED_TERMS) expect(lower).not.toContain(term);
  });
});

// -------------------------------------------------------------- span & scrub

describe('timeline span', () => {
  it('reports the distinct instants that exist, ascending', () => {
    expect(timelineInstants(buildTimelineEvents(SCAN, 'DF-001'))).toEqual([
      Date.parse('2026-02-01T11:52:00Z'),
      Date.parse(ACQ),
      Date.parse('2026-02-01T12:05:00Z'),
    ]);
  });

  it('marks a single acquisition as un-scrubbable', () => {
    const span = timelineSpan(buildTimelineEvents(SCAN, 'DF-002'));
    expect(span.stepCount).toBe(1);
    expect(span.singleInstant).toBe(true);
  });

  it('reports nothing to scrub when no instant was established', () => {
    const span = timelineSpan([]);
    expect(span).toEqual({ startMs: null, endMs: null, stepCount: 0, singleInstant: true });
  });

  it('positions instants on the track and clamps the scrub index', () => {
    const span = timelineSpan(buildTimelineEvents(SCAN, 'DF-001'));
    expect(timelinePosition(span.startMs, span)).toBe(0);
    expect(timelinePosition(span.endMs, span)).toBe(100);
    expect(timelinePosition(span.startMs, { ...span, startMs: 5, endMs: 5 })).toBe(50);
    expect(timelinePosition(null, span)).toBeNull();

    expect(clampScrubIndex('0', 3)).toBe(0);
    expect(clampScrubIndex('9', 3)).toBe(2);
    expect(clampScrubIndex('-4', 3)).toBe(0);
    expect(clampScrubIndex('nonsense', 3)).toBe(0);
    expect(clampScrubIndex(1, 0)).toBe(0);
  });
});

// --------------------------------------------------------------- formatters

describe('presentation vocabulary', () => {
  it('renders every missing value as "not established", never as a zero', () => {
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 'x']) {
      expect(formatMeters(value)).toBe(NOT_ESTABLISHED);
      expect(formatDegrees(value)).toBe(NOT_ESTABLISHED);
      expect(formatDb(value)).toBe(NOT_ESTABLISHED);
      expect(formatConfidence(value)).toBe(NOT_ESTABLISHED);
      expect(formatFootprint(value, value)).toBe(NOT_ESTABLISHED);
      expect(formatKnots(value)).toBe(NOT_ESTABLISHED);
      expect(formatDeltaSeconds(value)).toBe(NOT_ESTABLISHED);
      expect(formatLatLon(value, 1)).toBe(NOT_ESTABLISHED);
      expect(formatLatLon(1, value)).toBe(NOT_ESTABLISHED);
    }
  });

  it('keeps a genuine zero distinct from a missing value', () => {
    expect(formatMeters(0)).toBe('0 m');
    expect(formatDeltaSeconds(0)).toBe('0 s');
    expect(formatDegrees(0)).toBe('000°');
  });

  it('formats dimensions with their uncertainty and without inventing one', () => {
    expect(formatFootprint(88, 6)).toBe('88 m ±6 m');
    expect(formatFootprint(88, null)).toBe('88 m');
    expect(formatMeters(10, 2)).toBe('10.00 m');
  });

  it('signs Δt and rounds it to whole seconds', () => {
    expect(formatDeltaSeconds(-90)).toBe('-90 s');
    expect(formatDeltaSeconds(300.4)).toBe('+300 s');
  });

  it('wraps heading into 0..360 and labels hemispheres', () => {
    expect(formatDegrees(370)).toBe('010°');
    expect(formatDegrees(-10)).toBe('350°');
    expect(formatLatLon(-1.2644, -103.84)).toBe('1.2644° S, 103.8400° W');
  });

  it('names the gated advanced layers instead of drawing them', () => {
    expect(WAKE_GEOMETRY_UNAVAILABLE).toContain(WAKE_GEOMETRY_SOURCE);
    expect(MULTIPASS_UNAVAILABLE).toContain('ADV-001');
  });
});

// ------------------------------------------------------------------ markup

/** Every control must expose a name via aria-label, aria-labelledby or a <label>. */
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

describe('Timeline markup', () => {
  const render = (props: Partial<Parameters<typeof Timeline>[0]> = {}): string =>
    renderToStaticMarkup(createElement(Timeline, { scan: SCAN, targetId: 'DF-001', ...props }));

  it('draws the acquisition tick with a Δt of zero', () => {
    const html = render();
    expect(html).toContain('data-df-timeline-event="SAR_ACQUISITION"');
    expect(html).toContain('data-df-timeline-delta="0 s"');
    expect(html).toContain('2026-02-01 12:00:00Z');
  });

  it('labels each observation with its signed offset from acquisition', () => {
    const html = render();
    expect(html).toContain('data-df-timeline-delta="-480 s"');
    expect(html).toContain('data-df-timeline-delta="+300 s"');
  });

  it('offers no playback and no invented progress', () => {
    const html = render();
    expect(html).not.toContain('<video');
    expect(html).not.toContain('requestAnimationFrame');
    expect(html).toContain('The timeline never advances on its own.');
  });

  it('scrubs only over instants that exist', () => {
    const html = render();
    expect(html).toContain('data-df-timeline-scrub');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="2"'); // three distinct instants, not a duration
  });

  it('says so instead of animating when a single acquisition exists', () => {
    const html = render({ targetId: 'DF-002' });
    expect(html).toContain('data-df-timeline-single');
    expect(html).toContain('Single acquisition');
    expect(html).not.toContain('data-df-timeline-scrub');
    expect(html).not.toContain('<input');
  });

  it('states the neutral association sentence and no forbidden wording', () => {
    const html = render({ targetId: 'DF-002' }).toLowerCase();
    expect(html).toContain(NO_ASSOCIATION_STATEMENT.toLowerCase());
    for (const term of FORBIDDEN_UNMATCHED_TERMS) expect(html).not.toContain(term);
  });

  it('draws the correlation window band only when observations exist', () => {
    expect(render()).toContain('data-df-timeline-window');
    expect(render({ targetId: 'DF-002' })).not.toContain('data-df-timeline-window');
  });

  it('explains itself when no acquisition time was established', () => {
    const html = render({ scan: null, targetId: null });
    expect(html).toContain('No acquisition time is established');
    expect(html).not.toContain('data-df-timeline-track');
  });

  it('gives every control an accessible name', () => {
    expect(unnamedControls(render())).toEqual([]);
    expect(unnamedControls(render({ targetId: 'DF-002' }))).toEqual([]);
    expect(unnamedControls(render({ scan: null }))).toEqual([]);
  });
});

// ----------------------------------------------------- source-level guards

describe('no fabricated motion', () => {
  // Comments are stripped first: the guard is about CODE, not about this file
  // describing the absence of timers in its own header comment.
  const source = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('contains no timer, animation frame or interval', () => {
    for (const banned of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'autoplay']) {
      expect(source).not.toContain(banned);
    }
  });

  it('does not reach for a network or a store', () => {
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('createApiClient');
  });

  it('declares the absence of playback in its own contract', () => {
    const raw = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
    expect(raw).toContain('NO fake playback');
  });
});