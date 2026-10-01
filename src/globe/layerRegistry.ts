/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet Layer Registry
 * Centralized, declarative layer lifecycle and visibility orchestration for CesiumJS.
 * Ensures deterministic resource cleanup, disposal, and telemetry bindings.
 */

import { Viewer } from 'cesium';
import { LayerConfig, LayerId } from '../types/darkfleet.ts';

export interface RegisteredLayer {
  config: LayerConfig;
  mount: (viewer: Viewer) => void;
  update: (viewer: Viewer, data?: any) => void;
  setVisible: (viewer: Viewer, visible: boolean) => void;
  setOpacity?: (viewer: Viewer, opacity: number) => void;
  dispose: (viewer: Viewer) => void;
}

export class LayerRegistry {
  private layers = new Map<LayerId, RegisteredLayer>();
  private viewer: Viewer | null = null;

  constructor(viewer?: Viewer) {
    if (viewer) {
      this.viewer = viewer;
    }
  }

  setViewer(viewer: Viewer) {
    this.viewer = viewer;
    // Mount all currently registered layers
    this.layers.forEach((layer) => {
      try {
        layer.mount(viewer);
      } catch (err) {
        console.warn(`Failed to mount layer ${layer.config.id}:`, err);
      }
    });
  }

  register(layer: RegisteredLayer) {
    if (this.layers.has(layer.config.id)) {
      this.unregister(layer.config.id);
    }
    this.layers.set(layer.config.id, layer);
    if (this.viewer) {
      try {
        layer.mount(this.viewer);
      } catch (err) {
        console.warn(`Failed to mount layer ${layer.config.id}:`, err);
      }
    }
  }

  unregister(id: LayerId) {
    const layer = this.layers.get(id);
    if (layer && this.viewer) {
      try {
        layer.dispose(this.viewer);
      } catch (err) {
        console.warn(`Failed to dispose layer ${id}:`, err);
      }
    }
    this.layers.delete(id);
  }

  getAll(): LayerConfig[] {
    return Array.from(this.layers.values()).map((l) => l.config);
  }

  get(id: LayerId): LayerConfig | undefined {
    return this.layers.get(id)?.config;
  }

  setVisible(id: LayerId, visible: boolean) {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.config.visible = visible;
    if (this.viewer) {
      try {
        layer.setVisible(this.viewer, visible);
      } catch (err) {
        console.warn(`Failed to set visibility on layer ${id}:`, err);
      }
    }
  }

  setOpacity(id: LayerId, opacity: number) {
    const layer = this.layers.get(id);
    if (!layer || layer.setOpacity === undefined) return;
    layer.config.opacity = Math.max(0, Math.min(1, opacity));
    if (this.viewer) {
      try {
        layer.setOpacity(this.viewer, layer.config.opacity);
      } catch (err) {
        console.warn(`Failed to set opacity on layer ${id}:`, err);
      }
    }
  }

  updateLayerData(id: LayerId, data: any) {
    const layer = this.layers.get(id);
    if (!layer || !this.viewer) return;
    try {
      layer.update(this.viewer, data);
    } catch (err) {
      console.warn(`Failed to update layer ${id}:`, err);
    }
  }

  disposeAll() {
    if (!this.viewer) return;
    this.layers.forEach((layer) => {
      try {
        layer.dispose(this.viewer!);
      } catch (err) {
        console.warn(`Failed to dispose layer ${layer.config.id}:`, err);
      }
    });
    this.layers.clear();
    this.viewer = null;
  }
}

export const DEFAULT_LAYERS: LayerConfig[] = [
  {
    id: 'BASE_WORLD',
    title: 'Earth Night Basemap',
    group: 'BASE',
    visible: true,
    opacity: 1.0,
    source: 'Cesium Dark Oceanic Ellipsoid',
  },
  {
    id: 'SAR_RASTER',
    title: 'SAR Backscatter (dB)',
    group: 'SAR',
    visible: true,
    opacity: 0.85,
    source: 'Sentinel-1 C-Band GRD (10m)',
  },
  {
    id: 'SAR_HEATMAP',
    title: 'SAR Radiance Heatmap',
    group: 'SAR',
    visible: true,
    opacity: 0.70,
    source: 'Thermal / Pseudocolor SAR Backscatter',
  },
  {
    id: 'SAR_FOOTPRINT',
    title: 'Scene AOI Footprint',
    group: 'SAR',
    visible: true,
    opacity: 1.0,
    source: 'STAC Bounding Geometry',
  },
  {
    id: 'SAR_DETECTIONS',
    title: 'Radar Detections & Reticles',
    group: 'SAR',
    visible: true,
    opacity: 1.0,
    source: 'CA-CFAR Target Centroids',
  },
  {
    id: 'AIS_CONTACTS',
    title: 'AIS Transponder Broadcasts',
    group: 'AIS',
    visible: true,
    opacity: 1.0,
    source: 'S-AIS / Terrestrial Kinematic Cache',
  },
  {
    id: 'AIS_TRAILS',
    title: 'AIS Velocity Vectors',
    group: 'AIS',
    visible: true,
    opacity: 1.0,
    source: 'AIS SOG / COG Dead Reckoning',
  },
  {
    id: 'CORRELATION_LINKS',
    title: 'Spatio-Temporal Tethers',
    group: 'CORRELATION',
    visible: true,
    opacity: 1.0,
    source: 'Bipartite Association Graph',
  },
  {
    id: 'UNCERTAINTY',
    title: 'Dynamic Match Radii',
    group: 'CORRELATION',
    visible: true,
    opacity: 0.5,
    source: 'Geodesic Kinematic Error Bounds',
  },
  {
    id: 'LAND_MASK',
    title: 'Coastline Exclusion Mask',
    group: 'BASE',
    visible: true,
    opacity: 0.9,
    source: 'GSHHG High-Resolution Shorelines',
  },
];
