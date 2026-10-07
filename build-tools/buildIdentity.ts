/**
 * BUILD IDENTITY -- which commit this bundle is.
 *
 * ================================ WHY THIS EXISTS ================================
 *
 * DF-X9.4S invalidated a whole round of browser evidence because `dfbuild94` -- the
 * hand-synced snapshot the E2E served -- was four commits stale and corresponded to no commit at
 * all. Nothing failed. The harness built a page, opened it, measured it, and every number it
 * reported was about code that no longer existed.
 *
 * That failure mode has no signature. A stale build does not error, does not warn, and produces
 * perfectly well-formed measurements. The only defence is to make the answer to "which commit is
 * the browser testing?" a thing the browser can simply READ, and then refuse to run when the
 * answer is not the expected one.
 *
 * ================================ WHAT IS EXPOSED, AND WHY IT IS NOT PRODUCT CODE ================================
 *
 * `<meta>` tags in `index.html`. Not a runtime API, not a global, not a debug endpoint:
 *
 *   - a global on `window` invites product code to branch on build identity, which is how a
 *     provenance marker becomes a feature flag;
 *   - a debug endpoint means running a server to ask what is already in the HTML;
 *   - a meta tag is inert. Nothing reads it except a test harness, and it survives minification
 *     because it is not JavaScript.
 *
 * The bundle digest CANNOT be a meta tag: a file cannot contain the hash of itself. So it is
 * emitted as `build-manifest.json` after the bundle is written, hashed over every emitted file
 * EXCEPT the manifest. That is what lets browser evidence name exactly what it measured.
 *
 * No secret is exposed. A commit SHA, a timestamp and a content digest are public facts about a
 * public repository; nothing here reads the environment, the network, or the filesystem beyond
 * git metadata in `.git`.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Plugin } from 'vite';

/** The identity a build carries. Field names are the meta-tag suffixes, lowercased. */
export interface BuildIdentity {
  /** `git rev-parse HEAD`, or `UNKNOWN` outside a repository. */
  readonly head: string;
  /** `true` when the working tree had modifications when the build started. */
  readonly dirty: boolean;
  /** ISO-8601, UTC. */
  readonly builtAt: string;
  /** SHA-256 of `src/api/contract.ts`, so a contract change is visible even if the commit does not move. */
  readonly contractHash: string;
  /** Vite's resolved mode. */
  readonly mode: string;
}

/** Run a git command, returning null rather than throwing. A build must not fail for provenance. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

export function readBuildIdentity(rootDir: string, mode: string): BuildIdentity {
  const head = git(['rev-parse', 'HEAD']) ?? 'UNKNOWN';
  const status = git(['status', '--porcelain']);
  const dirty = status === null ? false : status.length > 0;

  let contractHash = 'UNKNOWN';
  try {
    contractHash = createHash('sha256')
      .update(fs.readFileSync(path.join(rootDir, 'src', 'api', 'contract.ts')))
      .digest('hex')
      .slice(0, 16);
  } catch {
    /* left as UNKNOWN: a missing contract is a build error elsewhere, not here */
  }

  return { head, dirty, builtAt: new Date().toISOString(), contractHash, mode };
}

/** Escape a value for an HTML attribute. Identity strings are hashes and ISO dates, but be exact. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Injects build identity into `index.html` and emits `build-manifest.json` over the bundle.
 *
 * `strict` is what makes staleness IMPOSSIBLE TO IGNORE rather than merely recorded:
 * `DF_REQUIRE_CLEAN_TREE=1` fails the build outright on a dirty tree, so a verification build
 * cannot be produced from uncommitted source in the first place.
 */
export function darkfleetBuildIdentity(options: { rootDir: string; strict?: boolean }): Plugin {
  const { rootDir, strict = false } = options;
  let identity: BuildIdentity | null = null;

  return {
    name: 'darkfleet-build-identity',
    apply: 'build',

    buildStart() {
      identity = readBuildIdentity(rootDir, process.env.NODE_ENV ?? 'production');

      if (identity.head === 'UNKNOWN') {
        // Not fatal. A source tarball has no git and still produces a working build; the harness
        // will simply have nothing to compare against and must say so.
        this.warn('darkfleet-build-identity: not a git repository; HEAD is UNKNOWN');
      } else if (identity.dirty && strict) {
        // The whole point of §7-§13: a browser verification build must be a committed commit. A
        // dirty tree means the served bytes differ from the commit, so "which commit is this?" has
        // no answer and the build is refused rather than labelled.
        this.error(
          `darkfleet-build-identity: refusing to build from a DIRTY tree with strict identity.\n`
          + `  HEAD ${identity.head} has uncommitted modifications.\n`
          + `  Commit them, or unset DF_REQUIRE_CLEAN_TREE to build anyway (the build will be `
          + `recorded as dirty and a freshness gate must reject it).`,
        );
      }
    },

    transformIndexHtml(html) {
      if (identity === null) identity = readBuildIdentity(rootDir, 'production');
      const tags = [
        ['darkfleet-build-head', identity.head],
        ['darkfleet-build-dirty', String(identity.dirty)],
        ['darkfleet-build-at', identity.builtAt],
        ['darkfleet-contract-hash', identity.contractHash],
        ['darkfleet-build-mode', identity.mode],
      ]
        .map(([name, value]) => `    <meta name="${name}" content="${attr(value)}" />`)
        .join('\n');

      return html.replace('</head>', `    <!-- darkfleet-build-identity: read by the browser verification harness. Inert. -->\n${tags}\n  </head>`);
    },

    /*
     * `writeBundle` runs after every file is on disk, which is the only moment the bundle can be
     * hashed. The manifest covers every emitted file EXCEPT itself -- a file cannot contain its
     * own digest -- and the file list is sorted so the digest is stable across machines.
     */
    async writeBundle(options, bundle) {
      if (identity === null) identity = readBuildIdentity(rootDir, 'production');

      const outDir = options.dir ?? path.join(rootDir, 'dist');
      const files = Object.keys(bundle)
        .filter((name) => name !== 'build-manifest.json')
        .sort();

      const digest = createHash('sha256');
      for (const name of files) {
        const filePath = path.join(outDir, name);
        if (!fs.existsSync(filePath)) continue;
        digest.update(name);
        digest.update(fs.readFileSync(filePath));
      }

      const manifest = {
        ...identity,
        bundleDigest: digest.digest('hex'),
        files,
      };

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'build-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}
