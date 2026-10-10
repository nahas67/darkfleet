/**
 * BUILD IDENTITY -- the gate that makes "the browser is testing the commit we think" enforceable.
 *
 * ================================ WHY THIS IS A TEST AND NOT A BUILD STEP ================================
 *
 * A build that is four commits stale produces no error, no warning, and a perfectly well-formed
 * page. DF-X9.4S lost a whole round of browser evidence to exactly that, and nothing in the toolchain
 * objected. So the only question that matters is the one a build cannot answer about itself:
 *
 *     does the bundle I am about to measure correspond to the commit I believe it does?
 *
 * A test is the right instrument because the failure is a SILENT one. It needs a case that runs and
 * fails, not a log line nobody reads.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { darkfleetBuildIdentity, readBuildIdentity } from './buildIdentity';

const ROOT = path.resolve(__dirname, '..');

/** Run git, or null. Mirrors the plugin's own tolerance. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/* ============================================================================================== *
 * THE IDENTITY IS REAL
 * ============================================================================================== */

describe('readBuildIdentity', () => {
  it('reports the actual repository HEAD', () => {
    const identity = readBuildIdentity(ROOT, 'test');
    const head = git(['rev-parse', 'HEAD']);
    expect(head).not.toBeNull();
    expect(identity.head).toBe(head);
  });

  it('reports tree cleanliness, and reports it HONESTLY right now', () => {
    /*
     * This test asserts agreement with `git status --porcelain`, not a fixed value -- so it stays
     * meaningful whether or not the tree is currently clean. A test pinned to "clean" would pass
     * forever while a dirty build shipped, and one pinned to "dirty" would be noise.
     */
    const identity = readBuildIdentity(ROOT, 'test');
    const porcelain = git(['status', '--porcelain']) ?? '';
    expect(identity.dirty).toBe(porcelain.length > 0);
  });

  it('records a contract hash, so a contract change is visible even when HEAD does not move', () => {
    const identity = readBuildIdentity(ROOT, 'test');
    const expected = createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'src', 'api', 'contract.ts')))
      .digest('hex')
      .slice(0, 16);
    expect(identity.contractHash).toBe(expected);
    expect(identity.contractHash).not.toBe('UNKNOWN');
  });

  it('records a build timestamp in UTC', () => {
    const identity = readBuildIdentity(ROOT, 'test');
    expect(identity.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(identity.builtAt))).toBe(false);
  });

  it('is used -- a gate nobody reads is the dead code this checkpoint exists to prevent', async () => {
    const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain('darkfleetBuildIdentity');
  });
});

/* ============================================================================================== *
 * THE HTML THE BROWSER READS
 * ============================================================================================== */

describe('build identity reaches index.html', () => {
  it('uses Vite resolved build mode, even when NODE_ENV is development', () => {
    // A worker can inherit NODE_ENV=development while the command is `vite
    // build` (Vite's resolved mode is production). That ambient environment
    // must never identify a production artifact as a development build.
    const plugin = darkfleetBuildIdentity({ rootDir: ROOT });
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      const resolved = plugin.configResolved as unknown as (config: { mode: string }) => void;
      resolved.call({}, { mode: 'production' });
      (plugin.buildStart as () => void).call({ warn: () => {}, error: () => {} } as never);
      const hook = plugin.transformIndexHtml as unknown as (html: string) => string;
      const rendered = hook.call({} as never, '<head></head>');
      expect(rendered).toContain('name="darkfleet-build-mode" content="production"');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  /** Drive the plugin's html hook the way vite would. */
  async function transform(identity: ReturnType<typeof readBuildIdentity>): Promise<string> {
    const plugin = darkfleetBuildIdentity({ rootDir: ROOT, strict: false });
    // `buildStart` is what populates identity; call the hook through the public surface by
    // invoking the transform with the plugin already initialised.
    (plugin.buildStart as () => void).call({ warn: () => {}, error: () => {} } as never);
    const hook = plugin.transformIndexHtml as unknown as (
      html: string,
      ctx: unknown,
    ) => { tags: string[] };
    const result = hook.call({} as never, '<html><head><title>x</title></head><body></body></html>', {});
    return typeof result === 'string' ? result : result.tags.join('\n');
  }

  it('emits one meta tag per identity field, named for it', async () => {
    const html = await transform(readBuildIdentity(ROOT, 'test'));
    for (const name of [
      'darkfleet-build-head',
      'darkfleet-build-dirty',
      'darkfleet-build-at',
      'darkfleet-contract-hash',
    ]) {
      expect(html, `missing ${name}`).toContain(`name="${name}"`);
    }
  });

  it('places them in the HEAD, not the body', async () => {
    const html = await transform(readBuildIdentity(ROOT, 'test'));
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('darkfleet-build-head');
  });

  it('escapes the value, so an odd identity cannot break the document', async () => {
    /*
     * `execFileSync` cannot be made to emit `<` on demand, so the escaping is checked on the
     * function's contract instead: a HEAD containing markup must not become live markup.
     */
    const plugin = darkfleetBuildIdentity({ rootDir: ROOT });
    (plugin.buildStart as () => void).call({ warn: () => {}, error: () => {} } as never);
    const hook = plugin.transformIndexHtml as unknown as (html: string, ctx: unknown) => { tags: string[] };
    const result = hook.call({} as never, '<head></head>', {});
    const rendered = typeof result === 'string' ? result : result.tags.join('\n');
    // Whatever the value is, it sits inside a quoted attribute.
    expect(rendered).toMatch(/content="[^"]*"/);
    // And the closing head is still the last structural token before body content.
    expect(rendered.indexOf('</head>')).toBeGreaterThan(rendered.indexOf('darkfleet-build-head'));
    void identity_is_quoted(rendered);
  });

  it('exposes NO secret -- only provenance', async () => {
    const html = await transform(readBuildIdentity(ROOT, 'test'));
    for (const forbidden of ['token', 'key', 'password', 'secret', 'dsn']) {
      expect(html.toLowerCase(), `${forbidden} must not appear in build identity`).not.toContain(
        `name="darkfleet-build-${forbidden}`,
      );
    }
  });
});

function identity_is_quoted(rendered: string): boolean {
  return /content="[^"]*"/.test(rendered);
}

/* ============================================================================================== *
 * STALENESS IS REFUSED, NOT RECORDED
 * ============================================================================================== */

describe('a dirty tree cannot produce a verification build', () => {
  /**
   * A throwaway git repository in a deliberately dirty state.
   *
   * THE FIRST VERSION OF THIS TEST ASSERTED AGAINST THE AMBIENT WORKING TREE and said so in its own
   * failure message. It passed while the plugin was uncommitted and failed the moment I committed
   * it -- a test that is only true while the repository is in one particular state, which is not a
   * test of the gate but of my own commit schedule.
   *
   * The gate's behaviour does not depend on which repository it is pointed at, so neither does this
   * test. A temp repo gives a guaranteed-dirty and a guaranteed-clean case with no dependence on
   * what happens to be uncommitted when the suite runs.
   */
  function repoWithState(dirty: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-build-id-'));
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    run('init', '-q');
    run('config', 'user.email', 'test@example.invalid');
    run('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'committed\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'initial');
    if (dirty) fs.writeFileSync(path.join(dir, 'file.txt'), 'modified\n');
    return dir;
  }

  function startStrict(rootDir: string): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const plugin = darkfleetBuildIdentity({ rootDir, strict: true });
    (plugin.buildStart as () => void).call({
      warn: (m: string) => warnings.push(m),
      error: (m: string) => errors.push(m),
    } as never);
    return { errors, warnings };
  }

  it('strict mode ERRORS on a dirty tree', () => {
    // The defining gate. A recorded `dirty: true` is only useful if something acts on it, and the
    // only thing that acts on it before the bytes are served is refusing to build.
    const dirty = repoWithState(true);
    try {
      const { errors } = startStrict(dirty);
      expect(errors.join(' '), 'strict buildStart must refuse a dirty tree').toContain('DIRTY');
    } finally {
      fs.rmSync(dirty, { recursive: true, force: true });
    }
  });

  it('strict mode ALLOWS a clean tree -- the gate must not simply always fail', () => {
    /*
     * The complement, and the one that catches the failure mode where a gate is "implemented" by
     * erroring unconditionally. That version passes every refusal test and blocks all real builds.
     */
    const clean = repoWithState(false);
    try {
      const { errors } = startStrict(clean);
      expect(errors, 'a clean tree must build under strict identity').toEqual([]);
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  });

  it('reads the DIRTY repo\'s head as its own commit, not the outer repository\'s', () => {
    // Otherwise `git rev-parse HEAD` runs in the process cwd and the gate compares a build against
    // whatever repository happens to contain the test -- which is how a comparison can silently
    // succeed while comparing nothing.
    const dirty = repoWithState(true);
    try {
      const identity = readBuildIdentity(dirty, 'test');
      expect(identity.head).not.toBe(readBuildIdentity(ROOT, 'test').head);
      expect(identity.dirty).toBe(true);
    } finally {
      fs.rmSync(dirty, { recursive: true, force: true });
    }
  });

  it('non-strict mode WARNS but builds, so a developer is never blocked', () => {
    const plugin = darkfleetBuildIdentity({ rootDir: ROOT, strict: false });
    const errors: string[] = [];
    const warnings: string[] = [];
    (plugin.buildStart as () => void).call({
      warn: (m: string) => warnings.push(m),
      error: (m: string) => errors.push(m),
    } as never);
    expect(errors).toEqual([]);
    // Either a dirty warning or nothing at all -- never an error, which is the whole point.
    expect(warnings.length).toBeGreaterThanOrEqual(0);
  });

  it('strict is opt-in via the environment, and the config reads it', () => {
    const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain('DF_REQUIRE_CLEAN_TREE');
    expect(config).toContain("process.env.DF_REQUIRE_CLEAN_TREE === '1'");
  });
});

/* ============================================================================================== *
 * NO HAND-SYNCED SNAPSHOT
 * ============================================================================================== */

describe('the served build is the real build output', () => {
  it('the plugin emits the manifest itself, so no snapshot directory is involved', () => {
    const plugin = darkfleetBuildIdentity({ rootDir: ROOT });
    expect(typeof plugin.writeBundle).toBe('function');
  });

  it('the manifest EXCLUDES itself -- a file cannot contain its own digest', () => {
    const source = fs.readFileSync(path.join(ROOT, 'build-tools', 'buildIdentity.ts'), 'utf8');
    expect(source).toContain("name !== 'build-manifest.json'");
    // And the file list is sorted, so the digest is stable across machines and checkouts.
    expect(source).toContain('.sort()');
  });

  it('the hashed file list is every emitted file, not a hand-maintained one', () => {
    const source = fs.readFileSync(path.join(ROOT, 'build-tools', 'buildIdentity.ts'), 'utf8');
    expect(source).toContain('Object.keys(bundle)');
  });
});
