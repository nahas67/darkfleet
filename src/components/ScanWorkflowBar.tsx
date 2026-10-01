/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Scan Workflow Bar & Status Indicator
 * Shows the multi-stage SAR + AIS processing pipeline progress.
 */

import React from 'react';
import { CheckCircle2, Clock, Cpu, Database, Satellite, Zap } from 'lucide-react';
import { ScanResult } from '../types/darkfleet.ts';

interface ScanWorkflowBarProps {
  scanResult: ScanResult | null;
  isScanning: boolean;
  currentStage: string;
}

export const ScanWorkflowBar: React.FC<ScanWorkflowBarProps> = ({
  scanResult,
  isScanning,
  currentStage,
}) => {
  const stages = [
    { id: 'SEARCHING_SCENE', label: 'STAC SCENE' },
    { id: 'LOADING_SAR', label: 'SAR WINDOW' },
    { id: 'MASKING_LAND', label: 'LAND MASK' },
    { id: 'FILTERING', label: 'SPECKLE FILTER' },
    { id: 'DETECTING', label: 'CA-CFAR' },
    { id: 'LOADING_AIS', label: 'AIS ARCHIVE' },
    { id: 'CORRELATING', label: 'SPATIO-TEMPORAL' },
  ];

  return (
    <div className="bg-[#080c10] border-t border-cyan-950/70 px-4 py-2 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs font-mono select-none text-slate-300">
      {/* Workflow Steps / Progress */}
      <div className="flex items-center gap-1.5 overflow-x-auto max-w-full py-0.5">
        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mr-1">
          PIPELINE:
        </span>
        {stages.map((st, idx) => {
          const isDone = !isScanning && Boolean(scanResult);
          const isCurrent = isScanning && currentStage === st.id;

          return (
            <div key={st.id} className="flex items-center gap-1 shrink-0">
              <span
                className={`px-2 py-0.5 rounded text-[10px] flex items-center gap-1 border transition ${
                  isCurrent
                    ? 'border-cyan-400 bg-cyan-950 text-cyan-300 animate-pulse font-bold'
                    : isDone
                    ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-400'
                    : 'border-slate-800 bg-[#0d1319] text-slate-600'
                }`}
              >
                {isDone && <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />}
                {st.label}
              </span>
              {idx < stages.length - 1 && <span className="text-slate-700 text-[10px]">&rsaquo;</span>}
            </div>
          );
        })}
      </div>

      {/* Metrics & Processing Time */}
      {scanResult && !isScanning && (
        <div className="flex items-center gap-4 text-[11px] shrink-0">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-slate-400">LATENCY:</span>
            <span className="text-cyan-300 font-bold">{scanResult.processingTimeMs} ms</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-slate-400">TARGETS:</span>
            <span className="text-emerald-300 font-bold">{scanResult.detectionsCount}</span>
            <span className="text-slate-500">
              ({scanResult.matchedCount} AIS / {scanResult.unmatchedCount} Unmatched)
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-1.5">
            <span className="text-slate-400">CONFIDENCE:</span>
            <span className="text-cyan-300 font-bold">{Math.round(scanResult.scanConfidence * 100)}%</span>
          </div>
        </div>
      )}
    </div>
  );
};
