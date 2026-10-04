/**
 * AIS -- what AIS reported, and what its silence does and does not mean.
 *
 * THE THREE CASES AN OPERATOR MUST SEE APART
 *
 *   NO COVERAGE              nobody was listening. Absence proves nothing.
 *   COVERAGE, ZERO REPORTS   someone was listening; nothing came through.
 *   COVERAGE, REJECTED       a vessel reported and the correlation declined it.
 *
 * `readCoverage` distinguishes these and this tab renders the distinction. A panel
 * that just printed an observation count would show "0" for all three, which is the
 * single most misleading thing this screen could do.
 *
 * NULLS STAY NULL
 *
 * Every field except identity, position and time is nullable, and null means the
 * source did not report it. A vessel transmitting without SOG has NOT reported zero
 * knots; it has reported nothing. Rendering null as `0.0 kn` invents a measurement
 * and, for a vessel that is stopped, inverts the meaning.
 *
 * OBSERVED AND PREDICTED ARE NEVER IN THE SAME TABLE
 *
 * The predicted SAR-time position is dead-reckoned from an observed fix. It is a
 * derived estimate, not a transmission, and it is rendered outside the observation
 * table with its own label. Putting a derived point in a table of observed rows
 * would make it indistinguishable from a report that was actually received.
 */

import { useCallback } from 'react';

import type { AisObservationOut, TargetAisResponse } from '../../api/contract';
import { loadTargetAis } from '../api';
import { count, measurement, readCoverage, text } from '../format';
import type { TargetRef } from '../../intelligence/targetRef';
import {
  AbsentText,
  DataTable,
  Empty,
  Maybe,
  Pill,
  PillTone,
  Provenance,
  Row,
  SectionTitle,
  SubTitle,
  TabError,
  TabLoading,
} from '../primitives';
import { useTabData } from '../useTabData';

export function AisTab({ targetRef }: { targetRef: TargetRef }) {
  const fetcher = useCallback((signal: AbortSignal) => loadTargetAis(targetRef)(signal), [targetRef]);
  const state = useTabData<TargetAisResponse>(targetRef, fetcher);

  if (state.status === 'loading' || state.status === 'idle') return <TabLoading label="AIS observations" />;
  if (state.status === 'failed') return <TabError reason={state.reason} />;

  const payload = state.value;
  const coverage = readCoverage(payload.coverage ?? null);
  const observations = payload.observations ?? [];

  return (
    <div data-df-tab="AIS" className="space-y-2">
      <div data-df-coverage-kind={coverage.kind}>
        <SectionTitle
          right={
            <Pill tone={coverageTone(coverage.kind)}>{coverageTitle(coverage.kind)}</Pill>
          }
        >
          AIS coverage
        </SectionTitle>
        <div className="pt-1 text-[11px] leading-tight text-ink-2">{coverage.detail}</div>
        <Row label="Observation count">
          <Maybe
            value={
              coverage.kind === 'AVAILABLE' || coverage.kind === 'PARTIAL'
                ? String(coverage.observationCount)
                : null
            }
          />
        </Row>
        {/*
          The measured count is deliberately NOT rendered as 0 when coverage was
          absent. The backend nulls it for exactly this reason, and coercing it here
          would undo a decision the contract already made correctly.
        */}
        <Row label="Window start">
          <Maybe value={text(payload.window?.start ?? null)} />
        </Row>
        <Row label="Window end">
          <Maybe value={text(payload.window?.end ?? null)} />
        </Row>
      </div>

      <div>
        <SectionTitle>Association</SectionTitle>
        <Row label="Associated">
          <Pill tone={payload.associated ? 'ok' : 'warn'}>{payload.associated ? 'ASSOCIATED' : 'NOT ASSOCIATED'}</Pill>
        </Row>
        <Row label="MMSI">
          {payload.mmsi ? (
            <span className="df-num">{payload.mmsi}</span>
          ) : (
            <AbsentText reason="ZERO_CANDIDATES" />
          )}
        </Row>
        <div className="pt-1 text-[10px] leading-tight text-ink-dim">{payload.note}</div>
      </div>

      <div>
        <SubTitle>Observed AIS reports</SubTitle>
        {observations.length === 0 ? (
          <Empty
            heading={coverage.kind === 'NO_COVERAGE' ? 'NO COVERAGE' : 'ZERO OBSERVATIONS'}
            detail={
              coverage.kind === 'NO_COVERAGE'
                ? 'No receiver covered this window. Nothing here is evidence that no vessel was present.'
                : 'A receiver covered this window and returned no reports. That is a different finding from having no coverage.'
            }
          />
        ) : (
          <>
            <DataTable
              rows={observations}
              rowKey={(row, index) => `${row.mmsi}-${row.timestamp}-${index}`}
              caption="OBSERVED transmissions only. Null fields mean the source did not report them and are never shown as zero."
              columns={[
                { key: 'ts', header: 'Timestamp', render: (row) => <span className="df-num">{row.timestamp}</span> },
                { key: 'mmsi', header: 'MMSI', render: (row) => <span className="df-num">{row.mmsi}</span> },
                {
                  key: 'pos',
                  header: 'Lat, Lon',
                  render: (row) => (
                    <span className="df-num">
                      {row.lat.toFixed(4)}, {row.lon.toFixed(4)}
                    </span>
                  ),
                },
                {
                  key: 'sog',
                  header: 'SOG kn',
                  numeric: true,
                  render: (row) => <Maybe value={measurement(row.sog, { digits: 1 })} />,
                },
                {
                  key: 'cog',
                  header: 'COG°',
                  numeric: true,
                  render: (row) => <Maybe value={measurement(row.cog, { digits: 0 })} />,
                },
                {
                  key: 'hdg',
                  header: 'Hdg°',
                  numeric: true,
                  render: (row) => <Maybe value={measurement(row.heading, { digits: 0 })} />,
                },
                { key: 'nav', header: 'Nav', render: (row) => <Maybe value={text(row.nav_status)} /> },
              ]}
              empty={null}
            />

            <SubTitle>Vessel particulars</SubTitle>
            <DataTable
              rows={observations}
              rowKey={(row, index) => `${row.mmsi}-p-${index}`}
              columns={[
                { key: 'name', header: 'Name', render: (row) => <Maybe value={text(row.ship_name)} /> },
                { key: 'call', header: 'Callsign', render: (row) => <Maybe value={text(row.callsign)} /> },
                { key: 'imo', header: 'IMO', render: (row) => <Maybe value={text(row.imo)} /> },
                { key: 'type', header: 'Type', render: (row) => <Maybe value={text(row.ship_type)} /> },
                {
                  key: 'len',
                  header: 'Length m',
                  numeric: true,
                  render: (row) => <Maybe value={measurement(row.length_m, { digits: 1 })} />,
                },
                {
                  key: 'wid',
                  header: 'Width m',
                  numeric: true,
                  render: (row) => <Maybe value={measurement(row.width_m, { digits: 1 })} />,
                },
                { key: 'src', header: 'Source', render: (row) => <Maybe value={text(row.source)} /> },
              ]}
              empty={null}
            />
          </>
        )}
      </div>

      {/*
        A one-observation "track" is a point, not a path. Drawn as a polyline it
        would invent motion the archive does not contain, so the track is only
        reported when there are at least two observations to connect.
      */}
      <TrackSection observations={observations} />

      <Provenance label="Coverage semantics">
        <div className="text-[11px] text-ink-2">
          A coverage state of NO_COVERAGE means no receiver covered this position at acquisition
          time. It is a statement about the record, not about the water. An operator must be able
          to distinguish "nobody was listening" from "listening and hearing nothing", because
          those support opposite conclusions.
        </div>
        <div className="pt-1 text-[10px] text-ink-dim">
          Predicted positions are dead-reckoned to the SAR instant and appear only on the
          CORRELATION tab. They are never placed in the observed table above.
        </div>
      </Provenance>
    </div>
  );
}

function TrackSection({ observations }: { observations: readonly AisObservationOut[] }) {
  if (observations.length < 2) {
    return (
      <div>
        <SubTitle>Observed track</SubTitle>
        <Empty
          heading="INSUFFICIENT OBSERVATIONS FOR A TRACK"
          detail={
            observations.length === 0
              ? 'No observations were returned.'
              : 'One observation is a point, not a path. Drawing a polyline through it would invent motion the archive does not contain.'
          }
        />
      </div>
    );
  }
  const sources = new Set(observations.map((o) => o.source ?? 'NOT_ESTABLISHED'));
  return (
    <div>
      <SubTitle>Observed track</SubTitle>
      <Row label="Observation points">
        <span className="df-num">{observations.length}</span>
      </Row>
      <Row label="Sources">
        <span className="df-num">{[...sources].join(', ')}</span>
      </Row>
      <Row label="Time span">
        <span className="df-num">
          {observations[0].timestamp} → {observations[observations.length - 1].timestamp}
        </span>
      </Row>
      <div className="pt-1 text-[10px] leading-tight text-ink-dim">
        Observations are shown as received. No interpolation or smoothing is applied: a smoothed
        path implies precision between reports that neither the source nor this product measured.
      </div>
    </div>
  );
}

function coverageTitle(kind: string): string {
  switch (kind) {
    case 'AVAILABLE':
      return 'AVAILABLE';
    case 'PARTIAL':
      return 'PARTIAL';
    case 'ZERO_OBSERVATIONS':
      return 'AVAILABLE — ZERO REPORTS';
    case 'NOT_CONFIGURED':
      return 'NOT CONFIGURED';
    default:
      return 'NO COVERAGE';
  }
}

function coverageTone(kind: string): PillTone {
  switch (kind) {
    case 'AVAILABLE':
      return 'ok';
    case 'PARTIAL':
      return 'info';
    case 'ZERO_OBSERVATIONS':
      return 'info';
    case 'NOT_CONFIGURED':
      return 'neutral';
    default:
      return 'warn';
  }
}