import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = () =>
  readFileSync(resolve(__dirname, 'TacticalWorld.tsx'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

/**
 * DF-X9.6 S57: manual camera motion must release FOLLOW.
 *
 * The controller's moveStart/input subscriptions bind to the LIVE camera object.
 * They were attached in an effect that runs BEFORE the engine.init effect, while
 * `engine.#viewer` is still null -- so every camera port returned a noop
 * unsubscriber, `attached` latched true on four noops, and no manual gesture
 * ever released follow again (reproduced 3/3 live-browser runs: zoom moves the
 * camera, FOLLOW stays TRACKING). Effects run in declaration order on mount, so
 * "declared after" is not "runs after": the attach call must textually follow
 * `engine.init` inside the SAME effect, where the viewer provably exists.
 */
describe('camera owner attach ordering (S57)', () => {
  it('attaches only after the viewer exists, at exactly one call site', () => {
    const code = source();
    const initAt = code.indexOf('engine.init(container');
    const attachAt = code.indexOf('aisCamera.attach()');
    expect(initAt).toBeGreaterThanOrEqual(0);
    expect(attachAt).toBeGreaterThan(initAt);
    expect(code.indexOf('aisCamera.attach()', attachAt + 1)).toBe(-1);
  });

  it('detaches when the globe view unmounts so counts return to baseline', () => {
    const code = source();
    expect(code).toContain('aisCamera.detach()');
  });
});
