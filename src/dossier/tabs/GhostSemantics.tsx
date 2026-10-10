/**
 * GHOST VESSEL SEMANTICS -- the decision record, stated as arithmetic.
 *
 * ================================ WHY THIS EXISTS ================================
 *
 * `GhostVesselPanel.tsx` rendered all of this and was reachable from nothing: its only
 * importer was `TargetIntel`, which `DarkFleetCommandApp.tsx` superseded with the dossier.
 * So the backend computed the candidate count, the acceptance threshold, the rejected near
 * miss and the score decomposition, returned them over `/targets/{id}`, and no operator could
 * see any of them.
 *
 * THE CHOICE WAS INTEGRATION, NOT A TWELFTH TAB, and the reason is that the dossier was already
 * doing the work. `EvidenceTab` calls `loadTargetSlice(targetRef)` -- the SAME endpoint the dead
 * panel fetched -- already narrows `ghost_vessel` by its discriminator, and already renders the
 * designation, the analytical class and the semantic warning. So restoring the panel would have
 * meant a second fetch of one URL, a second component drawing the same warning, and two
 * divergent copies of Observed/Hypotheses/Unknowns. That is the "two surfaces disagreeing about
 * the same target" duplication the superseding commit existed to remove, re-introduced one layer
 * down. `GhostVesselPanel.tsx` and its dead importer `TargetIntel.tsx` were deleted.
 *
 * ================================ WHAT THIS MUST NOT DO ================================
 *
 * No browser rescore. Every number below is printed from the backend's own record. The frontend
 * does not recompute a score, does not re-derive a match, and does not compare against its own
 * copy of the threshold: a second scoring implementation is a second set of answers to the same
 * question, and only one of them is the analytical authority.
 *
 * Absences stay absent. `candidates_considered: null` renders as NOT ESTABLISHED and is never
 * coerced to zero, because "we did not record how many were considered" and "there were none" are
 * different findings and collapsing them is the DF-X7 regression all over again.
 */

import type {
  GhostAssociationDecision,
  GhostObservedEvidence,
  GhostVesselDossier,
  RejectedCandidate,
  ScoreDecomposition,
} from '../../api/contract';
import { Empty, Maybe, Pill, Row, SectionTitle, SubTitle } from '../primitives';

/* ============================================================================================== *
 * THE COVERAGE QUESTION, WHICH IS NOT ONE BIT
 * ============================================================================================== */

/**
 * Why no association was accepted, as a distinct state rather than a number.
 *
 * DF-X7 found the defect this exists to prevent: `candidatesConsidered = 0` was being presented
 * as though it meant AIS coverage was unavailable, and those are unrelated facts. A system with
 * excellent AIS coverage that had no vessel near the target yields zero candidates; a system with
 * no AIS source at all yields zero candidates too. Same number, completely different finding, and
 * an operator who is told "0 candidates" and nothing else cannot tell which they are looking at.
 *
 * So the states are enumerated from what the backend can ACTUALLY establish, and the one it
 * cannot establish is refused rather than guessed:
 *
 *   AIS SOURCE NOT CONFIGURED  the coverage state says so
 *   NO COVERAGE                the coverage state says so
 *   PARTIAL COVERAGE           coverage exists and was incomplete
 *   ZERO CANDIDATES            coverage existed, and nothing was near enough to consider
 *   CANDIDATES REJECTED        candidates existed and were scored below threshold
 *   NOT ESTABLISHED            the record does not say
 *
 * "ZERO OBSERVATIONS" is deliberately absent. Nothing in this record counts observations in the
 * search window -- `candidates_considered` counts AIS vessels that were considered, which is a
 * different quantity. Reporting it would mean inventing a measurement the backend does not make,
 * which is the error this whole feature is built to avoid.
 */
export type CoverageVerdict =
  | 'AIS_SOURCE_NOT_CONFIGURED'
  | 'NO_COVERAGE'
  | 'PARTIAL_COVERAGE'
  | 'ZERO_CANDIDATES'
  | 'CANDIDATES_REJECTED'
  | 'NOT_ESTABLISHED';

/** The establishable states, in the order they are meaningful (most specific evidence first). */
export const COVERAGE_VERDICT_LABEL: Readonly<Record<CoverageVerdict, string>> = {
  AIS_SOURCE_NOT_CONFIGURED: 'AIS SOURCE NOT CONFIGURED',
  NO_COVERAGE: 'NO AIS COVERAGE',
  PARTIAL_COVERAGE: 'PARTIAL AIS COVERAGE',
  ZERO_CANDIDATES: 'ZERO CANDIDATES CONSIDERED',
  CANDIDATES_REJECTED: 'CANDIDATES REJECTED',
  NOT_ESTABLISHED: 'NOT ESTABLISHED',
};

export function coverageVerdict(
  decision: GhostAssociationDecision | null | undefined,
): CoverageVerdict {
  if (!decision) return 'NOT_ESTABLISHED';

  // The coverage states are checked FIRST, before the candidate count. A source that was never
  // configured did not consider zero candidates -- it was never able to consider any, and
  // reporting its candidate count would present a missing input as a measured result.
  const coverage = (decision.ais_coverage_state ?? '').toUpperCase();
  if (coverage === 'NOT_CONFIGURED') return 'AIS_SOURCE_NOT_CONFIGURED';
  if (coverage === 'NO_COVERAGE') return 'NO_COVERAGE';
  if (coverage === 'PARTIAL') return 'PARTIAL_COVERAGE';

  const considered = decision.candidates_considered;
  // null is an ABSENCE and never a zero. See the module header.
  if (considered === null || considered === undefined) return 'NOT_ESTABLISHED';
  if (considered === 0) return 'ZERO_CANDIDATES';
  if (considered > 0) return 'CANDIDATES_REJECTED';

  return 'NOT_ESTABLISHED';
}

/* ============================================================================================== *
 * FORMATTING. Every absence stays an absence.
 * ============================================================================================== */

/** A number, or an explicit absence. `0.00` is a real measurement and must survive. */
function num(value: number | null | undefined, digits = 2): string | null {
  // A null check, NOT `value || fallback`: zero is a measured score and `0 || '-'` renders a dash
  // for it. That single operator produced seven false readings in one of my own harnesses.
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(digits);
}

function metres(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${Math.round(value).toLocaleString('en-GB')} m`;
}

/* ============================================================================================== *
 * THE OBSERVED REGISTER -- stated from structure, not from prose
 * ============================================================================================== */

/**
 * What was measured, as label/value pairs read from `GhostObservedEvidence`.
 *
 * Read from the structured fields rather than from a summary sentence, so it cannot drift from the
 * numbers rendered beside it. A wake reading of `false` is printed as "NO" and a reading of `null`
 * is printed as absent -- those are different facts and the difference is the point.
 */
function observedRows(observed: GhostObservedEvidence): Array<[string, string | null]> {
  const rows: Array<[string, string | null]> = [];

  rows.push(['SAR detection confidence', num(observed.sar_detection_confidence)]);
  // `GhostObservedPosition.lat` and `.lon` are BOTH nullable, so each is checked independently.
  // A position with a latitude and no longitude is a partial record, not a position of
  // "0, undefined" -- and the shape of the coordinate pair is itself the finding.
  rows.push([
    'Position',
    observed.position?.lat === null || observed.position?.lat === undefined
      ? null
      : observed.position?.lon === null || observed.position?.lon === undefined
        ? `${observed.position.lat.toFixed(5)}, longitude not established`
        : `${observed.position.lat.toFixed(5)}, ${observed.position.lon.toFixed(5)}`,
  ]);
  rows.push(['Marine region', observed.marine_region]);
  rows.push(['Apparent length', metres(observed.apparent_footprint_m?.length)]);
  rows.push(['Apparent width', metres(observed.apparent_footprint_m?.width)]);
  rows.push(['Length uncertainty', metres(observed.length_uncertainty_m)]);
  rows.push([
    'Orientation',
    observed.orientation_deg === null || observed.orientation_deg === undefined
      ? null
      : `${observed.orientation_deg.toFixed(1)}°`,
  ]);
  rows.push(['Mean backscatter', num(observed.mean_backscatter_db)]);
  rows.push(['Max backscatter', num(observed.max_backscatter_db)]);
  // A boolean must be tri-state. `false` is a measurement; `null` is an absence.
  rows.push([
    'Wake detected',
    observed.wake_detected === null || observed.wake_detected === undefined
      ? null
      : observed.wake_detected
        ? 'YES'
        : 'NO',
  ]);
  rows.push(['Polarization evidence', observed.polarization_evidence]);
  rows.push(['Multipass evidence', observed.multipass_evidence]);

  return rows;
}

/* ============================================================================================== *
 * THE REJECTED NEAR MISS -- the finding that is not the finding
 * ============================================================================================== */

/** Render only the recorded rejection category, without browser-side rescoring. */
export function rejectionReasonLabel(reason: RejectedCandidate['rejectionReason']): string {
  switch (reason) {
    case 'BELOW_THRESHOLD': return 'BELOW ACCEPTANCE THRESHOLD';
    case 'ONE_TO_ONE_CONFLICT': return 'AIS IDENTITY ALREADY ASSIGNED TO ANOTHER SAR TARGET';
    case 'LOWER_RANKED_ALTERNATIVE': return 'LOWER-RANKED CANDIDATE';
    case 'AMBIGUOUS_PAIR': return 'AMBIGUOUS NEAR-EQUAL CANDIDATES';
    default: return 'REJECTION CAUSE NOT RECORDED';
  }
}

function RejectedCandidateBlock({ candidate }: { candidate: RejectedCandidate }) {
  return (
    <div className="mt-1 border-l-2 border-structural-bright pl-2" data-df-ghost-rejected>
      <SubTitle>Closest rejected candidate</SubTitle>
      {/*
       * A rejected near miss and an empty search are DIFFERENT findings and are never collapsed:
       * `closest_rejected_candidate: null` with zero candidates means nothing was available to
       * correlate, which is not the same as "something was close and did not qualify".
       */}
      <Row label="MMSI">
        <span className="df-num">{candidate.mmsi}</span>
      </Row>
      <Row label="Name">
        <Maybe value={candidate.vesselName ?? null} />
      </Row>
      <Row label="Composite score">
        <span className="df-num">{num(candidate.score)}</span>
      </Row>
      <Row label="Rejection cause">
        <span className="df-num">{rejectionReasonLabel(candidate.rejectionReason)}</span>
      </Row>
      {candidate.rejectionReason === 'BELOW_THRESHOLD' ? (
        <Row label="Short by" tone="warn">
          <span className="df-num">{num(candidate.shortfall)}</span>
        </Row>
      ) : null}
      <Row label="Separation">
        <span className="df-num">
          <Maybe value={metres(candidate.distanceMeters)} />
        </span>
      </Row>
      <Row label="Time offset">
        <span className="df-num">
          {candidate.timeDeltaSeconds === null || candidate.timeDeltaSeconds === undefined
            ? null
            : `${candidate.timeDeltaSeconds.toFixed(0)} s`}
        </span>
      </Row>
    </div>
  );
}

/** The score decomposition, so a rejected candidate can be interrogated rather than trusted. */
function Decomposition({ decomposition }: { decomposition: ScoreDecomposition }) {
  return (
    <div className="mt-1 border-l-2 border-structural/60 pl-2" data-df-ghost-decomposition>
      <SubTitle>Rejected candidate score decomposition</SubTitle>
      <Row label="Spatial">
        <span className="df-num">{num(decomposition.spatialScore)}</span>
      </Row>
      <Row label="Temporal">
        <span className="df-num">{num(decomposition.temporalScore)}</span>
      </Row>
      <Row label="Heading">
        <span className="df-num">{num(decomposition.headingScore)}</span>
      </Row>
      <Row label="Size">
        <span className="df-num">{num(decomposition.sizeScore)}</span>
      </Row>
      <Row label="Composite">
        <span className="df-num">{num(decomposition.compositeScore)}</span>
      </Row>
      <Row label="Match radius">
        <span className="df-num">{metres(decomposition.matchRadiusMeters)}</span>
      </Row>
      <Row label="Distance offset">
        <span className="df-num">{metres(decomposition.distanceOffsetMeters)}</span>
      </Row>
      <Row label="Time offset">
        <span className="df-num">{decomposition.timeDeltaSeconds.toFixed(0)} s</span>
      </Row>
    </div>
  );
}

/* ============================================================================================== *
 * THE SURFACE
 * ============================================================================================== */

/**
 * Everything about WHY this target is a Ghost Vessel, in one place.
 *
 * Rendered only for the Ghost Vessel branch of the union. For `GhostVesselNotApplicable` this
 * renders nothing at all, because "not applicable" is not a Ghost Vessel dossier with empty
 * fields and rendering an empty decision block beside a real target would imply a correlation
 * attempt that never happened.
 */
export function GhostSemantics({ ghost }: { ghost: GhostVesselDossier }) {
  const decision = ghost.decision ?? null;
  const verdict = coverageVerdict(decision);

  return (
    <div className="space-y-2" data-df-ghost-semantics="true">
      <SectionTitle
        right={
          <Pill tone={verdict === 'NOT_ESTABLISHED' ? 'neutral' : 'warn'}>
            {COVERAGE_VERDICT_LABEL[verdict]}
          </Pill>
        }
      >
        Why no association was accepted
      </SectionTitle>

      {decision === null ? (
        /*
         * The record carries no decision. That is an absence in the evidence, not a decision that
         * nothing was considered -- so it is stated as one rather than filled with zeroes.
         */
        <Empty
          heading="NO DECISION RECORD"
          detail="This target's evidence document does not carry an association decision. DarkFleet does not know why no candidate was accepted, and is not going to guess."
        />
      ) : (
        <>
          <Row label="AIS candidates considered">
            <span className="df-num">{num(decision.candidates_considered, 0)}</span>
          </Row>
          <Row label="Acceptance threshold">
            <span className="df-num">{num(decision.acceptance_threshold)}</span>
          </Row>
          <Row label="AIS association confidence">
            <span className="df-num">{num(decision.ais_association_confidence)}</span>
          </Row>
          <Row label="AIS coverage state">
            <span className="df-num">{(decision.ais_coverage_state ?? '').replace(/_/g, ' ') || null}</span>
          </Row>
          {/*
           * The backend's own sentence, verbatim. Not a frontend restatement of it: this string is
           * the analytical authority's wording, and paraphrasing it would put two vocabularies on
           * one finding.
           */}
          <Row label="Reason recorded">
            <Maybe value={decision.reason_no_association || null} />
          </Row>

          {decision.closest_rejected_candidate ? (
            <RejectedCandidateBlock candidate={decision.closest_rejected_candidate} />
          ) : (
            <p className="pt-1 text-[11px] leading-relaxed text-ink-dim">
              No AIS candidate was available to correlate in the search window. That is a different
              finding from a near miss, and the two are not merged.
            </p>
          )}

          {decision.score_decomposition ? (
            <Decomposition decomposition={decision.score_decomposition} />
          ) : null}
        </>
      )}

      {/* The structured measurements, beside the decision that used them. */}
      <div>
        <SubTitle>Observed</SubTitle>
        {observedRows(ghost.observed).map(([label, value]) => (
          <Row key={label} label={label}>
            <Maybe value={value} />
          </Row>
        ))}
      </div>
    </div>
  );
}
