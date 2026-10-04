/**
 * SAR -- the analytical imagery behind this detection.
 *
 * This tab deliberately does NOT build a second analytics viewer. DF-X6C already
 * has a raster viewer with fit/zoom/pan/opacity, a layer table, a pixel probe and
 * a CFAR lab, and duplicating any of it would produce two viewers that disagree.
 * What this tab does is the part a viewer cannot do: answer "which pixels produced
 * this target" and hand off to the workspace that can interrogate them.
 *
 * EVERY IMAGE IS A REAL PIPELINE LAYER
 *
 * Nothing here is drawn in the browser from the target record. The chips are
 * fetched from the raster endpoints, which serve the same arrays the detector
 * consumed. A canvas-rendered approximation of a target would look like evidence
 * and be a picture of nothing.
 *
 * PROVENANCE IS REPRODUCIBILITY, NOT FILLER
 *
 * The geolocation fields are shown so a reader can reproduce the coordinate
 * independently: the sub-pixel centroid, the pixel-centre offset, the scene CRS.
 * The dossier does NOT redo the pixel-to-geographic transform -- the geolocation
 * authority is one implementation and a second one in the browser would be a
 * second answer to the same question.
 */

import { useCallback, useState } from 'react';

import { api } from '../../api/errors';
import type { ScanScene, VesselTarget } from '../../api/contract';
import { measurement, text } from '../format';
import {
  AbsentText,
  Empty,
  Maybe,
  Pill,
  Provenance,
  Row,
  SectionTitle,
  SubTitle,
} from '../primitives';
import { store, useStoreSelector } from '../../state/store';

/**
 * The layers worth showing beside a target, in pipeline order.
 *
 * Pipeline order rather than visual order, because the question an analyst asks is
 * "what did each stage do to this", and that is a sequence.
 */
const LAYERS = [
  { id: 'raw', label: 'RAW', note: 'As delivered by the provider, before any processing.' },
  { id: 'normalized', label: 'NORMALIZED', note: 'After radiometric and thermal handling.' },
  { id: 'filtered', label: 'FILTERED', note: 'After speckle filtering. This is what detection consumed.' },
  { id: 'landmask', label: 'LAND MASK', note: 'Land and coastline exclusion applied before detection.' },
  { id: 'cfar', label: 'CFAR', note: 'Constant-false-alarm thresholding.' },
  { id: 'detection', label: 'DETECTION MASK', note: 'Pixels that became components.' },
] as const;

export function SarTab({ target, scene }: { target: VesselTarget; scene: ScanScene | null }) {
  const scanId = useStoreSelector((s) => s.scanId);
  const [layer, setLayer] = useState<string>('filtered');
  const [chip, setChip] = useState<{ url: string; failed: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const centroid = target.geoPixelCentroid ?? null;
  const hasAnchor = centroid !== null && centroid.length >= 2;

  const loadChip = useCallback(async () => {
    if (scanId === null) return;
    setLoading(true);
    try {
      // The raster image endpoint serves a real layer as an image. It is fetched
      // here only to prove the layer exists and to give the operator something to
      // look at; the analytical reading happens in DF-X6C.
      const blob = await api.get<Blob>(
        `/api/scans/${encodeURIComponent(scanId)}/raster/${encodeURIComponent(layer)}/image`,
      );
      setChip({ url: URL.createObjectURL(blob), failed: false });
    } catch {
      setChip({ url: '', failed: true });
    } finally {
      setLoading(false);
    }
  }, [scanId, layer]);

  const openInAnalytics = useCallback(() => {
    /*
     * The analytics workspace already follows the GLOBAL selection (DF-X6C has a
     * "follow global selection into workspace" effect). So the correct handoff is
     * to move to that workspace, not to push a second copy of the target into it.
     * Pushing would create exactly the tab-local selection §41 forbids.
     */
    store.set({ workspace: 'ANALYTICS' });
  }, []);

  return (
    <div data-df-tab="SAR" className="space-y-2">
      <div className="flex flex-wrap gap-1">
        <button type="button" className="df-btn text-[10px]" onClick={openInAnalytics} data-df-open-analytics>
          Open in analytics
        </button>
        <button
          type="button"
          className="df-btn text-[10px]"
          onClick={() => store.set({ workspace: 'TACTICAL' })}
        >
          Focus on globe
        </button>
        <button
          type="button"
          className="df-btn text-[10px]"
          onClick={loadChip}
          disabled={loading || !hasAnchor}
          data-df-probe-centroid
        >
          {loading ? 'Loading layer…' : 'Load layer image'}
        </button>
      </div>

      <div>
        <SectionTitle>Detection</SectionTitle>
        <Row label="SAR confidence">
          <span className="df-num">{target.sarConf.toFixed(3)}</span>
        </Row>
        <Row label="Footprint L×W">
          <span className="df-num">
            {target.lenM}×{target.widM} m
          </span>
        </Row>
        <Row label="Length uncertainty">
          <Maybe value={measurement(target.lenUncM, { digits: 0, unit: 'm' })} />
        </Row>
        <Row label="Orientation">
          <Maybe value={measurement(target.hdg, { digits: 1, unit: 'deg' })} />
        </Row>
        <Row label="Mean backscatter">
          <span className="df-num">{target.meanDb.toFixed(2)} dB</span>
        </Row>
        <Row label="Max backscatter">
          <span className="df-num">{target.maxDb.toFixed(2)} dB</span>
        </Row>
        <Row label="Area">
          <span className="df-num">{target.area ?? 'NOT ESTABLISHED'}</span>
        </Row>
      </div>

      <div>
        <SubTitle>Analytical layers, in pipeline order</SubTitle>
        <div className="df-scroll-x flex gap-1 pb-1">
          {LAYERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setLayer(entry.id)}
              aria-pressed={layer === entry.id}
              className={`shrink-0 border px-1.5 py-[2px] text-[10px] uppercase ${
                layer === entry.id ? 'border-info text-ink' : 'border-structural text-ink-dim'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="pt-1 text-[10px] leading-tight text-ink-dim">
          {LAYERS.find((entry) => entry.id === layer)?.note}
        </div>
      </div>

      <div>
        <SubTitle>Layer image</SubTitle>
        {!hasAnchor ? (
          <Empty
            heading="NO ANALYTICAL ANCHOR"
            detail="This target has no sub-pixel centroid, so it cannot be located in the window raster. A target without an anchor is not placed at the raster corner as a fallback."
          />
        ) : chip?.failed ? (
          <Empty
            heading="LAYER UNAVAILABLE"
            detail="The raster layer could not be read for this scan. The analytical workspace may still be able to load it."
          />
        ) : chip?.url ? (
          <img
            src={chip.url}
            alt={`${layer} layer for ${target.id}`}
            className="max-h-64 w-full border border-structural object-contain"
            data-df-layer-image={layer}
          />
        ) : (
          <Empty
            heading="NOT LOADED"
            detail="Layer images are fetched on request rather than eagerly: eleven tabs all fetching 400x400 rasters would be a large, immediately discarded transfer."
          />
        )}
      </div>

      <Provenance label="Reproducibility">
        <Row label="Scan ID">
          <Maybe value={text(scanId)} />
        </Row>
        <Row label="Scene ID">
          <Maybe value={text(scene?.item_id ?? null)} />
        </Row>
        <Row label="Source CRS">
          <Maybe value={text(scene?.crs ?? null)} />
        </Row>
        <Row label="Resolution">
          <Maybe value={measurement(scene?.resolution_m ?? null, { digits: 2, unit: 'm' })} />
        </Row>
        <Row label="geoPixelCentroid">
          {/* The analytical anchor. Shown so a reader can reproduce the coordinate;
              the transform itself is NOT redone here. */}
          {centroid ? (
            <span className="df-num">
              [{centroid[0]}, {centroid[1]}]
            </span>
          ) : (
            <AbsentText reason="NOT_ESTABLISHED" />
          )}
        </Row>
        <Row label="Pixel centre offset">
          <Maybe value={measurement(target.geoCentreOffset ?? null, { digits: 3 })} />
        </Row>
        <Row label="WGS84 coordinate">
          <span className="df-num">
            {target.lat.toFixed(6)}, {target.lon.toFixed(6)}
          </span>
        </Row>
        <Row label="Detector">
          <Pill tone="neutral">SEE /detectors</Pill>
        </Row>
        <div className="pt-1 text-[10px] leading-tight text-ink-dim">
          The pixel-to-geographic transform is applied by the geolocation authority only. This tab
          reports its outputs; it does not reimplement it, because two implementations of one
          transform is two answers to the same question.
        </div>
      </Provenance>
    </div>
  );
}