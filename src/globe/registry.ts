/**
 * Authoritative Cesium layer registry.
 *
 * The globe consumes this ONE registry — nothing else may create imagery
 * layers or entities directly, so repeated scans cannot leak Cesium resources.
 * Advanced layers are declared but marked NOT_AVAILABLE until their CP15
 * implementation exists; the UI hides them rather than rendering fake data.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Cartesian2, Cartesian3, Viewer } from 'cesium';
import type { LayerConfig, LayerId, CapabilityState } from '../types/api.ts';

/** A live Cesium-backed layer with an explicit lifecycle. */
export interface RegisteredLayer {
  config: LayerConfig;
  /** Attach Cesium primitives to the viewer. Idempotent. */
  mount(viewer: Viewer): void;
  /** Push new data. Must clear prior primitives before adding new ones. */
  update(viewer: Viewer, data?: unknown): void;
  setVisible(viewer: Viewer, visible: boolean): void;
  setOpacity(viewer: Viewer, opacity: number): void;
  /** Release every Cesium resource this layer owns. Must be safe to call twice. */
  dispose(viewer: Viewer): void;
}

export const LAYER_DEFS: LayerConfig[] = [
  {
    id: 'BASE_WORLD',
    title: 'Earth / Ocean',
    group: 'REFERENCE',
    visible: true,
    opacity: 1,
    source: 'Cesium ellipsoid + imagery',
    capabilityState: 'AVAILABLE',
    supportsOpacity: false,
  },
  {
    id: 'SAR_RASTER',
    title: 'Sentinel-1 SAR',
    group: 'IMAGERY',
    visible: true,
    opacity: 0.85,
    source: 'Planetary Computer / EarthSearch COG',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'SAR_SCENE_FOOTPRINT',
    title: 'Scene footprint',
    group: 'IMAGERY',
    visible: true,
    opacity: 1,
    source: 'STAC item geometry',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'LAND_MASK',
    title: 'Land / coastline mask',
    group: 'ANALYSIS',
    visible: false,
    opacity: 0.9,
    source: 'ESA WorldCover 10 m',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'SAR_DETECTIONS',
    title: 'SAR detections',
    group: 'CONTACTS',
    visible: true,
    opacity: 1,
    source: 'CA-CFAR connected components',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'AIS_CONTACTS',
    title: 'AIS positions',
    group: 'CONTACTS',
    visible: true,
    opacity: 1,
    source: 'Local AIS archive',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'AIS_TRAILS',
    title: 'AIS tracks',
    group: 'CONTACTS',
    visible: true,
    opacity: 1,
    source: 'Dead-reckoned AIS observations',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'CORRELATION_LINKS',
    title: 'Correlation links',
    group: 'CONTACTS',
    visible: true,
    opacity: 1,
    source: 'Score decomposition (backend)',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'UNCERTAINTY_RADII',
    title: 'Match uncertainty',
    group: 'ANALYSIS',
    visible: false,
    opacity: 0.5,
    source: 'Per-candidate match radius',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'SELECTED_TARGET',
    title: 'Selected target',
    group: 'ANALYSIS',
    visible: true,
    opacity: 1,
    source: 'Active selection',
    capabilityState: 'AVAILABLE',
    supportsOpacity: false,
  },
  {
    id: 'CFAR_DEBUG',
    title: 'CFAR debug overlay',
    group: 'ANALYSIS',
    visible: false,
    opacity: 0.8,
    source: 'Detection mask + thresholds',
    capabilityState: 'AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'MULTIPASS_TRACKS',
    title: 'Multi-pass track hypotheses',
    group: 'INTELLIGENCE',
    visible: false,
    opacity: 1,
    source: 'ADV-001 (CP15)',
    capabilityState: 'NOT_AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'WAKE_GEOMETRY',
    title: 'Wake geometry',
    group: 'ANALYSIS',
    visible: false,
    opacity: 0.9,
    source: 'ADV-004 (CP15)',
    capabilityState: 'NOT_AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'ML_OUTPUT',
    title: 'ML detector output',
    group: 'INTELLIGENCE',
    visible: false,
    opacity: 1,
    source: 'ADV-007 (CP15)',
    capabilityState: 'NOT_AVAILABLE',
    supportsOpacity: true,
  },
  {
    id: 'TEMPORAL_ANOMALIES',
    title: 'Temporal anomalies',
    group: 'INTELLIGENCE',
    visible: false,
    opacity: 1,
    source: 'ADV-009 (CP15)',
    capabilityState: 'NOT_AVAILABLE',
    supportsOpacity: true,
  },
];

export class LayerRegistry {
  private readonly layers = new Map<LayerId, RegisteredLayer>();
  private viewer: Viewer | null = null;

  register(layer: RegisteredLayer): void {
    const existing = this.layers.get(layer.config.id);
    if (existing) this.disposeOne(layer.config.id);
    this.layers.set(layer.config.id, layer);
    if (this.viewer) {
      try {
        layer.mount(this.viewer);
      } catch (err) {
        console.warn(`layer ${layer.config.id} failed to mount:`, err);
      }
    }
  }

  setViewer(viewer: Viewer): void {
    this.viewer = viewer;
    for (const layer of this.layers.values()) {
      try {
        layer.mount(viewer);
      } catch (err) {
        console.warn(`layer ${layer.config.id} failed to mount:`, err);
      }
    }
  }

  private disposeOne(id: LayerId): void {
    const layer = this.layers.get(id);
    if (layer && this.viewer) {
      try {
        layer.dispose(this.viewer);
      } catch (err) {
        console.warn(`layer ${id} failed to dispose:`, err);
      }
    }
    this.layers.delete(id);
  }

  /** Layers available to the UI: NOT_AVAILABLE layers are hidden, not rendered. */
  available(): LayerConfig[] {
    return this.all().filter((l) => l.capabilityState === 'AVAILABLE');
  }

  all(): LayerConfig[] {
    return LAYER_DEFS.map((def) => this.layers.get(def.id)?.config ?? def);
  }

  get(id: LayerId): RegisteredLayer | undefined {
    return this.layers.get(id);
  }

  setVisible(id: LayerId, visible: boolean): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.config.visible = visible;
    if (this.viewer) layer.setVisible(this.viewer, visible);
  }

  setOpacity(id: LayerId, opacity: number): void {
    const layer = this.layers.get(id);
    if (!layer?.config.supportsOpacity) return;
    layer.config.opacity = Math.max(0, Math.min(1, opacity));
    if (this.viewer) layer.setOpacity(this.viewer, layer.config.opacity);
  }

  update(id: LayerId, data: unknown): void {
    const layer = this.layers.get(id);
    if (!layer || !this.viewer || layer.config.capabilityState !== 'AVAILABLE') return;
    layer.update(this.viewer, data);
  }

  capability(id: LayerId): CapabilityState {
    return this.layers.get(id)?.config.capabilityState ?? 'NOT_AVAILABLE';
  }

  /** Release everything. Safe to call repeatedly. */
  disposeAll(): void {
    if (!this.viewer) {
      this.layers.clear();
      return;
    }
    for (const id of [...this.layers.keys()]) this.disposeOne(id);
    this.viewer = null;
  }

  /** Count of registered layers — used by the leak test to prove cleanup. */
  get size(): number {
    return this.layers.size;
  }
}

/** Geometry helper shared by footprint and AOI layers. */
export function bboxPolygon(bbox: [number, number, number, number]): Cartesian3[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return [
    Cartesian3.fromDegrees(minLon, minLat),
    Cartesian3.fromDegrees(maxLon, minLat),
    Cartesian3.fromDegrees(maxLon, maxLat),
    Cartesian3.fromDegrees(minLon, maxLat),
    Cartesian3.fromDegrees(minLon, minLat),
  ];
}

export const IDENTITY_SIZE = new Cartesian2(1, 1);