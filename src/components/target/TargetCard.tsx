/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Floating Target Evidence Card
 * Sparse initial glance with progressive disclosure of radar chips and telemetry.
 */

import React, { useState } from 'react';
import { 
  X, 
  Crosshair, 
  ChevronDown, 
  ChevronUp, 
  Download, 
  Copy, 
  Check, 
  Radio, 
  Cpu, 
  Compass, 
  Layers 
} from 'lucide-react';
import { VesselTarget } from '../../types/darkfleet.ts';

interface TargetCardProps {
  target: VesselTarget | null;
  onClose: () => void;
  onFocus: (target: VesselTarget) => void;
}

export const TargetCard: React.FC<TargetCardProps> = ({ target, onClose, onFocus }) => {
  const [showDetails, setShowDetails] = useState(false);
  const [openSection, setOpenSection] = useState<'sar' | 'ais' | 'geometry' | 'evidence' | null>(null);
  const [copied, setCopied] = useState(false);

  if (!target) return null;

  const isUnmatched = target.classification === 'SAR_UNMATCHED';
  const isStatic = target.classification === 'STATIONARY_OR_INFRASTRUCTURE';
  const isMatched = target.classification === 'SAR_MATCHED_AIS';

  const classificationLabel = isUnmatched
    ? 'SAR UNMATCHED'
    : isStatic
    ? 'STATIONARY INFRASTRUCTURE'
    : isMatched
    ? 'SAR MATCHED AIS'
    : target.classification.replace(/_/g, ' ');

  const classificationColor = isUnmatched
    ? 'text-[#ff6b6b]'
    : isStatic
    ? 'text-[#38bdf8]'
    : isMatched
    ? 'text-[#66f0c3]'
    : 'text-[#ffc76b]';

  const handleCopyJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(target, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadGeoJSON = () => {
    const feature = {
      type: 'Feature',
      id: target.id,
      geometry: {
        type: 'Point',
        coordinates: [target.position.lon, target.position.lat],
      },
      properties: target,
    };
    const blob = new Blob([JSON.stringify(feature, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${target.id}-evidence.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        background: 'rgba(8, 16, 24, 0.82)',
        border: '1px solid rgba(180, 220, 235, 0.16)',
        backdropFilter: 'blur(28px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(28px) saturate(1.4)',
        borderRadius: '14px',
        boxShadow: '0 16px 42px rgba(0,0,0,0.65)',
      }}
      className="fixed top-28 sm:top-32 right-6 sm:right-9 z-20 w-[320px] sm:w-[350px] max-h-[min(72vh,640px)] overflow-y-auto pointer-events-auto select-none font-mono text-xs text-[#f0f7fa] animate-in fade-in slide-in-from-right-4 duration-200"
    >
      {/* 1. Header: Classification, ID, Close */}
      <div className="p-3.5 border-b border-white/10 flex items-center justify-between">
        <div>
          <span className={`text-[9px] tracking-[2.5px] uppercase font-bold block ${classificationColor}`}>
            {classificationLabel}
          </span>
          <span className="text-base font-semibold tracking-[2px] text-[#f0f7fa]">
            {target.id}
          </span>
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded-lg text-[#d2e6ec]/40 hover:text-white hover:bg-white/5 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 2. Core Initial Minimal Metrics (Restrained glancing) */}
      <div className="p-4 space-y-3">
        {/* Coordinates */}
        <div className="flex items-center justify-between text-[11px] pb-1 border-b border-white/5">
          <span className="text-[#d2e6ec]/40">POSITION</span>
          <span className="text-[#f0f7fa] font-medium">
            {target.position.lat.toFixed(5)}° N &bull; {target.position.lon.toFixed(5)}° E
          </span>
        </div>

        {/* Confidence Dual-line */}
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="bg-white/5 p-2 rounded-lg">
            <span className="text-[#d2e6ec]/40 block text-[8px] tracking-[1.5px] uppercase">
              SAR CONFIDENCE
            </span>
            <span className="text-sm font-semibold text-[#62e8ff]">
              {Math.round(target.sarConfidence * 100)}%
            </span>
          </div>

          <div className="bg-white/5 p-2 rounded-lg">
            <span className="text-[#d2e6ec]/40 block text-[8px] tracking-[1.5px] uppercase">
              AIS ASSOCIATION
            </span>
            <span className={`text-sm font-semibold ${isMatched ? 'text-[#66f0c3]' : 'text-[#ff6b6b]'}`}>
              {Math.round(target.aisMatchConfidence * 100)}%
            </span>
          </div>
        </div>

        {/* Footprint & Heading */}
        <div className="flex items-center justify-between text-[11px]">
          <div>
            <span className="text-[#d2e6ec]/40 text-[9px] block">APPARENT FOOTPRINT</span>
            <span className="text-[#f0f7fa] font-medium">
              ~{target.estimatedLengthMeters}m <span className="text-[#d2e6ec]/40 text-[9px]">(&plusmn;{target.lengthUncertaintyMeters}m)</span>
            </span>
          </div>

          <div className="text-right">
            <span className="text-[#d2e6ec]/40 text-[9px] block">HEADING</span>
            <span className="text-[#f0f7fa] font-medium">
              {String(Math.round(target.estimatedHeadingDeg)).padStart(3, '0')}°
            </span>
          </div>
        </div>

        {/* Primary Action Buttons: [ FOCUS ] [ DETAILS ] */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => onFocus(target)}
            className="flex-1 py-1.5 px-3 rounded-lg border border-[#62e8ff]/30 bg-[#62e8ff]/10 hover:bg-[#62e8ff]/20 text-[#62e8ff] tracking-wider text-[11px] font-medium flex items-center justify-center gap-1.5 transition"
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span>FOCUS</span>
          </button>

          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex-1 py-1.5 px-3 rounded-lg border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/10 text-[#d2e6ec]/80 hover:text-white tracking-wider text-[11px] flex items-center justify-center gap-1 transition"
          >
            <span>{showDetails ? 'LESS' : 'DETAILS'}</span>
            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* 3. PROGRESSIVE DISCLOSURE: Detailed Sections */}
        {showDetails && (
          <div className="pt-2 border-t border-white/10 space-y-2 text-[10px]">
            {/* SAR RETURN ACCORDION */}
            <div className="border border-white/5 rounded-lg overflow-hidden bg-black/30">
              <button
                onClick={() => setOpenSection(openSection === 'sar' ? null : 'sar')}
                className="w-full p-2 text-left flex items-center justify-between text-[#d2e6ec]/80 hover:text-white"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[9px] text-[#62e8ff]">
                  <Cpu className="w-3 h-3" />
                  SAR RETURN & CHIP
                </span>
                <ChevronDown className={`w-3 h-3 transition-transform ${openSection === 'sar' ? 'rotate-180' : ''}`} />
              </button>

              {openSection === 'sar' && target.sarChip && (
                <div className="p-2.5 pt-0 space-y-2">
                  {/* Postage-Stamp 24x24 Radar Chip Viewer */}
                  <div className="relative aspect-square w-36 mx-auto border border-white/10 rounded overflow-hidden bg-black">
                    <div
                      className="w-full h-full"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(24, 1fr)',
                      }}
                    >
                      {target.sarChip.matrix.map((row, ry) =>
                        row.map((val, rx) => {
                          const norm = Math.max(0, Math.min(1, (val + 28) / 33));
                          const byte = Math.round(norm * 255);
                          return (
                            <div
                              key={`${ry}-${rx}`}
                              style={{
                                backgroundColor: val > -5 ? '#ffffff' : `rgb(${byte},${byte},${byte})`,
                              }}
                              className="w-full h-full"
                            />
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-1 text-center text-[9px]">
                    <div className="bg-white/5 p-1 rounded">
                      <span className="text-[#d2e6ec]/40 block text-[8px]">PEAK</span>
                      <span className="font-semibold text-white">{target.maxBackscatterDb} dB</span>
                    </div>
                    <div className="bg-white/5 p-1 rounded">
                      <span className="text-[#d2e6ec]/40 block text-[8px]">CLUTTER</span>
                      <span className="text-[#d2e6ec]/70">{target.sarChip.clutterMeanDb} dB</span>
                    </div>
                    <div className="bg-white/5 p-1 rounded">
                      <span className="text-[#d2e6ec]/40 block text-[8px]">SNR</span>
                      <span className="text-[#66f0c3] font-semibold">
                        {(target.maxBackscatterDb - target.sarChip.clutterMeanDb).toFixed(1)} dB
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* AIS ASSOCIATION ACCORDION */}
            <div className="border border-white/5 rounded-lg overflow-hidden bg-black/30">
              <button
                onClick={() => setOpenSection(openSection === 'ais' ? null : 'ais')}
                className="w-full p-2 text-left flex items-center justify-between text-[#d2e6ec]/80 hover:text-white"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[9px] text-[#62e8ff]">
                  <Radio className="w-3 h-3" />
                  AIS TELEMETRY
                </span>
                <ChevronDown className={`w-3 h-3 transition-transform ${openSection === 'ais' ? 'rotate-180' : ''}`} />
              </button>

              {openSection === 'ais' && (
                <div className="p-2.5 pt-0 space-y-1.5 text-[10px]">
                  {target.aisCorrelation.matched ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-[#d2e6ec]/40">Vessel:</span>
                        <span className="text-white font-medium">{target.aisCorrelation.vesselName}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#d2e6ec]/40">MMSI:</span>
                        <span className="text-[#66f0c3]">{target.aisCorrelation.mmsi}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#d2e6ec]/40">Spatial Offset:</span>
                        <span>{target.aisCorrelation.distanceOffsetMeters} m</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#d2e6ec]/40">Time Delta (Δt):</span>
                        <span>{target.aisCorrelation.timeDeltaSeconds} s</span>
                      </div>
                    </>
                  ) : (
                    <div className="text-[#d2e6ec]/60 leading-relaxed text-[9px]">
                      No active transponder broadcast received within 3 NM in overpass window (&plusmn;15 min).
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* EVIDENCE & OBSERVATION */}
            <div className="border border-white/5 rounded-lg p-2.5 bg-black/30 space-y-1">
              <span className="text-[8px] tracking-[1.5px] uppercase text-[#d2e6ec]/40 block">
                OBSERVATION SUMMARY
              </span>
              <p className="text-[10px] text-[#d2e6ec]/80 leading-relaxed">
                {target.tacticalAssessment}
              </p>
            </div>

            {/* EXPORTS */}
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleDownloadGeoJSON}
                className="flex-1 py-1 px-2 rounded border border-white/10 hover:border-white/20 text-[#d2e6ec]/70 hover:text-white flex items-center justify-center gap-1 text-[10px]"
              >
                <Download className="w-3 h-3" />
                <span>GEOJSON</span>
              </button>
              <button
                onClick={handleCopyJSON}
                className="flex-1 py-1 px-2 rounded border border-white/10 hover:border-white/20 text-[#d2e6ec]/70 hover:text-white flex items-center justify-center gap-1 text-[10px]"
              >
                {copied ? <Check className="w-3 h-3 text-[#66f0c3]" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'COPIED' : 'COPY JSON'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
