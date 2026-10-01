/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Floating Left Action Rail & Side Drawers
 * Collapsible floating rail with on-demand glass panels.
 */

import React, { useState } from 'react';
import { Layers, Globe, Filter, Sliders, X, Radio, Eye } from 'lucide-react';
import { DisplayOptions, RegionScenario } from '../../types/darkfleet.ts';

interface LeftRailProps {
  scenarios: RegionScenario[];
  selectedScenario: RegionScenario;
  onSelectScenario: (scenario: RegionScenario) => void;
  displayOptions: DisplayOptions;
  onToggleDisplayOption: <K extends keyof DisplayOptions>(key: K, val?: DisplayOptions[K]) => void;
  onOpenWorkbench: () => void;
}

export const LeftRail: React.FC<LeftRailProps> = ({
  scenarios,
  selectedScenario,
  onSelectScenario,
  displayOptions,
  onToggleDisplayOption,
  onOpenWorkbench,
}) => {
  const [activePanel, setActivePanel] = useState<'layers' | 'scenes' | 'filters' | null>(null);

  const togglePanel = (panel: 'layers' | 'scenes' | 'filters') => {
    setActivePanel(activePanel === panel ? null : panel);
  };

  return (
    <>
      {/* 1. Floating Rail Icons */}
      <div className="fixed top-[24vh] left-7 sm:left-9 z-20 pointer-events-auto select-none flex flex-col gap-2 font-mono">
        <div
          style={{
            background: 'rgba(8, 16, 24, 0.72)',
            border: '1px solid rgba(130, 200, 220, 0.16)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            borderRadius: '12px',
          }}
          className="p-1 flex flex-col gap-1.5 shadow-xl"
        >
          <button
            onClick={() => togglePanel('layers')}
            className={`p-2.5 rounded-lg transition text-xs flex items-center justify-center ${
              activePanel === 'layers'
                ? 'bg-[#62e8ff]/20 text-[#62e8ff] border border-[#62e8ff]/40'
                : 'text-[#d2e6ec]/50 hover:text-white hover:bg-white/5'
            }`}
            title="Display Layers (L)"
          >
            <Layers className="w-4 h-4" />
          </button>

          <button
            onClick={() => togglePanel('scenes')}
            className={`p-2.5 rounded-lg transition text-xs flex items-center justify-center ${
              activePanel === 'scenes'
                ? 'bg-[#62e8ff]/20 text-[#62e8ff] border border-[#62e8ff]/40'
                : 'text-[#d2e6ec]/50 hover:text-white hover:bg-white/5'
            }`}
            title="Sectors & Satellite Passes"
          >
            <Globe className="w-4 h-4" />
          </button>

          <button
            onClick={() => togglePanel('filters')}
            className={`p-2.5 rounded-lg transition text-xs flex items-center justify-center ${
              activePanel === 'filters'
                ? 'bg-[#62e8ff]/20 text-[#62e8ff] border border-[#62e8ff]/40'
                : 'text-[#d2e6ec]/50 hover:text-white hover:bg-white/5'
            }`}
            title="SAR Visual Filters"
          >
            <Filter className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Floating Glass Drawer (Only ONE open at once) */}
      {activePanel && (
        <div
          style={{
            background: 'rgba(8, 18, 27, 0.88)',
            border: '1px solid rgba(180, 220, 235, 0.16)',
            backdropFilter: 'blur(28px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(28px) saturate(1.4)',
            borderRadius: '14px',
            boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
          }}
          className="fixed top-[24vh] left-20 sm:left-24 z-20 w-[300px] p-4 pointer-events-auto select-none font-mono text-xs text-[#f0f7fa] animate-in fade-in slide-in-from-left-4 duration-200"
        >
          {/* Close header */}
          <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-3">
            <span className="text-[10px] tracking-[2px] uppercase text-[#62e8ff] font-medium">
              {activePanel === 'layers' && 'DISPLAY LAYERS'}
              {activePanel === 'scenes' && 'SECTOR SELECTION'}
              {activePanel === 'filters' && 'SAR COLOR PALETTE'}
            </span>
            <button
              onClick={() => setActivePanel(null)}
              className="text-[#d2e6ec]/40 hover:text-white transition"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* LAYERS DRAWER CONTENT */}
          {activePanel === 'layers' && (
            <div className="space-y-4">
              {/* IMAGERY */}
              <div>
                <span className="text-[9px] tracking-[1.5px] uppercase text-[#d2e6ec]/40 block mb-1.5">
                  IMAGERY
                </span>
                <div className="space-y-1.5 text-[11px]">
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>SAR Raster</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showSarOverlay}
                      onChange={(e) => onToggleDisplayOption('showSarOverlay', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>Coastline Mask</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showLandMask}
                      onChange={(e) => onToggleDisplayOption('showLandMask', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>Swath Footprint</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showSceneFootprint}
                      onChange={(e) => onToggleDisplayOption('showSceneFootprint', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                </div>
              </div>

              {/* CONTACTS */}
              <div>
                <span className="text-[9px] tracking-[1.5px] uppercase text-[#d2e6ec]/40 block mb-1.5">
                  CONTACTS
                </span>
                <div className="space-y-1.5 text-[11px]">
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>SAR Detections</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showDetections}
                      onChange={(e) => onToggleDisplayOption('showDetections', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>AIS Telemetry</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showAisTracks}
                      onChange={(e) => onToggleDisplayOption('showAisTracks', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>Correlation Tethers</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showCorrelationLinks}
                      onChange={(e) => onToggleDisplayOption('showCorrelationLinks', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer text-[#d2e6ec]/80 hover:text-white py-0.5">
                    <span>Kelvin Wakes</span>
                    <input
                      type="checkbox"
                      checked={displayOptions.showWakes}
                      onChange={(e) => onToggleDisplayOption('showWakes', e.target.checked)}
                      className="accent-[#62e8ff]"
                    />
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* SCENES DRAWER CONTENT */}
          {activePanel === 'scenes' && (
            <div className="space-y-1.5 max-h-[50vh] overflow-y-auto pr-1">
              {scenarios.map((sc) => (
                <button
                  key={sc.id}
                  onClick={() => onSelectScenario(sc)}
                  className={`w-full text-left p-2.5 rounded-lg text-[11px] transition flex flex-col ${
                    selectedScenario.id === sc.id
                      ? 'bg-[#62e8ff]/15 border border-[#62e8ff]/40 text-[#62e8ff]'
                      : 'border border-white/5 hover:border-white/20 text-[#d2e6ec]/80 hover:bg-white/5'
                  }`}
                >
                  <span className="font-medium tracking-wide">{sc.name}</span>
                  <span className="text-[9px] text-[#d2e6ec]/40 line-clamp-1 mt-0.5">{sc.satellitePass}</span>
                </button>
              ))}
            </div>
          )}

          {/* FILTERS DRAWER CONTENT */}
          {activePanel === 'filters' && (
            <div className="space-y-2">
              <span className="text-[9px] tracking-[1.5px] uppercase text-[#d2e6ec]/40 block mb-1">
                SAR RASTER PALETTE
              </span>
              {(['sar-mono', 'contrast', 'thermal'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => onToggleDisplayOption('sarColorMode', mode)}
                  className={`w-full text-left p-2 rounded-lg text-[11px] uppercase transition flex items-center justify-between ${
                    displayOptions.sarColorMode === mode
                      ? 'bg-[#62e8ff]/15 border border-[#62e8ff]/40 text-[#62e8ff]'
                      : 'border border-white/5 text-[#d2e6ec]/60 hover:text-white'
                  }`}
                >
                  <span>{mode === 'sar-mono' ? 'Monochrome SAR (Default)' : mode === 'contrast' ? 'High Contrast' : 'Thermal Spectrum'}</span>
                  {displayOptions.sarColorMode === mode && <span className="w-1.5 h-1.5 rounded-full bg-[#62e8ff]" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};
