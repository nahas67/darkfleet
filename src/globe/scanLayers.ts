/**
 * Globe drawing for real scan results.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The layer panel was a set of switches connected to nothing. `LAYER_DEFS`
 * declared ten layers AVAILABLE, `SpatialShell` rendered toggles for them, and
 * `main.tsx` parked the Cesium viewer on `window.__darkfleetViewer` with the
 * comment "CP9 wires the LayerRegistry to this viewer" — which never happened.
 * `LayerRegistry` was only ever constructed inside its own test file, and no
 * code anywhere called `viewer.entities.add`. The globe was a dark empty sphere:
 * a scan could find 23 detections and the map showed none of them.
 *
 * Honesty rules, enforced here rather than promised in prose:
 *
 *  - Every position drawn came from the scan result. A target whose lat/lon is
 *    absent or non-finite is SKIPPED, not placed at (0, 0) or at the AOI centre.
 *  - An uncertainty circle is drawn only when `lenUncM` is a positive finite
 *    measurement. Absent uncertainty is not rendered as a small confident circle.
 *  - A correlation link is drawn only when the association is real:
 *    `corr.matched` true AND a finite predicted position on both ends.
 *  - A detection is never promoted, recoloured, or labelled with a class the
 *    backend did not assign.
 *  - The AOI footprint is drawn only for a bbox of four finite numbers.
 *
 * Layout: the decisions are pure functions over plain data ({@link DetectionMark}
 * and friends) so they can be tested without a WebGL context, and the Cesium
 * adapter at the bottom is a thin translation of those decisions. That split is
 * deliberate — a Cesium-dependent test can only assert that objects were
 * constructed, never that the right ones were.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  Entity,
  LabelStyle,
  Viewer,
} from 'cesium';
import type { RegisteredLayer } from './registry.ts';
import { LAYER_DEFS } from './registry.ts';
import type {
  AisOnlyTarget,
  LayerConfig,
  LayerId,
  ScanResult,
  TargetClassification,
  VesselTarget,
} from '../types/api.ts';

// --------------------------------------------------------------- decisions

/** One detection, ready to draw. Position is real or this mark does not exist. */
export interface DetectionMark {
  readonly targetId: string;
  readonly classification: TargetClassification;
  readonly lat: number;
  readonly lon: number;
  readonly sarConfidence: number;
  /** Association confidence; 0 when the backend established no association. */
  readonly aisConfidence: number;
  /** Uncertainty radius in metres, or null when the backend measured none. */
  readonly uncertaintyRadiusM: number | null;
}

/** One AIS position, from `ais_only` or from an established association. */
export interface AisMark {
  readonly mmsi: string;
  readonly name: string | null;
  readonly lat: number;
  readonly lon: number;
  /** True when this position belongs to a target the backend associated. */
  readonly matched: boolean;
}

/** A real association: detection -> associated AIS predicted position. */
export interface LinkMark {
  readonly targetId: string;
  readonly fromLat: number;
  readonly fromLon: number;
  readonly toLat: number;
  readonly toLon: number;
  readonly confidence: number;
  readonly mmsi: string | null;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validate a position, returning the numbers only if they are usable.
 *
 * Returns the pair rather than a boolean so no caller has to re-assert the
 * type. A latitude outside +/-90 or a longitude outside +/-180 is not a
 * position; it is a corrupt value, and drawing it would put a mark in the
 * ocean. (0, 0) is likewise rejected: it is the classic "unset" sentinel and
 * sits in the Gulf of Guinea, where it would look like a real detection.
 */
function validatedPosition(
  lat: unknown,
  lon: unknown,
): { lat: number; lon: number } | null {
  if (!finite(lat) || !finite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Detections that can be drawn, in the order the backend returned them. */
export function detectionMarks(targets: readonly VesselTarget[]): DetectionMark[] {
  const marks: DetectionMark[] = [];
  for (const t of targets) {
    if (!t) continue;
    const pos = validatedPosition(t.lat, t.lon);
    if (!pos) continue;
    const radius = finite(t.lenUncM) && t.lenUncM > 0 ? t.lenUncM : null;
    marks.push({
      targetId: t.id,
      classification: t.classification,
      lat: pos.lat,
      lon: pos.lon,
      sarConfidence: finite(t.sarConf) ? t.sarConf : 0,
      aisConfidence: finite(t.aisConf) ? t.aisConf : 0,
      uncertaintyRadiusM: radius,
    });
  }
  return marks;
}

/** AIS positions, deduplicated by MMSI so one vessel is not drawn twice. */
export function aisMarks(result: ScanResult): AisMark[] {
  const seen = new Set<string>();
  const marks: AisMark[] = [];

  const push = (
    mmsi: string | null | undefined,
    name: string | null,
    lat: unknown,
    lon: unknown,
    matched: boolean,
  ): void => {
    if (!mmsi || seen.has(mmsi)) return;
    const pos = validatedPosition(lat, lon);
    if (!pos) return;
    seen.add(mmsi);
    marks.push({ mmsi, name, lat: pos.lat, lon: pos.lon, matched });
  };

  for (const t of result.targets ?? []) {
    const c = t?.corr;
    if (!c?.matched || !c.mmsi) continue;
    push(c.mmsi, c.vesselName, c.predictedLat, c.predictedLon, true);
  }
  for (const a of (result.ais_only ?? []) as readonly AisOnlyTarget[]) {
    push(a?.mmsi, a?.vesselName ?? null, a?.lat, a?.lon, false);
  }
  return marks;
}

/**
 * Association links. Drawn only for real associations.
 *
 * A `matched` flag with no predicted position means the backend associated the
 * detection but could not place the vessel; that is a real finding and the
 * evidence endpoint reports it, but there is no second point to draw a line to,
 * so no line is drawn and nothing is invented to stand in for one.
 */
export function linkMarks(targets: readonly VesselTarget[]): LinkMark[] {
  const marks: LinkMark[] = [];
  for (const t of targets) {
    const c = t?.corr;
    if (!c?.matched || !c.mmsi) continue;
    const from = validatedPosition(t.lat, t.lon);
    if (!from) continue;
    const to = validatedPosition(c.predictedLat, c.predictedLon);
    if (!to) continue;
    marks.push({
      targetId: t.id,
      fromLat: from.lat,
      fromLon: from.lon,
      toLat: to.lat,
      toLon: to.lon,
      confidence: finite(c.aisAssociationConfidence) ? c.aisAssociationConfidence : 0,
      mmsi: c.mmsi,
    });
  }
  return marks;
}

/** The AOI footprint, or null when the record carried no usable bbox. */
export function footprint(result: ScanResult): [number, number, number, number] | null {
  const aoi = result?.aoi;
  if (!Array.isArray(aoi) || aoi.length !== 4 || !aoi.every(finite)) return null;
  const [minLon, minLat, maxLon, maxLat] = aoi as number[];
  if (minLon > maxLon || minLat > maxLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

// ----------------------------------------------------------------- styling

/**
 * Colour by classification. `UNMATCHED` is amber and `MATCHED` is teal, so the
 * distinction the operator actually acts on is readable at a glance.
 */
export function classificationColor(c: TargetClassification): Color {
  switch (c) {
    case 'SAR_MATCHED_AIS':
      return Color.fromCssColorString('#66f0c3');
    case 'SAR_UNMATCHED':
      return Color.fromCssColorString('#ffc76b');
    case 'AIS_ONLY':
      return Color.fromCssColorString('#7fb2ff');
    case 'STATIONARY_OR_INFRASTRUCTURE':
      return Color.fromCssColorString('#9aa7b4');
    case 'SEA_CLUTTER':
      return Color.fromCssColorString('#6b7a86');
    case 'LOW_CONFIDENCE':
      return Color.fromCssColorString('#c9a0ff');
    default:
      // UNRESOLVED is deliberately muted: the backend did not resolve it, and a
      // bright mark would overstate what is known.
      return Color.fromCssColorString('#55606b');
  }
}

/** Confidence 0..1 to alpha 0.25..1. Low confidence is drawn faint, not hidden. */
export function confidenceAlpha(c: number): number {
  if (!finite(c)) return 0.25;
  return 0.25 + 0.75 * Math.max(0, Math.min(1, c));
}

function configFor(id: LayerId): LayerConfig {
  const def = LAYER_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`unknown layer id ${id}`);
  return { ...def };
}

// ------------------------------------------------------- Cesium adapter

/**
 * A layer that owns one Cesium entity collection and rebuilds it on update.
 *
 * Entities are removed before being re-added rather than diffed. For the counts
 * this tool produces (tens to low hundreds of marks) a rebuild is imperceptible,
 * and it removes a whole class of bug where a partially updated scene keeps
 * showing marks from a previous scan.
 */
function entityLayer(
  id: LayerId,
  build: (viewer: Viewer, data: unknown) => Entity[],
): RegisteredLayer {
  let owned: Entity[] = [];
  let visible = true;

  const clear = (viewer: Viewer): void => {
    for (const e of owned) {
      const still = viewer.entities.getById(e.id);
      if (still) viewer.entities.remove(still);
    }
    owned = [];
  };

  return {
    config: configFor(id),
    mount(viewer: Viewer): void {
      // No-op: entities are added on the first update, which is what keeps a
      // layer from painting anything before a scan has produced data.
    },
    update(viewer: Viewer, data?: unknown): void {
      clear(viewer);
      if (data === undefined || data === null) return;
      owned = build(viewer, data);
      for (const e of owned) viewer.entities.add(e);
      if (!visible) this.setVisible(viewer, false);
    },
    setVisible(viewer: Viewer, next: boolean): void {
      visible = next;
      for (const e of owned) {
        const still = viewer.entities.getById(e.id);
        if (still) still.show = next;
      }
    },
    setOpacity(_viewer: Viewer, opacity: number): void {
      // Opacity is applied per mark at build time via confidenceAlpha; there is
      // no single material to scale here.
      void opacity;
    },
    dispose(viewer: Viewer): void {
      clear(viewer);
    },
  };
}

/** The layers that actually draw, given the registry ids the UI already offers. */
export function scanLayers(): RegisteredLayer[] {
  return [
    entityLayer('SAR_SCENE_FOOTPRINT', (_viewer, data) => {
      const box = data as [number, number, number, number] | null;
      if (!box) return [];
      const [minLon, minLat, maxLon, maxLat] = box;
      return [
        new Entity({
          id: 'df-aoi-footprint',
          polygon: {
            hierarchy: [
              Cartesian3.fromDegrees(minLon, minLat),
              Cartesian3.fromDegrees(maxLon, minLat),
              Cartesian3.fromDegrees(maxLon, maxLat),
              Cartesian3.fromDegrees(minLon, maxLat),
            ],
            height: 0,
            material: Color.fromCssColorString('#66f0c3').withAlpha(0.08),
            outline: true,
            outlineColor: Color.fromCssColorString('#66f0c3').withAlpha(0.5),
          },
        }),
      ];
    }),

    entityLayer('SAR_DETECTIONS', (_viewer, data) => {
      const marks = data as DetectionMark[];
      return marks.map(
        (m) =>
          new Entity({
            id: `df-detection-${m.targetId}`,
            position: Cartesian3.fromDegrees(m.lon, m.lat),
            point: {
              pixelSize: 9,
              color: classificationColor(m.classification).withAlpha(
                confidenceAlpha(m.sarConfidence),
              ),
              outlineColor: Color.fromCssColorString('#05070a'),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            // The label is the target id and nothing else: no name, no class, no
            // vessel identity, because the backend associated none unless
            // `corr.matched` said so and that is the link layer's job.
            label: {
              text: m.targetId,
              font: '11px monospace',
              fillColor: Color.fromCssColorString('#c8d3dc'),
              showBackground: true,
              backgroundColor: Color.fromCssColorString('#05070a').withAlpha(0.7),
              pixelOffset: new Cartesian2(10, -8),
              style: LabelStyle.FILL_AND_OUTLINE,
              // disableDepthTestDistance keeps a mark visible through terrain, so
              // a detection behind a headland is still findable. Hiding it would
              // make the map look cleaner and lose real detections.
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
      );
    }),

    entityLayer('UNCERTAINTY_RADII', (_viewer, data) => {
      const marks = data as DetectionMark[];
      return marks
        .filter((m) => m.uncertaintyRadiusM !== null && m.uncertaintyRadiusM > 0)
        .map(
          (m) =>
            new Entity({
              id: `df-uncertainty-${m.targetId}`,
              position: Cartesian3.fromDegrees(m.lon, m.lat),
              ellipse: {
                semiMajorAxis: m.uncertaintyRadiusM as number,
                semiMinorAxis: m.uncertaintyRadiusM as number,
                material: Color.fromCssColorString('#ffc76b').withAlpha(0.12),
                outline: true,
                outlineColor: Color.fromCssColorString('#ffc76b').withAlpha(0.45),
                height: 0,
              },
            }),
        );
    }),

    entityLayer('AIS_CONTACTS', (_viewer, data) => {
      const marks = data as AisMark[];
      return marks.map(
        (m) =>
          new Entity({
            id: `df-ais-${m.mmsi}`,
            position: Cartesian3.fromDegrees(m.lon, m.lat),
            point: {
              pixelSize: 7,
              color: Color.fromCssColorString('#7fb2ff').withAlpha(m.matched ? 0.95 : 0.55),
              outlineColor: Color.fromCssColorString('#05070a'),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: m.name ?? m.mmsi,
              font: '10px monospace',
              fillColor: Color.fromCssColorString('#7fb2ff'),
              showBackground: true,
              backgroundColor: Color.fromCssColorString('#05070a').withAlpha(0.7),
              pixelOffset: new Cartesian2(8, 8),
              style: LabelStyle.FILL_AND_OUTLINE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
      );
    }),

    entityLayer('CORRELATION_LINKS', (_viewer, data) => {
      const marks = data as LinkMark[];
      return marks.map(
        (m) =>
          new Entity({
            id: `df-link-${m.targetId}`,
            polyline: {
              positions: [
                Cartesian3.fromDegrees(m.fromLon, m.fromLat),
                Cartesian3.fromDegrees(m.toLon, m.toLat),
              ],
              width: 2,
              material: Color.fromCssColorString('#66f0c3').withAlpha(
                confidenceAlpha(m.confidence),
              ),
              clampToGround: false,
            },
          }),
      );
    }),
  ];
}