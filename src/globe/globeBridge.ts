/**
 * The connection between a scan result and the globe.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `main.tsx` created a Cesium viewer and parked it on `window.__darkfleetViewer`
 * with the comment "CP9 wires the LayerRegistry to this viewer". It never did.
 * `LayerRegistry` was constructed only inside its own test file, no code called
 * `viewer.entities.add`, and the globe stayed a dark empty sphere: a scan could
 * report 23 detections and the map showed none of them, because the layer panel
 * was a set of switches connected to nothing.
 *
 * This module is that wiring, and it is the ONLY place that knows how scan data
 * reaches Cesium. The shell stays free of Cesium logic.
 *
 * Honesty rules:
 *  - Data is pushed only from a real, completed scan result. There is no
 *    placeholder, preview or sample payload.
 *  - `undefined` for a layer CLEARS it. Pushing null or undefined must not leave
 *    the previous scan's marks on the globe, which would be a stale reading
 *    presented as current.
 *  - Layer visibility is taken from the registry config, so a layer the user has
 *    switched off stays off.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Viewer } from 'cesium';

import { LayerRegistry } from './registry.ts';
import type { LayerId } from '../types/api.ts';
import {
  aisMarks,
  detectionMarks,
  footprint,
  linkMarks,
  scanLayers,
} from './scanLayers.ts';
import type { ScanResult } from '../types/api.ts';

/** The layers this bridge feeds, in the order they are pushed. */
export const BRIDGE_LAYERS: readonly LayerId[] = [
  'SAR_SCENE_FOOTPRINT',
  'SAR_DETECTIONS',
  'UNCERTAINTY_RADII',
  'AIS_CONTACTS',
  'CORRELATION_LINKS',
];

/**
 * Build a registry pre-loaded with the drawing layers and bound to a viewer.
 *
 * Returns the registry so the caller can drive `setVisible`. The viewer is set
 * immediately so `update` works without a separate call.
 */
export function createGlobeBridge(viewer: Viewer): LayerRegistry {
  const registry = new LayerRegistry();
  for (const layer of scanLayers()) registry.register(layer);
  registry.setViewer(viewer);
  return registry;
}

/**
 * Push one completed scan result onto the globe.
 *
 * Passing `undefined` clears every layer, which is what a fresh scan start or a
 * scan failure must do: the previous scan's detections are still real
 * measurements, but they are measurements of somewhere else, and leaving them up
 * next to a new AOI would be a lie about what the map shows.
 */
export function pushScanResult(
  registry: LayerRegistry,
  viewer: Viewer,
  result: ScanResult | null | undefined,
): void {
  if (viewer.isDestroyed?.()) return;

  if (!result) {
    for (const id of BRIDGE_LAYERS) registry.update(id, undefined);
    return;
  }

  const detections = detectionMarks(result.targets ?? []);
  // Keyed by the layers this bridge feeds, not by every LayerId: the remaining
  // layers have no scan-data source and are driven by the layer panel alone.
  const data: Partial<Record<LayerId, unknown>> = {
    SAR_SCENE_FOOTPRINT: footprint(result),
    SAR_DETECTIONS: detections,
    UNCERTAINTY_RADII: detections,
    AIS_CONTACTS: aisMarks(result),
    CORRELATION_LINKS: linkMarks(result.targets ?? []),
  };

  for (const id of BRIDGE_LAYERS) registry.update(id, data[id]);
}

/** Release every Cesium resource the bridge owns. Safe to call repeatedly. */
export function disposeGlobeBridge(registry: LayerRegistry | null): void {
  if (!registry) return;
  try {
    registry.disposeAll();
  } catch {
    // Teardown must not throw: a leaked entity is cosmetic, an exception during
    // unmount can take the whole tree down with it.
  }
}

/** Counts per layer, for the status readout and for tests. */
export function layerCounts(result: ScanResult): Record<string, number> {
  const detections = detectionMarks(result.targets ?? []);
  return {
    SAR_SCENE_FOOTPRINT: footprint(result) ? 1 : 0,
    SAR_DETECTIONS: detections.length,
    UNCERTAINTY_RADII: detections.filter((d) => d.uncertaintyRadiusM !== null).length,
    AIS_CONTACTS: aisMarks(result).length,
    CORRELATION_LINKS: linkMarks(result.targets ?? []).length,
  };
}