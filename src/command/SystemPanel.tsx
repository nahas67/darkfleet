/**
 * System panel.
 *
 * Provider health, keyboard reference, and the honest state of each source.
 *
 * Two rules:
 *  - A source is AVAILABLE only when a real probe returned AVAILABLE. A
 *    configured credential is not availability.
 *  - A failed probe is shown as a failure with the reason. The retired UI's
 *    worst-member summarisation is preserved: a group reports its worst member so
 *    one failing provider cannot hide behind a healthy sibling.
 */

import { loadProviders } from '../api/client';
import { useStore } from '../state/store';
import { healthColor, healthSeverity } from '../design/tokens';
import { SHORTCUTS } from './useGlobalKeys';
import { NOT_ESTABLISHED } from '../design/format';

export function SystemPanel() {
  const state = useStore();

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="SYSTEM">
      <header className="df-panel-head justify-between">
        <span className="df-label">System</span>
        <button
          type="button"
          className="df-btn"
          data-df-reprobe
          onClick={() => void loadProviders()}
          disabled={state.providersLoading}
        >
          {state.providersLoading ? 'Probing…' : 'Re-probe'}
        </button>
      </header>

      <div className="p-3">
        <p className="df-label mb-1.5 text-[10px]">Source health</p>
        {state.providers.length === 0 ? (
          <p className="text-[11px] text-ink-dim" data-df-providers-empty>
            {state.providersLoading
              ? 'Probing sources…'
              : `No source has reported. ${NOT_ESTABLISHED} is not the same as operational.`}
          </p>
        ) : (
          <ul className="space-y-1" data-df-provider-list>
            {state.providers.map((provider) => {
              const status = String((provider as { status?: string }).status ?? 'NOT_CONFIGURED');
              const tone = healthColor[status] ?? 'var(--df-text-dim)';
              return (
                <li key={provider.provider} className="border-l-2 pl-2" style={{ borderColor: tone }}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="df-num text-[11px] text-ink">{provider.provider}</span>
                    <span className="df-label text-[10px]" style={{ color: tone }}>
                      {status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {(provider.detail || provider.error) ? (
                    <p className="text-[11px] leading-relaxed text-ink-2">
                      {provider.detail || provider.error}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <p className="df-label mb-1.5 mt-4 text-[10px]">Severity order</p>
        <ol className="df-num space-y-0.5 text-[10px] text-ink-dim">
          {healthSeverity.map((status, index) => (
            <li key={status}>
              {String(index + 1).padStart(2, '0')} {status.replace(/_/g, ' ')}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-dim">
          A group reports its worst member, so a single failing source cannot be hidden
          behind a healthy sibling.
        </p>

        <p className="df-label mb-1.5 mt-4 text-[10px]">Keyboard</p>
        <dl className="space-y-0.5">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-baseline gap-2">
              <dt className="df-num w-14 shrink-0 text-[10px] text-ink">{shortcut.keys}</dt>
              <dd className="text-[11px] text-ink-2">{shortcut.action}</dd>
            </div>
          ))}
        </dl>

        <p className="df-label mb-1.5 mt-4 text-[10px]">Provenance</p>
        <dl className="space-y-0.5">
          {(
            [
              ['Scan', state.scanId],
              ['Stage', state.scanStage],
              ['Stream', state.streamState],
              ['Raster', state.rasterError ? 'unavailable' : state.rasterLoaded ? 'loaded' : 'not loaded'],
            ] as ReadonlyArray<readonly [string, string | null]>
          ).map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-2">
              <dt className="df-label text-[10px] text-ink-dim">{label}</dt>
              <dd className="df-num text-[10px] text-ink">{value ?? NOT_ESTABLISHED}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}