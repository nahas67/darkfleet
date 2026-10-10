/**
 * REVISIT -- when can this water actually be imaged again?
 *
 * ONE ACQUISITION DEFINES NO INTERVAL
 *
 * This is the tab's central rule. The median, minimum and maximum of a single
 * sample are all mathematically degenerate, and the backend deliberately nulls them.
 * Rendering "0 days" would assert a cadence that no pair of acquisitions supports,
 * and it is the same error as rendering a missing AIS heading as 000 degrees: a
 * number standing in for a measurement that was never made.
 *
 * Nominal orbital repeat is NOT substituted. The 12-day Sentinel-1 revisit is a
 * property of the orbit, not a measurement of this water, and the operator asked
 * about the water. Presenting it as the answer would be answering a different
 * question confidently.
 *
 * THIS IS AREA CONTEXT, NOT VESSEL HISTORY
 *
 * Revisit describes an AREA. A vessel happens to be in it. The tab says so, because
 * presenting an area statistic inside a vessel dossier invites the reader to treat
 * it as a statement about the vessel's future.
 */

import { useCallback } from 'react';

import type { RevisitPlanOut, VesselTarget } from '../../api/contract';
import { loadRevisitAround } from '../api';
import { readInterval, text } from '../format';
import type { TargetRef } from '../../intelligence/targetRef';
import {
  DataTable,
  Empty,
  Maybe,
  Pill,
  Row,
  SectionTitle,
  SubTitle,
  TabError,
  TabLoading,
} from '../primitives';
import { useTabData } from '../useTabData';

export function RevisitTab({ targetRef, target }: { targetRef: TargetRef; target: VesselTarget }) {
  const fetcher = useCallback(
    (signal: AbortSignal) => loadRevisitAround(targetRef, { lat: target.lat, lon: target.lon })(signal),
    [targetRef, target.lat, target.lon],
  );
  const state = useTabData<RevisitPlanOut>(targetRef, fetcher);

  if (state.status === 'loading' || state.status === 'idle') return <TabLoading label="revisit plan" />;
  if (state.status === 'failed') return <TabError reason={state.reason} />;

  const plan = state.value;
  const acquisitions = plan.acquisitions ?? [];
  const count = acquisitions.length;
  const stats = plan.statistics;
  const gaps = plan.gaps ?? [];

  return (
    <div data-df-tab="REVISIT" className="space-y-2">
      <div className="border border-structural/50 px-2 py-1.5 text-[10px] leading-tight text-ink-dim">
        AREA CONTEXT, NOT VESSEL HISTORY. A revisit interval describes how often this water can be
        imaged. It says nothing about where this vessel will be.
      </div>

      <div>
        <SectionTitle>Query</SectionTitle>
        <Row label="Query AOI">
          <span className="df-num">
            {plan.requested_bbox?.length === 4
              ? plan.requested_bbox.join(', ')
              : 'NOT ESTABLISHED'}
          </span>
        </Row>
        <Row label="Window start"><span className="df-num">{plan.window?.start ?? 'NOT ESTABLISHED'}</span></Row>
        <Row label="Window end"><span className="df-num">{plan.window?.end ?? 'NOT ESTABLISHED'}</span></Row>
        <Row label="Provider">
          <Maybe value={text(plan.provider ?? null)} />
        </Row>
        <Row label="Collection">
          <Maybe value={text(plan.collection ?? null)} />
        </Row>
        <Row label="Acquisitions found">
          <span className="df-num" data-df-revisit-count>
            {count}
          </span>
        </Row>
      </div>

      <div>
        <SectionTitle>Intervals</SectionTitle>
        <Row label="Median revisit">
          <Maybe value={readInterval(stats?.median_revisit_days ?? null, 'days', count).label} />
        </Row>
        <Row label="Minimum revisit">
          <Maybe value={readInterval(stats?.min_revisit_days ?? null, 'days', count).label} />
        </Row>
        <Row label="Maximum revisit">
          <Maybe value={readInterval(stats?.max_revisit_days ?? null, 'days', count).label} />
        </Row>
        {count < 2 ? (
          <div className="pt-1 text-[10px] leading-tight text-ink-dim">
            One acquisition defines no interval. The median, minimum and maximum of a single sample
            are all degenerate, so all three are reported as NOT ESTABLISHED rather than as zero.
          </div>
        ) : null}
        {/*
          The nominal repeat IS shown, and it is shown separately and labelled, because
          it is the number an operator is most likely to substitute for a measurement
          on their own. It is a property of the orbit. Putting it next to a measured
          interval under one heading would invite exactly the substitution this tab
          exists to prevent.
        */}
        <Row label="Nominal orbital repeat">
          <span className="df-num">
            {stats?.nominal_repeat_days?.toFixed(1) ?? '—'} d{' '}
            <Pill tone="neutral">ORBIT-DERIVED</Pill>
          </span>
        </Row>
      </div>

      <div>
        <SubTitle>Real catalogue acquisitions</SubTitle>
        <DataTable
          rows={acquisitions}
          rowKey={(row, index) => `${row.item_id}-${index}`}
          caption="Every row is an acquisition that genuinely exists in the provider catalogue. Nothing here is predicted."
          columns={[
            { key: 'scene', header: 'Scene', render: (row) => <span className="df-num">{row.item_id}</span> },
            { key: 'plat', header: 'Platform', render: (row) => <span className="df-num">{row.platform}</span> },
            {
              key: 'time',
              header: 'Acquired',
              render: (row) => <span className="df-num">{row.acquisition_time}</span>,
            },
            {
              key: 'pol',
              header: 'Polarizations',
              render: (row) => (
                <span className="df-num">{(row.polarizations ?? []).join(', ') || 'NOT ESTABLISHED'}</span>
              ),
            },
          ]}
          empty={
            <Empty
              heading="ZERO CATALOGUE ACQUISITIONS"
              detail="The provider catalogue returned no acquisition for this area and window. That is a statement about the catalogue, not about what is possible."
            />
          }
        />
      </div>

      {gaps.length > 0 ? (
        <div>
          <SubTitle>Flagged gaps</SubTitle>
          <DataTable
            rows={gaps}
            rowKey={(row, index) => `gap-${index}`}
            columns={[
              {
                key: 'len',
                header: 'Gap days',
                numeric: true,
                render: (row) => <span className="df-num">{row.days.toFixed(1)}</span>,
              },
              { key: 'start', header: 'From', render: (row) => <span className="df-num">{row.start}</span> },
              { key: 'end', header: 'To', render: (row) => <span className="df-num">{row.end}</span> },
              {
                key: 'ex',
                header: 'Exceeds nominal',
                render: (row) => (
                  <Pill tone={row.exceeds_nominal ? 'warn' : 'neutral'}>
                    {row.exceeds_nominal === true ? 'YES' : 'NO'}
                  </Pill>
                ),
              },
            ]}
            empty={null}
          />
        </div>
      ) : null}

      <div>
        <Row label="Next known acquisition">
          {plan.next_after ? (
            <span className="df-num">
              {plan.next_after.acquisition_time} <Pill tone="info">CATALOGUE</Pill>
            </span>
          ) : (
            /*
             * No next acquisition is NOT the same as "no more imaging is possible". It
             * means the catalogue returned none, which is a weaker and different
             * claim, so it is stated as NOT ESTABLISHED rather than as a negative.
             */
            <span className="text-ink-dim">NOT ESTABLISHED — the catalogue returned no future acquisition</span>
          )}
        </Row>
      </div>

      {(plan.limitations ?? []).length > 0 ? (
        <div>
          <SubTitle>Limitations</SubTitle>
          <ul className="list-inside list-disc text-[11px] text-ink-2">
            {(plan.limitations ?? []).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
