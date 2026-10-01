/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Floating Telemetry & Contacts Workspace Overlay
 * On-demand glass bottom sheet for deep-dive tabular inspection.
 */

import React, { useState } from 'react';
import { X, Search, Crosshair, Radio, ShieldCheck, ShieldAlert, ArrowUpRight } from 'lucide-react';
import { ScanResult, VesselTarget } from '../../types/darkfleet.ts';

interface TelemetryOverlayProps {
  scanResult: ScanResult | null;
  selectedTarget: VesselTarget | null;
  onSelectTarget: (target: VesselTarget) => void;
  isOpen: boolean;
  onClose: () => void;
}

export const TelemetryOverlay: React.FC<TelemetryOverlayProps> = ({
  scanResult,
  selectedTarget,
  onSelectTarget,
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'contacts' | 'ais'>('contacts');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'unmatched' | 'matched'>('all');

  if (!isOpen || !scanResult) return null;

  const filteredTargets = scanResult.vessels.filter((v) => {
    if (filterMode === 'unmatched' && v.classification !== 'SAR_UNMATCHED') return false;
    if (filterMode === 'matched' && v.classification !== 'SAR_MATCHED_AIS') return false;

    if (!search) return true;
    const q = search.toLowerCase();
    return (
      v.id.toLowerCase().includes(q) ||
      (v.aisCorrelation.mmsi && v.aisCorrelation.mmsi.includes(q)) ||
      (v.aisCorrelation.vesselName && v.aisCorrelation.vesselName.toLowerCase().includes(q))
    );
  });

  const filteredAis = scanResult.aisObservations.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.mmsi.includes(q) || a.shipName.toLowerCase().includes(q) || a.flag.toLowerCase().includes(q);
  });

  return (
    <div className="fixed bottom-[9vh] left-1/2 -translate-x-1/2 z-40 w-[94vw] max-w-[1140px] pointer-events-auto select-none font-mono text-xs text-[#f0f7fa]">
      <div
        style={{
          background: 'rgba(8, 16, 24, 0.90)',
          border: '1px solid rgba(180, 220, 235, 0.18)',
          backdropFilter: 'blur(30px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(30px) saturate(1.4)',
          borderRadius: '16px',
          boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
        }}
        className="h-[min(44vh,440px)] flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200"
      >
        {/* Header Tabs */}
        <div className="p-3 border-b border-white/10 flex items-center justify-between bg-black/20">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setActiveTab('contacts')}
              className={`px-3 py-1 rounded-lg text-xs tracking-wider transition ${
                activeTab === 'contacts'
                  ? 'bg-[#62e8ff]/20 text-[#62e8ff] border border-[#62e8ff]/40 font-medium'
                  : 'text-[#d2e6ec]/50 hover:text-white'
              }`}
            >
              RADAR CONTACTS ({scanResult.vessels.length})
            </button>

            <button
              onClick={() => setActiveTab('ais')}
              className={`px-3 py-1 rounded-lg text-xs tracking-wider transition ${
                activeTab === 'ais'
                  ? 'bg-[#62e8ff]/20 text-[#62e8ff] border border-[#62e8ff]/40 font-medium'
                  : 'text-[#d2e6ec]/50 hover:text-white'
              }`}
            >
              AIS TELEMETRY ({scanResult.aisObservations.length})
            </button>
          </div>

          <div className="flex items-center gap-2">
            {activeTab === 'contacts' && (
              <div className="flex items-center gap-1 text-[10px]">
                {(['all', 'unmatched', 'matched'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setFilterMode(mode)}
                    className={`px-2 py-0.5 rounded uppercase border transition ${
                      filterMode === mode
                        ? 'border-[#62e8ff] text-[#62e8ff] bg-[#62e8ff]/10'
                        : 'border-white/10 text-[#d2e6ec]/40 hover:text-white'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            )}

            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[#d2e6ec]/30" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-black/40 border border-white/10 rounded-lg pl-7 pr-2 py-1 text-xs text-white placeholder:text-[#d2e6ec]/30 focus:outline-none focus:border-[#62e8ff]"
              />
            </div>

            <button
              onClick={onClose}
              className="p-1 rounded-lg text-[#d2e6ec]/40 hover:text-white hover:bg-white/5 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'contacts' ? (
            <table className="w-full text-left border-collapse text-[11px]">
              <thead className="sticky top-0 bg-[#09111a] text-[#d2e6ec]/40 text-[9px] tracking-wider border-b border-white/5 z-10">
                <tr>
                  <th className="p-2.5">ID</th>
                  <th className="p-2.5">CLASSIFICATION</th>
                  <th className="p-2.5">FOOTPRINT</th>
                  <th className="p-2.5">PEAK RCS</th>
                  <th className="p-2.5">HEADING</th>
                  <th className="p-2.5">AIS ASSOCIATION</th>
                  <th className="p-2.5 text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredTargets.map((t) => {
                  const isSel = selectedTarget?.id === t.id;
                  const isUnm = t.classification === 'SAR_UNMATCHED';

                  return (
                    <tr
                      key={t.id}
                      onClick={() => onSelectTarget(t)}
                      className={`hover:bg-white/5 cursor-pointer transition ${
                        isSel ? 'bg-[#62e8ff]/10 text-[#62e8ff]' : ''
                      }`}
                    >
                      <td className="p-2.5 font-medium">{t.id}</td>
                      <td className="p-2.5">
                        <span className={`text-[10px] font-medium tracking-wider ${isUnm ? 'text-[#ff6b6b]' : 'text-[#66f0c3]'}`}>
                          {isUnm ? 'UNMATCHED' : 'MATCHED AIS'}
                        </span>
                      </td>
                      <td className="p-2.5">~{t.estimatedLengthMeters}m</td>
                      <td className="p-2.5">{t.maxBackscatterDb} dB</td>
                      <td className="p-2.5">{String(Math.round(t.estimatedHeadingDeg)).padStart(3, '0')}°</td>
                      <td className="p-2.5">
                        {t.aisCorrelation.matched ? (
                          <span className="text-[#66f0c3]">MMSI {t.aisCorrelation.mmsi}</span>
                        ) : (
                          <span className="text-[#d2e6ec]/40">Unassociated</span>
                        )}
                      </td>
                      <td className="p-2.5 text-right">
                        <span className="text-[10px] text-[#62e8ff] hover:underline flex items-center justify-end gap-1">
                          Focus <ArrowUpRight className="w-3 h-3" />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse text-[11px]">
              <thead className="sticky top-0 bg-[#09111a] text-[#d2e6ec]/40 text-[9px] tracking-wider border-b border-white/5 z-10">
                <tr>
                  <th className="p-2.5">MMSI</th>
                  <th className="p-2.5">VESSEL NAME</th>
                  <th className="p-2.5">FLAG</th>
                  <th className="p-2.5">TYPE</th>
                  <th className="p-2.5">POSITION</th>
                  <th className="p-2.5">SPEED / COURSE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredAis.map((a) => (
                  <tr key={a.mmsi} className="hover:bg-white/5 transition">
                    <td className="p-2.5 text-[#62e8ff] font-medium">{a.mmsi}</td>
                    <td className="p-2.5 font-medium">{a.shipName}</td>
                    <td className="p-2.5 text-[#d2e6ec]/60">{a.flag}</td>
                    <td className="p-2.5 text-[#d2e6ec]/70">{a.shipType}</td>
                    <td className="p-2.5 text-[#d2e6ec]/60">{a.lat.toFixed(4)}°N, {a.lon.toFixed(4)}°E</td>
                    <td className="p-2.5">{a.sog} kts &bull; {a.cog}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
