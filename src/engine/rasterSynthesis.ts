/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Synthetic Aperture Radar (SAR) Raster Synthesis & AIS Ground-Truth Simulator
 * Simulates Sentinel-1 C-band GRD backscatter physics, sea clutter, speckle, Kelvin wakes,
 * and realistic regional AIS telemetry feeds.
 */

import { AISObservation, Sentinel1Scene } from '../types/darkfleet.ts';
import { propagateDeadReckoning } from './geodesy.ts';

export interface SynthesizedSceneData {
  width: number;
  height: number;
  gridDb: number[][]; // normalized radar backscatter (dB)
  landMask: boolean[][]; // true = land pixel
  aisObservations: AISObservation[];
  groundTruthVessels: Array<{
    x: number;
    y: number;
    lengthM: number;
    widthM: number;
    headingDeg: number;
    sogKnots: number;
    isDark: boolean;
    isStationary: boolean;
    mmsi?: string;
    shipName?: string;
    shipType?: string;
    flag?: string;
    imo?: string;
  }>;
}

// Pseudo-random deterministic generator for consistent repeatable scenes
function pseudoRandom(seed: number) {
  let s = Math.sin(seed) * 10000;
  return s - Math.floor(s);
}

export function synthesizeSceneRaster(scene: Sentinel1Scene, width = 180, height = 180): SynthesizedSceneData {
  const gridDb: number[][] = Array.from({ length: height }, () => new Array(width).fill(-22.0));
  const landMask: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));

  const [minLon, minLat, maxLon, maxLat] = scene.bbox;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;

  // 1. Generate base ocean clutter with Rayleigh/Gamma speckle and wind streaks
  const baseNoiseMean = scene.seaClutterLevel === 'HIGH' ? -18.5 : scene.seaClutterLevel === 'LOW' ? -24.0 : -21.0;
  const windAngleRad = 0.65; // ~37 degrees

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Wind streak modulation (low-frequency radar backscatter variation)
      const windStreak = Math.sin((x * Math.cos(windAngleRad) + y * Math.sin(windAngleRad)) * 0.08) * 1.8;
      
      // Multi-look speckle noise (Rayleigh-like)
      const u1 = Math.max(0.0001, pseudoRandom(x * 37 + y * 97 + 101));
      const u2 = pseudoRandom(x * 53 + y * 13 + 307);
      const speckle = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 2.2;

      gridDb[y][x] = Number((baseNoiseMean + windStreak + speckle).toFixed(1));
    }
  }

  // 2. Synthesize geographic Land Masks for regional fidelity
  if (scene.id.includes('MALACCA')) {
    // Top-right: Singapore & southern tip of Malaysia
    for (let y = 0; y < Math.floor(height * 0.35); y++) {
      for (let x = Math.floor(width * 0.45); x < width; x++) {
        const edge = Math.sin(x * 0.15) * 6;
        if (y < Math.floor(height * 0.28) + edge) {
          landMask[y][x] = true;
          gridDb[y][x] = Number((-8.0 + pseudoRandom(x * 7 + y * 19) * 6).toFixed(1));
        }
      }
    }
    // Bottom-left: Indonesian Batam/Riau islands
    for (let y = Math.floor(height * 0.68); y < height; y++) {
      for (let x = 0; x < Math.floor(width * 0.55); x++) {
        const islandEdge = Math.cos(x * 0.12) * 8;
        if (y > Math.floor(height * 0.72) - islandEdge) {
          landMask[y][x] = true;
          gridDb[y][x] = Number((-7.5 + pseudoRandom(x * 11 + y * 23) * 5).toFixed(1));
        }
      }
    }
  } else if (scene.id.includes('HORMUZ')) {
    // Left: UAE / Fujairah coastline
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < Math.floor(width * 0.28); x++) {
        const coast = Math.sin(y * 0.1) * 7;
        if (x < Math.floor(width * 0.22) + coast) {
          landMask[y][x] = true;
          gridDb[y][x] = Number((-6.5 + pseudoRandom(x * 9 + y * 31) * 5).toFixed(1));
        }
      }
    }
  } else if (scene.id.includes('BLACKSEA')) {
    // Top: Crimean peninsula headlands
    for (let y = 0; y < Math.floor(height * 0.40); y++) {
      for (let x = 0; x < width; x++) {
        const cape = Math.sin(x * 0.08) * 12 + Math.cos(x * 0.04) * 8;
        if (y < Math.floor(height * 0.25) + cape) {
          landMask[y][x] = true;
          gridDb[y][x] = Number((-7.0 + pseudoRandom(x * 13 + y * 29) * 5.5).toFixed(1));
        }
      }
    }
  }

  // 3. Ground truth vessels & AIS telemetry dataset for each scenario
  interface VesselDef {
    xNorm: number;
    yNorm: number;
    lengthM: number;
    widthM: number;
    headingDeg: number;
    sogKnots: number;
    isDark: boolean;
    isStationary?: boolean;
    mmsi?: string;
    shipName?: string;
    shipType?: string;
    flag?: string;
    imo?: string;
  }

  let scenarioVessels: VesselDef[] = [];

  if (scene.id.includes('MALACCA')) {
    scenarioVessels = [
      // SIM_MATCHED_CARGO / SIM_MATCHED_TANKER: Reporting commercial vessels in transit corridor
      { xNorm: 0.35, yNorm: 0.42, lengthM: 294, widthM: 32, headingDeg: 122, sogKnots: 14.8, isDark: false, mmsi: '563189210', shipName: 'MAERSK MC-KINNEY', shipType: 'Container Ship', flag: 'Singapore', imo: '9619907' },
      { xNorm: 0.52, yNorm: 0.48, lengthM: 333, widthM: 60, headingDeg: 304, sogKnots: 13.2, isDark: false, mmsi: '477421900', shipName: 'COSCO SHIPPING SCORPIO', shipType: 'Crude Oil Tanker', flag: 'Hong Kong', imo: '9789647' },
      { xNorm: 0.68, yNorm: 0.54, lengthM: 228, widthM: 32, headingDeg: 125, sogKnots: 11.5, isDark: false, mmsi: '636019882', shipName: 'PACIFIC RUBY', shipType: 'Bulk Carrier', flag: 'Liberia', imo: '9428798' },
      { xNorm: 0.44, yNorm: 0.38, lengthM: 180, widthM: 28, headingDeg: 302, sogKnots: 12.0, isDark: false, mmsi: '538007142', shipName: 'ORIENT ADVANCE', shipType: 'Chemical Tanker', flag: 'Marshall Islands', imo: '9512018' },
      { xNorm: 0.78, yNorm: 0.62, lengthM: 95, widthM: 18, headingDeg: 118, sogKnots: 9.4, isDark: false, mmsi: '525005822', shipName: 'BATAM TRADER', shipType: 'General Cargo', flag: 'Indonesia', imo: '8910452' },

      // SIM_UNMATCHED_LARGE_RETURN: Large surface radar return in eastern anchorage without matching AIS broadcast in correlation window
      { xNorm: 0.72, yNorm: 0.32, lengthM: 318, widthM: 58, headingDeg: 78, sogKnots: 1.2, isDark: true },
      
      // SIM_UNMATCHED_PROXIMITY_PAIR: Two surface returns observed within 1.5 NM proximity without synchronized AIS
      { xNorm: 0.28, yNorm: 0.62, lengthM: 245, widthM: 42, headingDeg: 45, sogKnots: 1.8, isDark: true },
      { xNorm: 0.31, yNorm: 0.64, lengthM: 274, widthM: 48, headingDeg: 50, sogKnots: 1.5, isDark: true },

      // SIM_UNMATCHED_FAST_RETURN: Fast underway craft with wake signature without matching transponder report
      { xNorm: 0.58, yNorm: 0.65, lengthM: 115, widthM: 16, headingDeg: 260, sogKnots: 16.5, isDark: true },

      // SIM_STATIC_PLATFORM: Stationary offshore infrastructure return
      { xNorm: 0.18, yNorm: 0.22, lengthM: 65, widthM: 65, headingDeg: 0, sogKnots: 0, isDark: false, isStationary: true },
    ];
  } else if (scene.id.includes('HORMUZ')) {
    scenarioVessels = [
      // SIM_MATCHED_TANKER: Reporting tankers in Fujairah anchorage
      { xNorm: 0.45, yNorm: 0.35, lengthM: 330, widthM: 60, headingDeg: 140, sogKnots: 0.2, isDark: false, mmsi: '636015520', shipName: 'FRONT ALTAIR', shipType: 'Crude Oil Tanker', flag: 'Liberia', imo: '9745902' },
      { xNorm: 0.62, yNorm: 0.68, lengthM: 250, widthM: 44, headingDeg: 320, sogKnots: 13.8, isDark: false, mmsi: '311000843', shipName: 'BAHRI JAZAN', shipType: 'Ro-Ro Cargo', flag: 'Saudi Arabia', imo: '9626534' },
      { xNorm: 0.55, yNorm: 0.22, lengthM: 274, widthM: 48, headingDeg: 135, sogKnots: 1.1, isDark: false, mmsi: '256428000', shipName: 'MARAN GAS APOLLONIA', shipType: 'LNG Carrier', flag: 'Malta', imo: '9633434' },

      // SIM_UNMATCHED_LARGE_RETURN: Uncorrelated radar returns in offshore sector
      { xNorm: 0.75, yNorm: 0.45, lengthM: 320, widthM: 58, headingDeg: 210, sogKnots: 2.1, isDark: true },
      { xNorm: 0.77, yNorm: 0.47, lengthM: 190, widthM: 32, headingDeg: 215, sogKnots: 2.0, isDark: true },
      { xNorm: 0.38, yNorm: 0.75, lengthM: 130, widthM: 20, headingDeg: 90, sogKnots: 12.4, isDark: true },
      
      // SIM_STATIC_PLATFORM: Stationary mooring buoy / platform return
      { xNorm: 0.40, yNorm: 0.18, lengthM: 70, widthM: 70, headingDeg: 0, sogKnots: 0, isDark: false, isStationary: true },
    ];
  } else {
    // Default fallback scenarios (Black Sea, Red Sea, etc.)
    scenarioVessels = [
      { xNorm: 0.40, yNorm: 0.55, lengthM: 210, widthM: 30, headingDeg: 110, sogKnots: 12.5, isDark: false, mmsi: '215124000', shipName: 'SEAMAR TRADER', shipType: 'Bulk Carrier', flag: 'Malta', imo: '9312890' },
      { xNorm: 0.65, yNorm: 0.45, lengthM: 185, widthM: 26, headingDeg: 285, sogKnots: 10.8, isDark: false, mmsi: '352001182', shipName: 'CRIMEA FREIGHTER', shipType: 'General Cargo', flag: 'Panama', imo: '9211054' },
      // Unmatched returns
      { xNorm: 0.50, yNorm: 0.70, lengthM: 240, widthM: 40, headingDeg: 195, sogKnots: 8.5, isDark: true },
      { xNorm: 0.72, yNorm: 0.30, lengthM: 145, widthM: 22, headingDeg: 45, sogKnots: 0.8, isDark: true },
      { xNorm: 0.25, yNorm: 0.35, lengthM: 55, widthM: 55, headingDeg: 0, sogKnots: 0, isDark: false, isStationary: true },
    ];
  }

  // 4. Inject radar backscatter signatures onto the grid
  const sarAcquisitionTimeMs = new Date(scene.acquisitionTime).getTime();
  const aisObservations: AISObservation[] = [];
  const groundTruthVessels = [];

  for (const v of scenarioVessels) {
    const pxX = Math.round(v.xNorm * width);
    const pxY = Math.round(v.yNorm * height);

    if (landMask[pxY]?.[pxX]) continue;

    groundTruthVessels.push({
      x: pxX,
      y: pxY,
      lengthM: v.lengthM,
      widthM: v.widthM,
      headingDeg: v.headingDeg,
      sogKnots: v.sogKnots,
      isDark: v.isDark,
      isStationary: Boolean(v.isStationary),
      mmsi: v.mmsi,
      shipName: v.shipName,
      shipType: v.shipType,
      flag: v.flag,
      imo: v.imo,
    });

    // Hull pixel dimensions based on SAR resolution (10m/px)
    // Hull pixel dimensions scaled for the raster grid
    const hullLengthPx = Math.max(3, Math.min(10, Math.round(v.lengthM / 32)));
    const hullWidthPx = Math.max(1, Math.min(4, Math.round(v.widthM / 20)));
    const headingRad = (v.headingDeg * Math.PI) / 180;
    // Nautical bearing to screen coordinates: 0° is North (dy = -1), 90° is East (dx = +1)
    const dirX = Math.sin(headingRad);
    const dirY = -Math.cos(headingRad);
    const normalX = -dirY;
    const normalY = dirX;

    // Draw metallic hull corner reflectors (-4 dB to +5 dB)
    const halfL = hullLengthPx / 2;
    const halfW = hullWidthPx / 2;

    for (let l = -halfL; l <= halfL; l += 0.8) {
      for (let w = -halfW; w <= halfW; w += 0.8) {
        const hx = Math.round(pxX + l * dirX + w * normalX);
        const hy = Math.round(pxY + l * dirY + w * normalY);

        if (hx >= 0 && hx < width && hy >= 0 && hy < height && !landMask[hy][hx]) {
          // Intense metallic reflection
          const intensity = Number((0.5 + pseudoRandom(hx * 17 + hy * 41) * 3.8).toFixed(1));
          if (intensity > gridDb[hy][hx]) {
            gridDb[hy][hx] = intensity;
          }
        }
      }
    }

    // Add radar antenna cross-sidelobes (typical optical characteristic of C-band SAR)
    if (v.lengthM > 150) {
      for (let s = -2; s <= 2; s++) {
        const sx = pxX + s;
        const sy = pxY;
        if (sx >= 0 && sx < width && sy >= 0 && sy < height && !landMask[sy][sx]) {
          gridDb[sy][sx] = Math.max(gridDb[sy][sx], -4.0);
        }
      }
    }

    // Add Kelvin wake if moving (> 4 knots)
    if (v.sogKnots > 4.0 && !v.isStationary) {
      // Wake trails behind vessel stern: opposite to dir
      const wakeDirX = -dirX;
      const wakeDirY = -dirY;
      const wakeArmsAngle = 0.34; // ~19.5 deg Kelvin envelope

      for (let dist = 3; dist <= 12; dist += 2) {
        // Turbulent dark centerline scar (reduced backscatter: -25 to -28 dB)
        const cx = Math.round(pxX + wakeDirX * dist);
        const cy = Math.round(pxY + wakeDirY * dist);
        if (cx >= 0 && cx < width && cy >= 0 && cy < height && !landMask[cy][cx]) {
          gridDb[cy][cx] = -27.5;
        }

        // Positive V-wake crests (rough wave crests: -12 to -14 dB)
        const offset = dist * Math.tan(wakeArmsAngle);
        const arm1X = Math.round(cx + normalX * offset);
        const arm1Y = Math.round(cy + normalY * offset);
        const arm2X = Math.round(cx - normalX * offset);
        const arm2Y = Math.round(cy - normalY * offset);

        if (arm1X >= 0 && arm1X < width && arm1Y >= 0 && arm1Y < height && !landMask[arm1Y][arm1X]) {
          gridDb[arm1Y][arm1X] = Math.max(gridDb[arm1Y][arm1X], -13.0);
        }
        if (arm2X >= 0 && arm2X < width && arm2Y >= 0 && arm2Y < height && !landMask[arm2Y][arm2X]) {
          gridDb[arm2Y][arm2X] = Math.max(gridDb[arm2Y][arm2X], -13.0);
        }
      }
    }


    // Generate AIS telemetry observation for non-dark vessels
    if (!v.isDark && v.mmsi) {
      // Calculate SAR acquisition WGS-84 lat/lon
      const sarLon = minLon + (pxX / width) * lonSpan;
      const sarLat = maxLat - (pxY / height) * latSpan;

      // Realistically offset timestamp by -15 to +60 seconds to test kinematics propagation
      const timeOffsetSec = Math.round((pseudoRandom(pxX * 19 + pxY * 29) - 0.4) * 80);
      const aisTimestamp = new Date(sarAcquisitionTimeMs - timeOffsetSec * 1000).toISOString();

      // Kinematically back-propagate position to historical AIS broadcast time
      const { lat: aisLat, lon: aisLon } = propagateDeadReckoning(
        sarLat,
        sarLon,
        v.sogKnots,
        v.headingDeg,
        -timeOffsetSec
      );

      aisObservations.push({
        mmsi: v.mmsi,
        shipName: v.shipName ?? 'COMMERCIAL VESSEL',
        callsign: `9V${v.mmsi.slice(-4)}`,
        imo: v.imo ?? `9${v.mmsi.slice(-6)}`,
        flag: v.flag ?? 'Singapore',
        shipType: v.shipType ?? 'Cargo Ship',
        lat: Number(aisLat.toFixed(6)),
        lon: Number(aisLon.toFixed(6)),
        sog: v.sogKnots,
        cog: v.headingDeg,
        heading: v.headingDeg,
        navStatus: v.sogKnots < 1.0 ? 'At Anchor' : 'Under Way Using Engine',
        length: v.lengthM,
        width: v.widthM,
        timestamp: aisTimestamp,
      });
    }
  }

  // 5. Add 1-2 AIS Spoof / Ghost transponder broadcasts (AIS transmitting, but no radar target exists)
  const ghostLat = maxLat - 0.85 * latSpan;
  const ghostLon = minLon + 0.15 * lonSpan;
  aisObservations.push({
    mmsi: '357900124',
    shipName: 'PHANTOM TRADER (GHOST)',
    callsign: 'HO9912',
    imo: '9182391',
    flag: 'Panama',
    shipType: 'Oil Products Tanker',
    lat: Number(ghostLat.toFixed(6)),
    lon: Number(ghostLon.toFixed(6)),
    sog: 11.2,
    cog: 85,
    heading: 85,
    navStatus: 'Under Way Using Engine',
    length: 182,
    width: 32,
    timestamp: new Date(sarAcquisitionTimeMs - 45 * 1000).toISOString(),
  });

  return {
    width,
    height,
    gridDb,
    landMask,
    aisObservations,
    groundTruthVessels,
  };
}
