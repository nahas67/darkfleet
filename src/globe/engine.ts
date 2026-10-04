/**
 * The tactical world.
 *
 * One Cesium Viewer for the lifetime of the application. It is created once and
 * never recreated: recreating a Viewer leaks a WebGL context, and browsers cap
 * those at roughly 16. The retired UI got this right by accident; here it is a
 * stated invariant with a guard.
 *
 * Three responsibilities, kept apart:
 *   engine  -- camera, viewer lifecycle, layer ownership
 *   symbology (design/symbology.ts) -- what a mark looks like
 *   scanLayers (globe/scanLayers.ts) -- how a mark is built from a target
 *
 * Nothing here reads React state. The engine is driven by explicit calls, so a
 * panel re-render cannot cause a globe rebuild.
 */

import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  GridImageryProvider,
  Ellipsoid,
  HeadingPitchRange,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SingleTileImageryProvider,
  type Viewer,
} from 'cesium';

import { initializeCesiumViewer, type BasemapHandle } from './cesiumViewer';
import { defaultLayerState, getLayer, type LayerId } from './layerRegistry';
import type { MapSourceStatus } from './MapSourceController';
import { classificationColor } from '../design/tokens';
import { toBBox, type BBox, type SarTarget, type ViewMode } from '../state/store';

const TARGET_LAYER = 'targets';
const RASTER_LAYER = 'sar-raster';

export type TargetHandle = {
  id: string;
  position: Cartesian3;
  /** Screen-space pixel position, refreshed per frame for the hover HUD. */
  screen: Cartesian2;
  classification: string;
  mmsi: string | null;
  lat: number;
  lon: number;
};

export type EngineCallbacks = {
  onPick?: (target: TargetHandle | null) => void;
  onCursor?: (lat: number, lon: number) => void;
};

export class TacticalEngine {
  #viewer: Viewer | null = null;
  #container: HTMLElement | null = null;
  #callbacks: EngineCallbacks = {};
  #rasterProvider: SingleTileImageryProvider | null = null;
  /**
   * The raster's ImageryLayer handle.
   *
   * Previously only the provider was kept, so the raster could be added and removed
   * but never shown or hidden without destroying and rebuilding it. Toggling a layer
   * must not re-request the image.
   */
  #rasterLayer: ImageryLayer | null = null;
  /**
   * Layer visibility, the engine's copy of the single authority in the store.
   *
   * Applied to real Cesium objects by `#syncLayerVisibility`. This exists so a toggle
   * has a visible effect on objects that are ALREADY on the globe -- previously ten
   * of eleven controls had no way to reach a renderer at all.
   */
  #layerVisible: Map<string, boolean> = new Map(
    Object.entries(defaultLayerState()).map(([id, s]) => [id, s.visible]),
  );
  #rasterRectangle: { west: number; south: number; east: number; north: number } | null = null;
  #targetEntities = new Map<string, { entity: unknown; handle: TargetHandle }>();
  #trackEntities: Array<unknown> = [];
  #linkEntities: Array<unknown> = [];
  /**
   * Detection-uncertainty circles.
   *
   * Separate from `#linkEntities` on purpose -- see `setUncertainty`. Sharing one
   * array made the two layers overwrite each other.
   */
  #uncertaintyEntities: Array<unknown> = [];
  #aoiEntity: unknown = null;
  #graticuleProvider: ImageryLayer | null = null;
  #footprintEntity: unknown = null;
  #aisEntities: Array<unknown> = [];
  #handler: ScreenSpaceEventHandler | null = null;
  #hovered: string | null = null;
  /** Live basemap ownership, or null before init. */
  #basemap: BasemapHandle | null = null;
  /** Recovery-probe interval. Cleared on dispose. */
  #basemapTimer: number | null = null;

  get initialised(): boolean {
    return this.#viewer !== null;
  }

  /**
   * Create the Viewer, or return the existing one.
   *
   * Idempotent by design. React StrictMode double-invokes mount effects in
   * development, and this function previously threw on the second call -- which
   * the caller caught and reported as "no WebGL context" while a perfectly good
   * context was in use. The globe was destroyed by its own guard.
   *
   * Returning the existing viewer is the correct response: the invariant being
   * protected is "exactly one Viewer", and returning it preserves that. Creating
   * a second would exhaust WebGL contexts, so that still cannot happen.
   */
  init(container: HTMLElement, callbacks: EngineCallbacks = {}): Viewer {
    if (this.#viewer) {
      // Refresh the callbacks so a remount is not left holding stale closures.
      this.#callbacks = callbacks;
      this.#container = container;
      return this.#viewer;
    }
    this.#container = container;
    this.#callbacks = callbacks;

    /*
     * The ion token is read from the environment rather than hardcoded to ''.
     *
     * This line used to be `Ion.defaultAccessToken = ''`, unconditionally, immediately
     * before creating the viewer -- which made the `ionToken` parameter of
     * `initializeCesiumViewer` dead code. Any configured Cesium ion account was
     * silently ignored.
     *
     * Absent a token the keyless OpenStreetMap source is used and the globe opens
     * normally: no credential is required to start (§27).
     */
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const ionToken = env?.VITE_CESIUM_ION_TOKEN;

    const viewer = initializeCesiumViewer({ container, ionToken });
    viewer.scene.globe.depthTestAgainstTerrain = false;
    this.#viewer = viewer;
    this.#basemap = viewer.basemap ?? null;

    /*
     * Recovery probe.
     *
     * A provider that failed is retried only after the controller's cooldown, so a
     * flapping source cannot swap the basemap repeatedly. The interval is shorter than
     * the cooldown, which means the probe simply finds itself not yet eligible -- the
     * controller owns the timing, this only provides the tick.
     */
    this.#basemapTimer = window.setInterval(() => {
      if (!this.#basemap) return;
      const before = this.#basemap.status().activeId;
      const after = this.#basemap.controller.maybeRecover();
      if (after.activeId !== before) {
        this.#applyBasemapSource();
        this.#basemap.syncCredit();
      }
    }, 15_000);

    this.#handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.#installPicking();
    this.#installCameraTelemetry(viewer);

    return viewer;
  }

  /**
   * Push the controller's active source onto the globe.
   *
   * Delegates to the basemap handle, which owns the imagery layer bookkeeping -- the
   * listener detach, the old layer removal and the new layer addition all live in one
   * place. Duplicating that here is how a second basemap layer accumulates.
   *
   * The camera, selection, overlays, timeline and workspace are untouched: only
   * `imageryLayers` changes, which is why fallback cannot disturb analytical geometry.
   */
  #applyBasemapSource(): void {
    this.#basemap?.applyActive();
  }

  /**
   * The live basemap status, for the system panel.
   *
   * Source HEALTH and the ACTIVE source are separate facts and are reported as
   * separate fields. A provider can be UNAVAILABLE while a DIFFERENT one is active,
   * and collapsing those into one label is exactly the confusion §26 forbids.
   */
  basemapStatus(): MapSourceStatus | null {
    return this.#basemap?.status() ?? null;
  }

  /* ----------------------------------------------------------- lifecycle */

  /**
   * Release everything this engine owns.
   *
   * Explicit rather than relying on garbage collection: Cesium holds GPU
   * resources, and an entity left registered keeps its geometry alive.
   */
  dispose(): void {
    this.#handler?.destroy();
    this.#handler = null;
    this.#targetEntities.clear();
    this.#trackEntities = [];
    this.#linkEntities = [];
    this.#uncertaintyEntities = [];
    this.#rasterProvider = null;
    this.#rasterLayer = null;

    // The recovery probe must stop, or it keeps calling into a disposed controller.
    if (this.#basemapTimer !== null) {
      window.clearInterval(this.#basemapTimer);
      this.#basemapTimer = null;
    }
    // Detaches the provider error listener and removes the basemap imagery layer
    // before the viewer goes away.
    this.#basemap?.dispose();
    this.#basemap = null;

    this.#viewer = null;
  }

  get viewer(): Viewer | null {
    return this.#viewer;
  }

  /**
   * Publish camera altitude whenever the camera settles.
   *
   * Driven by Cesium's own change event rather than by pointer movement, so a
   * programmatic fly (frame detections, fly-to, reset camera) updates the readout
   * too. Previously the HUD showed whatever altitude the pointer last implied,
   * which went stale the moment the camera moved without a mouse.
   */
  /**
   * Toggle the graticule.
   *
   * Implemented rather than declared: the layer console offered GRATICULE as an
   * enabled toggle that drew nothing, which is the "enabled control for
   * unavailable functionality" the product forbids. A graticule is genuinely
   * useful on a maritime console for reading a position off the globe, so it is
   * worth having for real.
   */
  setGraticule(visible: boolean): void {
    const viewer = this.#viewer;
    if (!viewer) return;

    if (!visible) {
      if (this.#graticuleProvider) {
        try {
          viewer.imageryLayers.remove(this.#graticuleProvider, true);
        } catch {
          /* already removed */
        }
        this.#graticuleProvider = null;
      }
      return;
    }
    if (this.#graticuleProvider) return;

    try {
      this.#graticuleProvider = viewer.imageryLayers.addImageryProvider(
        new GridImageryProvider({
          // 10 lines per hemisphere: coarse enough to stay legible under
          // symbology, fine enough to read a tenth of a degree off the globe.
          cells: 18,
          color: Color.fromCssColorString('#5C6E63').withAlpha(0.5),
          glowColor: Color.fromCssColorString('#5C6E63').withAlpha(0.12),
          glowWidth: 2,
          backgroundColor: Color.TRANSPARENT,
        }),
      );
    } catch (error) {
      console.error('DarkFleet: graticule layer was not added', error);
      this.#graticuleProvider = null;
    }
  }

  get graticuleVisible(): boolean {
    return this.#graticuleProvider !== null;
  }

  /**
   * Scene footprint for the acquisition a scan read.
   *
   * Drawn from the scene's own recorded bounds. If those bounds cannot be
   * validated, nothing is drawn rather than an approximate rectangle: a
   * footprint is a statement about where the radar looked.
   */
  setSceneFootprint(bbox: readonly number[] | null | undefined): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    if (this.#footprintEntity) {
      try {
        viewer.entities.remove(this.#footprintEntity as never);
      } catch {
        /* already gone */
      }
      this.#footprintEntity = null;
    }
    const box = toBBox(bbox);
    if (!box) return;
    const [minLon, minLat, maxLon, maxLat] = box;
    this.#footprintEntity = viewer.entities.add({
      name: 'scene-footprint',
      polygon: {
        hierarchy: [
          Cartesian3.fromDegrees(minLon, minLat),
          Cartesian3.fromDegrees(maxLon, minLat),
          Cartesian3.fromDegrees(maxLon, maxLat),
          Cartesian3.fromDegrees(minLon, maxLat),
        ],
        // Outlined only. A filled footprint would sit over the imagery it is
        // meant to describe.
        material: Color.TRANSPARENT,
        outline: true,
        outlineColor: Color.fromCssColorString('#3FA9C4').withAlpha(0.9),
        height: 0,
      },
    });
  }

  /**
   * AIS-only contacts: vessels transmitting with no radar return beside them.
   *
   * A separate layer from AIS_TRACKS because the two answer different questions.
   * An AIS-only contact is an open question about coverage and detection
   * threshold, not a finding about the vessel.
   */
  setAisContacts(
    contacts: ReadonlyArray<{ mmsi: string; lat: number; lon: number }>,
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    for (const entity of this.#aisEntities) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already gone */
      }
    }
    this.#aisEntities = [];
    for (const contact of contacts) {
      if (!Number.isFinite(contact.lat) || !Number.isFinite(contact.lon)) continue;
      this.#aisEntities.push(
        viewer.entities.add({
          name: `ais:${contact.mmsi}`,
          position: Cartesian3.fromDegrees(contact.lon, contact.lat),
          point: {
            pixelSize: 8,
            color: Color.fromCssColorString('#3FA9C4').withAlpha(0.75),
            outlineColor: Color.fromCssColorString('#040705'),
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: contact.mmsi,
            font: '10px "JetBrains Mono", monospace',
            fillColor: Color.fromCssColorString('#3FA9C4'),
            outlineColor: Color.fromCssColorString('#040705'),
            outlineWidth: 2,
            pixelOffset: new Cartesian2(11, -11),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
  }

  /**
   * Correlation links: detection to the AIS position propagated to acquisition time.
   *
   * Drawn ONLY for an actual association, and only when both ends are
   * placeable. A line to a position the product did not compute would be a
   * fabricated relationship.
   */
  setCorrelationLinks(
    entries: ReadonlyArray<{
      id: string;
      lat: number;
      lon: number;
      predictedLat: number;
      predictedLon: number;
    }>,
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    for (const entity of this.#linkEntities) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already gone */
      }
    }
    this.#linkEntities = [];
    for (const entry of entries) {
      if (![entry.lat, entry.lon, entry.predictedLat, entry.predictedLon].every((v) =>
        Number.isFinite(v),
      )) {
        continue;
      }
      this.#linkEntities.push(
        viewer.entities.add({
          name: `link:${entry.id}`,
          polyline: {
            positions: new ConstantProperty([
              Cartesian3.fromDegrees(entry.lon, entry.lat, 0),
              Cartesian3.fromDegrees(entry.predictedLon, entry.predictedLat, 0),
            ]),
            width: new ConstantProperty(1.5),
            material: new ColorMaterialProperty(
              Color.fromCssColorString('#7C6BB0').withAlpha(0.75),
            ),
            clampToGround: new ConstantProperty(false),
          },
        }),
      );
    }
  }

  #installCameraTelemetry(viewer: Viewer): void {
    // Plausibility bound. Cesium reports a finite height in every frame, but a
    // transient during teardown or a stalled flight produced a value ~10^11 m,
    // which was rendered verbatim. The scene's own zoom clamp is 500..30,000,000
    // m, so anything outside that is not a camera position.
    const MIN_ALT = 1;
    const MAX_ALT = 40_000_000;
    const publish = () => {
      const carto = Cartographic.fromCartesian(viewer.camera.positionWC);
      const height = carto.height;
      if (!Number.isFinite(height) || height < MIN_ALT || height > MAX_ALT) {
        this.#onCameraAltitude?.(null);
        return;
      }
      this.#onCameraAltitude?.(height);
    };
    // `moveEnd` is the settle signal; `changed` alone leaves the resting
    // altitude unpublished because the final frames move less than
    // percentageChanged (0.5% of camera height).
    viewer.camera.changed.addEventListener(publish);
    viewer.camera.moveEnd.addEventListener(publish);
    publish();
  }

  #onCameraAltitude: ((metres: number | null) => void) | null = null;

  /** Called by the shell so camera telemetry reaches the store. */
  onCameraAltitude(handler: (metres: number | null) => void): void {
    this.#onCameraAltitude = handler;
    handler(this.cameraAltitude());
  }

  /* --------------------------------------------------------- interaction */

  #installPicking(): void {
    const handler = this.#handler;
    const viewer = this.#viewer;
    if (!handler || !viewer) return;

    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.position);
      const entity = picked?.id as { name?: string } | undefined;
      const id = entity?.name?.startsWith('target:') ? entity.name.slice('target:'.length) : null;
      const found = id ? (this.#targetEntities.get(id)?.handle ?? null) : null;
      this.#callbacks.onPick?.(found);
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Hover is tracked so the HUD can show a compact target readout. It is not a
    // selection: clicking is selection.
    handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.endPosition);
      const entity = picked?.id as { name?: string } | undefined;
      const id = entity?.name?.startsWith('target:') ? entity.name.slice('target:'.length) : null;
      if (id !== this.#hovered) {
        this.#hovered = id;
        const handle = id ? this.#targetEntities.get(id)?.handle : undefined;
        this.#callbacks.onPick?.(handle ?? null);
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    // Cursor coordinate telemetry. The globe is the primary surface, so the
    // operator should always be able to read where the pointer is.
    const handler2 = handler;
    handler2.setInputAction((movement: { endPosition: Cartesian2 }) => {
      const viewer2 = this.#viewer;
      if (!viewer2) return;
      const cartesian = viewer2.camera.pickEllipsoid(
        movement.endPosition,
        Ellipsoid.WGS84,
        new Cartesian3(),
      );
      if (!cartesian) return;
      const carto = Cartographic.fromCartesian(cartesian);
      this.#callbacks.onCursor?.(
        CesiumMath.toDegrees(carto.latitude),
        CesiumMath.toDegrees(carto.longitude),
      );
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  /* -------------------------------------------------------------- camera */

  /**
   * Fly to a position.
   *
   * Duration is fixed and short. A long cinematic flight on every selection is
   * the single most common way a map becomes annoying to use: the operator has
   * to wait to look at the next thing.
   */
  flyTo(lat: number, lon: number, altitude = 450_000, duration = 1.4): void {
    const viewer = this.#viewer;
    if (!viewer || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, altitude),
      duration,
    });
  }

  /** Frame a bounding box, choosing an altitude that actually contains it. */
  flyToBbox(bbox: BBox, duration = 1.4): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    // A very small AOI must still leave the camera above the surface, so the
    // offset range is floored rather than allowed to collapse to zero.
    const span = Math.max(Math.abs(maxLat - minLat), Math.abs(maxLon - minLon));
    const altitude = Math.max(25_000, span * 111_320 * 2.2);
    viewer.camera.flyToBoundingSphere(boundingSphereOf(bbox), {
      duration,
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-55), altitude),
    });
  }

  resetCamera(duration = 1.6): void {
    this.flyTo(12, 100, 24_000_000, duration);
  }

  /**
   * Apply a named view mode.
   *
   * Each mode is expressed as a heading/pitch pair rather than a separate camera
   * implementation, so switching modes cannot desynchronise the target the
   * operator was already looking at.
   */
  setViewMode(mode: ViewMode, lat = 8, lon = 105, altitude = 2_400_000): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    // Every pitch must stay INSIDE the horizon cone at the mode's altitude, or
    // the camera looks past the limb and renders empty space. The horizon dip is
    // acos(R / (R + h)): 65.5 deg at 9,000 km, 60.4 deg at 3,000 km. Each pitch
    // below keeps clear of that boundary.
    const orientations: Record<ViewMode, { heading: number; pitch: number }> = {
      GLOBAL: { heading: 0, pitch: CesiumMath.toRadians(-89) },
      // Steep enough that the horizon sits near the top of the frame and the
      // Earth fills the viewport. The globe is the operating environment here,
      // not a backdrop: at -45 deg it occupied only ~38% of the canvas.
      THEATER: { heading: CesiumMath.toRadians(-12), pitch: CesiumMath.toRadians(-68) },
      TOP_DOWN: { heading: 0, pitch: CesiumMath.toRadians(-90) },
      OBLIQUE: { heading: CesiumMath.toRadians(-35), pitch: CesiumMath.toRadians(-40) },
      NORTH_UP: { heading: 0, pitch: CesiumMath.toRadians(-78) },
    };
    const { heading, pitch } = orientations[mode];
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, altitude),
      orientation: { heading, pitch, roll: 0 },
      duration: 1.5,
    });
  }

  /** Camera altitude in metres, for the navigation HUD. */
  cameraAltitude(): number | null {
    const viewer = this.#viewer;
    if (!viewer) return null;
    const carto = Cartographic.fromCartesian(viewer.camera.positionWC);
    return Number.isFinite(carto.height) ? carto.height : null;
  }

  /* -------------------------------------------------------------- targets */

  /**
   * Replace the target layer.
   *
   * Rebuild-not-diff, deliberately: a scan produces at most a few hundred
   * detections, and a diffing layer is a correctness risk (a removed target
   * leaving a mark behind) for no measurable gain at this scale.
   */
  setTargets(targets: readonly SarTarget[], selectedId: string | null): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    for (const { entity } of this.#targetEntities.values()) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already gone */
      }
    }
    this.#targetEntities.clear();

    for (const target of targets) {
      if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) continue;
      // The unset sentinel (0, 0) is in the Gulf of Guinea and would render as a
      // real contact. A target with no position is not drawn.
      if (target.lat === 0 && target.lon === 0) continue;

      const selected = target.id === selectedId;
      const color = Color.fromCssColorString(
        classificationColor[target.classification] ?? '#8FA396',
      );
      const entity = viewer.entities.add({
        name: `target:${target.id}`,
        position: Cartesian3.fromDegrees(target.lon, target.lat),
        point: {
          pixelSize: selected ? 15 : 10,
          color: color.withAlpha(selected ? 1.0 : 0.92),
          outlineColor: selected
            ? Color.fromCssColorString('#D8E4DC')
            : Color.fromCssColorString('#040705'),
          outlineWidth: selected ? 2.5 : 1.5,
          // Marks stay findable behind headlands. An operator must always be able
          // to see that something was detected.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          // The label is the id and nothing else. No name, no class, no identity:
          // the globe asserts a position and an id, never a conclusion.
          text: target.id,
          font: '11px "JetBrains Mono", monospace',
          fillColor: Color.fromCssColorString(selected ? '#D8E4DC' : '#8FA396'),
          outlineColor: Color.fromCssColorString('#040705'),
          outlineWidth: 2,
          style: 0,
          pixelOffset: new Cartesian2(12, -12),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });

      this.#targetEntities.set(target.id, {
        entity,
        handle: {
          id: target.id,
          position: Cartesian3.fromDegrees(target.lon, target.lat),
          screen: new Cartesian2(),
          classification: target.classification,
          mmsi: target.mmsi,
          lat: target.lat,
          lon: target.lon,
        },
      });
    }
  }

  /** Bearing and range from the camera to a target, for the navigation HUD. */
  targetBearingAndRange(
    targetId: string,
  ): { bearingDeg: number; rangeM: number } | null {
    const viewer = this.#viewer;
    const entry = this.#targetEntities.get(targetId);
    if (!viewer || !entry) return null;
    const camera = Cartographic.fromCartesian(viewer.camera.positionWC);
    const target = Cartographic.fromCartesian(entry.handle.position);
    const range = Cartesian3.distance(viewer.camera.positionWC, entry.handle.position);
    const dLon = target.longitude - camera.longitude;
    const y = Math.sin(dLon) * Math.cos(target.latitude);
    const x =
      Math.cos(camera.latitude) * Math.sin(target.latitude) -
      Math.sin(camera.latitude) * Math.cos(target.latitude) * Math.cos(dLon);
    return {
      bearingDeg: (CesiumMath.toDegrees(Math.atan2(y, x)) + 360) % 360,
      rangeM: range,
    };
  }

  /* ----------------------------------------------------------- uncertainty */

  /**
   * Draw geolocation uncertainty where a figure exists.
   *
   * No figure, no circle. An uncertainty ring drawn from a guessed radius is a
   * claim about precision the product cannot support.
   */
  setUncertainty(entries: ReadonlyArray<{ id: string; lat: number; lon: number; radiusM: number }>): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    // Own storage. This previously reused `#linkEntities`, which made
    // `setUncertainty` and `setCorrelationLinks` mutually destructive: drawing
    // uncertainty radii removed every correlation link, and re-drawing the links
    // removed the radii. Two independent layers sharing one array is invisible until
    // the moment one of them is refreshed, at which point the other silently
    // disappears.
    for (const entity of this.#uncertaintyEntities) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already gone */
      }
    }
    this.#uncertaintyEntities = [];
    for (const entry of entries) {
      if (!Number.isFinite(entry.radiusM) || entry.radiusM <= 0) continue;
      this.#uncertaintyEntities.push(
        viewer.entities.add({
          name: `uncertainty:${entry.id}`,
          position: Cartesian3.fromDegrees(entry.lon, entry.lat),
          ellipse: {
            semiMajorAxis: new ConstantProperty(entry.radiusM),
            semiMinorAxis: new ConstantProperty(entry.radiusM),
            material: new ColorMaterialProperty(
              Color.fromCssColorString('#3FA9C4').withAlpha(0.1),
            ),
            outline: new ConstantProperty(true),
            outlineColor: new ConstantProperty(
              Color.fromCssColorString('#3FA9C4').withAlpha(0.5),
            ),
            height: new ConstantProperty(0),
          },
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- layers */

  /**
   * Show or hide one layer.
   *
   * The registry declares which renderer owns a layer; this applies the decision to
   * the Cesium objects that renderer produced. It is idempotent and applied
   * immediately, so the effect is observable on objects that are already on the
   * globe rather than only on the next data load.
   *
   * The store is the single authority (§9). This is the engine applying it, not a
   * second opinion: the same call re-asserts the state on every setter, so a layer
   * cannot escape by being re-created while switched off.
   */
  setLayerVisibility(layerId: LayerId, visible: boolean): void {
    this.#layerVisible.set(layerId, visible);
    this.#syncLayerVisibility();
  }

  /**
   * Re-assert every layer's visibility against the objects currently on the globe.
   *
   * Called after a batch of layer setters has run. Each setter clears and re-adds its
   * entities, and Cesium gives a new entity `show = true` by default -- so without
   * this, switching a layer off and then loading new data would bring it back. One
   * call after the batch is what makes the store authoritative rather than
   * approximately authoritative.
   */
  refreshLayers(): void {
    this.#syncLayerVisibility();
  }

  /** Whether a layer is currently visible. */
  isLayerVisible(layerId: LayerId): boolean {
    return this.#isVisible(layerId);
  }

  #isVisible(layerId: LayerId): boolean {
    const explicit = this.#layerVisible.get(layerId);
    return explicit ?? getLayer(layerId).defaultVisibility;
  }

  /** Cesium stores `name` as a Property, so read it defensively. */
  #entityName(entity: unknown): string {
    const raw = (entity as { name?: unknown }).name;
    if (typeof raw === 'string') return raw;
    const getter = (raw as { getValue?: () => unknown } | undefined)?.getValue;
    if (typeof getter !== 'function') return '';
    const value = getter.call(raw);
    return typeof value === 'string' ? value : '';
  }

  /**
   * Push the current visibility authority onto every owned Cesium object.
   *
   * Called after each toggle AND after each layer setter. The second call is what
   * closes the window where a freshly added entity appears over a layer the operator
   * switched off.
   */
  #syncLayerVisibility(): void {
    const viewer = this.#viewer;
    if (!viewer) return;

    const apply = (id: LayerId, entity: unknown): void => {
      (entity as { show?: boolean }).show = this.#isVisible(id);
    };
    const applyEach = (id: LayerId, entities: Iterable<unknown>): void => {
      const on = this.#isVisible(id);
      for (const entity of entities) apply(id, entity);
    };

    for (const { entity } of this.#targetEntities.values()) apply('SAR_DETECTIONS', entity);
    applyEach('UNCERTAINTY_RADII', this.#uncertaintyEntities);
    applyEach('AIS_CONTACTS', this.#aisEntities);
    applyEach('SAR_SCENE_FOOTPRINT', this.#footprintEntity ? [this.#footprintEntity] : []);
    applyEach('CORRELATION_LINKS', this.#linkEntities);

    /*
     * `setTrack` builds THREE entities -- the observed polyline, the head fix and the
     * predicted polyline -- so TWO registry layers share one renderer and cannot be
     * separated by array membership. They are told apart by entity name, which is
     * why those names are set explicitly in the renderer rather than left to Cesium's
     * default: the mapping depends on them.
     */
    for (const entity of this.#trackEntities) {
      const name = this.#entityName(entity);
      if (name.includes('predicted')) apply('AIS_PREDICTED', entity);
      else if (name === 'ais-fix') apply('AIS_CONTACTS', entity);
      else apply('AIS_TRACKS', entity);
    }

    if (this.#rasterLayer) this.#rasterLayer.show = this.#isVisible('SAR_RASTER');
    if (this.#graticuleProvider) this.#graticuleProvider.show = this.#isVisible('GRATICULE');
  }

  /* ---------------------------------------------------------------- raster */

  /**
   * Attach a server-rendered SAR raster to the measured rectangle it came from.
   *
   * The rectangle is derived from the backend's measured transform, never from
   * the requested AOI. If those disagree the image would be placed somewhere it
   * was not acquired -- which is the GEO-CORR defect in the visual domain.
   */
  /**
   * Attach a server-rendered SAR raster to the measured rectangle it came from.
   *
   * Returns whether the layer was actually added, so the caller can report the
   * truth rather than assuming success.
   */
  setRaster(
    url: string,
    rectangle: { west: number; south: number; east: number; north: number },
    size: { width: number; height: number },
  ): boolean {
    const viewer = this.#viewer;
    if (!viewer) return false;
    this.#clearRaster();

    // The rectangle is mandatory. Without it the provider tiles over the whole
    // globe, which would put one acquisition's imagery under the entire world.
    const extent = Rectangle.fromDegrees(
      rectangle.west,
      rectangle.south,
      rectangle.east,
      rectangle.north,
    );
    try {
      // SingleTile, not UrlTemplate: this is ONE image over ONE rectangle. A
      // template provider re-requests the same URL once per tile -- five
      // identical GETs of the same PNG were observed.
      //
      // tileWidth/tileHeight are MANDATORY in Cesium 1.145; omitting them throws
      // DeveloperError. They are the rendered pixel size the backend measured,
      // and they are also how the image is fitted into the rectangle, so they are
      // taken from the render report rather than guessed.
      const provider = new SingleTileImageryProvider({
        url,
        rectangle: extent,
        tileWidth: Math.max(1, Math.round(size.width)),
        tileHeight: Math.max(1, Math.round(size.height)),
        credit: 'DarkFleet SAR - server-rendered from the measured window transform',
      });
      this.#rasterProvider = provider;
      this.#rasterRectangle = rectangle;
      const layer: ImageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      this.#rasterLayer = layer;
      layer.alpha = 0.95;
      // Honour the current authority rather than hardcoding `true`: a raster loaded
      // while its layer is toggled off must not appear.
      layer.show = this.#isVisible('SAR_RASTER');
      return true;
    } catch (error) {
      // Logged, not swallowed. A previous revision caught and discarded, so a
      // missing required option produced a silently blank globe and no console
      // entry pointing at the cause.
      console.error('DarkFleet: SAR raster layer was not added', error);
      this.#rasterProvider = null;
      this.#rasterLayer = null;
      this.#rasterRectangle = null;
      return false;
    }
  }

  #clearRaster(): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    for (let i = viewer.imageryLayers.length - 1; i >= 0; i -= 1) {
      const layer = viewer.imageryLayers.get(i);
      if (layer?.imageryProvider === this.#rasterProvider) {
        viewer.imageryLayers.remove(layer, true);
      }
    }
    this.#rasterProvider = null;
    this.#rasterLayer = null;
    this.#rasterRectangle = null;
  }

  get rasterBounds(): { west: number; south: number; east: number; north: number } | null {
    return this.#rasterRectangle;
  }

  /* ------------------------------------------------------------------- AOI */

  setAoi(bbox: BBox | null): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    if (this.#aoiEntity) {
      try {
        viewer.entities.remove(this.#aoiEntity as never);
      } catch {
        /* already gone */
      }
      this.#aoiEntity = null;
    }
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    this.#aoiEntity = viewer.entities.add({
      name: 'aoi',
      polygon: {
        hierarchy: [
          Cartesian3.fromDegrees(minLon, minLat),
          Cartesian3.fromDegrees(maxLon, minLat),
          Cartesian3.fromDegrees(maxLon, maxLat),
          Cartesian3.fromDegrees(minLon, maxLat),
        ],
        material: new ColorMaterialProperty(
          Color.fromCssColorString('#3FA9C4').withAlpha(0.06),
        ),
        outline: true,
        outlineColor: Color.fromCssColorString('#3FA9C4').withAlpha(0.85),
        height: 0,
      },
    });
  }

  /* ----------------------------------------------------------------- track */

  /**
   * Draw an AIS track: observed as a solid polyline, predicted as dashed.
   *
   * The visual difference is not styling taste. An operator must be able to see
   * at a glance which parts of a line were reported and which were computed.
   */
  setTrack(
    observed: ReadonlyArray<{ lat: number; lon: number }>,
    predicted: ReadonlyArray<{ lat: number; lon: number }> | null,
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    for (const entity of this.#trackEntities) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already gone */
      }
    }
    this.#trackEntities = [];

    if (observed.length >= 2) {
      this.#trackEntities.push(
        viewer.entities.add({
          name: 'ais-track-observed',
          polyline: {
            positions: new ConstantProperty(
              observed.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, 0)),
            ),
            width: new ConstantProperty(2.5),
            material: new ColorMaterialProperty(
              Color.fromCssColorString('#3FB950').withAlpha(0.9),
            ),
            clampToGround: new ConstantProperty(false),
          },
        }),
      );
    }

    for (const fix of observed) {
      this.#trackEntities.push(
        viewer.entities.add({
          name: 'ais-fix',
          position: Cartesian3.fromDegrees(fix.lon, fix.lat),
          point: {
            pixelSize: 4,
            color: Color.fromCssColorString('#3FB950'),
            outlineColor: Color.fromCssColorString('#040705'),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }

    if (!predicted || predicted.length === 0) return;

    const last = observed[observed.length - 1];
    const path = last ? [...observed.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, 0)), ...predicted.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, 0))] : predicted.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, 0));
    this.#trackEntities.push(
      viewer.entities.add({
        name: 'ais-track-predicted',
        polyline: {
          positions: new ConstantProperty(path),
          width: new ConstantProperty(2),
          material: new ColorMaterialProperty(
            Color.fromCssColorString('#D9A03C').withAlpha(0.85),
          ),
          clampToGround: new ConstantProperty(false),
        },
      }),
    );
    // The predicted endpoint gets a ring: a prediction has no observation to sit
    // on, so it is marked as a terminus rather than as a fix.
    const tip = predicted[predicted.length - 1];
    this.#trackEntities.push(
      viewer.entities.add({
        name: 'ais-predicted-endpoint',
        position: Cartesian3.fromDegrees(tip.lon, tip.lat),
        point: {
          pixelSize: 11,
          color: Color.fromCssColorString('#040705').withAlpha(0.9),
          outlineColor: Color.fromCssColorString('#D9A03C'),
          outlineWidth: 2.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
  }

  get entityCount(): number {
    return (
      this.#targetEntities.size + this.#trackEntities.length + this.#linkEntities.length
    );
  }
}

/**
 * A bounding sphere containing an AOI.
 *
 * The radius is taken from the FARTHEST corner, not the near one. Using a near
 * corner under-sizes the sphere and the camera ends up inside the AOI, which
 * reads as "the flight did nothing".
 */
function boundingSphereOf(bbox: BBox): BoundingSphere {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const centre = Cartesian3.fromDegrees((minLon + maxLon) / 2, (minLat + maxLat) / 2, 0);
  const corners = [
    Cartesian3.fromDegrees(minLon, minLat, 0),
    Cartesian3.fromDegrees(maxLon, maxLat, 0),
    Cartesian3.fromDegrees(minLon, maxLat, 0),
    Cartesian3.fromDegrees(maxLon, minLat, 0),
  ];
  let radius = 1;
  for (const corner of corners) radius = Math.max(radius, Cartesian3.distance(centre, corner));
  return new BoundingSphere(centre, radius * 1.15);
}

export const engine = new TacticalEngine();