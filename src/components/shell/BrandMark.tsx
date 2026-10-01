/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Floating Top-Left Brand Identity
 * Minimalist orbital reconnaissance ground-station branding with canonical RuntimeMode indicator.
 */

import React, { useEffect, useState } from 'react';
import { RuntimeMode } from '../../types/darkfleet.ts';

interface BrandMarkProps {
  mode: RuntimeMode;
  onToggleMode?: (nextMode: RuntimeMode) => void;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ mode, onToggleMode }) => {
  const [zuluTime, setZuluTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setZuluTime(now.toISOString().substring(11, 19) + 'Z');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed top-7 left-8 sm:left-10 z-20 pointer-events-auto select-none font-mono">
      <div className="flex flex-col">
        {/* Title */}
        <div className="text-xl sm:text-2xl font-medium tracking-[7px] text-[#f0f7fa] flex items-center gap-2">
          <span>DARKFLEET</span>
          <span className={`w-1.5 h-1.5 rounded-full ${mode === 'REAL' ? 'bg-[#5cffc6]' : 'bg-[#62e8ff]'} opacity-80`} />
        </div>

        {/* Subtitle */}
        <div className="text-[9px] tracking-[3.5px] uppercase text-[#d2e6ec]/40 mt-1">
          SAR / AIS CORRELATION
        </div>

        {/* Canonical Runtime Mode & Zulu Clock */}
        <div className="flex items-center gap-2 text-[9px] tracking-[1.5px] mt-2">
          {onToggleMode ? (
            <button
              onClick={() => onToggleMode(mode === 'DEMO' ? 'REAL' : 'DEMO')}
              className={`px-1.5 py-0.5 rounded text-[8px] font-bold tracking-[1.5px] border transition cursor-pointer ${
                mode === 'REAL'
                  ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/60'
                  : 'bg-amber-950/80 border-amber-500/50 text-amber-300 hover:bg-amber-900/60'
              }`}
              title="Click to toggle between DEMO synthetic data and REAL satellite mode"
            >
              {mode === 'REAL' ? 'REAL DATA' : 'DEMO DATA'}
            </button>
          ) : (
            <span
              className={`px-1.5 py-0.5 rounded text-[8px] font-bold tracking-[1.5px] border ${
                mode === 'REAL'
                  ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                  : 'bg-amber-950/80 border-amber-500/50 text-amber-300'
              }`}
            >
              {mode === 'REAL' ? 'REAL DATA' : 'DEMO DATA'}
            </span>
          )}

          <span className="text-[#d2e6ec]/20">&bull;</span>
          <span className="text-[#d2e6ec]/50">{zuluTime}</span>
        </div>
      </div>
    </div>
  );
};
