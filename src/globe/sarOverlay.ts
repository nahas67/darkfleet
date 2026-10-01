/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Georeferenced SAR Raster Overlay for CesiumJS
 * Renders calibrated Sentinel-1 C-Band backscatter onto the 3D globe surface
 * using high-resolution offscreen canvas textures.
 */

import { Viewer, Entity, Rectangle, Color, SingleTileImageryProvider, ImageryLayer } from 'cesium';
import { BoundingBox } from '../types/darkfleet.ts';

export interface SarOverlayOptions {
  viewer: Viewer;
  rasterGrid: number[][];
  landMask?: boolean[][];
  bbox: BoundingBox;
  colorMode: 'sar-mono' | 'contrast' | 'thermal';
  showLandMask: boolean;
  opacity?: number;
}

export class SarOverlayManager {
  private viewer: Viewer;
  private currentEntity: Entity | null = null;
  private canvas: HTMLCanvasElement;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.canvas = document.createElement('canvas');
  }

  public update({
    rasterGrid,
    landMask,
    bbox,
    colorMode = 'sar-mono',
    showLandMask = true,
    opacity = 0.88,
  }: Omit<SarOverlayOptions, 'viewer'>): void {
    if (!rasterGrid || rasterGrid.length === 0 || !rasterGrid[0] || rasterGrid[0].length === 0) {
      this.clear();
      return;
    }

    const height = rasterGrid.length;
    const width = rasterGrid[0].length;
    this.canvas.width = width;
    this.canvas.height = height;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const db = rasterGrid[y][x];
        const isLand = landMask && landMask[y]?.[x];

        // Normalize dB (-28 dB to +5 dB) to 0..255
        const norm = Math.max(0, Math.min(1, (db + 28) / 33));
        const byteVal = Math.round(norm * 255);

        if (isLand && showLandMask) {
          // Coastline / island exclusion mask: deep slate navy
          data[idx] = 10;
          data[idx + 1] = 22;
          data[idx + 2] = 30;
          data[idx + 3] = 210;
        } else if (colorMode === 'sar-mono') {
          // Authentic monochrome SAR: black ocean, gray sea clutter, brilliant white returns
          data[idx] = byteVal;
          data[idx + 1] = byteVal;
          data[idx + 2] = byteVal;
          data[idx + 3] = Math.max(160, Math.round(byteVal * 1.05));
        } else if (colorMode === 'contrast') {
          // High contrast stretch
          const boosted = Math.min(255, Math.pow(norm, 1.4) * 310);
          data[idx] = boosted;
          data[idx + 1] = boosted;
          data[idx + 2] = boosted;
          data[idx + 3] = 220;
        } else {
          // Muted thermal radar scale
          data[idx] = Math.round(byteVal * 0.95);
          data[idx + 1] = Math.round(byteVal * 0.45);
          data[idx + 2] = Math.round((255 - byteVal) * 0.5);
          data[idx + 3] = 220;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const [minLon, minLat, maxLon, maxLat] = bbox;
    const rectangle = Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);

    if (this.currentEntity) {
      this.viewer.entities.remove(this.currentEntity);
    }

    this.currentEntity = this.viewer.entities.add({
      rectangle: {
        coordinates: rectangle as any,
        material: this.canvas as any,
        classificationType: undefined,
      },
    });

  }

  public setVisible(visible: boolean): void {
    if (this.currentEntity) {
      this.currentEntity.show = visible;
    }
  }

  public clear(): void {
    if (this.currentEntity) {
      this.viewer.entities.remove(this.currentEntity);
      this.currentEntity = null;
    }
  }
}
