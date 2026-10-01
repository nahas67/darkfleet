/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * CFAR Algorithm Analysis Workspace
 * Centered glass workspace for fine-tuning radar detection parameters.
 */

import React, { useState } from 'react';
import { X, Sliders, Play, RotateCcw, Cpu } from 'lucide-react';
import { CFARConfig } from '../types/darkfleet.ts';

interface CFARWorkbenchProps {
  config: CFARConfig;
  isOpen: boolean;
  onClose: () => void;
  onApplyConfig: (newConfig: CFARConfig) => void;
}

export const CFARWorkbench: React.FC<CFARWorkbenchProps> = ({
  config,
  isOpen,
  onClose,
  onApplyConfig,
}) => {
  const [currentConfig, setCurrentConfig] = useState<CFARConfig>({ ...config });

  if (!isOpen) return null;

  const presets = [
    {
      name: 'Standard Sentinel-1',
      desc: 'Balanced IW mode parameters for general maritime surveillance',
      cfg: { trainingCells: 16, guardCells: 4, thresholdFactor: 3.5, coastlineBufferMeters: 150, speckleFilter: 'median' as const, kernelSize: 3, minPixels: 3, maxPixels: 1000 },
    },
    {
      name: 'High Sensitivity',
      desc: 'Lower threshold for small craft in calm seas',
      cfg: { trainingCells: 12, guardCells: 2, thresholdFactor: 2.7, coastlineBufferMeters: 100, speckleFilter: 'median' as const, kernelSize: 3, minPixels: 2, maxPixels: 1200 },
    },
    {
      name: 'High Sea State / Clutter',
      desc: 'Elevated threshold to suppress breaking wave crests',
      cfg: { trainingCells: 24, guardCells: 6, thresholdFactor: 4.5, coastlineBufferMeters: 200, speckleFilter: 'median' as const, kernelSize: 3, minPixels: 4, maxPixels: 800 },
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 pointer-events-auto font-mono text-xs text-[#f0f7fa]">
      <div
        style={{
          background: 'rgba(8, 16, 24, 0.92)',
          border: '1px solid rgba(180, 220, 235, 0.20)',
          backdropFilter: 'blur(32px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(32px) saturate(1.4)',
          borderRadius: '16px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.75)',
        }}
        className="w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#62e8ff]" />
            <span className="font-medium tracking-[2px] text-sm text-[#f0f7fa]">
              CA-CFAR DETECTION PARAMETERS
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded text-[#d2e6ec]/40 hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Presets */}
          <div>
            <span className="text-[9px] tracking-[1.5px] uppercase text-[#d2e6ec]/40 block mb-1.5">
              PRESET CONFIGURATIONS
            </span>
            <div className="grid grid-cols-3 gap-2">
              {presets.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setCurrentConfig({ ...p.cfg })}
                  className="p-2 rounded-lg border border-white/5 hover:border-[#62e8ff]/40 bg-white/5 hover:bg-white/10 text-left transition"
                >
                  <span className="font-medium text-[#62e8ff] text-[10px] block truncate">{p.name}</span>
                  <span className="text-[8px] text-[#d2e6ec]/40 line-clamp-1 mt-0.5">{p.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Sliders */}
          <div className="space-y-3 bg-black/30 p-3.5 rounded-xl border border-white/5">
            {/* Threshold Multiplier */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[#d2e6ec]/80">Threshold Multiplier (&alpha;)</span>
                <span className="text-[#62e8ff] font-semibold">{currentConfig.thresholdFactor.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min="2.0"
                max="5.5"
                step="0.1"
                value={currentConfig.thresholdFactor}
                onChange={(e) => setCurrentConfig({ ...currentConfig, thresholdFactor: parseFloat(e.target.value) })}
                className="w-full accent-[#62e8ff] cursor-pointer"
              />
            </div>

            {/* Training Cells */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[#d2e6ec]/80">Training Window (N_train)</span>
                <span className="text-[#62e8ff] font-semibold">{currentConfig.trainingCells} cells</span>
              </div>
              <input
                type="range"
                min="8"
                max="32"
                step="2"
                value={currentConfig.trainingCells}
                onChange={(e) => setCurrentConfig({ ...currentConfig, trainingCells: parseInt(e.target.value) })}
                className="w-full accent-[#62e8ff] cursor-pointer"
              />
            </div>

            {/* Guard Cells */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[#d2e6ec]/80">Guard Window (N_guard)</span>
                <span className="text-[#62e8ff] font-semibold">{currentConfig.guardCells} cells</span>
              </div>
              <input
                type="range"
                min="2"
                max="8"
                step="2"
                value={currentConfig.guardCells}
                onChange={(e) => setCurrentConfig({ ...currentConfig, guardCells: parseInt(e.target.value) })}
                className="w-full accent-[#62e8ff] cursor-pointer"
              />
            </div>

            {/* Coastline Buffer */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[#d2e6ec]/80">Coastline Mask Buffer</span>
                <span className="text-[#62e8ff] font-semibold">{currentConfig.coastlineBufferMeters} m</span>
              </div>
              <input
                type="range"
                min="50"
                max="500"
                step="25"
                value={currentConfig.coastlineBufferMeters}
                onChange={(e) => setCurrentConfig({ ...currentConfig, coastlineBufferMeters: parseInt(e.target.value) })}
                className="w-full accent-[#62e8ff] cursor-pointer"
              />
            </div>

            {/* Speckle Filter */}
            <div className="pt-1">
              <span className="text-[#d2e6ec]/80 block mb-1">Pre-Detection Speckle Filter</span>
              <div className="flex gap-2">
                {(['median', 'none'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setCurrentConfig({ ...currentConfig, speckleFilter: filter })}
                    className={`flex-1 py-1.5 px-3 rounded-lg border text-xs capitalize transition ${
                      currentConfig.speckleFilter === filter
                        ? 'border-[#62e8ff] bg-[#62e8ff]/15 text-[#62e8ff] font-medium'
                        : 'border-white/5 bg-white/5 text-[#d2e6ec]/50'
                    }`}
                  >
                    {filter === 'median' ? '3x3 2D Median' : 'None (Raw)'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-white/10 bg-black/20 flex items-center justify-between">
          <button
            onClick={() => setCurrentConfig({ trainingCells: 16, guardCells: 4, thresholdFactor: 3.5, coastlineBufferMeters: 150, speckleFilter: 'median', kernelSize: 3, minPixels: 3, maxPixels: 1000 })}
            className="flex items-center gap-1.5 text-[#d2e6ec]/40 hover:text-white transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-[#d2e6ec]/70 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onApplyConfig(currentConfig);
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#62e8ff] hover:bg-[#62e8ff]/90 text-[#06090d] font-semibold transition"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Apply & Re-scan</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
