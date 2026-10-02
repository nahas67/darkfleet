/**
 * Application entry point.
 *
 * The vNext product mounts the full-screen Cesium globe INSIDE the spatial
 * shell, so chrome always paints above the globe and the Earth dominates the
 * viewport. The legacy dashboard composition is deliberately not mounted here;
 * its capabilities are migrated into the shell and its files are removed once
 * `docs/UI_FEATURE_MIGRATION.md` shows each one shipped.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Viewer } from 'cesium';
import './index.css';

import { SpatialShell } from './app/SpatialShell.tsx';
import { createApiClient, toProvidersHealth } from './app/useApi.ts';
import { initializeCesiumViewer } from './globe/cesiumViewer.ts';
import {
  createGlobeBridge,
  disposeGlobeBridge,
  pushScanResult,
} from './globe/globeBridge.ts';
import type { LayerRegistry } from './globe/registry.ts';
import { appStore } from './app/state.ts';
import type { ProvidersHealth, ScanResult } from './types/api.ts';

/**
 * Mounts the globe into the shell's container and tears it down on unmount.
 * The Viewer's lifetime is owned here so resizing the shell never leaks a
 * WebGL context.
 */
function Globe({ onReady }: { onReady: (viewer: unknown) => void }): React.ReactElement | null {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let viewer: Viewer;
    try {
      viewer = initializeCesiumViewer({ container: host });
    } catch (err) {
      // A missing WebGL context must degrade visibly, not silently.
      console.error('[DarkFleet] Cesium failed to initialise:', err);
      return undefined;
    }
    viewerRef.current = viewer;
    onReady(viewer);

    return () => {
      try {
        if (!viewer.isDestroyed()) viewer.destroy();
      } catch (err) {
        console.error('[DarkFleet] Cesium teardown failed:', err);
      }
      viewerRef.current = null;
    };
  }, [onReady]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}

function Root(): React.ReactElement {
  // Provider status comes from the backend's live probe. One client instance is
  // created here and never re-created, so in-flight scans keep their transport.
  const [client] = useState(() => createApiClient());
  const [registry, setRegistry] = useState<LayerRegistry | null>(null);

  useEffect(() => {
    void client
      .getProvidersHealth()
      .then((response) => {
        // The backend response is the raw probe; adapt it to the wire contract
        // so the shell renders the same shape it tests against.
        const health: ProvidersHealth = toProvidersHealth(response);
        appStore.setProviders(health, response.checked_at ?? null, null);
      })
      .catch((err: unknown) => {
        // A failed probe is shown as a real failure, never as "online".
        appStore.setProviders(null, null, err instanceof Error ? err.message : String(err));
      });
  }, [client]);

  // The globe's layers follow the store, and the store follows the backend.
  // This effect is the whole of the wiring that CP9 described and never built:
  // a completed scan reaches `appStore`, and this pushes it onto the viewer.
  useEffect(() => {
    const viewer = window.__darkfleetViewer;
    if (!registry || !viewer || viewer.isDestroyed()) return undefined;

    const apply = (): void => {
      if (viewer.isDestroyed()) return;
      pushScanResult(registry, viewer, appStore.getState().scanResult);
    };

    apply();
    return appStore.subscribe(apply);
  }, [registry]);

  // Layer visibility is owned by the layer panel. Mirroring it here is what
  // makes those switches do something; before this, they changed store state and
  // no Cesium object was ever consulted.
  useEffect(() => {
    if (!registry) return undefined;
    const applyVisibility = (): void => {
      const state = appStore.getState();
      for (const [id, layer] of Object.entries(state.layers)) {
        registry.setVisible(id as never, layer.visible);
      }
    };
    applyVisibility();
    return appStore.subscribe(applyVisibility);
  }, [registry]);

  useEffect(() => () => disposeGlobeBridge(registry), [registry]);

  const handleViewerReady = useCallback((viewer: unknown) => {
    if (!(viewer instanceof Viewer)) return;
    // Debug handle only. Nothing in the product reaches the viewer through this;
    // the bridge above owns the LayerRegistry and pushes scan data through it.
    window.__darkfleetViewer = viewer;
    setRegistry(createGlobeBridge(viewer));
  }, []);

  return (
    <SpatialShell client={client} onViewerReady={handleViewerReady}>
      <Globe onReady={handleViewerReady} />
    </SpatialShell>
  );
}

declare global {
  interface Window {
    /**
     * Read-only handle on the Cesium Viewer, for debugging and for a browser
     * console. This is NOT how layers are wired: `GlobeBridge` owns the
     * LayerRegistry and pushes scan data through it. Nothing in the product
     * should reach the viewer through this global.
     */
    __darkfleetViewer?: Viewer;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('[DarkFleet] #root not found');

createRoot(container).render(<Root />);