/**
 * Reports and evidence export.
 *
 * The backend already renders geojson, kml, json, png and pdf server-side and
 * carries provenance on each. This does not reimplement any of it -- a second
 * renderer would be a second thing to keep correct.
 *
 * `csv` is deliberately absent: the backend does not serve it, and a link that
 * 400s is worse than no link.
 */

import { useEffect, useState } from 'react';
import type { ScanStateResponse } from '../api/contract';
import { api } from '../api/errors';
import { useStore } from '../state/store';
import { NOT_ESTABLISHED } from '../design/format';
import { InvestigationNotebook } from './InvestigationNotebook';

const FORMATS = [
  { id: 'json', label: 'Analytical JSON', note: 'full record with provenance' },
  { id: 'geojson', label: 'GeoJSON', note: 'geometry for any GIS' },
  { id: 'kml', label: 'KML', note: 'Google Earth / QGIS' },
  { id: 'png', label: 'PNG evidence', note: 'rendered server-side' },
  { id: 'pdf', label: 'PDF evidence', note: 'rendered server-side' },
] as const;

/** Export readiness is about a verified persisted source, not a visible scan ID. */
export function isExportableScan(value: ScanStateResponse): boolean {
  return value.record_persisted === true && value.runtime_mode === 'REAL' &&
    value.synthetic === false && value.stage === 'COMPLETE';
}

export function ReportsWorkspace() {
  const state = useStore();
  const scanId = state.scanId;
  const [exportState, setExportState] = useState<{
    scanId: string; status: 'loading' | 'ready' | 'unavailable'; detail: string;
  } | null>(null);

  useEffect(() => {
    if (!scanId) return;
    if (state.scanStage !== 'COMPLETE') {
      setExportState({ scanId, status: 'unavailable',
        detail: state.scanStage === 'FAILED'
          ? 'This scan failed and has no completed evidence export.'
          : 'This scan has not completed. Exports require a persisted scan record.' });
      return;
    }
    let active = true;
    const controller = new AbortController();
    setExportState({ scanId, status: 'loading', detail: 'Checking persisted scan evidence…' });
    void api.get<ScanStateResponse>(`/api/scans/${encodeURIComponent(scanId)}`, controller.signal)
      .then((record) => {
        if (!active) return;
        setExportState(isExportableScan(record)
          ? { scanId, status: 'ready', detail: '' }
          : { scanId, status: 'unavailable',
            detail: 'This scan has no verified, completed REAL record available for export.' });
      })
      .catch(() => {
        if (active) setExportState({ scanId, status: 'unavailable',
          detail: 'Export availability could not be checked. No report download has been verified.' });
      });
    return () => { active = false; controller.abort(); };
  }, [scanId, state.scanStage]);
  const ready = scanId !== null && exportState?.scanId === scanId && exportState.status === 'ready';

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="REPORTS">
      <header className="df-panel-head">
        <span className="df-label">Reports &amp; evidence</span>
      </header>

      <div className="space-y-4 p-3">
        <div>
          <p className="df-label mb-1 text-[10px]">Scan exports</p>
          {scanId === null ? (
            <p className="text-[11px] text-ink-dim" data-df-reports-empty>
              Exports appear once a scan exists. Nothing is exported from an analysis that
              has not run.
            </p>
          ) : ready ? (
            <ul className="space-y-1">
              {FORMATS.map((format) => (
                <li key={format.id}>
                  <a
                    className="df-btn w-full justify-between normal-case tracking-normal"
                    href={`/api/scans/${encodeURIComponent(scanId)}/export/${format.id}`}
                    data-df-export={format.id}
                    download={`${scanId}.${format.id}`}
                  >
                    <span>{format.label}</span>
                    <span className="df-num text-[10px] text-ink-dim">{format.note}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-ink-dim" role="status" data-df-report-export-unavailable>
              {exportState?.scanId === scanId ? exportState.detail : 'Checking persisted scan evidence…'}
              {' '}Download links are disabled until the source is verified.
            </p>
          )}
        </div>

        <div>
          <p className="df-label mb-1 text-[10px]">Selected target</p>
          <p className="df-num text-[11px] text-ink">
            {state.selection.kind === 'target' ? state.selection.targetId : NOT_ESTABLISHED}
          </p>
          <p className="df-label mb-1 mt-2 text-[10px]">Selected AIS contact</p>
          <p className="df-num text-[11px] text-ink">
            {state.selectedAis?.mmsi ?? NOT_ESTABLISHED}
          </p>
          <p className="df-num mt-0.5 text-[10px] text-ink-dim">
            Per-target export is {NOT_ESTABLISHED.toLowerCase()}. Whole-scan exports only.
          </p>
        </div>

        <InvestigationNotebook />
      </div>
    </section>
  );
}
