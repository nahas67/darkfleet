/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet 3D Digital Globe Viewport
 * Primary full-screen geospatial container powered by CesiumJS.
 */

import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { Viewer, ScreenSpaceEventHandler, ScreenSpaceEventType, Math as CesiumMath } from 'cesium';
import { initializeCesiumViewer } from './cesiumViewer.ts';
import { flyToScenario, focusTarget, resetGlobe, setTopDown, setOrbit } from './cameraController.ts';
import { SarOverlayManager } from './sarOverlay.ts';
import { SceneFootprintManager } from './sceneFootprint.ts';
import { TargetEntityManager } from './targetEntities.ts';
import { AISTrackManager } from './aisTracks.ts';
import { BoundingBox, DisplayOptions, RegionScenario, ScanResult, VesselTarget } from '../types/darkfleet.ts';

export interface GlobeRef {
  flyToScenario: (scenario: RegionScenario) => void;
  focusTarget: (target: VesselTarget) => void;
  resetGlobe: () => void;
  setTopDown: () => void;
  setOrbit: () => void;
  getViewer: () => Viewer | null;
}

interface DarkFleetGlobeProps {
  scenario: RegionScenario;
  scanResult: ScanResult | null;
  selectedTarget: VesselTarget | null;
  rasterGrid?: number[][];
  landMask?: boolean[][];
  displayOptions: DisplayOptions;
  isScanning: boolean;
  onSelectTarget: (target: VesselTarget | null) => void;
  onCursorMove?: (telemetry: { lat: number; lon: number; heightKm: number } | null) => void;
  onError?: (err: any) => void;
}

export const DarkFleetGlobe = forwardRef<GlobeRef, DarkFleetGlobeProps>(({
  scenario,
  scanResult,
  selectedTarget,
  rasterGrid,
  landMask,
  displayOptions,
  isScanning,
  onSelectTarget,
  onCursorMove,
  onError,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  const sarOverlayRef = useRef<SarOverlayManager | null>(null);
  const footprintRef = useRef<SceneFootprintManager | null>(null);
  const targetEntityRef = useRef<TargetEntityManager | null>(null);
  const aisTrackRef = useRef<AISTrackManager | null>(null);
  const [hoveredTarget, setHoveredTarget] = useState<VesselTarget | null>(null);

  // Expose camera methods via ref
  useImperativeHandle(ref, () => ({
    flyToScenario: (sc: RegionScenario) => {
      if (viewerRef.current) flyToScenario(viewerRef.current, sc);
    },
    focusTarget: (t: VesselTarget) => {
      if (viewerRef.current) focusTarget(viewerRef.current, t);
    },
    resetGlobe: () => {
      if (viewerRef.current) resetGlobe(viewerRef.current);
    },
    setTopDown: () => {
      if (viewerRef.current) setTopDown(viewerRef.current);
    },
    setOrbit: () => {
      if (viewerRef.current) setOrbit(viewerRef.current);
    },
    getViewer: () => viewerRef.current,
  }));

  // 1. Initialize Cesium Viewer on mount
  useEffect(() => {
    if (!containerRef.current) return;

    let viewer: Viewer;
    try {
      viewer = initializeCesiumViewer({
        container: containerRef.current,
      });
      viewerRef.current = viewer;
    } catch (err: any) {
      console.warn('Failed to initialize Cesium Viewer, falling back:', err);
      onError?.(err);
      return;
    }

    sarOverlayRef.current = new SarOverlayManager(viewer);
    footprintRef.current = new SceneFootprintManager(viewer);
    targetEntityRef.current = new TargetEntityManager(viewer);
    aisTrackRef.current = new AISTrackManager(viewer);

    targetEntityRef.current.initInteractions(
      (tgt) => onSelectTarget(tgt),
      (tgt) => setHoveredTarget(tgt)
    );

    // Initial camera flight to active scenario
    flyToScenario(viewer, scenario, 2.5);

    // Cursor tracking for Intelligence HUD
    const mouseHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    mouseHandler.setInputAction((movement: any) => {
      if (!onCursorMove) return;
      const ray = viewer.camera.getPickRay(movement.endPosition);
      if (ray) {
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (cartesian) {
          const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
          onCursorMove({
            lat: Number(CesiumMath.toDegrees(cartographic.latitude).toFixed(5)),
            lon: Number(CesiumMath.toDegrees(cartographic.longitude).toFixed(5)),
            heightKm: Number((viewer.camera.positionCartographic.height / 1000).toFixed(1)),
          });
          return;
        }
      }
      onCursorMove(null);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    return () => {
      mouseHandler.destroy();
      sarOverlayRef.current?.clear();
      footprintRef.current?.clear();
      targetEntityRef.current?.destroy();
      aisTrackRef.current?.clear();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // 2. Fly camera on scenario change
  useEffect(() => {
    if (viewerRef.current) {
      flyToScenario(viewerRef.current, scenario, 2.0);
    }
  }, [scenario.id]);

  // 3. Update Scene Footprint AOI
  useEffect(() => {
    if (!footprintRef.current) return;
    const bbox: BoundingBox = scanResult?.aoi || scenario.bbox;
    footprintRef.current.update(bbox, isScanning);
    footprintRef.current.setVisible(displayOptions.showSceneFootprint);
  }, [scenario.id, scanResult?.aoi, isScanning, displayOptions.showSceneFootprint]);

  // 4. Update SAR Raster Overlay
  useEffect(() => {
    if (!sarOverlayRef.current) return;
    const bbox: BoundingBox = scanResult?.aoi || scenario.bbox;
    if (displayOptions.showSarOverlay && rasterGrid && rasterGrid.length > 0) {
      sarOverlayRef.current.update({
        rasterGrid,
        landMask,
        bbox,
        colorMode: displayOptions.sarColorMode,
        showLandMask: displayOptions.showLandMask,
      });
    } else {
      sarOverlayRef.current.clear();
    }
  }, [
    rasterGrid,
    landMask,
    scanResult?.aoi,
    scenario.bbox,
    displayOptions.showSarOverlay,
    displayOptions.sarColorMode,
    displayOptions.showLandMask,
  ]);

  // 5. Update Target Reticles & Entities
  useEffect(() => {
    if (!targetEntityRef.current) return;
    targetEntityRef.current.update({
      targets: scanResult?.vessels || [],
      selectedTargetId: selectedTarget?.id || null,
      hoveredTargetId: hoveredTarget?.id || null,
      showDetections: displayOptions.showDetections,
      showCorrelationLinks: displayOptions.showCorrelationLinks,
      showWakes: displayOptions.showWakes,
    });
  }, [
    scanResult?.vessels,
    selectedTarget?.id,
    hoveredTarget?.id,
    displayOptions.showDetections,
    displayOptions.showCorrelationLinks,
    displayOptions.showWakes,
  ]);

  // 6. Update AIS Tracks
  useEffect(() => {
    if (!aisTrackRef.current) return;
    aisTrackRef.current.update(
      scanResult?.aisObservations || [],
      scanResult?.vessels || [],
      displayOptions.showAisTracks
    );
  }, [scanResult?.aisObservations, scanResult?.vessels, displayOptions.showAisTracks]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 w-screen h-screen z-0 bg-[#06090d] overflow-hidden"
    />
  );
});

DarkFleetGlobe.displayName = 'DarkFleetGlobe';
