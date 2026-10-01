/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet Server Entry Point
 * Full-stack Express backend with mounted Vite middleware.
 * Implements deterministic DEMO simulation, strict REAL provider boundary,
 * CA-CFAR detection, AIS correlation, and evidence-based maritime situational analysis.
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { SENTINEL1_SCENES_CATALOG, REGION_SCENARIOS } from './src/data/scenes.ts';
import { synthesizeSceneRaster } from './src/engine/rasterSynthesis.ts';
import { applyMedianFilter, extractConnectedComponents, runCaCfar } from './src/engine/cfar.ts';
import { correlateDetections } from './src/engine/correlation.ts';
import { formatAnalyticalProtocolJSON, generateGeoJSON, generateKML } from './src/engine/export.ts';
import { 
  CFARConfig, 
  DataSourceStatus, 
  RuntimeMode, 
  ScanProvenance, 
  ScanResult, 
  Sentinel1Scene, 
  SourceHealth 
} from './src/types/darkfleet.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());

// In-memory cache for scans
const scanCache = new Map<string, ScanResult>();

// Default CFAR configuration
const DEFAULT_CFAR_CONFIG: CFARConfig = {
  trainingCells: 16,
  guardCells: 4,
  thresholdFactor: 3.5,
  coastlineBufferMeters: 150,
  speckleFilter: 'median',
  kernelSize: 3,
  minPixels: 3,
  maxPixels: 1000,
};

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

// 1. Scene & Region Discovery
app.get('/api/scenes', (_req, res) => {
  res.json({
    scenes: SENTINEL1_SCENES_CATALOG,
    regions: REGION_SCENARIOS,
  });
});

// 2. Source Health Status
app.get('/api/providers/health', (_req, res) => {
  const hasStacCredentials = Boolean(process.env.CDSE_CLIENT_ID || process.env.AWS_EARTH_SEARCH_KEY);
  const hasAisCredentials = Boolean(process.env.AIS_HISTORICAL_API_KEY);

  const health: SourceHealth = {
    sar: {
      status: hasStacCredentials ? 'available' : 'unavailable',
      provider: 'Copernicus Data Space Ecosystem (CDSE) / AWS EarthSearch',
      message: hasStacCredentials
        ? 'STAC satellite catalog endpoint configured.'
        : 'External STAC credentials unconfigured. Operating in isolated DEMO mode.',
    },
    ais: {
      status: hasAisCredentials ? 'available' : 'unavailable',
      provider: 'Persisted S-AIS / Terrestrial Historical Archive',
      historicalCoverage: hasAisCredentials ? 'Historical window queries enabled' : 'Unconfigured',
      message: hasAisCredentials
        ? 'Historical AIS archive accessible.'
        : 'Historical AIS archive required for retrospective overpass correlation. Live feeds cannot correlate against past satellite passes.',
    },
  };

  res.json(health);
});

// 3. Run Scan & Correlate Pipeline
app.post('/api/scans', async (req, res) => {
  const startTime = Date.now();
  try {
    const { 
      sceneId, 
      bbox, 
      cfarConfig = DEFAULT_CFAR_CONFIG, 
      runtimeMode = 'DEMO' as RuntimeMode 
    } = req.body;

    // REAL MODE GATE: Never silently fall back to simulation
    if (runtimeMode === 'REAL') {
      const hasStacCredentials = Boolean(process.env.CDSE_CLIENT_ID || process.env.AWS_EARTH_SEARCH_KEY);
      const hasAisCredentials = Boolean(process.env.AIS_HISTORICAL_API_KEY);

      return res.status(503).json({
        status: 'unavailable',
        runtimeMode: 'REAL',
        error: 'REAL_SCAN_UNAVAILABLE',
        message: 'Real satellite SAR and historical AIS data providers are not configured in this environment.',
        details: {
          sar: hasStacCredentials
            ? 'Connected to STAC catalog.'
            : 'Sentinel-1 STAC API endpoint (CDSE/EarthSearch) requires active credentials.',
          ais: hasAisCredentials
            ? 'Connected to historical archive.'
            : 'Persisted historical AIS archive is required for retrospective correlation (+/-15 min).',
        },
        suggestions: [
          'Switch to DEMO mode to analyze high-fidelity synthetic passes.',
          'Provide CDSE_CLIENT_ID / AIS_HISTORICAL_API_KEY environment variables to enable REAL queries.',
        ],
      });
    }

    // DEMO MODE PIPELINE
    let scene = SENTINEL1_SCENES_CATALOG.find((s) => s.id === sceneId);
    if (!scene) {
      scene = SENTINEL1_SCENES_CATALOG[0];
    }

    const activeBbox = bbox || scene.bbox;
    const activeScene: Sentinel1Scene = { ...scene, bbox: activeBbox };

    // Step 1: Synthesize SAR raster window & AIS observations (DEMO only)
    const rasterData = synthesizeSceneRaster(activeScene, 180, 180);
    const { width, height, gridDb, landMask, aisObservations } = rasterData;

    // Step 2: Apply speckle reduction filter
    const filteredGrid =
      cfarConfig.speckleFilter === 'median'
        ? applyMedianFilter(gridDb, width, height)
        : gridDb;

    // Step 3: Run 2D CA-CFAR detection
    const detectionsMask = runCaCfar(filteredGrid, width, height, cfarConfig, landMask);

    // Step 4: Extract connected components & target features
    const components = extractConnectedComponents(
      detectionsMask,
      filteredGrid,
      width,
      height,
      cfarConfig,
      activeScene.resolutionMeters
    );

    // Step 5: Spatio-temporal matching with AIS observations
    const scanId = `SCAN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    const { targets, aisOnlyCount } = correlateDetections(
      components,
      aisObservations,
      activeScene,
      width,
      height,
      scanId
    );

    const unmatchedCount = targets.filter((t) => t.classification === 'SAR_UNMATCHED').length;
    const matchedCount = targets.filter((t) => t.classification === 'SAR_MATCHED_AIS').length;
    const staticCount = targets.filter((t) => t.classification === 'STATIONARY_OR_INFRASTRUCTURE').length;

    const dataSource: DataSourceStatus = {
      mode: 'DEMO',
      sarSource: 'Synthetic C-Band GRD (Simulation)',
      aisSource: 'Kinematic AIS Observation Archive (Simulation)',
      satellitePlatform: activeScene.platform,
      sensorMode: activeScene.mode,
      polarization: activeScene.polarization,
      isSynthetic: true,
    };

    const provenance: ScanProvenance = {
      runtimeMode: 'DEMO',
      sarSource: `Synthetic Sentinel-1 ${activeScene.platform} ${activeScene.mode} ${activeScene.polarization}`,
      sarSceneId: activeScene.id,
      aisSource: 'S-AIS Regional Synthetic Kinematic Archive',
      acquisitionTimestamp: activeScene.acquisitionTime,
      processingTimestamp: new Date().toISOString(),
      processingVersion: 'DarkFleet-Core 3.0.0',
      classificationSchemaVersion: 'DarkFleet-Neutral-v1',
      synthetic: true,
      cfarConfig,
    };

    // Step 6: Generate objective evidence summary
    const defaultSummary = `SAR observation analyzed for ${activeScene.regionName} (${activeScene.platform} ${activeScene.polarization} mode simulation). Identified ${targets.length} total surface radar signatures: ${matchedCount} correlated with reporting AIS transponders, ${unmatchedCount} unmatched radar detections without valid transponder association in the available observation window, and ${staticCount} stationary returns. Unmatched contacts indicate absence of correlated AIS broadcast in the available archive, which may stem from transponder carriage exemptions, antenna reception shadows, or non-transmitting operation.`;

    const scanResult: ScanResult = {
      scanId,
      runtimeMode: 'DEMO',
      scene: activeScene,
      aoi: activeBbox,
      timestamp: new Date().toISOString(),
      cfarConfig,
      detectionsCount: targets.length,
      unmatchedCount,
      matchedCount,
      staticCount,
      aisOnlyCount,
      scanConfidence: Number((Math.min(0.96, 0.78 + (matchedCount / Math.max(1, targets.length)) * 0.18)).toFixed(2)),
      vessels: targets,
      aisObservations,
      areaSummary: defaultSummary,
      processingTimeMs: Date.now() - startTime,
      dataSource,
      provenance,
    };

    scanCache.set(scanId, scanResult);

    res.json(scanResult);
  } catch (error: any) {
    console.error('Scan processing error:', error);
    res.status(500).json({ error: error.message || 'Scan processing failed' });
  }
});

// 4. Get Scan by ID
app.get('/api/scans/:id', (req, res) => {
  const scan = scanCache.get(req.params.id);
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  res.json(scan);
});

// 5. Export GeoJSON
app.get('/api/scans/:id/geojson', (req, res) => {
  const scan = scanCache.get(req.params.id);
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  const geojson = generateGeoJSON(scan);
  res.setHeader('Content-Type', 'application/geo+json');
  res.setHeader('Content-Disposition', `attachment; filename="${scan.scanId}.geojson"`);
  res.json(geojson);
});

// 6. Export KML
app.get('/api/scans/:id/kml', (req, res) => {
  const scan = scanCache.get(req.params.id);
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  const kml = generateKML(scan);
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${scan.scanId}.kml"`);
  res.send(kml);
});

// 7. Export Protocol JSON
app.get('/api/scans/:id/protocol-json', (req, res) => {
  const scan = scanCache.get(req.params.id);
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  res.json(formatAnalyticalProtocolJSON(scan));
});

// 8. AI Maritime Situational Intelligence Briefing using @google/genai (Gate 24)
app.post('/api/scans/analyze-ai', async (req, res) => {
  try {
    const { scanId } = req.body;
    const scan = scanCache.get(scanId);

    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.json({
        observed: [
          `Detected ${scan.detectionsCount} surface radar contacts via ${scan.scene.platform}.`,
          `${scan.matchedCount} contacts associated with broadcasting AIS transponders.`,
          `${scan.unmatchedCount} contacts observed with no matching AIS transmission in the correlation window.`,
        ],
        hypotheses: [
          'Unmatched contacts may represent vessels exempt from mandatory AIS carriage (e.g. fishing craft <300 GT or local artisanal vessels).',
          'Potential terrestrial or satellite AIS line-of-sight reception blockage in high-density corridors.',
          'Possible non-transmitting operation or transponder power outage.',
        ],
        unknowns: [
          'Optical confirmation of vessel superstructure and flag registry.',
          'Pre-acquisition voyage history outside the overpass correlation window.',
        ],
        confidence: {
          sar: 0.94,
          ais_coverage: 0.86,
          correlation: scan.scanConfidence,
        },
        summary: scan.areaSummary,
        assessments: scan.vessels.map((v) => ({
          target_id: v.id,
          tactical_assessment: v.tacticalAssessment,
        })),
        aiPowered: false,
      });
    }

    const ai = new GoogleGenAI({});

    const prompt = `You are DarkFleet-Core, an analytical maritime orbital reconnaissance correlation system.
Analyze the following SAR + AIS correlation telemetry for Sector: ${scan.scene.regionName}.

Acquisition Sensor: ${scan.scene.platform} (${scan.scene.mode} mode, polarization ${scan.scene.polarization}) [MODE: ${scan.runtimeMode}]
Total Radar Detections: ${scan.detectionsCount}
Correlated AIS Transponders: ${scan.matchedCount}
Unmatched Radar Contacts: ${scan.unmatchedCount}
Stationary Infrastructure: ${scan.staticCount}

Target details:
${scan.vessels.map(v => `- ID ${v.id}: ${v.classification} | Apparent Length: ~${v.estimatedLengthMeters}m | Peak Backscatter: ${v.maxBackscatterDb} dB | Wake visible: ${v.wakeVisible} | Associated AIS: ${v.aisCorrelation.mmsi || 'UNASSOCIATED'} (${v.aisCorrelation.distanceOffsetMeters ? v.aisCorrelation.distanceOffsetMeters + 'm' : 'N/A'}) | Tags: ${v.tags.join(', ')}`).join('\n')}

OPERATIONAL RULES (EVIDENCE SAFETY):
1. Maintain an objective, scientific, evidence-based tone.
2. DO NOT invent criminal motives, sanctions evasion, smuggling, or deliberate deception solely from lack of AIS association. An unmatched radar return signifies only that a radar signature was detected without corresponding AIS within the correlation envelope.
3. Clearly separate OBSERVED facts, HYPOTHESES, and UNKNOWNS.
4. For each contact, provide a 1-2 sentence evidence-based assessment summarizing physical dimensions, radar cross section backscatter, wake indications, and transponder correlation state.
5. Output strictly valid JSON with this exact structure:
{
  "observed": ["string"],
  "hypotheses": ["string"],
  "unknowns": ["string"],
  "confidence": {
    "sar": 0.94,
    "ais_coverage": 0.86,
    "correlation": 0.90
  },
  "summary": "1-paragraph objective situational area summary",
  "assessments": [
    {
      "target_id": "DF-001",
      "tactical_assessment": "1-2 sentence objective evidence debrief"
    }
  ]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    
    if (parsed.summary) {
      scan.areaSummary = parsed.summary;
    }
    if (Array.isArray(parsed.assessments)) {
      parsed.assessments.forEach((item: any) => {
        const v = scan.vessels.find((t) => t.id === item.target_id);
        if (v && item.tactical_assessment) {
          v.tacticalAssessment = item.tactical_assessment;
        }
      });
    }

    res.json({
      observed: parsed.observed || [],
      hypotheses: parsed.hypotheses || [],
      unknowns: parsed.unknowns || [],
      confidence: parsed.confidence || {},
      summary: scan.areaSummary,
      assessments: parsed.assessments || [],
      aiPowered: true,
    });
  } catch (error: any) {
    console.error('AI analysis error:', error);
    res.status(500).json({ error: error.message || 'AI debrief failed' });
  }
});

// 9. Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'online',
    version: '3.0.0',
    system: 'DarkFleet-Core Orbital Reconnaissance Engine',
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// VITE CLIENT MOUNTING (DEV & PROD)
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`[DarkFleet-Core] Intelligence Server online at http://0.0.0.0:${PORT}`);
  });
}

startServer();
