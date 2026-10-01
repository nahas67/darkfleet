/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Target & AIS Telemetry Table
 * Searchable, filterable tactical data grid for all SAR detections and AIS observations.
 */

import React, { useState } from 'react';
import { Search, ShieldAlert, ShieldCheck, Radio, Anchor, ChevronDown, ChevronUp, Crosshair } from 'lucide-react';
import { ScanResult, VesselTarget } from '../types/darkfleet.ts';

interface AISTelemetryTableProps {
  scanResult: ScanResult | null;
  selectedTarget: VesselTarget | null;
  onSelectTarget: (target: VesselTarget) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export const AISTelemetryTable: React.FC<AISTelemetryTableProps> = ({
  scanResult,
  selectedTarget,
  onSelectTarget,
  isOpen,
  onToggleOpen,
}) => {
  const [activeTab, setActiveTab] = useState<'targets' | 'ais'>('targets');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterType, setFilterType] = useState<'all' | 'unmatched' | 'matched'>('all');

  if (!scanResult) return null;

  // Filtered radar targets
  const filteredTargets = scanResult.vessels.filter((v) => {
    if (filterType === 'unmatched' && v.classification !== 'SAR_UNMATCHED') return false;
    if (filterType === 'matched' && v.classification !== 'SAR_MATCHED_AIS') return false;

    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      v.id.toLowerCase().includes(q) ||
      (v.aisCorrelation.mmsi && v.aisCorrelation.mmsi.includes(q)) ||
      (v.aisCorrelation.vesselName && v.aisCorrelation.vesselName.toLowerCase().includes(q)) ||
      v.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  // Filtered AIS broadcasts
  const filteredAis = scanResult.aisObservations.filter((a) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.mmsi.includes(q) ||
      a.shipName.toLowerCase().includes(q) ||
      a.flag.toLowerCase().includes(q) ||
      a.shipType.toLowerCase().includes(q)
    );
  });

  return (
    <div className="bg-[#080c10] border-t border-cyan-950/80 text-xs font-mono select-none">
      {/* Drawer Toggle Header Bar */}
      <div className="px-4 py-2 bg-[#0a0f16] border-b border-slate-800/80 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveTab('targets')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md font-bold transition ${
              activeTab === 'targets'
                ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>RADAR TARGETS ({scanResult.vessels.length})</span>
            {scanResult.unmatchedCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-950 text-rose-400 border border-rose-500/50">
                {scanResult.unmatchedCount} UNMATCHED
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('ais')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md font-bold transition ${
              activeTab === 'ais'
                ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>REGIONAL AIS TELEMETRY ({scanResult.aisObservations.length})</span>
          </button>
        </div>

        <div className="flex items-center gap-3">
          {isOpen && (
            <div className="flex items-center gap-2">
              {/* Quick filter pills */}
              {activeTab === 'targets' && (
                <div className="hidden md:flex items-center gap-1 text-[10px]">
                  {(['all', 'unmatched', 'matched'] as const).map((ft) => (
                    <button
                      key={ft}
                      onClick={() => setFilterType(ft)}
                      className={`px-2 py-0.5 rounded uppercase border transition ${
                        filterType === ft
                          ? 'border-cyan-500 bg-cyan-950 text-cyan-300 font-bold'
                          : 'border-slate-800 text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {ft}
                    </button>
                  ))}
                </div>
              )}

              {/* Search input */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Filter MMSI, ID, Name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-[#05080c] border border-slate-800 rounded-md pl-7 pr-2 py-1 text-slate-200 text-xs placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
          )}

          <button
            onClick={onToggleOpen}
            className="flex items-center gap-1 text-slate-400 hover:text-cyan-300 transition px-2 py-1 rounded hover:bg-slate-800"
          >
            <span className="text-[11px]">{isOpen ? 'COLLAPSE' : 'EXPAND TABLE'}</span>
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Expanded Table Content */}
      {isOpen && (
        <div className="max-h-60 overflow-y-auto">
          {activeTab === 'targets' ? (
            <table className="w-full text-left border-collapse">
              <thead className="bg-[#05080c] text-slate-500 text-[10px] sticky top-0 border-b border-slate-800 z-10">
                <tr>
                  <th className="p-2.5 font-bold">TARGET ID</th>
                  <th className="p-2.5 font-bold">CLASSIFICATION</th>
                  <th className="p-2.5 font-bold">THREAT</th>
                  <th className="p-2.5 font-bold">APPARENT LENGTH</th>
                  <th className="p-2.5 font-bold">PEAK RCS (dB)</th>
                  <th className="p-2.5 font-bold">HEADING / WAKE</th>
                  <th className="p-2.5 font-bold">AIS CORRELATION</th>
                  <th className="p-2.5 font-bold text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredTargets.map((v) => {
                  const isSelected = selectedTarget?.id === v.id;
                  const isUnm = v.classification === 'SAR_UNMATCHED';

                  return (
                    <tr
                      key={v.id}
                      onClick={() => onSelectTarget(v)}
                      className={`hover:bg-slate-800/40 cursor-pointer transition ${
                        isSelected ? 'bg-cyan-950/40 border-l-2 border-cyan-400' : ''
                      }`}
                    >
                      <td className="p-2.5 font-bold text-cyan-300 flex items-center gap-1.5">
                        <Crosshair className="w-3 h-3 text-cyan-400" />
                        {v.id}
                      </td>
                      <td className="p-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          isUnm
                            ? 'bg-rose-950/70 border border-rose-500/50 text-rose-300'
                            : v.classification === 'STATIONARY_OR_INFRASTRUCTURE'
                            ? 'bg-sky-950/70 border border-sky-500/50 text-sky-300'
                            : 'bg-emerald-950/70 border border-emerald-500/50 text-emerald-300'
                        }`}>
                          {v.classification.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="p-2.5">
                        <span className={`font-bold ${isUnm ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {isUnm ? 'UNMATCHED' : 'CORRELATED'}
                        </span>
                      </td>
                      <td className="p-2.5 text-slate-200">
                        ~{v.estimatedLengthMeters}m <span className="text-slate-500 text-[10px]">(&plusmn;{v.lengthUncertaintyMeters}m)</span>
                      </td>
                      <td className="p-2.5 font-bold text-slate-300">{v.maxBackscatterDb} dB</td>
                      <td className="p-2.5 text-slate-300">
                        {v.estimatedHeadingDeg}° {v.wakeVisible && <span className="text-cyan-400 font-bold ml-1">(Wake)</span>}
                      </td>
                      <td className="p-2.5">
                        {v.aisCorrelation.matched ? (
                          <div className="flex items-center gap-1 text-emerald-400">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            <span>MMSI {v.aisCorrelation.mmsi} ({v.aisCorrelation.vesselName})</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-rose-400 font-bold">
                            <ShieldAlert className="w-3.5 h-3.5" />
                            <span>NO TRANSPONDER DETECTED</span>
                          </div>
                        )}
                      </td>
                      <td className="p-2.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectTarget(v);
                          }}
                          className="px-2 py-0.5 rounded text-[10px] border border-cyan-800 hover:border-cyan-400 text-cyan-300 hover:bg-cyan-950 transition"
                        >
                          INSPECT
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead className="bg-[#05080c] text-slate-500 text-[10px] sticky top-0 border-b border-slate-800 z-10">
                <tr>
                  <th className="p-2.5 font-bold">MMSI</th>
                  <th className="p-2.5 font-bold">VESSEL NAME</th>
                  <th className="p-2.5 font-bold">FLAG / CALLSIGN</th>
                  <th className="p-2.5 font-bold">VESSEL TYPE</th>
                  <th className="p-2.5 font-bold">COORDINATES</th>
                  <th className="p-2.5 font-bold">SPEED / COURSE</th>
                  <th className="p-2.5 font-bold">STATUS</th>
                  <th className="p-2.5 font-bold">SAR CORRELATION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredAis.map((a) => {
                  const correlatedTarget = scanResult.vessels.find(
                    (v) => v.aisCorrelation.mmsi === a.mmsi && v.aisCorrelation.matched
                  );

                  return (
                    <tr key={a.mmsi} className="hover:bg-slate-800/40 transition">
                      <td className="p-2.5 font-bold text-cyan-300">{a.mmsi}</td>
                      <td className="p-2.5 font-bold text-slate-200">{a.shipName}</td>
                      <td className="p-2.5 text-slate-400">{a.flag} ({a.callsign})</td>
                      <td className="p-2.5 text-slate-300">{a.shipType}</td>
                      <td className="p-2.5 text-slate-400">{a.lat.toFixed(4)}°N, {a.lon.toFixed(4)}°E</td>
                      <td className="p-2.5 text-slate-200">{a.sog} kts &bull; {a.cog}°</td>
                      <td className="p-2.5 text-slate-400">{a.navStatus}</td>
                      <td className="p-2.5">
                        {correlatedTarget ? (
                          <button
                            onClick={() => onSelectTarget(correlatedTarget)}
                            className="flex items-center gap-1 text-emerald-400 font-bold hover:underline"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            <span>Matched with {correlatedTarget.id}</span>
                          </button>
                        ) : (
                          <span className="text-amber-400 flex items-center gap-1 font-bold">
                            <Radio className="w-3.5 h-3.5" />
                            <span>No Radar Target (Ghost/AIS-Only)</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};
