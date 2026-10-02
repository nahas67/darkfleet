/**
 * SAR acquisition plan surface (GEO-002).
 *
 * The honesty assertions here matter more than the markup: a plan that shows a
 * predicted pass, or turns "insufficient data" into 0, is worse than no plan.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AcquisitionPlan,
  formatAcquisitionTime,
  formatDays,
  platformSummary,
  sortGapsBySeverity,
} from './AcquisitionPlan.tsx';
import type { RevisitGap, RevisitPlan, RevisitStatistics } from '../app/useApi.ts';

// Real item ids and timestamps from a live Planetary Computer query.
const REAL_PLAN: RevisitPlan = {
  acquisition_count: 5,
  acquisitions: [
    {
      item_id: 'S1D_IW_GRDH_1SDV_20260903T112445_20260903T112510_004762_008EC4_rtc',
      acquisition_time: '2026-09-03T11:24:57.508922Z',
      platform: 'sentinel-1d',
      collection: 'sentinel-1-rtc',
      polarizations: ['VH', 'VV'],
    },
    {
      item_id: 'S1D_IW_GRDH_1SDV_20260915T112445_20260915T112510_004762_008EC6_rtc',
      acquisition_time: '2026-09-15T11:24:58.143217Z',
      platform: 'sentinel-1d',
      collection: 'sentinel-1-rtc',
      polarizations: ['VH', 'VV'],
    },
  ],
  gaps: [
    {
      start: '2026-09-03T11:24:57.508922Z',
      end: '2026-09-15T11:24:58.143217Z',
      days: 12.0,
      window_edge: false,
      exceeds_nominal: false,
    },
    {
      start: '2026-06-16T11:00:00Z',
      end: '2026-06-24T11:00:00Z',
      days: 7.0,
      window_edge: false,
      exceeds_nominal: false,
    },
  ],
  statistics: {
    platform_count: 1,
    acquisitions_per_platform: { 'sentinel-1d': 5 },
    interior_gap_count: 4,
    median_revisit_days: 10.53,
    min_revisit_days: 1.47,
    max_revisit_days: 12.0,
    flagged_gap_count: 0,
    nominal_repeat_days: 12,
  },
  window: { start: '2026-05-14T00:00:00Z', end: '2026-10-24T00:00:00Z' },
  next_after: {
    item_id: 'S1D_IW_GRDH_1SDV_20260927T112445_20260927T112510_004762_008EC8_rtc',
    acquisition_time: '2026-09-27T11:24:58.180786Z',
    platform: 'sentinel-1d',
    collection: 'sentinel-1-rtc',
    polarizations: ['VH', 'VV'],
  },
  limitations: [
    'Intervals are measured between consecutive real acquisitions inside the queried window only; nothing outside the window is inferred.',
  ],
  provider: 'planetary-computer',
  collection: 'sentinel-1-rtc',
  requested_bbox: [103.8, 1.24, 103.86, 1.28],
};

const render = (props: Partial<Parameters<typeof AcquisitionPlan>[0]>) =>
  renderToStaticMarkup(
    createElement(AcquisitionPlan, { plan: null, error: null, loading: false, ...props }),
  );

// ------------------------------------------------------------ pure helpers


describe('formatDays', () => {
  it('formats a measured value', () => {
    expect(formatDays(12)).toBe('12.0 d');
    expect(formatDays(1.47)).toBe('1.5 d');
  });

  it('renders null as insufficient data, never 0', () => {
    // The single most important assertion in this file.
    expect(formatDays(null)).toBe('insufficient data');
    expect(formatDays(undefined)).toBe('insufficient data');
    expect(formatDays(NaN)).toBe('insufficient data');
    expect(formatDays(Number.POSITIVE_INFINITY)).toBe('insufficient data');
    expect(formatDays(null)).not.toContain('0');
  });
});

describe('formatAcquisitionTime', () => {
  it('formats a real timestamp', () => {
    expect(formatAcquisitionTime('2026-09-27T11:24:58.180786Z')).toBe('2026-09-27T11:24:58Z');
  });

  it('refuses to invent a timestamp', () => {
    expect(formatAcquisitionTime(null)).toBe('not established');
    expect(formatAcquisitionTime(undefined)).toBe('not established');
    expect(formatAcquisitionTime('')).toBe('not established');
    expect(formatAcquisitionTime('not-a-date')).toBe('not established');
  });
});

describe('sortGapsBySeverity', () => {
  const gap = (days: number, exceeds: boolean): RevisitGap => ({
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-02T00:00:00Z',
    days,
    window_edge: false,
    exceeds_nominal: exceeds,
  });

  it('puts flagged gaps first, then longest', () => {
    const sorted = sortGapsBySeverity([gap(2, false), gap(30, true), gap(12, false), gap(90, true)]);
    expect(sorted.map((g) => g.days)).toEqual([90, 30, 12, 2]);
  });

  it('does not mutate its input', () => {
    const input = [gap(2, false), gap(90, true)];
    sortGapsBySeverity(input);
    expect(input.map((g) => g.days)).toEqual([2, 90]);
  });
});

describe('platformSummary', () => {
  const stats = (record: Record<string, number>): RevisitStatistics => ({
    platform_count: Object.keys(record).length,
    acquisitions_per_platform: record,
    interior_gap_count: 0,
    median_revisit_days: null,
    min_revisit_days: null,
    max_revisit_days: null,
    flagged_gap_count: 0,
    nominal_repeat_days: 12,
  });

  it('names each platform with its count', () => {
    expect(platformSummary(stats({ 'sentinel-1a': 4, 'sentinel-1b': 3 }))).toBe(
      'sentinel-1a (4), sentinel-1b (3)',
    );
  });

  it('says so when nothing is reported', () => {
    expect(platformSummary(stats({}))).toBe('no platform reported');
  });
});

// -------------------------------------------------------------- rendering


describe('AcquisitionPlan surface', () => {
  it('shows the measured statistics and the window that produced them', () => {
    const html = render({ plan: REAL_PLAN });
    expect(html).toContain('data-df-acquisition-plan');
    expect(html).toContain('Median revisit');
    expect(html).toContain('10.5 d');
    expect(html).toContain('Window');
    expect(html).toContain('2026-05-14');
    expect(html).toContain('2026-10-24');
  });

  it('states that no pass is predicted', () => {
    expect(render({ plan: REAL_PLAN })).toContain('No pass is predicted');
  });

  it('renders real item-backed acquisitions', () => {
    const html = render({ plan: REAL_PLAN });
    expect(html).toContain('2026-09-27');
    expect(html).toContain('VH/VV');
  });

  it('surfaces the limitations the backend attached', () => {
    const html = render({ plan: REAL_PLAN });
    expect(html).toContain('What this does not say');
    expect(html).toContain('nothing outside the window is inferred');
  });

  it('renders insufficient data rather than a zero', () => {
    const plan: RevisitPlan = {
      ...REAL_PLAN,
      statistics: { ...REAL_PLAN.statistics, median_revisit_days: null },
    };
    const html = render({ plan });
    expect(html).toContain('insufficient data');
  });

  it('flags a gap longer than the nominal cycle', () => {
    const plan: RevisitPlan = {
      ...REAL_PLAN,
      gaps: [
        {
          start: '2026-01-01T00:00:00Z',
          end: '2026-03-01T00:00:00Z',
          days: 59,
          window_edge: false,
          exceeds_nominal: true,
        },
      ],
      statistics: { ...REAL_PLAN.statistics, flagged_gap_count: 1 },
    };
    const html = render({ plan });
    expect(html).toContain('59.0 d');
    expect(html).toContain('!');
  });

  it('says the empty catalogue is not evidence of no coverage', () => {
    const plan: RevisitPlan = {
      ...REAL_PLAN,
      acquisition_count: 0,
      acquisitions: [],
      gaps: [],
      next_after: null,
    };
    const html = render({ plan });
    expect(html).toContain('not');
    expect(html).toContain('evidence that the area is never covered');
  });

  it('has an explicit not-requested state', () => {
    expect(render({ plan: null })).toContain('No acquisition plan requested yet');
  });

  it('shows a loading state rather than an empty table', () => {
    expect(render({ plan: null, loading: true })).toContain('Querying catalogue');
  });

  it('surfaces a provider failure instead of an empty plan', () => {
    const html = render({ plan: null, error: 'Acquisition plan unavailable: 503 UNAVAILABLE' });
    expect(html).toContain('503');
    expect(html).not.toContain('Median revisit');
  });
});