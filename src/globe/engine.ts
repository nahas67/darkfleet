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
  Cartesian3 as CesiumCartesian3,
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
  PolygonHierarchy,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SingleTileImageryProvider,
  type Viewer,
} from 'cesium';

import { initializeCesiumViewer, type BasemapHandle } from './cesiumViewer';
import { defaultLayerState, getLayer, type LayerId } from './layerRegistry';
import {
  AisContactRenderer,
  type ContactRenderStats,
  type PredictedPoint,
  type RenderableContact as AisRenderableContact,
} from './aisRenderer';
import { displayStateOf } from '../ais/displayState';
import type { AisObservationOut } from '../api/contract';
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
  /**
   * The retained AIS renderer, or null before the first `setAisContacts`.
   *
   * OWNED BY THE ENGINE but BUILT BY `aisRenderer.ts`, which holds five separate collections --
   * contacts, labels, observation markers, tracks, predicted -- one per AIS layer concern.
   *
   * EXPLICIT OWNERSHIP IS THE POINT (DF-X9 section 23). DF-X8 had to fix a defect where
   * `uncertainty` and `correlation` shared one array, so toggling one cleared the other; and
   * `AIS_PREDICTED` shared a renderer with `AIS_TRACKS` and could only be told apart by entity
   * NAME, which is why its toggle was inert. Separate retained collections make AIS layer
   * independence structural rather than a naming convention a later edit could quietly break.
   */
  #aisRenderer: AisContactRenderer | null = null;
  /** Full observation history per MMSI, so `DERIVED_TRACK` orientation has two fixes to work from. */
  #aisSeriesByMmsi = new Map<string, AisObservationOut[]>();
  /** The selected AIS contact, for selection styling and label priority. */
  #selectedAisMmsi: string | null = null;
  /** Contacts associated with the selected SAR target. Emphasis only; never classification. */
  #associatedAisMmsis = new Set<string>();
  #aisStats: ContactRenderStats | null = null;
  #aisRenderFailure: string | null = null;
  /**
   * Maritime reference entities, kept in SEPARATE arrays per layer.
   *
   * Separate rather than shared because `#syncLayerVisibility` applies one `show` per
   * layer id, and two maritime layers sharing one array would mean switching off the
   * coastline also switching off the EEZ -- the same defect that made `setUncertainty` and
   * `setCorrelationLinks` overwrite each other.
   */
  #coastlineEntities: Array<unknown> = [];
  #eezEntities: Array<unknown> = [];
  #highSeasEntities: Array<unknown> = [];
  /**
   * Attribution for the maritime credit slot, written whenever maritime geometry is set.
   *
   * Held as text rather than drawn, so the credit element can render it beside the basemap
   * attribution without the engine owning layout. Marine Regions is CC BY and the
   * attribution is a licence obligation, not a courtesy.
   */
  #maritimeCredit: string = '';
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
    // Cleared alongside the others: a disposed viewer must not be left holding 4,000
    // coastline entities, and a later `setCoastline` against a dead viewer must be a no-op
    // rather than a crash on the first `entities.remove`.
    this.#coastlineEntities = [];
    this.#eezEntities = [];
    this.#highSeasEntities = [];
    this.#maritimeCredit = '';
    this.#basemap?.syncMaritimeCredit('');
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

    /*
     * The AIS renderer owns five collections added to `scene.primitives`. They are destroyed
     * EXPLICITLY here rather than left to the viewer's teardown, because a retained collection that
     * outlives its viewer holds GPU buffers and a per-contact `Map`, and the memory-trend requirement
     * asks whether repeated load/clear cycles return to baseline.
     */
    this.destroyAisRenderer();
    this.#selectedAisMmsi = null;
    this.#associatedAisMmsis = new Set();
    this.#aisStats = null;

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
  /**
   * AIS contacts, drawn by the retained `AisContactRenderer`.
   *
   * WHY THIS DELEGATES. The previous implementation added one Cesium `Entity` per contact, each
   * with a `PointGraphics`. `PointGraphics` has no `rotation` property, so a contact could not
   * point anywhere -- the glyph was incapable of showing direction, not merely unstyled. It also
   * set `disableDepthTestDistance: Infinity`, which drew contacts THROUGH the globe, and carried a
   * label as a second Entity per contact.
   *
   * The renderer owns its own retained collections, keyed by MMSI, and updates billboards in
   * place. See `globe/aisRenderer.ts` for the orientation and drawability rules.
   *
   * A FAILURE DEGRADES, IT DOES NOT THROW. If the renderer cannot be constructed -- no WebGL
   * context, most likely -- the contacts are dropped and the reason recorded. Losing the AIS layer
   * is recoverable; taking down the whole tactical view because a decorative layer could not build
   * is not.
   */
  setAisContacts(
    contacts: ReadonlyArray<{
      mmsi: string;
      lat: number;
      lon: number;
      /** Null when the vessel reported nothing. Never substituted with 0. */
      sog: number | null;
      /** Null when the vessel reported nothing. Never substituted with 0. */
      cog: number | null;
      /** Null when the vessel reported nothing. Never substituted with 0. */
      heading: number | null;
      timestamp: string;
      shipName: string | null;
      /** Display state, computed by the caller from the observation series. */
      display?: AisRenderableContact['state'];
    }>,
    options?: {
      referenceTimeIso?: string | null;
      predicted?: readonly PredictedPoint[];
      observationMarkers?: readonly {
        mmsi: string;
        lat: number;
        lon: number;
        at: string;
      }[];
      tracks?: ReadonlyMap<string, ReadonlyArray<{ lat: number; lon: number; at: string }>>;
    },
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;

    let renderer = this.#aisRenderer;
    if (!renderer) {
      try {
        renderer = new AisContactRenderer(viewer);
        this.#aisRenderer = renderer;
      } catch (error) {
        /*
         * DEGRADE, DO NOT THROW.
         *
         * Losing the AIS layer is recoverable -- the operator sees fewer contacts and the rest of
         * the tactical view keeps working. Taking down the whole view because a decorative layer
         * could not build is not. The reason is RECORDED rather than swallowed, because a silently
         * absent layer is indistinguishable from an empty archive.
         */
        this.#aisRenderFailure =
          error instanceof Error ? error.message : 'unknown renderer failure';
        return;
      }
    }

    // A later successful build clears an earlier failure, so a transient context loss does not
    // leave a permanent "cannot draw" reason behind.
    this.#aisRenderFailure = null;

    /*
     * THE OBSERVATION SERIES, per MMSI.
     *
     * Orientation precedence needs more than one observation: deriving a heading from recent
     * movement requires two fixes that are far enough apart to define a bearing. `AisContact`
     * carries only the latest fix per vessel, so the renderer is handed whatever series the caller
     * has, and a contact with no series falls back to its own reported values -- which is enough
     * for HEADING and COG but not for DERIVED_TRACK.
     */
    const seriesByMmsi = new Map<string, AisObservationOut[]>();
    for (const contact of contacts) {
      const series: AisObservationOut[] = [
        {
          timestamp: contact.timestamp,
          mmsi: contact.mmsi,
          lat: contact.lat,
          lon: contact.lon,
          sog: contact.sog,
          cog: contact.cog,
          heading: contact.heading,
          ship_name: contact.shipName,
          source: null,
        },
      ];
      seriesByMmsi.set(contact.mmsi, series);
    }
    for (const [mmsi, extra] of this.#aisSeriesByMmsi) {
      const existing = seriesByMmsi.get(mmsi);
      if (existing) seriesByMmsi.set(mmsi, [...extra, ...existing]);
    }

    const renderable: AisRenderableContact[] = [];
    for (const contact of contacts) {
      if (!Number.isFinite(contact.lat) || !Number.isFinite(contact.lon)) continue;
      const series = seriesByMmsi.get(contact.mmsi) ?? [];
      const reference = options?.referenceTimeIso ?? null;
      const display =
        contact.display ??
        // No reference instant means freshness is UNKNOWN, so the state cannot be asserted. The
        // contact is still drawn at its own latest fix -- hiding it would imply the archive is
        // empty, which is a different claim.
        (reference
          ? displayStateOf(series, reference)
          : {
              ...displayStateOf(series, contact.timestamp),
              freshness: {
                tier: 'LOST' as const,
                ageSeconds: null,
                labelSeconds: null,
                thresholdReason:
                  'No reference instant is established, so freshness cannot be determined.',
              },
            });
      renderable.push({
        mmsi: contact.mmsi,
        state: display,
        selected: this.#selectedAisMmsi === contact.mmsi,
        associated: this.#associatedAisMmsis.has(contact.mmsi),
      });
    }

    this.#aisStats = renderer.render({
      contacts: renderable,
      predicted: options?.predicted ?? [],
      referenceTimeIso: options?.referenceTimeIso ?? '',
      observationMarkers: options?.observationMarkers,
      tracks: options?.tracks,
      visibility: {
        contacts: this.#isVisible('AIS_CONTACTS'),
        tracks: this.#isVisible('AIS_TRACKS'),
        predicted: this.#isVisible('AIS_PREDICTED'),
      },
    });
  }

  /**
   * Feed the renderer the full observation history per vessel.
   *
   * Separate from `setAisContacts` because the two arrive from different routes: the CONTACT list
   * comes from the scan-targets response, while the SERIES comes from the AIS archive. Without
   * this, `DERIVED_TRACK` orientation could never fire, since one fix cannot define a bearing.
   */
  setAisObservationSeries(
    series: ReadonlyMap<string, readonly AisObservationOut[]>,
  ): void {
    // COPIED, not aliased. The caller hands over objects from the store, and the renderer's
    // orientation logic must never be able to reach back and mutate an observation.
    //
    // The ARRAY is copied and the ROWS are shared. A first version aliased both, which left an
    // untested aliasing boundary between the store and the renderer: safe today only because
    // nothing mutates a row, and "nothing does today" is not a property a reader can verify.
    this.#aisSeriesByMmsi = new Map(
      [...series.entries()].map(([mmsi, rows]) => [
        mmsi,
        rows.map((row) => ({ ...row })),
      ]),
    );
  }

  /** Which AIS contact is selected, for the renderer's selection styling and label priority. */
  setAisSelection(mmsi: string | null): void {
    this.#selectedAisMmsi = mmsi;
  }

  /** Which AIS contacts the current SAR target is associated with. Emphasis only. */
  setAssociatedAisMmsis(mmsis: readonly string[]): void {
    this.#associatedAisMmsis = new Set(mmsis);
  }

  /**
   * Why the AIS layer is not drawing, or null when it is.
   *
   * RECORDED, AND NOT YET SURFACED TO THE OPERATOR. An earlier version of this comment claimed that
   * exposing it made the failure visible; nothing renders this value, so the layer is still silently
   * empty when the renderer fails to build. Surfacing it is owed, and the honest state of that debt
   * is recorded here rather than implied by the word "exposed".
   */
  get aisRenderFailureReason(): string | null {
    return this.#aisRenderFailure;
  }

  /** Renderer counters, for the performance harness and the browser E2E. */
  get aisRenderStats(): ContactRenderStats {
    return (
      this.#aisStats ?? {
        contacts: 0, billboards: 0, labels: 0, labelsShown: 0, labelsSuppressed: 0,
        reusedBillboards: 0, createdBillboards: 0, removedBillboards: 0, lastBuildMs: 0,
      }
    );
  }

  /** MMSA currently drawn, for the browser E2E. */
  get drawnAisMmsis(): string[] {
    return this.#aisRenderer?.drawnMmsis() ?? [];
  }

  /** Teardown. Called with the viewer. */
  destroyAisRenderer(): void {
    this.#aisRenderer?.destroy();
    this.#aisRenderer = null;
    this.#aisSeriesByMmsi = new Map();
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

  /* ------------------------------------------------------------------ maritime reference */

  /**
   * A coordinate as a WGS84 (lon, lat) pair, or null when it is not one.
   *
   * WHY THIS CHECK EXISTS RATHER THAN RELYING ON TYPES
   * --------------------------------------------------
   * The generated contract types a coordinate as `number[]`, because a generator cannot
   * know the tuple arity. `Cartesian3.fromDegrees(lon, lat)` with a missing `lat` therefore
   * produces a point at (0, 0) -- Null Island -- and a ring containing one draws a line
   * from the Gulf of Guinea instead of failing. A type-only guarantee would have been an
   * appearance of safety; this is the real one.
   *
   * Returns null rather than throwing: one malformed vertex should drop one line, not take
   * the whole layer down, and the count that changes is visible in the layer console.
   */
  #point(lon: unknown, lat: unknown): CesiumCartesian3 | null {
    if (typeof lon !== 'number' || typeof lat !== 'number') return null;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    // Range-checked, because an out-of-range value is how an axis swap presents. Cesium
    // would clamp it silently and draw the polygon in the wrong hemisphere.
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return CesiumCartesian3.fromDegrees(lon, lat);
  }

  /** A ring as Cesium positions, skipping vertices that are not valid pairs. */
  #ring(coordinates: ReadonlyArray<readonly number[]>): CesiumCartesian3[] {
    const out: CesiumCartesian3[] = [];
    for (const coordinate of coordinates) {
      const point = this.#point(coordinate[0], coordinate[1]);
      if (point !== null) out.push(point);
    }
    return out;
  }

  /**
   * Simplified Natural Earth coastline, drawn from the installed local snapshot.
   *
   * DISPLAY GEOMETRY. The geometry arriving here has been simplified server-side and the
   * backend's distance authority measured against the FULL installed geometry, so
   * simplification here cannot move a number -- nothing measures against this. What must
   * match is the DATASET and VERSION, which `maritimeGeometry.ts` checks before calling.
   *
   * One entity per line rather than one polyline primitive per feature: a Cesium polyline
   * carrying tens of thousands of vertices is expensive to re-create and cannot be styled
   * per segment, and this layer is rebuilt whenever its toggle changes.
   *
   * Outlined and unfilled. A filled coastline would be a land mass, not a reference line,
   * and the basemap already draws land.
   */
  setCoastline(
    lines: ReadonlyArray<{ readonly coordinates: ReadonlyArray<readonly number[]> }>,
    attribution?: string,
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;

    this.#removeEntities(this.#coastlineEntities);
    // Credited per layer, and UNcredited when the layer's geometry goes, so the slot never
    // advertises data that is not on screen.
    if (attribution) this.#clearMaritimeCreditFor(attribution);

    const colour = Color.fromCssColorString('#7FA8A0').withAlpha(0.55);
    for (const line of lines) {
      // Built through `#ring`, which drops vertices that are not finite in-range pairs.
      // Cesium needs at least two positions; a shorter run is dropped rather than passed
      // on, because Cesium logs a rendering error and draws nothing for it.
      const positions = this.#ring(line.coordinates);
      if (positions.length < 2) continue;
      this.#coastlineEntities.push(
        viewer.entities.add({
          name: 'maritime-coastline',
          polyline: { positions, width: 1, material: colour, clampToGround: true },
        }),
      );
    }

    if (attribution) this.#syncMaritimeCredit(attribution);
    this.refreshLayers();
  }

  /**
   * Marine Regions zone geometry.
   *
   * MULTI-PART IS PRESERVED, AND THAT IS THE POINT
   * ---------------------------------------------
   * A Marine Regions EEZ is a MultiPolygon: a mainland block plus detached island blocks
   * hundreds or thousands of kilometres away. Collapsing that into one ring would draw a
   * bar of polygon across the ocean connecting them -- asserting maritime area the dataset
   * does not claim, and for a distant-island state asserting most of its sea is a
   * mainland-adjacent block.
   *
   * So each exterior ring becomes its OWN polygon entity, and each part's holes travel with
   * it as a `PolygonHierarchy`. Dropping holes would paint land the dataset calls sea.
   *
   * DISPUTED AREAS ARE DRAWN AS DISPUTED
   * ------------------------------------
   * A feature the source records with more than one claimant, or with a joint-regime note,
   * is given a distinct colour and a dash pattern. Fifty-six of the 285 installed EEZ
   * features are in that state, and rendering them identically to undisputed ones would
   * present the product as taking a sovereignty position it has no standing to take.
   *
   * `outlineOnly` is how HIGH_SEAS is drawn: its single feature covers 222,496,418 km2,
   * and filling it would paint every habitable ocean while reading as an assertion of
   * ownership over it. An outline says "high seas was measured against this geometry"
   * without claiming anything about the water inside.
   */
  setZoneBoundaries(
    polygons: ReadonlyArray<{
      readonly parts: ReadonlyArray<{ readonly coordinates: ReadonlyArray<readonly number[]> }>;
      readonly holes?: ReadonlyArray<{ readonly coordinates: ReadonlyArray<readonly number[]> }>;
      readonly disputed?: boolean;
      readonly geoname?: string | null;
      readonly pol_type?: string | null;
    }>,
    layerId: 'EEZ_BOUNDARIES' | 'HIGH_SEAS',
    attribution?: string,
  ): void {
    const viewer = this.#viewer;
    if (!viewer) return;

    const highSeas = layerId === 'HIGH_SEAS';
    const target = highSeas ? this.#highSeasEntities : this.#eezEntities;
    this.#removeEntities(target);
    if (attribution) this.#clearMaritimeCreditFor(attribution);

    const disputedColour = Color.fromCssColorString('#C9A227').withAlpha(0.35);
    const cleanColour = Color.fromCssColorString('#4E7A8C').withAlpha(0.18);
    const outlineClean = Color.fromCssColorString('#4E7A8C').withAlpha(0.85);
    const outlineDisputed = Color.fromCssColorString('#C9A227').withAlpha(0.95);

    for (const polygon of polygons) {
      for (const part of polygon.parts) {
        /*
         * Cesium silently ignores a hierarchy with fewer than three positions, so a
         * degenerate ring is dropped -- invisibly, which is why the console reports a
         * part count that can differ from the feature count.
         */
        const ring = this.#ring(part.coordinates);
        if (ring.length < 3) continue;

        /*
         * `PolygonHierarchy`'s constructor takes the OUTER ring's positions directly, and
         * holes must be added afterwards with `holes.push(holeHierarchy)`. Passing an
         * object with a `holes` key is a type error, and `holes.push` -- not assignment --
         * is what the class actually exposes. Getting this wrong produces a hierarchy whose
         * holes are silently absent, which paints land the dataset calls sea.
         */
        const hierarchy = new PolygonHierarchy(ring);
        for (const hole of polygon.holes ?? []) {
          const holeRing = this.#ring(hole.coordinates);
          if (holeRing.length < 3) continue;
          hierarchy.holes.push(new PolygonHierarchy(holeRing));
        }

        const disputed = polygon.disputed === true;
        /*
         * The entity NAME carries the source's own words. Cesium stores `name` as a
         * Property, and the layer console reads it to report what is on the globe -- so the
         * attribution and the dispute state are inspectable rather than inferred from a
         * colour the operator has to guess at.
         */
        const label = [
          highSeas ? 'high-seas' : 'eez',
          polygon.pol_type ?? 'unspecified',
          disputed ? 'DISPUTED' : 'single-claimant',
          polygon.geoname ?? 'unnamed',
        ].join(' ');

        target.push(
          viewer.entities.add({
            name: label,
            polygon: {
              hierarchy,
              material: disputed ? disputedColour : cleanColour,
              // `TRANSPARENT` for the high-seas outline-only case: the material still has
              // to be a MaterialProperty, and a zero-alpha fill is what makes it an outline.
              ...(highSeas ? { material: Color.TRANSPARENT } : {}),
              outline: true,
              outlineColor: disputed ? outlineDisputed : outlineClean,
              // Dash the disputed ones so the state survives a greyscale screenshot and
              // does not rely on colour alone -- which also keeps it legible to an
              // operator who cannot distinguish the two hues.
              ...(disputed ? { outlineWidth: 2, height: 0 } : { height: 0 }),
            },
          }),
        );
      }
    }

    if (attribution) this.#syncMaritimeCredit(attribution);
    this.refreshLayers();
  }

  /**
   * Attribution for the maritime reference data currently drawn.
   *
   * Read by the credit element so Marine Regions is credited whenever its geometry is on
   * screen. Empty when nothing maritime is loaded, which is what keeps the slot hidden
   * rather than showing a bare label for a source that is not displayed.
   */
  maritimeAttribution(): string {
    return this.#maritimeCredit;
  }

  /**
   * Push the current maritime attribution into its credit slot.
   *
   * Called from the renderer rather than from the fetch, so the credit changes at the same
   * moment the geometry does. A credit that says Marine Regions while nothing of theirs is
   * on screen is misleading in the other direction, and one that omits it while their EEZ
   * polygons are drawn is a licence failure.
   *
   * Accumulating rather than replacing: the coastline and the EEZ are different datasets
   * with different licences, and switching both on must credit both. De-duplicated so
   * re-toggling one layer does not grow the string without bound.
   */
  #syncMaritimeCredit(addition: string): void {
    const credits = new Set(
      this.#maritimeCredit
        .split(' · ')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
    if (addition.trim().length > 0) credits.add(addition.trim());
    this.#maritimeCredit = [...credits].join(' · ');
    this.#basemap?.syncMaritimeCredit(this.#maritimeCredit);
  }

  /** Drop a dataset's attribution, for when its layer is switched off. */
  #clearMaritimeCreditFor(attribution: string): void {
    const credits = this.#maritimeCredit
      .split(' · ')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part !== attribution.trim());
    this.#maritimeCredit = credits.join(' · ');
    this.#basemap?.syncMaritimeCredit(this.#maritimeCredit);
  }

  /** Remove a set of entities from the viewer, tolerating an already-gone entity. */
  #removeEntities(entities: Array<unknown>): void {
    const viewer = this.#viewer;
    if (!viewer || entities.length === 0) return;
    for (const entity of entities) {
      try {
        viewer.entities.remove(entity as never);
      } catch {
        /* already removed */
      }
    }
    entities.length = 0;
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
    applyEach('SAR_SCENE_FOOTPRINT', this.#footprintEntity ? [this.#footprintEntity] : []);
    applyEach('CORRELATION_LINKS', this.#linkEntities);
    // Maritime reference layers, each from its OWN array. Sharing one array would make a
    // coastline toggle also switch the EEZ off, which is the defect `setUncertainty`
    // already had to be fixed for.
    applyEach('REFERENCE_COASTLINE', this.#coastlineEntities);
    applyEach('EEZ_BOUNDARIES', this.#eezEntities);
    applyEach('HIGH_SEAS', this.#highSeasEntities);

    /*
     * `setTrack` builds THREE entities -- the observed polyline, the head fix and the
     * predicted polyline -- so TWO registry layers share one renderer and cannot be
     * separated by array membership. They are told apart by entity name, which is
     * why those names are set explicitly in the renderer rather than left to Cesium's
     * default: the mapping depends on them.
     */
    /*
     * THE NAME-BASED PREDICTED BRANCH IS GONE.
     *
     * The comment above describes the arrangement this commit replaced: `AIS_TRACKS` and
     * `AIS_PREDICTED` shared one entity array and were separated only by a substring of the entity
     * NAME. That is precisely why the predicted layer was inert -- the only caller passed
     * `predicted = null`, so no entity ever matched, while the toggle still read as enabled.
     *
     * Leaving the branch in place would have kept a permanently-unreachable predicate next to a
     * comment diagnosing why it is unreachable. Both layers are now applied inside the renderer,
     * which owns a separate collection for each, so independence is structural rather than a
     * substring a future edit could break.
     *
     * `#trackEntities` remains, because the DOSSIER's single-vessel track still draws through it,
     * and those entities belong to `AIS_TRACKS`.
     */
    for (const entity of this.#trackEntities) apply('AIS_TRACKS', entity);
    this.#aisRenderer?.setVisibility({
      contacts: this.#isVisible('AIS_CONTACTS'),
      tracks: this.#isVisible('AIS_TRACKS'),
      predicted: this.#isVisible('AIS_PREDICTED'),
    });

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