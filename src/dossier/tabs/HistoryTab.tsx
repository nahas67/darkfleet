/**
 * HISTORY -- what is actually persisted about this target.
 *
 * THE HONEST ANSWER ABOUT HISTORY
 *
 * Nothing is synthesised here. There is no analyst-note store in this product, and
 * pipeline stage events are an in-memory SSE stream for the job runner, not a
 * persisted ledger. So there is no event history to show, and building a
 * timeline-shaped view out of the current target state would be a fabrication with a
 * clock on it: it would look like a record of what happened and be nothing of the
 * kind.
 *
 * What IS persisted, and is therefore what this tab shows:
 *
 *   - the owning scan: when it was created, when it acquired, from which scene
 *   - this target's detection and classification within it
 *   - the secondary channels as they stood for this observation
 *   - whether OTHER stored scans exist over the same water
 *
 * That last item is cross-scan context, and it is labelled as such. It is not a
 * history of THIS target: target ids are assigned per scan, so `DF-002` in another
 * scan is a different vessel and any apparent continuity between them would be an
 * artefact of the numbering.
 */

import type { ScanScene, VesselTarget } from '../../api/contract';
import { loadTracks, tracksForPosition } from '../api';
import { measurement, readPolarization, readWake, text } from '../format';
import {
  Empty,
  Maybe,
  Pill,
  Provenance,
  Row,
  SectionTitle,
  SubTitle,
} from '../primitives';
import { useArchiveData } from '../useTabData';
import type { TracksOut } from '../../api/contract';
import { useCallback } from 'react';

export function HistoryTab({
  target,
  scene,
  scanId,
}: {
  target: VesselTarget;
  scene: ScanScene | null;
  scanId: string | null;
}) {
  const fetcher = useCallback((signal: AbortSignal) => loadTracks()(signal), []);
  const archive = useArchiveData<TracksOut>(fetcher);

  const wake = readWake(target.wakeAnalysis ?? null);
  const pol = readPolarization(target.polarizationEvidence ?? null);

  // Other observations of the same water. Explicitly NOT called "history of this
  // target": see the module note.
  const others =
    archive.status === 'ready'
      ? tracksForPosition(archive.value, { lat: target.lat, lon: target.lon })
      : [];

  return (
    <div data-df-tab="HISTORY" className="space-y-2">
      <div className="border border-structural/50 px-2 py-1.5 text-[10px] leading-tight text-ink-dim">
        This tab shows what is PERSISTED. DarkFleet stores no analyst notes and no stage-event
        ledger, so there is no note history to display and none is invented. Pipeline stage events
        are a live stream for the job runner, not a durable record.
      </div>

      <div>
        <SectionTitle>Owning scan</SectionTitle>
        <Row label="Scan ID">
          <Maybe value={text(scanId)} />
        </Row>
        <Row label="Scene ID">
          <Maybe value={text(scene?.item_id ?? null)} />
        </Row>
        <Row label="Acquisition time">
          <Maybe value={text(scene?.acquisition_time ?? null)} />
        </Row>
        <Row label="Platform">
          <Maybe value={text(scene?.platform ?? null)} />
        </Row>
        <Row label="Product">
          <Maybe value={text(scene?.product ?? null)} />
        </Row>
      </div>

      <div>
        <SectionTitle>Events recorded for this observation</SectionTitle>
        <Row label="SAR observation">
          <span className="df-num">
            {target.lat.toFixed(5)}, {target.lon.toFixed(5)}
          </span>
        </Row>
        <Row label="Detection confidence">
          <span className="df-num">{target.sarConf.toFixed(3)}</span>
        </Row>
        <Row label="Classification">
          <Pill tone={target.classification === 'SAR_UNMATCHED' ? 'warn' : 'neutral'}>
            {target.classification}
          </Pill>
        </Row>
        <Row label="AIS association">
          <Maybe value={text(target.corr?.mmsi ?? null)} />
        </Row>
        <Row label="Candidates considered">
          {target.corr?.candidatesConsidered === undefined ? (
            <span className="text-ink-dim">NOT ESTABLISHED</span>
          ) : (
            <span className="df-num">{target.corr.candidatesConsidered}</span>
          )}
        </Row>
        <Row label="Wake analysis">
          <Pill tone={wake.kind === 'FAILED' ? 'fault' : 'neutral'}>{wake.kind}</Pill>
        </Row>
        <Row label="Polarization analysis">
          <Pill tone={pol.kind === 'FAILED' ? 'fault' : 'neutral'}>{pol.kind}</Pill>
        </Row>
        <Row label="Footprint">
          <span className="df-num">
            {target.lenM}×{target.widM} m
          </span>
        </Row>
        <Row label="Length uncertainty">
          <Maybe value={measurement(target.lenUncM, { digits: 0, unit: 'm' })} />
        </Row>
        <div className="pt-1 text-[10px] leading-tight text-ink-dim">
          Analyst annotations are persisted in Reports / Investigation notebook, separate
          from measured observations. Report generation is not logged as a scan event.
        </div>
      </div>

      <div>
        <SubTitle>Other stored observations of the same water</SubTitle>
        {archive.status === 'loading' || archive.status === 'idle' ? (
          <div className="text-[11px] text-ink-dim">Loading archive…</div>
        ) : archive.status === 'failed' ? (
          <Empty heading="ARCHIVE UNAVAILABLE" detail="The stored-scan projection could not be read." />
        ) : others.length === 0 ? (
          <Empty
            heading="NO OTHER STORED OBSERVATION"
            detail="No stored scan has an observation within 400 m of this target. That is a fact about the archive, not about the water."
          />
        ) : (
          <>
            <div className="space-y-1 pt-1">
              {others.map((track) => (
                <div key={track.track_id} className="border border-structural/50 px-2 py-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="df-num text-[11px]">{track.track_id}</span>
                    <Pill tone="warn">HYPOTHESIS</Pill>
                  </div>
                  <div className="text-[10px] text-ink-dim">
                    {(track.points ?? []).length} observation(s) across{' '}
                    {(track.points ?? []).map((p) => p.scan_id).join(', ')}
                  </div>
                </div>
              ))}
            </div>
            <div className="pt-1 text-[10px] leading-tight text-ink-dim">
              These are HYPOTHESES that other stored scans observed the same water. They are not a
              history of <span className="df-num">{target.id}</span>: target ids are assigned per
              scan, so the same id in another scan is a different vessel.
            </div>
          </>
        )}
      </div>

      <Provenance label="What is not persisted">
        <ul className="list-inside list-disc text-[11px] text-ink-2">
          <li>Report-generation actions, which are not tracked as scan events.</li>
          <li>Pipeline stage events, which are an in-memory stream rather than a ledger.</li>
          <li>
            A stable cross-scan target identity. Ids are per-scan, so continuity of identity is a
            hypothesis, not a record.
          </li>
        </ul>
      </Provenance>
    </div>
  );
}
