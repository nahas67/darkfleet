/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet Data Provider Architecture
 * Enforces strict boundary between deterministic DEMO simulation and REAL satellite data.
 * Zero silent fallbacks: REAL mode never calls synthetic generators.
 */

import {
  BoundingBox,
  CFARConfig,
  RegionScenario,
  RuntimeMode,
  ScanEventSink,
  ScanRequest,
  ScanResult,
  SceneQuery,
  SceneSearchResult,
  Sentinel1Scene,
  SourceHealth,
} from '../types/darkfleet.ts';
import { REGION_SCENARIOS, SENTINEL1_SCENES_CATALOG } from './scenes.ts';

export class RealDataUnavailableError extends Error {
  public readonly code = 'REAL_DATA_UNAVAILABLE';
  public readonly details: { sar: string; ais: string };
  public readonly suggestions: string[];

  constructor(
    message: string,
    details = {
      sar: 'Sentinel-1 STAC API endpoint (CDSE/EarthSearch) requires active upstream configuration.',
      ais: 'Historical persisted AIS archive is required for retrospective correlation window (+/-15 min).',
    },
    suggestions = [
      'Switch to DEMO mode to analyze high-fidelity orbital passes.',
      'Configure external STAC & AIS archive provider credentials.',
    ]
  ) {
    super(message);
    this.name = 'RealDataUnavailableError';
    this.details = details;
    this.suggestions = suggestions;
  }
}

export interface DarkFleetDataProvider {
  readonly mode: RuntimeMode;
  listScenes(query?: SceneQuery): Promise<SceneSearchResult>;
  runScan(request: ScanRequest, onProgress?: ScanEventSink): Promise<ScanResult>;
  getScan(scanId: string): Promise<ScanResult>;
  getSourceHealth(): Promise<SourceHealth>;
}

/**
 * DEMO Provider: High-fidelity, deterministic synthetic SAR C-band backscatter & AIS telemetry.
 */
export class DemoDataProvider implements DarkFleetDataProvider {
  public readonly mode: RuntimeMode = 'DEMO';

  async listScenes(_query?: SceneQuery): Promise<SceneSearchResult> {
    try {
      const res = await fetch('/api/scenes');
      if (res.ok) {
        const data = await res.json();
        return {
          scenes: data.scenes || SENTINEL1_SCENES_CATALOG,
          regions: data.regions || REGION_SCENARIOS,
          source: 'Synthetic Sentinel-1 Mission Catalog (Demo)',
          totalAvailable: (data.scenes || SENTINEL1_SCENES_CATALOG).length,
        };
      }
    } catch {
      // offline demo fallback
    }

    return {
      scenes: SENTINEL1_SCENES_CATALOG,
      regions: REGION_SCENARIOS,
      source: 'Local Synthetic Scenario Fixtures (Demo)',
      totalAvailable: SENTINEL1_SCENES_CATALOG.length,
    };
  }

  async runScan(request: ScanRequest, onProgress?: ScanEventSink): Promise<ScanResult> {
    onProgress?.({
      stage: 'QUEUED',
      message: 'Initializing orbital reconnaissance pipeline...',
      step: 1,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    onProgress?.({
      stage: 'SEARCHING_SCENE',
      message: `Accessing scene footprint ${request.sceneId}...`,
      step: 2,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...request,
        runtimeMode: 'DEMO',
      }),
    });

    onProgress?.({
      stage: 'LOADING_SAR',
      message: 'Extracting C-band SAR backscatter window...',
      step: 3,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    onProgress?.({
      stage: 'DETECTING',
      message: 'Running 2D CA-CFAR adaptive thresholding...',
      step: 4,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    onProgress?.({
      stage: 'LOADING_AIS',
      message: 'Retrieving synchronized AIS transponder broadcasts...',
      step: 5,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    onProgress?.({
      stage: 'CORRELATING',
      message: 'Performing kinematic spatio-temporal correlation...',
      step: 6,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Demo scan failed with status HTTP ${res.status}`);
    }

    const data: ScanResult = await res.json();

    onProgress?.({
      stage: 'COMPLETE',
      message: `Correlation completed: ${data.detectionsCount} contacts detected.`,
      step: 7,
      totalSteps: 7,
      timestamp: new Date().toISOString(),
    });

    return data;
  }

  async getScan(scanId: string): Promise<ScanResult> {
    const res = await fetch(`/api/scans/${scanId}`);
    if (!res.ok) {
      throw new Error(`Failed to retrieve scan ${scanId}: HTTP ${res.status}`);
    }
    return await res.json();
  }

  async getSourceHealth(): Promise<SourceHealth> {
    return {
      sar: {
        status: 'available',
        provider: 'Sentinel-1 C-Band Synthetic Radar Engine (Demo)',
        message: 'High-fidelity backscatter simulation operational.',
      },
      ais: {
        status: 'available',
        provider: 'Regional Kinematic Transponder Simulator (Demo)',
        historicalCoverage: 'Full spatial & temporal coverage for scenario windows.',
        message: 'Synthetic telemetry synchronized with satellite passes.',
      },
    };
  }
}

/**
 * REAL Provider: Queries live STAC APIs and persisted historical AIS archives.
 * If credentials or endpoints are unavailable, raises explicit RealDataUnavailableError.
 * NEVER secretly substitutes synthetic or manufactured data.
 */
export class RealDataProvider implements DarkFleetDataProvider {
  public readonly mode: RuntimeMode = 'REAL';

  async listScenes(_query?: SceneQuery): Promise<SceneSearchResult> {
    // Check server STAC discovery
    try {
      const res = await fetch('/api/stac/scenes');
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // ignore
    }

    // Return current available scene references with explicit status
    return {
      scenes: [],
      regions: REGION_SCENARIOS,
      source: 'Copernicus CDSE / AWS Earth Search (Unconfigured)',
      totalAvailable: 0,
    };
  }

  async runScan(request: ScanRequest, onProgress?: ScanEventSink): Promise<ScanResult> {
    onProgress?.({
      stage: 'SEARCHING_SCENE',
      message: 'Connecting to STAC satellite catalog for Sentinel-1 imagery...',
      step: 1,
      totalSteps: 5,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...request,
        runtimeMode: 'REAL',
      }),
    });

    if (res.status === 503 || res.status === 400 || !res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new RealDataUnavailableError(
        body.message || 'REAL SAR satellite imagery or historical AIS archive is unavailable.',
        body.details,
        body.suggestions
      );
    }

    return await res.json();
  }

  async getScan(scanId: string): Promise<ScanResult> {
    const res = await fetch(`/api/scans/${scanId}`);
    if (!res.ok) {
      throw new Error(`Failed to retrieve real scan ${scanId}: HTTP ${res.status}`);
    }
    return await res.json();
  }

  async getSourceHealth(): Promise<SourceHealth> {
    try {
      const res = await fetch('/api/providers/health');
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // ignore
    }

    return {
      sar: {
        status: 'unavailable',
        provider: 'Copernicus Data Space Ecosystem (CDSE) / AWS EarthSearch',
        message: 'External STAC API credentials not configured in environment.',
      },
      ais: {
        status: 'unavailable',
        provider: 'Persisted Terrestrial/Satellite AIS Historical Archive',
        historicalCoverage: 'Historical archive access unconfigured.',
        message: 'Live-only AIS WebSockets cannot correlate against historical overpasses without persistence.',
      },
    };
  }
}

export function getDataProvider(mode: RuntimeMode): DarkFleetDataProvider {
  if (mode === 'REAL') {
    return new RealDataProvider();
  }
  return new DemoDataProvider();
}
