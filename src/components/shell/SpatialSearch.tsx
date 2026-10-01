/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spatial Search Surface
 * Instant search for coordinates, maritime sectors, loaded target IDs, MMSIs, and scans.
 * Directly drives camera flight without navigating away from the 3D globe.
 */

import React, { useState, useMemo } from 'react';
import { Search, X, Crosshair, Globe, Radio, Compass, ArrowUpRight } from 'lucide-react';
import { RegionScenario, ScanResult, VesselTarget } from '../../types/darkfleet.ts';

interface SpatialSearchProps {
  isOpen: boolean;
  onClose: () => void;
  scenarios: RegionScenario[];
  scanResult: ScanResult | null;
  onSelectScenario: (sc: RegionScenario) => void;
  onSelectTarget: (tgt: VesselTarget) => void;
  onFlyToCoordinates: (lat: number, lon: number) => void;
}

export const SpatialSearch: React.FC<SpatialSearchProps> = ({
  isOpen,
  onClose,
  scenarios,
  scanResult,
  onSelectScenario,
  onSelectTarget,
  onFlyToCoordinates,
}) => {
  const [query, setQuery] = useState('');

  const trimmed = query.trim().toLowerCase();

  // Coordinate parse test: "1.25, 103.85" or "1.25 103.85"
  const parsedCoords = useMemo(() => {
    const parts = query.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 2) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return { lat, lon };
      }
    }
    return null;
  }, [query]);

  // Matching scenarios
  const matchingScenarios = useMemo(() => {
    if (!trimmed) return [];
    return scenarios.filter(
      (s) =>
        s.name.toLowerCase().includes(trimmed) ||
        s.chokepoint.toLowerCase().includes(trimmed) ||
        s.id.toLowerCase().includes(trimmed)
    );
  }, [scenarios, trimmed]);

  // Matching targets
  const matchingTargets = useMemo(() => {
    if (!trimmed || !scanResult) return [];
    return scanResult.vessels.filter(
      (v) =>
        v.id.toLowerCase().includes(trimmed) ||
        (v.aisCorrelation.mmsi && v.aisCorrelation.mmsi.includes(trimmed)) ||
        (v.aisCorrelation.vesselName && v.aisCorrelation.vesselName.toLowerCase().includes(trimmed)) ||
        v.classification.toLowerCase().includes(trimmed)
    );
  }, [scanResult, trimmed]);

  // Matching AIS observations
  const matchingAis = useMemo(() => {
    if (!trimmed || !scanResult) return [];
    return scanResult.aisObservations.filter(
      (a) =>
        a.mmsi.includes(trimmed) ||
        a.shipName.toLowerCase().includes(trimmed) ||
        a.callsign.toLowerCase().includes(trimmed)
    );
  }, [scanResult, trimmed]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60 backdrop-blur-sm p-4 pointer-events-auto font-mono text-xs text-[#f0f7fa]">
      <div
        style={{
          background: 'rgba(8, 16, 24, 0.94)',
          border: '1px solid rgba(180, 220, 235, 0.22)',
          backdropFilter: 'blur(32px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(32px) saturate(1.4)',
          borderRadius: '16px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.8)',
        }}
        className="w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Search Input Bar */}
        <div className="p-3.5 border-b border-white/10 flex items-center gap-3">
          <Search className="w-4 h-4 text-[#62e8ff] shrink-0" />
          <input
            type="text"
            autoFocus
            placeholder="Search coordinates (lat, lon), sectors, target IDs (DF-001), or MMSIs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-sm text-white placeholder:text-[#d2e6ec]/30 focus:outline-none"
          />
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[#d2e6ec]/40 hover:text-white hover:bg-white/5 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="max-h-80 overflow-y-auto p-2 space-y-1">
          {parsedCoords && (
            <button
              onClick={() => {
                onFlyToCoordinates(parsedCoords.lat, parsedCoords.lon);
                onClose();
              }}
              className="w-full text-left p-2.5 rounded-lg bg-[#62e8ff]/10 hover:bg-[#62e8ff]/20 border border-[#62e8ff]/40 flex items-center justify-between text-[#62e8ff] transition"
            >
              <div className="flex items-center gap-2">
                <Crosshair className="w-4 h-4" />
                <span>Fly to Coordinates: {parsedCoords.lat.toFixed(5)}°N, {parsedCoords.lon.toFixed(5)}°E</span>
              </div>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Scenarios */}
          {matchingScenarios.map((sc) => (
            <button
              key={sc.id}
              onClick={() => {
                onSelectScenario(sc);
                onClose();
              }}
              className="w-full text-left p-2 rounded-lg hover:bg-white/5 flex items-center justify-between text-[#d2e6ec]/80 hover:text-white transition"
            >
              <div className="flex items-center gap-2.5">
                <Compass className="w-4 h-4 text-[#62e8ff]/70" />
                <div>
                  <span className="font-medium text-white block">{sc.name}</span>
                  <span className="text-[10px] text-[#d2e6ec]/40">{sc.chokepoint}</span>
                </div>
              </div>
              <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-white/5 text-[#d2e6ec]/60">Sector</span>
            </button>
          ))}

          {/* Targets */}
          {matchingTargets.map((t) => {
            const isUnm = t.classification === 'SAR_UNMATCHED';
            return (
              <button
                key={t.id}
                onClick={() => {
                  onSelectTarget(t);
                  onClose();
                }}
                className="w-full text-left p-2 rounded-lg hover:bg-white/5 flex items-center justify-between text-[#d2e6ec]/80 hover:text-white transition"
              >
                <div className="flex items-center gap-2.5">
                  <Crosshair className={`w-4 h-4 ${isUnm ? 'text-[#ff6b6b]' : 'text-[#5cffc6]'}`} />
                  <div>
                    <span className="font-medium text-white block">
                      Target {t.id} &bull; ~{t.estimatedLengthMeters}m
                    </span>
                    <span className="text-[10px] text-[#d2e6ec]/50">
                      {t.classification} {t.aisCorrelation.mmsi ? `&bull; MMSI ${t.aisCorrelation.mmsi}` : ''}
                    </span>
                  </div>
                </div>
                <span className="text-[9px] text-[#62e8ff]">Inspect</span>
              </button>
            );
          })}

          {/* AIS Observations */}
          {matchingAis.map((a) => (
            <div
              key={a.mmsi}
              className="p-2 rounded-lg bg-black/20 flex items-center justify-between text-[#d2e6ec]/70"
            >
              <div className="flex items-center gap-2.5">
                <Radio className="w-4 h-4 text-[#ffc76b]" />
                <div>
                  <span className="text-white block font-medium">{a.shipName} (MMSI: {a.mmsi})</span>
                  <span className="text-[10px] text-[#d2e6ec]/40">{a.shipType} &bull; Flag: {a.flag}</span>
                </div>
              </div>
              <span className="text-[10px] text-amber-300 font-medium">{a.sog} kts</span>
            </div>
          ))}

          {!parsedCoords && matchingScenarios.length === 0 && matchingTargets.length === 0 && matchingAis.length === 0 && trimmed.length > 0 && (
            <div className="p-6 text-center text-[#d2e6ec]/40">
              No matching sectors, targets, or coordinates found for "{query}".
            </div>
          )}

          {trimmed.length === 0 && (
            <div className="p-4 text-center text-[11px] text-[#d2e6ec]/40 leading-relaxed">
              Type coordinates (e.g. <span className="text-white">1.25, 103.85</span>), target IDs (e.g. <span className="text-white">DF-001</span>), MMSI numbers, or sector names.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
