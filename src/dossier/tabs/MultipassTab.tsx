/**
 * MULTIPASS -- track HYPOTHESES, never confirmed identity.
 *
 * The language in this file is load-bearing. A multi-pass track is a proposal that
 * two returns in different scenes are the same vessel. Nothing in the geometry
 * establishes that: two vessels can cross, a static structure looks identical
 * across passes, and a low-confidence return can move by coincidence. So the tab
 * says HYPOTHESIS throughout and never "confirmed same vessel".
 *
 * WHY THE TARGET IS NARROWED CLIENT-SIDE
 *
 * `/tracks` is a cross-scan projection with no target parameter. The backend
 * exposes `scans_considered`, `observations_considered` and a list of hypotheses;
 * it does not expose "hypotheses touching this coordinate". The dossier therefore
 * filters the returned list on distance and reports the radius it used. That is
 * inspection of a real response, not a new query invented in the browser -- adding
 * a parameter the backend does not implement would be a silent contract change.
 *
 * EVIDENCE ON BOTH SIDES
 *
 * `supporting_evidence` and `contradicting_evidence` are both required by the
 * contract and both are shown. A hypothesis presented with only the evidence that
 * flatters it is marketing.
 */

import { useCallback } from 'react';

import type { TracksOut, VesselTarget } from '../../api/contract';
import { loadTracks, tracksForPosition } from '../api';
import { MULTIPASS_LANGUAGE } from '../format';
import {
  DataTable,
  Empty,
  Epistemics,
  MagnitudeBar,
  Pill,
  Row,
  SectionTitle,
  SubTitle,
  TabError,
  TabLoading,
} from '../primitives';
import { useArchiveData } from '../useTabData';

export function MultipassTab({ target }: { target: VesselTarget }) {
  const fetcher = useCallback((signal: AbortSignal) => loadTracks()(signal), []);
  const state = useArchiveData<TracksOut>(fetcher);

  if (state.status === 'loading' || state.status === 'idle') return <TabLoading label="multi-pass tracks" />;
  if (state.status === 'failed') return <TabError reason={state.reason} />;

  const tracks = state.value;
  const relevant = tracksForPosition(tracks, { lat: target.lat, lon: target.lon });

  return (
    <div data-df-tab="MULTIPASS" className="space-y-2">
      <div className="border border-warn/40 px-2 py-1.5">
        <div className="df-label text-[10px] uppercase text-warn">{MULTIPASS_LANGUAGE.title}</div>
        <div className="pt-0.5 text-[11px] leading-tight text-ink-2">{MULTIPASS_LANGUAGE.disclaimer}</div>
      </div>

      <div>
        <SectionTitle>Archive coverage</SectionTitle>
        <Row label="Scans considered">
          <span className="df-num">{tracks.scans_considered ?? 0}</span>
        </Row>
        <Row label="Observations considered">
          <span className="df-num">{tracks.observations_considered ?? 0}</span>
        </Row>
        <Row label="Hypotheses in archive">
          <span className="df-num">{(tracks.tracks ?? []).length}</span>
        </Row>
        <Row label="Hypotheses touching this position">
          <span className="df-num" data-df-multipass-relevant>
            {relevant.length}
          </span>
        </Row>
      </div>

      {relevant.length === 0 ? (
        <Empty
          heading={(tracks.scans_considered ?? 0) < 2 ? 'INSUFFICIENT PASSES' : 'NO HYPOTHESIS AT THIS POSITION'}
          detail={
            (tracks.scans_considered ?? 0) < 2
              ? 'A multi-pass hypothesis needs at least two acquisitions of the same water. One scan cannot produce one, and this surface will not draw a line between a single point and itself.'
              : tracks.note || 'The archive contains hypotheses, but none has an observation within 400 m of this target.'
          }
        />
      ) : (
        <div className="space-y-2">
          {relevant.map((track) => (
            <div key={track.track_id} className="border border-structural/60 px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="df-num text-[11px]">{track.track_id}</span>
                <Pill tone="warn">HYPOTHESIS</Pill>
              </div>

              <SubTitle>Observations</SubTitle>
              <DataTable
                rows={track.points ?? []}
                rowKey={(row, index) => `${row.scan_id}-${index}`}
                caption="Passes joined by this hypothesis. Each is an independent detection in its own scene."
                columns={[
                  { key: 'scan', header: 'Pass', render: (row) => <span className="df-num">{row.scan_id}</span> },
                  { key: 'scene', header: 'Scene', render: (row) => <span className="df-num">{row.item_id}</span> },
                  { key: 'time', header: 'Acquired', render: (row) => <span className="df-num">{row.acquisition_time}</span> },
                  {
                    key: 'pos',
                    header: 'Lat, Lon',
                    render: (row) => (
                      <span className="df-num">
                        {row.lat.toFixed(4)}, {row.lon.toFixed(4)}
                      </span>
                    ),
                  },
                  { key: 'cls', header: 'Class', render: (row) => <span className="df-num">{row.classification}</span> },
                  {
                    key: 'conf',
                    header: 'SAR conf',
                    numeric: true,
                    render: (row) => <span className="df-num">{row.sar_conf?.toFixed(2) ?? '—'}</span>,
                  },
                ]}
                empty={null}
              />

              <SubTitle>Intervals between passes</SubTitle>
              {(track.gaps ?? []).length === 0 ? (
                <div className="text-[11px] text-ink-dim">NO INTERVALS. Fewer than two passes.</div>
              ) : (
                <DataTable
                  rows={track.gaps ?? []}
                  rowKey={(row, index) => `gap-${index}`}
                  columns={[
                    {
                      key: 's',
                      header: 'Elapsed',
                      numeric: true,
                      render: (row) => <span className="df-num">{formatElapsed(row.seconds)}</span>,
                    },
                    {
                      key: 'v',
                      header: 'Implied speed kn',
                      numeric: true,
                      render: (row) =>
                        row.implied_speed_knots === null || row.implied_speed_knots === undefined ? (
                          // Deliberately NOT rendered as 0 kn. A gap too long to bridge
                          // honestly has no implied speed; zero would be a kinematic
                          // claim nobody measured.
                          <span className="text-ink-dim">NOT ESTABLISHED</span>
                        ) : (
                          <span className="df-num">{row.implied_speed_knots.toFixed(1)}</span>
                        ),
                    },
                    {
                      key: 'p',
                      header: 'Plausible',
                      render: (row) => (
                        <Pill tone={row.plausible ? 'info' : 'warn'}>{row.plausible ? 'PLAUSIBLE' : 'IMPLAUSIBLE'}</Pill>
                      ),
                    },
                    { key: 'n', header: 'Note', render: (row) => <span className="text-[10px]">{row.note}</span> },
                  ]}
                  empty={null}
                />
              )}

              <SubTitle>Identity strength</SubTitle>
              <MagnitudeBar
                label="Identity strength (backend assessment)"
                value={track.identity_strength ?? 0}
                max={1}
              />
              <div className="pt-1 text-[11px] text-ink-2">
                {track.confidence_statement || 'No confidence statement was recorded.'}
              </div>

              <SubTitle>Evidence for and against</SubTitle>
              <Epistemics
                observed={[]}
                hypotheses={track.supporting_evidence ?? []}
                unknowns={track.contradicting_evidence ?? []}
              />
              <div className="pt-1 text-[10px] leading-tight text-ink-dim">
                Rows above the line support the hypothesis; rows below it count against it. Both are
                required by the contract so a hypothesis cannot be presented with only the evidence
                that flatters it.
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] leading-tight text-ink-dim">
        Hypotheses are matched to this target by position, within 400 m. That radius is a stated
        tolerance for inclusion on this screen, not a physical quantity and not a correlation
        parameter. Multpass geometry does not modify <span className="df-num">sarConf</span>, AIS
        association or classification.
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'NOT ESTABLISHED';
  if (seconds < 3600) return `${seconds.toFixed(0)} s`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}