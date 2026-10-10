import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdvancedWorkspace } from './AdvancedWorkspace';

describe('Advanced workspace tab reachability', () => {
  it('renders Local GeoTIFF among eight horizontally scrollable, nonshrinking tabs', () => {
    const html = renderToStaticMarkup(<AdvancedWorkspace bbox={null} />);
    expect(html).toContain('data-df-advanced-workspace');
    expect(html).toContain('df-scroll-x');
    expect(html).toContain('overflow-x-auto');
    expect(html.match(/data-df-advanced-tab=/g)).toHaveLength(8);
    expect(html).toContain('data-df-advanced-tab="LOCAL_SAR"');
    expect(html).toContain('Local GeoTIFF');
    expect(html).toContain('shrink-0 whitespace-nowrap');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="advanced-panel-REVISIT"');
    expect(html).toContain('aria-labelledby="advanced-tab-REVISIT"');
    expect(html).toContain('aria-controls="advanced-panel-REVISIT"');
    // No dangling aria-controls references to an unmounted/inactive panel.
    expect(html).not.toContain('aria-controls="advanced-panel-LOCAL_SAR"');
  });
});
