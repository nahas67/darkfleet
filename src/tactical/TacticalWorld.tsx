/**
 * The tactical world.
 *
 * The globe is the primary operating environment, not a background: it fills the
 * viewport and every other surface floats above it. The container owns the
 * engine's lifecycle -- created once, never recreated.
 *
 * If WebGL is unavailable the product says so and offers the data surfaces
 * without the map, rather than showing an empty black rectangle that reads as
 * "no contacts here".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useCoastlineGeometry, useZoneGeometry } from '../globe/maritimeGeometry';

import { engine, type TargetHandle } from '../globe/engine';
import { isLayerId, type LayerId } from '../globe/layerRegistry';
import { isWebGLAvailable } from '../globe/cesiumViewer';
import { store, useStore } from '../state/store';
import { fmt, fmtLatLon } from '../design/format';
import type { PredictedPoint } from '../globe/aisRenderer';
import type { AisObservationOut, VesselTarget } from '../api/contract';

/**
 * Observed track polylines, one per MMSI.
 *
 * Built from the ARCHIVE observations rather than the contact projection: a contact carries only
 * the latest fix, and one point is not a track. A vessel with fewer than two observations
 * contributes no entry, and the renderer drops it again -- stated in both places, because "one
 * point is a track" is exactly the claim DF-X9 section 50 forbids.
 *
 * NOT segmented HERE. The SEGMENTATION HAPPENS IN THE RENDERER, which calls `segmentTrack` and
 * draws observed stretches solid while drawing gaps as a broken connector.
 *
 * An earlier version of this comment said segmentation was deferred to DF-X9.4, and the DF-X9.3D
 * browser E2E then reported a live defect against it: "the track polyline crosses the 3120 s gap
 * unbroken while the contact position correctly refuses to." It was reporting against a build that
 * predated the fix -- a Vite reload had straddled its run -- but the comment was the reason that
 * looked true, and it stayed wrong after the code changed. A comment claiming a defect is unfixed
 * is worse than no comment, because it invites someone to re-report it.
 */
function buildTrackGeometries(
  observations: readonly AisObservationOut[],
): Map<string, Array<{ lat: number; lon: number; at: string }>> {
  const byMmsi = new Map<string, Array<{ lat: number; lon: number; at: string }>>();
  for (const observation of [...observations].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )) {
    const fixes = byMmsi.get(observation.mmsi) ?? [];
    // `at` is carried because the renderer needs it to tell an observed interval from a reporting
    // GAP. Without it the track is one polyline through everything, which is the defect
    // `segmentTrack` exists to prevent.
    fixes.push({ lat: observation.lat, lon: observation.lon, at: observation.timestamp });
    byMmsi.set(observation.mmsi, fixes);
  }
  for (const [mmsi, fixes] of [...byMmsi]) {
    if (fixes.length < 2) byMmsi.delete(mmsi);
  }
  return byMmsi;
}

/**
 * The analytical PREDICTED positions, read from the scan record.
 *
 * `corr.predictedLat` / `predictedLon` are computed by the BACKEND during the scan and persisted
 * with the target. They are read here and nowhere else derived: a client-side projection would be a
 * second prediction competing with the analytical one, and the operator could not tell which they
 * were looking at.
 *
 * This is what finally gives `AIS_PREDICTED` something to draw. The toggle declared
 * `defaultVisibility: true` while its only caller passed `null`, so it read as enabled and rendered
 * nothing -- an inert control, which is the DF-X8 defect class.
 */
function collectPredictedPoints(targets: readonly VesselTarget[]): PredictedPoint[] {
  const points: PredictedPoint[] = [];
  for (const target of targets) {
    const corr = target.corr;
    const lat = corr?.predictedLat;
    const lon = corr?.predictedLon;
    const mmsi = corr?.mmsi;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (typeof mmsi !== 'string' || mmsi === '') continue;
    points.push({ mmsi, lat, lon, atSarTime: '' });
  }
  return points;
}

export type TacticalWorldProps = {
  /** Rendered when WebGL is unavailable, so the failure is legible. */
  fallback?: React.ReactNode;
};

export function TacticalWorld({ fallback }: TacticalWorldProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [webgl] = useState(() => isWebGLAvailable());
  const [initError, setInitError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<TargetHandle | null>(null);

  const state = useStore();
  const targets = state.targets;
  const selection = state.selection;
  const rasterBounds = engine.rasterBounds;

  /*
   * The AIS observation history, handed to the renderer so orientation can use more than one fix.
   * `AisContact` carries only the latest fix per vessel, and DERIVED_TRACK orientation needs two
   * fixes far enough apart to define a bearing.
   */
  useEffect(() => {
    if (!webgl || initError !== null) return;
    const series = new Map<string, AisObservationOut[]>();
    for (const observation of state.aisObservations) {
      const rows = series.get(observation.mmsi) ?? [];
      rows.push(observation);
      series.set(observation.mmsi, rows);
    }
    engine.setAisObservationSeries(series);
  }, [state.aisObservations, webgl, initError]);

  /*
   * Selection and association, forwarded to the renderer.
   *
   * The renderer needs to know these to style the selected contact and to give its label top
   * arbitration priority. Association is EMPHASIS ONLY: a linked AIS vessel is drawn and labelled
   * more prominently, and that is the entire effect. Correlation acceptance is backend-authoritative
   * and is not recomputed here.
   */
  useEffect(() => {
    if (!webgl || initError !== null) return;
    engine.setAisSelection(selection.kind === 'mmsi' ? selection.mmsi : null);
    const associated = (state.targetDetail ?? [])
      .map((t) => t.corr?.mmsi)
      .filter((mmsi): mmsi is string => typeof mmsi === 'string' && mmsi !== '');
    engine.setAssociatedAisMmsis(associated);
  }, [selection, state.targetDetail, webgl, initError]);

  useEffect(() => {
    // Camera telemetry is written to the store so the navigation HUD stays
    // correct through programmatic camera moves.
    engine.onCameraAltitude((metres) => store.set({ cameraAltitude: metres }));
    return () => engine.onCameraAltitude(() => {});
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webgl) return;
    try {
      engine.init(container, {
        onPick: (handle) => setHovered(handle),
        onCursor: (lat, lon) => {
          // Telemetry is written straight to the store, which notifies nothing
          // when the value is unchanged -- so a stationary cursor does not
          // re-render the tree.
          store.set({ cursor: { lat, lon } });
        },
      });
      // 2,400 km at -68 deg: the horizon lands near the top of the frame, so
      // the Earth fills the viewport instead of sitting in a starfield.
      engine.setViewMode('THEATER', 8, 105, 2_400_000);
      setInitError(null);
    } catch (error) {
      // The real reason is surfaced. An earlier revision discarded the exception
      // with `void error`, so a guard tripping on itself was reported to the
      // operator as a missing WebGL context -- a false diagnosis, with nothing in
      // the console to contradict it.
      const message = error instanceof Error ? error.message : String(error);
      console.error('DarkFleet: tactical world failed to initialise', error);
      setInitError(message);
    }
    return () => {
      // The Viewer is intentionally NOT destroyed here: it is created once for
      // the application lifetime. React StrictMode double-invokes effects in
      // development, so destroying on unmount would tear down a live viewer and
      // leave the next mount with no globe.
    };
  }, [webgl]);

  // Targets are pushed to the engine imperatively, never through React state, so
  // a target update cannot re-render the Cesium canvas.
  useEffect(() => {
    if (!webgl || initError !== null) return;
    engine.setTargets(targets, selection.kind === 'target' ? selection.targetId : null);
    engine.setUncertainty(
      targets
        .filter((t) => t.geolocationUncertaintyM !== null && t.geolocationUncertaintyM > 0)
        .map((t) => ({
          id: t.id,
          lat: t.lat,
          lon: t.lon,
          radiusM: t.geolocationUncertaintyM as number,
        })),
    );
    /*
     * AIS CONTACTS, from the archive-derived projection.
     *
     * Every field is passed through. `sog`, `cog` and `heading` used to be dropped here and forced
     * to `null`, which was the reason no contact could be oriented: the types were present and the
     * values were thrown away at the projection boundary, making a vessel that reported nothing
     * indistinguishable from one whose kinematics were never read.
     *
     * The reference instant is the store's explicit temporal authority. It is null when none has
     * been established, which the renderer treats as UNKNOWN freshness rather than as current.
     */
    engine.setAisContacts(
      state.aisOnly.map((contact) => ({
        mmsi: contact.mmsi,
        lat: contact.lat,
        lon: contact.lon,
        sog: contact.sog,
        cog: contact.cog,
        heading: contact.heading,
        timestamp: contact.timestamp,
        shipName: contact.shipName,
      })),
      {
        referenceTimeIso: state.aisReferenceTime,
        observationMarkers: state.aisObservations.map((o) => ({
          mmsi: o.mmsi,
          lat: o.lat,
          lon: o.lon,
          at: o.timestamp,
        })),
        tracks: buildTrackGeometries(state.aisObservations),
        predicted: collectPredictedPoints(state.targetDetail),
      },
    );
    // The setters above CLEAR and re-add their entities, and Cesium gives every new
    // entity `show = true`. Without this the layer toggles would be authoritative only
    // until the next target update, at which point every switched-off layer would
    // reappear. One call per batch keeps the store the single authority.
    engine.refreshLayers();
  }, [
    targets,
    selection,
    state.aisOnly,
    /*
     * THE THREE DEPENDENCIES THAT WERE MISSING, AND WHY EACH ONE MATTERS.
     *
     * This effect READS all three of these and originally declared NONE of them. React's dependency
     * array is not documentation -- it is the list of values whose change re-runs the effect -- so a
     * value read but not listed is read once and then never again when it actually changes.
     *
     *   aisReferenceTime   Set by `loadScanAis`, which is a SEPARATE async call from the one that
     *                     populates `targets`. It arrives after this effect has already run, so
     *                     without it here every contact's freshness was computed against a null
     *                     reference and stayed UNKNOWN forever.
     *
     *   aisObservations    Same separate async path. Without it, the observation markers and the
     *                     track polylines were never built at all: the effect ran once with an empty
     *                     array and was not re-run when 27 rows arrived.
     *
     *   targetDetail       THE ONE THAT BROKE AIS_PREDICTED ENTIRELY. It is populated from the scan
     *                     record's `corr.predictedLat/predictedLon`, on yet another async path, and
     *                     it is RESET to `[]` at the start of a scan load. So the sequence was:
     *                     selection or targets change -> effect runs -> targetDetail still in flight
     *                     -> `collectPredictedPoints` returns [] -> nothing re-runs the effect ->
     *                     the predicted layer can never draw. The layer toggle read as enabled and
     *                     rendered nothing, which is the exact inert-toggle defect DF-X9.3D exists
     *                     to close, re-created one level up in the component tree.
     */
    state.aisReferenceTime,
    state.aisObservations,
    state.targetDetail,
    webgl,
    initError,
  ]);

  // The observed track, split so propagation is visibly a hypothesis.
  const track = state.track;
  useEffect(() => {
    if (!webgl || initError !== null) return;
    /*
     * The dossier's SINGLE-VESSEL track only.
     *
     * The globe-wide track is drawn by `AisContactRenderer`, from `state.aisObservations`, in the
     * renderer's own `PolylineCollection`. Passing it here as well drew the SAME fixes twice -- a
     * green 4 px entity from this path, bound to `AIS_CONTACTS`, and a white 7 px billboard from the
     * renderer, bound to `AIS_TRACKS`. Two markers, two layers, one archive: switching off
     * `AIS_CONTACTS` hid one and left the other behind.
     *
     * So this path exists only for the SELECTED vessel's dossier track, which the renderer does not
     * draw, and `predicted` is still `null` because the analytical predicted geometry comes from
     * the renderer's own collection off the scan record.
     */
    const observed = (track?.observed ?? []).map((fix) => ({ lat: fix.lat, lon: fix.lon }));
    engine.setTrack(observed, null);
    engine.refreshLayers();
  }, [track, webgl, initError]);

  /*
   * Layer visibility, applied from the store.
   *
   * This is the whole path DF-X8 §10 requires: store -> engine -> Cesium. It runs on
   * every change to `state.layerState`, and the registry validates that each id names
   * a layer that exists, so a typo fails here rather than producing a dead control.
   */
  const layerState = state.layerState;
  useEffect(() => {
    if (!webgl || initError !== null) return;
    for (const [id, layer] of Object.entries(layerState)) {
      if (!isLayerId(id)) continue;
      engine.setLayerVisibility(id, layer.visible);
    }
  }, [layerState, webgl, initError]);

  /*
   * MARITIME REFERENCE GEOMETRY (DF-X8.5)
   *
   * The toggle and the fetch are deliberately separate concerns, and the ORDER matters:
   *
   *   1. the geometry hook fetches ONLY when the operator has switched the layer on, so a
   *      default-off reference layer costs no request on load -- 4,133 coastline entities
   *      and 285 EEZ polygons are not free to create;
   *   2. the renderer is called only when geometry actually arrives, because Cesium gives
   *      a new entity `show = true` by default and an unconditional call on every render
   *      would switch a hidden layer back on;
   *   3. `setLayerVisibility` has already run, so the newly created entities inherit the
   *      operator's choice rather than the registry default.
   *
   * The attribution is passed to the renderer so the credit element can show Marine
   * Regions whenever its geometry is on screen. CC BY is a licence obligation, not a
   * courtesy, and an uncredited drawing of a CC BY dataset is a licence failure.
   */
  /**
   * The reason a maritime layer declined to draw, or '' when there is none.
   *
   * ONE FUNCTION, three call sites, because the wording must not vary per layer: an operator
   * reading "EEZ boundaries is unavailable" and "Coastline is unavailable" needs the same
   * information in both, and three hand-built strings would drift.
   *
   * `idle` -- the operator has not switched the layer on -- is NOT a refusal and returns ''. An
   * absent OPTIONAL dataset is not a fault either, so `absent` carries the backend's own reason
   * rather than being folded into the same word.
   */
  const refusalReason = (layer: {
    status: string;
    reason?: string;
  }): string => {
    if (layer.status === 'ready' || layer.status === 'idle') return '';
    const label = layer.status.replace(/_/g, ' ');
    const detail = layer.reason ?? '';
    return detail ? `${label}: ${detail}` : label;
  };

  /*
   * Record or clear a maritime layer's refusal.
   *
   * A refusal that nothing displays is indistinguishable from a broken product, so the
   * reason is written into the store where the layer console can disable the row and state
   * it. `ready` CLEARS rather than leaves: an operator who fixed the cause and switched the
   * layer back on must not still see the stale reason.
   */
  const recordRefusal = useCallback((layerId: LayerId, reason: string | null) => {
    const current = store.getState().maritimeLayerRefusals;
    const has = current[layerId] !== undefined;
    if (reason === null) {
      if (!has) return;
      const { [layerId]: _removed, ...rest } = current;
      store.set({ maritimeLayerRefusals: rest });
      return;
    }
    if (current[layerId] === reason) return;
    store.set({ maritimeLayerRefusals: { ...current, [layerId]: reason } });
  }, []);

  const coastlineVisible = layerState.REFERENCE_COASTLINE?.visible === true;
  const coastline = useCoastlineGeometry(coastlineVisible);
  useEffect(() => {
    const reason = refusalReason(coastline);
    recordRefusal('REFERENCE_COASTLINE', reason === '' ? null : reason);
  }, [recordRefusal, coastline]);

  useEffect(() => {
    if (coastline.status !== 'ready') return;
    engine.setCoastline(
      coastline.lines.map((line) => ({ coordinates: line.coordinates })),
      coastline.provenance?.attribution,
    );
  }, [coastline]);

  const eezVisible = layerState.EEZ_BOUNDARIES?.visible === true;

  /*
   * `AIS_PREDICTED` HONEST AVAILABILITY -- DF-X9.3 section 28.
   *
   * THE DEFECT THIS CLOSES, FOUND BY THE BROWSER: every target in the real archive carries
   * `corr.predictedLat = null`, because no archived detection was ever associated with a vessel. The
   * layer declared `defaultVisibility: true` and its toggle read as enabled while it could draw
   * nothing -- an inert control, which is the DF-X8 defect class DF-X9.3 set out to eliminate.
   *
   * Repairing the WIRING was necessary but not sufficient: the wiring now works, and there is still
   * nothing to draw. That is a DIFFERENT reason and needs a different response, which is why this is
   * a separate effect from the one that draws the contacts.
   *
   * So the layer REPORTS that no analytical prediction exists, through the same refusal channel the
   * maritime layers use. The console disables the row and states the reason verbatim, rather than
   * showing an enabled switch over an empty globe with no explanation anywhere.
   *
   * The reason names the CAUSE -- an association is what produces a predicted position -- so the
   * operator is not left deciding whether the layer is broken or merely has no inputs. `null` CLEARS
   * the refusal, so an operator who loads an associated scan sees the layer become available.
   */
  useEffect(() => {
    const predictedCount = collectPredictedPoints(state.targetDetail).length;
    recordRefusal(
      'AIS_PREDICTED',
      predictedCount === 0
        ? 'No predicted position exists. A predicted position requires a detection correlated to an '
          + 'AIS vessel, and this scan has no such association, so the backend propagated nothing.'
        : null,
    );
  }, [recordRefusal, state.targetDetail]);

  const eez = useZoneGeometry('EEZ_BOUNDARIES', eezVisible);
  useEffect(() => {
    const reason = refusalReason(eez);
    recordRefusal('EEZ_BOUNDARIES', reason === '' ? null : reason);
  }, [recordRefusal, eez]);

  useEffect(() => {
    if (eez.status !== 'ready') return;
    engine.setZoneBoundaries(
      eez.polygons.map((polygon) => ({
        parts: polygon.parts.map((part) => ({ coordinates: part.coordinates })),
        holes: (polygon.holes ?? []).map((hole) => ({ coordinates: hole.coordinates })),
        disputed: polygon.disputed === true,
        geoname: polygon.geoname ?? null,
        pol_type: polygon.pol_type ?? null,
      })),
      'EEZ_BOUNDARIES',
      eez.provenance?.attribution,
    );
  }, [eez]);

  const highSeasVisible = layerState.HIGH_SEAS?.visible === true;
  const highSeas = useZoneGeometry('HIGH_SEAS', highSeasVisible);
  useEffect(() => {
    const reason = refusalReason(highSeas);
    recordRefusal('HIGH_SEAS', reason === '' ? null : reason);
  }, [recordRefusal, highSeas]);

  useEffect(() => {
    if (highSeas.status !== 'ready') return;
    engine.setZoneBoundaries(
      highSeas.polygons.map((polygon) => ({
        parts: polygon.parts.map((part) => ({ coordinates: part.coordinates })),
        disputed: false,
        geoname: polygon.geoname ?? null,
      })),
      'HIGH_SEAS',
      highSeas.provenance?.attribution,
    );
  }, [highSeas]);

  if (!webgl || initError !== null) {
    return (
      <div
        className="absolute inset-0 grid place-items-center"
        role="status"
        aria-live="polite"
      >
        <div className="df-clipped df-panel max-w-md p-6 text-center">
          <p className="df-label mb-2">Tactical world unavailable</p>
          <p className="text-[12px] leading-relaxed text-ink-2">
            {webgl
              ? initError
              : 'This browser did not provide a WebGL context, so the globe cannot be drawn.'}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-dim">
            Target, AIS and evidence data remain available in the workspace.
          </p>
          {fallback}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        className="h-full w-full"
        data-df-globe
        role="application"
        aria-label="Tactical globe. SAR detections, AIS contacts and the active area of interest. Use the contact list for a keyboard-navigable equivalent."
      />
      {hovered ? <TargetHoverHud handle={hovered} rasterBounds={rasterBounds} /> : null}
    </div>
  );
}

/**
 * Compact hover readout.
 *
 * Deliberately small. The retired UI's instinct was a large card; on a globe
 * that obscures the thing under the pointer and forces the operator to move the
 * cursor away to read it.
 */
function TargetHoverHud({
  handle,
  rasterBounds,
}: {
  handle: TargetHandle;
  rasterBounds: { west: number; south: number; east: number; north: number } | null;
}) {
  const insideRaster =
    rasterBounds !== null &&
    handle.lat >= rasterBounds.south &&
    handle.lat <= rasterBounds.north &&
    handle.lon >= rasterBounds.west &&
    handle.lon <= rasterBounds.east;

  return (
    <div
      className="df-clipped df-panel pointer-events-none absolute left-3 top-3 px-2.5 py-2"
      data-df-target-hover
      role="tooltip"
    >
      <p className="df-mono text-[11px] text-ink">{handle.id}</p>
      <p className="df-label mt-0.5 text-[10px]">{handle.classification.replace(/_/g, ' ')}</p>
      <p className="df-num mt-1 text-ink-2">{fmtLatLon(handle.lat, handle.lon, 4)}</p>
      <p className="df-num mt-0.5 text-ink-dim">
        AIS {handle.mmsi ? fmt(handle.mmsi) : 'no association'}
      </p>
      {rasterBounds ? (
        <p className="df-num mt-0.5 text-ink-dim">
          {insideRaster ? 'inside SAR raster' : 'outside SAR raster'}
        </p>
      ) : null}
    </div>
  );
}