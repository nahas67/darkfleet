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
import { engine } from '../globe/engine';
import { useStore } from '../state/store';
import { healthColor, healthSeverity } from '../design/tokens';
import { SHORTCUTS } from './useGlobalKeys';
import { NOT_ESTABLISHED } from '../design/format';
import { useArchiveCoverage } from '../ais/archiveCoverage';

/**
 * Deployment-level AIS archive state.
 *
 * Lives here rather than on the dossier AIS tab because it answers a different
 * question than the target-scoped coverage block: does this deployment HAVE an
 * archive, as opposed to did any receiver cover THIS target's window. Showing the
 * two side by side would let a reader read a healthy archive as proof that a
 * particular unmatched target had AIS coverage, which is the specific confusion
 * this separation prevents.
 */
function ArchiveCoverageSection() {
  const coverage = useArchiveCoverage();

  return (
    <div className="border border-structural/60 px-2 py-1.5" data-df-archive-coverage>
      <div className="flex items-baseline justify-between gap-2">
        <span className="df-label text-[10px] uppercase">AIS archive (deployment)</span>
        <button type="button" className="df-btn text-[10px]" onClick={coverage.reload}>
          Re-probe
        </button>
      </div>

      {coverage.status === 'loading' ? (
        <p className="pt-1 text-[11px] text-ink-dim">Probing the local AIS archive…</p>
      ) : coverage.status === 'failed' ? (
        <p className="pt-1 text-[11px] text-fault">
          The archive probe failed: {coverage.reason}. That is a connection failure, not an
          absent archive.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2 pt-1">
            <span className="df-num text-[11px]">{coverage.value.state}</span>
            {/*
              `observation_count` is null under NOT_CONFIGURED because with nothing
              to count a number would imply a measurement. Rendering 0 here would turn
              "this deployment has no archive" into "there were no vessels", which is
              the exact substitution this product refuses everywhere else.
            */}
            <span className="df-num text-[11px]">
              {coverage.value.observation_count === null
                ? NOT_ESTABLISHED
                : `${coverage.value.observation_count} obs`}
            </span>
          </div>
          <p className="pt-1 text-[11px] leading-relaxed text-ink-2">{coverage.value.detail}</p>
          <p className="pt-1 text-[10px] leading-relaxed text-ink-dim">
            This is the state of the whole deployment. A target can still report NO COVERAGE while
            this reads AVAILABLE, because coverage is also a question of place and time.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Basemap source, live from the controller.
 *
 * Kept OUT of `state.providers`, which is the backend's archive-source health. Those
 * are different axes and both need saying: the backend answers "can this deployment
 * reach its SAR and AIS sources", this answers "which imagery is on the globe and is
 * the preferred one still working".
 *
 * `SOURCE HEALTH` and `ACTIVE SOURCE` are deliberately separate rows. A provider can
 * be UNAVAILABLE while a DIFFERENT provider is active, and a single merged label would
 * make "which imagery am I looking at" unanswerable -- which is the confusion that
 * makes a fallback look like a silent substitution.
 */
function BasemapSection() {
  const status = engine.basemapStatus();

  if (status === null) {
    return (
      <div data-df-basemap="absent">
        <p className="df-label mb-1.5 text-[10px]">Basemap</p>
        <p className="text-[11px] text-ink-dim">
          The globe has not been created, so no basemap source is active.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3" data-df-basemap={status.activeId ?? 'none'}>
      <p className="df-label mb-1.5 text-[10px]">Basemap</p>
      <div className="flex items-baseline justify-between gap-2">
        <span className="df-num text-[11px] text-ink">{status.activeLabel ?? NOT_ESTABLISHED}</span>
        <span
          className="df-label text-[10px]"
          style={{ color: status.isFallback ? 'var(--df-amber)' : 'var(--df-green)' }}
          data-df-basemap-fallback={status.isFallback ? 'true' : 'false'}
        >
          {status.isFallback ? 'Fallback active' : 'Active'}
        </span>
      </div>
      {status.notice !== null ? (
        <p className="pt-1 text-[11px] leading-relaxed text-ink-2" data-df-basemap-notice>
          {status.notice}
        </p>
      ) : null}
      <p className="pt-1 text-[10px] leading-relaxed text-ink-dim">
        Reference basemap, not analytical source evidence. It provides geographic context
        beneath SAR targets and is never an input to detection, correlation or
        classification.
      </p>
    </div>
  );
}

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
        <ArchiveCoverageSection />
        <BasemapSection />

        <p className="df-label mb-1.5 mt-3 text-[10px]">Source health</p>
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