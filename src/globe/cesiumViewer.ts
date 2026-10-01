/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * CesiumJS Viewer Core Initializer
 * Configures the 3D digital globe with dark aerospace ground-station aesthetics
 * and keyless fallback basemaps.
 */

import {
  Viewer,
  Color,
  ImageryLayer,
  OpenStreetMapImageryProvider,
  Ion,
} from 'cesium';

export interface CesiumViewerOptions {
  container: HTMLElement;
  ionToken?: string;
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export function initializeCesiumViewer({ container, ionToken }: CesiumViewerOptions): Viewer {
  if (ionToken) {
    Ion.defaultAccessToken = ionToken;
  }

  let baseLayer: any = false;
  try {
    const osmProvider = new OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
    });
    baseLayer = new ImageryLayer(osmProvider);
  } catch (err) {
    console.warn('Cesium ImageryLayer fallback to false:', err);
    baseLayer = false;
  }

  const viewerOptions: any = {
    baseLayer,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    animation: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    creditContainer: undefined,
  };

  const viewer = new Viewer(container, viewerOptions);


  const scene = viewer.scene;
  const globe = scene.globe;

  // Deep oceanic night ground-station theme
  globe.baseColor = Color.fromCssColorString('#06090d');
  scene.backgroundColor = Color.fromCssColorString('#05070a');

  // Subtle dark atmospheric illumination
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.brightnessShift = -0.25;
    scene.skyAtmosphere.saturationShift = -0.15;
  }

  // Lighting & fog
  scene.globe.enableLighting = false; // uniform clean sensor visibility
  scene.globe.depthTestAgainstTerrain = false;

  // Limit zoom extremes
  scene.screenSpaceCameraController.minimumZoomDistance = 500;
  scene.screenSpaceCameraController.maximumZoomDistance = 30000000;

  return viewer;
}
