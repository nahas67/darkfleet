/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Target Inspector & Evidence Panel
 * Displays high-resolution radar chip cut-outs, backscatter dB distributions,
 * geodesic telemetry, AIS association cards, and tactical debriefs.
 */

import React, { useState } from 'react';
import { 
  X, 
  ShieldAlert, 
  ShieldCheck, 
  Radio, 
  Anchor, 
  Navigation, 
  Layers, 
  Download, 
  Copy, 
  Check, 
  AlertTriangle,
  Compass,
  Cpu,
  Waves
} from 'lucide-react';
import { VesselTarget } from '../types/darkfleet.ts';

interface TargetInspectorProps {
  target: VesselTarget | null;
  onClose: () => void;
}

export const TargetInspector: React.FC<TargetInspectorProps> = ({ target, onClose }) => {
  const [copied, setCopied] = useState<boolean>(false);
  const [chipColorMode, setChipColorMode] = useState<'phosphor' | 'thermal'>('phosphor');

  if (!target) return null;

  const isDark = target.classification === 'SAR_UNMATCHED';
  const isPlatform = target.classification === 'STATIONARY_OR_INFRASTRUCTURE';
  const isVerified = target.classification === 'SAR_MATCHED_AIS';

  const classificationTitle = isDark
    ? 'UNMATCHED SAR'
    : isPlatform
    ? 'STATIONARY INFRASTRUCTURE'
    : isVerified
    ? 'CORRELATED AIS VESSEL'
    : target.classification.replace(/_/g, ' ');

  const handleCopyJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(target, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
    <div className="w-full h-full bg-[#080c10]/95 backdrop-blur-md border-l border-cyan-950/80 flex flex-col text-slate-200 text-xs font-mono select-none overflow-y-auto shadow-2xl">
      {/* Header bar */}
      <div className="p-3 border-b border-slate-800/80 flex items-center justify-between bg-[#0a0f15]">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded border ${isDark ? 'border-rose-500/50 bg-rose-950/50 text-rose-400' : 'border-cyan-500/50 bg-cyan-950/50 text-cyan-400'}`}>
            {isDark ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-cyan-300 tracking-wider">{target.id}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${isDark ? 'bg-rose-950/80 border-rose-500 text-rose-300' : 'bg-emerald-950/80 border-emerald-500 text-emerald-300'}`}>
                {isDark ? 'UNASSOCIATED' : 'CORRELATED'}
              </span>
            </div>
            <span className="text-[10px] text-slate-400">{classificationTitle}</span>
          </div>
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-4">
        {/* Radar Chip (Postage Stamp) Sub-matrix */}
        {target.sarChip && (
          <div className="bg-[#05080c] border border-cyan-900/40 rounded-lg p-2.5 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-cyan-400 font-bold flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" />
                SAR RADAR CHIP (24x24 px @ 10m/px)
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setChipColorMode('phosphor')}
                  className={`px-1.5 py-0.5 rounded text-[9px] border ${chipColorMode === 'phosphor' ? 'border-emerald-500 text-emerald-400 bg-emerald-950/50' : 'border-slate-800 text-slate-500'}`}
                >
                  PHOSPHOR
                </button>
                <button
                  onClick={() => setChipColorMode('thermal')}
                  className={`px-1.5 py-0.5 rounded text-[9px] border ${chipColorMode === 'thermal' ? 'border-cyan-500 text-cyan-400 bg-cyan-950/50' : 'border-slate-800 text-slate-500'}`}
                >
                  THERMAL
                </button>
              </div>
            </div>

            {/* Canvas Chip Matrix */}
            <div className="relative aspect-square w-full max-w-[200px] mx-auto border border-slate-800 bg-black rounded overflow-hidden">
              <div className="grid grid-cols-24 w-full h-full" style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)' }}>
                {target.sarChip.matrix.map((row, ry) =>
                  row.map((val, rx) => {
                    const norm = Math.max(0, Math.min(1, (val + 28) / 33));
                    const isCorner = val > -5.0;

                    let bg = '';
                    if (chipColorMode === 'phosphor') {
                      bg = isCorner 
                        ? '#22c55e' 
                        : `rgb(${Math.round(norm * 20)}, ${Math.round(norm * 180)}, ${Math.round(norm * 60)})`;
                    } else {
                      bg = isCorner
                        ? '#f43f5e'
                        : `rgb(${Math.round(norm * 240)}, ${Math.round(norm * 140)}, ${Math.round(norm * 60)})`;
                    }

                    return (
                      <div
                        key={`${ry}-${rx}`}
                        style={{ backgroundColor: bg }}
                        title={`[${rx}, ${ry}]: ${val} dB`}
                        className="w-full h-full"
                      />
                    );
                  })
                )}
              </div>

              {/* Centroid Reticle */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-4 h-4 border border-cyan-400/80 rounded-full" />
                <div className="absolute w-8 h-[1px] bg-cyan-400/60" />
                <div className="absolute h-8 w-[1px] bg-cyan-400/60" />
              </div>

              {/* Orientation Vector line */}
              <div 
                className="absolute inset-0 pointer-events-none flex items-center justify-center"
                style={{ transform: `rotate(${target.estimatedHeadingDeg}deg)` }}
              >
                <div className="w-[1px] h-14 bg-gradient-to-t from-transparent via-cyan-400 to-white" />
              </div>
            </div>

            {/* Radar Chip Metrics */}
            <div className="grid grid-cols-3 gap-1.5 text-center text-[10px] pt-1">
              <div className="bg-[#0a0f16] p-1 rounded border border-slate-800/80">
                <span className="text-slate-500 block text-[9px]">PEAK RCS</span>
                <span className="text-cyan-300 font-bold">{target.maxBackscatterDb} dB</span>
              </div>
              <div className="bg-[#0a0f16] p-1 rounded border border-slate-800/80">
                <span className="text-slate-500 block text-[9px]">CLUTTER FLOOR</span>
                <span className="text-slate-400">{target.sarChip.clutterMeanDb} dB</span>
              </div>
              <div className="bg-[#0a0f16] p-1 rounded border border-slate-800/80">
                <span className="text-slate-500 block text-[9px]">SNR</span>
                <span className="text-emerald-400 font-bold">
                  {(target.maxBackscatterDb - target.sarChip.clutterMeanDb).toFixed(1)} dB
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Confidence Gauges */}
        <div className="bg-[#0a0f16] border border-slate-800 rounded-lg p-2.5 space-y-2">
          <span className="text-[11px] font-bold text-slate-300 block">CONFIDENCE METRICS</span>
          
          <div>
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-slate-400">SAR Radar Confidence</span>
              <span className="text-cyan-400 font-bold">{Math.round(target.sarConfidence * 100)}%</span>
            </div>
            <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-cyan-500 h-1.5 rounded-full" 
                style={{ width: `${target.sarConfidence * 100}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-slate-400">AIS Transponder Association</span>
              <span className={target.aisCorrelation.matched ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {Math.round(target.aisMatchConfidence * 100)}%
              </span>
            </div>
            <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
              <div 
                className={`h-1.5 rounded-full ${target.aisCorrelation.matched ? 'bg-emerald-500' : 'bg-rose-500'}`}
                style={{ width: `${target.aisMatchConfidence * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Geodesic Physical Telemetry */}
        <div className="bg-[#0a0f16] border border-slate-800 rounded-lg p-2.5 space-y-2">
          <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1">
            <Compass className="w-3.5 h-3.5 text-cyan-400" />
            GEODESIC & PHYSICAL TELEMETRY
          </span>

          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div>
              <span className="text-slate-500 block">WGS-84 COORDINATES</span>
              <span className="text-cyan-300 font-bold">
                {target.position.lat.toFixed(5)}°N, {target.position.lon.toFixed(5)}°E
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">APPARENT LENGTH (SAR)</span>
              <span className="text-slate-200 font-bold">
                ~{target.estimatedLengthMeters}m <span className="text-slate-500 font-normal">(&plusmn;{target.lengthUncertaintyMeters}m)</span>
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">RADAR BEAM HEADING</span>
              <span className="text-slate-200 font-bold">{target.estimatedHeadingDeg}°</span>
            </div>
            <div>
              <span className="text-slate-500 block">KELVIN WAKE SCAR</span>
              <span className={target.wakeVisible ? 'text-cyan-400 font-bold' : 'text-slate-500'}>
                {target.wakeVisible ? `DETECTED (${target.wakeHeadingDeg ?? target.estimatedHeadingDeg}°)` : 'NOT EVIDENT'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">2D BOUNDING BOX (0-1000)</span>
              <span className="text-slate-400 font-mono">[{target.box2d.join(', ')}]</span>
            </div>
            <div>
              <span className="text-slate-500 block">PIXEL AREA</span>
              <span className="text-slate-400">{target.pixelArea} px</span>
            </div>
          </div>
        </div>

        {/* AIS Correlation Details */}
        <div className="bg-[#0a0f16] border border-slate-800 rounded-lg p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1">
              <Radio className="w-3.5 h-3.5 text-cyan-400" />
              AIS TRANSPONDER CORRELATION
            </span>
            {target.aisCorrelation.matched ? (
              <span className="px-1.5 py-0.5 rounded text-[9px] bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 font-bold">
                MATCHED
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded text-[9px] bg-rose-950/60 border border-rose-500/50 text-rose-300 font-bold">
                UNMATCHED (DARK)
              </span>
            )}
          </div>

          {target.aisCorrelation.matched ? (
            <div className="space-y-1.5 text-[10px]">
              <div className="flex justify-between border-b border-slate-800/60 pb-1">
                <span className="text-slate-400">Vessel Name:</span>
                <span className="text-emerald-400 font-bold">{target.aisCorrelation.vesselName}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1">
                <span className="text-slate-400">MMSI / IMO:</span>
                <span className="text-slate-200">{target.aisCorrelation.mmsi} / {target.aisCorrelation.imo || 'N/A'}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1">
                <span className="text-slate-400">Flag / Type:</span>
                <span className="text-slate-200">{target.aisCorrelation.flag} &bull; {target.aisCorrelation.shipType}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1">
                <span className="text-slate-400">Speed (SOG) / Course (COG):</span>
                <span className="text-slate-200">{target.aisCorrelation.sogKnots} kts &bull; {target.aisCorrelation.cogDeg}°</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1">
                <span className="text-slate-400">Spatial Offset:</span>
                <span className="text-cyan-300 font-bold">{target.aisCorrelation.distanceOffsetMeters} m</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Temporal Delta (Δt):</span>
                <span className="text-slate-200">{target.aisCorrelation.timeDeltaSeconds} s</span>
              </div>
            </div>
          ) : (
            <div className="bg-rose-950/20 border border-rose-900/40 rounded p-2 text-[10px] text-rose-200/90 space-y-1">
              <div className="flex items-center gap-1 font-bold text-rose-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                TRANSPONDER ANOMALY DETECTED
              </div>
              <p className="text-[10px] leading-relaxed text-slate-300">
                Satellite radar reveals a clear metallic surface return (~{target.estimatedLengthMeters}m), but no active AIS transponder broadcast was received within a 3 nautical mile radius inside the &plusmn;15 minute overpass window.
              </p>
              {target.proximityPartnerId && (
                <div className="mt-1.5 p-1.5 bg-rose-900/30 border border-rose-500/40 rounded text-rose-200 text-[10px]">
                  <strong>PROXIMITY ALERT:</strong> Operating in close proximity to contact <strong>{target.proximityPartnerId}</strong> (&lt; 2 NM).
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tactical Military Debriefing Assessment */}
        <div className="bg-[#0a0f16] border border-cyan-900/50 rounded-lg p-2.5 space-y-1.5">
          <span className="text-[11px] font-bold text-cyan-400 block tracking-wider">
            TACTICAL RECONNAISSANCE ASSESSMENT
          </span>
          <p className="text-[11px] text-slate-300 leading-relaxed italic bg-[#05080c] p-2 rounded border border-slate-800/80">
            "{target.tacticalAssessment}"
          </p>
          <div className="flex flex-wrap gap-1 pt-1">
            {target.tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded text-[9px] bg-slate-800 border border-slate-700 text-slate-300"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 pt-1 pb-4">
          <button
            onClick={handleDownloadGeoJSON}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg bg-cyan-950/60 hover:bg-cyan-900/80 border border-cyan-500/40 text-cyan-300 hover:text-white transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>EXPORT GEOJSON</span>
          </button>

          <button
            onClick={handleCopyJSON}
            className="flex items-center justify-center gap-1 py-2 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition"
            title="Copy Analytical JSON snippet"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'COPIED' : 'JSON'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
