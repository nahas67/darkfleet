/**
 * DarkFleet vNext spatial shell â€” the ONE product surface.
 *
 * Layout contract:
 *  - The full-screen Cesium globe is the only primary viewport. There is no
 *    dashboard frame and no 2D fallback.
 *  - A minimal top bar carries the wordmark, live SAR/AIS provider status, the
 *    UTC clock and settings. There is no runtime-mode control: the synthetic
 *    runtime was removed from the product and every scan is a real provider
 *    query, so there is no mode left to pick.
 *  - A compact left icon rail (SEARCH / LAYERS / SAR / AIS / CORRELATE /
 *    ANALYTICS / MORE) and a bottom-centre command dock (SEARCH / SCAN / TIME /
 *    LAYERS / VIEW) each open a single floating contextual surface.
 *
 * Honesty rules enforced here:
 *  - Cesium attribution is never hidden; no rule in this file touches
 *    `.cesium-widget-credits` (see `src/index.css`, which only restyles it).
 *  - Nothing in this file invents data: no synthetic scene, no substitute
 *    extent, no fabricated count. Scan requests carry only a bbox and the
 *    scene the backend itself catalogued.
 *  - Layers the registry marks NOT_AVAILABLE are rendered disabled with a
 *    reason. They are never made visible and never emitted.
 *  - No progress percentage, invented stage, or client-side analytics.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Clock,
  Download,
  EyeOff,
  GitCompare,
  Globe,
  Layers,
  MoreHorizontal,
  Radar,
  RefreshCw,
  Search,
  Settings,
  Ship,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { BoundingBox, LayerId, ProvidersHealth, ProviderHealthEntry, ScanResult, VesselTarget } from '../types/api.ts';
import type { ScanRequest } from '../types/api.ts';
import {
  ADVANCED_LAYER_IDS,
  appStore,
  formatUtc,
  providerLabel,
  providerTone,
  summarizeProviders,
  unavailableLayers,
  visibleLayerGroups,
} from './state.ts';
import type {
  AppState,
  AppStore,
  LayerGroupId,
  ProviderSummary,
  SurfaceId,
} from './state.ts';
import { createApiClient, scanExportUrl, toProvidersHealth } from './useApi.ts';
import type { ApiClient, RevisitPlan, ScanTargetsResponse, SceneListResponse, SceneSummary } from './useApi.ts';
import { stageLabel, stagePosition, useScan } from './useScan.ts';
import type { ScanState } from './useScan.ts';
import { AnalysisWorkbench } from '../analysis/AnalysisWorkbench.tsx';
import { Contacts } from '../contacts/Contacts.tsx';
import { TargetInspector } from '../evidence/TargetInspector.tsx';
import { AcquisitionPlan } from '../plan/AcquisitionPlan.tsx';
import { Timeline } from '../timeline/Timeline.tsx';

type IconComponent = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

interface RailEntry {
  readonly id: SurfaceId;
  readonly label: string;
  readonly Icon: IconComponent;
}

/** Left rail order is fixed by the shell spec. */
const RAIL_ENTRIES: readonly RailEntry[] = [
  { id: 'SEARCH', label: 'Spatial search', Icon: Search },
  { id: 'LAYERS', label: 'Display layers', Icon: Layers },
  { id: 'SAR', label: 'SAR imagery', Icon: Radar },
  { id: 'AIS', label: 'AIS contacts', Icon: Ship },
  { id: 'CORRELATE', label: 'Correlate', Icon: GitCompare },
  { id: 'ANALYTICS', label: 'Analytics', Icon: BarChart3 },
  { id: 'MORE', label: 'More tools', Icon: MoreHorizontal },
];

/** Bottom-centre command dock order is fixed by the shell spec. */
const DOCK_ENTRIES: readonly RailEntry[] = [
  { id: 'SEARCH', label: 'Search scenes', Icon: Search },
  { id: 'SCAN', label: 'Run scan', Icon: Sparkles },
  { id: 'TIME', label: 'Timeline', Icon: Clock },
  { id: 'LAYERS', label: 'Display layers', Icon: SlidersHorizontal },
  { id: 'VIEW', label: 'Camera view', Icon: Globe },
];

const SURFACE_HEADINGS: Readonly<Record<SurfaceId, string>> = {
  SEARCH: 'Spatial search',
  LAYERS: 'Layers',
  SAR: 'SAR',
  AIS: 'AIS',
  CORRELATE: 'Correlate',
  ANALYTICS: 'Analytics',
  MORE: 'More',
  SCAN: 'Scan',
  TIME: 'Timeline',
  VIEW: 'View',
};

// ------------------------------------------------------------------ shell

export interface SpatialShellProps {
  /** Injectable store. Defaults to the process store; tests pass their own. */
  readonly store?: AppStore;
  /** Injectable API client. Defaults to a real fetch-backed client. */
  readonly client?: ApiClient;
  /** Wall clock in ms. Injected so the UTC readout is deterministic in tests. */
  readonly now?: () => number;
  /**
   * Cesium mount point. The shell owns the container; the caller renders the
   * globe into it. Rendered last so chrome always paints above the globe.
   */
  readonly children?: React.ReactNode;
  readonly onViewerReady?: (viewer: unknown) => void;
}

export function SpatialShell({
  store = appStore,
  client: clientProp,
  now = Date.now,
  children,
  onViewerReady,
}: SpatialShellProps): React.ReactElement {
  const [state, setState] = useState<AppState>(() => store.getState());
  const [clockMs, setClockMs] = useState(() => now());

  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);

  // 1 Hz UTC readout; the top bar is the only clock surface.
  useEffect(() => {
    const id = setInterval(() => setClockMs(now()), 1000);
    return () => clearInterval(id);
  }, [now]);

  // Escape closes whatever surface is open. Bound at the shell root so it
  // works regardless of which control holds focus.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.closeSurface();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  // Provider health is a live probe, never a hardcoded "online". The result is
  // written to the store so the top bar and every source-health surface read the
  // same real state.
  const client = useMemo(() => clientProp ?? createApiClient(), [clientProp]);
  const [refreshProviders, setRefreshProviders] = useState(0);
  const providers = state.providers;
  const providersError = state.providersError;

  useEffect(() => {
    let cancelled = false;
    client
      .getProvidersHealth()
      .then((response) => {
        if (cancelled) return;
        store.setProviders(toProvidersHealth(response), response.checked_at, null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed probe is an unknown state, never a fallback to "online".
        store.setProviders(
          null,
          null,
          err instanceof Error ? err.message : 'Provider health unavailable.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client, store, refreshProviders]);

  const scan = useScan({ client });
  useEffect(() => {
    if (scan.state.scanId) store.setActiveScanId(scan.state.scanId);
  }, [scan.state.scanId, store]);

  // The active scan's targets are fetched ONCE here and shared by every surface
  // that needs them (contacts, inspector, timeline). Each surface fetching its
  // own copy would mean three requests and three chances to disagree.
  //
  // The fetch keys on the JOB STAGE as well as the id. A scan that is still
  // running answers 409 for /targets, so a fetch that races the job leaves the
  // surfaces empty; without a stage dependency they would stay empty until a
  // manual page reload even after the scan finished.
  const activeScanId = scan.state.scanId ?? state.activeScanId;
  const targets = useScanTargets(client, activeScanId, scan.state.stage, scan.state.terminal);

  const openSurface = state.openSurface;
  const toggle = useCallback((id: SurfaceId) => store.toggleSurface(id), [store]);
  const close = useCallback(() => store.closeSurface(), [store]);

  const sar = summarizeProviders(providers?.sar);
  const ais = summarizeProviders(providers?.ais);

  return (
    <div className="fixed inset-0 h-full w-full overflow-hidden bg-[var(--df-bg)] text-[var(--df-text)]">
      {/* 1. Globe: the single primary viewport, full bleed. */}
      <div className="absolute inset-0 z-0" data-df-globe-container>
        {children}
      </div>

      {/* 2. Minimal top bar. */}
      <TopBar
        sar={sar}
        ais={ais}
        clockMs={clockMs}
        onOpenSettings={() => store.toggleSurface('MORE')}
      />

      {/* 3. Compact left icon rail. */}
      <LeftRail entries={RAIL_ENTRIES} openSurface={openSurface} onSelect={toggle} />

      {/* 4. Bottom-centre floating command dock. */}
      <CommandDock entries={DOCK_ENTRIES} openSurface={openSurface} onSelect={toggle} />

      {/* 5. Exactly one floating contextual surface at a time. */}
      {openSurface && (
        <FloatingSurface title={SURFACE_HEADINGS[openSurface]} onClose={close}>
          <SurfaceBody
            surface={openSurface}
            state={state}
            store={store}
            client={client}
            providers={providers}
            providersError={providersError}
            scan={scan.state}
            targets={targets}
            onStartScan={scan.startScan}
            onRefreshProviders={() => setRefreshProviders((n) => n + 1)}
            onViewerReady={onViewerReady}
          />
        </FloatingSurface>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- top bar

interface TopBarProps {
  sar: ProviderSummary;
  ais: ProviderSummary;
  clockMs: number;
  onOpenSettings: () => void;
}

function TopBar({ sar, ais, clockMs, onOpenSettings }: TopBarProps) {
  return (
    <header
      className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex items-center gap-3 px-4 py-2"
      role="banner"
    >
      <div className="df-glass flex items-center gap-2 rounded-[var(--df-control-radius)] px-3 py-1.5">
        <span className="font-mono text-sm font-semibold tracking-[0.22em] text-[var(--df-accent)]">
          DARKFLEET
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ProviderBadge kind="SAR" summary={sar} />
        <ProviderBadge kind="AIS" summary={ais} />
        <time
          className="df-glass rounded-[var(--df-control-radius)] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[var(--df-text-secondary)]"
          data-df-utc-clock
        >
          {formatUtc(clockMs)}
        </time>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings and source health"
          className="df-glass rounded-[var(--df-control-radius)] p-2 text-[var(--df-text-secondary)] transition hover:text-[var(--df-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
        >
          <Settings className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </header>
  );
}

const TONE_CLASS: Record<'ok' | 'warn' | 'bad' | 'idle', string> = {
  ok: 'text-[var(--df-success)]',
  warn: 'text-[var(--df-warning)]',
  bad: 'text-[var(--df-danger)]',
  idle: 'text-[var(--df-text-dim)]',
};

function ProviderBadge({ kind, summary }: { kind: 'SAR' | 'AIS'; summary: ProviderSummary }) {
  const tone = providerTone(summary.state);
  return (
    <div
      className="df-glass flex items-center gap-1.5 rounded-[var(--df-control-radius)] px-2.5 py-1.5"
      data-df-provider={kind}
      // The full probe detail is the accessible name; the visible text is short.
      title={summary.detail}
    >
      <span className="font-mono text-[9px] tracking-[0.18em] text-[var(--df-text-dim)]">
        {kind}
      </span>
      <span className={`font-mono text-[10px] font-semibold ${TONE_CLASS[tone]}`}>
        {providerLabel(summary.state)}
      </span>
      <span className="sr-only">{summary.detail}</span>
    </div>
  );
}

// --------------------------------------------------------------- left rail

interface NavProps {
  entries: readonly RailEntry[];
  openSurface: SurfaceId | null;
  onSelect: (id: SurfaceId) => void;
}

function LeftRail({ entries, openSurface, onSelect }: NavProps) {
  return (
    <nav
      aria-label="Primary tools"
      data-df-rail
      className="df-glass pointer-events-auto absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-[10px] p-1"
    >
      {entries.map(({ id, label, Icon }) => {
        const active = openSurface === id;
        return (
          <RailButton
            key={id}
            id={id}
            label={label}
            active={active}
            onSelect={onSelect}
            Icon={Icon}
          />
        );
      })}
    </nav>
  );
}

function CommandDock({ entries, openSurface, onSelect }: NavProps) {
  return (
    <div
      data-df-dock
      className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center"
    >
      <div
        role="toolbar"
        aria-label="Command dock"
        className="df-glass pointer-events-auto flex items-center gap-1 rounded-[12px] p-1"
      >
        {entries.map(({ id, label, Icon }) => {
          const active = openSurface === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-label={label}
              aria-pressed={active}
              data-df-dock-item={id}
              className={[
                'rounded-[8px] p-2 transition',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]',
                active
                  ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent)]'
                  : 'text-[var(--df-text-secondary)] hover:bg-[var(--df-accent-soft)] hover:text-[var(--df-accent)]',
              ].join(' ')}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RailButton({
  id,
  label,
  active,
  onSelect,
  Icon,
}: {
  id: SurfaceId;
  label: string;
  active: boolean;
  onSelect: (id: SurfaceId) => void;
  Icon: IconComponent;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-label={label}
      aria-pressed={active}
      data-df-rail-item={id}
      className={[
        'rounded-[8px] p-2 transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]',
        active
          ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent)]'
          : 'text-[var(--df-text-secondary)] hover:bg-[var(--df-accent-soft)] hover:text-[var(--df-accent)]',
      ].join(' ')}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

// -------------------------------------------------------- floating surface

function FloatingSurface({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Move focus into the surface so keyboard users land inside it.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <div
        ref={ref}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        data-df-surface={title}
        className="df-glass-strong pointer-events-auto absolute left-[4.75rem] top-[4.5rem] max-h-[calc(100vh-9rem)] w-[22rem] overflow-y-auto rounded-[var(--df-panel-radius)] p-4 shadow-2xl focus:outline-none"
      >
        <div className="mb-3 flex items-center justify-between border-b border-[var(--df-border)] pb-2">
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--df-accent)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded-[6px] p-1 text-[var(--df-text-dim)] transition hover:text-[var(--df-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ surface bodies

interface SurfaceBodyProps {
  surface: SurfaceId;
  state: AppState;
  store: AppStore;
  client: ApiClient;
  providers: ProvidersHealth | null;
  providersError: string | null;
  scan: ScanState;
  targets: ScanTargetsResponse | null;
  onStartScan: (request: ScanRequest) => void;
  onRefreshProviders: () => void;
  onViewerReady?: (viewer: unknown) => void;
}

/**
 * The active scan's target list, fetched once and shared. `null` means either
 * "no scan" or "not readable yet" — never an empty list standing in for either.
 *
 * `stage` and `terminal` are dependencies on purpose: a scan that has not
 * finished answers 409, so re-reading only on `scanId` would strand the
 * surfaces empty after the job completes.
 */
function useScanTargets(
  client: ApiClient,
  scanId: string | null,
  stage: string | null,
  terminal: boolean,
): ScanTargetsResponse | null {
  const [targets, setTargets] = useState<ScanTargetsResponse | null>(null);
  useEffect(() => {
    if (!scanId) {
      setTargets(null);
      return undefined;
    }
    let cancelled = false;
    client
      .getScanTargets(scanId)
      .then((response) => {
        if (cancelled) return;
        setTargets(response);
        // Publish to the store so the globe bridge can draw it. This is the only
        // handoff from the shell to the map: the shell does not know what Cesium
        // is, and the bridge does not fetch.
        appStore.setScanResult(toGlobeScanResult(response));
      })
      .catch(() => {
        // Not readable yet (409 while the job runs) is an unknown state, not an
        // empty scan. The stage dependency re-runs this once the job lands.
        if (cancelled) return;
        setTargets(null);
        // Clear the globe too: the previous scan's marks are real measurements,
        // but of somewhere else, and leaving them up while a new scan loads
        // would show a stale reading as if it were the current one.
        appStore.setScanResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, scanId, stage, terminal]);
  return targets;
}

/**
 * Adapt the targets response into the `ScanResult` shape the globe draws.
 *
 * Returns null when the response cannot be trusted as a measurement. The backend
 * stamps `runtime_mode` and `synthetic` on every response, so a payload that
 * says otherwise is refused here rather than drawn: a globe full of fabricated
 * marks would be the single worst failure this tool could have.
 *
 * Exported for testing: this is the last point at which a fabricated payload can
 * be stopped, so it is asserted directly rather than inferred from the globe.
 */
export function toGlobeScanResult(response: ScanTargetsResponse): ScanResult | null {
  if (response.runtime_mode !== 'REAL' || response.synthetic !== false) return null;
  const targets = Array.isArray(response.targets) ? response.targets : [];
  const aisOnly = Array.isArray(response.ais_only) ? response.ais_only : [];
  return {
    scan_id: response.scan_id,
    runtime_mode: 'REAL',
    synthetic: false,
    scene: (response.scene ?? {}) as ScanResult['scene'],
    aoi: Array.isArray(response.aoi) ? response.aoi : [],
    acquisition_time: response.acquisition_time ?? '',
    config: {},
    targets: targets as unknown as VesselTarget[],
    ais_only: aisOnly as unknown as ScanResult['ais_only'],
    counts: response.counts ?? {},
    provenance: (response.provenance ?? {}) as unknown as ScanResult['provenance'],
    processing_time_ms: 0,
    created_at: '',
  };
}

function SurfaceBody(props: SurfaceBodyProps) {
  const { state, store, client, targets } = props;
  const selected = useMemo(
    () => targets?.targets.find((t) => t.id === state.selectedTargetId) ?? null,
    [targets, state.selectedTargetId],
  );
  const selectTarget = useCallback((id: string | null) => store.selectTarget(id), [store]);

  switch (props.surface) {
    case 'LAYERS':
      return <LayersSurface state={state} store={store} />;
    case 'SEARCH':
      return <SceneBrowser client={client} />;
    case 'TIME':
      return (
        <Timeline
          scan={
            targets
              ? {
                  scan_id: targets.scan_id,
                  acquisition_time: targets.acquisition_time,
                  scene: targets.scene
                    ? { acquisition_time: targets.scene.acquisition_time }
                    : null,
                }
              : null
          }
          targetId={state.selectedTargetId}
          onClose={store.closeSurface}
        />
      );
    case 'SCAN':
      return (
        <ScanLauncher
          scan={props.scan}
          store={store}
          onStart={props.onStartScan}
          client={client}
        />
      );
    case 'SAR':
      return (
        <>
          <SarSurface state={state} providers={props.providers} />
          <div className="mt-4 border-t border-[var(--df-border)] pt-3">
            <AcquisitionPlanSection client={client} state={state} scan={props.scan} />
          </div>
          <div className="mt-4 border-t border-[var(--df-border)] pt-3">
            <AnalysisWorkbench client={client} scanId={state.activeScanId} />
          </div>
        </>
      );
    case 'AIS':
      return (
        <>
          <Contacts
            targets={targets?.targets ?? null}
            aisOnly={targets?.ais_only ?? null}
            selectedTargetId={state.selectedTargetId}
            onSelectTarget={selectTarget}
            onClose={store.closeSurface}
          />
          <div className="mt-4 border-t border-[var(--df-border)] pt-3">
            <AisSurface state={state} providers={props.providers} />
          </div>
        </>
      );
    case 'CORRELATE':
      return (
        <>
          <TargetInspector
            target={selected}
            scene={targets?.scene ?? null}
            client={client}
          />
          <div className="mt-4 border-t border-[var(--df-border)] pt-3">
            <CorrelateSurface state={state} providers={props.providers} />
          </div>
        </>
      );
    case 'ANALYTICS':
      return <AnalyticsSurface state={state} scan={props.scan} targets={targets} />;
    case 'MORE':
    case 'VIEW':
      return (
        <SettingsSurface
          state={state}
          providers={props.providers}
          providersError={props.providersError}
          onRefreshProviders={props.onRefreshProviders}
        />
      );
    default:
      return null;
  }
}

function GroupHeading({ group }: { group: LayerGroupId }) {
  return (
    <h3 className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
      {group}
    </h3>
  );
}

/**
 * Layers surface. Groups follow the registry's own declaration order and the
 * NOT_AVAILABLE layers get an explicit, visibly disabled row.
 */
function LayersSurface({ state, store }: { state: AppState; store: AppStore }) {
  const groups = visibleLayerGroups(state);
  const blocked = unavailableLayers(state);
  return (
    <div data-df-layers className="space-y-4">
      {groups.map(({ group, items }) => (
        <section key={group}>
          <GroupHeading group={group} />
          <ul className="space-y-1.5">
            {items.map((layer) => (
              <li key={layer.id} data-df-layer={layer.id}>
                <div className="flex items-center justify-between gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-[var(--df-text-secondary)]">
                    <input
                      type="checkbox"
                      checked={layer.visible}
                      onChange={(event) =>
                        store.setLayerVisible(layer.id as LayerId, event.target.checked)
                      }
                      aria-label={`Toggle layer ${layer.title}`}
                      className="h-3 w-3 shrink-0 accent-[var(--df-accent)]"
                    />
                    <span className="truncate">{layer.title}</span>
                  </label>
                  {layer.supportsOpacity ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="sr-only">{layer.title} opacity</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={layer.opacity}
                        onChange={(event) =>
                          store.setLayerOpacity(layer.id as LayerId, Number(event.target.value))
                        }
                        aria-label={`${layer.title} opacity`}
                        className="h-1 w-16 accent-[var(--df-accent)]"
                      />
                    </span>
                  ) : (
                    <span
                      className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--df-text-dim)]"
                      title="This layer has no opacity control"
                    >
                      n/a
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {blocked.length > 0 && (
        <section data-df-layers-unavailable>
          <h3 className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-warning)]">
            Not available
          </h3>
          <ul className="space-y-1">
            {blocked.map((layer) => (
              <li key={layer.id} className="flex items-center gap-2" data-df-layer={layer.id}>
                <button
                  type="button"
                  disabled
                  aria-label={`${layer.title} - no data source, cannot be enabled`}
                  title={`${layer.title} has no backend data source (${layer.source})`}
                  className="flex w-full cursor-not-allowed items-center gap-2 rounded-[6px] px-1 py-0.5 text-left text-[11px] text-[var(--df-text-dim)] line-through"
                >
                  <EyeOff className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{layer.title}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-[var(--df-text-dim)]">
            These layers are declared but unimplemented. They cannot be enabled and no data is
            rendered for them.
          </p>
        </section>
      )}
    </div>
  );
}

/** Scene browser: a real `GET /api/scenes` call, nothing invented. */
function SceneBrowser({ client }: { client?: ApiClient }) {
  const resolved = useMemo(() => client ?? createApiClient(), [client]);
  const [scenes, setScenes] = useState<SceneListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(() => {
    setLoading(true);
    setError(null);
    resolved
      .getScenes()
      .then((response) => setScenes(response))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Scene query failed.'),
      )
      .finally(() => setLoading(false));
  }, [resolved]);

  useEffect(search, [search]);

  return (
    <div data-df-scene-browser className="space-y-3">
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Every scene listed is a real acquisition returned by the backend provider probe.
      </p>
      {error && (
        <p className="flex items-start gap-1.5 text-[10px] text-[var(--df-danger)]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {loading && <p className="font-mono text-[10px] text-[var(--df-text-dim)]">Queryingâ€¦</p>}
      {!loading && !scenes && !error && (
        <p className="font-mono text-[10px] text-[var(--df-text-dim)]">No scene query run yet.</p>
      )}
      {scenes && (
        <>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--df-text-dim)]">
            {scenes.count} scenes Â· {scenes.provider} Â· {scenes.status}
          </p>
          <ul className="space-y-1.5">
            {scenes.scenes.map((scene) => (
              <li
                key={scene.id}
                className="rounded-[6px] border border-[var(--df-border)] px-2 py-1.5 text-[10px]"
              >
                <span className="truncate font-mono text-[var(--df-text)]">
                  {scene.platform} {scene.product}
                </span>
                <p className="mt-0.5 font-mono text-[9px] text-[var(--df-text-dim)]">
                  {scene.id} Â· {scene.acquisition_time}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        onClick={search}
        disabled={loading}
        className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--df-border)] px-2 py-1.5 font-mono text-[10px] text-[var(--df-text-secondary)] transition hover:border-[var(--df-border-active)] hover:text-[var(--df-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)] disabled:opacity-40"
      >
        <RefreshCw className="h-3 w-3" aria-hidden />
        Refresh scenes
      </button>
    </div>
  );
}

/**
 * Parse the operator's extent. Pure, so the exact validation that guards a
 * scan request is assertable without a DOM.
 */
export function parseBbox(
  text: string,
): { bbox: BoundingBox } | { error: string } {
  const parts = text
    .split(',')
    .map((p: string) => Number(p.trim()))
    .filter((n: number) => Number.isFinite(n));
  if (parts.length !== 4) {
    return { error: 'Enter four numbers: min_lon, min_lat, max_lon, max_lat.' };
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (minLon >= maxLon || minLat >= maxLat) {
    return { error: 'min_lon must be below max_lon and min_lat below max_lat.' };
  }
  return { bbox: [minLon, minLat, maxLon, maxLat] };
}

/**
 * Build the scan request.
 *
 * The request carries ONLY what the operator asked for: the extent, and the
 * scene id when one came from the backend catalogue. It deliberately carries no
 * `runtime_mode` — the backend removed the synthetic runtime and rejects that
 * field with 422 `extra_forbidden`. Every scan is a live provider query.
 */
export function buildScanRequest(
  bbox: BoundingBox,
  scene: SceneSummary | null,
): ScanRequest {
  return {
    bbox,
    ...(scene ? { scene_id: scene.id } : {}),
  };
}

/**
 * SAR acquisition plan, mounted under the SAR surface (GEO-002).
 *
 * The AOI comes from the active scan so the plan describes the water the user is
 * actually looking at. With no scan there is no extent to plan over, and the
 * section says so rather than planning somewhere arbitrary.
 */
function AcquisitionPlanSection({
  client,
  state,
  scan,
}: {
  client: ApiClient;
  state: AppState;
  scan: ScanState;
}) {
  const [plan, setPlan] = useState<RevisitPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bbox, setBbox] = useState<number[] | null>(null);

  useEffect(() => {
    const scanId = scan.scanId ?? state.activeScanId;
    if (!scanId) {
      setBbox(null);
      setPlan(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .getScanTargets(scanId)
      .then((targets) => {
        if (cancelled) return;
        // Prefer the scan's own AOI; fall back to the extent of what it found.
        const box = targets.aoi ?? null;
        if (box && box.length === 4) {
          setBbox(box as number[]);
          return;
        }
        setBbox(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read the scan extent.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, scan.scanId, state.activeScanId]);

  useEffect(() => {
    if (!bbox || bbox.length !== 4) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .getRevisitPlan(bbox)
      .then((response) => {
        if (!cancelled) setPlan(response);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPlan(null);
        setError(
          err instanceof Error
            ? `Acquisition plan unavailable: ${err.message}`
            : 'Acquisition plan unavailable.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, bbox]);

  if (!scan.scanId && !state.activeScanId) {
    return (
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Acquisition planning needs an area. Run a scan, or set an extent, to plan coverage for it.
      </p>
    );
  }

  return <AcquisitionPlan plan={plan} error={error} loading={loading} />;
}

/**
 * Scan launcher. The Scan surface previously only DISPLAYED scan state, so a
 * scan could be started from nowhere in the UI: `useScan().startScan` and
 * `client.createScan` both existed with no caller. This wires them.
 *
 * The bbox is entered explicitly. There is no "use the whole world" default,
 * because a live scan over an arbitrary extent would either return nothing or
 * silently download an unreasonable amount of data.
 */
export function ScanLauncher({
  scan,
  store,
  onStart,
  client,
}: {
  scan: ScanState;
  store: AppStore;
  onStart: (request: ScanRequest) => void;
  client?: ApiClient;
}) {
  const [bboxText, setBboxText] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const busy = scan.connection === 'CONNECTING' || scan.connection === 'STREAMING';

  // The backend owns the footprints. A hardcoded default extent is rejected
  // with BBOX_SCENE_MISMATCH, so the scene catalogue is the authoritative
  // source for a valid extent — and it is a real provider catalogue.
  useEffect(() => {
    let cancelled = false;
    (client ?? createApiClient())
      .getScenes()
      .then((response) => {
        if (cancelled) return;
        setScenes(response.scenes);
      })
      .catch(() => {
        // A failed catalogue read is an unknown state. The field stays empty
        // and the operator types an extent; nothing is invented.
        if (!cancelled) setScenes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const cataloguedScene = useMemo(() => scenes?.[0] ?? null, [scenes]);
  const suggested = bboxText ?? cataloguedScene?.bbox?.join(', ') ?? '';

  const submit = useCallback(() => {
    const bbox = parseBbox(suggested);
    if ('error' in bbox) {
      setParseError(bbox.error);
      return;
    }
    setParseError(null);
    onStart(buildScanRequest(bbox.bbox, cataloguedScene));
  }, [suggested, onStart, cataloguedScene]);

  return (
    <div data-df-scan-launcher className="space-y-3">
      <div className="space-y-1">
        <label
          htmlFor="df-scan-bbox"
          className="block font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]"
        >
          Area of interest
        </label>
        <input
          id="df-scan-bbox"
          type="text"
          value={suggested}
          onChange={(event) => setBboxText(event.target.value)}
          disabled={busy}
          placeholder="min_lon, min_lat, max_lon, max_lat"
          aria-label="Bounding box: min_lon, min_lat, max_lon, max_lat"
          aria-invalid={parseError !== null}
          className="w-full rounded-[6px] border border-[var(--df-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] text-[var(--df-text)] placeholder:text-[var(--df-text-dim)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)] disabled:opacity-50"
        />
        {cataloguedScene && (
          <p className="font-mono text-[9px] text-[var(--df-text-dim)]">
            extent of {cataloguedScene.id}
          </p>
        )}
        {parseError && (
          <p className="flex items-start gap-1.5 text-[10px] text-[var(--df-danger)]">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            {parseError}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={busy || suggested.trim() === ''}
        aria-label={busy ? 'Scan in flight' : 'Run live scan'}
        className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--df-border-active)] px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--df-accent)] transition hover:bg-[var(--df-accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)] disabled:opacity-40"
      >
        <Sparkles className="h-3 w-3" aria-hidden />
        {busy ? 'Scan in flight' : 'Run live scan'}
      </button>
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Queries the live SAR provider over the extent above. If the provider cannot serve it the scan
        fails visibly rather than returning substituted data.
      </p>

      <div className="border-t border-[var(--df-border)] pt-3">
        <ScanSurface scan={scan} store={store} />
      </div>
    </div>
  );
}

/**
 * Scan surface. Renders the stage names the backend actually streamed plus a
 * stage COUNTER read off the fixed pipeline. No percentage, no progress bar.
 */
export function ScanSurface({ scan, store }: { scan: ScanState; store: AppStore }) {
  const position = stagePosition(scan.stage);
  const busy = scan.connection === 'CONNECTING' || scan.connection === 'STREAMING';
  return (
    <div data-df-scan className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-[var(--df-text-dim)]">
          {scan.scanId ?? 'no scan'}
        </span>
      </div>

      <p className="font-mono text-[11px] text-[var(--df-text)]" data-df-scan-stage>
        {scan.stage ? stageLabel(scan.stage) : 'Idle'}
        {position && (
          <span className="ml-2 text-[10px] text-[var(--df-text-dim)]">
            stage {position.index} of {position.total}
          </span>
        )}
      </p>

      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--df-text-dim)]">
        stream: {scan.connection}
      </p>

      {scan.error && (
        <p className="flex items-start gap-1.5 text-[10px] text-[var(--df-danger)]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {scan.error}
        </p>
      )}

      {scan.unknownStages.length > 0 && (
        <p className="text-[10px] text-[var(--df-warning)]">
          Unrecognised stage from backend: {scan.unknownStages.join(', ')}
        </p>
      )}

      {scan.history.length > 0 && (
        <ol className="space-y-1 border-l border-[var(--df-border)] pl-2">
          {scan.history.map((event, index) => (
            <li key={`${event.stage}-${index}`} className="font-mono text-[10px] text-[var(--df-text-secondary)]">
              <span className="text-[var(--df-accent)]">{stageLabel(event.stage)}</span>
              {event.detail && <span className="ml-1.5 text-[var(--df-text-dim)]">{event.detail}</span>}
            </li>
          ))}
        </ol>
      )}

      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Start a scan from the Scan command in the dock. Stage names above are streamed live from the
        backend job.
      </p>
      {busy && <p className="font-mono text-[9px] text-[var(--df-text-dim)]">Job in flight.</p>}
      <button
        type="button"
        onClick={() => {
          store.setActiveScanId(null);
        }}
        className="w-full rounded-[6px] border border-[var(--df-border)] px-2 py-1.5 font-mono text-[10px] text-[var(--df-text-secondary)] transition hover:border-[var(--df-border-active)] hover:text-[var(--df-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
      >
        Clear active scan reference
      </button>
    </div>
  );
}

function ProviderList({
  title,
  entries,
}: {
  title: string;
  entries: ProviderHealthEntry[] | undefined;
}) {
  const summary = summarizeProviders(entries);
  if (!entries || entries.length === 0) {
    return (
      <div>
        <h3 className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
          {title}
        </h3>
        <p className="text-[10px] text-[var(--df-text-dim)]">
          No {title} provider has reported yet.
        </p>
      </div>
    );
  }
  return (
    <div>
      <h3 className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
        {title} Â· {providerLabel(summary.state)}
      </h3>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.provider} className="text-[10px]">
            <span className="font-mono text-[var(--df-text)]">{entry.provider}</span>
            <span className={`ml-1.5 ${TONE_CLASS[providerTone(entry.status)]}`}>
              {providerLabel(entry.status)}
            </span>
            {entry.message && (
              <p className="mt-0.5 text-[10px] leading-snug text-[var(--df-text-dim)]">
                {entry.message}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SarSurface({
  state,
  providers,
}: {
  state: AppState;
  providers: ProvidersHealth | null;
}) {
  return (
    <div data-df-sar className="space-y-3">
      <ProviderList title="SAR" entries={providers?.sar} />
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Raster rendering is driven by the layer registry. Toggle it in Display layers.
      </p>
      <p className="font-mono text-[9px] text-[var(--df-text-dim)]">
        active scan: {state.activeScanId ?? 'none'}
      </p>
    </div>
  );
}

function AisSurface({
  state,
  providers,
}: {
  state: AppState;
  providers: ProvidersHealth | null;
}) {
  return (
    <div data-df-ais className="space-y-3">
      <ProviderList title="AIS" entries={providers?.ais} />
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Association counts are computed by the backend and shown verbatim in Analytics; the frontend
        derives none of them.
      </p>
      <p className="font-mono text-[9px] text-[var(--df-text-dim)]">
        selected target: {state.selectedTargetId ?? 'none'}
      </p>
    </div>
  );
}

function CorrelateSurface({
  state,
  providers,
}: {
  state: AppState;
  providers: ProvidersHealth | null;
}) {
  return (
    <div data-df-correlate className="space-y-3">
      <ProviderList title="SAR" entries={providers?.sar} />
      <ProviderList title="AIS" entries={providers?.ais} />
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Correlation runs in the backend. Use the Correlation links layer to show its output; the
        client never recomputes a match.
      </p>
      <p className="font-mono text-[9px] text-[var(--df-text-dim)]">
        active scan: {state.activeScanId ?? 'none'}
      </p>
    </div>
  );
}

/**
 * Analytics surface. Every number here is a passthrough from the backend's
 * `counts` record; the frontend computes nothing (API-011).
 */
function AnalyticsSurface({
  state,
  scan,
  targets,
}: {
  state: AppState;
  scan: ScanState;
  targets: ScanTargetsResponse | null;
}) {
  const scanId = scan.scanId ?? state.activeScanId;
  const error = null;

  return (
    <div data-df-analytics className="space-y-3">
      {!scanId && (
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
          No scan selected. Run a scan to see backend-computed counters.
        </p>
      )}
      {error && <p className="text-[10px] text-[var(--df-danger)]">{error}</p>}
      {targets && (
        <>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--df-text-dim)]">
            {targets.scan_id} Â· {targets.runtime_mode} provenance
          </p>
          <dl className="space-y-0.5">
            {Object.entries(targets.counts).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2 text-[11px]">
                <dt className="text-[var(--df-text-secondary)]">{key}</dt>
                <dd className="font-mono tabular-nums text-[var(--df-text)]">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-2 border-t border-[var(--df-border)] pt-0.5 text-[11px]">
              <dt className="text-[var(--df-text-secondary)]">ais_only</dt>
              <dd className="font-mono tabular-nums text-[var(--df-text)]">
                {targets.ais_only_count}
              </dd>
            </div>
          </dl>
          <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
            Values are read from the backend response as-is. Nothing here is derived in the browser.
          </p>
        </>
      )}
    </div>
  );
}

function SettingsSurface({
  state,
  providers,
  providersError,
  onRefreshProviders,
}: {
  state: AppState;
  providers: ProvidersHealth | null;
  providersError: string | null;
  onRefreshProviders: () => void;
}) {
  return (
    <div data-df-settings className="space-y-3">
      <ProviderList title="SAR" entries={providers?.sar} />
      <ProviderList title="AIS" entries={providers?.ais} />
      {providersError && (
        <p className="flex items-start gap-1.5 text-[10px] text-[var(--df-danger)]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {providersError}
        </p>
      )}
      <button
        type="button"
        onClick={onRefreshProviders}
        className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--df-border)] px-2 py-1.5 font-mono text-[10px] text-[var(--df-text-secondary)] transition hover:border-[var(--df-border-active)] hover:text-[var(--df-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
      >
        <Activity className="h-3 w-3" aria-hidden />
        Re-probe providers
      </button>

      <div className="space-y-1 border-t border-[var(--df-border)] pt-2">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
          Camera
        </h3>
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
          Camera presets are owned by the Cesium viewport. Drag, scroll and tilt directly on the
          globe.
        </p>
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
          Cesium attribution stays visible in the bottom-right corner.
        </p>
      </div>

      <div className="space-y-1 border-t border-[var(--df-border)] pt-2">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
          Export
        </h3>
        {state.activeScanId ? (
          <div className="flex flex-wrap gap-1.5">
            {(['json', 'geojson', 'kml', 'png', 'pdf'] as const).map((format) => (
              <a
                key={format}
                href={scanExportUrl(state.activeScanId as string, format)}
                className="flex items-center gap-1 rounded-[6px] border border-[var(--df-border)] px-2 py-1 font-mono text-[10px] text-[var(--df-text-secondary)] transition hover:border-[var(--df-border-active)] hover:text-[var(--df-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
                aria-label={`Export scan as ${format.toUpperCase()}`}
              >
                <Download className="h-3 w-3" aria-hidden />
                {format}
              </a>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-[var(--df-text-dim)]">
            Exports appear once a scan exists.
          </p>
        )}
      </div>

      <div className="space-y-1 border-t border-[var(--df-border)] pt-2">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
          Gated layers
        </h3>
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
          {ADVANCED_LAYER_IDS.length} analysis layers are declared without a data source and cannot
          be enabled from this shell. The analysis workbench under SAR exposes all 13 debug layers
          the backend actually serves; anything it cannot serve is shown as unavailable rather
          than drawn.
        </p>
      </div>
    </div>
  );
}

export default SpatialShell;