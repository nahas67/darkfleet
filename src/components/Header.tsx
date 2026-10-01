/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { 
  Radar, 
  Satellite, 
  ShieldAlert, 
  Download, 
  Sparkles, 
  Sliders, 
  Layers, 
  RefreshCw,
  Compass,
  FileCode,
  Radio
} from 'lucide-react';
import { RegionScenario, ScanResult } from '../types/darkfleet.ts';

interface HeaderProps {
  scenarios: RegionScenario[];
  selectedScenario: RegionScenario;
  onSelectScenario: (scenario: RegionScenario) => void;
  scanResult: ScanResult | null;
  isScanning: boolean;
  onTriggerScan: () => void;
  onOpenWorkbench: () => void;
  onOpenDebrief: () => void;
  onOpenTable?: () => void;
  isTableOpen?: boolean;
  viewMode?: '2d' | '3d';
  onToggleViewMode?: () => void;
  onExportGeoJSON: () => void;
  onExportKML: () => void;
  onExportProtocolJSON: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  scenarios,
  selectedScenario,
  onSelectScenario,
  scanResult,
  isScanning,
  onTriggerScan,
  onOpenWorkbench,
  onOpenDebrief,
  onOpenTable,
  isTableOpen = false,
  viewMode = '2d',
  onToggleViewMode,
  onExportGeoJSON,
  onExportKML,
  onExportProtocolJSON,
}) => {
  const [zuluTime, setZuluTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setZuluTime(now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const darkCount = scanResult?.unmatchedCount ?? 0;
  const criticalCount = scanResult?.vessels.filter(v => v.classification === 'SAR_UNMATCHED').length ?? 0;

  return (
    <header className="bg-[#080c10] border-b border-cyan-950/60 px-4 py-2.5 flex flex-col md:flex-row items-center justify-between gap-3 text-slate-200 select-none shadow-xl z-30">
      {/* Brand & System Status */}
      <div className="flex items-center gap-3">
        <div className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-cyan-950/60 border border-cyan-500/40 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.25)]">
          <Radar className={`w-5 h-5 ${isScanning ? 'animate-spin' : ''}`} />
          <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
          </span>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono font-bold text-base tracking-wider text-cyan-300 flex items-center gap-1.5">
              DARKFLEET<span className="text-xs px-1.5 py-0.5 rounded bg-cyan-900/60 text-cyan-300 font-semibold border border-cyan-500/30">CORE v1.0</span>
            </h1>
            <span className="hidden sm:inline-block text-[11px] font-mono text-emerald-400 bg-emerald-950/50 border border-emerald-500/30 px-2 py-0.5 rounded">
              ORBITAL LINK ACTIVE
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
            <span className="flex items-center gap-1">
              <Satellite className="w-3 h-3 text-cyan-400" />
              {selectedScenario.satellitePass.split(' ')[0]} C-BAND
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400">{zuluTime}</span>
          </div>
        </div>
      </div>

      {/* Scenario / Hotspot Selector & Quick Stats */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center bg-[#0d1319] border border-slate-800 rounded-lg px-2.5 py-1 text-xs">
          <Compass className="w-3.5 h-3.5 text-cyan-400 mr-2 shrink-0" />
          <span className="text-slate-400 mr-1.5 text-[11px]">SECTOR:</span>
          <select
            value={selectedScenario.id}
            onChange={(e) => {
              const sc = scenarios.find((s) => s.id === e.target.value);
              if (sc) onSelectScenario(sc);
            }}
            className="bg-transparent text-cyan-300 font-mono text-xs focus:outline-none cursor-pointer pr-1"
          >
            {scenarios.map((sc) => (
              <option key={sc.id} value={sc.id} className="bg-[#080c10] text-slate-200">
                {sc.name}
              </option>
            ))}
          </select>
        </div>

        {/* Scan Button */}
        <button
          onClick={onTriggerScan}
          disabled={isScanning}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold tracking-wide border transition-all shadow-md ${
            isScanning
              ? 'bg-slate-800/80 border-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-cyan-900/60 hover:bg-cyan-800/70 border-cyan-500/50 text-cyan-200 hover:text-white shadow-[0_0_12px_rgba(6,182,212,0.3)]'
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
          {isScanning ? 'SCANNING ORBIT...' : 'RUN SAR SCAN'}
        </button>

        {/* CFAR Algorithm Workbench */}
        <button
          onClick={onOpenWorkbench}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono bg-[#0d1319] hover:bg-slate-800/70 border border-slate-700 text-slate-300 hover:text-white transition"
          title="Tweak CA-CFAR detection & land masking parameters"
        >
          <Sliders className="w-3.5 h-3.5 text-cyan-400" />
          <span className="hidden sm:inline">CFAR CONFIG</span>
        </button>

        {/* AI Intelligence Debrief */}
        <button
          onClick={onOpenDebrief}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono bg-purple-950/40 hover:bg-purple-900/60 border border-purple-500/40 text-purple-200 hover:text-white transition shadow-[0_0_10px_rgba(168,85,247,0.2)]"
          title="Generate orbital reconnaissance debrief conforming to protocol"
        >
          <Sparkles className="w-3.5 h-3.5 text-purple-400" />
          <span className="hidden sm:inline">INTEL DEBRIEF</span>
        </button>

        {/* Telemetry Table Toggle */}
        {onOpenTable && (
          <button
            onClick={onOpenTable}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono border transition ${
              isTableOpen
                ? 'bg-cyan-950/70 border-cyan-400 text-cyan-200 font-semibold'
                : 'bg-[#0d1319] hover:bg-slate-800/70 border-slate-700 text-slate-300 hover:text-white'
            }`}
            title="Inspect target contacts and AIS transmissions data table"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">CONTACTS</span>
          </button>
        )}

        {/* 2D / 3D Mode Switcher */}
        {onToggleViewMode && (
          <button
            onClick={onToggleViewMode}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono bg-[#0d1319] hover:bg-slate-800/70 border border-slate-700 text-cyan-300 hover:text-white transition"
            title="Switch between 2D Tactical SAR Radar and 3D Orbital Globe"
          >
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>{viewMode === '2d' ? '2D RADAR' : '3D GLOBE'}</span>
          </button>
        )}

        {/* Threat Counters */}
        {scanResult && (
          <div className="flex items-center gap-2 pl-1 font-mono text-xs">
            <div className={`flex items-center gap-1 px-2 py-1 rounded border ${
              darkCount > 0 
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-300 animate-pulse' 
                : 'bg-slate-900/50 border-slate-800 text-slate-400'
            }`}>
              <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
              <span>{darkCount} DARK</span>
            </div>

            {criticalCount > 0 && (
              <span className="hidden xl:inline-block px-1.5 py-0.5 rounded text-[10px] bg-red-600/30 border border-red-500 text-red-200 font-bold">
                {criticalCount} CRITICAL
              </span>
            )}
          </div>
        )}

        {/* Export Dropdown / Buttons */}
        <div className="flex items-center gap-1 border-l border-slate-800 pl-2">
          <button
            onClick={onExportGeoJSON}
            disabled={!scanResult}
            className="p-1.5 rounded text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 transition disabled:opacity-40 disabled:cursor-not-allowed"
            title="Export GeoJSON FeatureCollection"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onExportKML}
            disabled={!scanResult}
            className="px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 transition disabled:opacity-40"
            title="Export Google Earth KML"
          >
            KML
          </button>
          <button
            onClick={onExportProtocolJSON}
            disabled={!scanResult}
            className="p-1.5 rounded text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 transition disabled:opacity-40"
            title="Export Analytical Protocol JSON"
          >
            <FileCode className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
