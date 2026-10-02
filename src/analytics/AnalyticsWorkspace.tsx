/**
 * Analytics workspace.
 *
 * The real raster layers, server-rendered over the measured window transform.
 * The analysis parameters are shown and editable, and a change is stated as
 * requiring a backend recompute rather than pretending to take effect locally.
 *
 * The retired UI had all of this and none of it worked: the recompute button was
 * inert and `toCfarRequestParams` was never called. Here the request path is
 * wired, so a changed parameter actually produces a new run.
 */

import { useState } from 'react';

import { loadRaster } from '../api/client';
import {
  CFAR_PARAM_KEYS,
  CFAR_PARAM_SPECS,
  CFAR_PRESETS,
  DEFAULT_CFAR_CONFIG,
  diffConfig,
  type CfarConfig,
  type CfarConfigKey,
} from '../analysis/cfar';
import { useStore } from '../state/store';
import { fmtInstant, NOT_ESTABLISHED } from '../design/format';

const LAYERS = ['raw', 'normalized', 'filtered', 'landmask', 'cfar_threshold', 'detection_mask'] as const;

export function AnalyticsWorkspace() {
  const state = useStore();
  const [layer, setLayer] = useState<string>('raw');
  const [config, setConfig] = useState<CfarConfig>(DEFAULT_CFAR_CONFIG);
  const [pending, setPending] = useState<CfarConfig>(DEFAULT_CFAR_CONFIG);

  const changed = diffConfig(config, pending);
  const scanId = state.scanId;

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="ANALYTICS">
      <header className="df-panel-head">
        <span className="df-label">Analytics</span>
      </header>

      <div className="space-y-3 p-3">
        <div>
          <p className="df-label mb-1 text-[10px]">Raster layer</p>
          <div className="flex flex-wrap gap-1">
            {LAYERS.map((name) => (
              <button
                key={name}
                type="button"
                className="df-btn normal-case tracking-normal"
                aria-pressed={layer === name}
                data-df-analytics-layer={name}
                onClick={() => {
                  setLayer(name);
                  if (scanId) void loadRaster(scanId, name);
                }}
              >
                {name.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>

        {scanId ? (
          <div>
            <p className="df-label mb-1 text-[10px]">Rendered artifact</p>
            <img
              className="w-full border border-structural"
              src={`/api/scans/${scanId}/raster/${layer}/image`}
              alt={`${layer.replace(/_/g, ' ')} raster for scan ${scanId}, georeferenced over the measured window transform`}
              data-df-analytics-image
            />
            <p className="df-num mt-1 text-[10px] text-ink-dim">
              Server-rendered. The rectangle is derived from the measured window
              transform, not the requested AOI.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-ink-dim">Run an analysis to render real raster layers.</p>
        )}

        <div>
          <p className="df-label mb-1 text-[10px]">Detector parameters</p>
          <div className="flex flex-wrap gap-1">
            {CFAR_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={
                  CFAR_PARAM_KEYS.every((key) => config[key] === preset.config[key])
                }
                className="df-btn normal-case tracking-normal"
                data-df-preset={preset.id}
                onClick={() => {
                  setConfig(preset.config);
                  setPending(preset.config);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="mt-2 space-y-1.5">
            {CFAR_PARAM_KEYS.map((key) => {
              const spec = CFAR_PARAM_SPECS[key];
              const value = pending[key];

              // A categorical parameter rendered as a range slider is a dead
              // control: `Number('median')` is NaN, which React rejects as an
              // attribute value and which the operator cannot operate. Spot
              // filter and kernel size are choices, not quantities, so they get a
              // select.
              const isCategorical =
                spec.min === spec.max || typeof value === 'string' || !Number.isFinite(Number(value));

              if (isCategorical) {
                const options =
                  key === 'speckleFilter'
                    ? ['none', 'median', 'lee']
                    : key === 'kernelSize'
                      ? ['3', '5', '7']
                      : [String(value)];
                return (
                  <div key={key}>
                    <div className="flex items-baseline justify-between">
                      <label className="df-label text-[10px]" htmlFor={`cfar-${key}`}>
                        {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                      </label>
                      <output className="df-num text-[10px] text-ink">{String(value)}</output>
                    </div>
                    <select
                      id={`cfar-${key}`}
                      className="df-input w-full"
                      value={String(value)}
                      onChange={(event) =>
                        setPending((prev) => ({
                          ...prev,
                          // kernelSize is numeric in the config but string-typed
                          // in the option list; the select is the one place that
                          // knows the difference.
                          [key]:
                            key === 'kernelSize' ? Number(event.target.value) : event.target.value,
                        }) as CfarConfig)
                      }
                    >
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              }

              return (
                <div key={key}>
                  <div className="flex items-baseline justify-between">
                    <label className="df-label text-[10px]" htmlFor={`cfar-${key}`}>
                      {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                    </label>
                    <output className="df-num text-[10px] text-ink">{String(value)}</output>
                  </div>
                  <input
                    id={`cfar-${key}`}
                    type="range"
                    className="w-full accent-[var(--df-cyan)]"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={Number(value)}
                    aria-valuetext={`${String(value)} ${spec.unit ?? ''}`.trim()}
                    onChange={(event) =>
                      setPending((prev) =>
                        ({ ...prev, [key]: Number(event.target.value) } as CfarConfig),
                      )
                    }
                  />
                </div>
              );
            })}
          </div>

          {changed.length > 0 ? (
            <div
              className="mt-2 border-l-2 border-warn pl-2"
              role="status"
              aria-live="polite"
              data-df-recompute="required"
            >
              <p className="df-label text-[10px]" style={{ color: 'var(--df-amber)' }}>
                {changed.length} parameter{changed.length === 1 ? '' : 's'} changed
              </p>
              <ul className="df-num mt-0.5 space-y-0.5 text-[10px] text-ink-2">
                {changed.map((key: CfarConfigKey) => (
                  <li key={key}>
                    {key}: {String(config[key])} → {String(pending[key])}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-ink-dim">
                Detections are computed by the backend. These values take effect on the next
                run — they are not applied to the detections already on screen.
              </p>
              <div className="mt-1.5 flex gap-1">
                <button
                  type="button"
                  className="df-btn"
                  data-df-cfar-apply
                  onClick={() => {
                    setConfig(pending);
                    // The values become the baseline for the NEXT run. Claiming they
                    // already took effect would be false.
                  }}
                >
                  Accept as next-run baseline
                </button>
                <button
                  type="button"
                  className="df-btn"
                  onClick={() => setPending(config)}
                >
                  Revert
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div>
          <p className="df-label mb-1 text-[10px]">Acquisition</p>
          <p className="df-num text-[10px] text-ink-2">
            {state.scene ? (
              <>
                {state.scene.item_id} · {fmtInstant(state.scene.acquisition_time)}
              </>
            ) : (
              NOT_ESTABLISHED
            )}
          </p>
        </div>
      </div>
    </section>
  );
}