/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Tactical Geospatial Canvas Map
 * High-performance radar viewport rendering SAR backscatter rasters,
 * CFAR detections, AIS vectors, correlation links, and Kelvin wakes.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { 
  Eye, 
  EyeOff, 
  Layers, 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Crosshair, 
  BoxSelect, 
  Navigation,
  Compass,
  Flame
} from 'lucide-react';
import { BoundingBox, DisplayOptions, ScanResult, VesselTarget } from '../types/darkfleet.ts';

/**
 * Colormap lookup for SAR microwave backscatter heatmap overlay.
 * Maps normalized dB (-28 dB to +5 dB) to vibrant pseudocolor gradients.
 */
function getHeatmapRgb(t: number, palette: 'turbo' | 'thermal' | 'plasma' = 'thermal'): [number, number, number] {
  t = Math.max(0, Math.min(1, t));

  if (palette === 'plasma') {
    // Plasma: Dark Purple -> Magenta -> Orange-Red -> Bright Yellow
    if (t < 0.25) {
      const f = t / 0.25;
      return [Math.round(15 + f * 95), Math.round(5 + f * 10), Math.round(80 + f * 85)];
    } else if (t < 0.5) {
      const f = (t - 0.25) / 0.25;
      return [Math.round(110 + f * 90), Math.round(15 + f * 55), Math.round(165 - f * 85)];
    } else if (t < 0.75) {
      const f = (t - 0.5) / 0.25;
      return [Math.round(200 + f * 45), Math.round(70 + f * 90), Math.round(80 * (1 - f))];
    } else {
      const f = (t - 0.75) / 0.25;
      return [Math.round(245 + f * 10), Math.round(160 + f * 95), Math.round(20 + f * 80)];
    }
  } else if (palette === 'turbo') {
    // Turbo: Deep Blue -> Cyan -> Emerald Green -> Amber -> Deep Crimson
    if (t < 0.2) {
      const f = t / 0.2;
      return [Math.round(30 * (1 - f)), Math.round(40 + f * 140), Math.round(160 + f * 95)];
    } else if (t < 0.4) {
      const f = (t - 0.2) / 0.2;
      return [0, Math.round(180 + f * 60), Math.round(255 * (1 - f) + 50 * f)];
    } else if (t < 0.65) {
      const f = (t - 0.4) / 0.25;
      return [Math.round(f * 240), Math.round(240 - f * 30), 0];
    } else if (t < 0.85) {
      const f = (t - 0.65) / 0.2;
      return [Math.round(240 + f * 15), Math.round(210 * (1 - f) + 40 * f), 0];
    } else {
      const f = (t - 0.85) / 0.15;
      return [255, Math.round(40 * (1 - f)), Math.round(f * 50)];
    }
  } else {
    // Thermal (Default): Deep Indigo -> Cyan -> Vivid Emerald -> Radiant Amber -> Crimson -> White-Hot
    if (t < 0.18) {
      const f = t / 0.18;
      return [Math.round(5 + f * 10), Math.round(20 + f * 150), Math.round(90 + f * 140)];
    } else if (t < 0.42) {
      const f = (t - 0.18) / 0.24;
      return [Math.round(15 + f * 15), Math.round(170 + f * 75), Math.round(230 * (1 - f) + 60 * f)];
    } else if (t < 0.68) {
      const f = (t - 0.42) / 0.26;
      return [Math.round(30 + f * 225), Math.round(245 - f * 35), Math.round(60 * (1 - f))];
    } else if (t < 0.88) {
      const f = (t - 0.68) / 0.20;
      return [255, Math.round(210 * (1 - f) + 35 * f), Math.round(15 * f)];
    } else {
      const f = (t - 0.88) / 0.12;
      return [255, Math.round(35 + f * 220), Math.round(15 + f * 240)];
    }
  }
}

interface TacticalMapProps {
  scanResult: ScanResult | null;
  selectedTarget: VesselTarget | null;
  onSelectTarget: (target: VesselTarget | null) => void;
  rasterGrid?: number[][];
  landMask?: boolean[][];
  onBoxSelected?: (bbox: BoundingBox) => void;
  displayOptions?: DisplayOptions;
  onUpdateDisplayOptions?: (opts: Partial<DisplayOptions>) => void;
}

export const TacticalMap: React.FC<TacticalMapProps> = ({
  scanResult,
  selectedTarget,
  onSelectTarget,
  rasterGrid,
  landMask,
  onBoxSelected,
  displayOptions,
  onUpdateDisplayOptions,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Map viewport transform (offset in pixels, zoom level)
  const [zoom, setZoom] = useState<number>(1.0);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Custom Bounding Box Draw Mode
  const [isDrawingBox, setIsDrawingBox] = useState<boolean>(false);
  const [boxStart, setBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [boxCurrent, setBoxCurrent] = useState<{ x: number; y: number } | null>(null);

  // Hover state & cursor telemetry
  const [cursorGeo, setCursorGeo] = useState<{ lat: number; lon: number; db?: number } | null>(null);
  const [hoveredTarget, setHoveredTarget] = useState<VesselTarget | null>(null);

  // Layer Visibility toggles
  const [showSarRaster, setShowSarRaster] = useState<boolean>(true);
  const [showHeatmapOverlay, setShowHeatmapOverlay] = useState<boolean>(displayOptions?.showHeatmapOverlay ?? true);
  const [heatmapOpacity, setHeatmapOpacity] = useState<number>(displayOptions?.heatmapOpacity ?? 0.70);
  const [heatmapPalette, setHeatmapPalette] = useState<'turbo' | 'thermal' | 'plasma'>(displayOptions?.heatmapPalette ?? 'thermal');
  const [showLandMask, setShowLandMask] = useState<boolean>(true);
  const [showCfarBoxes, setShowCfarBoxes] = useState<boolean>(true);
  const [showAisVectors, setShowAisVectors] = useState<boolean>(true);
  const [showCorrelationLinks, setShowCorrelationLinks] = useState<boolean>(true);
  const [showKelvinWakes, setShowKelvinWakes] = useState<boolean>(true);
  const [showStsRings, setShowStsRings] = useState<boolean>(true);
  const [showLayersMenu, setShowLayersMenu] = useState<boolean>(false);
  const [rasterColorMode, setRasterColorMode] = useState<'radar-green' | 'grayscale' | 'night-flir'>('radar-green');

  // Synchronize with external displayOptions changes
  useEffect(() => {
    if (displayOptions) {
      if (displayOptions.showHeatmapOverlay !== undefined) {
        setShowHeatmapOverlay(displayOptions.showHeatmapOverlay);
      }
      if (displayOptions.heatmapOpacity !== undefined) {
        setHeatmapOpacity(displayOptions.heatmapOpacity);
      }
      if (displayOptions.heatmapPalette !== undefined) {
        setHeatmapPalette(displayOptions.heatmapPalette);
      }
      if (displayOptions.showLandMask !== undefined) {
        setShowLandMask(displayOptions.showLandMask);
      }
      if (displayOptions.showDetections !== undefined) {
        setShowCfarBoxes(displayOptions.showDetections);
      }
      if (displayOptions.showAisTracks !== undefined) {
        setShowAisVectors(displayOptions.showAisTracks);
      }
      if (displayOptions.showCorrelationLinks !== undefined) {
        setShowCorrelationLinks(displayOptions.showCorrelationLinks);
      }
      if (displayOptions.showWakes !== undefined) {
        setShowKelvinWakes(displayOptions.showWakes);
      }
    }
  }, [
    displayOptions?.showHeatmapOverlay,
    displayOptions?.heatmapOpacity,
    displayOptions?.heatmapPalette,
    displayOptions?.showLandMask,
    displayOptions?.showDetections,
    displayOptions?.showAisTracks,
    displayOptions?.showCorrelationLinks,
    displayOptions?.showWakes,
  ]);

  const updateHeatmapState = (updates: {
    show?: boolean;
    opacity?: number;
    palette?: 'turbo' | 'thermal' | 'plasma';
  }) => {
    if (updates.show !== undefined) {
      setShowHeatmapOverlay(updates.show);
      onUpdateDisplayOptions?.({ showHeatmapOverlay: updates.show });
    }
    if (updates.opacity !== undefined) {
      setHeatmapOpacity(updates.opacity);
      onUpdateDisplayOptions?.({ heatmapOpacity: updates.opacity });
    }
    if (updates.palette !== undefined) {
      setHeatmapPalette(updates.palette);
      onUpdateDisplayOptions?.({ heatmapPalette: updates.palette });
    }
  };

  // Active Scene Bounding Box
  const bbox: BoundingBox = scanResult?.aoi || [103.65, 1.10, 104.05, 1.40];
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;

  // Coordinate conversion: Geo (lat, lon) -> Canvas (x, y)
  const geoToCanvas = useCallback(
    (lat: number, lon: number, width: number, height: number) => {
      const padding = 30;
      const usableW = width - padding * 2;
      const usableH = height - padding * 2;

      const normX = (lon - minLon) / lonSpan;
      const normY = (maxLat - lat) / latSpan; // lat increases northward

      const x = padding + normX * usableW;
      const y = padding + normY * usableH;

      // Apply zoom & pan centered at container middle
      const centerX = width / 2;
      const centerY = height / 2;
      const screenX = centerX + (x - centerX + offset.x) * zoom;
      const screenY = centerY + (y - centerY + offset.y) * zoom;

      return { x: screenX, y: screenY };
    },
    [minLon, maxLat, lonSpan, latSpan, zoom, offset]
  );

  // Coordinate conversion: Screen (x, y) -> Geo (lat, lon)
  const canvasToGeo = useCallback(
    (screenX: number, screenY: number, width: number, height: number) => {
      const centerX = width / 2;
      const centerY = height / 2;

      const unzoomedX = (screenX - centerX) / zoom + centerX - offset.x;
      const unzoomedY = (screenY - centerY) / zoom + centerY - offset.y;

      const padding = 30;
      const usableW = width - padding * 2;
      const usableH = height - padding * 2;

      const normX = Math.max(0, Math.min(1, (unzoomedX - padding) / usableW));
      const normY = Math.max(0, Math.min(1, (unzoomedY - padding) / usableH));

      const lon = minLon + normX * lonSpan;
      const lat = maxLat - normY * latSpan;

      return { lat, lon, normX, normY };
    },
    [minLon, maxLat, lonSpan, latSpan, zoom, offset]
  );

  // Main Canvas Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resize canvas to parent
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // 1. Draw Deep Ocean Tactical Background
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, w, h);

    // 2. Draw Geospatial Coordinate Graticule Grid
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.08)';
    ctx.lineWidth = 1;
    const gridDivisions = 8;
    for (let i = 0; i <= gridDivisions; i++) {
      const frac = i / gridDivisions;
      const gLon = minLon + frac * lonSpan;
      const gLat = minLat + frac * latSpan;

      const pX = geoToCanvas(minLat, gLon, w, h);
      const pY = geoToCanvas(gLat, minLon, w, h);

      // Vertical meridian
      ctx.beginPath();
      ctx.moveTo(pX.x, 0);
      ctx.lineTo(pX.x, h);
      ctx.stroke();

      // Horizontal parallel
      ctx.beginPath();
      ctx.moveTo(0, pY.y);
      ctx.lineTo(w, pY.y);
      ctx.stroke();

      // Coordinate Labels
      ctx.fillStyle = 'rgba(6, 182, 212, 0.35)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(`${gLon.toFixed(2)}°E`, pX.x + 4, h - 8);
      ctx.fillText(`${gLat.toFixed(2)}°N`, 8, pY.y - 4);
    }

    // 3. Render SAR Backscatter Raster Grid (if available & enabled)
    if (showSarRaster && rasterGrid && rasterGrid.length > 0) {
      const rH = rasterGrid.length;
      const rW = rasterGrid[0].length;

      // Offscreen canvas for fast bilinear rendering
      const offscreen = document.createElement('canvas');
      offscreen.width = rW;
      offscreen.height = rH;
      const offCtx = offscreen.getContext('2d');
      if (offCtx) {
        const imgData = offCtx.createImageData(rW, rH);
        const data = imgData.data;

        for (let ry = 0; ry < rH; ry++) {
          for (let rx = 0; rx < rW; rx++) {
            const idx = (ry * rW + rx) * 4;
            const db = rasterGrid[ry][rx];
            const isLand = landMask && landMask[ry]?.[rx];

            // Normalize dB (-28 dB to +5 dB) to 0..255
            const norm = Math.max(0, Math.min(1, (db + 28) / 33));
            const byteVal = Math.round(norm * 255);

            if (isLand && showLandMask) {
              // Land terrain mask: dark slate cyan
              data[idx] = 12;
              data[idx + 1] = 30;
              data[idx + 2] = 38;
              data[idx + 3] = 220;
            } else if (rasterColorMode === 'radar-green') {
              // Classic tactical radar phosphor green colormap
              data[idx] = Math.round(byteVal * 0.15);
              data[idx + 1] = Math.round(byteVal * 0.95);
              data[idx + 2] = Math.round(byteVal * 0.45);
              data[idx + 3] = Math.max(140, Math.round(byteVal * 1.1));
            } else if (rasterColorMode === 'night-flir') {
              // High-contrast cyan/crimson FLIR mode
              data[idx] = byteVal > 180 ? byteVal : Math.round(byteVal * 0.1);
              data[idx + 1] = Math.round(byteVal * 0.85);
              data[idx + 2] = Math.round(byteVal * 0.95);
              data[idx + 3] = 230;
            } else {
              // Grayscale backscatter
              data[idx] = byteVal;
              data[idx + 1] = byteVal;
              data[idx + 2] = byteVal;
              data[idx + 3] = 220;
            }
          }
        }
        offCtx.putImageData(imgData, 0, 0);

        // Project offscreen raster onto map area
        const tl = geoToCanvas(maxLat, minLon, w, h);
        const br = geoToCanvas(minLat, maxLon, w, h);
        ctx.save();
        ctx.imageSmoothingEnabled = false; // preserve pixelated radar look
        ctx.globalAlpha = 0.88;
        ctx.drawImage(offscreen, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.restore();
      }
    }

    // 3B. Render SAR Backscatter Heatmap Overlay (if available & enabled)
    if (showHeatmapOverlay && rasterGrid && rasterGrid.length > 0 && heatmapOpacity > 0.01) {
      const rH = rasterGrid.length;
      const rW = rasterGrid[0].length;

      const offscreenHeat = document.createElement('canvas');
      offscreenHeat.width = rW;
      offscreenHeat.height = rH;
      const offCtx = offscreenHeat.getContext('2d');
      if (offCtx) {
        const imgData = offCtx.createImageData(rW, rH);
        const data = imgData.data;

        for (let ry = 0; ry < rH; ry++) {
          for (let rx = 0; rx < rW; rx++) {
            const idx = (ry * rW + rx) * 4;
            const db = rasterGrid[ry][rx];
            const isLand = landMask && landMask[ry]?.[rx];

            if (isLand && showLandMask) {
              // Mask land out of ocean heatmap
              data[idx] = 0;
              data[idx + 1] = 0;
              data[idx + 2] = 0;
              data[idx + 3] = 0;
              continue;
            }

            // Normalize dB (-28 dB to +5 dB) to 0..1
            const norm = Math.max(0, Math.min(1, (db + 28) / 33));
            const [r, g, b] = getHeatmapRgb(norm, heatmapPalette);

            // Progressive alpha gradient:
            // Lowest specular sea noise is transparent/subtle;
            // High-RCS ship hulls and Kelvin wakes are vibrant and distinct
            const alphaVal = norm < 0.15 
              ? Math.round(norm * 450)
              : Math.min(255, Math.round(160 + norm * 95));

            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = alphaVal;
          }
        }
        offCtx.putImageData(imgData, 0, 0);

        // Project offscreen heatmap onto canvas with smooth bilinear radiance
        const tl = geoToCanvas(maxLat, minLon, w, h);
        const br = geoToCanvas(minLat, maxLon, w, h);
        ctx.save();
        ctx.imageSmoothingEnabled = true; // smooth radiant heat dispersion
        ctx.globalAlpha = heatmapOpacity; // adjustable opacity in displayOptions
        ctx.drawImage(offscreenHeat, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.restore();
      }
    }

    // 4. Draw AOI Footprint Border
    const aoiTL = geoToCanvas(maxLat, minLon, w, h);
    const aoiBR = geoToCanvas(minLat, maxLon, w, h);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(aoiTL.x, aoiTL.y, aoiBR.x - aoiTL.x, aoiBR.y - aoiTL.y);

    // Corner bracket marks
    const bracketLen = 14;
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    // Top-Left
    ctx.beginPath();
    ctx.moveTo(aoiTL.x, aoiTL.y + bracketLen);
    ctx.lineTo(aoiTL.x, aoiTL.y);
    ctx.lineTo(aoiTL.x + bracketLen, aoiTL.y);
    ctx.stroke();
    // Top-Right
    ctx.beginPath();
    ctx.moveTo(aoiBR.x - bracketLen, aoiTL.y);
    ctx.lineTo(aoiBR.x, aoiTL.y);
    ctx.lineTo(aoiBR.x, aoiTL.y + bracketLen);
    ctx.stroke();
    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(aoiTL.x, aoiBR.y - bracketLen);
    ctx.lineTo(aoiTL.x, aoiBR.y);
    ctx.lineTo(aoiTL.x + bracketLen, aoiBR.y);
    ctx.stroke();
    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(aoiBR.x - bracketLen, aoiBR.y);
    ctx.lineTo(aoiBR.x, aoiBR.y);
    ctx.lineTo(aoiBR.x, aoiBR.y - bracketLen);
    ctx.stroke();

    if (!scanResult) return;

    // 5. Draw STS Proximity Rings (2 NM radius circles) for high-threat contacts
    if (showStsRings) {
      scanResult.vessels.forEach((v) => {
        if (v.proximityPartnerId) {
          const pos = geoToCanvas(v.position.lat, v.position.lon, w, h);
          // 2 Nautical Miles = ~3704 meters in screen pixels
          const metersPerLonDegree = 111320 * Math.cos((v.position.lat * Math.PI) / 180);
          const screenRadiusPx = ((3704 / metersPerLonDegree) / lonSpan) * (aoiBR.x - aoiTL.x);

          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, Math.max(15, screenRadiusPx), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      });
    }

    // 6. Draw Correlation Tether Lines
    if (showCorrelationLinks) {
      scanResult.vessels.forEach((v) => {
        if (v.aisCorrelation.matched && v.aisCorrelation.predictedLat && v.aisCorrelation.predictedLon) {
          const pSar = geoToCanvas(v.position.lat, v.position.lon, w, h);
          const pAis = geoToCanvas(v.aisCorrelation.predictedLat, v.aisCorrelation.predictedLon, w, h);

          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.65)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(pSar.x, pSar.y);
          ctx.lineTo(pAis.x, pAis.y);
          ctx.stroke();

          // Distance tag
          if (v.aisCorrelation.distanceOffsetMeters && v.aisCorrelation.distanceOffsetMeters > 80) {
            const midX = (pSar.x + pAis.x) / 2;
            const midY = (pSar.y + pAis.y) / 2;
            ctx.fillStyle = '#10b981';
            ctx.font = '8px "JetBrains Mono", monospace';
            ctx.fillText(`${v.aisCorrelation.distanceOffsetMeters}m`, midX + 3, midY - 3);
          }
          ctx.restore();
        }
      });
    }

    // 7. Draw Kelvin Wakes
    if (showKelvinWakes) {
      scanResult.vessels.forEach((v) => {
        if (v.wakeVisible) {
          const pos = geoToCanvas(v.position.lat, v.position.lon, w, h);
          const headingRad = (v.estimatedHeadingDeg * Math.PI) / 180;
          // Wake trails behind vessel (opposite of heading)
          const sternRad = headingRad + Math.PI;
          const wakeLen = 35 * zoom;
          const armAngle = 0.34; // ~19.5 deg

          ctx.save();
          // Turbulent centerline scar
          ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(pos.x + Math.sin(sternRad) * wakeLen, pos.y - Math.cos(sternRad) * wakeLen);
          ctx.stroke();

          // Kelvin V-arms
          ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(
            pos.x + Math.sin(sternRad - armAngle) * wakeLen,
            pos.y - Math.cos(sternRad - armAngle) * wakeLen
          );
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(
            pos.x + Math.sin(sternRad + armAngle) * wakeLen,
            pos.y - Math.cos(sternRad + armAngle) * wakeLen
          );
          ctx.stroke();
          ctx.restore();
        }
      });
    }

    // 8. Draw AIS Ghost / Non-Correlated Vessels (Amber symbols)
    if (showAisVectors) {
      scanResult.aisObservations.forEach((ais) => {
        const isMatched = scanResult.vessels.some(
          (v) => v.aisCorrelation.mmsi === ais.mmsi && v.aisCorrelation.matched
        );

        if (!isMatched) {
          // AIS-only contact (no matching radar target detected)
          const pos = geoToCanvas(ais.lat, ais.lon, w, h);
          ctx.strokeStyle = '#f59e0b';
          ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
          ctx.lineWidth = 1.5;

          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fill();

          // Heading line
          const hRad = (ais.cog * Math.PI) / 180;
          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(pos.x + Math.sin(hRad) * 14, pos.y - Math.cos(hRad) * 14);
          ctx.stroke();

          // Label
          ctx.fillStyle = '#f59e0b';
          ctx.font = '8px "JetBrains Mono", monospace';
          ctx.fillText(`AIS: ${ais.mmsi}`, pos.x + 8, pos.y + 3);
        }
      });
    }

    // 9. Draw Target Markers & Bounding Reticles
    scanResult.vessels.forEach((v) => {
      const pos = geoToCanvas(v.position.lat, v.position.lon, w, h);
      const isSelected = selectedTarget?.id === v.id;
      const isHovered = hoveredTarget?.id === v.id;

      // Color scheme based on canonical classification
      let primaryColor = '#10b981'; // Green for SAR_MATCHED_AIS
      let glowColor = 'rgba(16, 185, 129, 0.4)';

      if (v.classification === 'SAR_UNMATCHED') {
        primaryColor = '#ef4444'; // Red for SAR_UNMATCHED
        glowColor = 'rgba(239, 68, 68, 0.5)';
      } else if (v.classification === 'STATIONARY_OR_INFRASTRUCTURE') {
        primaryColor = '#38bdf8'; // Sky blue for platforms
        glowColor = 'rgba(56, 189, 248, 0.4)';
      } else if (v.classification === 'AIS_ONLY') {
        primaryColor = '#f59e0b';
        glowColor = 'rgba(245, 158, 11, 0.4)';
      }

      ctx.save();

      // Heading vector arrow
      const hRad = (v.estimatedHeadingDeg * Math.PI) / 180;
      const arrowLen = Math.max(12, Math.min(28, (v.estimatedLengthMeters / 10) * zoom));
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x + Math.sin(hRad) * arrowLen, pos.y - Math.cos(hRad) * arrowLen);
      ctx.stroke();

      // Vessel Centroid Marker
      if (v.classification === 'STATIONARY_OR_INFRASTRUCTURE') {
        // Square platform symbol
        ctx.fillStyle = primaryColor;
        ctx.fillRect(pos.x - 4, pos.y - 4, 8, 8);
      } else {
        // Ship hull diamond
        ctx.fillStyle = primaryColor;
        ctx.beginPath();
        ctx.moveTo(pos.x + Math.sin(hRad) * 7, pos.y - Math.cos(hRad) * 7);
        ctx.lineTo(pos.x + Math.cos(hRad) * 4, pos.y + Math.sin(hRad) * 4);
        ctx.lineTo(pos.x - Math.sin(hRad) * 7, pos.y + Math.cos(hRad) * 7);
        ctx.lineTo(pos.x - Math.cos(hRad) * 4, pos.y - Math.sin(hRad) * 4);
        ctx.closePath();
        ctx.fill();
      }

      // Normalized 2D Bounding Box reticle (if enabled)
      if (showCfarBoxes) {
        const boxSize = Math.max(16, (v.apparentWidthMeters / 6) * zoom);
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(pos.x - boxSize / 2, pos.y - boxSize / 2, boxSize, boxSize);
        ctx.setLineDash([]);
      }

      // Highlight pulse on selected or hovered target
      if (isSelected || isHovered) {
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
        ctx.stroke();

        // Crosshairs
        ctx.beginPath();
        ctx.moveTo(pos.x - 22, pos.y);
        ctx.lineTo(pos.x + 22, pos.y);
        ctx.moveTo(pos.x, pos.y - 22);
        ctx.lineTo(pos.x, pos.y + 22);
        ctx.stroke();
      }

      // Target ID & Length label
      ctx.fillStyle = primaryColor;
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.fillText(v.id, pos.x + 10, pos.y - 4);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillText(`~${v.estimatedLengthMeters}m`, pos.x + 10, pos.y + 6);

      ctx.restore();
    });

    // 10. Draw User Custom Bounding Box Drag Selection (if active)
    if (isDrawingBox && boxStart && boxCurrent) {
      ctx.save();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = 'rgba(6, 182, 212, 0.15)';
      const bx = Math.min(boxStart.x, boxCurrent.x);
      const by = Math.min(boxStart.y, boxCurrent.y);
      const bw = Math.abs(boxCurrent.x - boxStart.x);
      const bh = Math.abs(boxCurrent.y - boxStart.y);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.restore();
    }

    // 11. Draw Nautical Mile Scale Bar & Compass Rose in top-right
    const nmScalePixels = ((1852 / 111320) / lonSpan) * (aoiBR.x - aoiTL.x);
    if (nmScalePixels > 15) {
      const scaleX = w - 120;
      const scaleY = h - 25;
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaleX, scaleY);
      ctx.lineTo(scaleX + nmScalePixels, scaleY);
      ctx.moveTo(scaleX, scaleY - 4);
      ctx.lineTo(scaleX, scaleY + 4);
      ctx.moveTo(scaleX + nmScalePixels, scaleY - 4);
      ctx.lineTo(scaleX + nmScalePixels, scaleY + 4);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText('1 NAUTICAL MILE', scaleX + 2, scaleY - 6);
    }
  }, [
    scanResult,
    selectedTarget,
    hoveredTarget,
    zoom,
    offset,
    showSarRaster,
    showHeatmapOverlay,
    heatmapOpacity,
    heatmapPalette,
    showLandMask,
    showCfarBoxes,
    showAisVectors,
    showCorrelationLinks,
    showKelvinWakes,
    showStsRings,
    rasterColorMode,
    rasterGrid,
    landMask,
    isDrawingBox,
    boxStart,
    boxCurrent,
    geoToCanvas,
    minLon,
    minLat,
    maxLon,
    maxLat,
    lonSpan,
    latSpan,
  ]);

  // Mouse Handlers for Pan, Zoom, and Target Click
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isDrawingBox) {
      setBoxStart({ x, y });
      setBoxCurrent({ x, y });
      return;
    }

    setIsDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Telemetry lookup under cursor
    const geo = canvasToGeo(x, y, rect.width, rect.height);
    let cellDb: number | undefined;
    if (rasterGrid && rasterGrid.length > 0) {
      const rY = Math.floor(geo.normY * rasterGrid.length);
      const rX = Math.floor(geo.normX * rasterGrid[0].length);
      if (rY >= 0 && rY < rasterGrid.length && rX >= 0 && rX < rasterGrid[0].length) {
        cellDb = rasterGrid[rY][rX];
      }
    }
    setCursorGeo({ lat: geo.lat, lon: geo.lon, db: cellDb });

    if (isDrawingBox && boxStart) {
      setBoxCurrent({ x, y });
      return;
    }

    if (isDragging) {
      setOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
      return;
    }

    // Check hit test for target hover
    if (scanResult) {
      let found: VesselTarget | null = null;
      for (const t of scanResult.vessels) {
        const pos = geoToCanvas(t.position.lat, t.position.lon, rect.width, rect.height);
        const dist = Math.hypot(x - pos.x, y - pos.y);
        if (dist <= 14) {
          found = t;
          break;
        }
      }
      setHoveredTarget(found);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (isDrawingBox && boxStart && boxCurrent) {
      const g1 = canvasToGeo(boxStart.x, boxStart.y, rect.width, rect.height);
      const g2 = canvasToGeo(boxCurrent.x, boxCurrent.y, rect.width, rect.height);
      const newBbox: BoundingBox = [
        Math.min(g1.lon, g2.lon),
        Math.min(g1.lat, g2.lat),
        Math.max(g1.lon, g2.lon),
        Math.max(g1.lat, g2.lat),
      ];

      setIsDrawingBox(false);
      setBoxStart(null);
      setBoxCurrent(null);
      if (onBoxSelected) {
        onBoxSelected(newBbox);
      }
      return;
    }

    if (isDragging) {
      setIsDragging(false);
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDrawingBox) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !scanResult) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let clickedTarget: VesselTarget | null = null;
    for (const t of scanResult.vessels) {
      const pos = geoToCanvas(t.position.lat, t.position.lon, rect.width, rect.height);
      const dist = Math.hypot(x - pos.x, y - pos.y);
      if (dist <= 16) {
        clickedTarget = t;
        break;
      }
    }
    onSelectTarget(clickedTarget);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.88;
    setZoom((z) => Math.max(0.6, Math.min(6.0, z * factor)));
  };

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#05080c] overflow-hidden select-none">
      {/* Scanline CRT Texture Overlay */}
      <div className="absolute inset-0 scanlines pointer-events-none z-10" />

      {/* Main Radar Viewport Canvas */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onWheel={handleWheel}
        className={`w-full h-full block ${isDrawingBox ? 'cursor-crosshair' : isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      />

      {/* Top Map Floating Bar: Layer controls & Zoom */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5 bg-[#080c10]/90 backdrop-blur-md border border-slate-800 rounded-lg p-1 shadow-2xl">
        <button
          onClick={() => setZoom((z) => Math.min(6.0, z * 1.25))}
          className="p-1.5 rounded hover:bg-slate-800 text-slate-300 hover:text-cyan-300 transition"
          title="Zoom In (+)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(0.6, z * 0.8))}
          className="p-1.5 rounded hover:bg-slate-800 text-slate-300 hover:text-cyan-300 transition"
          title="Zoom Out (-)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setZoom(1.0);
            setOffset({ x: 0, y: 0 });
          }}
          className="p-1.5 rounded hover:bg-slate-800 text-slate-300 hover:text-cyan-300 transition"
          title="Reset View"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <div className="h-4 w-[1px] bg-slate-700 mx-0.5" />

        {/* Custom Bounding Box Draw Mode */}
        <button
          onClick={() => setIsDrawingBox((b) => !b)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-mono transition ${
            isDrawingBox
              ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_10px_rgba(6,182,212,0.6)]'
              : 'hover:bg-slate-800 text-slate-300'
          }`}
          title="Draw Custom AOI Bounding Box"
        >
          <BoxSelect className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">DRAW AOI</span>
        </button>

        <div className="h-4 w-[1px] bg-slate-700 mx-0.5" />

        {/* Layer Visibility Menu */}
        <div className="relative">
          <button
            onClick={() => setShowLayersMenu((m) => !m)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono hover:bg-slate-800 text-slate-300 hover:text-cyan-300 transition"
          >
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">LAYERS</span>
          </button>

          {showLayersMenu && (
            <div className="absolute top-8 left-0 w-64 bg-[#0a0f16] border border-cyan-900/60 rounded-lg p-2.5 shadow-2xl z-30 text-xs font-mono space-y-2">
              <div className="text-[10px] text-slate-400 font-bold tracking-wider border-b border-slate-800 pb-1">
                RADAR DISPLAY LAYERS
              </div>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>SAR Backscatter Raster (dB)</span>
                <input
                  type="checkbox"
                  checked={showSarRaster}
                  onChange={(e) => setShowSarRaster(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>Land & Coastline Mask</span>
                <input
                  type="checkbox"
                  checked={showLandMask}
                  onChange={(e) => setShowLandMask(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>CFAR 2D Bounding Boxes</span>
                <input
                  type="checkbox"
                  checked={showCfarBoxes}
                  onChange={(e) => setShowCfarBoxes(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>AIS Broadcast Vectors</span>
                <input
                  type="checkbox"
                  checked={showAisVectors}
                  onChange={(e) => setShowAisVectors(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>Correlation Tethers</span>
                <input
                  type="checkbox"
                  checked={showCorrelationLinks}
                  onChange={(e) => setShowCorrelationLinks(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>Kelvin Wake V-Lines</span>
                <input
                  type="checkbox"
                  checked={showKelvinWakes}
                  onChange={(e) => setShowKelvinWakes(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer text-slate-300 hover:text-white">
                <span>STS 2 NM Threat Rings</span>
                <input
                  type="checkbox"
                  checked={showStsRings}
                  onChange={(e) => setShowStsRings(e.target.checked)}
                  className="accent-cyan-500"
                />
              </label>

              {/* Heatmap Overlay Layer with Opacity Control */}
              <div className="pt-2 border-t border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 hover:text-white font-semibold">
                    <Flame className="w-3.5 h-3.5 text-amber-400" />
                    <span>SAR Heatmap Overlay</span>
                  </label>
                  <input
                    type="checkbox"
                    checked={showHeatmapOverlay}
                    onChange={(e) => updateHeatmapState({ show: e.target.checked })}
                    className="accent-amber-500 w-4 h-4 cursor-pointer"
                  />
                </div>

                {showHeatmapOverlay && (
                  <div className="space-y-1.5 pl-1 bg-black/40 p-2 rounded border border-amber-950/50">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">Heatmap Opacity:</span>
                      <span className="text-amber-400 font-bold">{Math.round(heatmapOpacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.05"
                      max="1.0"
                      step="0.05"
                      value={heatmapOpacity}
                      onChange={(e) => updateHeatmapState({ opacity: parseFloat(e.target.value) })}
                      className="w-full accent-amber-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                    />

                    <div className="pt-1">
                      <span className="text-[10px] text-slate-400 block mb-1">HEATMAP COLORMAP:</span>
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        {(['thermal', 'turbo', 'plasma'] as const).map((p) => (
                          <button
                            key={p}
                            onClick={() => updateHeatmapState({ palette: p })}
                            className={`px-1 py-0.5 rounded text-center border capitalize ${
                              heatmapPalette === p
                                ? 'border-amber-500 bg-amber-950/70 text-amber-300 font-semibold'
                                : 'border-slate-800 text-slate-400 hover:bg-slate-800'
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-1.5 border-t border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-1">COLOR PALETTE:</span>
                <div className="grid grid-cols-3 gap-1 text-[10px]">
                  {(['radar-green', 'grayscale', 'night-flir'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setRasterColorMode(mode)}
                      className={`px-1.5 py-1 rounded text-center border capitalize ${
                        rasterColorMode === mode
                          ? 'border-cyan-500 bg-cyan-950/60 text-cyan-300'
                          : 'border-slate-800 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {mode.replace('-', ' ')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Top-Right Orbital Compass & Pass Info */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2 bg-[#080c10]/90 backdrop-blur-md border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono shadow-2xl">
        <div className="flex items-center gap-1.5 text-cyan-400">
          <Navigation className="w-4 h-4 transform -rotate-45" />
          <span>TRUE NORTH</span>
        </div>
        <div className="h-4 w-[1px] bg-slate-700" />
        <span className="text-slate-400">LOOK: DESCENDING ~38.6°</span>
      </div>

      {/* Bottom Telemetry HUD bar */}
      <div className="absolute bottom-3 left-3 z-20 flex items-center gap-3 bg-[#080c10]/95 backdrop-blur-md border border-slate-800/80 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-300 shadow-2xl">
        <div className="flex items-center gap-1.5">
          <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
          <span>
            {cursorGeo
              ? `${cursorGeo.lat.toFixed(5)}°N, ${cursorGeo.lon.toFixed(5)}°E`
              : 'POSITION TELEMETRY'}
          </span>
        </div>

        {cursorGeo?.db !== undefined && (
          <>
            <div className="h-3 w-[1px] bg-slate-700" />
            <div className="flex items-center gap-1">
              <span className="text-slate-500">BACKSCATTER:</span>
              <span className={`font-semibold ${cursorGeo.db > -10 ? 'text-amber-400' : 'text-cyan-300'}`}>
                {cursorGeo.db} dB
              </span>
            </div>
          </>
        )}

        <div className="h-3 w-[1px] bg-slate-700" />
        <div className="flex items-center gap-1 text-[11px] text-slate-400">
          <span>ZOOM:</span>
          <span className="text-cyan-400 font-bold">{zoom.toFixed(1)}x</span>
        </div>
      </div>

      {/* Floating Tactical Heatmap Legend & Opacity HUD */}
      {showHeatmapOverlay && (
        <div className="absolute bottom-12 right-3 z-20 flex flex-col gap-1.5 bg-[#080c10]/95 backdrop-blur-md border border-amber-500/40 rounded-lg p-2.5 text-xs font-mono shadow-[0_0_20px_rgba(245,158,11,0.15)]">
          <div className="flex items-center justify-between gap-4 text-[10px]">
            <div className="flex items-center gap-1.5 text-amber-300 font-bold tracking-wider">
              <Flame className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
              <span>SAR HEATMAP</span>
              <span className="text-[9px] px-1 py-0.2 rounded bg-amber-950/80 border border-amber-500/30 text-amber-200 capitalize">
                {heatmapPalette}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">OPACITY:</span>
              <span className="text-amber-400 font-bold">{Math.round(heatmapOpacity * 100)}%</span>
            </div>
          </div>

          {/* Color Gradient Scale */}
          <div
            className="w-56 h-2 rounded overflow-hidden border border-slate-700/80 shadow-inner"
            style={{
              background:
                heatmapPalette === 'plasma'
                  ? 'linear-gradient(to right, rgb(15,5,80), rgb(110,15,165), rgb(200,70,80), rgb(245,160,20), rgb(255,255,100))'
                  : heatmapPalette === 'turbo'
                  ? 'linear-gradient(to right, rgb(0,40,160), rgb(0,180,255), rgb(120,240,0), rgb(240,210,0), rgb(255,40,0))'
                  : 'linear-gradient(to right, rgb(5,20,90), rgb(0,170,230), rgb(20,245,60), rgb(255,210,0), rgb(255,35,15), rgb(255,255,255))',
            }}
          />

          <div className="flex items-center justify-between text-[9px] text-slate-400 font-mono px-0.5">
            <span>-28 dB (Sea)</span>
            <span>-12 dB (Wake)</span>
            <span>+5 dB (Hull)</span>
          </div>

          {/* Interactive Fast Opacity Slider */}
          <div className="flex items-center gap-2 pt-1 border-t border-slate-800">
            <span className="text-[9px] text-slate-500 font-semibold">ADJUST:</span>
            <input
              type="range"
              min="0.05"
              max="1.0"
              step="0.05"
              value={heatmapOpacity}
              onChange={(e) => updateHeatmapState({ opacity: parseFloat(e.target.value) })}
              className="flex-1 accent-amber-500 cursor-pointer h-1.5 bg-slate-800 rounded"
              title="Adjust Heatmap Opacity"
            />
            <button
              onClick={() => {
                const next = heatmapPalette === 'thermal' ? 'turbo' : heatmapPalette === 'turbo' ? 'plasma' : 'thermal';
                updateHeatmapState({ palette: next });
              }}
              className="px-1.5 py-0.5 rounded text-[9px] bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:text-white transition capitalize"
              title="Cycle Heatmap Palette"
            >
              {heatmapPalette}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
