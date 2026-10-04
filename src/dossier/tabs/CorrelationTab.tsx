/**
 * CORRELATION -- why this target matched, or failed to match, AIS.
 *
 * This is the flagship analytical surface, and the thing it must never do is
 * re-derive the answer. Every number here is read from the correlation record the
 * backend produced. No score is recomputed in the browser, no candidate is
 * re-ranked, no threshold is re-applied. If the arithmetic looks wrong the answer
 * is to fix the backend under the defect-stop rule, not to adjust a display.
 *
 * FOUR CASES, KEPT APART
 *
 * These are different findings with different implications, and collapsing them is
 * how an investigation goes wrong:
 *
 *   A  NO COVERAGE              nobody was listening. Absence of AIS is not evidence.
 *   B  COVERAGE, NO CANDIDATES  someone was listening; nothing came near the window.
 *   C  CANDIDATES REJECTED      vessels reported and the correlation declined them.
 *   D  ACCEPTED                 an association was made.
 *
 * B and C in particular must not merge. "Nothing was there" and "something was
 * there and we said no" point in opposite directions, and an operator who cannot
 * tell them apart cannot reason about the target at all.
 *
 * ON THE RANKED CANDIDATE TABLE
 *
 * The correlation record exposes `candidatesConsidered` as a COUNT and
 * `closestRejected` as a SINGLE candidate. It does not expose the evaluated
 * candidate list, so there is nothing to rank and this tab does not pretend
 * otherwise. A table of invented candidates would be the most dangerous element
 * possible on this screen: it would look like the correlation considered five
 * vessels and show three of them.
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

type CorrelationCase = 'A_NO_COVERAGE' | 'B_NO_CANDIDATES' | 'C_REJECTED' | 'D_ACCEPTED' | 'E_NOT_APPLICABLE';

const CASE_COPY: Record<CorrelationCase, { title: string; meaning: string; tone: PillTone }> = {
  A_NO_COVERAGE: {
    title: 'NO AIS COVERAGE',
    meaning:
      'No receiver covered this position at acquisition time. DarkFleet cannot say whether a ' +
      'vessel was present, because for this place and time the AIS record is silent. Silence ' +
      'here is not evidence of absence.',
    tone: 'warn',
  },
  B_NO_CANDIDATES: {
    title: 'COVERAGE AVAILABLE — NO CANDIDATES ENTERED THE MATCH WINDOW',
    meaning:
      'A receiver did cover this area and time, and no AIS report fell inside the dynamic match ' +
      'radius. Either no vessel was there, or no vessel reported. Those remain different.',
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
          : 'A_NO_COVERAGE';

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
            matched || considered === null
              ? 'The correlation produced no decomposition for this target.'
              : 'No candidate was scored, so there is nothing to decompose. That is consistent with case B.'
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