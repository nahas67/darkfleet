/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * AIS Track & Telemetry Entity Manager
 * Visualizes non-correlated or broadcast AIS records on the CesiumJS globe.
 */

import { Viewer, Entity, Cartesian3, Color, VerticalOrigin, HorizontalOrigin, NearFarScalar } from 'cesium';
import { AISObservation, VesselTarget } from '../types/darkfleet.ts';

export class AISTrackManager {
  private viewer: Viewer;
  private aisEntities: Entity[] = [];

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  public update(
    observations: AISObservation[],
    matchedTargets: VesselTarget[],
    showAisTracks = true
  ): void {
    this.clear();
    if (!showAisTracks || !observations || observations.length === 0) return;

    const matchedMmsis = new Set<string>();
    matchedTargets.forEach((t) => {
      if (t.aisCorrelation.matched && t.aisCorrelation.mmsi) {
        matchedMmsis.add(t.aisCorrelation.mmsi);
      }
    });

    // Create pin canvas for AIS only
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = '#ffc76b';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(10, 10, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 199, 107, 0.2)';
      ctx.fill();
    }

    observations.forEach((obs) => {
      const isMatched = matchedMmsis.has(obs.mmsi);
      if (!isMatched) {
        // Ghost / Transponder without radar signature
        const entity = this.viewer.entities.add({
          position: Cartesian3.fromDegrees(obs.lon, obs.lat),
          billboard: {
            image: canvas,
            verticalOrigin: VerticalOrigin.CENTER,
            horizontalOrigin: HorizontalOrigin.CENTER,
            scaleByDistance: new NearFarScalar(1.5e3, 1.0, 5.0e6, 0.4),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        this.aisEntities.push(entity);
      }
    });
  }

  public clear(): void {
    this.aisEntities.forEach((e) => this.viewer.entities.remove(e));
    this.aisEntities = [];
  }
}
