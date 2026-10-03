/**
 * Scan workflow.
 *
 * The full operational path an operator takes, with no manual API calls:
 *   AOI -> scene -> run -> watch real stages -> results.
 *
 * The AOI has no default. The retired UI prefilled it from the first catalogue
 * entry, which meant an operator could run an analysis over somewhere they had
 * not chosen and not notice.
 */

import { useEffect, useState } from 'react';

import { loadScenes, startScan } from '../api/client';
import { engine } from '../globe/engine';
import { store, toBBox, useStore, type BBox } from '../state/store';
import { fmt, fmtInstant, NOT_ESTABLISHED } from '../design/format';

function parseBbox(text: string): BBox | null {
  const parts = text.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (Math.abs(minLat) > 90 || Math.abs(minLon) > 180) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/** A scan that exists and has not reached a terminal stage is in flight. */
function terminalStage(stage: string): boolean {
  return stage === 'COMPLETE' || stage === 'FAILED';
}

export function ScanWorkflow() {
  const state = useStore();
  // Store-backed: survives remount when the workspace changes.
  const text = state.aoiText;
  const setText = (value: string) => store.set({ aoiText: value });
  const [sceneId, setSceneId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);


  const parsed = parseBbox(text);

  // Scene search is spatial: the backend refuses an unbounded catalogue query,
  // so it re-runs as the AOI becomes valid. Keyed on validity rather than on the
  // parsed value so typing a fourth digit does not fire a request per keystroke.
  const aoiValid = parsed !== null;
  useEffect(() => {
    void loadScenes(aoiValid ? parsed : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aoiValid]);

  /**
   * The run gate.
   *
   * Previously this was `scanStage !== 'QUEUED'`, which is always false on a
   * freshly loaded page: the store's initial stage is QUEUED while `scanId` is
   * null, so no analysis could ever be started from the interface.
   *
   * The real question is "is a scan already in flight", and only a scan that
   * exists can be in flight.
   */
  const scanInFlight = state.scanId !== null && !terminalStage(state.scanStage);
  const canRun = parsed !== null && !busy && !scanInFlight;

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    setFailure(null);
    try {
      engine.setAoi(parsed);
      await startScan(parsed, sceneId || undefined);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The scan could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const useSceneExtent = (bbox: BBox) => {
    setText(bbox.map((v) => v.toFixed(4)).join(', '));
  };

  const terminal = terminalStage(state.scanStage);

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="TASKING">
      <header className="df-panel-head">
        <span className="df-label">Scan workflow</span>
      </header>

      <div className="space-y-3 p-3">
        <div>
          <label className="df-label mb-1 block text-[10px]" htmlFor="df-scan-bbox">
            Area of interest · min_lon, min_lat, max_lon, max_lat
          </label>
          <input
            id="df-scan-bbox"
            className="df-input w-full"
            placeholder="103.72, 1.10, 104.05, 1.40"
            value={text}
            aria-invalid={text.length > 0 && parsed === null}
            aria-describedby="df-scan-bbox-hint"
            onChange={(event) => setText(event.target.value)}
          />
          <p id="df-scan-bbox-hint" className="df-num mt-1 text-[10px] text-ink-dim">
            {text.length === 0
              ? 'No default. An analysis runs only over an area you choose.'
              : parsed === null
                ? 'Enter four finite numbers with min < max on both axes.'
                : `${(parsed[2] - parsed[0]).toFixed(4)}° lon × ${(parsed[3] - parsed[1]).toFixed(4)}° lat`}
          </p>
        </div>

        <div>
          <label className="df-label mb-1 block text-[10px]" htmlFor="df-scan-scene">
            Sentinel-1 scene
          </label>
          <select
            id="df-scan-scene"
            className="df-input w-full"
            value={sceneId}
            onChange={(event) => setSceneId(event.target.value)}
          >
            <option value="">Newest acquisition covering the AOI</option>
            {state.scenes.map((scene) => (
              <option key={`${scene.id}:${scene.polarization}`} value={scene.id}>
                {scene.id} · {scene.platform ?? 'unknown platform'}
              </option>
            ))}
          </select>
          {state.scenes.length > 0 ? (
            <ul className="df-scroll mt-2 max-h-40 space-y-1 overflow-y-auto">
              {state.scenes.slice(0, 8).map((scene) => (
                <li
                  key={`${scene.id}:${scene.polarization}`}
                  className="df-num flex items-center gap-2 text-[10px]"
                >
                  <button
                    type="button"
                    className="df-btn normal-case tracking-normal"
                    data-df-scene-extent={scene.id}
                    onClick={() => {
                      store.select({ kind: 'scene', sceneId: scene.id });
                      const bbox = toBBox(scene.bbox);
                      if (bbox) {
                        useSceneExtent(bbox);
                        engine.flyToBbox(bbox);
                      }
                    }}
                  >
                    {scene.id}
                  </button>
                  <span className="text-ink-dim">
                    {scene.platform ?? '—'} · {fmtInstant(scene.acquisition_time)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <button
          type="button"
          className="df-btn w-full justify-center"
          disabled={!canRun}
          data-df-run-scan
          onClick={() => void run()}
        >
          {busy ? 'Starting…' : 'Run analysis'}
        </button>

        {failure ? (
          <p className="text-[11px] text-fault" role="alert" data-df-scan-failure>
            {failure}
          </p>
        ) : null}

        {state.scanError ? (
          <p className="text-[11px] text-fault" role="alert" data-df-scan-error>
            {state.scanError}
          </p>
        ) : null}

        {/* Real job stages. No progress bar, no ETA: the pipeline has no
            measurable completion estimate, only an ordered sequence. */}
        {state.scanId ? (
          <div data-df-stage-log>
            <p className="df-label mb-1 text-[10px]">Job {state.scanId}</p>
            <ol className="df-scroll max-h-56 space-y-0.5 overflow-y-auto">
              {state.scanStageHistory.map((event, index) => (
                <li
                  key={`${event.stage}-${index}`}
                  className="df-num flex gap-2 text-[10px]"
                  data-df-stage={event.stage}
                >
                  <span className="text-ink-dim">{fmtInstant(event.timestamp).slice(11)}</span>
                  <span className="w-28 shrink-0 text-ink-2">{event.stage}</span>
                  {/* title, because a truncated detail line otherwise
                      silently loses the stage's real message */}
                  <span className="truncate text-ink-dim" title={event.detail}>
                    {event.detail}
                  </span>
                </li>
              ))}
            </ol>
            {terminal ? (
              <p className="df-num mt-2 text-[10px] text-ink-2">
                {state.scanStage === 'COMPLETE'
                  ? `${state.targets.length} target(s) · ${state.aisOnly.length} AIS-only`
                  : 'The scan failed. The recorded reason is above.'}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] text-ink-dim">{NOT_ESTABLISHED}</p>
        )}

        <button
          type="button"
          className="df-btn w-full justify-center"
          disabled={!state.targets.length}
          data-df-frame-aoi
          onClick={() => {
            const first = state.targets[0];
            if (first) engine.flyTo(first.lat, first.lon, 400_000);
          }}
        >
          Frame detections
        </button>
      </div>
    </section>
  );
}

export { fmt };