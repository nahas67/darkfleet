/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * CesiumJS Viewer Core Initializer
 * Configures the 3D digital globe with dark aerospace ground-station aesthetics
 * and keyless fallback basemaps.
 *
 * WHAT CHANGED IN DF-X8.3, AND WHY IT WAS NOT OPTIONAL
 *
 * The previous version did three things that had to be undone:
 *
 *   1. It hardcoded one OpenStreetMap provider inside a `try/catch` that fell back to
 *      `baseLayer = false`. One tile server down meant a blank world, no message, no
 *      fallback.
 *   2. It passed `creditContainer: undefined`, which DISABLES Cesium's credit
 *      display. OpenStreetMap data is ODbL and the attribution is a licence
 *      obligation, so this was a compliance failure, not a missing nicety.
 *   3. It observed no imagery errors at all -- there was no `errorEvent` listener
 *      anywhere in `src/globe` -- so no failure policy could ever have triggered.
 *
 * The basemap is now installed through `MapSourceController`, which owns the ordered
 * source registry, the failure threshold, fallback, cooldown recovery and the active
 * credit.
 *
 * THE VIEWER IS STILL CREATED EXACTLY ONCE (§17)
 *
 * The Viewer is built with NO basemap, then the controller's chosen source is added as
 * an `ImageryLayer`. Fallback therefore REPLACES an imagery layer -- it never
 * constructs a second Viewer. Recreating a Viewer leaks a WebGL context and browsers
 * cap those at roughly sixteen.
 */

import {
  Viewer,
  Color,
  ImageryLayer,
  Ion,
  OpenStreetMapImageryProvider,
  UrlTemplateImageryProvider,
  type ImageryProvider,
} from 'cesium';

import { MapSourceController, type MapSourceStatus } from './MapSourceController';
import { buildMapSources, MAP_SOURCE_URLS } from './mapSources';

export interface CesiumViewerOptions {
  container: HTMLElement;
  ionToken?: string;
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')),
    );
  } catch {
    return false;
  }
}

/**
 * The credit element, created by us and handed to Cesium.
 *
 * Kept in the DOM and visible rather than suppressed. It carries the ACTIVE basemap
 * credit plus separate slots for maritime reference data and the SAR provider, so the
 * three are not concatenated into one opaque footer whose provenance cannot be
 * inspected.
 */
export type CreditElements = {
  root: HTMLDivElement;
  basemap: HTMLSpanElement;
  maritime: HTMLSpanElement;
  sar: HTMLSpanElement;
};

function createCreditElements(container: HTMLElement): CreditElements {
  const root = document.createElement('div');
  root.className = 'df-map-credit';
  root.setAttribute('data-df-credit', 'basemap');

  const basemap = document.createElement('span');
  basemap.className = 'df-map-credit-item';
  basemap.dataset.dfCreditSlot = 'basemap';

  const maritime = document.createElement('span');
  maritime.className = 'df-map-credit-item';
  maritime.dataset.dfCreditSlot = 'maritime';
  maritime.hidden = true;

  const sar = document.createElement('span');
  sar.className = 'df-map-credit-item';
  sar.dataset.dfCreditSlot = 'sar';
  sar.hidden = true;

  root.append(basemap, maritime, sar);
  container.appendChild(root);
  return { root, basemap, maritime, sar };
}

/** Live basemap ownership, exposed so the engine and UI can drive and observe it. */
export type BasemapHandle = {
  controller: MapSourceController;
  credit: CreditElements;
  /** Current status, for the system panel. */
  status: () => MapSourceStatus;
  /**
   * Point the credit at a different source. Called after every activation so the
   * displayed attribution always matches the imagery actually on screen.
   */
  syncCredit: () => void;
  /**
   * Install whichever source the controller now considers active.
   *
   * Idempotent, and it is the ONLY thing that changes the basemap. Both the failure
   * path and the recovery probe call it, so a source change and the imagery on screen
   * can never disagree.
   */
  applyActive: () => void;
  /** Release provider resources. Call before the viewer is destroyed. */
  dispose: () => void;
};

/**
 * Construct the imagery provider for a source id.
 *
 * Separate from `buildMapSources` so the registry file stays free of Cesium and can
 * be imported by tests running in `node`.
 */
function createImageryProvider(kind: 'OSM' | 'ESRI' | 'ION', ionToken?: string): ImageryProvider {
  if (kind === 'OSM') {
    return new OpenStreetMapImageryProvider({ url: MAP_SOURCE_URLS.OSM });
  }
  if (kind === 'ESRI') {
    return new UrlTemplateImageryProvider({
      url: MAP_SOURCE_URLS.ESRI,
      // Esri's endpoint uses {z}/{y}/{x}; maximumLevel avoids a failed-request storm
      // once the operator zooms past the imagery's actual extent.
      maximumLevel: 19,
    });
  }
  if (!ionToken) throw new Error('Cesium ion requires a token');
  Ion.defaultAccessToken = ionToken;
  return new UrlTemplateImageryProvider({
    url: 'https://assets.cesium.com/us/rest/1.0/assets/2/imagery/2023_07_28',
  });
}

export function initializeCesiumViewer({
  container,
  ionToken,
}: CesiumViewerOptions): Viewer & { basemap?: BasemapHandle } {
  if (ionToken) {
    Ion.defaultAccessToken = ionToken;
  }

  const credit = createCreditElements(container);

  /*
   * Built with NO basemap. The controller then installs one as an ImageryLayer, which
   * is what makes fallback a layer swap rather than a Viewer reconstruction.
   *
   * `creditContainer` is the element we created, so the credit is VISIBLE. Passing
   * `undefined` here would suppress it, which is the defect this whole arrangement
   * exists to reverse.
   */
  /*
   * `creditContainer` is deliberately NOT set.
   *
   * Passing our own element made Cesium inject its OWN credit markup -- including the
   * Cesium ion logo -- inside our styled box. The ion logo then overlapped the
   * attribution text and rendered it unreadable, which defeats the purpose of
   * restoring the credit at all. Attribution that is present but illegible is not
   * compliance.
   *
   * Cesium therefore builds its default credit container, and our attribution is a
   * SEPARATE element positioned above it (see `.df-map-credit` bottom offset in
   * `tokens.css`). Neither covers the other, and both remain visible.
   *
   * Passing `creditContainer: undefined` is still forbidden and still guarded by a
   * test -- that suppresses the credit entirely. Omitting the key lets Cesium place its
   * own, which is the different thing we want.
   */
  const viewerOptions: Record<string, unknown> = {
    baseLayer: false,
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
  };

  const viewer = new Viewer(container, viewerOptions) as Viewer & {
    basemap?: BasemapHandle;
  };

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

  /* ------------------------------------------------------------- basemap */

  /**
   * The imagery layer currently installed, and the listener watching it.
   *
   * Both are tracked so a switch can detach the old listener BEFORE removing the old
   * layer. Leaving a stale listener attached to a destroyed provider is how a repeated
   * toggle cycle accumulates handlers and starts counting failures from a source that
   * is no longer on screen (§18).
   */
  let currentLayer: ImageryLayer | null = null;
  let currentProvider: ImageryProvider | null = null;
  let failureListener: { remove: () => void } | null = null;

  const detachFailureListener = (): void => {
    if (failureListener) {
      failureListener.remove();
      failureListener = null;
    }
  };

  const removeCurrentLayer = (): void => {
    detachFailureListener();
    if (currentLayer) {
      try {
        viewer.imageryLayers.remove(currentLayer, true);
      } catch {
        /* already removed */
      }
    }
    currentLayer = null;
    currentProvider = null;
  };

  /**
   * Feed a provider's error events into the controller.
   *
   * Cesium raises `errorEvent` on an ImageryProvider when a tile request fails, which
   * is the signal the failure policy is defined against. Listening on the PROVIDER
   * rather than the layer means the listener transfers with the provider and cannot
   * accidentally count an unrelated application error as a basemap failure (§14).
   */
  const observeFailures = (provider: ImageryProvider): void => {
    const providerError = provider.errorEvent;
    if (!providerError) return;
    const listener = (): void => {
      // Report first, then install: if this failure crosses the threshold the
      // controller will have chosen a different source, and the globe must end this
      // turn showing that source rather than the one that just failed.
      controller.reportFailure();
      installActiveSource();
      syncCredit();
    };
    providerError.addEventListener(listener);
    failureListener = { remove: () => providerError.removeEventListener(listener) };
  };

  const installActiveSource = (): void => {
    const handle = controller.activeHandle as ImageryProvider | null;
    if (handle === null) {
      removeCurrentLayer();
      return;
    }
    if (handle === currentProvider) return;
    // Order matters: detach first, so a failure arriving during teardown is not counted
    // against the incoming provider.
    detachFailureListener();
    if (currentLayer) {
      try {
        viewer.imageryLayers.remove(currentLayer, true);
      } catch {
        /* already removed */
      }
    }
    const layer = viewer.imageryLayers.addImageryProvider(handle);
    currentLayer = layer;
    currentProvider = handle;
    observeFailures(handle);
  };

  const controller = new MapSourceController({
    sources: buildMapSources((kind) => createImageryProvider(kind, ionToken)),
  });

  function syncCredit(): void {
    const active = controller.status().activeId;
    const spec = controller.sources.find((s) => s.id === active);
    credit.basemap.textContent = spec?.attribution ?? '';
  }

  controller.start();
  installActiveSource();
  syncCredit();

  viewer.basemap = {
    controller,
    credit,
    status: () => controller.status(),
    syncCredit,
    applyActive: () => {
      installActiveSource();
      syncCredit();
    },
    dispose: () => {
      detachFailureListener();
      removeCurrentLayer();
      controller.dispose();
      credit.root.remove();
    },
  };

  return viewer;
}