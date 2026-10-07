import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = () => readFileSync(resolve(__dirname, 'TopStrip.tsx'), 'utf8');

describe('top status under the local font stack', () => {
  it('keeps provider health tokens intact and yields mission-id width first', () => {
    // At 1024px after removing remote condensed fonts, SAR UNAVAILABLE and AIS AVAILABLE
    // wrapped their final letter onto a second line. A prior-build screenshot shows they
    // were each one line. This source guard accompanies the responsive browser retest.
    const code = source().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/<div[^>]*whitespace-nowrap[^>]*data-df-counter=\{label\}/);
    expect(code).toMatch(/<span[^>]*truncate[^>]*data-df-mission/);
  });
});
