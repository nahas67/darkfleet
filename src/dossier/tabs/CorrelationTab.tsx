/**
 * CORRELATION -- why this target matched, or failed to match, AIS.
 *
 * This is the flagship analytical surface, and the thing it must never do is
 * re-derive the answer. Every number here is read from the correlation record the
 * backend produced. No score is recomputed in the browser, no candidate is
 * re-ranked, no threshold is re-applied. If the arithmetic looks wrong the answer
 * is to fix the backend under the defect-stop rule, not to adjust a display.
 *
 * WHAT THE CORRELATION RECORD CAN AND CANNOT ANSWER
 *
 * `candidatesConsidered` is a count of candidates the correlation evaluated. It is
 * NOT a statement about coverage, and reading it as one is a mistake this tab
 * originally made: with zero candidates it announced "COVERAGE AVAILABLE -- NO
 * CANDIDATES ENTERED THE MATCH WINDOW" on a deployment that had no AIS archive at
 * all. A zero candidate count is equally consistent with nobody listening.
 *
 * The correlation record carries no coverage state, so this tab cannot distinguish
 * case A from case B and does not pretend to. It reports what the record supports --
 * no candidates entered the window -- and names the coverage question as one the
 * AIS tab answers, with its scope stated. Claiming coverage from a count is exactly
 * the kind of inference that makes an absence look like an observation.
 *
 * THE FOUR CASES, AND WHO ESTABLISHES EACH
 *
 *   A  NO COVERAGE              the AIS tab, from the archive and window
 *   B  NO CANDIDATES IN WINDOW  this tab, from the candidate count alone
 *   C  CANDIDATES REJECTED      this tab: candidates evaluated, none accepted
 *   D  ACCEPTED                 this tab: one candidate exceeded the threshold
 *
 * B and C must not merge. "Nothing entered the window" and "something entered and we
 * said no" point in opposite directions.
 *
 * ON THE RANKED CANDIDATE TABLE
 *
 * The record exposes `candidatesConsidered` as a COUNT and `closestRejected` as a
 * SINGLE candidate. It does not expose the evaluated candidate list, so there is
 * nothing to rank and this tab does not pretend otherwise. A table of invented
 * candidates would be the most dangerous element possible on this screen: it would
 * look like the correlation weighed five vessels and show three of them.
 */

import type { AisAssociation, VesselTarget } from '../../api/contract';
import { measurement, text } from '../format';
import {
  AbsentText,
  DataTable,
  Empty,
  Maybe,
  MagnitudeBar,
  Pill,
  PillTone,
  Provenance,
  Row,
  SectionTitle,
  SubTitle,
} from '../primitives';

type CorrelationCase = 'B_NO_CANDIDATES' | 'C_REJECTED' | 'D_ACCEPTED' | 'E_NOT_APPLICABLE';

const CASE_COPY: Record<CorrelationCase, { title: string; meaning: string; tone: PillTone }> = {
  B_NO_CANDIDATES: {
    title: 'NO CANDIDATES ENTERED THE MATCH WINDOW',
    meaning:
      'The correlation evaluated no AIS candidate for this return. Whether that is because nobody ' +
      'was listening, because nobody reported, or because no report fell inside the dynamic match ' +
      'radius is NOT established by this record -- a zero candidate count is consistent with all ' +
      'three. The AIS tab answers the coverage question for this window; its scope is the archive, ' +
      'not the whole deployment.',
    tone: 'info',
  },
  C_REJECTED: {
    title: 'CANDIDATES CONSIDERED — NONE EXCEEDED THE ACCEPTANCE THRESHOLD',
    meaning:
      'Vessels did report nearby and the correlation evaluated them, then declined. The closest ' +
      'one is shown below with its arithmetic. Declining is a decision by the algorithm, not a ' +
      'finding about the vessel.',
    tone: 'warn',
  },
  D_ACCEPTED: {
    title: 'ASSOCIATION ACCEPTED',
    meaning:
      'One AIS candidate exceeded the acceptance threshold and was associated with this return.',
    tone: 'ok',
  },
  E_NOT_APPLICABLE: {
    title: 'NOT APPLICABLE',
    meaning:
      'This target was not produced by SAR detection, so no correlation decision was made about it.',
    tone: 'neutral',
  },
};

export function CorrelationTab({
  target,
  targetRef,
}: {
  target: VesselTarget;
  targetRef: { targetId: string; scanId: string | null };
}) {
  const corr: AisAssociation | null = target.corr ?? null;
  const decided = target.classification !== 'AIS_ONLY';
  const matched = corr?.matched === true;
  const considered = corr?.candidatesConsidered ?? null;
  const threshold = corr?.acceptanceThreshold ?? null;

  const kase: CorrelationCase = !decided
    ? 'E_NOT_APPLICABLE'
    : matched
      ? 'D_ACCEPTED'
      : considered === 0
        ? 'B_NO_CANDIDATES'
        : corr?.closestRejected
          ? 'C_REJECTED'
          // Candidates were evaluated but no rejected candidate was persisted. That
          // is a gap in the record, and the honest label is the gap rather than a
          // guess at which of the other cases it must have been.
          : 'B_NO_CANDIDATES';

  const copy = CASE_COPY[kase];
  const decomposition = corr?.scoreDecomposition ?? null;

  return (
    <div data-df-tab="CORRELATION" className="space-y-2">
      <div className="border border-structural/60 px-2 py-1.5" data-df-correlation-case={kase}>
        <div className="flex items-baseline gap-2">
          <Pill tone={copy.tone}>{copy.title}</Pill>
        </div>
        <div className="pt-1 text-[11px] leading-tight text-ink-2">{copy.meaning}</div>
      </div>

      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <SectionTitle>Decision</SectionTitle>
          <Row label="Candidates considered">
            {considered === null ? <AbsentText reason="NOT_ESTABLISHED" /> : <span className="df-num">{considered}</span>}
          </Row>
          <Row label="Acceptance threshold">
            {threshold === null ? <AbsentText reason="NOT_ESTABLISHED" /> : <span className="df-num">{threshold.toFixed(3)}</span>}
          </Row>
          <Row label="Associated MMSI">
            {matched ? <Maybe value={text(corr?.mmsi ?? null)} /> : <AbsentText reason="ZERO_CANDIDATES" />}
          </Row>
          <Row label="Vessel name">
            <Maybe value={text(corr?.vesselName ?? null)} />
          </Row>
          <Row label="Association confidence">
            {corr?.aisAssociationConfidence === undefined ? (
              <AbsentText reason="NOT_ESTABLISHED" />
            ) : (
              <span className="df-num">{corr.aisAssociationConfidence.toFixed(3)}</span>
            )}
          </Row>
        </div>

        <div>
          <SectionTitle>Geometry</SectionTitle>
          <Row label="Distance offset">
            <Maybe value={measurement(corr?.distanceOffsetMeters ?? null, { digits: 1, unit: 'm' })} />
          </Row>
          <Row label="Time delta">
            <Maybe value={measurement(corr?.timeDeltaSeconds ?? null, { digits: 1, unit: 's' })} />
          </Row>
          <Row label="Dynamic radius">
            <Maybe
              value={measurement(decomposition?.matchRadiusMeters ?? null, { digits: 1, unit: 'm' })}
            />
          </Row>
          <Row label="Predicted SAR-time position">
            {/* The PREDICTED fix, kept separate from every observed AIS row in the AIS
                tab. It is dead-reckoned to the SAR instant and is not a transmission. */}
            {corr?.predictedLat === undefined || corr?.predictedLat === null ? (
              <AbsentText reason="NOT_ESTABLISHED" />
            ) : (
              <span className="df-num">
                {corr.predictedLat.toFixed(5)}, {corr.predictedLon?.toFixed(5) ?? '—'}
              </span>
            )}
          </Row>
        </div>
      </div>

      {decomposition ? (
        <>
          <div>
            <SubTitle>Score decomposition — accepted candidate</SubTitle>
            {/*
              Bars AND numbers. A bar alone cannot be compared precisely, and a score
              an operator has to eyeball is a score they will misread. The values are
              the backend's, unmodified.
            */}
            <MagnitudeBar label="Spatial" value={decomposition.spatialScore} max={1} />
            <MagnitudeBar label="Temporal" value={decomposition.temporalScore} max={1} />
            <MagnitudeBar label="Heading" value={decomposition.headingScore} max={1} />
            <MagnitudeBar label="Size" value={decomposition.sizeScore} max={1} />
            <Row label="Composite">
              <span className="df-num">{decomposition.compositeScore.toFixed(4)}</span>
            </Row>
            <Row label="Threshold">
              {threshold === null ? <AbsentText reason="NOT_ESTABLISHED" /> : <span className="df-num">{threshold.toFixed(4)}</span>}
            </Row>
            <Row label="Margin">
              {threshold === null ? (
                <AbsentText reason="NOT_ESTABLISHED" />
              ) : (
                <span className="df-num" data-df-correlation-margin>
                  {(decomposition.compositeScore - threshold).toFixed(4)}
                </span>
              )}
            </Row>
          </div>
        </>
      ) : (
        <Empty
          heading="NO SCORE DECOMPOSITION"
          detail={
            matched
              ? 'An association was made but the record carries no decomposition. That is a gap in the stored record, not a value of zero.'
              : 'No candidate was scored, so there is nothing to decompose. That is consistent with no candidates having entered the window.'
          }
        />
      )}

      {corr?.closestRejected ? (
        <div>
          <SubTitle>Closest rejected candidate</SubTitle>
          <DataTable
            rows={[corr.closestRejected]}
            rowKey={(row) => row.mmsi}
            caption="The best candidate that was NOT accepted. Backend order is authoritative; nothing here is re-ranked."
            columns={[
              { key: 'mmsi', header: 'MMSI', render: (row) => <span className="df-num">{row.mmsi}</span> },
              { key: 'name', header: 'Name', render: (row) => <Maybe value={text(row.vesselName)} /> },
              {
                key: 'dist',
                header: 'Distance m',
                numeric: true,
                render: (row) => <span className="df-num">{row.distanceMeters.toFixed(1)}</span>,
              },
              {
                key: 'dt',
                header: 'ΔT s',
                numeric: true,
                render: (row) => (
                  <span className="df-num">{(row.timeDeltaSeconds ?? 0).toFixed(1)}</span>
                ),
              },
              { key: 'score', header: 'Score', numeric: true, render: (row) => <span className="df-num">{row.score.toFixed(4)}</span> },
              {
                key: 'result',
                header: 'Result',
                render: () => <Pill tone="warn">REJECTED</Pill>,
              },
            ]}
            empty={null}
          />
          <div className="pt-1">
            <Row label="Shortfall">
              <span className="df-num">{corr.closestRejected.shortfall.toFixed(4)}</span>
            </Row>
          </div>
        </div>
      ) : kase === 'C_REJECTED' ? (
        <Empty
          heading="NO CLOSEST REJECTED CANDIDATE RECORDED"
          detail="Candidates were evaluated but the record carries no rejected candidate. The backend did not persist one, and this surface will not invent it."
        />
      ) : null}

      <Provenance label="Where these numbers come from">
        <div className="text-[11px] text-ink-2">
          Every value on this tab is read from the correlation record produced by the backend for{' '}
          <span className="df-num">{target.id}</span>
          {targetRef.scanId ? (
            <>
              {' '}
              in scan <span className="df-num">{targetRef.scanId}</span>
            </>
          ) : (
            ' with no pinned scan'
          )}
          . No score is recomputed, no candidate is re-ranked and no threshold is re-applied in
          the browser.
        </div>
        <div className="pt-1 text-[10px] text-ink-dim">
          The correlation record exposes a candidate COUNT and a single closest-rejected candidate.
          It does not expose the full evaluated candidate list, so no ranked table of all
          candidates is shown — there is no such data to show.
        </div>
      </Provenance>
    </div>
  );
}