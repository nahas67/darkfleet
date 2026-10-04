/**
 * How the dossier renders absence.
 *
 * THIS IS THE MOST IMPORTANT FILE IN THE DOSSIER
 *
 * Every rule here exists because the tempting rendering is a lie. A null AIS
 * heading rendered as `000°` is a measurement the source never made. A missing
 * wake rendered as "NO WAKE DETECTED" asserts that the detector looked and found
 * nothing, which is a different claim from the detector having failed. A revisit
 * interval computed from a single acquisition rendered as "0 days" invents a
 * cadence that was never observed.
 *
 * The distinction the whole product rests on:
 *
 *     NOT ESTABLISHED   the source did not report it
 *     NOT AVAILABLE     the capability could not run
 *     NOT ANALYSED      it was never run
 *     ZERO              it ran, and the answer is none
 *
 * Those four are not interchangeable and a reader cannot recover which one
 * applied from a `0`, a `--`, or a blank cell. So this module returns them as
 * distinct tagged values rather than as pre-formatted strings, and the component
 * layer decides only colour, never meaning.
 *
 * PURE AND DOM-FREE BY DESIGN
 *
 * There is no component-test infrastructure in this repository (vitest runs in a
 * `node` environment with no DOM), so every rule that must not regress is a pure
 * function here with a test beside it. A formatting rule that cannot be tested is
 * a formatting rule that will be broken by the next person who touches a panel.
 */

/** A value that may legitimately be absent, and whose absence has a reason. */
export type Absent = { readonly kind: 'absent'; readonly reason: AbsentReason };

export type AbsentReason =
  /** The source exists and reported nothing for this field. */
  | 'NOT_ESTABLISHED'
  /** The capability could not run. */
  | 'NOT_AVAILABLE'
  /** It was never run for this observation. */
  | 'NOT_ANALYSED'
  /** It ran and raised. */
  | 'FAILED'
  /** There is no coverage to ask. */
  | 'NO_COVERAGE'
  /** Coverage existed and contained nothing. */
  | 'ZERO_OBSERVATIONS'
  /** Candidates were evaluated and none qualified. */
  | 'ZERO_CANDIDATES'
  /** Coverage is present but incomplete. */
  | 'PARTIAL'
  /** Fewer passes than the question needs. */
  | 'INSUFFICIENT_PASSES'
  /** The quantity is mathematically undefined at this sample size. */
  | 'NOT_ESTABLISHED_STATISTIC';

export function absent(reason: AbsentReason): Absent {
  return { kind: 'absent', reason };
}

export function isAbsent(value: unknown): value is Absent {
  return typeof value === 'object' && value !== null && (value as Absent).kind === 'absent';
}

/** The literal shown to the operator. Never a number, never a dash, never blank. */
export const ABSENT_LABEL: Record<AbsentReason, string> = {
  NOT_ESTABLISHED: 'NOT ESTABLISHED',
  NOT_AVAILABLE: 'NOT AVAILABLE',
  NOT_ANALYSED: 'NOT ANALYSED',
  FAILED: 'FAILED',
  NO_COVERAGE: 'NO COVERAGE',
  ZERO_OBSERVATIONS: 'ZERO OBSERVATIONS',
  ZERO_CANDIDATES: 'ZERO CANDIDATES',
  PARTIAL: 'PARTIAL',
  INSUFFICIENT_PASSES: 'INSUFFICIENT PASSES',
  NOT_ESTABLISHED_STATISTIC: 'NOT ESTABLISHED',
};

/**
 * Render a nullable measurement.
 *
 * `zero` is a value, not an absence, so 0 knots renders as "0.0" and NOT as
 * "NOT ESTABLISHED". The distinction is the whole point: a vessel genuinely
 * stopped (`sog = 0`) and a vessel whose receiver reported nothing are different
 * facts about the world, and the second is not a stopped vessel.
 */
export function measurement(
  value: number | string | null | undefined,
  options: { digits?: number; unit?: string } = {},
): string | Absent {
  if (value === null || value === undefined) return absent('NOT_ESTABLISHED');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return absent('NOT_ESTABLISHED');
    const digits = options.digits ?? 1;
    return `${value.toFixed(digits)}${options.unit ? ` ${options.unit}` : ''}`;
  }
  const text = value.trim();
  return text.length === 0 ? absent('NOT_ESTABLISHED') : text;
}

/** Render an optional free-text field. Empty and whitespace both mean absent. */
export function text(value: string | null | undefined): string | Absent {
  if (value === null || value === undefined) return absent('NOT_ESTABLISHED');
  const trimmed = value.trim();
  return trimmed.length === 0 ? absent('NOT_ESTABLISHED') : trimmed;
}

/**
 * A count that must never be shown when the denominator is unknown.
 *
 * `observation_count` is deliberately null under NO_COVERAGE, because "we counted
 * nothing" and "there was nothing to count" are different. Rendering null as 0 is
 * how an unobserved ocean is displayed as an empty one.
 */
export function count(value: number | null | undefined, whenUnknown: AbsentReason): string | Absent {
  if (value === null || value === undefined) return absent(whenUnknown);
  return String(value);
}

/* ------------------------------------------------------------------ coverage */

/**
 * What AIS can answer for this request.
 *
 * The three cases an operator must be able to tell apart at a glance, because
 * they support completely different conclusions:
 *
 *     NO COVERAGE              nobody was listening here; absence is not evidence
 *     COVERAGE, ZERO REPORTS   someone was listening and the vessel said nothing
 *     COVERAGE, REJECTED       the vessel reported and the correlation declined it
 *
 * The third is the one that is easy to lose. "Coverage existed and a nearby vessel
 * reported" is not the same as "coverage existed and nothing was there", and it is
 * certainly not the same as "no coverage".
 */
export type CoverageReading =
  | { kind: 'NO_COVERAGE'; detail: string }
  | { kind: 'NOT_CONFIGURED'; detail: string }
  | { kind: 'PARTIAL'; detail: string; observationCount: number }
  | { kind: 'ZERO_OBSERVATIONS'; detail: string }
  | { kind: 'AVAILABLE'; detail: string; observationCount: number };

export function readCoverage(
  coverage: {
    state: string;
    detail: string;
    observation_count?: number | null;
  } | null,
): CoverageReading {
  if (coverage === null) {
    return { kind: 'NO_COVERAGE', detail: 'No coverage information was returned for this request.' };
  }
  const n = coverage.observation_count ?? null;
  switch (coverage.state) {
    case 'AVAILABLE':
      // `n === null` under AVAILABLE would mean the backend counted nothing and
      // reported no total, which it does not do. Treating it as ZERO_OBSERVATIONS
      // rather than inventing a count keeps the two facts apart.
      return n === null || n === 0
        ? { kind: 'ZERO_OBSERVATIONS', detail: coverage.detail }
        : { kind: 'AVAILABLE', detail: coverage.detail, observationCount: n };
    case 'PARTIAL':
      return { kind: 'PARTIAL', detail: coverage.detail, observationCount: n ?? 0 };
    case 'NOT_CONFIGURED':
      return { kind: 'NOT_CONFIGURED', detail: coverage.detail };
    case 'NO_COVERAGE':
    default:
      return { kind: 'NO_COVERAGE', detail: coverage.detail };
  }
}

/* ---------------------------------------------------------------------- wake */

/**
 * Wake state, kept honest.
 *
 * The rule this exists to enforce: a FAILED analysis must never render as "NO WAKE
 * DETECTED". Those are opposite claims. One says the radar saw a hull and nothing
 * trailing it; the other says the software broke and nobody looked. Collapsing
 * them manufactures a negative observation out of a software fault, which is the
 * single most damaging thing this surface could do.
 */
export type WakeReading =
  | { kind: 'ANALYSED'; detected: boolean; confidence: number | null; label: string }
  | { kind: 'NOT_ANALYSED'; label: string }
  | { kind: 'NOT_AVAILABLE'; label: string }
  | { kind: 'FAILED'; label: string; detail: string | null };

export const WAKE_STATUS_BANNER = [
  'WAKE ANALYSIS',
  'EXPERIMENTAL EVIDENCE',
  'NOT CALIBRATED',
  'NOT USED IN GHOST VESSEL CLASSIFICATION',
] as const;

export function readWake(
  analysis:
    | {
        state?: string;
        detected?: boolean;
        confidence?: number | null;
        error_type?: string | null;
        error_message?: string | null;
        notes?: string | null;
      }
    | null
    | undefined,
): WakeReading {
  if (analysis === null || analysis === undefined) {
    return { kind: 'NOT_ANALYSED', label: 'The wake detector has not been run for this target.' };
  }
  switch (analysis.state) {
    case 'FAILED':
      return {
        kind: 'FAILED',
        label: 'The wake detector FAILED for this target.',
        detail: analysis.error_type
          ? `${analysis.error_type}: ${analysis.error_message ?? 'no further detail'}`
          : (analysis.error_message ?? null),
      };
    case 'NOT_AVAILABLE':
      return { kind: 'NOT_AVAILABLE', label: analysis.notes ?? 'Nothing measurable was available to the wake detector.' };
    case 'NOT_ANALYSED':
      return { kind: 'NOT_ANALYSED', label: 'The wake detector was not run for this observation.' };
    case 'ANALYSED':
    default: {
      const detected = analysis.detected === true;
      return {
        kind: 'ANALYSED',
        detected,
        confidence: typeof analysis.confidence === 'number' ? analysis.confidence : null,
        // "Wake-like evidence" rather than "UNDERWAY": a wake does not establish
        // that a vessel is moving, and UNDERWAY would be that assertion.
        label: detected
          ? 'Wake-like linear evidence was measured. This does not establish that the ' +
            'vessel was moving: a wake outlives a stop, and wind and current produce ' +
            'linear features without any vessel.'
          : 'The detector ran and measured no wake-like linear feature.',
      };
    }
  }
}

/* ------------------------------------------------------------- polarization */

export type PolarizationReading =
  | {
      kind: 'FEATURES';
      available: string[];
      requested: string[];
      domain: string;
      perPol: Record<string, Record<string, number | string>>;
      notes: string[];
    }
  | { kind: 'NOT_AVAILABLE'; available: string[]; domain: string; reason: string | null }
  | { kind: 'FAILED'; available: string[]; domain: string; reason: string | null };

export const POLARIZATION_STATUS_BANNER = [
  'POLARIZATION',
  'EVIDENCE CHANNEL',
  'NOT USED IN GHOST VESSEL CLASSIFICATION',
] as const;

/**
 * Read the polarization channel.
 *
 * `available` is what the pipeline ACTUALLY opened, and everything outside it is
 * reported as unavailable. The trap this avoids: a dual-pol ratio defaulted to 0
 * reads as "the cross-pol channel measured equal to the co-pol channel", which is
 * a physical claim about the radar return that nobody made.
 */
export function readPolarization(
  evidence:
    | {
        status?: string;
        available?: string[];
        requested?: string[];
        calibration_domain?: string;
        per_pol?: Record<string, Record<string, number | string>>;
        vh_over_vv_db?: number | null;
        dual_pol_flags?: Record<string, unknown>;
        reason?: string | null;
        notes?: string[];
      }
    | null
    | undefined,
): PolarizationReading {
  if (evidence === null || evidence === undefined) {
    return {
      kind: 'NOT_AVAILABLE',
      available: [],
      domain: 'unknown',
      reason: 'The polarization channel did not run for this target.',
    };
  }
  const available = evidence.available ?? [];
  const domain = evidence.calibration_domain ?? 'unknown';
  if (evidence.status === 'FEATURES') {
    return {
      kind: 'FEATURES',
      available,
      requested: evidence.requested ?? [],
      domain,
      perPol: evidence.per_pol ?? {},
      notes: evidence.notes ?? [],
    };
  }
  if (evidence.status === 'FAILED') {
    return { kind: 'FAILED', available, domain, reason: evidence.reason ?? null };
  }
  return { kind: 'NOT_AVAILABLE', available, domain, reason: evidence.reason ?? null };
}

/**
 * The dual-polarization outputs that are genuinely unavailable.
 *
 * Returned as an explicit list rather than left implicit so the surface can say
 * what is missing instead of showing a short table and letting the reader assume
 * the system has no such capability at all.
 */
export function unavailableDualPol(available: string[]): string[] {
  const wanted = ['VV', 'VH', 'HH', 'HV'];
  return wanted.filter((channel) => !available.includes(channel));
}

/* ------------------------------------------------------------------- revisit */

/**
 * A revisit interval.
 *
 * One acquisition defines no interval. The median, minimum and maximum of a
 * single sample are all mathematically degenerate, and reporting "0 days" would
 * assert a cadence that no pair of acquisitions supports. Nominal orbital repeat
 * is NOT substituted either: that is a property of the orbit, not a measurement of
 * this water, and the operator asked about the water.
 */
export type IntervalReading =
  | { kind: 'ESTABLISHED'; label: string }
  | { kind: 'NOT_ESTABLISHED'; label: string };

export function readInterval(
  value: number | null | undefined,
  unit: string,
  acquisitionCount: number,
): IntervalReading {
  if (acquisitionCount < 2) {
    return {
      kind: 'NOT_ESTABLISHED',
      label: 'NOT ESTABLISHED — one acquisition defines no interval',
    };
  }
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { kind: 'NOT_ESTABLISHED', label: 'NOT ESTABLISHED' };
  }
  return { kind: 'ESTABLISHED', label: `${value.toFixed(1)} ${unit}` };
}

/* ---------------------------------------------------------------- multipass */

export const MULTIPASS_LANGUAGE = {
  title: 'TRACK HYPOTHESIS',
  disclaimer:
    'A multi-pass track is a HYPOTHESIS that two returns are the same vessel. ' +
    'Geometry alone does not establish identity, and nothing here should be read as ' +
    'a confirmed same-vessel finding.',
} as const;

/* ------------------------------------------------------------------- ghost */

export const GHOST_WARNING =
  'No sufficiently confident AIS association was found in the available observations. ' +
  'This alone does not establish why.';

/**
 * Is this classification a Ghost Vessel?
 *
 * Derived from the canonical classification rather than from a designation string,
 * so there is exactly one definition in the product and no second data model.
 */
export function isGhostVessel(classification: string | null | undefined): boolean {
  return classification === 'SAR_UNMATCHED';
}

/**
 * The two-line header for a Ghost Vessel.
 *
 * `GHOST VESSEL` is the designation shown to the operator; `SAR_UNMATCHED` is the
 * analytical classification underneath it. Both are shown because they are
 * different claims: one is the product's label, the other is what the correlation
 * actually concluded.
 */
export function ghostHeader(classification: string | null | undefined): {
  designation: string;
  analytical: string;
  warning: string;
} | null {
  if (!isGhostVessel(classification)) return null;
  return {
    designation: 'GHOST VESSEL',
    analytical: 'SAR_UNMATCHED',
    warning: GHOST_WARNING,
  };
}