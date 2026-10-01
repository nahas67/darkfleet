/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * World-Space Target Entity Manager for CesiumJS
 * Renders radar detection reticles, heading vectors, correlation links,
 * and Kelvin wake vectors with restrained aerospace design aesthetics.
 */

import {
  Viewer,
  Entity,
  Cartesian3,
  Cartesian2,
  Color,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  HorizontalOrigin,
  NearFarScalar,
  DistanceDisplayCondition,
} from 'cesium';

import { VesselTarget } from '../types/darkfleet.ts';

export interface TargetEntitiesOptions {
  viewer: Viewer;
  targets: VesselTarget[];
  selectedTargetId: string | null;
  hoveredTargetId: string | null;
  showDetections: boolean;
  showCorrelationLinks: boolean;
  showWakes: boolean;
  onSelectTarget: (target: VesselTarget | null) => void;
  onHoverTarget: (target: VesselTarget | null) => void;
}

// Generate minimal diamond / reticle canvas pins
function generateTargetPin(classification: string, isSelected: boolean, isHovered: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const size = isSelected ? 48 : isHovered ? 40 : 28;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const center = size / 2;
  const half = isSelected ? 12 : isHovered ? 10 : 7;

  let color = '#5cffc6'; // SAR_MATCHED_AIS
  if (classification === 'SAR_UNMATCHED') {
    color = '#ff6b6b';
  } else if (classification === 'STATIONARY_OR_INFRASTRUCTURE') {
    color = '#38bdf8';
  } else if (classification === 'AIS_ONLY') {
    color = '#ffc76b';
  } else if (classification === 'LOW_CONFIDENCE' || classification === 'SEA_CLUTTER') {
    color = '#94a3b8';
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 2.0 : 1.4;

  if (classification === 'STATIONARY_OR_INFRASTRUCTURE') {
    // Fixed platform: square
    ctx.strokeRect(center - half, center - half, half * 2, half * 2);
    ctx.fillStyle = color;
    ctx.fillRect(center - 2, center - 2, 4, 4);
  } else {
    // Vessel: Diamond
    ctx.beginPath();
    ctx.moveTo(center, center - half);
    ctx.lineTo(center + half, center);
    ctx.lineTo(center, center + half);
    ctx.lineTo(center - half, center);
    ctx.closePath();
    ctx.stroke();

    // Small center dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(center, center, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Selected reticle corner ticks
  if (isSelected) {
    const tickLen = 6;
    const r = half + 4;
    // Top-Left
    ctx.beginPath();
    ctx.moveTo(center - r, center - r + tickLen);
    ctx.lineTo(center - r, center - r);
    ctx.lineTo(center - r + tickLen, center - r);
    // Top-Right
    ctx.moveTo(center + r - tickLen, center - r);
    ctx.lineTo(center + r, center - r);
    ctx.lineTo(center + r, center - r + tickLen);
    // Bottom-Left
    ctx.moveTo(center - r, center + r - tickLen);
    ctx.lineTo(center - r, center + r);
    ctx.lineTo(center - r + tickLen, center + r);
    // Bottom-Right
    ctx.moveTo(center + r - tickLen, center + r);
    ctx.lineTo(center + r, center + r);
    ctx.lineTo(center + r, center + r - tickLen);
    ctx.stroke();
  }

  return canvas;
}

export class TargetEntityManager {
  private viewer: Viewer;
  private targetEntities = new Map<string, Entity>();
  private vectorEntities: Entity[] = [];
  private handler: ScreenSpaceEventHandler | null = null;
  private targetsMap = new Map<string, VesselTarget>();

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  public initInteractions(
    onSelect: (target: VesselTarget | null) => void,
    onHover: (target: VesselTarget | null) => void
  ): void {
    if (this.handler) {
      this.handler.destroy();
    }

    this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

    // Left click selects target
    this.handler.setInputAction((click: any) => {
      const picked = this.viewer.scene.pick(click.position);
      if (defined(picked) && picked.id && typeof picked.id === 'object' && picked.id._targetData) {
        onSelect(picked.id._targetData);
      } else {
        onSelect(null);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Mouse move hover
    this.handler.setInputAction((movement: any) => {
      const picked = this.viewer.scene.pick(movement.endPosition);
      if (defined(picked) && picked.id && typeof picked.id === 'object' && picked.id._targetData) {
        onHover(picked.id._targetData);
      } else {
        onHover(null);
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  public update({
    targets,
    selectedTargetId,
    hoveredTargetId,
    showDetections = true,
    showCorrelationLinks = true,
    showWakes = true,
  }: Omit<TargetEntitiesOptions, 'viewer' | 'onSelectTarget' | 'onHoverTarget'>): void {
    this.clear();
    this.targetsMap.clear();

    if (!showDetections || !targets || targets.length === 0) return;

    targets.forEach((target) => {
      this.targetsMap.set(target.id, target);
      const isSelected = target.id === selectedTargetId;
      const isHovered = target.id === hoveredTargetId;

      const pinCanvas = generateTargetPin(target.classification, isSelected, isHovered);

      // Label text: only show if selected, hovered, or camera within 40 km
      const labelText = isSelected || isHovered ? `${target.id} ~${target.estimatedLengthMeters}m` : target.id;
      const labelColor =
        target.classification === 'SAR_UNMATCHED'
          ? Color.fromCssColorString('#ff6b6b')
          : target.classification === 'STATIONARY_OR_INFRASTRUCTURE'
          ? Color.fromCssColorString('#38bdf8')
          : target.classification === 'AIS_ONLY'
          ? Color.fromCssColorString('#ffc76b')
          : Color.fromCssColorString('#5cffc6');

      const entity = this.viewer.entities.add({
        position: Cartesian3.fromDegrees(target.position.lon, target.position.lat),
        billboard: {
          image: pinCanvas,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1.5e3, 1.2, 5.0e6, 0.4),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: labelText,
          font: '10px "JetBrains Mono", monospace',
          fillColor: labelColor,
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(6, 9, 13, 0.85)'),
          horizontalOrigin: HorizontalOrigin.LEFT,
          pixelOffset: new Cartesian2(16, 0),
          distanceDisplayCondition: isSelected || isHovered

            ? undefined
            : new DistanceDisplayCondition(0, 150000),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });

      // Attach custom reference
      (entity as any)._targetData = target;
      this.targetEntities.set(target.id, entity);

      // Heading vector line
      const headingRad = (target.estimatedHeadingDeg * Math.PI) / 180;
      const vectorLenMeters = Math.max(300, target.estimatedLengthMeters * 3.5);
      // Rough degree offsets
      const dLat = (vectorLenMeters / 111320) * Math.cos(headingRad);
      const dLon = (vectorLenMeters / (111320 * Math.cos((target.position.lat * Math.PI) / 180))) * Math.sin(headingRad);

      const vectorEntity = this.viewer.entities.add({
        polyline: {
          positions: [
            Cartesian3.fromDegrees(target.position.lon, target.position.lat),
            Cartesian3.fromDegrees(target.position.lon + dLon, target.position.lat + dLat),
          ],
          width: isSelected ? 2.0 : 1.2,
          material: labelColor,
          clampToGround: true,
        },
      });
      this.vectorEntities.push(vectorEntity);

      // Kelvin wake lines (if visible)
      if (showWakes && target.wakeVisible) {
        const sternHeadingRad = headingRad + Math.PI;
        const wakeLenM = 1500;
        const wakeDLat = (wakeLenM / 111320) * Math.cos(sternHeadingRad);
        const wakeDLon = (wakeLenM / (111320 * Math.cos((target.position.lat * Math.PI) / 180))) * Math.sin(sternHeadingRad);

        const wakeEntity = this.viewer.entities.add({
          polyline: {
            positions: [
              Cartesian3.fromDegrees(target.position.lon, target.position.lat),
              Cartesian3.fromDegrees(target.position.lon + wakeDLon, target.position.lat + wakeDLat),
            ],
            width: 1.0,
            material: new PolylineDashMaterialProperty({
              color: Color.fromCssColorString('rgba(98, 232, 255, 0.4)'),
              dashLength: 8,
            }),
            clampToGround: true,
          },
        });
        this.vectorEntities.push(wakeEntity);
      }

      // Correlation Tether Line (connecting radar return to predicted AIS position)
      if (
        showCorrelationLinks &&
        target.aisCorrelation.matched &&
        target.aisCorrelation.predictedLat &&
        target.aisCorrelation.predictedLon
      ) {
        const tetherEntity = this.viewer.entities.add({
          polyline: {
            positions: [
              Cartesian3.fromDegrees(target.position.lon, target.position.lat),
              Cartesian3.fromDegrees(
                target.aisCorrelation.predictedLon,
                target.aisCorrelation.predictedLat
              ),
            ],
            width: isSelected ? 1.8 : 1.0,
            material: new PolylineDashMaterialProperty({
              color: Color.fromCssColorString('rgba(92, 255, 198, 0.6)'),
              dashLength: 6,
            }),
            clampToGround: true,
          },
        });
        this.vectorEntities.push(tetherEntity);
      }
    });
  }

  public clear(): void {
    this.targetEntities.forEach((entity) => this.viewer.entities.remove(entity));
    this.targetEntities.clear();
    this.vectorEntities.forEach((entity) => this.viewer.entities.remove(entity));
    this.vectorEntities = [];
  }

  public destroy(): void {
    this.clear();
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
  }
}
