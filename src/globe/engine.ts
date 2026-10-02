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
  Ellipsoid,
  HeadingPitchRange,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  type Viewer,
} from 'cesium';

import { initializeCesiumViewer } from './cesiumViewer';
import { classificationColor } from '../design/tokens';
import type { BBox, SarTarget, ViewMode } from '../state/store';

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
  #rasterProvider: UrlTemplateImageryProvider | null = null;
  #rasterRectangle: { west: number; south: number; east: number; north: number } | null = null;
  #targetEntities = new Map<string, { entity: unknown; handle: TargetHandle }>();
  #trackEntities: Array<unknown> = [];
  #linkEntities: Array<unknown> = [];
  #aoiEntity: unknown = null;
  #handler: ScreenSpaceEventHandler | null = null;
  #hovered: string | null = null;

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
    Ion.defaultAccessToken = '';

    const viewer = initializeCesiumViewer({ container });
    viewer.scene.globe.depthTestAgainstTerrain = false;
    this.#viewer = viewer;

    this.#handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.#installPicking();
    this.#installCameraTelemetry(viewer);

    return viewer;
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
    this.#rasterProvider = null;
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
  #installCameraTelemetry(viewer: Viewer): void {
    const publish = () => {
      const carto = Cartographic.fromCartesian(viewer.camera.positionWC);
      this.#onCameraAltitude?.(Number.isFinite(carto.height) ? carto.height : null);
    };
    viewer.camera.changed.addEventListener(publish);
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
    for (const entity of this.#linkEntities) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already gone */
      }
    }
    this.#linkEntities = [];
    for (const entry of entries) {
      if (!Number.isFinite(entry.radiusM) || entry.radiusM <= 0) continue;
      this.#linkEntities.push(
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

  /* ---------------------------------------------------------------- raster */

  /**
   * Attach a server-rendered SAR raster to the measured rectangle it came from.
   *
   * The rectangle is derived from the backend's measured transform, never from
   * the requested AOI. If those disagree the image would be placed somewhere it
   * was not acquired -- which is the GEO-CORR defect in the visual domain.
   */
  setRaster(
    url: string,
    rectangle: { west: number; south: number; east: number; north: number },
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;
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
      const provider = new UrlTemplateImageryProvider({
        url,
        rectangle: extent,
        credit: 'DarkFleet SAR - server-rendered from the measured window transform',
      });
      this.#rasterProvider = provider;
      this.#rasterRectangle = rectangle;
      const layer: ImageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      layer.alpha = 0.95;
      layer.show = true;
    } catch {
      // Cesium refused the provider. The raster will not show and the product
      // says so from state -- no placeholder image is substituted.
      this.#rasterProvider = null;
      this.#rasterRectangle = null;
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