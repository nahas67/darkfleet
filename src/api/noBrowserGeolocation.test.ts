/**
 * No coordinate arithmetic anywhere in `src/`.
 *
 * GEO-CORR established one authority for pixel -> WGS84:
 *
 *     backend geolocation.pixel_to_wgs84
 *
 * Everything this file defends follows from that being true. A browser-side
 * affine, a hand-rolled UTM inverse, or even a "just for the hover readout"
 * shortcut would each produce a coordinate disagreeing with the backend by some
 * amount nobody measures -- and it would disagree SILENTLY, next to real
 * detections, which is the precise failure mode this product exists to avoid.
 *
 * Testing that the current probe client is correct would not help much: the risk
 * is not this file being wrong, it is a LATER file adding a second answer. So
 * these tests scan the whole frontend source for the arithmetic itself.
 *
 * Presentation geometry is explicitly allowed and explicitly distinguished: a
 * screen coordinate, a zoom factor, a canvas layout, a fraction of a container's
 * width. None of those turn a SAR pixel into an earth position.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** Source with comments and string literals stripped, so prose cannot trip a pattern. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

const files = sourceFiles();

/**
 * The guard must not scan itself.
 *
 * Its own docstrings and pattern literals contain the very strings it hunts for
 * ("affine", "EPSG:32648", "0.5"), so including it made the gate fail on its own
 * prose -- which is how a guard gets quietly disabled rather than fixed.
 */
const SCANNED = files.filter((f) => !f.endsWith(join('api', 'noBrowserGeolocation.test.ts')));

/**
 * Production modules only.
 *
 * A test fixture may legitimately contain a CRS identifier or backend values,
 * because asserting "the response carries EPSG:32648" requires writing one down.
 * A shipped module has no such need: the browser is handed a coordinate, never a
 * projection to convert. So the identifier check applies to production code, and
 * the arithmetic check applies to everything.
 */
const PRODUCTION = SCANNED.filter((f) => !/\.test\.tsx?$/.test(f));

describe('the frontend has no geolocation implementation', () => {
  it('found the source tree to scan', () => {
    // If this fails, every assertion below would pass vacuously.
    expect(SCANNED.length).toBeGreaterThan(20);
  });

  it('declares no affine transform', () => {
    // The six coefficients of an affine, applied by hand. This is the shape a
    // copy of the backend's transform math would take.
    const offenders = SCANNED.filter((f) => {
      const src = code(f);
      return /\baffine\b/i.test(src) || /\bAffineLike\b/.test(src);
    });
    expect(offenders, `affine maths in ${offenders.join(', ')}`).toEqual([]);
  });

  it('declares no pixel-to-projected-coordinate helper', () => {
    // x = a*col + b*row + c  is the backend's own formula. Any equivalent in the
    // frontend is a second authority even under a different variable name.
    const offenders = SCANNED.filter((f) => {
      const src = code(f);
      return (
        /\bpixelTo[A-Z]/.test(src) ||
        /\bpixel_to_wgs84\b/.test(src) ||
        /\btransform_wgs84\b/.test(src) ||
        /\b(col|column)\s*\*\s*\d+(\.\d+)?\s*\+/.test(src) ||
        /\b(row)\s*\*\s*-?\d+(\.\d+)?\s*\+/.test(src)
      );
    });
    expect(offenders, `pixel->projected maths in ${offenders.join(', ')}`).toEqual([]);
  });

  it('declares no projected-CRS inverse', () => {
    // Checked against the RAW source, not the comment/string-stripped version.
    //
    // A second authority would necessarily name its CRS, and that name lives in
    // a STRING -- so stripping strings before scanning hid exactly the evidence
    // worth looking for. A mutation check caught this: an injected hand-rolled
    // UTM inverse containing 'EPSG:32648' passed the stripped scan silently.
    const offenders = SCANNED.filter((f) => {
      const raw = readFileSync(f, 'utf8');
      const src = code(f);
      // A CRS *name* in a fixture is fine -- asserting the backend echoed
      // EPSG:32648 requires writing it down. CRS *maths* is not fine anywhere.
      const isTest = /\.test\.tsx?$/.test(f);
      return (
        /\butm\b/i.test(src) ||
        /\butmNorthing\b/i.test(src) ||
        /\butmZoneFrom/i.test(src) ||
        /\blatLonToUtm\b/i.test(src) ||
        /\btransverseMercator\b/i.test(src) ||
        /\bWebMercator\b/i.test(src) ||
        /\bgeodeticToEasting\b/i.test(src) ||
        /\+proj=/i.test(raw) ||
        (!isTest && /\bEPSG:\d{4,5}\b/i.test(raw))
      );
    });
    expect(offenders, `projected CRS maths in ${offenders.join(', ')}`).toEqual([]);
  });

  it('names no projected CRS identifier in production code', () => {
    // Scoped to PRODUCTION, not to every file.
    //
    // A test fixture may legitimately write 'EPSG:32648' down, because asserting
    // that the backend echoed its own CRS requires the value to appear
    // somewhere. A shipped module has no such need: the browser is handed a
    // coordinate, never a projection to convert. So the identifier is forbidden
    // in production code and permitted in tests, which is the distinction that
    // keeps the gate meaningful instead of merely annoying.
    const offenders = PRODUCTION.filter((f) => /\bEPSG:32\d{3}\b/.test(readFileSync(f, 'utf8')));
    expect(
      offenders,
      `projected CRS identifier in production code: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('declares no AOI-based coordinate interpolation', () => {
    // The GEO-001 defect: deriving a position by interpolating inside the
    // requested bbox rather than by transforming a pixel.
    const offenders = SCANNED.filter((f) => {
      const src = code(f);
      return (
        /interpolat\w*\(.*(bbox|aoi)/i.test(src) ||
        /(bbox|aoi)\w*\s*\.\s*map\(.*=>.*\/\s*(4|2)\b/.test(src)
      );
    });
    expect(offenders, `AOI interpolation in ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('the probe client is a pass-through, not an authority', () => {
  it('contains no arithmetic beyond building the request body', () => {
    const src = code(join(SRC, 'api', 'probe.ts'));
    // One interpolation for the scan id in the URL is fine. Arithmetic on a
    // coordinate is not.
    expect(src).not.toMatch(/0\.5/);
    expect(src).not.toMatch(/\bMath\.(round|floor|ceil)\b/);
    expect(src).not.toMatch(/\*/);
  });

  it('takes the coordinate from the response, not from its arguments', async () => {
    const { probePixel } = await import('../api/probe');
    // The function returns whatever the backend said. It has no way to
    // manufacture a coordinate: its return value is the parsed response.
    const source = readFileSync(join(SRC, 'api', 'probe.ts'), 'utf8');
    expect(source).toMatch(/return api\.post<ProbeResponse>/);
    expect(source).not.toMatch(/return\s*\{\s*lat/);
  });
});

describe('presentation geometry remains allowed', () => {
  it('does not flag ordinary screen layout arithmetic', () => {
    // A false positive here would train everyone to ignore this gate, so the
    // patterns are checked against something that legitimately exists.
    const sample = `
      const left = rect.left + width * 0.5;
      const scale = containerWidth / rasterWidth;
      const zoom = 1 / (2 ** level);
    `;
    const patterns = [
      /\baffine\b/i,
      /\bpixelTo[A-Z]/,
      /\bUTM\b/,
      /\bEPSG:32\d{3}\b/,
    ];
    for (const pattern of patterns) {
      expect(pattern.test(sample)).toBe(false);
    }
  });

  it('the globe engine may still position Cesium entities', () => {
    // Cesium needs Cartesian3 positions in its own frame. That is presentation,
    // fed from coordinates the backend already produced.
    const offenders = SCANNED.filter((f) => /\bfromDegrees\b/.test(readFileSync(f, 'utf8')));
    for (const file of offenders) {
      // Allowed, but the argument must be a variable -- never an expression
      // that computes a longitude from a pixel.
      const src = code(file);
      expect(src).not.toMatch(/fromDegrees\([^)]*\*[^)]*\)/);
    }
  });
});