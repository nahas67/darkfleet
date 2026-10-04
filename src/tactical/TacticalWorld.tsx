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

import { useEffect, useRef, useState } from 'react';

import { engine, type TargetHandle } from '../globe/engine';
import { isLayerId } from '../globe/layerRegistry';
import { isWebGLAvailable } from '../globe/cesiumViewer';
import { store, useStore } from '../state/store';
import { fmt, fmtLatLon } from '../design/format';

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
    // AIS-only contacts, from real delivered state.
    engine.setAisContacts(
      state.aisOnly.map((contact) => ({ mmsi: contact.mmsi, lat: contact.lat, lon: contact.lon })),
    );
    // The setters above CLEAR and re-add their entities, and Cesium gives every new
    // entity `show = true`. Without this the layer toggles would be authoritative only
    // until the next target update, at which point every switched-off layer would
    // reappear. One call per batch keeps the store the single authority.
    engine.refreshLayers();
  }, [targets, selection, state.aisOnly, webgl, initError]);

  // The observed track, split so propagation is visibly a hypothesis.
  const track = state.track;
  useEffect(() => {
    if (!webgl || initError !== null) return;
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