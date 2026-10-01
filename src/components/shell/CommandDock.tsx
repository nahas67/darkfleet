/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Compact Command Dock
 * Restrained, focused floating primary control surface.
 * Prioritizes Earth visibility while providing seamless access to search, scan,
 * layers, temporal alignment, and specialized workspaces.
 */

import React, { useState } from 'react';
import { 
  Search, 
  Layers, 
  Clock, 
  Eye, 
  RotateCcw, 
  Sliders, 
  Table, 
  Sparkles, 
  Download, 
  Activity, 
  Maximize2,
  MoreHorizontal,
  X,
  Compass
} from 'lucide-react';
import { DisplayMode, DisplayOptions, RegionScenario, ScanProgressEvent, ScanResult } from '../../types/darkfleet.ts';

interface CommandDockProps {
  scenarios: RegionScenario[];
  selectedScenario: RegionScenario;
  onSelectScenario: (scenario: RegionScenario) => void;
  scanResult: ScanResult | null;
  isScanning: boolean;
  scanProgress: ScanProgressEvent | null;
  onTriggerScan: () => void;
  displayMode: DisplayMode;
  onSelectDisplayMode: (mode: DisplayMode) => void;
  displayOptions: DisplayOptions;
  onToggleDisplayOption: <K extends keyof DisplayOptions>(key: K, val?: DisplayOptions[K]) => void;
  onOpenSearch: () => void;
  onOpenTimeline: () => void;
  onOpenLayers: () => void;
  onOpenWorkbench: () => void;
  onOpenTelemetryTable: () => void;
  onOpenDebrief: () => void;
  onOpenSourceHealth: () => void;
  onExportGeoJSON: () => void;
  onExportKML: () => void;
  onExportProtocolJSON: () => void;
  onResetCamera: () => void;
  onToggleCleanView: () => void;
  isCleanView: boolean;
}

export const CommandDock: React.FC<CommandDockProps> = ({
  scenarios,
  selectedScenario,
  onSelectScenario,
  scanResult,
  isScanning,
  scanProgress,
  onTriggerScan,
  displayMode,
  onSelectDisplayMode,
  displayOptions,
  onToggleDisplayOption,
  onOpenSearch,
  onOpenTimeline,
  onOpenLayers,
  onOpenWorkbench,
  onOpenTelemetryTable,
  onOpenDebrief,
  onOpenSourceHealth,
  onExportGeoJSON,
  onExportKML,
  onExportProtocolJSON,
  onResetCamera,
  onToggleCleanView,
  isCleanView,
}) => {
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const [showSectorMenu, setShowSectorMenu] = useState(false);

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-auto select-none font-mono">
      {/* 1. Event-Driven Real Scan Progress Notification */}
      {isScanning && scanProgress && (
        <div className="mb-2 flex items-center justify-between px-3.5 py-1.5 rounded-lg bg-[rgba(8,18,27,0.85)] border border-[#62e8ff]/30 backdrop-blur-md text-[10px] text-[#62e8ff] shadow-xl animate-pulse">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#62e8ff] animate-ping" />
            <span className="font-bold tracking-wider">{scanProgress.stage}</span>
            <span className="text-[#d2e6ec]/50">&bull;</span>
            <span className="text-white/80">{scanProgress.message}</span>
          </div>
          <span className="text-[9px] text-[#d2e6ec]/40 ml-4">
            STEP {scanProgress.step}/{scanProgress.totalSteps}
          </span>
        </div>
      )}

      {/* 2. Compact Main Dock */}
      <div
        style={{
          background: 'rgba(8, 16, 24, 0.82)',
          border: '1px solid rgba(130, 200, 220, 0.18)',
          backdropFilter: 'blur(28px) saturate(1.35)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.35)',
          borderRadius: '16px',
          boxShadow: '0 12px 36px rgba(0,0,0,0.65)',
        }}
        className="px-3 py-2 flex items-center gap-1.5 sm:gap-2 text-xs text-[#f0f7fa]"
      >
        {/* SECTOR SELECTOR */}
        <div className="relative">
          <button
            onClick={() => setShowSectorMenu(!showSectorMenu)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 transition text-[#d2e6ec]/80 hover:text-white"
            title="Select Maritime Sector"
          >
            <Compass className="w-3.5 h-3.5 text-[#62e8ff]" />
            <span className="text-[11px] font-medium tracking-wide truncate max-w-[130px] sm:max-w-[160px]">
              {selectedScenario.name.split('&')[0].trim()}
            </span>
          </button>

          {showSectorMenu && (
            <div className="absolute bottom-12 left-0 w-64 bg-[#090f16]/95 border border-white/10 rounded-xl p-1.5 shadow-2xl backdrop-blur-2xl z-50 space-y-1">
              <div className="text-[9px] tracking-[2px] text-[#d2e6ec]/40 px-2 py-1 uppercase">
                MARITIME SECTORS
              </div>
              {scenarios.map((sc) => (
                <button
                  key={sc.id}
                  onClick={() => {
                    onSelectScenario(sc);
                    setShowSectorMenu(false);
                  }}
                  className={`w-full text-left p-2 rounded-lg text-[11px] transition flex flex-col ${
                    selectedScenario.id === sc.id
                      ? 'bg-[#62e8ff]/15 text-[#62e8ff] border border-[#62e8ff]/30'
                      : 'text-[#d2e6ec]/80 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <span className="font-medium tracking-wide">{sc.name}</span>
                  <span className="text-[9px] text-[#d2e6ec]/40 truncate">{sc.satellitePass}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-white/10" />

        {/* 1. SEARCH ACTION */}
        <button
          onClick={onOpenSearch}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-[#d2e6ec]/70 hover:text-white transition"
          title="Search coordinates, sectors, target IDs, or MMSIs (S)"
        >
          <Search className="w-3.5 h-3.5 text-[#62e8ff]/70" />
          <span className="hidden md:inline text-[11px]">SEARCH</span>
        </button>

        {/* 2. PRIMARY SCAN ACTION */}
        <button
          onClick={onTriggerScan}
          disabled={isScanning}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-xl transition-all duration-200 cursor-pointer ${
            isScanning
              ? 'bg-[#62e8ff]/15 text-[#62e8ff] border border-[#62e8ff]/30 cursor-wait'
              : 'bg-[#62e8ff]/20 hover:bg-[#62e8ff]/30 text-[#62e8ff] border border-[#62e8ff]/40 shadow-[0_0_12px_rgba(98,232,255,0.25)] hover:scale-[1.02] active:scale-[0.98]'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isScanning ? 'bg-amber-400 animate-ping' : 'bg-[#62e8ff]'}`} />
          <span className="text-xs font-semibold tracking-[1.5px]">
            {isScanning ? 'SCANNING' : 'SCAN'}
          </span>
        </button>

        {/* 3. TIME / TIMELINE ACTION */}
        <button
          onClick={onOpenTimeline}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-[#d2e6ec]/70 hover:text-white transition"
          title="Open Temporal Correlation Window & Alignment Timeline"
        >
          <Clock className="w-3.5 h-3.5 text-[#ffc76b]/70" />
          <span className="hidden md:inline text-[11px]">TIME</span>
        </button>

        {/* 4. LAYERS ACTION */}
        <button
          onClick={onOpenLayers}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-[#d2e6ec]/70 hover:text-white transition"
          title="Open Layer Registry & Opacity Controls"
        >
          <Layers className="w-3.5 h-3.5 text-[#62e8ff]/70" />
          <span className="hidden md:inline text-[11px]">LAYERS</span>
        </button>

        {/* 5. VIEW / DISPLAY MODE ACTION */}
        <div className="relative">
          <button
            onClick={() => setShowViewMenu(!showViewMenu)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-[#d2e6ec]/70 hover:text-white transition"
            title="Display Presentation Modes"
          >
            <Eye className="w-3.5 h-3.5 text-[#5cffc6]/70" />
            <span className="hidden md:inline text-[11px] uppercase">{displayMode}</span>
          </button>

          {showViewMenu && (
            <div className="absolute bottom-12 right-0 w-48 bg-[#090f16]/95 border border-white/10 rounded-xl p-1.5 shadow-2xl backdrop-blur-2xl z-50 space-y-1">
              <div className="text-[9px] tracking-[2px] text-[#d2e6ec]/40 px-2 py-1 uppercase">
                DOMAIN VIEW MODES
              </div>
              {(['WORLD', 'SAR', 'SAR_CONTRAST', 'CORRELATION', 'ANALYSIS'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    onSelectDisplayMode(m);
                    setShowViewMenu(false);
                  }}
                  className={`w-full text-left p-1.5 rounded-lg text-[10px] tracking-wider transition ${
                    displayMode === m
                      ? 'bg-[#62e8ff]/20 text-[#62e8ff] font-medium'
                      : 'text-[#d2e6ec]/70 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {m.replace('_', ' ')}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-white/10" />

        {/* MORE / WORKSPACES DRAWER */}
        <div className="relative">
          <button
            onClick={() => setShowToolsMenu(!showToolsMenu)}
            className="p-1.5 rounded-lg hover:bg-white/5 text-[#d2e6ec]/50 hover:text-white transition"
            title="Workspaces & Exports"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>

          {showToolsMenu && (
            <div className="absolute bottom-12 right-0 w-64 bg-[#090f16]/95 border border-white/10 rounded-xl p-2 shadow-2xl backdrop-blur-2xl z-50 space-y-1 text-xs">
              <div className="text-[9px] tracking-[2px] text-[#d2e6ec]/40 px-2 py-1 uppercase border-b border-white/10">
                TOOLS & WORKSPACES
              </div>

              <button
                onClick={() => {
                  onOpenTelemetryTable();
                  setShowToolsMenu(false);
                }}
                className="w-full text-left p-2 rounded-lg hover:bg-white/5 text-[#d2e6ec]/80 hover:text-white flex items-center gap-2 transition"
              >
                <Table className="w-3.5 h-3.5 text-[#62e8ff]" />
                <span>Contacts & Telemetry Table</span>
              </button>

              <button
                onClick={() => {
                  onOpenWorkbench();
                  setShowToolsMenu(false);
                }}
                className="w-full text-left p-2 rounded-lg hover:bg-white/5 text-[#d2e6ec]/80 hover:text-white flex items-center gap-2 transition"
              >
                <Sliders className="w-3.5 h-3.5 text-[#ffc76b]" />
                <span>CFAR Parameter Workbench</span>
              </button>

              <button
                onClick={() => {
                  onOpenDebrief();
                  setShowToolsMenu(false);
                }}
                className="w-full text-left p-2 rounded-lg hover:bg-white/5 text-[#d2e6ec]/80 hover:text-white flex items-center gap-2 transition"
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                <span>Intelligence Debrief (AI)</span>
              </button>

              <button
                onClick={() => {
                  onOpenSourceHealth();
                  setShowToolsMenu(false);
                }}
                className="w-full text-left p-2 rounded-lg hover:bg-white/5 text-[#d2e6ec]/80 hover:text-white flex items-center gap-2 transition"
              >
                <Activity className="w-3.5 h-3.5 text-[#5cffc6]" />
                <span>Provider & Data Health</span>
              </button>

              <div className="border-t border-white/10 pt-1 mt-1">
                <span className="text-[9px] tracking-[1.5px] text-[#d2e6ec]/40 px-2 uppercase block mb-1">
                  EXPORTS
                </span>
                <div className="grid grid-cols-3 gap-1 px-1">
                  <button
                    onClick={() => {
                      onExportGeoJSON();
                      setShowToolsMenu(false);
                    }}
                    className="p-1 rounded text-center bg-white/5 hover:bg-white/10 text-[10px] text-[#62e8ff]"
                  >
                    GeoJSON
                  </button>
                  <button
                    onClick={() => {
                      onExportKML();
                      setShowToolsMenu(false);
                    }}
                    className="p-1 rounded text-center bg-white/5 hover:bg-white/10 text-[10px] text-amber-300"
                  >
                    KML
                  </button>
                  <button
                    onClick={() => {
                      onExportProtocolJSON();
                      setShowToolsMenu(false);
                    }}
                    className="p-1 rounded text-center bg-white/5 hover:bg-white/10 text-[10px] text-emerald-300"
                  >
                    JSON
                  </button>
                </div>
              </div>

              <div className="border-t border-white/10 pt-1 mt-1 flex items-center justify-between px-1">
                <button
                  onClick={() => {
                    onResetCamera();
                    setShowToolsMenu(false);
                  }}
                  className="p-1.5 rounded hover:bg-white/5 text-[#d2e6ec]/50 hover:text-white flex items-center gap-1.5 text-[10px]"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset Camera</span>
                </button>

                <button
                  onClick={() => {
                    onToggleCleanView();
                    setShowToolsMenu(false);
                  }}
                  className={`p-1.5 rounded text-[10px] flex items-center gap-1.5 ${
                    isCleanView ? 'text-[#62e8ff]' : 'text-[#d2e6ec]/50 hover:text-white'
                  }`}
                >
                  <Maximize2 className="w-3 h-3" />
                  <span>{isCleanView ? 'Normal View' : 'Clean View'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
