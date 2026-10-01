/**
 * `useGlobeLayers` — the single hook that binds the authoritative LayerRegistry
 * to the live Cesium Viewer and to the shell store (UI-006, UI-031..033).
 *
 * Responsibilities, in order:
 *  1. register every layer implementation exactly once (idempotent),
 *  2. hand the Viewer to the registry when it appears, release it on unmount,
 *  3. mirror store visibility and opacity onto the registry,
 *  4. push backend scan payloads into the layers that are enabled.
 *
 * It holds no data of its own: every value comes from the backend response, so a
 * scan with zero targets renders zero primitives. The whole synchronisation is
 * factored into the pure `syncGlobeLayers`, which is unit tested without React.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Viewer } from 'cesium';
import { LayerRegistry } from './registry.ts';
import type { RegisteredLayer } from './registry.ts';
import { createGlobeLayers } from './layers.ts';
import type { CreateLayerOptions } from './layers.ts';
import { appStore, isLayerEnabled, useStoreState } from '../app/state.ts';
import type { AppState, AppStore, LayerId } from '../app/state.ts';
import type { AisOnlyTarget, ScanResult, VesselTarget } from '../types/api.ts';
import type { DebugLayerResponse } from '../app/useApi.ts';

/** Layers this hook feeds with backend payloads. */
export const PUSHED_LAYER_IDS: readonly LayerId[] = [
  'SAR_RASTER',
  'SAR_SCENE_FOOTPRINT',
  'LAND_MASK',
  'SAR_DETECTIONS',
  'AIS_CONTACTS',
  'AIS_TRAILS',
  'CORRELATION_LINKS',
  'UNCERTAINTY_RADII',
  'SELECTED_TARGET',
  'CFAR_DEBUG',
];

/** Backend payloads the hook forwards to the layers. */
export interface GlobeLayerPayloads {
  /** Backend SAR raster. Absent renders no imagery. */
  readonly raster?: Record<string, unknown> | null;
  /** The active scan: drives footprint, detections, links and radii. */
  readonly scan?: ScanResult | null;
  /** AIS trails (already grouped) or raw observations to group by MMSI. */
  readonly ais?: { trails?: unknown; observations?: unknown } | null;
  /** `landmask` from `/api/debug/{scan}/{layer}`. */
  readonly landMask?: DebugLayerResponse | null;
  /** `detection_mask` from `/api/debug/{scan}/{layer}`. */
  readonly cfarDebug?: DebugLayerResponse | null;
}

export interface UseGlobeLayersOptions extends GlobeLayerPayloads {
  /** The Cesium Viewer. `null` until the globe mounts. */
  readonly viewer?: Viewer | null;
  /** Injectable store; defaults to the process store. */
  readonly store?: AppStore;
  /** Injectable registry; defaults to one created for this hook instance. */
  readonly registry?: LayerRegistry;
  /** Injectable layers; defaults to `createGlobeLayers()`. */
  readonly layers?: readonly RegisteredLayer[];
  /** Passed to `createGlobeLayers` when `layers` is not supplied. */
  readonly layerOptions?: CreateLayerOptions;
}

/**
 * Turn a debug-layer response into a `{ bbox, grid }` mask payload. Returns null
 * when the endpoint returned no grid or the scan carried no AOI: a debug layer
 * without a mask renders nothing rather than inventing an extent.
 */
export function debugMaskPayload(
  response: DebugLayerResponse | null | undefined,
  scan: ScanResult | null | undefined,
): { bbox: number[]; grid: unknown } | null {
  if (!response || !Array.isArray(response.grid) || response.grid.length === 0) return null;
  const bbox = scan?.aoi;
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  return { bbox, grid: response.grid };
}

/**
 * Push store state and backend payloads into the registry.
 *
 * Pure and idempotent: calling it twice with the same inputs leaves the viewer
 * with the same primitives, because every layer clears before it rebuilds.
 */
export function syncGlobeLayers(
  registry: LayerRegistry,
  state: AppState,
  payloads: GlobeLayerPayloads = {},
): void {
  const ids = Object.keys(state.layers) as LayerId[];
  for (const id of ids) {
    registry.setVisible(id, isLayerEnabled(state, id));
    registry.setOpacity(id, state.layers[id].opacity);
  }

  const enabled = (id: LayerId): boolean => isLayerEnabled(state, id);
  const { scan = null, ais = null, raster = null, landMask = null, cfarDebug = null } = payloads;
  const targets: VesselTarget[] = scan?.targets ?? [];
  const aisOnly: AisOnlyTarget[] = scan?.ais_only ?? [];

  if (enabled('SAR_RASTER')) {
    registry.update(
      'SAR_RASTER',
      raster ?? (scan ? { asset_href: scan.scene?.asset_href, aoi: scan.aoi } : null),
    );
  }
  if (enabled('SAR_SCENE_FOOTPRINT')) {
    registry.update('SAR_SCENE_FOOTPRINT', { aoi: scan?.aoi });
  }
  if (enabled('LAND_MASK')) {
    registry.update('LAND_MASK', debugMaskPayload(landMask, scan));
  }
  if (enabled('SAR_DETECTIONS')) registry.update('SAR_DETECTIONS', targets);
  if (enabled('AIS_CONTACTS')) registry.update('AIS_CONTACTS', aisOnly);
  if (enabled('AIS_TRAILS')) {
    registry.update('AIS_TRAILS', ais ?? { observations: aisOnly });
  }
  if (enabled('CORRELATION_LINKS')) registry.update('CORRELATION_LINKS', targets);
  if (enabled('UNCERTAINTY_RADII')) registry.update('UNCERTAINTY_RADII', targets);
  if (enabled('SELECTED_TARGET')) {
    registry.update('SELECTED_TARGET', { targetId: state.selectedTargetId, targets });
  }
  if (enabled('CFAR_DEBUG')) {
    registry.update('CFAR_DEBUG', debugMaskPayload(cfarDebug, scan));
  }
}

export function useGlobeLayers(options: UseGlobeLayersOptions = {}): LayerRegistry {
  const store = options.store ?? appStore;
  const state = useStoreState(store);
  const layers = useMemo<RegisteredLayer[]>(
    () => (options.layers ? [...options.layers] : createGlobeLayers(options.layerOptions ?? {})),
    [options.layers],
  );
  const registry = useMemo(() => options.registry ?? new LayerRegistry(), [options.registry]);
  // Registration runs exactly once per registry, no matter how often we render.
  const registered = useRef(false);
  if (!registered.current) {
    for (const layer of layers) registry.register(layer);
    registered.current = true;
  }

  const { viewer, raster, scan, ais, landMask, cfarDebug } = options;

  useEffect(() => {
    if (viewer) registry.setViewer(viewer);
  }, [registry, viewer]);

  useEffect(() => {
    syncGlobeLayers(registry, state, { raster, scan, ais, landMask, cfarDebug });
  }, [registry, state, raster, scan, ais, landMask, cfarDebug]);

  useEffect(
    () => () => {
      registry.disposeAll();
    },
    [registry],
  );

  return registry;
}

export default useGlobeLayers;