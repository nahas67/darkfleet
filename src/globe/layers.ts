/**
 * Cesium layer implementations for the DarkFleet vNext globe (UI-006, UI-031..033).
 *
 * Every layer here is a `RegisteredLayer`: it owns a private, explicit list of
 * Cesium primitives and RELEASES THEM BEFORE ADDING NEW ONES on every `update()`
 * and on `dispose()`. That is the no-leak guarantee the registry contract asks
 * for: running the same update five times leaves exactly the same number of
 * entities (and imagery layers) behind. `layers.test.ts` proves it.
 *
 * Honesty rules encoded here:
 *  - Nothing is invented. If the backend sent no targets, no entity is created.
 *  - Geometry is derived from backend fields only (`corr.scoreDecomposition
 *    .matchRadiusMeters`, `lenM`/`widM`/`hdg`, the mask grid). No threshold,
 *    score, match or classification is recomputed in the browser (API-011).
 *  - Advanced layers (MULTIPASS_TRACKS, WAKE_GEOMETRY, ML_OUTPUT,
 *    TEMPORAL_ANOMALIES) are deliberately NOT implemented. `createUnavailableLayer`
 *    returns a hard no-op layer, so their `update()` can never create a Cesium
 *    primitive even if something bypasses the registry's capability gate
 *    (UI-029/030, correction #8).
 *  - No Cesium widget, credit container or attribution is touched here.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  HeightReference,
  HorizontalOrigin,
  Math as CesiumMath,
  Matrix4,
  PolygonHierarchy,
  Rectangle,
  SingleTileImageryProvider,
  Transforms,
  VerticalOrigin,
} from 'cesium';
import type { Entity, ImageryLayer, ImageryProvider, Viewer } from 'cesium';
import { LAYER_DEFS } from './registry.ts';
import type { RegisteredLayer } from './registry.ts';
import type {
  AisOnlyTarget,
  BoundingBox,
  LayerConfig,
  LayerId,
  VesselTarget,
} from '../types/api.ts';

// --------------------------------------------------------------- palette

/**
 * Display palette. These are UI colours, not data: classification -> colour
 * maps the classification string the BACKEND already decided.
 */
export const LAYER_PALETTE = {
  matched: '#66f0c3',
  unmatched: '#ff6868',
  infrastructure: '#7cc4ff',
  ambiguous: '#9fb0bd',
  link: '#62e8ff',
  radius: '#ffc76b',
  footprint: '#62e8ff',
  land: '#8fa6b4',
  debug: '#ff9ad2',
  selected: '#ffffff',
} as const;

const CSS_CLASSIFICATION_COLORS: Readonly<Record<string, string>> = {
  SAR_MATCHED_AIS: LAYER_PALETTE.matched,
  SAR_UNMATCHED: LAYER_PALETTE.unmatched,
  AIS_ONLY: LAYER_PALETTE.radius,
  STATIONARY_OR_INFRASTRUCTURE: LAYER_PALETTE.infrastructure,
  SEA_CLUTTER: LAYER_PALETTE.ambiguous,
  LOW_CONFIDENCE: LAYER_PALETTE.ambiguous,
  UNRESOLVED: LAYER_PALETTE.ambiguous,
};

export function classificationCss(classification: string): string {
  return CSS_CLASSIFICATION_COLORS[classification] ?? LAYER_PALETTE.ambiguous;
}

export function classificationColor(classification: string): Color {
  return Color.fromCssColorString(classificationCss(classification));
}

// --------------------------------------------------------- input validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A bounding box is four finite degrees in `minLon,minLat,maxLon,maxLat` order. */
export function isBoundingBox(value: unknown): value is BoundingBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => finiteNumber(v)) &&
    (value as BoundingBox)[2] >= (value as BoundingBox)[0] &&
    (value as BoundingBox)[3] >= (value as BoundingBox)[1]
  );
}

/**
 * Accept either the wire `BoundingBox` tuple or the backend's flat `aoi`
 * number array (`ScanResult.aoi`). Returns null when the geometry is missing
 * rather than guessing an extent.
 */
export function toBoundingBox(value: unknown): BoundingBox | null {
  if (isBoundingBox(value)) {
    const [minLon, minLat, maxLon, maxLat] = value;
    if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return null;
    return [minLon, minLat, maxLon, maxLat];
  }
  return null;
}

/** Pull a bbox out of `{ bbox }`, `{ aoi }` or a bare tuple. */
export function readBoundingBox(data: unknown): BoundingBox | null {
  if (isBoundingBox(data)) return toBoundingBox(data);
  if (isRecord(data)) {
    return toBoundingBox(data.bbox) ?? toBoundingBox(data.aoi);
  }
  return null;
}

/** A target is usable only when it carries an id and finite coordinates. */
export function isVesselTargetLike(value: unknown): value is VesselTarget {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && finiteNumber(value.lat) && finiteNumber(value.lon);
}

export function isAisOnlyTargetLike(value: unknown): value is AisOnlyTarget {
  if (!isRecord(value)) return false;
  return (
    typeof value.mmsi === 'string' &&
    value.mmsi.length > 0 &&
    finiteNumber(value.lat) &&
    finiteNumber(value.lon)
  );
}

/**
 * Accepts a bare `VesselTarget[]` or a wrapper such as `{ targets }` /
 * `ScanResult`. Anything that is not a well-formed target is dropped, so a
 * malformed payload renders fewer things, never invented ones.
 */
export function readTargets(data: unknown): VesselTarget[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.targets)
      ? data.targets
      : isRecord(data) && Array.isArray(data.vessels)
        ? data.vessels
        : null;
  if (!raw) return [];
  return raw.filter(isVesselTargetLike);
}

/** Accepts a bare `AisOnlyTarget[]` or `{ ais_only }` / `{ contacts }`. */
export function readAisOnly(data: unknown): AisOnlyTarget[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.ais_only)
      ? data.ais_only
      : isRecord(data) && Array.isArray(data.contacts)
        ? data.contacts
        : null;
  if (!raw) return [];
  return raw.filter(isAisOnlyTargetLike);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ------------------------------------------------------------ grid helpers

export interface GridRect {
  /** First row index (top of the grid). */
  readonly row: number;
  /** First column index. */
  readonly col: number;
  /** Row span. */
  readonly rows: number;
  /** Column span. */
  readonly cols: number;
}

export interface GridShape {
  readonly rows: number;
  readonly cols: number;
}

/** Shape of a backend mask grid, or null when it is not a rectangular grid. */
export function gridShape(grid: unknown): GridShape | null {
  if (!Array.isArray(grid) || grid.length === 0) return null;
  const cols = Array.isArray(grid[0]) ? (grid[0] as unknown[]).length : 0;
  if (cols === 0) return null;
  for (const row of grid) {
    if (!Array.isArray(row) || (row as unknown[]).length !== cols) return null;
  }
  return { rows: grid.length, cols };
}

/** Mask semantics: the backend emits numeric 0/1 grids. */
function cellIsSet(value: unknown): boolean {
  if (typeof value === 'number') return value > 0;
  return value === true || value === 1;
}

/**
 * Merge a mask grid into as few axis-aligned cell rectangles as possible.
 * Pure geometry over backend output: no thresholding, smoothing or scoring.
 */
export function gridRectangles(grid: unknown): GridRect[] {
  const shape = gridShape(grid);
  if (!shape || !Array.isArray(grid)) return [];
  const closed: GridRect[] = [];
  let open = new Map<string, GridRect>();

  for (let r = 0; r < shape.rows; r++) {
    const row = (grid as unknown[][])[r];
    const next = new Map<string, GridRect>();
    let c = 0;
    while (c < shape.cols) {
      if (!cellIsSet(row[c])) {
        c += 1;
        continue;
      }
      let end = c;
      while (end + 1 < shape.cols && cellIsSet(row[end + 1])) end += 1;
      const key = `${c}:${end - c + 1}`;
      const previous = open.get(key);
      if (previous) {
        // Same span on the previous row: grow the existing rectangle.
        (previous as { rows: number }).rows = r - previous.row + 1;
        next.set(key, previous);
      } else {
        next.set(key, { row: r, col: c, rows: 1, cols: end - c + 1 });
      }
      c = end + 1;
    }
    for (const [key, rect] of open) {
      if (!next.has(key)) closed.push(rect);
    }
    open = next;
  }
  for (const rect of open.values()) closed.push(rect);
  return closed;
}

/** Map a grid cell rectangle onto lon/lat degrees for a given bbox. */
export function gridRectToBbox(rect: GridRect, shape: GridShape, bbox: BoundingBox): BoundingBox {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  return [
    minLon + (rect.col / shape.cols) * lonSpan,
    minLat + ((shape.rows - rect.row - rect.rows) / shape.rows) * latSpan,
    minLon + ((rect.col + rect.cols) / shape.cols) * lonSpan,
    minLat + ((shape.rows - rect.row) / shape.rows) * latSpan,
  ];
}

// --------------------------------------------------------------- geometry

export interface FootprintInput {
  readonly lat: number;
  readonly lon: number;
  readonly lenM: number;
  readonly widM: number;
  /** Degrees clockwise from north. Non-finite values are treated as 0 (N). */
  readonly hdg: number;
}

/**
 * Four corners of the apparent SAR footprint, oriented by the backend heading.
 * Ground frame is the local east-north-up frame at the detection, so the polygon
 * follows the vessel rather than the screen.
 */
export function footprintCorners(input: FootprintInput): Cartesian3[] {
  const heading = finiteNumber(input.hdg) ? CesiumMath.toRadians(input.hdg) : 0;
  const halfLength = Math.max(Math.abs(input.lenM), 1) / 2;
  const halfWidth = Math.max(Math.abs(input.widM), 1) / 2;
  // heading 0 = north (+y); clockwise positive.
  const forward = { x: Math.sin(heading), y: Math.cos(heading) };
  const starboard = { x: Math.cos(heading), y: -Math.sin(heading) };

  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(input.lon, input.lat));
  const corner = (along: number, across: number): Cartesian3 => {
    const local = new Cartesian3(
      across * halfWidth * starboard.x + along * halfLength * forward.x,
      across * halfWidth * starboard.y + along * halfLength * forward.y,
      0,
    );
    return Matrix4.multiplyByPoint(frame, local, new Cartesian3());
  };
  return [
    corner(1, 1),
    corner(1, -1),
    corner(-1, -1),
    corner(-1, 1),
    corner(1, 1),
  ];
}

// ------------------------------------------------------------- base layer

interface TintRef {
  readonly color: Color;
  readonly base: number;
}

/**
 * Shared lifecycle. Subclasses implement `build` only; clearing, visibility
 * and opacity are handled here so no layer can forget to release primitives.
 */
export abstract class CesiumEntityLayer implements RegisteredLayer {
  readonly config: LayerConfig;
  private entities: Entity[] = [];
  private tints: TintRef[] = [];
  protected visible: boolean;

  constructor(config: LayerConfig) {
    this.config = { ...config };
    this.visible = config.visible;
  }

  /** Nothing to mount: primitives are created per update, not per viewer. */
  mount(_viewer: Viewer): void {
    /* intentionally empty */
  }

  update(viewer: Viewer, data?: unknown): void {
    this.clear(viewer);
    this.build(viewer, data);
    for (const entity of this.entities) entity.show = this.visible;
  }

  /** Build this layer's primitives. `clear()` has already run. */
  protected abstract build(viewer: Viewer, data: unknown): void;

  /** Release every primitive this layer owns. Safe to call repeatedly. */
  protected clear(viewer: Viewer): void {
    for (const entity of this.entities) {
      try {
        viewer.entities.remove(entity);
      } catch {
        /* the viewer may already be gone; the entity goes with it */
      }
    }
    this.entities = [];
    this.tints = [];
  }

  dispose(viewer: Viewer): void {
    this.clear(viewer);
  }

  setVisible(_viewer: Viewer, visible: boolean): void {
    this.visible = visible;
    for (const entity of this.entities) entity.show = visible;
  }

  setOpacity(_viewer: Viewer, opacity: number): void {
    this.config.opacity = Math.max(0, Math.min(1, opacity));
    for (const tint of this.tints) tint.color.alpha = tint.base * this.config.opacity;
  }

  /** Number of live primitives; used by the leak test. */
  get primitiveCount(): number {
    return this.entities.length;
  }

  protected addEntity(viewer: Viewer, spec: Record<string, unknown>): Entity {
    const entity = viewer.entities.add(spec);
    this.entities.push(entity);
    entity.show = this.visible;
    return entity;
  }

  /** Colour scaled by the layer opacity; the tint is remembered for updates. */
  protected tint(hex: string, baseAlpha = 1): Color {
    const color = Color.fromCssColorString(hex);
    color.alpha = Math.max(0, Math.min(1, baseAlpha * this.config.opacity));
    this.tints.push({ color, base: Math.max(0, Math.min(1, baseAlpha)) });
    return color;
  }
}

function layerConfig(id: LayerId): LayerConfig {
  const found = LAYER_DEFS.find((def) => def.id === id);
  if (!found) throw new Error(`[darkfleet] unknown layer id: ${id}`);
  return found;
}

// -------------------------------------------------------------- SAR_RASTER

export interface SarRasterInput {
  /** Backend raster URL (`ScanResult.scene.asset_href` or an explicit tile URL). */
  readonly url: string;
  readonly bbox: BoundingBox;
  readonly width?: number;
  readonly height?: number;
}

/** Normalise a raster payload; null when the backend sent no usable raster. */
export function readSarRaster(data: unknown): SarRasterInput | null {
  if (!isRecord(data)) return null;
  const url = readString(data, 'url') ?? readString(data, 'asset_href');
  const bbox = readBoundingBox(data);
  if (!url || !bbox) return null;
  const width = finiteNumber(data.width) ? data.width : undefined;
  const height = finiteNumber(data.height) ? data.height : undefined;
  return { url, bbox, width, height };
}

export interface RasterProviderRequest {
  readonly url: string;
  readonly rectangle: Rectangle;
  readonly tileWidth?: number;
  readonly tileHeight?: number;
}

/**
 * Imagery provider factory. Injectable so tests never fetch an image; the
 * production default uses Cesium's single-tile provider (a real imagery layer,
 * NOT the old canvas-material overlay that used to leak).
 */
export type RasterProviderFactory = (
  request: RasterProviderRequest,
) => ImageryProvider | Promise<ImageryProvider>;

const defaultRasterFactory: RasterProviderFactory = (request) =>
  SingleTileImageryProvider.fromUrl(request.url, {
    rectangle: request.rectangle,
    ...(request.tileWidth ? { tileWidth: request.tileWidth } : {}),
    ...(request.tileHeight ? { tileHeight: request.tileHeight } : {}),
  });

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class SarRasterLayer extends CesiumEntityLayer {
  private readonly factory: RasterProviderFactory;
  private imagery: ImageryLayer | null = null;
  /** Guards against a slow provider resolving after a newer update. */
  private token = 0;
  private disposed = false;

  constructor(factory: RasterProviderFactory = defaultRasterFactory) {
    super(layerConfig('SAR_RASTER'));
    this.factory = factory;
  }

  /** Imagery layers currently owned; exactly 0 or 1 at any time. */
  get imageryLayerCount(): number {
    return this.imagery ? 1 : 0;
  }

  protected override clear(viewer: Viewer): void {
    super.clear(viewer);
    if (this.imagery) {
      try {
        viewer.imageryLayers.remove(this.imagery, true);
      } catch {
        /* viewer already torn down */
      }
      this.imagery = null;
    }
  }

  override dispose(viewer: Viewer): void {
    this.disposed = true;
    this.token += 1;
    this.clear(viewer);
  }

  protected build(viewer: Viewer, data: unknown): void {
    const input = readSarRaster(data);
    if (!input) return;
    const request: RasterProviderRequest = {
      url: input.url,
      rectangle: Rectangle.fromDegrees(...input.bbox),
      ...(input.width ? { tileWidth: input.width } : {}),
      ...(input.height ? { tileHeight: input.height } : {}),
    };
    this.token += 1;
    const token = this.token;
    const attach = (provider: ImageryProvider): void => {
      if (this.disposed || token !== this.token) return;
      try {
        this.imagery = viewer.imageryLayers.addImageryProvider(provider);
        this.imagery.show = this.visible;
        this.imagery.alpha = this.config.opacity;
      } catch (err) {
        console.warn('[darkfleet] SAR raster imagery failed to attach:', err);
      }
    };
    try {
      const provider = this.factory(request);
      if (isPromiseLike(provider)) {
        provider.then(attach).catch((err: unknown) => {
          console.warn('[darkfleet] SAR raster provider failed:', err);
        });
      } else {
        attach(provider);
      }
    } catch (err) {
      console.warn('[darkfleet] SAR raster provider failed:', err);
    }
  }

  override setVisible(_viewer: Viewer, visible: boolean): void {
    this.visible = visible;
    if (this.imagery) this.imagery.show = visible;
  }

  override setOpacity(_viewer: Viewer, opacity: number): void {
    this.config.opacity = Math.max(0, Math.min(1, opacity));
    if (this.imagery) this.imagery.alpha = this.config.opacity;
  }
}

// -------------------------------------------------------- scene footprint

export class SarSceneFootprintLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('SAR_SCENE_FOOTPRINT'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    const bbox = readBoundingBox(data);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const perimeter: Cartesian3[] = [
      Cartesian3.fromDegrees(minLon, minLat),
      Cartesian3.fromDegrees(maxLon, minLat),
      Cartesian3.fromDegrees(maxLon, maxLat),
      Cartesian3.fromDegrees(minLon, maxLat),
      Cartesian3.fromDegrees(minLon, minLat),
    ];
    this.addEntity(viewer, {
      id: 'df-layer:SAR_SCENE_FOOTPRINT:fill',
      rectangle: {
        coordinates: Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat),
        material: this.tint(LAYER_PALETTE.footprint, 0.04),
        heightReference: HeightReference.CLAMP_TO_GROUND,
      },
    });
    this.addEntity(viewer, {
      id: 'df-layer:SAR_SCENE_FOOTPRINT:edge',
      polyline: {
        positions: perimeter,
        width: 2,
        material: this.tint(LAYER_PALETTE.footprint, 0.55),
        clampToGround: true,
      },
    });
  }
}

// -------------------------------------------------------------- land mask

export interface MaskInput {
  readonly bbox: BoundingBox;
  readonly grid: unknown;
}

/** Normalise a debug mask payload; null when there is no grid to draw. */
export function readMask(data: unknown): MaskInput | null {
  if (!isRecord(data)) return null;
  const bbox = readBoundingBox(data);
  const grid = data.grid ?? data.mask;
  if (!bbox || !gridShape(grid)) return null;
  return { bbox, grid };
}

export class LandMaskLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('LAND_MASK'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    const input = readMask(data);
    if (!input) return;
    const shape = gridShape(input.grid);
    if (!shape) return;
    for (const rect of gridRectangles(input.grid)) {
      const cell = gridRectToBbox(rect, shape, input.bbox);
      this.addEntity(viewer, {
        rectangle: {
          coordinates: Rectangle.fromDegrees(...cell),
          material: this.tint(LAYER_PALETTE.land, 0.45),
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
  }
}

// --------------------------------------------------------- SAR detections

export class SarDetectionsLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('SAR_DETECTIONS'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    for (const target of readTargets(data)) {
      const css = classificationCss(target.classification);
      const id = `df-target:${target.id}`;
      this.addEntity(viewer, {
        id: `${id}:box`,
        polygon: {
          hierarchy: new PolygonHierarchy(
            footprintCorners({
              lat: target.lat,
              lon: target.lon,
              lenM: finiteNumber(target.lenM) ? target.lenM : 1,
              widM: finiteNumber(target.widM) ? target.widM : 1,
              hdg: finiteNumber(target.hdg) ? target.hdg : 0,
            }),
          ),
          material: this.tint(css, 0.12),
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
      this.addEntity(viewer, {
        id: `${id}:point`,
        position: Cartesian3.fromDegrees(target.lon, target.lat),
        point: {
          pixelSize: 7,
          color: this.tint(css, 0.95),
          outlineColor: Color.fromCssColorString('#06090d'),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${target.id} · ${target.classification}`,
          font: '10px monospace',
          fillColor: this.tint(css, 0.9),
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(6,9,13,0.8)'),
          horizontalOrigin: HorizontalOrigin.LEFT,
          pixelOffset: new Cartesian2(10, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }
}

// ----------------------------------------------------------- AIS contacts

export class AisContactsLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('AIS_CONTACTS'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    for (const contact of readAisOnly(data)) {
      this.addEntity(viewer, {
        id: `df-ais:${contact.mmsi}`,
        position: Cartesian3.fromDegrees(contact.lon, contact.lat),
        point: {
          pixelSize: 6,
          color: this.tint(LAYER_PALETTE.radius, 0.95),
          outlineColor: Color.fromCssColorString('#06090d'),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: contact.vesselName ? `${contact.vesselName} ${contact.mmsi}` : contact.mmsi,
          font: '10px monospace',
          fillColor: this.tint(LAYER_PALETTE.radius, 0.85),
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(6,9,13,0.8)'),
          horizontalOrigin: HorizontalOrigin.LEFT,
          pixelOffset: new Cartesian2(10, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }
}

// ------------------------------------------------------------- AIS trails

export interface AisTrailPoint {
  readonly lat: number;
  readonly lon: number;
  readonly timestamp?: string;
}

export interface AisTrailInput {
  readonly mmsi: string;
  readonly vesselName?: string | null;
  readonly points: readonly AisTrailPoint[];
}

/** One polyline per MMSI. Observations are ordered by timestamp, not moved. */
export function readAisTrails(data: unknown): AisTrailInput[] {
  if (!isRecord(data)) return [];
  const out: AisTrailInput[] = [];
  const push = (mmsi: string, vesselName: string | null, points: AisTrailPoint[]): void => {
    if (points.length === 0) return;
    out.push({ mmsi, vesselName, points });
  };

  if (Array.isArray(data.trails)) {
    for (const trail of data.trails) {
      if (!isRecord(trail) || typeof trail.mmsi !== 'string') continue;
      if (!Array.isArray(trail.points)) continue;
      const points = trail.points.filter(
        (p): p is AisTrailPoint =>
          isRecord(p) && finiteNumber(p.lat) && finiteNumber(p.lon),
      );
      push(
        trail.mmsi,
        typeof trail.vesselName === 'string' ? trail.vesselName : null,
        points,
      );
    }
    return out;
  }

  if (Array.isArray(data.observations)) {
    const grouped = new Map<string, AisTrailPoint[]>();
    const names = new Map<string, string>();
    for (const obs of data.observations) {
      if (!isRecord(obs) || typeof obs.mmsi !== 'string') continue;
      if (!finiteNumber(obs.lat) || !finiteNumber(obs.lon)) continue;
      const bucket = grouped.get(obs.mmsi) ?? [];
      bucket.push({
        lat: obs.lat,
        lon: obs.lon,
        ...(typeof obs.timestamp === 'string' ? { timestamp: obs.timestamp } : {}),
      });
      grouped.set(obs.mmsi, bucket);
      const name = readString(obs, 'vesselName') ?? readString(obs, 'shipName');
      if (name && !names.has(obs.mmsi)) names.set(obs.mmsi, name);
    }
    for (const [mmsi, points] of grouped) {
      points.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
      push(mmsi, names.get(mmsi) ?? null, points);
    }
  }
  return out;
}

export class AisTrailsLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('AIS_TRAILS'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    for (const trail of readAisTrails(data)) {
      const positions = trail.points.map((p) => Cartesian3.fromDegrees(p.lon, p.lat));
      if (positions.length < 2) continue;
      this.addEntity(viewer, {
        id: `df-ais-trail:${trail.mmsi}`,
        polyline: {
          positions,
          width: 1.5,
          material: this.tint(LAYER_PALETTE.radius, 0.6),
          clampToGround: true,
        },
      });
      this.addEntity(viewer, {
        id: `df-ais-trail-label:${trail.mmsi}`,
        position: positions[positions.length - 1],
        label: {
          text: trail.vesselName ? `${trail.vesselName} ${trail.mmsi}` : trail.mmsi,
          font: '10px monospace',
          fillColor: this.tint(LAYER_PALETTE.radius, 0.85),
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(6,9,13,0.8)'),
          horizontalOrigin: HorizontalOrigin.LEFT,
          pixelOffset: new Cartesian2(10, 0),
          verticalOrigin: VerticalOrigin.BOTTOM,
        },
      });
    }
  }
}

// ------------------------------------------------------ correlation links

/** Match radius in metres for a target, or null when the backend sent none. */
export function matchRadiusMeters(target: VesselTarget): number | null {
  const decomposition = target.corr?.scoreDecomposition;
  const radius = decomposition?.matchRadiusMeters;
  return finiteNumber(radius) && radius > 0 ? radius : null;
}

/** Predicted AIS position, or null when the backend associated nothing. */
export function predictedPosition(target: VesselTarget): { lat: number; lon: number } | null {
  if (!target.corr?.matched) return null;
  const { predictedLat, predictedLon } = target.corr;
  return finiteNumber(predictedLat) && finiteNumber(predictedLon)
    ? { lat: predictedLat, lon: predictedLon }
    : null;
}

export class CorrelationLinksLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('CORRELATION_LINKS'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    for (const target of readTargets(data)) {
      const predicted = predictedPosition(target);
      const radius = matchRadiusMeters(target);
      const css = classificationCss(target.classification);
      if (radius !== null) {
        this.addEntity(viewer, {
          id: `df-match-radius:${target.id}`,
          position: Cartesian3.fromDegrees(target.lon, target.lat),
          ellipse: {
            semiMajorAxis: radius,
            semiMinorAxis: radius,
            material: this.tint(LAYER_PALETTE.link, 0.08),
            outline: true,
            outlineColor: this.tint(LAYER_PALETTE.link, 0.35),
            outlineWidth: 1,
            heightReference: HeightReference.CLAMP_TO_GROUND,
          },
        });
      }
      if (!predicted) continue;
      this.addEntity(viewer, {
        id: `df-link:${target.id}`,
        polyline: {
          positions: [
            Cartesian3.fromDegrees(target.lon, target.lat),
            Cartesian3.fromDegrees(predicted.lon, predicted.lat),
          ],
          width: 1.6,
          material: this.tint(css, 0.7),
          clampToGround: true,
        },
      });
      this.addEntity(viewer, {
        id: `df-link-label:${target.id}`,
        position: Cartesian3.fromDegrees(predicted.lon, predicted.lat),
        point: {
          pixelSize: 5,
          color: this.tint(css, 0.9),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: target.corr.mmsi ?? 'AIS',
          font: '10px monospace',
          fillColor: this.tint(css, 0.85),
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(6,9,13,0.8)'),
          horizontalOrigin: HorizontalOrigin.LEFT,
          pixelOffset: new Cartesian2(8, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }
}

// ------------------------------------------------------ uncertainty radii

/**
 * The per-candidate match radius from `corr.scoreDecomposition`. Candidates
 * without a decomposition are skipped: a missing radius is never replaced by a
 * made-up one.
 */
export class UncertaintyRadiiLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('UNCERTAINTY_RADII'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    for (const target of readTargets(data)) {
      const radius = matchRadiusMeters(target);
      if (radius === null) continue;
      const css = classificationCss(target.classification);
      this.addEntity(viewer, {
        id: `df-uncertainty:${target.id}`,
        position: Cartesian3.fromDegrees(target.lon, target.lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: this.tint(css, 0.1),
          outline: true,
          outlineColor: this.tint(css, 0.6),
          outlineWidth: 1,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
  }
}

// ------------------------------------------------------ selected target

export interface SelectedTargetInput {
  readonly targetId: string | null;
  readonly targets: VesselTarget[];
}

export function readSelectedTarget(data: unknown): SelectedTargetInput {
  if (Array.isArray(data)) {
    return { targetId: null, targets: data.filter(isVesselTargetLike) };
  }
  if (!isRecord(data)) return { targetId: null, targets: [] };
  const raw = Array.isArray(data.targets) ? data.targets : [];
  const id = readString(data, 'targetId') ?? readString(data, 'selectedTargetId');
  const single = isVesselTargetLike(data) ? [data] : [];
  return { targetId: id, targets: [...single, ...raw.filter(isVesselTargetLike)] };
}

/** Reticle radius: the target's own footprint plus its length uncertainty. */
export function reticleRadius(target: VesselTarget): number {
  const len = finiteNumber(target.lenM) ? Math.abs(target.lenM) : 0;
  const uncertainty = finiteNumber(target.lenUncM) ? Math.abs(target.lenUncM) : 0;
  return Math.max(150, len + uncertainty * 2);
}

export class SelectedTargetLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('SELECTED_TARGET'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    const { targetId, targets } = readSelectedTarget(data);
    if (!targetId) return;
    const target = targets.find((t) => t.id === targetId);
    if (!target) return;
    const radius = reticleRadius(target);
    this.addEntity(viewer, {
      id: `df-selected:${target.id}`,
      position: Cartesian3.fromDegrees(target.lon, target.lat),
      ellipse: {
        semiMajorAxis: radius,
        semiMinorAxis: radius,
        material: this.tint(LAYER_PALETTE.selected, 0.05),
        outline: true,
        outlineColor: this.tint(LAYER_PALETTE.selected, 0.9),
        outlineWidth: 2,
        heightReference: HeightReference.CLAMP_TO_GROUND,
      },
    });
    this.addEntity(viewer, {
      id: `df-selected-label:${target.id}`,
      position: Cartesian3.fromDegrees(target.lon, target.lat),
      label: {
        text: `${target.id} · ${target.classification}`,
        font: 'bold 12px monospace',
        fillColor: this.tint(LAYER_PALETTE.selected, 0.95),
        showBackground: true,
        backgroundColor: Color.fromCssColorString('rgba(6,9,13,0.9)'),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -14),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }
}

// ------------------------------------------------------------ CFAR debug

/** Outline of the backend detection mask, from the debug endpoint grid. */
export class CfarDebugLayer extends CesiumEntityLayer {
  constructor() {
    super(layerConfig('CFAR_DEBUG'));
  }

  protected build(viewer: Viewer, data: unknown): void {
    const input = readMask(data);
    if (!input) return;
    const shape = gridShape(input.grid);
    if (!shape) return;
    for (const rect of gridRectangles(input.grid)) {
      const [minLon, minLat, maxLon, maxLat] = gridRectToBbox(rect, shape, input.bbox);
      this.addEntity(viewer, {
        polyline: {
          positions: [
            Cartesian3.fromDegrees(minLon, minLat),
            Cartesian3.fromDegrees(maxLon, minLat),
            Cartesian3.fromDegrees(maxLon, maxLat),
            Cartesian3.fromDegrees(minLon, maxLat),
            Cartesian3.fromDegrees(minLon, minLat),
          ],
          width: 1.2,
          material: this.tint(LAYER_PALETTE.debug, 0.85),
          clampToGround: true,
        },
      });
    }
  }
}

// --------------------------------------------------------- gated layers

/**
 * A declared-but-unimplemented layer. `update()` is a hard no-op, so no Cesium
 * primitive can ever be created for an advanced layer (UI-029/030).
 */
export class UnavailableLayer implements RegisteredLayer {
  readonly config: LayerConfig;

  constructor(id: LayerId) {
    const found = LAYER_DEFS.find((def) => def.id === id);
    if (!found) throw new Error(`[darkfleet] unknown layer id: ${id}`);
    this.config = { ...found, capabilityState: 'NOT_AVAILABLE', visible: false };
  }

  mount(_viewer: Viewer): void {
    /* no primitives, ever */
  }

  update(_viewer: Viewer, _data?: unknown): void {
    /* no primitives, ever */
  }

  setVisible(_viewer: Viewer, _visible: boolean): void {
    /* no primitives, ever */
  }

  setOpacity(_viewer: Viewer, _opacity: number): void {
    /* no primitives, ever */
  }

  dispose(_viewer: Viewer): void {
    /* no primitives, ever */
  }
}

/** The base earth layer is Cesium's own ellipsoid + imagery; nothing to add. */
export class BaseWorldLayer implements RegisteredLayer {
  readonly config: LayerConfig;

  constructor() {
    this.config = { ...layerConfig('BASE_WORLD') };
  }

  mount(_viewer: Viewer): void {
    /* owned by the Viewer itself */
  }

  update(_viewer: Viewer, _data?: unknown): void {
    /* owned by the Viewer itself */
  }

  setVisible(_viewer: Viewer, _visible: boolean): void {
    /* owned by the Viewer itself */
  }

  setOpacity(_viewer: Viewer, _opacity: number): void {
    /* BASE_WORLD declares supportsOpacity: false */
  }

  dispose(_viewer: Viewer): void {
    /* owned by the Viewer itself */
  }
}

// -------------------------------------------------------------- factories

export interface CreateLayerOptions {
  /** Override the SAR raster provider factory (tests inject a stub). */
  readonly rasterProviderFactory?: RasterProviderFactory;
}

/**
 * Every layer implementation the registry knows, in registry declaration order.
 * Advanced ids resolve to `UnavailableLayer` no-ops.
 */
export function createGlobeLayers(options: CreateLayerOptions = {}): RegisteredLayer[] {
  const available: RegisteredLayer[] = [
    new BaseWorldLayer(),
    new SarRasterLayer(options.rasterProviderFactory),
    new SarSceneFootprintLayer(),
    new LandMaskLayer(),
    new SarDetectionsLayer(),
    new AisContactsLayer(),
    new AisTrailsLayer(),
    new CorrelationLinksLayer(),
    new UncertaintyRadiiLayer(),
    new SelectedTargetLayer(),
    new CfarDebugLayer(),
  ];
  const advanced: LayerId[] = [
    'MULTIPASS_TRACKS',
    'WAKE_GEOMETRY',
    'ML_OUTPUT',
    'TEMPORAL_ANOMALIES',
  ];
  return [...available, ...advanced.map((id) => new UnavailableLayer(id))];
}

export function createGlobeLayer(id: LayerId, options: CreateLayerOptions = {}): RegisteredLayer {
  const layer = createGlobeLayers(options).find((candidate) => candidate.config.id === id);
  if (!layer) throw new Error(`[darkfleet] no implementation for layer: ${id}`);
  return layer;
}