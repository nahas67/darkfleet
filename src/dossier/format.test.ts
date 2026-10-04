/**
 * The dossier's rendering rules, pinned.
 *
 * There is no component-test infrastructure here (vitest runs in a `node`
 * environment, no DOM), so these pure functions carry every rule that must not
 * regress. Each test states the failure it prevents, because "returns NOT
 * ESTABLISHED" is not obviously worth a test until you know what it replaces.
 */

import { describe, expect, it } from 'vitest';

import {
  ABSENT_LABEL,
  GHOST_WARNING,
  POLARIZATION_STATUS_BANNER,
  WAKE_STATUS_BANNER,
  absent,
  count,
  ghostHeader,
  isAbsent,
  isGhostVessel,
  measurement,
  readCoverage,
  readInterval,
  readPolarization,
  readWake,
  text,
  unavailableDualPol,
} from './format';

/* ------------------------------------------------------- null is not a value */

describe('a null measurement never renders as a number', () => {
  it('does not turn a missing AIS heading into 000 degrees', () => {
    // 000 is a compass bearing. A vessel that reported no heading and a vessel
    // pointing north are different facts, and only one of them was observed.
    const rendered = measurement(null, { digits: 0, unit: 'deg' });
    expect(isAbsent(rendered)).toBe(true);
    if (isAbsent(rendered)) expect(rendered.reason).toBe('NOT_ESTABLISHED');
  });

  it('does not turn a missing SOG into 0 knots', () => {
    // This is the most damaging possible substitution: a stopped vessel and a
    // silent one look identical, and "0 kn" reads as a measurement.
    const rendered = measurement(null, { unit: 'kn' });
    expect(isAbsent(rendered)).toBe(true);
  });

  it('renders a genuine zero as a value, because zero was measured', () => {
    expect(measurement(0, { digits: 1, unit: 'kn' })).toBe('0.0 kn');
    expect(measurement(0, { digits: 1 })).toBe('0.0');
  });

  it('treats NaN and Infinity as unestablished rather than printing them', () => {
    expect(isAbsent(measurement(Number.NaN))).toBe(true);
    expect(isAbsent(measurement(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('treats empty and whitespace text as unestablished', () => {
    expect(isAbsent(text(''))).toBe(true);
    expect(isAbsent(text('   '))).toBe(true);
    expect(isAbsent(text(null))).toBe(true);
    expect(text('STENA FRODE')).toBe('STENA FRODE');
  });

  it('never returns a dash or an empty string for an absent value', () => {
    // The failure this guards is a blank cell, which reads as "nothing to report"
    // rather than "the source did not report it".
    for (const reason of Object.keys(ABSENT_LABEL) as Array<keyof typeof ABSENT_LABEL>) {
      const label = ABSENT_LABEL[reason];
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe('-');
      expect(label).not.toBe('N/A');
      expect(label).not.toMatch(/^\d/);
    }
  });
});

describe('counts distinguish nothing-to-count from counting-nothing', () => {
  it('does not report zero observations when coverage was absent', () => {
    // `observation_count` is deliberately null under NO_COVERAGE. Rendering that
    // as 0 is how an unobserved ocean is displayed as an empty one.
    expect(isAbsent(count(null, 'NO_COVERAGE'))).toBe(true);
    expect(isAbsent(count(undefined, 'NO_COVERAGE'))).toBe(true);
  });

  it('reports a real zero as a zero', () => {
    expect(count(0, 'NO_COVERAGE')).toBe('0');
  });
});

/* ----------------------------------------------------------------- coverage */

describe('AIS coverage: three cases that must stay visually distinct', () => {
  it('distinguishes NO_COVERAGE from ZERO_OBSERVATIONS', () => {
    // Nobody listening is not the same as listening and hearing nothing.
    const none = readCoverage({ state: 'NO_COVERAGE', detail: 'no receiver', observation_count: null });
    const zero = readCoverage({ state: 'AVAILABLE', detail: 'receiver live', observation_count: 0 });
    expect(none.kind).toBe('NO_COVERAGE');
    expect(zero.kind).toBe('ZERO_OBSERVATIONS');
    expect(none.kind).not.toBe(zero.kind);
  });

  it('distinguishes AVAILABLE from PARTIAL', () => {
    const full = readCoverage({ state: 'AVAILABLE', detail: '', observation_count: 4 });
    const partial = readCoverage({ state: 'PARTIAL', detail: '', observation_count: 4 });
    expect(full.kind).toBe('AVAILABLE');
    expect(partial.kind).toBe('PARTIAL');
  });

  it('keeps NOT_CONFIGURED distinct from NO_COVERAGE', () => {
    // Not configured is an operator state; no coverage is a world state. Both mean
    // "no AIS", but they call for different actions.
    const unconfigured = readCoverage({ state: 'NOT_CONFIGURED', detail: '' });
    expect(unconfigured.kind).toBe('NOT_CONFIGURED');
    expect(unconfigured.kind).not.toBe('NO_COVERAGE');
  });

  it('treats a missing coverage block as NO_COVERAGE rather than assuming data', () => {
    expect(readCoverage(null).kind).toBe('NO_COVERAGE');
  });

  it('falls back to NO_COVERAGE for an unrecognised state', () => {
    // An unknown state must not be rendered as available. Defaulting to the
    // pessimistic branch is the safe direction: it cannot invent evidence.
    expect(readCoverage({ state: 'SOMETHING_NEW', detail: '' }).kind).toBe('NO_COVERAGE');
  });
});

/* --------------------------------------------------------------------- wake */

describe('wake: FAILED is never "no wake detected"', () => {
  it('keeps FAILED distinct from a clean non-detection', () => {
    // A failed detector says nobody looked. A non-detection says the radar saw a
    // hull and nothing trailing it. Merging them manufactures a negative
    // observation out of a software fault.
    const failed = readWake({ state: 'FAILED', detected: false, confidence: 0 });
    const clean = readWake({ state: 'ANALYSED', detected: false, confidence: 0 });
    expect(failed.kind).toBe('FAILED');
    expect(clean.kind).toBe('ANALYSED');
    expect(failed.kind).not.toBe(clean.kind);
  });

  it('carries the exception detail on a failure', () => {
    const failed = readWake({
      state: 'FAILED',
      error_type: 'ZeroDivisionError',
      error_message: 'boom',
    });
    expect(failed.kind).toBe('FAILED');
    if (failed.kind === 'FAILED') expect(failed.detail).toContain('ZeroDivisionError');
  });

  it('handles a null analysis as NOT_ANALYSED, not as a non-detection', () => {
    expect(readWake(null).kind).toBe('NOT_ANALYSED');
    expect(readWake(undefined).kind).toBe('NOT_ANALYSED');
  });

  it('keeps NOT_AVAILABLE distinct from NOT_ANALYSED', () => {
    // Both mean "no result", but one means the detector never ran and the other
    // means it ran and had nothing to measure.
    expect(readWake({ state: 'NOT_AVAILABLE' }).kind).toBe('NOT_AVAILABLE');
    expect(readWake({ state: 'NOT_ANALYSED' }).kind).toBe('NOT_ANALYSED');
  });

  it('never claims a vessel is underway from wake evidence alone', () => {
    // UNDERWAY asserts motion. A wake does not establish motion: a wake persists
    // long after a vessel stops, and can be visible from wind and current alone.
    const detected = readWake({ state: 'ANALYSED', detected: true, confidence: 0.8 });
    expect(detected.kind).toBe('ANALYSED');
    if (detected.kind === 'ANALYSED') {
      expect(detected.label.toUpperCase()).not.toContain('UNDERWAY');
      expect(detected.label).toMatch(/wake-like/i);
    }
  });

  it('labels a non-detection as a measurement, not as absence of a vessel', () => {
    const clean = readWake({ state: 'ANALYSED', detected: false });
    if (clean.kind === 'ANALYSED') {
      expect(clean.label).toMatch(/ran and measured no/i);
    }
  });

  it('states the mandated calibration status in the banner', () => {
    // Fixed product copy. It is asserted because the words must not quietly
    // change as the tab is edited.
    expect(WAKE_STATUS_BANNER).toContain('EXPERIMENTAL EVIDENCE');
    expect(WAKE_STATUS_BANNER).toContain('NOT CALIBRATED');
    expect(WAKE_STATUS_BANNER).toContain('NOT USED IN GHOST VESSEL CLASSIFICATION');
  });

  it('does not describe confidence as a probability', () => {
    const analysed = readWake({ state: 'ANALYSED', detected: true, confidence: 0.71 });
    if (analysed.kind === 'ANALYSED') {
      expect(`${analysed.label}`.toLowerCase()).not.toContain('probability');
      expect(`${analysed.label}`.toLowerCase()).not.toContain('likelihood of');
    }
  });
});

/* ------------------------------------------------------------- polarization */

describe('polarization: single-channel truth', () => {
  it('reports only the channel that was actually opened', () => {
    const reading = readPolarization({
      status: 'FEATURES',
      available: ['VV'],
      requested: ['VV', 'VH'],
      calibration_domain: 'gamma0',
      per_pol: { VV: { mean_db: 2.2, max_db: 2.4, p95_db: 2.4 } },
    });
    expect(reading.kind).toBe('FEATURES');
    if (reading.kind === 'FEATURES') {
      expect(reading.available).toEqual(['VV']);
      expect(unavailableDualPol(reading.available)).toEqual(['VH', 'HH', 'HV']);
    }
  });

  it('does not fabricate a dual-pol ratio for a single-channel acquisition', () => {
    // A ratio defaulted to 0 reads as "the cross-pol channel measured equal to the
    // co-pol channel", which is a physical claim about the radar return that
    // nobody made.
    const reading = readPolarization({
      status: 'FEATURES',
      available: ['VV'],
      per_pol: { VV: { mean_db: 2.2 } },
      vh_over_vv_db: null,
    });
    expect(reading.kind).toBe('FEATURES');
    if (reading.kind === 'FEATURES') {
      expect('vh_over_vv_db' in reading).toBe(false);
      expect(unavailableDualPol(reading.available)).toContain('VH');
    }
  });

  it('keeps FAILED distinct from NOT_AVAILABLE', () => {
    expect(readPolarization({ status: 'FAILED', available: ['VV'] }).kind).toBe('FAILED');
    expect(readPolarization({ status: 'NOT_AVAILABLE', available: [] }).kind).toBe('NOT_AVAILABLE');
    expect(readPolarization(null).kind).toBe('NOT_AVAILABLE');
  });

  it('preserves the calibration domain rather than normalising it', () => {
    // sigma0 (GRD) and gamma0 (RTC) differ by an incidence-angle term, so the
    // domain is part of the value's meaning.
    expect(
      readPolarization({ status: 'FEATURES', available: ['VV'], calibration_domain: 'sigma0' }),
    ).toMatchObject({ domain: 'sigma0' });
  });

  it('states the mandated evidence-channel status', () => {
    expect(POLARIZATION_STATUS_BANNER).toContain('EVIDENCE CHANNEL');
    expect(POLARIZATION_STATUS_BANNER).toContain('NOT USED IN GHOST VESSEL CLASSIFICATION');
  });

  it('reports a dual-pol acquisition as having both channels available', () => {
    const reading = readPolarization({
      status: 'FEATURES',
      available: ['VV', 'VH'],
      calibration_domain: 'sigma0',
      per_pol: { VV: { mean_db: 1 }, VH: { mean_db: -6 } },
    });
    if (reading.kind === 'FEATURES') {
      expect(unavailableDualPol(reading.available)).toEqual(['HH', 'HV']);
    }
  });
});

/* ------------------------------------------------------------------ revisit */

describe('revisit: one acquisition defines no interval', () => {
  it('reports NOT ESTABLISHED rather than 0 days for a single acquisition', () => {
    // "0 days" asserts a cadence that no pair of acquisitions supports. It is the
    // same class of error as rendering a missing heading as 000.
    const reading = readInterval(0, 'days', 1);
    expect(reading.kind).toBe('NOT_ESTABLISHED');
    expect(reading.label).not.toContain('0');
    expect(reading.label).toContain('NOT ESTABLISHED');
  });

  it('reports NOT ESTABLISHED even when a number was supplied for one acquisition', () => {
    // The value is ignored, because the sample size invalidates it regardless of
    // what the backend passed.
    expect(readInterval(12, 'days', 1).kind).toBe('NOT_ESTABLISHED');
    expect(readInterval(0, 'days', 0).kind).toBe('NOT_ESTABLISHED');
  });

  it('reports a real interval once two acquisitions exist', () => {
    const reading = readInterval(12.34, 'days', 4);
    expect(reading.kind).toBe('ESTABLISHED');
    expect(reading.label).toBe('12.3 days');
  });

  it('reports NOT ESTABLISHED for a null interval even with enough samples', () => {
    expect(readInterval(null, 'days', 5).kind).toBe('NOT_ESTABLISHED');
  });
});

/* ---------------------------------------------------------------- ghost */

describe('ghost vessel semantics', () => {
  it('derives Ghost Vessel from the canonical classification only', () => {
    // One definition, derived, never a second data model that can drift.
    expect(isGhostVessel('SAR_UNMATCHED')).toBe(true);
    expect(isGhostVessel('SAR_MATCHED_AIS')).toBe(false);
    expect(isGhostVessel('STATIONARY_OR_INFRASTRUCTURE')).toBe(false);
    expect(isGhostVessel(null)).toBe(false);
  });

  it('shows both the designation and the analytical classification', () => {
    // They are different claims: one is the product's label, the other is what
    // the correlation concluded.
    const header = ghostHeader('SAR_UNMATCHED');
    expect(header?.designation).toBe('GHOST VESSEL');
    expect(header?.analytical).toBe('SAR_UNMATCHED');
  });

  it('carries the canonical warning verbatim', () => {
    expect(ghostHeader('SAR_UNMATCHED')?.warning).toBe(GHOST_WARNING);
  });

  it('does not attach a ghost header to a matched target', () => {
    expect(ghostHeader('SAR_MATCHED_AIS')).toBeNull();
  });

  it('states that the warning does not establish a cause', () => {
    // The single most important sentence on this surface. It forecloses reading an
    // unmatched return as evasion, which the evidence does not support.
    expect(GHOST_WARNING).toContain('does not establish why');
  });
});

/* ------------------------------------------------------------ forbidden text */

describe('the absent helper cannot be confused with a value', () => {
  it('tags every absence with a reason', () => {
    expect(absent('NO_COVERAGE')).toEqual({ kind: 'absent', reason: 'NO_COVERAGE' });
    expect(isAbsent(absent('FAILED'))).toBe(true);
    expect(isAbsent(0)).toBe(false);
    expect(isAbsent('0')).toBe(false);
    expect(isAbsent(null)).toBe(false);
    expect(isAbsent('NOT ESTABLISHED')).toBe(false);
  });
});