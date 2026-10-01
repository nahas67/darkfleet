/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet Core Application Entry
 * Orbital Reconnaissance & SAR/AIS Maritime Vessel Correlation Platform
 */

import React, { useState, useEffect, useCallback, Component, ErrorInfo, ReactNode } from 'react';
import { Header } from './components/Header.tsx';
import { TacticalMap } from './components/TacticalMap.tsx';
import { TargetInspector } from './components/TargetInspector.tsx';
import { CFARWorkbench } from './components/CFARWorkbench.tsx';
import { IntelligenceDebriefModal } from './components/IntelligenceDebriefModal.tsx';
import { ScanWorkflowBar } from './components/ScanWorkflowBar.tsx';
import { AISTelemetryTable } from './components/AISTelemetryTable.tsx';
import { DarkFleetGlobe } from './globe/DarkFleetGlobe.tsx';
import { REGION_SCENARIOS, SENTINEL1_SCENES_CATALOG } from './data/scenes.ts';
import { synthesizeSceneRaster } from './engine/rasterSynthesis.ts';
import { applyMedianFilter, runCaCfar, extractConnectedComponents } from './engine/cfar.ts';
import { correlateDetections } from './engine/correlation.ts';
import { generateGeoJSON, generateKML, formatAnalyticalProtocolJSON } from './engine/export.ts';
import { 
  BoundingBox, 
  CFARConfig, 
  DisplayOptions, 
  RegionScenario, 
  ScanResult, 
  VesselTarget 
} from './types/darkfleet.ts';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackText?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class TacticalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Tactical Viewport Error caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center bg-[#05080c] text-cyan-300 p-8 font-mono text-center">
          <AlertTriangle className="w-12 h-12 text-amber-400 mb-4 animate-pulse" />
          <h2 className="text-lg font-bold tracking-wider mb-2">TACTICAL VIEWPORT RECOVERY</h2>
          <p className="text-xs text-slate-400 max-w-md mb-6 leading-relaxed">
            {this.props.fallbackText || 'Hardware renderer encountered an interruption. Defaulting to 2D SAR Radar raster engine.'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onReset?.();
            }}
            className="flex items-center gap-2 px-4 py-2 rounded bg-cyan-900/60 border border-cyan-500/50 text-xs font-semibold hover:bg-cyan-800 text-white transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            RELOAD TACTICAL VIEW
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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

const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  showSarOverlay: true,
  showLandMask: true,
  showDetections: true,
  showAisTracks: true,
  showCorrelationLinks: true,
  showWakes: true,
  showSceneFootprint: true,
  showUncertaintyRings: true,
  sarColorMode: 'sar-mono',
  showHeatmapOverlay: true,
  heatmapOpacity: 0.70,
  heatmapPalette: 'thermal',
};

export default function App() {
  const [scenarios] = useState<RegionScenario[]>(REGION_SCENARIOS);
  const [selectedScenario, setSelectedScenario] = useState<RegionScenario>(REGION_SCENARIOS[0]);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<VesselTarget | null>(null);
  const [cfarConfig, setCfarConfig] = useState<CFARConfig>(DEFAULT_CFAR_CONFIG);
  const [displayOptions, setDisplayOptions] = useState<DisplayOptions>(DEFAULT_DISPLAY_OPTIONS);

  const handleUpdateDisplayOptions = (patch: Partial<DisplayOptions>) => {
    setDisplayOptions((prev) => ({ ...prev, ...patch }));
  };

  // Raster & land mask data for display
  const [rasterGrid, setRasterGrid] = useState<number[][]>([]);
  const [landMask, setLandMask] = useState<boolean[][]>([]);

  // Pipeline execution state
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [currentStage, setCurrentStage] = useState<string>('COMPLETE');

  // Modals & Panels
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState<boolean>(false);
  const [isDebriefOpen, setIsDebriefOpen] = useState<boolean>(false);
  const [isTableOpen, setIsTableOpen] = useState<boolean>(false);
  const [isGeneratingAI, setIsGeneratingAI] = useState<boolean>(false);

  // View mode: '2d' (Primary 2D Canvas Radar - reliable & instant) or '3d' (Orbital Globe)
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const [notification, setNotification] = useState<string | null>(null);

  // Local fallback scan processing if server endpoint is slow or unreachable
  const runLocalScan = useCallback((scenario: RegionScenario, config: CFARConfig): ScanResult => {
    const scene = SENTINEL1_SCENES_CATALOG.find((s) => s.id === scenario.defaultSceneId) || SENTINEL1_SCENES_CATALOG[0];
    const syn = synthesizeSceneRaster(scene, 180, 180);
    const { width, height, gridDb, landMask: mask, aisObservations } = syn;

    const filtered = config.speckleFilter === 'median' ? applyMedianFilter(gridDb, width, height) : gridDb;
    const detMask = runCaCfar(filtered, width, height, config, mask);
    const components = extractConnectedComponents(detMask, filtered, width, height, config, scene.resolutionMeters);
    const scanId = `SCAN-${Date.now().toString(36).toUpperCase()}`;
    const { targets, aisOnlyCount } = correlateDetections(components, aisObservations, scene, width, height, scanId);

    const darkCount = targets.filter((t) => t.classification === 'SAR_UNMATCHED').length;
    const verifiedCount = targets.filter((t) => t.classification === 'SAR_MATCHED_AIS').length;
    const staticCount = targets.filter((t) => t.classification === 'STATIONARY_OR_INFRASTRUCTURE').length;

    return {
      scanId,
      runtimeMode: 'DEMO',
      scene,
      aoi: scenario.bbox,
      timestamp: new Date().toISOString(),
      cfarConfig: config,
      detectionsCount: targets.length,
      unmatchedCount: darkCount,
      matchedCount: verifiedCount,
      staticCount,
      aisOnlyCount,
      scanConfidence: 0.94,
      vessels: targets,
      aisObservations,
      areaSummary: `${scenario.name}: Radar scan completed with ${targets.length} surface returns. Detected ${darkCount} non-correlated dark targets with transponder suppression.`,
      processingTimeMs: 140,
      dataSource: {
        mode: 'DEMO',
        sarSource: 'Sentinel-1 C-band IW GRD (Synthetic Model)',
        aisSource: 'S-AIS Regional Terrestrial/Satellite Archive',
        satellitePlatform: scene.platform,
        sensorMode: scene.mode,
        polarization: scene.polarization,
        isSynthetic: true,
      },
      provenance: {
        runtimeMode: 'DEMO',
        sarSource: `Synthetic Sentinel-1 ${scene.platform} ${scene.mode} ${scene.polarization}`,
        sarSceneId: scene.id,
        aisSource: 'S-AIS Regional Synthetic Kinematic Archive',
        acquisitionTimestamp: scene.acquisitionTime,
        processingTimestamp: new Date().toISOString(),
        processingVersion: 'DarkFleet-Core 3.0.0',
        classificationSchemaVersion: 'DarkFleet-Neutral-v1',
        synthetic: true,
        cfarConfig: config,
      },
    };
  }, []);

  // Main scan execution
  const runScan = useCallback(async (scenario = selectedScenario, config = cfarConfig, customBbox?: BoundingBox) => {
    setIsScanning(true);
    setCurrentStage('SEARCHING_SCENE');

    const scene = SENTINEL1_SCENES_CATALOG.find((s) => s.id === scenario.defaultSceneId) || SENTINEL1_SCENES_CATALOG[0];
    const activeBbox = customBbox || scenario.bbox;
    const activeScene = { ...scene, bbox: activeBbox };

    // Immediately synthesize raster locally so viewport is instantly populated
    const syn = synthesizeSceneRaster(activeScene, 180, 180);
    setRasterGrid(syn.gridDb);
    setLandMask(syn.landMask);

    // Progressive stage simulation
    const t1 = setTimeout(() => setCurrentStage('LOADING_SAR'), 80);
    const t2 = setTimeout(() => setCurrentStage('MASKING_LAND'), 180);
    const t3 = setTimeout(() => setCurrentStage('FILTERING'), 280);
    const t4 = setTimeout(() => setCurrentStage('DETECTING'), 400);
    const t5 = setTimeout(() => setCurrentStage('LOADING_AIS'), 550);
    const t6 = setTimeout(() => setCurrentStage('CORRELATING'), 700);

    try {
      const res = await fetch('/api/scans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneId: scene.id,
          bbox: activeBbox,
          cfarConfig: config,
        }),
      });

      if (res.ok) {
        const data: ScanResult = await res.json();
        setScanResult(data);
        const darkTarget = data.vessels.find((v) => v.classification === 'SAR_UNMATCHED') || data.vessels[0];
        if (darkTarget) {
          setSelectedTarget(darkTarget);
        }
      } else {
        const fallback = runLocalScan(scenario, config);
        setScanResult(fallback);
        setSelectedTarget(fallback.vessels.find((v) => v.classification === 'SAR_UNMATCHED') || fallback.vessels[0]);
      }
    } catch {
      const fallback = runLocalScan(scenario, config);
      setScanResult(fallback);
      setSelectedTarget(fallback.vessels.find((v) => v.classification === 'SAR_UNMATCHED') || fallback.vessels[0]);
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      clearTimeout(t6);
      setTimeout(() => {
        setIsScanning(false);
        setCurrentStage('COMPLETE');
      }, 850);
    }
  }, [selectedScenario, cfarConfig, runLocalScan]);

  // Initial scan on mount
  useEffect(() => {
    runScan(selectedScenario, cfarConfig);
  }, []);

  const handleSelectScenario = (sc: RegionScenario) => {
    setSelectedScenario(sc);
    setSelectedTarget(null);
    runScan(sc, cfarConfig);
  };

  const handleApplyConfig = (newConfig: CFARConfig) => {
    setCfarConfig(newConfig);
    runScan(selectedScenario, newConfig);
  };

  const handleBoxSelected = (bbox: BoundingBox) => {
    runScan(selectedScenario, cfarConfig, bbox);
  };

  const handleExportGeoJSON = () => {
    if (!scanResult) return;
    const geo = generateGeoJSON(scanResult);
    const blob = new Blob([JSON.stringify(geo, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `darkfleet-${scanResult.scanId}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportKML = () => {
    if (!scanResult) return;
    const kml = generateKML(scanResult);
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `darkfleet-${scanResult.scanId}.kml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportProtocolJSON = () => {
    if (!scanResult) return;
    const proto = formatAnalyticalProtocolJSON(scanResult);
    const blob = new Blob([JSON.stringify(proto, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `darkfleet-${scanResult.scanId}-protocol.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRefreshAI = async () => {
    if (!scanResult) return;
    setIsGeneratingAI(true);
    try {
      const res = await fetch('/api/scans/analyze-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId: scanResult.scanId }),
      });
      if (res.ok) {
        const data = await res.json();
        setScanResult((prev) => {
          if (!prev) return prev;
          const updated = { ...prev, areaSummary: data.areaSummary || prev.areaSummary };
          if (Array.isArray(data.assessments)) {
            data.assessments.forEach((item: any) => {
              const v = updated.vessels.find((t) => t.id === item.target_id);
              if (v && item.tactical_assessment) {
                v.tacticalAssessment = item.tactical_assessment;
              }
            });
          }
          return updated;
        });
      }
    } catch (err) {
      console.error('AI debrief request failed:', err);
    } finally {
      setIsGeneratingAI(false);
    }
  };

  const handleToggleViewMode = () => {
    if (viewMode === '2d') {
      setViewMode('3d');
    } else {
      setViewMode('2d');
    }
  };

  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-[#05080c] text-slate-100 select-none">
      {/* 1. Tactical Command Header */}
      <Header
        scenarios={scenarios}
        selectedScenario={selectedScenario}
        onSelectScenario={handleSelectScenario}
        scanResult={scanResult}
        isScanning={isScanning}
        onTriggerScan={() => runScan(selectedScenario, cfarConfig)}
        onOpenWorkbench={() => setIsWorkbenchOpen(true)}
        onOpenDebrief={() => setIsDebriefOpen(true)}
        onOpenTable={() => setIsTableOpen((prev) => !prev)}
        isTableOpen={isTableOpen}
        viewMode={viewMode}
        onToggleViewMode={handleToggleViewMode}
        onExportGeoJSON={handleExportGeoJSON}
        onExportKML={handleExportKML}
        onExportProtocolJSON={handleExportProtocolJSON}
      />

      {/* Notification Banner */}
      {notification && (
        <div className="bg-amber-950/90 border-b border-amber-500/50 px-4 py-1.5 flex items-center justify-between text-xs font-mono text-amber-200 z-40">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>{notification}</span>
          </div>
          <button onClick={() => setNotification(null)} className="p-0.5 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 2. Main Geospatial Tactical Center (2D Radar or 3D Globe) */}
      <div className="relative flex-1 w-full h-full overflow-hidden">
        <TacticalErrorBoundary
          fallbackText="3D hardware acceleration was interrupted. Defaulting to 2D SAR Radar view."
          onReset={() => setViewMode('2d')}
        >
          {viewMode === '2d' ? (
            <TacticalMap
              scanResult={scanResult}
              selectedTarget={selectedTarget}
              onSelectTarget={(tgt) => setSelectedTarget(tgt)}
              rasterGrid={rasterGrid}
              landMask={landMask}
              onBoxSelected={handleBoxSelected}
              displayOptions={displayOptions}
              onUpdateDisplayOptions={handleUpdateDisplayOptions}
            />
          ) : (
            <div className="relative w-full h-full">
              <DarkFleetGlobe
                scenario={selectedScenario}
                scanResult={scanResult}
                selectedTarget={selectedTarget}
                rasterGrid={rasterGrid}
                landMask={landMask}
                displayOptions={displayOptions}
                isScanning={isScanning}
                onSelectTarget={(tgt) => setSelectedTarget(tgt)}
                onError={(_err) => {
                  setNotification('3D WebGL Globe hardware acceleration unavailable. Reverting to 2D Tactical SAR Radar.');
                  setViewMode('2d');
                }}
              />
            </div>
          )}
        </TacticalErrorBoundary>

        {/* 3. Floating Target Evidence Inspector */}
        {selectedTarget && (
          <div className="absolute top-3 right-3 z-30 max-w-sm w-full shadow-2xl">
            <TargetInspector
              target={selectedTarget}
              onClose={() => setSelectedTarget(null)}
            />
          </div>
        )}

        {/* 4. Collapsible Telemetry & AIS Transmissions Drawer */}
        {isTableOpen && (
          <div className="absolute bottom-0 left-0 right-0 z-30 max-h-[48vh] overflow-hidden shadow-2xl">
            <AISTelemetryTable
              scanResult={scanResult}
              selectedTarget={selectedTarget}
              onSelectTarget={(tgt) => setSelectedTarget(tgt)}
              isOpen={isTableOpen}
              onToggleOpen={() => setIsTableOpen(false)}
            />
          </div>
        )}
      </div>

      {/* 5. Bottom Multi-Stage Scan Workflow Bar */}
      <ScanWorkflowBar
        scanResult={scanResult}
        isScanning={isScanning}
        currentStage={currentStage}
      />

      {/* 6. CFAR Algorithm Analysis Workbench Modal */}
      <CFARWorkbench
        config={cfarConfig}
        isOpen={isWorkbenchOpen}
        onClose={() => setIsWorkbenchOpen(false)}
        onApplyConfig={handleApplyConfig}
      />

      {/* 7. Maritime Intelligence Debrief Modal */}
      <IntelligenceDebriefModal
        scanResult={scanResult}
        isOpen={isDebriefOpen}
        onClose={() => setIsDebriefOpen(false)}
        onRefreshAI={handleRefreshAI}
        isGeneratingAI={isGeneratingAI}
      />
    </div>
  );
}
