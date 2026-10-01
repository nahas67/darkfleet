/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Sparse Intelligence HUD Overlay
 * Non-intrusive aerospace telemetry overlay with pointer-events-none.
 */

import React from 'react';
import { Sentinel1Scene, VesselTarget } from '../../types/darkfleet.ts';

interface IntelHudProps {
  cursorGeo: { lat: number; lon: number; heightKm: number } | null;
  scene: Sentinel1Scene;
  selectedTarget: VesselTarget | null;
  visible: boolean;
}

export const IntelHud: React.FC<IntelHudProps> = ({
  cursorGeo,
  scene,
  selectedTarget,
  visible,
}) => {
  if (!visible) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-10 font-mono select-none text-[9px] text-[#d2e6ec]/40 leading-tight">
      {/* Lower-Left Cursor / Camera Position Telemetry */}
      <div className="absolute bottom-20 left-10 space-y-1">
        {cursorGeo ? (
          <>
            <div>
              <span className="text-[#d2e6ec]/25 mr-2">LAT</span>
              <span className="text-[#f0f7fa]/80">{cursorGeo.lat.toFixed(5)}°</span>
            </div>
            <div>
              <span className="text-[#d2e6ec]/25 mr-2">LON</span>
              <span className="text-[#f0f7fa]/80">{cursorGeo.lon.toFixed(5)}°</span>
            </div>
            <div>
              <span className="text-[#d2e6ec]/25 mr-2">ALT</span>
              <span className="text-[#62e8ff]/70">{cursorGeo.heightKm} KM</span>
            </div>
          </>
        ) : (
          <div>
            <span className="text-[#d2e6ec]/25 mr-2">GRID</span>
            <span>WGS-84 / ORBITAL</span>
          </div>
        )}
      </div>

      {/* Target Tracking Indicator (if target active) */}
      {selectedTarget && (
        <div className="absolute top-28 left-10 space-y-0.5">
          <div className="text-[8px] tracking-[2px] text-[#62e8ff]/60 uppercase">
            TARGET TRACK ACTIVE
          </div>
          <div className="text-sm font-semibold tracking-wider text-[#f0f7fa]">
            {selectedTarget.id}
          </div>
          <div className={`text-[9px] tracking-wider uppercase font-medium ${
            selectedTarget.classification === 'SAR_UNMATCHED'
              ? 'text-[#ff6b6b]'
              : 'text-[#66f0c3]'
          }`}>
            {selectedTarget.classification.replace('_', ' ')}
          </div>
        </div>
      )}
    </div>
  );
};
