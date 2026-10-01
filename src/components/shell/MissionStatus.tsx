/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Floating Top-Right Sensor Status Readout
 * Sparse telemetry readout for orbital satellite state and provenance.
 */

import React from 'react';
import { RuntimeMode, Sentinel1Scene } from '../../types/darkfleet.ts';

interface MissionStatusProps {
  scene: Sentinel1Scene;
  runtimeMode: RuntimeMode;
}

export const MissionStatus: React.FC<MissionStatusProps> = ({ scene, runtimeMode }) => {
  return (
    <div className="fixed top-8 right-9 z-20 pointer-events-auto select-none text-right font-mono">
      <div className="flex flex-col gap-2 text-[10px] leading-tight">
        <div>
          <span className="text-[#d2e6ec]/30 text-[8px] tracking-[2px] block">SENSOR</span>
          <span className="text-[#f0f7fa] font-medium tracking-[1.5px]">{scene.platform} / C-BAND</span>
        </div>

        <div className="flex items-center justify-end gap-3">
          <div>
            <span className="text-[#d2e6ec]/30 text-[8px] tracking-[2px] block">POL</span>
            <span className="text-[#62e8ff]/80 tracking-[1px]">{scene.polarization}</span>
          </div>

          <div className="w-[1px] h-4 bg-white/10" />

          <div>
            <span className="text-[#d2e6ec]/30 text-[8px] tracking-[2px] block">PROVENANCE</span>
            <span className={`tracking-[1px] font-semibold ${runtimeMode === 'REAL' ? 'text-[#5cffc6]' : 'text-[#ffc76b]'}`}>
              {runtimeMode === 'REAL' ? 'REAL DATA' : 'DEMO SYNTHETIC'}
            </span>
          </div>
        </div>

        <div>
          <span className="text-[#d2e6ec]/30 text-[8px] tracking-[2px] block">SCENE ID</span>
          <span className="text-[#d2e6ec]/70 tracking-[1px] text-[9px]">{scene.id}</span>
        </div>
      </div>
    </div>
  );
};
