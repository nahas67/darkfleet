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
import { appStore } from './app/state.ts';
import type { ProvidersHealth } from './types/api.ts';

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

  const handleViewerReady = useCallback((viewer: unknown) => {
    // CP9 wires the LayerRegistry to this viewer. The shell itself stays free
    // of Cesium logic; this is the single handoff point.
    if (viewer instanceof Viewer) window.__darkfleetViewer = viewer;
  }, []);

  return (
    <SpatialShell client={client} onViewerReady={handleViewerReady}>
      <Globe onReady={handleViewerReady} />
    </SpatialShell>
  );
}

declare global {
  interface Window {
    /** Single handoff to the Cesium Viewer for CP9 layer wiring. */
    __darkfleetViewer?: Viewer;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('[DarkFleet] #root not found');

createRoot(container).render(<Root />);