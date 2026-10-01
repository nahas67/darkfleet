/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Synthetic Aperture Radar (SAR) Processor & CA-CFAR Detector
 * Implements 2D Cell-Averaging Constant False Alarm Rate (CA-CFAR),
 * Connected Component Analysis, Spatial Moments, and Target Geometry Extraction.
 */

import { CFARConfig, SARChip } from '../types/darkfleet.ts';

export interface RawDetection {
  x: number;
  y: number;
  intensityDb: number;
}

export interface ExtractedComponent {
  centroidX: number;
  centroidY: number;
  pixelArea: number;
  majorAxisPx: number;
  minorAxisPx: number;
  orientationDeg: number;
  maxBackscatterDb: number;
  meanBackscatterDb: number;
  wakeVisible: boolean;
  wakeHeadingDeg?: number;
  boundingBox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  chip: SARChip;
}

/**
 * 2D 3x3 Median filter for SAR speckle reduction
 */
export function applyMedianFilter(grid: number[][], width: number, height: number): number[][] {
  const result: number[][] = Array.from({ length: height }, () => new Float64Array(width) as unknown as number[]);
  const neighbors = new Float64Array(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = Math.max(0, Math.min(height - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          neighbors[idx++] = grid[ny][nx];
        }
      }
      neighbors.sort();
      result[y][x] = neighbors[4]; // median value
    }
  }
  return result;
}

/**
 * CA-CFAR (Cell-Averaging Constant False Alarm Rate) Detector:
 * Estimates surrounding clutter background in training window around test cell,
 * skipping guard cells to prevent target self-masking.
 */
export function runCaCfar(
  grid: number[][],
  width: number,
  height: number,
  config: CFARConfig,
  landMask?: boolean[][]
): boolean[][] {
  const binaryDetections: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  const { trainingCells, guardCells, thresholdFactor } = config;

  // Window radii
  const guardRadius = Math.ceil(Math.sqrt(guardCells) / 2);
  const trainRadius = guardRadius + Math.ceil(Math.sqrt(trainingCells) / 2);

  for (let y = trainRadius; y < height - trainRadius; y++) {
    for (let x = trainRadius; x < width - trainRadius; x++) {
      // Exclude land pixels
      if (landMask && landMask[y]?.[x]) {
        continue;
      }

      // Convert dB to linear power for physical speckle averaging: P = 10^(dB / 10)
      const testValDb = grid[y][x];
      const testPower = Math.pow(10, testValDb / 10);

      let trainingSum = 0;
      let trainingCount = 0;

      for (let dy = -trainRadius; dy <= trainRadius; dy++) {
        for (let dx = -trainRadius; dx <= trainRadius; dx++) {
          const inGuard = Math.abs(dy) <= guardRadius && Math.abs(dx) <= guardRadius;
          if (inGuard) continue;

          // Check if training pixel is on land
          const py = y + dy;
          const px = x + dx;
          if (landMask && landMask[py]?.[px]) {
            continue;
          }

          const power = Math.pow(10, grid[py][px] / 10);
          trainingSum += power;
          trainingCount++;
        }
      }

      if (trainingCount < 6) continue;

      const backgroundMean = trainingSum / trainingCount;
      const cfarThreshold = backgroundMean * thresholdFactor;

      if (testPower > cfarThreshold) {
        binaryDetections[y][x] = true;
      }
    }
  }

  return binaryDetections;
}

/**
 * Computes second central moments and orientation/axes from weighted component pixels.
 * Strictly normalizes central moments once (prevents double-normalization bug).
 */
export function computeComponentMoments(
  pixels: Array<{ x: number; y: number; valDb: number }>,
  centroidX: number,
  centroidY: number,
  m00: number
): { majorAxisPx: number; minorAxisPx: number; orientationDeg: number } {
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;

  for (const p of pixels) {
    const weight = Math.pow(10, (p.valDb + 30) / 10);
    const dx = p.x - centroidX;
    const dy = p.y - centroidY;
    mu20 += dx * dx * weight;
    mu02 += dy * dy * weight;
    mu11 += dx * dy * weight;
  }

  // Strictly normalize once by m00
  mu20 /= m00;
  mu02 /= m00;
  mu11 /= m00;

  // Major and minor axes from eigenvalues of covariance matrix
  const common = Math.sqrt(Math.max(0, Math.pow(mu20 - mu02, 2) + 4 * Math.pow(mu11, 2)));
  const majorAxisPx = Math.max(1.5, 2 * Math.sqrt(Math.max(0, (mu20 + mu02 + common) / 2)));
  const minorAxisPx = Math.max(1.0, 2 * Math.sqrt(Math.max(0, (mu20 + mu02 - common) / 2)));

  // Orientation angle in degrees (-90..+90 mapped to 0..180)
  const thetaRad = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  let orientationDeg = (thetaRad * 180) / Math.PI;
  if (orientationDeg < 0) orientationDeg += 180;

  return { majorAxisPx, minorAxisPx, orientationDeg: Math.round(orientationDeg) };
}

/**
 * Connected Component Labeling & Spatial Moments extraction
 * Groups contiguous detected pixels, extracts centroid, orientation, apparent size, and radar chip.
 */
export function extractConnectedComponents(
  binaryMask: boolean[][],
  rawGrid: number[][],
  width: number,
  height: number,
  config: CFARConfig,
  resolutionMeters: number = 10
): ExtractedComponent[] {
  const visited: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  const components: ExtractedComponent[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!binaryMask[y][x] || visited[y][x]) continue;

      // Breadth-first search / flood fill
      const pixels: Array<{ x: number; y: number; valDb: number }> = [];
      const queue: Array<{ x: number; y: number }> = [{ x, y }];
      visited[y][x] = true;

      let minX = x, maxX = x, minY = y, maxY = y;

      while (queue.length > 0) {
        const p = queue.shift()!;
        const valDb = rawGrid[p.y][p.x];
        pixels.push({ x: p.x, y: p.y, valDb });

        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;

        // 8-connectivity
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = p.x + dx;
            const ny = p.y + dy;

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              if (binaryMask[ny][nx] && !visited[ny][nx]) {
                visited[ny][nx] = true;
                queue.push({ x: nx, y: ny });
              }
            }
          }
        }
      }

      // Filter by pixel count criteria
      if (pixels.length < config.minPixels || pixels.length > config.maxPixels) {
        continue;
      }

      // Calculate spatial moments (M00, M10, M01, mu20, mu02, mu11)
      let m00 = 0;
      let m10 = 0;
      let m01 = 0;
      let maxDb = -999;
      let sumDb = 0;

      for (const p of pixels) {
        const weight = Math.pow(10, (p.valDb + 30) / 10); // positive linear weight
        m00 += weight;
        m10 += p.x * weight;
        m01 += p.y * weight;
        sumDb += p.valDb;
        if (p.valDb > maxDb) maxDb = p.valDb;
      }

      const centroidX = m10 / m00;
      const centroidY = m01 / m00;
      const meanDb = sumDb / pixels.length;

      const { majorAxisPx, minorAxisPx, orientationDeg } = computeComponentMoments(
        pixels,
        centroidX,
        centroidY,
        m00
      );



      // Extract Radar Chip (24x24 postage-stamp centered on detection)
      const chipSize = 24;
      const halfChip = Math.floor(chipSize / 2);
      const chipMatrix: number[][] = [];
      const cornerReflectors: Array<{ x: number; y: number; intensity: number }> = [];

      let chipSum = 0;
      let chipMax = -999;
      let chipClutterSum = 0;
      let chipClutterCount = 0;

      for (let cy = 0; cy < chipSize; cy++) {
        const row: number[] = [];
        const py = Math.floor(centroidY) - halfChip + cy;
        for (let cx = 0; cx < chipSize; cx++) {
          const px = Math.floor(centroidX) - halfChip + cx;
          let val = -24.0;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            val = rawGrid[py][px];
          }
          row.push(Number(val.toFixed(1)));
          chipSum += val;
          if (val > chipMax) chipMax = val;

          // Corner reflector test (> -6 dB)
          if (val > -6.0) {
            cornerReflectors.push({ x: cx, y: cy, intensity: val });
          }

          // Distant cells for clutter
          const distToCenter = Math.hypot(cx - halfChip, cy - halfChip);
          if (distToCenter > 7) {
            chipClutterSum += val;
            chipClutterCount++;
          }
        }
        chipMatrix.push(row);
      }

      // Wake analysis: search for Kelvin wake V-arms or centerline turbulent scar
      const wakeDetected = analyzeKelvinWake(rawGrid, centroidX, centroidY, orientationDeg, width, height);

      components.push({
        centroidX,
        centroidY,
        pixelArea: pixels.length,
        majorAxisPx,
        minorAxisPx,
        orientationDeg: Math.round(orientationDeg),
        maxBackscatterDb: Number(maxDb.toFixed(1)),
        meanBackscatterDb: Number(meanDb.toFixed(1)),
        wakeVisible: wakeDetected.visible,
        wakeHeadingDeg: wakeDetected.heading,
        boundingBox: { minX, minY, maxX, maxY },
        chip: {
          matrix: chipMatrix,
          width: chipSize,
          height: chipSize,
          maxDb: Number(chipMax.toFixed(1)),
          meanDb: Number((chipSum / (chipSize * chipSize)).toFixed(1)),
          clutterMeanDb: Number((chipClutterCount > 0 ? chipClutterSum / chipClutterCount : -20.0).toFixed(1)),
          cornerReflectors: cornerReflectors.slice(0, 5),
        },
      });
    }
  }

  return components;
}

/**
 * Detects presence of geometric Kelvin wake or turbulent centerline scar
 * by sampling along the candidate vessel axis in both directions.
 */
function analyzeKelvinWake(
  grid: number[][],
  cx: number,
  cy: number,
  axisDeg: number,
  width: number,
  height: number
): { visible: boolean; heading?: number } {
  const rad = (axisDeg * Math.PI) / 180;
  const dir1X = Math.cos(rad);
  const dir1Y = Math.sin(rad);

  // Sample along dir1 and dir2 (180 opposite) for negative backscatter scar (turbulent centerline)
  // or positive Kelvin wake crests
  let dir1Score = 0;
  let dir2Score = 0;

  for (let step = 8; step <= 24; step += 3) {
    const p1x = Math.round(cx + dir1X * step);
    const p1y = Math.round(cy + dir1Y * step);
    const p2x = Math.round(cx - dir1X * step);
    const p2y = Math.round(cy - dir1Y * step);

    if (p1x >= 0 && p1x < width && p1y >= 0 && p1y < height) {
      if (grid[p1y][p1x] < -20.5 || grid[p1y][p1x] > -13.0) dir1Score++;
    }
    if (p2x >= 0 && p2x < width && p2y >= 0 && p2y < height) {
      if (grid[p2y][p2x] < -20.5 || grid[p2y][p2x] > -13.0) dir2Score++;
    }
  }

  if (dir1Score >= 3 && dir1Score > dir2Score + 1) {
    // Wake is trailing along dir1 -> vessel is heading in opposite direction dir2
    const heading = (axisDeg + 180) % 360;
    return { visible: true, heading };
  } else if (dir2Score >= 3 && dir2Score > dir1Score + 1) {
    // Wake trailing dir2 -> vessel heading dir1
    return { visible: true, heading: axisDeg };
  }

  return { visible: false };
}
