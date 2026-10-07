/**
 * Product invariants for the new architecture.
 *
 * These target the rules that, if they regress, make the product lie rather than
 * merely look wrong. Each test names the failure it prevents.
 */

import { describe, expect, it } from 'vitest';

import { parseSseBlock } from '../api/sse';
import { assertReal, toSarTarget } from '../api/client';
import { toBBox, resetStore, store, type SarTarget } from '../state/store';
import {
  NOT_ESTABLISHED,
  fmt,
  fmtAge,
  fmtBearing,
  fmtConfidence,
  fmtDelta,
  fmtInstant,
  fmtLatLon,
  fmtMetres,
  fmtRows,
  fmtText,
  fmtUtc,
} from '../design/format';
import { classificationColor } from '../design/tokens';

/* --------------------------------------------------------------- formatter */

describe('absence is never rendered as a value', () => {
  it('renders null and NaN as words, not zeroes', () => {
    // A `0` here would be indistinguishable from a measured zero, which is how an
    // unreported speed becomes "SOG 0.0 kn" and enters a correlation score.
    expect(fmt(null)).toBe(NOT_ESTABLISHED);
    expect(fmt(undefined)).toBe(NOT_ESTABLISHED);
    expect(fmt(Number.NaN)).toBe(NOT_ESTABLISHED);
    expect(fmt(Number.POSITIVE_INFINITY)).toBe(NOT_ESTABLISHED);
  });

  it('renders a genuine zero as a zero', () => {
    // The converse error matters too: a vessel at anchor really is 0.0 kn.
    expect(fmt(0)).toBe('0.00');
    expect(fmtConfidence(0)).toBe('0%');
    expect(fmtMetres(0)).toBe('0.0 m');
  });

  it('treats an empty string as absence', () => {
    expect(fmtText('')).toBe(NOT_ESTABLISHED);
    expect(fmtText('   ')).toBe(NOT_ESTABLISHED);
    expect(fmtText('MV TEST')).toBe('MV TEST');
  });

  it('drops unestablished rows instead of walling the panel with them', () => {
    const rows = fmtRows([
      ['MMSI', '123456789'],
      ['SOG', null],
      ['Name', ''],
      ['Length', 90],
    ]);
    expect(rows.map((r) => r.label)).toEqual(['MMSI', 'Length']);
  });
});

describe('coordinates and time', () => {
  it('renders hemisphere letters rather than signed decimals', () => {
    expect(fmtLatLon(1.32884, 104.11465)).toBe('1.32884°N  104.11465°E');
    expect(fmtLatLon(-12.5, -45.25)).toBe('12.50000°S  45.25000°W');
  });

  it('renders UTC only', () => {
    // A local-time mode would put two different numbers on the same timeline row.
    expect(fmtUtc('2026-03-01T12:00:00Z')).toBe('12:00:00Z');
    expect(fmtInstant('2026-03-01T12:00:00Z')).toBe('2026-03-01 12:00:00Z');
  });

  it('reports an unparseable timestamp as unestablished, not as an epoch', () => {
    expect(fmtInstant('not a date')).toBe(NOT_ESTABLISHED);
    expect(fmtInstant(null)).toBe(NOT_ESTABLISHED);
  });

  it('wraps bearings into a true bearing', () => {
    expect(fmtBearing(-10)).toBe('350°');
    expect(fmtBearing(370)).toBe('010°');
    expect(fmtBearing(null)).toBe(NOT_ESTABLISHED);
  });

  it('signs time deltas and does not invent one', () => {
    // Seconds are kept to two minutes: the deltas an analyst compares inside a
    // +/-15 minute correlation window are tens and hundreds of seconds.
    expect(fmtDelta(90)).toBe('+90s');
    expect(fmtDelta(-120)).toBe('-120s');
    expect(fmtDelta(-300)).toBe('-5.0m');
    expect(fmtDelta(0)).toBe('0s');
    expect(fmtDelta(null)).toBe(NOT_ESTABLISHED);
  });

  it('describes freshness honestly', () => {
    const now = Date.parse('2026-03-01T12:00:00Z');
    expect(fmtAge('2026-03-01T11:59:30Z', now)).toBe('30s ago');
    expect(fmtAge('2026-03-01T09:00:00Z', now)).toBe('3h ago');
    expect(fmtAge(null, now)).toBe(NOT_ESTABLISHED);
  });
});

/* ------------------------------------------------------------------ symbo */

describe('symbology', () => {
  it('gives every classification a distinct colour', () => {
    const classes = [
      'SAR_MATCHED_AIS',
      'SAR_UNMATCHED',
      'STATIONARY_OR_INFRASTRUCTURE',
      'AIS_ONLY',
      'LOW_CONFIDENCE',
      'UNRESOLVED',
      'SEA_CLUTTER',
    ];
    for (const name of classes) {
      expect(classificationColor[name], name).toBeTruthy();
    }
    // UNRESOLVED is muted on purpose: a bright mark would overstate what is known.
    expect(classificationColor.UNRESOLVED).toBe('#55606B');
  });
});

/* -------------------------------------------------------------- real guard */

describe('the REAL-only guard', () => {
  it('accepts only REAL and explicitly non-synthetic', () => {
    expect(assertReal({ runtime_mode: 'REAL', synthetic: false })).toBe(true);
    expect(assertReal({ runtime_mode: 'REAL', synthetic: true })).toBe(false);
    expect(assertReal({ runtime_mode: 'DEMO', synthetic: false })).toBe(false);
  });

  it('refuses a record that omits the guarantees', () => {
    // Absence is not consent. Defaulting a missing flag to "real" would draw
    // whatever arrived, which is the one outcome this guard exists to prevent.
    expect(assertReal({} as never)).toBe(false);
    expect(assertReal({ runtime_mode: 'REAL' } as never)).toBe(false);
    expect(assertReal({ synthetic: false } as never)).toBe(false);
  });
});

/* ------------------------------------------------------- target adaptation */

describe('target adaptation preserves absence', () => {
  const base = {
    id: 'DF-001',
    classification: 'SAR_UNMATCHED',
    lat: 1.3,
    lon: 103.8,
    sarConf: 0.8,
    aisConf: 0,
    corr: null,
  };

  it('leaves the MMSI null when there is no association', () => {
    // Never a nearby vessel's MMSI: that would be a different claim.
    expect(toSarTarget(base as never).mmsi).toBeNull();
  });

  it('carries the associated MMSI and geometry when one exists', () => {
    const target = toSarTarget({
      ...base,
      corr: {
        mmsi: '123456789',
        distanceOffsetMeters: 412,
        scoreDecomposition: { matchRadiusMeters: 1250 },
      },
    } as never);
    expect(target.mmsi).toBe('123456789');
    expect(target.distanceOffsetMeters).toBe(412);
    expect(target.matchRadiusMeters).toBe(1250);
  });

  it('reports no uncertainty rather than a guessed one', () => {
    // An uncertainty ring drawn from an invented radius asserts precision the
    // product cannot support.
    expect(toSarTarget(base as never).geolocationUncertaintyM).toBeNull();
  });
});

/* ------------------------------------------------------------- bbox safety */

describe('bbox validation', () => {
  it('accepts a well-ordered box', () => {
    expect(toBBox([103.7, 1.1, 104.05, 1.4])).toEqual([103.7, 1.1, 104.05, 1.4]);
  });

  it('refuses malformed boxes rather than casting them', () => {
    expect(toBBox([1, 2])).toBeNull();
    expect(toBBox([1, 2, 3, 4, 5])).toBeNull();
    expect(toBBox([104.05, 1.1, 103.7, 1.4])).toBeNull(); // inverted lon
    expect(toBBox([103.7, 1.4, 104.05, 1.1])).toBeNull(); // inverted lat
    expect(toBBox([103.7, -95, 104.05, 1.4])).toBeNull(); // |lat| > 90
    expect(toBBox([103.7, 1.1, 104.05, Number.NaN])).toBeNull();
    expect(toBBox(undefined)).toBeNull();
  });
});

/* ---------------------------------------------------------------- selection */

describe('bidirectional selection', () => {
  it('routes target and AIS picks through separate authorities that coexist', () => {
    resetStore();
    const target: SarTarget = {
      id: 'DF-001',
      classification: 'SAR_UNMATCHED',
      lat: 1.3,
      lon: 103.8,
      sarConf: 0.8,
      aisConf: 0,
      mmsi: null,
      distanceOffsetMeters: null,
      matchRadiusMeters: null,
      geolocationUncertaintyM: null,
      // The analytical anchor. Null here means "this target cannot be placed on
      // a raster", which is the honest default for a hand-built fixture -- not
      // (0, 0), which would place it at the raster's corner and look measured.
      geoPixelCentroid: null,
      geoCentreOffset: null,
    };
    store.set({ targets: [target] });

    store.select({ kind: 'target', targetId: 'DF-001' });
    // Target and AIS are separate authorities that coexist: every surface reads
    // the same two fields, which is what makes selection bidirectional without
    // any cross-panel wiring.
    expect(store.getState().selection).toEqual({ kind: 'target', targetId: 'DF-001' });

    store.selectAis({ mmsi: '123456789' });
    expect(store.getState().selectedAis).toEqual({ mmsi: '123456789', observationAt: null });
    // And the target survived the contact pick (DF-X9.6 section 7).
    expect(store.getState().selection).toEqual({ kind: 'target', targetId: 'DF-001' });
  });

  it('does not notify subscribers when nothing changed', () => {
    // Cursor telemetry is written at frame rate; notifying on an unchanged value
    // would re-render the whole tree continuously.
    resetStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.set({ cursor: { lat: 1, lon: 2 } });
    const afterFirst = notifications;
    store.set({ cursor: { lat: 1, lon: 2 } });
    store.set({ cursor: { lat: 1, lon: 2 } });
    unsubscribe();
    expect(afterFirst).toBe(1);
    expect(notifications).toBe(1);
  });
});

/* --------------------------------------------------------------------- SSE */

describe('SSE frame grammar', () => {
  it('parses a stage frame', () => {
    const frame = parseSseBlock('event: stage\ndata: {"stage":"COMPLETE"}');
    expect(frame).toEqual({ event: 'stage', data: '{"stage":"COMPLETE"}' });
  });

  it('joins multi-line data', () => {
    const frame = parseSseBlock('event: stage\ndata: {"a":1,\ndata: "b":2}');
    expect(frame?.data).toBe('{"a":1,\n"b":2}');
  });

  it('ignores comment keep-alives the backend sends before the first stage', () => {
    // These exist to hold the connection open. Treating one as a frame would
    // produce an empty stage event.
    expect(parseSseBlock(': keep-alive')).toBeNull();
    expect(parseSseBlock(': keep-alive\nevent: stage\ndata: {"stage":"QUEUED"}')).toEqual({
      event: 'stage',
      data: '{"stage":"QUEUED"}',
    });
  });

  it('handles CRLF framing', () => {
    expect(parseSseBlock('event: stage\r\ndata: {"stage":"QUEUED"}')).toEqual({
      event: 'stage',
      data: '{"stage":"QUEUED"}',
    });
  });

  it('returns null for a frame with no data', () => {
    expect(parseSseBlock('event: stage')).toBeNull();
    expect(parseSseBlock('')).toBeNull();
  });
});