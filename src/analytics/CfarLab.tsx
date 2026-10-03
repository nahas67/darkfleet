/**
 * CFAR request controls for the analytics workspace (DF-X6C).
 *
 * THREE THINGS THIS SURFACE MUST NOT DO
 *
 * 1. Detect. Every value here is a REQUEST parameter for `POST /api/scans`. The
 *    browser does not threshold, does not find components, and does not compute
 *    statistics. `NORMALIZED` / `FILTERED` / `CFAR` in the layer strip are names
 *    of pipeline products; a slider that borrowed one of those names would be a
 *    lie about what it is showing.
 *
 * 2. Imply an edit changed a detection. The completed run is immutable, so the
 *    two states are shown separately: CURRENT RUN (read from the record) and
 *    PROPOSED CONFIG (local, editable). A difference raises RECOMPUTE REQUIRED,
 *    and it stays raised until the backend has actually recomputed.
 *
 * 3. Show only what the backend supports. The eight parameters come from
 *    `analysis/cfar.ts`, whose wire form is a checked literal against the
 *    generated `CfarConfig` -- renaming a field on either side is a compile
 *    error, not a silently dropped field.
 *
 * SCENE PIN (DF-X6A invariant)
 *
 * A recompute is pinned to the same scene item the current run used. Without the
 * pin, "what changes if I lower the threshold?" would also silently change the
 * acquisition, and the comparison would be measuring the wrong difference.
 * `startScan` takes the scene id explicitly for exactly this reason.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CFAR_PARAM_KEYS,
  CFAR_PARAM_SPECS,
  CFAR_PRESETS,
  DEFAULT_CFAR_CONFIG,
  SPECKLE_MODE_LABELS,
  SPECKLE_MODES,
  applyPreset,
  formatParam,
  isSpeckleMode,
  recomputeDiff,
  toCfarRequestParams,
  updateParam,
  type CfarConfig,
  type CfarConfigKey,
} from '../analysis/cfar';
import { loadRunConfig, startScan } from '../api/client';
import { useStore } from '../state/store';

export function CfarLab({ scanId }: { scanId: string }) {
  const aoi = useStore().aoi;
  const sceneItemId = useStore().scene?.item_id ?? null;

  // The run that actually happened. Read from the record, never defaulted: a
  // browser-side default rendered as "current" is a claim nothing established.
  const [current, setCurrent] = useState<CfarConfig | null>(null);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [proposed, setProposed] = useState<CfarConfig>(DEFAULT_CFAR_CONFIG);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the proposed values from whatever this scan used, so the diff starts
  // empty and a change means a change rather than a difference of defaults.
  useEffect(() => {
    let cancelled = false;
    void loadRunConfig(scanId).then((run) => {
      if (cancelled) return;
      if (!run) return;
      setCurrent(run.config);
      setCurrentHash(run.configHash);
      setProposed(run.config);
    });
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  const diff = useMemo(
    () => (current ? recomputeDiff(current, proposed) : null),
    [current, proposed],
  );
  const dirty = diff?.requiresRecomputation ?? false;

  const setParam = useCallback(
    (key: CfarConfigKey, value: number | string) => {
      setProposed((prev) => updateParam(prev, key, value));
    },
    [],
  );

  const recompute = useCallback(() => {
    if (!aoi || submitting) return;
    setSubmitting(true);
    setError(null);
    // Same AOI, same scene, different detector configuration. Nothing else.
    void startScan(aoi, sceneItemId ?? undefined, toCfarRequestParams(proposed))
      .then(() => {
        setSubmitting(false);
      })
      .catch((e: unknown) => {
        setSubmitting(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [aoi, proposed, sceneItemId, submitting]);

  if (!aoi) {
    return (
      <aside
        className="df-scroll h-full min-w-0 flex-1 overflow-y-auto border-r border-structural/40"
        data-df-cfar-lab
      >
        <header className="df-panel-head">
          <span className="df-label">CFAR parameters</span>
        </header>
        <p className="df-note px-2 py-1 text-[10px]">No AOI set, so no run can be created.</p>
      </aside>
    );
  }

  return (
    <aside
      className="df-scroll h-full min-w-0 flex-1 overflow-y-auto border-r border-structural/40"
      data-df-cfar-lab
      aria-label="CFAR parameters"
    >
      <header className="df-panel-head">
        <span className="df-label">CFAR parameters</span>
      </header>

      <div className="px-2 py-1">
        <p className="df-label text-[10px]">CURRENT RUN</p>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5" data-df-cfar-current>
          {current ? (
            CFAR_PARAM_KEYS.map((key) => (
              <span key={key} className="df-num text-[10px] text-ink-2">
                {CFAR_PARAM_SPECS[key].label.toUpperCase()} {formatParam(key, current[key])}
              </span>
            ))
          ) : (
            <span className="df-mono text-[10px] text-ink-dim" data-df-cfar-current-state>
              {currentHash === null ? 'READING…' : 'NOT RECORDED'}
            </span>
          )}
        </div>
        {currentHash ? (
          <p className="df-mono mt-0.5 text-[10px] text-ink-dim" data-df-cfar-hash>
            CONFIG HASH {currentHash}
          </p>
        ) : null}
      </div>

      <div className="border-t border-structural/40 px-2 py-1">
        <p className="df-label text-[10px]">PROPOSED CONFIG</p>
        <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1" data-df-cfar-proposed>
          {CFAR_PARAM_KEYS.map((key) => (
            <ParamControl
              key={key}
              paramKey={key}
              value={proposed[key]}
              changed={(diff?.changedKeys ?? []).includes(key)}
              onChange={(v) => setParam(key, v)}
            />
          ))}
        </div>
      </div>

      {/* Only the changed parameters. Listing unchanged ones would imply they
          were part of the change. */}
      {dirty && diff ? (
        <div className="border-t border-structural/40 px-2 py-1" data-df-cfar-diff>
          <p className="df-label text-[10px]" style={{ color: 'var(--df-amber)' }}>
            RECOMPUTE REQUIRED
          </p>
          <dl className="mt-0.5 space-y-0.5">
            {diff.entries.map((e) => (
              <div key={e.key} className="df-mono flex items-baseline gap-1 text-[10px]">
                <dt className="text-ink-dim">{e.label.toUpperCase()}</dt>
                <dd className="text-ink-2">
                  <span style={{ color: 'var(--df-ink-dim)' }}>{e.before}</span>
                  {' → '}
                  <span style={{ color: 'var(--df-cyan)' }}>{e.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1 border-t border-structural/40 px-2 py-1">
        <select
          className="df-input w-28 text-[10px]"
          value=""
          onChange={(e) => {
            const next = applyPreset(proposed, e.target.value);
            if (next) setProposed(next);
          }}
          aria-label="Apply a CFAR preset"
          data-df-cfar-preset
        >
          <option value="">PRESET…</option>
          {CFAR_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {/* Restores the CURRENT RUN's values, not the shipped preset: the useful
            meaning of "reset" here is "put back what was actually computed". */}
        <button
          type="button"
          className="df-btn"
          onClick={() => current && setProposed(current)}
          disabled={!dirty || !current}
          data-df-cfar-reset
        >
          RESET
        </button>
        <button
          type="button"
          className="df-btn"
          onClick={recompute}
          disabled={!dirty || submitting}
          data-df-cfar-recompute
        >
          {submitting ? 'RUNNING…' : 'RECOMPUTE'}
        </button>
      </div>

      <p className="df-mono px-2 pb-1 text-[10px] text-ink-dim" data-df-cfar-scene-pin>
        PINNED TO {sceneItemId ?? 'NO SCENE SELECTED'}
      </p>
      {error ? (
        <p
          className="df-mono px-2 pb-1 text-[10px]"
          style={{ color: 'var(--df-red)' }}
          role="alert"
          data-df-cfar-error
        >
          RECOMPUTE FAILED — {error}
        </p>
      ) : null}
    </aside>
  );
}

/**
 * One parameter control.
 *
 * `speckleFilter` is an enum and gets a select; the rest are bounded numbers and
 * get a number input carrying the spec's own min/max/step, so the browser cannot
 * offer a value the backend would reject.
 */
function ParamControl({
  paramKey,
  value,
  changed,
  onChange,
}: {
  paramKey: CfarConfigKey;
  value: number | string;
  changed: boolean;
  onChange: (value: number | string) => void;
}) {
  const spec = CFAR_PARAM_SPECS[paramKey];
  return (
    <label className="block">
      <span
        className="df-label block text-[9px]"
        style={changed ? { color: 'var(--df-cyan)' } : { color: 'var(--df-ink-dim)' }}
      >
        {spec.label.toUpperCase()}
        {spec.unit ? ` (${spec.unit})` : ''}
        {changed ? ' •' : ''}
      </span>
      {paramKey === 'speckleFilter' ? (
        <select
          className="df-input w-full text-[10px]"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-label={spec.label}
          data-df-cfar-param={paramKey}
        >
          {SPECKLE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {SPECKLE_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="df-input w-full text-[10px]"
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={spec.min}
          max={spec.max}
          step={spec.integer ? 1 : 0.1}
          onChange={(e) => {
            if (isSpeckleMode(e.target.value)) return;
            const n = Number.parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          aria-label={spec.label}
          data-df-cfar-param={paramKey}
        />
      )}
    </label>
  );
}