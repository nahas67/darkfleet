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

import { useEffect, useState } from 'react';
import { loadDatasetHealth, loadProviders } from '../api/client';
import { engine } from '../globe/engine';
import { useStore, type State } from '../state/store';
import { healthColor, healthSeverity } from '../design/tokens';
import { SHORTCUTS } from './useGlobalKeys';
import { NOT_ESTABLISHED } from '../design/format';
import { useArchiveCoverage } from '../ais/archiveCoverage';
import { installStatusLabel, versionLabel } from '../maritime/datasetHealth';
import type { ProviderHealthEntry } from '../api/contract';
import { ApiError, explain } from '../api/errors';
import {
  DEFAULT_OPERATOR_PREFERENCES, getOperatorSettings, resetOperatorSettings,
  saveOperatorSettings, type OperatorPreferences, type OperatorSettings,
} from '../api/operatorSettings';

/** The group health is the least healthy reported member; an unknown status stays unknown. */
export function worstProviderHealth(providers: readonly ProviderHealthEntry[]): string | null {
  if (providers.length === 0) return null;
  const values = providers.map((provider) => provider.status);
  if (values.some((status) => !healthSeverity.includes(status))) return null;
  return values.reduce((worst, status) =>
    healthSeverity.indexOf(status) > healthSeverity.indexOf(worst) ? status : worst);
}

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
        <button type="button" className="df-btn text-[10px]" onClick={coverage.reload}
          disabled={coverage.status === 'loading'}>
          {coverage.status === 'loading' ? 'Probing…' : 'Re-probe'}
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
  const [, refresh] = useState(0);
  // The map-source recovery probe runs inside the engine and does not write to
  // the React store. Refresh this inspector while mounted so fallback/recovery
  // transitions become visible without a unrelated state update.
  useEffect(() => {
    const interval = window.setInterval(() => refresh((value) => value + 1), 5_000);
    return () => window.clearInterval(interval);
  }, []);
  const status = engine.basemapStatus();
  const sources = engine.basemapSources();
  const [sourceError, setSourceError] = useState<string | null>(null);

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
          {status.activeId === null ? 'No basemap active' : status.isFallback ? 'Fallback active' : 'Active'}
        </span>
      </div>
      {status.notice !== null ? (
        <p className="pt-1 text-[11px] leading-relaxed text-ink-2" data-df-basemap-notice>
          {status.notice}
        </p>
      ) : null}
      <div className="mt-2">
        <label className="df-label block text-[10px]" htmlFor="df-map-source">Map source</label>
        <select id="df-map-source" data-df-map-source className="df-btn mt-1 w-full"
          aria-label="Map source"
          value={sources.some((source) => source.id === status.activeId) ? status.activeId ?? '' : ''}
          onChange={(event) => {
            const chosen = engine.selectBasemapSource(event.target.value);
            setSourceError(chosen?.activeId === event.target.value ? null
              : `Map source ${event.target.value} could not be installed. The live provider status remains authoritative.`);
            refresh((n) => n + 1);
          }}>
          <option value="" disabled>Select an available source</option>
          {sources.map((source) => <option key={source.id} value={source.id} disabled={!source.configured}>
            {source.label}{source.configured ? '' : ' · not configured'}
          </option>)}
        </select>
        {sourceError ? <p role="status" className="df-note mt-1 text-[10px]">{sourceError}</p> : null}
      </div>
      {Array.from(new Set(status.attempted))
        .filter((id) => id !== status.activeId)
        .map((id) => (
          <div
            key={id}
            className="flex items-baseline justify-between gap-2 pt-1 text-[10px]"
            data-df-basemap-provider={id}
            data-df-basemap-provider-health="UNAVAILABLE"
          >
            <span className="df-label text-[10px]">{id}</span>
            <span className="df-num text-fault">UNAVAILABLE</span>
          </div>
        ))}
      <p className="pt-1 text-[10px] leading-relaxed text-ink-dim">
        Reference basemap, not analytical source evidence. It provides geographic context
        beneath SAR targets and is never an input to detection, correlation or
        classification. Active means a provider was constructed; successful tile delivery
        is assessed separately from repeated imagery request failures.
      </p>
    </div>
  );
}

/**
 * LOCAL REFERENCE DATASETS, and why this is not "source health"
 *
 * `/api/providers/health` answers "can this deployment reach its remote sources" and has a
 * live-uptime meaning. `/api/maritime/datasets` answers "which reference files are on this
 * disk and can a query read them". They are separate sections on purpose: a healthy
 * basemap must not imply healthy reference data, and a failed SAR provider must not imply
 * the coastline is broken. Neither is a real dependency on the other.
 *
 * THREE WORDS THAT MUST NOT COLLAPSE INTO ONE
 *
 *   CHECKSUM_UNRECORDED   installed, answers correctly, but the publisher published no
 *                         checksum to check against. A WEAKER guarantee, shown as itself.
 *   NOT INSTALLED         nothing on disk. For an optional dataset this is normal and is
 *                         not a fault.
 *   BLOCKER REASON        wanted, and could not be obtained. For the World Port Index this
 *                         is a real external blocker with a specific cause.
 *
 * Rendering the second and third identically would tell an operator nothing is wrong with
 * the port data, which is not what happened -- the publisher's service will not complete a
 * trusted TLS handshake, and TLS verification was not disabled to work around it.
 */
function DatasetHealthSection() {
  const health = useStore();
  const datasetStatus = health.datasetHealthError !== null
    ? health.datasetHealth !== null ? 'stale-error' : 'failed'
    : health.datasetHealthLoading
      ? health.datasetHealth !== null ? 'refreshing' : 'loading'
      : health.datasetHealth === null ? 'loading' : 'ready';

  return (
    <div className="mt-3" data-df-dataset-health={datasetStatus}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="df-label text-[10px]">Local reference data</span>
        <button
          type="button"
          className="df-btn text-[10px]"
          disabled={health.datasetHealthLoading}
          // `force` so an operator who installs a dataset and presses Re-check sees it.
          onClick={() => void loadDatasetHealth(true)}
        >
          {health.datasetHealthLoading ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {health.datasetHealth !== null && health.datasetHealthError !== null ? (
        <p className="mb-2 text-[11px] text-fault" data-df-dataset-health-error role="alert">
          The dataset store re-check failed: {health.datasetHealthError}. The inventory below is
          from the last successful check and is not verified as current. Maritime toggles are unavailable.
        </p>
      ) : health.datasetHealth !== null && health.datasetHealthLoading ? (
        <p className="mb-2 text-[11px] text-ink-dim" role="status">
          Re-checking the local dataset store. The inventory below is the previous result.
        </p>
      ) : null}

      {health.datasetHealth === null && health.datasetHealthError === null ? (
        <p className="text-[11px] text-ink-dim">Reading the local dataset store…</p>
      ) : health.datasetHealth === null ? (
        <p className="text-[11px] text-fault" data-df-dataset-health-error>
          The dataset store could not be read: {health.datasetHealthError}. That is a
          connection failure, not an absent dataset.
        </p>
      ) : (
        <>
          <p className="mb-1 text-[10px] leading-relaxed text-ink-dim">
            Files on this machine, not remote services. {health.datasetHealth.usable_count} of{' '}
            {health.datasetHealth.datasets.length} usable, {health.datasetHealth.verified_count} with a
            recorded checksum.
          </p>
          <ul className="space-y-1.5" data-df-dataset-list>
            {health.datasetHealth.datasets.map((entry) => (
              <li
                key={entry.id}
                data-df-dataset={entry.id}
                className="border-l-2 pl-2"
                style={{
                  borderColor: entry.usable
                    ? entry.install_status === 'READY'
                      ? 'var(--df-green)'
                      : 'var(--df-amber)'
                    : 'var(--df-text-dim)',
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="df-num text-[11px] text-ink">{entry.label}</span>
                  <span
                    className="df-label text-[10px]"
                    style={{
                      color: entry.usable
                        ? entry.install_status === 'READY'
                          ? 'var(--df-green)'
                          : 'var(--df-amber)'
                        : 'var(--df-text-dim)',
                    }}
                  >
                    {installStatusLabel(entry)}
                  </span>
                </div>

                {/*
                  The version is shown ONLY when the source established one. A service
                  snapshot whose publisher publishes no per-layer version shows its
                  retrieval timestamp instead -- and must never inherit "v12" from the
                  separate bulk release, which is a different product from a different URL.
                */}
                <p className="text-[10px] text-ink-2">
                  {versionLabel(entry) ?? 'VERSION NOT ESTABLISHED'}
                  {entry.retrieved_at ? ` · retrieved ${entry.retrieved_at}` : ''}
                </p>
                <p className="text-[10px] text-ink-dim">
                  {/* `??` rather than a bare read: the generated contract marks fields with
                      server defaults as optional, so an older backend answering this route
                      without `source_mechanism` must render as an unknown mechanism rather
                      than crash the whole panel. */}
                  {(entry.source_mechanism ?? 'UNKNOWN').replace(/_/g, ' ')} ·{' '}
                  {entry.license.replace(/_/g, ' ')}
                </p>

                {entry.blocker_reason ? (
                  <p className="text-[10px] leading-relaxed text-warn" data-df-dataset-blocker>
                    {entry.blocker_reason}
                  </p>
                ) : null}
                {!entry.blocker_reason && !entry.usable && !entry.optional ? (
                  <p className="text-[10px] leading-relaxed text-ink-dim">
                    {entry.detail || 'Not installed. No dataset is present on this machine.'}
                  </p>
                ) : null}
                {entry.usable && (entry.limitations?.length ?? 0) > 0 ? (
                  <ul className="list-disc pl-3 text-[10px] leading-relaxed text-ink-dim">
                    {(entry.limitations ?? []).slice(0, 2).map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function MaritimeEntitySection() {
  const state = useStore();
  const counts = engine.maritimeEntityCounts();
  const rows = [
    { id: 'REFERENCE_COASTLINE' as const, label: 'Reference coastline', count: counts?.coastline },
    { id: 'EEZ_BOUNDARIES' as const, label: 'EEZ boundaries', count: counts?.eez },
    { id: 'HIGH_SEAS' as const, label: 'High seas outline', count: counts?.highSeas },
  ];
  return (
    <div className="mt-3" data-df-maritime-entities>
      <p className="df-label mb-1.5 text-[10px]">Local geometry built</p>
      {rows.map(({ id, label, count }) => (
        <div key={id} className="flex items-baseline justify-between gap-2 py-0.5"
          data-df-maritime-entity-count={id} data-df-count={count ?? 'unknown'}>
          <span className="text-[11px] text-ink-2">{label}</span>
          <span className="df-num text-[10px]">
            {count === undefined ? NOT_ESTABLISHED : `${count} parts built`}
            {' · '}{state.layerState[id]?.visible ? 'ON' : 'OFF'}
          </span>
        </div>
      ))}
      <p className="pt-1 text-[10px] text-ink-dim">
        Built entities are not a measurement of coverage. An OFF layer retains hidden geometry;
        a zero on an ON layer may still be loading. LAYERS states any refusal.
      </p>
    </div>
  );
}

/** Failure causes and provider status remain visible even when optional healthy details are hidden. */
export function ProviderHealthRow({ provider, showOptionalDetails }: {
  provider: ProviderHealthEntry; showOptionalDetails: boolean;
}) {
  const reported = (provider as { status?: unknown }).status;
  const status = typeof reported === 'string' && healthSeverity.includes(reported)
    ? reported : 'NOT_ESTABLISHED';
  const tone = healthColor[status] ?? 'var(--df-text-dim)';
  return <li className="border-l-2 pl-2" style={{ borderColor: tone }}>
    <div className="flex items-baseline justify-between gap-2">
      <span className="df-num text-[11px] text-ink">{provider.provider}</span>
      <span className="df-label text-[10px]" style={{ color: tone }}>
        {status.replace(/_/g, ' ')}
      </span>
    </div>
    {(status !== 'AVAILABLE' || showOptionalDetails) && (provider.detail || provider.error) ? (
      <p className="text-[11px] leading-relaxed text-ink-2" data-df-provider-explanation>
        {provider.detail || provider.error}
      </p>
    ) : null}
  </li>;
}

export function SystemKeyboardReference({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return <section data-df-keyboard-reference>
    <p className="df-label mb-1.5 mt-4 text-[10px]">Keyboard</p>
    <dl className="space-y-0.5">
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.keys} className="flex items-baseline gap-2">
          <dt className="df-num w-14 shrink-0 text-[10px] text-ink">{shortcut.keys}</dt>
          <dd className="text-[11px] text-ink-2">{shortcut.action}</dd>
        </div>
      ))}
    </dl>
  </section>;
}

/** Scan/stage/source status is non-optional provenance; only prose can be hidden. */
export function SystemProvenanceStatus({ session, showSupplementary }: {
  session: Pick<State, 'scanId' | 'scanStage' | 'streamState' | 'rasterError' | 'rasterLoaded'>;
  showSupplementary: boolean;
}) {
  return <section data-df-provenance-mandatory>
    <p className="df-label mb-1.5 mt-4 text-[10px]">Provenance</p>
    <dl className="space-y-0.5">
      {([
        ['Scan', session.scanId],
        ['Stage', session.scanStage],
        ['Stream', session.streamState],
        ['Raster', session.rasterError ? 'unavailable' : session.rasterLoaded ? 'loaded' : 'not loaded'],
      ] as ReadonlyArray<readonly [string, string | null]>).map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <dt className="df-label text-[10px] text-ink-dim">{label}</dt>
          <dd className="df-num text-[10px] text-ink">{value ?? NOT_ESTABLISHED}</dd>
        </div>
      ))}
    </dl>
    {showSupplementary ? <p data-df-provenance-supplement className="mt-1 text-[10px] text-ink-dim">
      These are current interface/source-state indicators, not confirmation that a
      provider returned verified observations for every place and time.
    </p> : null}
  </section>;
}

export function SystemPanel() {
  const state = useStore();
  const [saved, setSaved] = useState<OperatorSettings | null>(null);
  const [draft, setDraft] = useState<OperatorPreferences>(DEFAULT_OPERATOR_PREFERENCES);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsWorking, setSettingsWorking] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [settingsConflict, setSettingsConflict] = useState(false);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void getOperatorSettings(controller.signal).then((result) => {
      if (!mounted) return;
      setSaved(result);
      setDraft(result.preferences);
      setSettingsError(null);
    }).catch((cause: unknown) => {
      if (mounted) setSettingsError(`Operator preferences unavailable: ${explain(cause)}`);
    }).finally(() => { if (mounted) setSettingsLoading(false); });
    return () => { mounted = false; controller.abort(); };
  }, []);

  const reloadSettings = async () => {
    setSettingsLoading(true);
    setSettingsStatus(null);
    try {
      const record = await getOperatorSettings();
      setSaved(record);
      setDraft(record.preferences);
      setSettingsConflict(false);
      setSettingsError(null);
      setSettingsStatus(`Loaded saved operator preferences (revision ${record.revision}).`);
    } catch (cause) {
      setSettingsError(`Settings reload failed: ${explain(cause)}`);
    } finally { setSettingsLoading(false); }
  };

  const changePreference = (key: keyof OperatorPreferences, checked: boolean) => {
    setDraft((previous) => ({ ...previous, [key]: checked }));
    setSettingsStatus(null);
  };

  const commitSettings = async (reset: boolean) => {
    if (!saved || settingsWorking || settingsLoading || settingsConflict) return;
    setSettingsWorking(true);
    setSettingsError(null);
    setSettingsStatus(null);
    try {
      const next = reset
        ? await resetOperatorSettings(saved.revision)
        : await saveOperatorSettings(saved.revision, draft);
      setSaved(next);
      setDraft(next.preferences);
      setSettingsStatus(`${reset ? 'Reset' : 'Saved'} operator preferences on server (revision ${next.revision}).`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setSettingsConflict(true);
        setSettingsError('Settings changed in another session. Reload the authoritative revision before editing or saving.');
      } else setSettingsError(`Operator settings could not be saved: ${explain(cause)}`);
    } finally { setSettingsWorking(false); }
  };

  const preferences = saved?.preferences ?? DEFAULT_OPERATOR_PREFERENCES;
  const dirty = saved !== null && (Object.keys(DEFAULT_OPERATOR_PREFERENCES) as Array<keyof OperatorPreferences>)
    .some((key) => draft[key] !== saved.preferences[key]);
  const writable = saved !== null && !settingsWorking && !settingsLoading && !settingsConflict;

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
        <section className="mb-3 border border-structural p-2 space-y-2" data-df-operator-settings
          aria-label="Persistent operator presentation preferences">
          <div className="flex items-center justify-between gap-2">
            <h3 className="df-label text-[10px]">Operator display settings</h3>
            <span className="df-num text-[10px] text-ink-dim" data-df-settings-revision>
              {saved ? `Revision ${saved.revision}` : 'NOT VERIFIED'}
            </span>
          </div>
          <p className="text-[10px] text-ink-dim">
            Saved locally on this installation. Presentation only: no source credentials,
            network permissions, sensor evidence or detection parameters change.
          </p>
          {settingsLoading ? <p role="status" data-df-settings-loading className="df-note text-[11px]">
            Reading saved operator preferences…
          </p> : null}
          {([
            ['show_provider_details', 'Display provider diagnostic details'],
            ['show_keyboard_reference', 'Display keyboard shortcut reference'],
            ['show_provenance_summary', 'Display supplementary provenance explanation'],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-[11px] text-ink-2">
              <input type="checkbox" data-df-operator-setting={key}
                checked={saved ? draft[key] : DEFAULT_OPERATOR_PREFERENCES[key]}
                disabled={!writable}
                onChange={(event) => changePreference(key, event.target.checked)} />
              {label}
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="df-btn" data-df-settings-save
              disabled={!writable || !dirty} onClick={() => void commitSettings(false)}>Save preferences</button>
            <button type="button" className="df-btn" data-df-settings-reset
              disabled={!writable} onClick={() => void commitSettings(true)}>Reset to defaults</button>
            <button type="button" className="df-btn" data-df-settings-reload
              disabled={settingsWorking || settingsLoading} onClick={() => void reloadSettings()}>Reload saved</button>
          </div>
          {settingsError ? <p role="alert" data-df-settings-error className="text-[11px] text-fault">
            {settingsError}
            {saved === null ? ' Displaying fallback layout only; nothing is recorded as saved.' : ''}
          </p> : null}
          {settingsStatus ? <p role="status" data-df-settings-status className="text-[11px] text-ink-2">
            {settingsStatus}
          </p> : null}
        </section>
        <ArchiveCoverageSection />
        <BasemapSection />
        <MaritimeEntitySection />
        {/* Deliberately adjacent to, not inside, `Source health` below: those are remote
            HTTP sources with a live-uptime meaning, these are files on this disk. */}
        <DatasetHealthSection />

        <p className="df-label mb-1.5 mt-3 text-[10px]">Source health</p>
        {state.providersLoading && state.providers.length > 0 ? (
          <p className="mb-1 text-[11px] text-ink-dim" role="status">
            Probing sources. The statuses below are from the previous check.
          </p>
        ) : null}
        {worstProviderHealth(state.providers) !== null ? (
          <p className="mb-1 text-[11px]" data-df-provider-overall>
            <span className="df-label text-[10px]">Worst reported health: </span>
            <span style={{ color: healthColor[worstProviderHealth(state.providers)!] ?? 'var(--df-text-dim)' }}>
              {worstProviderHealth(state.providers)?.replace(/_/g, ' ')}
            </span>
          </p>
        ) : null}
        {state.providers.length === 0 ? (
          <p className="text-[11px] text-ink-dim" data-df-providers-empty>
            {state.providersLoading
              ? 'Probing sources…'
              : `No source has reported. ${NOT_ESTABLISHED} is not the same as operational.`}
          </p>
        ) : (
          <ul className="space-y-1" data-df-provider-list>
            {state.providers.map((provider) => <ProviderHealthRow key={provider.provider}
              provider={provider} showOptionalDetails={preferences.show_provider_details} />)}
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
          Overall status is computed from reported provider states. An unknown or absent
          provider status does not establish group availability.
        </p>

        <SystemKeyboardReference visible={preferences.show_keyboard_reference} />
        <SystemProvenanceStatus session={state}
          showSupplementary={preferences.show_provenance_summary} />
      </div>
    </section>
  );
}
