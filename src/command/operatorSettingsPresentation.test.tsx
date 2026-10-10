import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderHealthEntry } from '../api/contract';
import { store } from '../state/store';
import type { OperatorPreferences } from '../api/operatorSettings';
import { ProviderHealthRow, SystemKeyboardReference, SystemProvenanceStatus } from './SystemPanel';

describe('settings must never suppress critical source truth', () => {
  it('all three optional presentation preferences OFF keeps unavailable reason and mandatory provenance visible', () => {
    const allOff: OperatorPreferences = {
      show_provider_details: false,
      show_keyboard_reference: false,
      show_provenance_summary: false,
    };
    const failed: ProviderHealthEntry = {
      provider: 'SAR sensor', status: 'UNAVAILABLE',
      detail: 'Provider returned HTTP 503; no observations verified.',
      last_check: '2026-10-11T05:00:00Z',
    } as ProviderHealthEntry;
    const healthy: ProviderHealthEntry = {
      provider: 'Static provider', status: 'AVAILABLE',
      detail: 'Optional healthy provider explanatory text',
      last_check: '2026-10-11T05:00:00Z',
    } as ProviderHealthEntry;
    const session = { ...store.getState(), scanId: 'KNOWN-SCAN', scanStage: 'COMPLETE' as const,
      rasterLoaded: false, rasterError: 'source raster absent' };
    const html = renderToStaticMarkup(<>
      <ProviderHealthRow provider={failed} showOptionalDetails={allOff.show_provider_details} />
      <ProviderHealthRow provider={healthy} showOptionalDetails={allOff.show_provider_details} />
      <SystemKeyboardReference visible={allOff.show_keyboard_reference} />
      <SystemProvenanceStatus session={session}
        showSupplementary={allOff.show_provenance_summary} />
    </>);
    expect(html).toContain('UNAVAILABLE');
    expect(html).toContain('HTTP 503; no observations verified.');
    expect(html).toContain('AVAILABLE');
    expect(html).not.toContain('Optional healthy provider explanatory text');
    expect(html).not.toContain('data-df-keyboard-reference');
    expect(html).toContain('data-df-provenance-mandatory');
    expect(html).toContain('KNOWN-SCAN');
    expect(html).toContain('COMPLETE');
    expect(html).toContain('Raster');
    expect(html).toContain('unavailable');
    expect(html).not.toContain('data-df-provenance-supplement');
  });
});
