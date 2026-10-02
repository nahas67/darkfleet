/**
 * DarkFleet command application.
 *
 * Layout is a frame around the globe, never a page containing one. The globe is
 * always mounted and always fills the space between the chrome; panels float
 * above it and can be closed without disturbing it.
 *
 *   +-------------------------------------------------------------+
 *   | top command strip                                           |
 *   +------+------------------------------------------+-----------+
 *   | rail |            TACTICAL WORLD                | workspace |
 *   |      |                                          |           |
 *   +------+------------------------------------------+-----------+
 *   | mission timeline                                          |
 *   +-------------------------------------------------------------+
 *
 * Responsive: below 1280 the workspace becomes a drawer so the globe keeps the
 * majority of the viewport, which is the whole point of the product.
 */

import { useEffect, useRef } from 'react';

import { loadProviders, loadRaster } from '../api/client';
import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';
import { OperationRail, type WorkspaceId } from './OperationRail';
import { TopStrip } from './TopStrip';
import { useGlobalKeys } from './useGlobalKeys';
import { TacticalWorld } from '../tactical/TacticalWorld';
import { MissionTimeline } from '../timeline/MissionTimeline';
import { ContactList } from '../contacts/ContactList';
import { TargetIntel } from '../intelligence/TargetIntel';
import { LayerConsole } from '../sensors/LayerConsole';
import { ScanWorkflow } from '../missions/ScanWorkflow';
import { SceneBrowser } from '../scenes/SceneBrowser';
import { SystemPanel } from '../command/SystemPanel';
import { ReportsWorkspace } from '../reports/ReportsWorkspace';
import { AnalyticsWorkspace } from '../analytics/AnalyticsWorkspace';
import { UnifiedSearch } from '../search/UnifiedSearch';

export function DarkFleetCommandApp() {
  const state = useStore();
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  useGlobalKeys();

  // Provider health is probed once on mount and re-probed on demand. A failed
  // probe is an explicit state, never an implied "online".
  useEffect(() => {
    void loadProviders();
  }, []);

  // The raster is attached to the measured rectangle the backend reports. It is
  // deliberately not re-fetched here on every render.
  useEffect(() => {
    const scanId = state.scanId;
    if (!scanId || state.scanStage !== 'COMPLETE') return;
    let cancelled = false;
    void (async () => {
      const result = await loadRaster(scanId, 'raw');
      if (cancelled || !result) return;
      engine.setRaster(
        `${result.imageUrl}`,
        result.rectangle,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [state.scanId, state.scanStage]);

  const activeWorkspace = state.workspace;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-void" data-df-app>
      <TopStrip />

      <div className="flex min-h-0 flex-1">
        <OperationRail />

        <main className="relative min-w-0 flex-1">
          <TacticalWorld />

          {/* Navigation telemetry. Camera figures are labelled as camera
              figures: an altitude readout is not an aircraft altitude and must
              never read as one. */}
          <NavHud />
          <TheaterHud />
        </main>

        <aside
          ref={workspaceRef}
          className="relative z-30 flex w-80 shrink-0 flex-col border-l border-structural bg-base/85 backdrop-blur-sm xl:w-96"
          aria-label="Operation workspace"
          data-df-workspace-panel
        >
          {activeWorkspace === 'TACTICAL' ? (
            <>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ScanWorkflow />
              </div>
            </>
          ) : null}
          {activeWorkspace === 'SEARCH' ? <UnifiedSearch /> : null}
          {activeWorkspace === 'INTELLIGENCE' ? (
            <>
              <div className="min-h-0 flex-[3] overflow-hidden border-b border-structural">
                <TargetIntel />
              </div>
              <div className="min-h-0 flex-[2] overflow-hidden">
                <ContactList />
              </div>
            </>
          ) : null}
          {activeWorkspace === 'TASKING' ? <ScanWorkflow /> : null}
          {activeWorkspace === 'LAYERS' ? <LayerConsole /> : null}
          {activeWorkspace === 'ANALYTICS' ? <AnalyticsWorkspace /> : null}
          {activeWorkspace === 'REPORTS' ? <ReportsWorkspace /> : null}
          {activeWorkspace === 'SYSTEM' ? <SystemPanel /> : null}
        </aside>

      </div>

      <MissionTimeline />
    </div>
  );
}

/** Cursor + camera telemetry. */
function NavHud() {
  const state = useStore();
  const bearing =
    state.selection.kind === 'target'
      ? engine.targetBearingAndRange(state.selection.targetId)
      : null;

  return (
    <div
      className="df-clipped df-panel pointer-events-none absolute bottom-2 left-2 px-2.5 py-1.5"
      data-df-nav-hud
    >
      <p className="df-num text-[10px] text-ink">
        {state.cursor
          ? `${state.cursor.lat.toFixed(4)}° ${state.cursor.lon.toFixed(4)}°`
          : 'CURSOR — MOVE OVER GLOBE'}
      </p>
      <p className="df-num text-[10px] text-ink-dim">
        CAM ALT{' '}
        {state.cameraAltitude === null
          ? 'not established'
          : `${Math.round(state.cameraAltitude).toLocaleString()} m`}
      </p>
      {bearing ? (
        <p className="df-num text-[10px] text-ink-2">
          BRG {bearing.bearingDeg.toFixed(0).padStart(3, '0')}° · RNG{' '}
          {(bearing.rangeM / 1000).toFixed(1)} km
        </p>
      ) : null}
    </div>
  );
}

/**
 * Theater overview.
 *
 * Every figure is derived from loaded data. With no scan the panel states that,
 * rather than showing a grid of zeros -- zero detections and no scan are
 * different facts.
 */
function TheaterHud() {
  const state = useStore();
  const hasScan = state.scanId !== null;
  const tally = (classification: string) =>
    state.targets.filter((t) => t.classification === classification).length;

  return (
    <div
      className="df-clipped df-panel pointer-events-none absolute left-2 top-2 w-60 px-2.5 py-2"
      data-df-theater-hud
    >
      <p className="df-label mb-1 text-[10px]">Theater overview</p>
      {!hasScan ? (
        <p className="text-[11px] text-ink-dim">No scan has run for this area.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          {(
            [
              ['Detections', state.targets.length],
              ['Matched', tally('SAR_MATCHED_AIS')],
              ['Unmatched', tally('SAR_UNMATCHED')],
              ['Infrastructure', tally('STATIONARY_OR_INFRASTRUCTURE')],
              ['Low confidence', tally('LOW_CONFIDENCE')],
              ['AIS-only', state.aisOnly.length],
            ] as ReadonlyArray<readonly [string, number]>
          ).map(([label, value]) => (
            <div key={label} className="flex min-w-0 items-baseline justify-between gap-1">
              <dt className="df-label truncate text-[10px] text-ink-dim">{label}</dt>
              <dd className="df-num shrink-0 text-[10px] text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {state.aisCoverage ? (
        <p className="df-num mt-1.5 border-t border-structural pt-1 text-[10px] text-ink-dim">
          AIS {String(state.aisCoverage.state).replace(/_/g, ' ')}
        </p>
      ) : null}
    </div>
  );
}

export type { WorkspaceId };
export { store };