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

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { loadDatasetHealth, loadProviders, loadRaster } from '../api/client';
import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';
import { OperationRail, type WorkspaceId } from './OperationRail';
import { TopStrip } from './TopStrip';
import { useGlobalKeys } from './useGlobalKeys';
import { TacticalWorld } from '../tactical/TacticalWorld';
import { MissionTimeline } from '../timeline/MissionTimeline';
import { AisPlaybackBar } from '../temporal/AisPlaybackBar';
import { buildTrack } from '../temporal/trackBuilder';
import { frameTrack, pointsOfSegments } from '../temporal/framing';
import { ContactList } from '../contacts/ContactList';
import { DossierWorkspace } from '../dossier/DossierWorkspace';
import { LayerConsole } from '../sensors/LayerConsole';
import { ScanWorkflow } from '../missions/ScanWorkflow';
import { SceneBrowser } from '../scenes/SceneBrowser';
import { SystemPanel } from '../command/SystemPanel';
import { ReportsWorkspace } from '../reports/ReportsWorkspace';
import { AnalyticsWorkspace } from '../analytics/AnalyticsWorkspace';
import { AdvancedWorkspace } from '../intelligence/AdvancedWorkspace';
import { UnifiedSearch } from '../search/UnifiedSearch';

export function DarkFleetCommandApp() {
  const state = useStore();
  /*
   * THE AIS FACTS THE PLAYBACK BAR SHOWS, DERIVED FROM THE ARCHIVE ONCE.
   *
   * Counts and gaps come from `buildTrack` rather than from the bar computing them, so the numbers on
   * screen and the model the renderer draws cannot disagree. `gapSeconds` is the SUM over gaps, which
   * is the figure an operator actually wants -- "4 gaps, 3,120 s of missing reporting" -- rather than a
   * count that reads like everything is fine.
   */
  const aisTrack = useMemo(() => buildTrack(state.aisObservations), [state.aisObservations]);
  const aisObservationsPresent = aisTrack.usableCount > 0;
  const aisObservationCount = aisTrack.usableCount;
  const aisTrackStatus = aisTrack.status;
  const aisGapCount = aisTrack.segments.filter((s) => s.kind === 'GAP').length;
  const aisGapSeconds = useMemo(() => {
    const spans = aisTrack.segments
      .filter((s) => s.kind === 'GAP')
      .map((s) => s.spanSeconds)
      .filter((v): v is number => v !== null);
    return spans.length > 0 ? spans.reduce((a, b) => a + b, 0) : null;
  }, [aisTrack]);

  /*
   * FRAME TRACK, ONE SHOT.
   *
   * Frames every segment point, so a track that crosses the antimeridian is framed on its SHORT
   * extent rather than on a 359-degree box. It is a single camera move: no subscription to the
   * playhead, because continuous follow is DF-X9.6's scope and a one-shot fit that quietly became
   * follow would take the camera away without anyone deciding to.
   */
  const aisCanFrame = aisTrack.segments.some((s) => s.points.length >= 2);
  const aisFrameTrack = useCallback(() => {
    const points = pointsOfSegments(aisTrack.segments);
    if (points.length === 0) return;
    frameTrack(
      (lat, lon, halfHeightDeg, halfWidthDeg) => {
        engine.flyToBbox([
          lon - halfWidthDeg,
          lat - halfHeightDeg,
          lon + halfWidthDeg,
          lat + halfHeightDeg,
        ]);
      },
      { points },
    );
  }, [aisTrack]);

  const workspaceRef = useRef<HTMLDivElement | null>(null);

  useGlobalKeys();

  // Provider health is probed once on mount and re-probed on demand. A failed
  // probe is an explicit state, never an implied "online".
  useEffect(() => {
    void loadProviders();
  /*
   * The ONE dataset-health fetch, beside the one provider-health fetch.
   *
   * Two panels read `/api/maritime/datasets`: the layer console, to decide whether a maritime
   * layer is drawable, and the system panel, to render the list. Loading it here rather than
   * in a hook per panel is what makes them agree -- as two hook instances they could show the
   * console disabled while the panel rendered the data, which the DF-X8.5 browser E2E caught.
   */
  void loadDatasetHealth();
  }, []);

  // The raster is attached to the measured rectangle the backend reports. It is
  // deliberately not re-fetched here on every render.
  useEffect(() => {
    const scanId = state.scanId;
    if (!scanId || state.scanStage !== 'COMPLETE') return;

    // Guard the effect itself rather than checking `cancelled` after an await:
    // StrictMode double-invokes the effect, and the first invocation had already
    // issued its request by the time the cleanup ran, so the metadata endpoint was
    // fetched twice per scan.
    let cancelled = false;
    void (async () => {
      const result = await loadRaster(scanId, 'raw');
      if (cancelled || !result) return;
      // Report what actually happened. `rasterLoaded` describes a layer on the
      // globe, not a metadata response that was received.
      const attached = engine.setRaster(result.imageUrl, result.rectangle, {
        width: result.width,
        height: result.height,
      });
      // The scene footprint is the MEASURED extent the raster was rendered
      // over -- not the requested AOI. Those differ whenever the window was
      // clamped, which is exactly the GEO-CORR defect in visual form.
      engine.setSceneFootprint([
        result.rectangle.west,
        result.rectangle.south,
        result.rectangle.east,
        result.rectangle.north,
      ]);
      store.set({
        rasterLoaded: attached,
        rasterError: attached
          ? null
          : 'The raster layer could not be added to the globe. See the browser console.',
      });
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
          // ANALYTICS needs room for a layer strip, a raster, a table and two
          // side panels. At the default 320px the raster collapsed to zero height
          // and the panels overlapped, so this workspace gets the width its
          // content requires. Every other workspace keeps the standard rail-width
          // panel.
          className={
            activeWorkspace === 'ANALYTICS'
              ? 'relative z-30 flex w-[min(68rem,72vw)] shrink-0 flex-col border-l border-structural bg-base/85 backdrop-blur-sm'
              : activeWorkspace === 'INTELLIGENCE'
                /*
                 * The dossier carries an eleven-tab strip, a two-column header, wide
                 * score and observation tables and a provenance drawer. At the 320px
                 * default those tables wrap per-character and the score decomposition
                 * becomes unreadable, so this workspace is given the width its content
                 * requires -- but bounded against the viewport so the globe is never
                 * squeezed out of existence. The `min()` is doing real work here: an
                 * unbounded width would simply take the whole screen at 1920 and leave
                 * no globe at all, which is a different failure from a cramped one.
                 */
                ? 'relative z-30 flex w-[min(58rem,62vw)] shrink-0 flex-col border-l border-structural bg-base/85 backdrop-blur-sm'
                : 'relative z-30 flex w-80 shrink-0 flex-col border-l border-structural bg-base/85 backdrop-blur-sm xl:w-96'
          }
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
            /*
             * The dossier replaces TargetIntel here. TargetIntel's five tabs are a
             * subset of what the dossier now answers, and keeping both would leave two
             * surfaces disagreeing about the same target -- the exact duplication this
             * checkpoint exists to remove. ContactList is retained because it is the
             * other way to change the single global selection, not part of the dossier.
             */
            <>
              <div className="min-h-0 flex-[3] overflow-hidden border-b border-structural">
                <DossierWorkspace />
              </div>
              <div className="min-h-0 flex-[2] overflow-hidden">
                <ContactList />
              </div>
            </>
          ) : null}
          {activeWorkspace === 'TASKING' ? <ScanWorkflow /> : null}
          {activeWorkspace === 'LAYERS' ? <LayerConsole /> : null}
          {activeWorkspace === 'ANALYTICS' ? <AnalyticsWorkspace /> : null}
          {activeWorkspace === 'ADVANCED' ? <AdvancedWorkspace bbox={state.aoi} /> : null}
          {activeWorkspace === 'REPORTS' ? <ReportsWorkspace /> : null}
          {activeWorkspace === 'SYSTEM' ? <SystemPanel /> : null}
        </aside>

      </div>

      <MissionTimeline />
      {/*
       * AIS PLAYBACK, BESIDE THE TIMELINE RATHER THAN INSIDE A DOSSIER.
       *
       * It sits on the same row because both read the SAME authority. Buried in a dossier tab the
       * playhead would be readable only there while the globe showed the previous instant -- the
       * second-timeline defect DF-X9.4 section 38 forbids.
       *
       * Rendered only when usable AIS observations exist, so a scan with no AIS archive shows nothing
       * rather than a disabled strip implying a feed that was never configured.
       */}
      {aisObservationsPresent ? (
        <AisPlaybackBar
          observationCount={aisObservationCount}
          trackStatus={aisTrackStatus}
          gapCount={aisGapCount}
          gapSeconds={aisGapSeconds}
          canFrame={aisCanFrame}
          onFrameTrack={aisFrameTrack}
        />
      ) : null}
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