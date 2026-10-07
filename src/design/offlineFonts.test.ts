import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const html = () => readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const css = () => readFileSync(resolve(ROOT, 'src/design/tokens.css'), 'utf8');
const types = () => readFileSync(resolve(ROOT, 'src/design/tokens.ts'), 'utf8');

/** A captured request that the product did not declare must never be shipped as a silent font dependency. */
describe('local-first typography', () => {
  it('the actual application shell loads no external font stylesheet or font preconnect', () => {
    // Re-adding the old Google Fonts stylesheet must fail. A browser request census separately
    // covers dynamic runtime loading; this guards the literal shell that caused five attempts.
    expect(html()).not.toMatch(/https?:\/\/(?:fonts\.googleapis|fonts\.gstatic)\.com/i);
    expect(html()).not.toMatch(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i);
  });

  it('label, body and telemetry stacks start with local/system families in CSS and TS', () => {
    for (const source of [css(), types()]) {
      expect(source).not.toMatch(/Barlow Condensed|Roboto Condensed|JetBrains Mono|\bInter\b/);
      expect(source).toContain('system-ui');
      expect(source).toContain('ui-monospace');
    }
  });
});
