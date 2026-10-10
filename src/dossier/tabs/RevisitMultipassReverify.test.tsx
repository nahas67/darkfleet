import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselTarget } from '../../api/contract';

const states = vi.hoisted(() => ({
  revisit: { status: 'loading' } as { status: string; reason?: string; value?: unknown },
  multipass: { status: 'loading' } as { status: string; reason?: string; value?: unknown },
}));
vi.mock('../useTabData', () => ({
  useTabData: () => states.revisit,
  useArchiveData: () => states.multipass,
}));

import { RevisitTab } from './RevisitTab';
import { MultipassTab } from './MultipassTab';

const target = { id: 'DF-001', lat: 1.25, lon: 103.8 } as unknown as VesselTarget;
const targetRef = { scanId: 'SCAN-1', targetId: 'DF-001' };

function revisit(): string {
  return renderToStaticMarkup(<RevisitTab targetRef={targetRef} target={target} />);
}
function multipass(): string {
  return renderToStaticMarkup(<MultipassTab target={target} />);
}

beforeEach(() => {
  states.revisit = { status: 'loading' };
  states.multipass = { status: 'loading' };
});

describe('mounted dossier evidence tabs', () => {
  it('renders distinct loading and failure states without fabricated catalogue evidence', () => {
    expect(revisit()).toContain('revisit plan');
    expect(multipass()).toContain('multi-pass tracks');
    states.revisit = { status: 'failed', reason: 'Catalogue timeout' };
    states.multipass = { status: 'failed', reason: 'Archive unavailable' };
    expect(revisit()).toContain('Catalogue timeout');
    expect(multipass()).toContain('Archive unavailable');
    expect(revisit()).not.toContain('Real catalogue acquisitions');
  });

  it('keeps zero acquisitions distinct from provider failure and never invents nominal cadence', () => {
    states.revisit = {
      status: 'ready',
      value: {
        acquisition_count: 0, acquisitions: [], gaps: [],
        provider: 'earthsearch', collection: 'sentinel-1-grd',
        requested_bbox: [179.985, 1.24, -179.995, 1.26],
        window: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
        statistics: { median_revisit_days: null, min_revisit_days: null, max_revisit_days: null, nominal_repeat_days: 12 },
        next_after: null, limitations: ['Only catalogue evidence was queried.'],
      },
    };
    const html = revisit();
    expect(html).toContain('ZERO CATALOGUE ACQUISITIONS');
    expect(html).toContain('NOT ESTABLISHED');
    expect(html).toContain('ORBIT-DERIVED');
    expect(html).toContain('179.985, 1.24, -179.995, 1.26');
    expect(html).toContain('2026-09-01T00:00:00Z');
    expect(html).not.toContain('Catalogue timeout');
  });

  it('shows actual archive emptiness and marks geometric proximity as unproven identity', () => {
    states.multipass = {
      status: 'ready',
      value: {
        scans_considered: 3, observations_considered: 5, track_count: 0, tracks: [],
        note: 'Track hypotheses only.',
      },
    };
    expect(multipass()).toContain('NO HYPOTHESIS AT THIS POSITION');
    expect(multipass()).toContain('near this position');
    expect(multipass()).toContain('Proximity alone');
  });
});
