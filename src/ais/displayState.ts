/**
 * The canonical AIS DISPLAY STATE model.
 *
 * ============================ WHAT THIS IS, AND WHAT IT IS NOT ============================
 *
 * DarkFleet has two things that are constantly confused and must never be:
 *
 *   1. EVIDENCE   -- what a vessel actually broadcast. Immutable. Stored in Parquet, served
 *                    verbatim by `/api/vessels/{mmsi}/track`, and consumed by the backend
 *                    correlation. Never rewritten for smoothness.
 *   2. DISPLAY    -- how that evidence is drawn. Interpolated for legibility, stabilised
 *                    against jitter, decluttered, oriented on screen.
 *
 * Before this module the product had no vocabulary for (2) at all. Contacts were
 * `viewer.entities.add` `PointGraphics` at raw coordinates, and the renderer had nothing to
 * smooth -- because nothing declared that smoothing was allowed in the first place. The trap
 * this file exists to close: the first person to add animation would have had no vocabulary for
 * what animation means, so they would have animated *positions*, and a smoothed position is
 * indistinguishable from a fabricated one to anyone reading the screen later.
 *
 * So every value here is either an OBSERVED value passed straight through, or a value carrying
 * an explicit `source` naming where it came from. There is no path in this file that produces a
 * position without naming the observations it was derived from.
 *
 * The governing rule, from DF-X9:
 *
 *     > DarkFleet may make AIS movement visually smooth, but it may never make the evidence
 *     > smoother than reality.
 *
 * ================================ THE THREE POSITION CONCEPTS ================================
 *
 * These are three different things and the type system keeps them apart. Conflating any pair of
 * them is the specific failure DF-X9 exists to prevent.
 *
 *   OBSERVED               A recorded fix, at its recorded coordinates and time. Carried
 *                          through unchanged. `AisObservationOut` is its type.
 *   INTERPOLATED_DISPLAY   A position BETWEEN two real observations, computed purely so the
 *                          contact does not teleport. NOT a measurement. Carries both
 *                          bracketing timestamps so it can always be traced home.
 *   PREDICTED              Dead reckoning to SAR acquisition time, produced by the BACKEND
 *                          (`correlation/geodesy.propagate`) and persisted on the scan record as
 *                          `corr.predictedLat/predictedLon`. Never computed here. It is
 *                          analytical evidence, not display smoothing.
 *
 * The third is the important one for this module's shape: `predictedPosition` is a field that
 * ARRIVES from the backend. This file does not derive it, cannot derive it, and must not be
 * extended to. A client-side dead-reckoning projection would be a second, subtly different
 * prediction competing with the analytical one, and the operator could not tell which they were
 * looking at.
 *
 * ================================ WHY FRESHNESS IS NOT WALL CLOCK ================================
 *
 * `freshnessOf` is measured against an EXPLICIT REFERENCE TIME, never against `Date.now()`.
 *
 * This deployment has no live AIS feed: `/api/scans/{id}/events` carries scan-stage lifecycle
 * only, and `GET /api/ais/coverage` reports `NOT_CONFIGURED`. Against a wall clock, every
 * archived contact would read as ancient and every contact would be `LOST`, which would be a
 * confident false claim -- it would assert the vessel stopped broadcasting, when the truth is
 * that this deployment has never had a feed. §28 of DF-X9 forbids exactly that: `STALE` must
 * never become "AIS turned off" without independent evidence.
 *
 * The reference time is the analysis time the operator is looking at: scan acquisition, or the
 * timeline cursor. A future live feed changes the reference (`now()`), not the rule and not the
 * thresholds. The two are separated deliberately so that adding a feed is a wiring change
 * rather than a re-derivation of every state in the product.
 */

import type { AisObservationOut } from '../api/contract';

/* ============================================================================================== *
 * THRESHOLDS -- every number here is traced to evidence in the product, not chosen by feel.
 * ============================================================================================== */

/**
 * Observed AIS cadence in the product's own fixtures.
 *
 * `backend/tests/test_ais_delivery.py:65` builds an archive with `for minute in (0, 4, 8, 12,
 * 16)` -- 4-minute steps. That is the fastest cadence the product actually models.
 */
export const OBSERVED_CADENCE_S = 240;

/**
 * The correlation window, and the hard ceiling on how old an observation may be and still
 * influence the science.
 *
 * `correlation/match.py:16` `WINDOW_S = 900`, and `match.py:168` skips any observation with
 * `abs(dt) > WINDOW_S` outright -- it is excluded from correlation entirely.
 */
export const CORRELATION_WINDOW_S = 900;

/**
 * Longest interval across which display interpolation is permitted.
 *
 * CHOSEN, NOT GUESSED, and the reasoning matters more than the value:
 *
 * The ceiling must be **below `CORRELATION_WINDOW_S`**. Interpolating across a gap longer than
 * the window would animate a vessel smoothly through water that correlation deliberately treats
 * as no observation at all. The product would then show confident continuous motion over a
 * stretch it has already declared scientifically empty -- display claiming to know something
 * the authority has disclaimed.
 *
 * The floor must be **above `OBSERVED_CADENCE_S`**, or every ordinary interval between two
 * fixes would be a gap and nothing would ever interpolate.
 *
 * 600 s sits between the 4-minute cadence and the 15-minute window: 2.5x cadence, 0.67x window.
 * A contact reporting on the modelled cadence always interpolates; a contact silent for 10
 * minutes does not, and does not pretend to.
 */
export const MAX_INTERPOLATION_INTERVAL_S = 600;

/**
 * Minimum speed for a course to be trusted as an orientation.
 *
 * This is the BACKEND'S OWN threshold, not a new one: `correlation/geodesy.py:29` declines
 * dead reckoning when `sog < 0.1`. Reusing it is the point -- a vessel under 0.1 kn is one the
 * product has already decided not to project anywhere, so letting the display spin its glyph to
 * follow that vessel's reported course would have the interface contradicting the authority in
 * the same build.
 *
 * The hazard this prevents is specific: at near-zero speed AIS COG jitters freely, because the
 * value is essentially noise around an indeterminate direction. Rotating a 12-pixel glyph by
 * that noise makes the contact visibly thrash while sitting still, which reads as "this vessel is
 * manoeuvring" -- an inference the data does not support and that would be read as one.
 */
export const MIN_MOTION_KNOTS = 0.1;

/**
 * Minimum ground distance between two fixes before their separation may define a heading.
 *
 * Below this, the bearing between two nearly-coincident fixes is dominated by position noise
 * rather than by any real course. 30 m is roughly a small vessel length: closer than that, the
 * two fixes are describing one place, not a direction.
 */
export const MIN_DERIVED_DISPLACEMENT_M = 30;

/* ============================================================================================== *
 * CIRCULAR ANGULAR MATH
 * ============================================================================================== */

/**
 * Normalise any angle into `[0, 360)`.
 *
 * Angles wrap. A course of 361 degrees is 1 degree, and treating them as different would make
 * `359 -> 1` look like a 358-degree turn instead of a 2-degree one.
 */
export function normalizeDegrees(deg: number): number {
  if (!Number.isFinite(deg)) return Number.NaN;
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Shortest signed rotation from `from` to `to`, in `(-180, 180]`.
 *
 * Sign is positive for clockwise / increasing-degrees. `circularDeltaDeg(359, 1)` is `+2`, NOT
 * `-358` -- this is the arithmetic DF-X9 §14 requires, and it is the reason rotation smoothing
 * (below) needs a circular delta at all: a naive `a - b` would tell the stabiliser a vessel
 * turned 358 degrees when it turned 2, and it would spin the glyph almost all the way round to
 * correct a 2-degree wobble.
 *
 * `+180` and `-180` are the same rotation. This returns `+180` for both, so the function is
 * total and has exactly one representation of the antipodal case rather than two that depend on
 * floating-point sign.
 */
export function circularDeltaDeg(from: number, to: number): number {
  const delta = normalizeDegrees(to) - normalizeDegrees(from);
  if (!Number.isFinite(delta)) return Number.NaN;
  if (delta > 180) return delta - 360;
  if (delta <= -180) return delta + 360;
  return delta;
}

/**
 * Rotate `current` toward `target` by at most `maxStep` degrees, taking the short way round.
 *
 * Used by the display stabiliser (DF-X9 §19). The raw value is never modified -- the caller keeps
 * it and shows it in the dossier. This only governs how fast the DRAWN glyph turns.
 *
 * The comparison is against the SHORT delta, so a 2-degree wobble that happens to sit either
 * side of 0/360 is treated as a 2-degree move rather than a 358-degree one.
 */
export function approachDegrees(current: number, target: number, maxStep: number): number {
  const limit = Math.abs(maxStep);
  const delta = circularDeltaDeg(current, target);
  if (!Number.isFinite(delta) || !Number.isFinite(limit)) return normalizeDegrees(target);
  if (Math.abs(delta) <= limit) return normalizeDegrees(target);
  return normalizeDegrees(current + Math.sign(delta) * limit);
}

/* ============================================================================================== *
 * GEODESY -- only what display orientation needs
 * ============================================================================================== */

/** Great-circle surface distance in metres, spherical. Adequate for glyph orientation. */
export function surfaceDistanceM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Initial bearing from point A to point B, degrees true.
 *
 * Uses the shortest signed longitude difference rather than the raw one, so a track that steps
 * from 179.9E to 179.9W is recognised as continuing east across the antimeridian instead of
 * being read as a jump backwards across the globe. This is the same wrap-awareness the track
 * renderer needs, expressed once here so both cannot disagree about it.
 */
export function initialBearingDeg(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = Math.PI / 180;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  let dLon = (bLon - aLon) * toRad;
  // Wrap into (-pi, pi] so the antimeridian is not the longest way round.
  while (dLon > Math.PI) dLon -= 2 * Math.PI;
  while (dLon <= -Math.PI) dLon += 2 * Math.PI;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeDegrees(Math.atan2(y, x) / toRad);
}

/* ============================================================================================== *
 * OBSERVATION ACCESSORS -- absence is never zero
 * ============================================================================================== */

/**
 * A measurement is usable only if it is present AND finite.
 *
 * `0` is a legitimate value for all three of these: course 0 is due north, speed 0 is a vessel
 * at anchor, heading 0 is north. The single most consequential thing this module does is keep
 * those distinguishable from absence, because the product's `AisObservation` model goes to
 * explicit lengths to make them distinguishable (`backend/darkfleet/ais/models.py`: an absent
 * measurement is `None` precisely so a vessel at anchor stays distinguishable from one that
 * never broadcast), and reading `0` back as "no data" or `null` back as "0 degrees" would undo
 * that at the display boundary.
 */
function measured(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

/** Speed over ground in knots, or null when the vessel did not report one. */
export function speedKnots(obs: AisObservationOut): number | null {
  return measured(obs.sog);
}

/** Course over ground in degrees true, or null when the vessel did not report one. */
export function courseOverGround(obs: AisObservationOut): number | null {
  const cog = measured(obs.cog);
  return cog === null ? null : normalizeDegrees(cog);
}

/**
 * True heading in degrees true, or null when the vessel did not report one.
 *
 * The AIS 511 "heading not available" sentinel is already normalised to null at ingest
 * (`ais/normalize.py:42`), so it arrives here as absence and this function does not need to know
 * about sentinels at all.
 */
export function trueHeading(obs: AisObservationOut): number | null {
  const heading = measured(obs.heading);
  return heading === null ? null : normalizeDegrees(heading);
}

function epochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : Number.NaN;
}

/** Archive order: ascending time. Unparseable timestamps sort last rather than corrupting order. */
export function byTime(a: AisObservationOut, b: AisObservationOut): number {
  const at = epochSeconds(a.timestamp);
  const bt = epochSeconds(b.timestamp);
  if (!Number.isFinite(at)) return 1;
  if (!Number.isFinite(bt)) return -1;
  return at - bt;
}

/** Observations in archive time order, without mutating the caller's array. */
export function inTimeOrder(observations: readonly AisObservationOut[]): AisObservationOut[] {
  return [...observations].sort(byTime);
}

/**
 * Display-only fast path: the ordinary AIS archive already arrives in
 * chronological order. Validate that fact in one linear pass, and reuse the
 * readonly series without a copy or comparator sort. Unsorted and invalid
 * timestamps use the unchanged public archival sort; equal timestamps retain
 * their original stable order. No path mutates caller observations.
 *
 * Do not memoize the array by identity: archive updates can change its content.
 */
function displayTimeOrder(observations: readonly AisObservationOut[]): readonly AisObservationOut[] {
  if (observations.length < 2) return observations;
  let previous = epochSeconds(observations[0].timestamp);
  if (!Number.isFinite(previous)) return inTimeOrder(observations);
  for (let i = 1; i < observations.length; i += 1) {
    const current = epochSeconds(observations[i].timestamp);
    if (!Number.isFinite(current) || current < previous) return inTimeOrder(observations);
    previous = current;
  }
  return observations;
}

/* ============================================================================================== *
 * ORIENTATION
 * ============================================================================================== */

/** Where a contact's orientation came from. Never a bare number without one of these. */
export type OrientationSource =
  /** A valid AIS true heading, from the vessel itself. */
  | 'HEADING'
  /** Course over ground, used only while the vessel is demonstrably moving. */
  | 'COG'
  /** Bearing between the two most recent observations that are far enough apart to define one. */
  | 'DERIVED_TRACK'
  /** Nothing in the evidence establishes a direction. NOT the same as 0 degrees. */
  | 'UNKNOWN';

export type Orientation = {
  source: OrientationSource;
  /** Degrees true in `[0, 360)`, or null ONLY when `source === 'UNKNOWN'`. */
  degrees: number | null;
  /** Which observation the value was read from, for the dossier. */
  observedAt: string | null;
  /** Why this source won. Surfaced so the choice is auditable rather than implicit. */
  reason: string;
};

/**
 * Whether the contact is demonstrably moving.
 *
 * Prefers the reported speed when there is one, and falls back to the actual distance covered
 * between the two most recent fixes when there is not. The fallback exists because "did not
 * report a speed" and "reported zero" lead to the same conclusion for orientation purposes --
 * neither licenses trusting a course -- but they are different claims, and neither should be
 * resolved by assuming a speed of 0.
 */
export function isMoving(observations: readonly AisObservationOut[]): boolean {
  return isMovingOrdered(inTimeOrder(observations));
}

/** Internal only: caller already made an independent, chronologically sorted copy. */
function isMovingOrdered(ordered: readonly AisObservationOut[]): boolean {
  if (ordered.length === 0) return false;

  const latest = ordered[ordered.length - 1];
  const sog = speedKnots(latest);
  if (sog !== null) {
    // A reported speed settles it. Including zero: an anchored vessel is not moving, and its
    // reported course is the noise this threshold exists to distrust.
    return sog >= MIN_MOTION_KNOTS;
  }

  // No reported speed on the latest fix: fall back to ground truth -- did it actually go
  // anywhere? Two fixes further apart than a vessel length describe movement, not noise.
  if (ordered.length < 2) return false;
  const previous = ordered[ordered.length - 2];
  if (
    previous.lat == null ||
    previous.lon == null ||
    latest.lat == null ||
    latest.lon == null
  ) {
    return false;
  }
  return (
    surfaceDistanceM(previous.lat, previous.lon, latest.lat, latest.lon) >=
    MIN_DERIVED_DISPLACEMENT_M
  );
}

/**
 * Resolve which direction the contact is pointing, and say where that direction came from.
 *
 * PRECEDENCE, and the reason each rung exists:
 *
 *   1. HEADING       -- what the vessel says it is pointing. This is the only source that
 *                      describes the HULL, so it is the only one that survives a vessel whose
 *                      course and heading legitimately differ (crossing current, a vessel
 *                      crabbing, a slow turn). DF-X9 §12: heading and COG are not
 *                      interchangeable, and one must never be labelled as the other.
 *   2. COG           -- where it is going over the ground. Valid, and the product's own
 *                      correlation scores against it (`match.py:184`), but ONLY while moving.
 *                      Below `MIN_MOTION_KNOTS` the reported course is noise and is refused.
 *   3. DERIVED_TRACK -- the bearing between the two most recent well-separated fixes. An
 *                      inference from positions, clearly labelled as one. Used when the vessel
 *                      reported no course at all but demonstrably moved.
 *   4. UNKNOWN       -- nothing establishes a direction.
 *
 * `UNKNOWN` is a real answer and is rendered as an unrotated, non-nodirectional glyph. It is
 * NOT 0 degrees. Drawing an unknown heading as north would be a claim nobody made, and DF-X9
 * §11 forbids it specifically.
 */
export function resolveOrientation(observations: readonly AisObservationOut[]): Orientation {
  return resolveOrientationOrdered(inTimeOrder(observations));
}

/** Avoid sorting the same five-fix series again while building a display state. */
function resolveOrientationOrdered(ordered: readonly AisObservationOut[]): Orientation {
  if (ordered.length === 0) {
    return {
      source: 'UNKNOWN',
      degrees: null,
      observedAt: null,
      reason: 'No observation establishes a direction.',
    };
  }

  const latest = ordered[ordered.length - 1];

  // 1. True heading. Highest authority, and unconditional -- a vessel that reports a heading is
  //    reporting the orientation of the thing the glyph represents.
  const heading = trueHeading(latest);
  if (heading !== null) {
    return {
      source: 'HEADING',
      degrees: heading,
      observedAt: latest.timestamp,
      reason: 'AIS true heading reported by the vessel.',
    };
  }

  const moving = isMovingOrdered(ordered);

  // 2. Course over ground, gated on motion.
  const cog = courseOverGround(latest);
  if (cog !== null) {
    if (!moving) {
      // Fall THROUGH to DERIVED_TRACK / UNKNOWN rather than returning here. A reported course
      // that the product has decided not to trust must not become the answer just by being
      // present.
    } else {
      return {
        source: 'COG',
        degrees: cog,
        observedAt: latest.timestamp,
        reason: 'AIS course over ground reported, and the vessel is moving.',
      };
    }
  }

  // 3. Derived from observed movement. Needs two well-separated fixes.
  if (ordered.length >= 2) {
    const previous = ordered[ordered.length - 2];
    if (
      previous.lat != null &&
      previous.lon != null &&
      latest.lat != null &&
      latest.lon != null
    ) {
      const separation = surfaceDistanceM(previous.lat, previous.lon, latest.lat, latest.lon);
      if (separation >= MIN_DERIVED_DISPLACEMENT_M) {
        return {
          source: 'DERIVED_TRACK',
          degrees: initialBearingDeg(previous.lat, previous.lon, latest.lat, latest.lon),
          observedAt: latest.timestamp,
          reason: `Derived from observed movement over ${Math.round(separation)} m.`,
        };
      }
    }
  }

  return {
    source: 'UNKNOWN',
    degrees: null,
    observedAt: null,
    reason: cog === null
      ? 'No course or heading was reported, and the observations do not separate.'
      : 'A course was reported but the vessel is not moving, so it was not trusted.',
  };
}

/* ============================================================================================== *
 * FRESHNESS
 * ============================================================================================== */

export type Freshness = 'CURRENT' | 'AGING' | 'STALE' | 'LOST';

export type FreshnessReading = {
  tier: Freshness;
  /** Age in seconds, or null when there is no observation to age. */
  ageSeconds: number | null;
  /** Age in seconds rounded to something an operator reads, or null. Never 0 for "unknown". */
  labelSeconds: number | null;
  thresholdReason: string;
};

/**
 * How old a contact's latest observation is, relative to an EXPLICIT reference time.
 *
 * The tiers are anchored to the product's own constants rather than chosen for looks:
 *
 *   CURRENT   age <= OBSERVED_CADENCE_S (240 s) -- within one cadence interval of the modelled
 *             feed. The operator is seeing the contact as reported.
 *   AGING     age <= 2 * OBSERVED_CADENCE_S (480 s) -- one missed interval. Visible, but a
 *             single dropped report is common and does not mean anything yet.
 *   STALE     age <= CORRELATION_WINDOW_S (900 s) -- the contact is outside the window the
 *             product's own correlation considers. The science already declined to use it; the
 *             display says so instead of quietly presenting it as current.
 *   LOST      age > CORRELATION_WINDOW_S -- the observation is excluded from correlation
 *             entirely. Still shown, because an operator should be able to see a contact that
 *             has gone quiet; but never shown as though it were live.
 *
 * A NEGATIVE age -- an observation timestamped after the reference time -- is reported as
 * `CURRENT` with a null age rather than as a negative number. Clocks disagree, and rendering
 * "-4 s" would be a claim about a clock skew nobody measured.
 */
export function freshnessOf(
  observations: readonly AisObservationOut[],
  referenceTimeIso: string,
): FreshnessReading {
  return freshnessOrdered(inTimeOrder(observations), referenceTimeIso);
}

/** Internal only: preserve the public helper's ordering contract without re-sorting. */
function freshnessOrdered(
  ordered: readonly AisObservationOut[],
  referenceTimeIso: string,
): FreshnessReading {
  if (ordered.length === 0) {
    return {
      tier: 'LOST',
      ageSeconds: null,
      labelSeconds: null,
      thresholdReason: 'No observation exists for this contact.',
    };
  }

  const latest = ordered[ordered.length - 1];
  const latestAt = epochSeconds(latest.timestamp);
  const referenceAt = epochSeconds(referenceTimeIso);

  if (!Number.isFinite(latestAt) || !Number.isFinite(referenceAt)) {
    return {
      tier: 'LOST',
      ageSeconds: null,
      labelSeconds: null,
      thresholdReason: 'The observation or reference timestamp could not be parsed.',
    };
  }

  const age = referenceAt - latestAt;
  if (age < 0) {
    return {
      tier: 'CURRENT',
      ageSeconds: null,
      labelSeconds: null,
      thresholdReason: 'The observation is newer than the reference time.',
    };
  }

  let tier: Freshness;
  let thresholdReason: string;
  if (age <= OBSERVED_CADENCE_S) {
    tier = 'CURRENT';
    thresholdReason = `Within one observed cadence interval (${OBSERVED_CADENCE_S} s).`;
  } else if (age <= 2 * OBSERVED_CADENCE_S) {
    tier = 'AGING';
    thresholdReason = `Beyond one cadence interval (${OBSERVED_CADENCE_S} s), within two.`;
  } else if (age <= CORRELATION_WINDOW_S) {
    tier = 'STALE';
    thresholdReason = `Beyond two cadence intervals; still inside the ${CORRELATION_WINDOW_S} s correlation window.`;
  } else {
    tier = 'LOST';
    thresholdReason = `Older than the ${CORRELATION_WINDOW_S} s correlation window, so correlation excludes this observation.`;
  }

  return { tier, ageSeconds: age, labelSeconds: Math.round(age), thresholdReason };
}

/* ============================================================================================== *
 * DISPLAY STATE
 * ============================================================================================== */

export type ContactDisplayState =
  /** Drawn exactly where a recorded observation says it is. */
  | 'OBSERVED'
  /** Drawn between two observations, for legibility only. NOT a measurement. */
  | 'INTERPOLATED_DISPLAY'
  /** Drawn at a position the BACKEND dead-reckoned to SAR acquisition time. NOT a measurement. */
  | 'PREDICTED'
  /** The contact's latest observation is old; the glyph is drawn faded at that old fix. */
  | 'STALE'
  /**
   * The playback time is BEFORE this contact's first observation.
   *
   * A REAL STATE, ADDED BY DF-X9.4, and the alternative to two failures. Either the contact
   * back-propagates across the empty span -- inventing positions before any measurement existed --
   * or it is silently omitted, which makes an archive not yet reached look like one that was never
   * there. Neither is truthful.
   *
   * Nothing is drawn for such a contact, because there is no position to draw. What is shown is its
   * absence with a stated cause.
   */
  | 'NOT_YET_OBSERVED'
  /** No usable observation, or one the product would exclude from correlation. */
  | 'LOST';

/**
 * One contact's render state, with its provenance attached.
 *
 * `sourceObservationTimestamps` is the field that makes this honest. Every position this type
 * can carry is traceable to the observations it came from, so a reviewer can always answer "what
 * was actually measured here?" -- and for `INTERPOLATED_DISPLAY` the answer is "these two, and
 * the point between them", which is visibly not the same claim as an observation.
 */
export type DisplayContactState = {
  mmsi: string;
  /** The coordinate to draw, or null when there is nothing to draw. */
  lat: number | null;
  lon: number | null;
  state: ContactDisplayState;
  /** The displayed timestamp. For OBSERVED it IS the observation's own. */
  at: string | null;
  /** Every observation this display position derives from. Empty when nothing is displayed. */
  sourceObservationTimestamps: readonly string[];
  orientation: Orientation;
  freshness: FreshnessReading;
  /** The observation's own values, unmodified, for the dossier and any export. */
  reported: {
    sogKnots: number | null;
    cogDegrees: number | null;
    headingDegrees: number | null;
  } | null;
};

/**
 * Linear interpolation between two observations, for display only.
 *
 * THE ONE FUNCTION IN THIS MODULE THAT PRODUCES A COORDINATE THAT WAS NOT MEASURED, and it is
 * therefore the one that returns `sourceObservationTimestamps` for both inputs. Its callers are
 * responsible for the resulting `state` being `INTERPOLATED_DISPLAY` -- never `OBSERVED`.
 *
 * Returns null rather than an interpolated point when:
 *   - either position is missing (absence must not become a coordinate);
 *   - the interval exceeds `MAX_INTERPOLATION_INTERVAL_S` (DF-X9 §8 -- do not animate
 *     continuously as if tracked across a gap);
 *   - the two observations are antipodal in longitude, where the short way round is genuinely
 *     ambiguous and no honest choice exists.
 */
export function interpolateForDisplay(
  from: AisObservationOut,
  to: AisObservationOut,
  fraction: number,
): { lat: number; lon: number } | null {
  if (
    from.lat == null ||
    from.lon == null ||
    !Number.isFinite(from.lat) ||
    !Number.isFinite(from.lon)
  ) {
    return null;
  }
  if (
    to.lat == null ||
    to.lon == null ||
    !Number.isFinite(to.lat) ||
    !Number.isFinite(to.lon)
  ) {
    return null;
  }
  const fromLat = from.lat;
  const fromLon = from.lon;
  const toLat = to.lat;
  const toLon = to.lon;

  const fromAt = epochSeconds(from.timestamp);
  const toAt = epochSeconds(to.timestamp);
  if (!Number.isFinite(fromAt) || !Number.isFinite(toAt)) return null;

  const interval = Math.abs(toAt - fromAt);
  // The gap check. Not `>=`: an interval of exactly the limit is within the limit.
  if (interval > MAX_INTERPOLATION_INTERVAL_S) return null;

  let dLon = toLon - fromLon;
  while (dLon > 180) dLon -= 360;
  while (dLon < -180) dLon += 360;
  // Exactly antipodal: two equally short ways round, and picking one would be an invention.
  if (Math.abs(dLon) === 180) return null;

  const clamped = Math.min(1, Math.max(0, fraction));
  return {
    lat: fromLat + (toLat - fromLat) * clamped,
    lon: normalizeDegrees(fromLon + dLon * clamped),
  };
}

/**
 * Build the display state for one contact at an explicit reference time.
 *
 * `atTimeIso` is when the operator is LOOKING, which is not the same as when the vessel was
 * last seen. The two being confusable is what makes a stale contact look live.
 *
 * THE BRACKETING RULE, which is the heart of this function:
 *
 *   The display position at time T comes from the two observations that BRACKET T -- the last
 *   one at or before T, and the next one after. If both exist and their interval is within
 *   `MAX_INTERPOLATION_INTERVAL_S`, the contact is drawn between them and the state is
 *   `INTERPOLATED_DISPLAY`.
 *
 *   Otherwise the contact is drawn at a REAL FIX and never moved:
 *
 *     T before every observation  -> drawn at the EARLIEST fix. Nothing is known about earlier
 *                                    times, and inventing a position there would be invention.
 *     T after every observation   -> drawn at the LATEST fix. NOT extrapolated forward. This is
 *                                    the case that matters most: a live-looking contact whose
 *                                    last report was two minutes ago is exactly the case where
 *                                    sliding it forward would look smooth and be a lie.
 *
 * An earlier revision of this function held the opposite rule -- it interpolated whenever the
 * reference time was at or after the latest fix -- and computed its fraction as
 * `(reference - latest) / (reference - previous)`. For a reference time 14 minutes past a fix
 * that arrived 4 minutes in, that yields 0.78 between the previous fix and the latest one: a
 * position PAST the newest observation, drawn smoothly, with the freshest evidence behind it.
 * Every one of those claims is false and each would have looked correct on screen. The bracket
 * formulation has no forward case at all, so the failure is not merely guarded against, it is
 * unrepresentable.
 */
export function displayStateOf(
  observations: readonly AisObservationOut[],
  atTimeIso: string,
): DisplayContactState {
  const ordered = displayTimeOrder(observations);
  // The former call chain sorted + parsed these same timestamps four times:
  // here, then in resolveOrientation, again in isMoving, and in freshnessOf.
  // Keep the public helpers independently order-safe, but share this single
  // immutable sorted copy across all per-contact stages in the hot renderer.
  const orientation = resolveOrientationOrdered(ordered);
  const freshness = freshnessOrdered(ordered, atTimeIso);
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;

  const reported = latest
    ? {
        sogKnots: speedKnots(latest),
        cogDegrees: courseOverGround(latest),
        headingDegrees: trueHeading(latest),
      }
    : null;

  const base = {
    mmsi: latest?.mmsi ?? '',
    orientation,
    freshness,
    reported,
  };

  // Nothing observed. A predicted position alone is not a contact to draw: it is a hypothesis
  // about a vessel we have no fix for, and showing it as a contact would be showing the
  // conclusion as though it were the observation.
  if (latest === null) {
    return { ...base, lat: null, lon: null, state: 'LOST', at: null, sourceObservationTimestamps: [] };
  }

  const referenceAt = epochSeconds(atTimeIso);
  const earliest = ordered[0];
  const earliestAt = epochSeconds(earliest.timestamp);

  if (!Number.isFinite(referenceAt)) {
    // Unparseable reference time. Draw the latest real fix rather than guessing at an instant.
    return {
      ...base,
      lat: latest.lat ?? null,
      lon: latest.lon ?? null,
      state: freshness.tier === 'CURRENT' ? 'OBSERVED' : 'STALE',
      at: latest.timestamp,
      sourceObservationTimestamps: [latest.timestamp],
    };
  }

  /*
   * STRICTLY BEFORE THE EARLIEST OBSERVATION: NOT YET OBSERVED.
   *
   * Changed by DF-X9.4 from drawing the contact AT its earliest fix. That was a fabrication in a
   * subtler form than extrapolation: the vessel had not been seen at all at this instant, and
   * drawing it at its first known position asserted a presence the evidence does not support. It
   * looked defensible because the drawn point is a REAL observation -- the lie is in the timing.
   *
   * Nothing is drawn, and `sourceObservationTimestamps` is EMPTY rather than carrying the earliest
   * fix: this state is not derived from that observation, it is defined by its absence.
   *
   * Freshness still reports the age of the newest observation, so the dossier can say what IS known
   * while the globe says the contact is not yet present.
   */
  if (referenceAt < earliestAt) {
    return {
      ...base,
      lat: null,
      lon: null,
      state: 'NOT_YET_OBSERVED',
      at: null,
      sourceObservationTimestamps: [],
    };
  }

  // Strictly AFTER the latest observation: no forward interpolation, ever. Drawn at the newest
  // real fix, and its staleness is whatever the freshness reading says.
  if (referenceAt >= epochSeconds(latest.timestamp)) {
    const state: ContactDisplayState =
      freshness.tier === 'LOST'
        ? 'LOST'
        : freshness.tier === 'STALE' || freshness.tier === 'AGING'
          ? 'STALE'
          : 'OBSERVED';
    return {
      ...base,
      lat: latest.lat ?? null,
      lon: latest.lon ?? null,
      state,
      at: latest.timestamp,
      sourceObservationTimestamps: [latest.timestamp],
    };
  }

  // An EXACT observation time is observed, not interpolated. Landing on a recorded instant is
  // the one case where the displayed coordinate is literally a measurement, and reporting
  // `INTERPOLATED_DISPLAY` there would understate the evidence for no benefit -- the drawn
  // position and the recorded position are the same point.
  for (const candidate of ordered) {
    if (epochSeconds(candidate.timestamp) === referenceAt) {
      return {
        ...base,
        lat: candidate.lat ?? null,
        lon: candidate.lon ?? null,
        state: 'OBSERVED',
        at: candidate.timestamp,
        sourceObservationTimestamps: [candidate.timestamp],
      };
    }
  }

  // The reference time lies strictly between two observations. Find the bracketing pair.
  let before = ordered[0];
  let after = latest;
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const lower = epochSeconds(ordered[i].timestamp);
    const upper = epochSeconds(ordered[i + 1].timestamp);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
    if (lower <= referenceAt && referenceAt < upper) {
      before = ordered[i];
      after = ordered[i + 1];
      break;
    }
  }

  const lowerAt = epochSeconds(before.timestamp);
  const upperAt = epochSeconds(after.timestamp);
  const span = upperAt - lowerAt;
  const point = span > 0 ? interpolateForDisplay(before, after, (referenceAt - lowerAt) / span) : null;

  if (point) {
    return {
      ...base,
      lat: point.lat,
      lon: point.lon,
      state: 'INTERPOLATED_DISPLAY',
      at: atTimeIso,
      sourceObservationTimestamps: [before.timestamp, after.timestamp],
    };
  }

  // Bracketed in time but NOT interpolatable -- the interval exceeded the limit, or the two
  // observations are antipodal. Drawn at the earlier real fix, because it is the closest
  // observation at or before the reference time and is therefore not extrapolated.
  return {
    ...base,
    lat: before.lat ?? null,
    lon: before.lon ?? null,
    state: 'OBSERVED',
    at: before.timestamp,
    sourceObservationTimestamps: [before.timestamp],
  };
}

/**
 * The contact's state when the product is showing the backend's analytical prediction.
 *
 * A separate constructor on purpose. The predicted position is NOT a moving-contact state and
 * must never be animated through: it is a single analytical point computed at scan time for one
 * specific instant. DF-X9 §43 -- never animate the contact through a predicted analytical point
 * as if it were observed.
 */
export function predictedDisplayState(
  mmsi: string,
  predicted: { lat: number; lon: number } | null,
  observations: readonly AisObservationOut[],
  atTimeIso: string,
): DisplayContactState {
  const ordered = inTimeOrder(observations);
  const base = {
    mmsi,
    orientation: resolveOrientation(ordered),
    freshness: freshnessOf(ordered, atTimeIso),
    reported: null,
  };
  if (!predicted || !Number.isFinite(predicted.lat) || !Number.isFinite(predicted.lon)) {
    return {
      ...base,
      lat: null,
      lon: null,
      state: 'PREDICTED',
      at: null,
      sourceObservationTimestamps: [],
    };
  }
  return {
    ...base,
    lat: predicted.lat,
    lon: predicted.lon,
    state: 'PREDICTED',
    at: null,
    // Deliberately EMPTY. The prediction was not derived from these observations -- it was
    // derived from one observation plus a speed, a course and a time delta, by the backend. If
    // the bracketing timestamps were listed here it would claim a provenance it does not have.
    sourceObservationTimestamps: [],
  };
}

/* ============================================================================================== *
 * DISPLAY STABILISATION
 * ============================================================================================== */

/**
 * Rate-limited rotation for the drawn glyph. The ANALYTICAL value is untouched.
 *
 * AIS heading jitters: a vessel at a steady course reports 091 one second and 092 the next, and
 * a naive renderer turns that into a visibly twitching glyph. DF-X9 §19 asks for smoothing; §19
 * also requires the raw value stay exposed, which is why this takes the raw target and returns a
 * separate DISPLAY angle rather than mutating anything.
 *
 * `minDeltaDeg` is a deadband: motion smaller than this is not a turn, it is noise, and is
 * simply not drawn. `maxStepDeg` is a rate limit: a real turn still animates, but cannot snap.
 */
export function stabilizeOrientation(
  previousDisplayDeg: number | null,
  rawDegrees: number | null,
  maxStepDeg: number,
  minDeltaDeg: number,
): number | null {
  if (rawDegrees === null || !Number.isFinite(rawDegrees)) return previousDisplayDeg;
  const target = normalizeDegrees(rawDegrees);
  if (previousDisplayDeg === null || !Number.isFinite(previousDisplayDeg)) return target;

  const delta = circularDeltaDeg(previousDisplayDeg, target);
  if (Math.abs(delta) < minDeltaDeg) return normalizeDegrees(previousDisplayDeg);
  return approachDegrees(previousDisplayDeg, target, maxStepDeg);
}

/* ============================================================================================== *
 * TRACK SEGMENTATION
 * ============================================================================================== */

export type TrackSegmentKind = 'OBSERVED' | 'INTERPOLATED_DISPLAY' | 'GAP';

export type TrackSegment = {
  kind: TrackSegmentKind;
  points: Array<{ lat: number; lon: number }>;
  /** The bracketing observation timestamps. Empty for a GAP, which has no endpoints in evidence. */
  fromTimestamp: string | null;
  toTimestamp: string | null;
  /** Seconds spanned. Null when it could not be computed. */
  spanSeconds: number | null;
};

/**
 * Split a track into observed stretches, interpolatable stretches, and breaks.
 *
 * DF-X9 §25/§26: a gap must be a VISIBLE BREAK, not a continuous line drawn across missing
 * data. The product's own observed track was one solid polyline through every fix
 * (`engine.ts:1262`), which means a two-hour hole rendered as confidently as a two-minute
 * interval.
 *
 * A single fix is not a track and is not emitted as one. DF-X9 §50: do not call one point a
 * track.
 */
export function segmentTrack(
  observations: readonly AisObservationOut[],
): TrackSegment[] {
  const ordered = inTimeOrder(observations);
  if (ordered.length < 2) return [];

  const segments: TrackSegment[] = [];
  let run: TrackSegment = {
    kind: 'OBSERVED',
    points: [],
    fromTimestamp: null,
    toTimestamp: null,
    spanSeconds: null,
  };

  const flush = () => {
    if (run.points.length >= 2 && run.fromTimestamp !== null) {
      segments.push(run);
    }
  };

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const a = ordered[i];
    const b = ordered[i + 1];
    if (
      a.lat == null ||
      a.lon == null ||
      b.lat == null ||
      b.lon == null ||
      !Number.isFinite(a.lat) ||
      !Number.isFinite(a.lon) ||
      !Number.isFinite(b.lat) ||
      !Number.isFinite(b.lon)
    ) {
      continue;
    }
    const aLat = a.lat;
    const aLon = a.lon;
    const bLat = b.lat;
    const bLon = b.lon;
    const at = epochSeconds(a.timestamp);
    const bt = epochSeconds(b.timestamp);
    const span = Number.isFinite(at) && Number.isFinite(bt) ? bt - at : null;

    const withinLimit = span !== null && span <= MAX_INTERPOLATION_INTERVAL_S;
    if (withinLimit) {
      if (run.kind === 'GAP') {
        flush();
        run = {
          kind: 'OBSERVED',
          points: [],
          fromTimestamp: null,
          toTimestamp: null,
          spanSeconds: null,
        };
      }
      run.kind = 'OBSERVED';
      if (run.points.length === 0) {
        run.points.push({ lat: aLat, lon: aLon });
        run.fromTimestamp = a.timestamp;
      }
      run.points.push({ lat: bLat, lon: bLon });
      run.toTimestamp = b.timestamp;
      run.spanSeconds = (run.spanSeconds ?? 0) + (span ?? 0);
    } else {
      flush();
      segments.push({
        kind: 'GAP',
        points: [{ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }],
        fromTimestamp: a.timestamp,
        toTimestamp: b.timestamp,
        // Null, not zero and not the raw span: the span is unknown, and inventing one is what
        // this whole model exists to prevent.
        spanSeconds: span,
      });
      run = {
        kind: 'OBSERVED',
        points: [],
        fromTimestamp: null,
        toTimestamp: null,
        spanSeconds: null,
      };
    }
  }
  flush();
  return segments;
}
