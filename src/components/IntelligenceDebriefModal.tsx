/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Maritime Intelligence Debriefing Modal
 * Objective, evidence-based analysis and area summary.
 */

import React, { useState } from 'react';
import { X, Sparkles, Download, Copy, Check, FileText, RefreshCw, AlertCircle } from 'lucide-react';
import { ScanResult } from '../types/darkfleet.ts';

interface IntelligenceDebriefModalProps {
  scanResult: ScanResult | null;
  isOpen: boolean;
  onClose: () => void;
  onRefreshAI: () => Promise<void>;
  isGeneratingAI: boolean;
}

export const IntelligenceDebriefModal: React.FC<IntelligenceDebriefModalProps> = ({
  scanResult,
  isOpen,
  onClose,
  onRefreshAI,
  isGeneratingAI,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen || !scanResult) return null;

  const unmatchedVessels = scanResult.vessels.filter(
    (v) => v.classification === 'SAR_UNMATCHED'
  );
  const matchedVessels = scanResult.vessels.filter(
    (v) => v.classification === 'SAR_MATCHED_AIS'
  );

  const handleCopyReport = () => {
    const reportText = `[DARKFLEET MARITIME CORRELATION BRIEFING]
MODE: ${scanResult.runtimeMode}
SECTOR: ${scanResult.scene.regionName}
SENSOR: ${scanResult.scene.platform} (${scanResult.scene.mode}, ${scanResult.scene.polarization})
TIMESTAMP: ${scanResult.scene.acquisitionTime}
SCAN ID: ${scanResult.scanId}

1. SITUATIONAL SUMMARY:
${scanResult.areaSummary}

2. CORRELATION BREAKDOWN:
- Total Radar Detections: ${scanResult.detectionsCount}
- Correlated AIS Transponders: ${matchedVessels.length}
- Unmatched Radar Contacts: ${unmatchedVessels.length}
- Fixed Infrastructure: ${scanResult.staticCount}

3. OBSERVATION CATALOG:
${scanResult.vessels.map(v => `[${v.id}] ${v.classification} | Apparent Length: ~${v.estimatedLengthMeters}m | Heading: ${String(Math.round(v.estimatedHeadingDeg)).padStart(3, '0')}° | AIS: ${v.aisCorrelation.mmsi || 'UNASSOCIATED'}
Observation: ${v.tacticalAssessment}
`).join('\n')}
`;
    navigator.clipboard.writeText(reportText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadReport = () => {
    const reportText = `DARKFLEET MARITIME RADAR + AIS CORRELATION REPORT
Simulation Dataset: ${scanResult.dataSource?.mode ?? 'Simulation'}
Generated: ${new Date().toISOString()}
Scan ID: ${scanResult.scanId}
Sector: ${scanResult.scene.regionName}

============================================================
1. SENSOR PARAMETERS
============================================================
Platform: ${scanResult.scene.platform} C-band SAR
Product: ${scanResult.scene.productType} (${scanResult.scene.mode} mode)
Polarization: ${scanResult.scene.polarization}
Orbit Direction: ${scanResult.scene.orbitDirection}
Incidence Angle: ${scanResult.scene.incidenceAngle}°
Timestamp: ${scanResult.scene.acquisitionTime}

============================================================
2. OBJECTIVE SECTOR SUMMARY
============================================================
${scanResult.areaSummary}

============================================================
3. DETECTION CATALOG
============================================================
${scanResult.vessels.map(v => `
TARGET ID: ${v.id}
Classification: ${v.classification}
Apparent Length: ${v.estimatedLengthMeters} m (±${v.lengthUncertaintyMeters} m)
Position: ${v.position.lat.toFixed(5)}°N, ${v.position.lon.toFixed(5)}°E
Peak Backscatter: ${v.maxBackscatterDb} dB (Clutter Floor: ${v.sarChip?.clutterMeanDb ?? -22} dB)
Wake Characteristic: ${v.wakeVisible ? 'Wake vector observed' : 'No apparent wake line'}
AIS Transponder: ${v.aisCorrelation.matched ? `Matched MMSI ${v.aisCorrelation.mmsi} (${v.aisCorrelation.vesselName || 'Commercial'})` : 'No correlated transponder in overpass window'}
Assessment:
${v.tacticalAssessment}
------------------------------------------------------------`).join('\n')}
`;
    const blob = new Blob([reportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `DarkFleet-Report-${scanResult.scanId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md p-4 pointer-events-auto font-mono text-xs text-[#f0f7fa]">
      <div
        style={{
          background: 'rgba(8, 16, 24, 0.92)',
          border: '1px solid rgba(180, 220, 235, 0.20)',
          backdropFilter: 'blur(32px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(32px) saturate(1.4)',
          borderRadius: '16px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.75)',
        }}
        className="w-full max-w-2xl overflow-hidden flex flex-col max-h-[82vh] animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#62e8ff]" />
            <span className="font-medium tracking-[2px] text-sm text-[#f0f7fa]">
              MARITIME SITUATIONAL BRIEFING
            </span>
            <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#ffc76b]/15 text-[#ffc76b] border border-[#ffc76b]/30">
              SIMULATION
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded text-[#d2e6ec]/40 hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Metadata pill bar */}
          <div className="grid grid-cols-4 gap-2 bg-black/30 p-2.5 rounded-xl border border-white/5 text-[9px]">
            <div>
              <span className="text-[#d2e6ec]/40 block">SECTOR</span>
              <span className="text-[#f0f7fa] font-medium">{scanResult.scene.regionName.split(' ')[0]}</span>
            </div>
            <div>
              <span className="text-[#d2e6ec]/40 block">SENSOR</span>
              <span className="text-[#62e8ff]">{scanResult.scene.platform}</span>
            </div>
            <div>
              <span className="text-[#d2e6ec]/40 block">UNMATCHED</span>
              <span className="text-[#ff6b6b] font-medium">{unmatchedVessels.length} CONTACTS</span>
            </div>
            <div>
              <span className="text-[#d2e6ec]/40 block">MATCHED</span>
              <span className="text-[#66f0c3] font-medium">{matchedVessels.length} AIS</span>
            </div>
          </div>

          {/* Area Summary */}
          <div className="bg-black/30 border border-white/5 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[9px] tracking-[1.5px] uppercase text-[#62e8ff] font-medium">
                OBJECTIVE SECTOR SUMMARY
              </span>
              <button
                onClick={onRefreshAI}
                disabled={isGeneratingAI}
                className="flex items-center gap-1.5 text-[9px] text-[#62e8ff] hover:text-white bg-[#62e8ff]/10 hover:bg-[#62e8ff]/20 border border-[#62e8ff]/30 px-2 py-0.5 rounded transition disabled:opacity-40"
              >
                <RefreshCw className={`w-3 h-3 ${isGeneratingAI ? 'animate-spin' : ''}`} />
                <span>{isGeneratingAI ? 'ANALYZING...' : 'RE-RUN AI ANALYSIS'}</span>
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-[#d2e6ec]/80">
              {scanResult.areaSummary}
            </p>
          </div>

          {/* Contact Breakdown */}
          <div className="space-y-2">
            <span className="text-[9px] tracking-[1.5px] uppercase text-[#d2e6ec]/40 block">
              CONTACT OBSERVATIONS
            </span>
            <div className="space-y-1.5">
              {scanResult.vessels.map((v) => {
                const isUnm = v.classification === 'SAR_UNMATCHED';
                return (
                  <div
                    key={v.id}
                    className="p-2.5 rounded-lg border border-white/5 bg-black/20 text-[10px] space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{v.id}</span>
                        <span className="text-[#d2e6ec]/30">&bull;</span>
                        <span className="text-[#d2e6ec]/70">~{v.estimatedLengthMeters}m</span>
                        <span className="text-[#d2e6ec]/30">&bull;</span>
                        <span className="text-[#d2e6ec]/60">{v.position.lat.toFixed(4)}°N, {v.position.lon.toFixed(4)}°E</span>
                      </div>
                      <span className={`text-[9px] font-medium ${isUnm ? 'text-[#ff6b6b]' : 'text-[#66f0c3]'}`}>
                        {isUnm ? 'UNMATCHED SAR' : 'MATCHED AIS'}
                      </span>
                    </div>
                    <p className="text-[#d2e6ec]/75 text-[10px]">
                      {v.tacticalAssessment}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-white/10 bg-black/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyReport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-[#d2e6ec]/80 hover:text-white transition text-[10px]"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#66f0c3]" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'COPIED' : 'COPY REPORT'}</span>
            </button>

            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-[#d2e6ec]/80 hover:text-white transition text-[10px]"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>DOWNLOAD TXT</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white transition text-[10px]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
