/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Scene Footprint & AOI Geometry Renderer
 * Renders satellite acquisition swath boundaries and scan pass sweeps in world space.
 */

import { Viewer, Entity, Rectangle, Color, Cartesian3, PolylineDashMaterialProperty } from 'cesium';
import { BoundingBox } from '../types/darkfleet.ts';

export class SceneFootprintManager {
  private viewer: Viewer;
  private footprintEntity: Entity | null = null;
  private borderEntities: Entity[] = [];
  private sweepEntity: Entity | null = null;
  private isSweeping = false;
  private sweepProgress = 0;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  public update(bbox: BoundingBox, isScanning = false): void {
    this.clear();

    const [minLon, minLat, maxLon, maxLat] = bbox;
    const rectangle = Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);

    // Subtle footprint fill
    this.footprintEntity = this.viewer.entities.add({
      rectangle: {
        coordinates: rectangle,
        material: Color.fromCssColorString('rgba(98, 232, 255, 0.03)'),
      },
    });

    // Thin perimeter boundary
    const boundaryPoints = [
      Cartesian3.fromDegrees(minLon, minLat),
      Cartesian3.fromDegrees(maxLon, minLat),
      Cartesian3.fromDegrees(maxLon, maxLat),
      Cartesian3.fromDegrees(minLon, maxLat),
      Cartesian3.fromDegrees(minLon, minLat),
    ];

    const perimeter = this.viewer.entities.add({
      polyline: {
        positions: boundaryPoints,
        width: 1.2,
        material: Color.fromCssColorString('rgba(98, 232, 255, 0.45)'),
        clampToGround: true,
      },
    });
    this.borderEntities.push(perimeter);

    // Corner registration ticks
    const tickSpan = 0.03;
    const corners = [
      { lon: minLon, lat: minLat, dLon: tickSpan, dLat: tickSpan },
      { lon: maxLon, lat: minLat, dLon: -tickSpan, dLat: tickSpan },
      { lon: maxLon, lat: maxLat, dLon: -tickSpan, dLat: -tickSpan },
      { lon: minLon, lat: maxLat, dLon: tickSpan, dLat: -tickSpan },
    ];

    corners.forEach((c) => {
      const hLine = this.viewer.entities.add({
        polyline: {
          positions: [
            Cartesian3.fromDegrees(c.lon, c.lat),
            Cartesian3.fromDegrees(c.lon + c.dLon, c.lat),
          ],
          width: 2.0,
          material: Color.fromCssColorString('#62e8ff'),
          clampToGround: true,
        },
      });
      const vLine = this.viewer.entities.add({
        polyline: {
          positions: [
            Cartesian3.fromDegrees(c.lon, c.lat),
            Cartesian3.fromDegrees(c.lon, c.lat + c.dLat),
          ],
          width: 2.0,
          material: Color.fromCssColorString('#62e8ff'),
          clampToGround: true,
        },
      });
      this.borderEntities.push(hLine, vLine);
    });

    // Orbital pass sweep bar during active scan (sweeps from North to South once)
    if (isScanning) {
      this.triggerSweep(bbox);
    }
  }

  private triggerSweep(bbox: BoundingBox): void {
    if (this.sweepEntity) {
      this.viewer.entities.remove(this.sweepEntity);
      this.sweepEntity = null;
    }

    const [minLon, minLat, maxLon, maxLat] = bbox;
    const latSpan = maxLat - minLat;
    let progress = 0;

    this.sweepEntity = this.viewer.entities.add({
      polyline: {
        positions: [
          Cartesian3.fromDegrees(minLon, maxLat),
          Cartesian3.fromDegrees(maxLon, maxLat),
        ],
        width: 2.5,
        material: Color.fromCssColorString('rgba(98, 232, 255, 0.8)'),
        clampToGround: true,
      },
    });

    const interval = setInterval(() => {
      progress += 0.05;
      if (progress >= 1.0 || !this.sweepEntity) {
        clearInterval(interval);
        if (this.sweepEntity) {
          this.viewer.entities.remove(this.sweepEntity);
          this.sweepEntity = null;
        }
        return;
      }

      const currentLat = maxLat - progress * latSpan;
      if (this.sweepEntity && this.sweepEntity.polyline) {
        (this.sweepEntity.polyline.positions as any) = [
          Cartesian3.fromDegrees(minLon, currentLat),
          Cartesian3.fromDegrees(maxLon, currentLat),
        ];
      }
    }, 50);
  }

  public setVisible(visible: boolean): void {
    if (this.footprintEntity) this.footprintEntity.show = visible;
    this.borderEntities.forEach((e) => (e.show = visible));
  }

  public clear(): void {
    if (this.footprintEntity) {
      this.viewer.entities.remove(this.footprintEntity);
      this.footprintEntity = null;
    }
    this.borderEntities.forEach((e) => this.viewer.entities.remove(e));
    this.borderEntities = [];
    if (this.sweepEntity) {
      this.viewer.entities.remove(this.sweepEntity);
      this.sweepEntity = null;
    }
  }
}
