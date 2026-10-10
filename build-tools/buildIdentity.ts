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
 * emitted as `build-manifest.json` after ALL plugin asset-copy operations, hashed over every
 * physical emitted file EXCEPT the manifest (including Cesium's copied Workers/Assets tree).
 * That is what lets browser evidence name exactly what it measured.
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

/**
 * Run a git command IN `rootDir`, returning null rather than throwing.
 *
 * A build must not fail for provenance, so a missing git or a non-repository yields null rather
 * than throwing.
 *
 * `cwd: rootDir` is load-bearing and was WRONG in the first version, which ran git in
 * `process.cwd()` and accepted a `rootDir` it then ignored for the git calls only -- the contract
 * hash used it correctly, so the option looked honoured. It happens to be harmless today because
 * vite runs with cwd === rootDir, and it would silently misattribute a build the moment that stops
 * being true: the gate would compare a build against whatever repository contains the process.
 *
 * An accepted parameter that does nothing is the same defect shape as the exported-but-unbound
 * `ariaPressedFor` this checkpoint spent a day on, so it is worth naming rather than patching.
 */
function git(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

export function readBuildIdentity(rootDir: string, mode: string): BuildIdentity {
  const head = git(rootDir, ['rev-parse', 'HEAD']) ?? 'UNKNOWN';
  const status = git(rootDir, ['status', '--porcelain']);
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
  let resolvedMode = 'production';
  let resolvedOutDir = path.join(rootDir, 'dist');

  function allEmittedFiles(directory: string): string[] {
    const files: string[] = [];
    function walk(current: string, prefix: string): void {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(current, entry.name);
        // Do not follow copied links out of dist or attest to bytes we did not emit.
        if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in emitted build: ${relative}`);
        if (entry.isDirectory()) walk(absolute, relative);
        else if (entry.isFile()) {
          if (relative !== 'build-manifest.json') files.push(relative);
        } else throw new Error(`Unsupported emitted filesystem entry: ${relative}`);
      }
    }
    walk(directory, '');
    return files.sort();
  }

  return {
    name: 'darkfleet-build-identity',
    apply: 'build',

    configResolved(config) {
      // Vite --mode is the authority for which environment the emitted bundle
      // targets. NODE_ENV may be inherited as `development` even for `vite
      // build`, so reading it gave a real production bundle a false identity.
      resolvedMode = config.mode;
      // The production Vite config supplies both; unit tests also invoke the
      // resolved-mode hook with a deliberately minimal test configuration.
      if (config.root && config.build?.outDir) {
        resolvedOutDir = path.resolve(config.root, config.build.outDir);
      }
    },

    buildStart() {
      identity = readBuildIdentity(rootDir, resolvedMode);

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
      if (identity === null) identity = readBuildIdentity(rootDir, resolvedMode);
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
     * The Cesium plugin copies Assets/Workers/Widgets in closeBundle, AFTER the
     * Rollup writeBundle inventory is frozen. Our plugin is registered after
     * Cesium in vite.config.ts, so its closeBundle executes after that copy.
     * Hash the actual final physical dist tree, not Object.keys(bundle).
     * Omitting any copied asset would make a correct digest certify an incomplete
     * release; the verifier independently checks this exact tree coverage.
     */
    async closeBundle() {
      if (identity === null) identity = readBuildIdentity(rootDir, resolvedMode);
      const outDir = resolvedOutDir;
      if (!fs.existsSync(outDir)) throw new Error(`Missing output directory: ${outDir}`);
      const files = allEmittedFiles(outDir);
      if (!files.includes('index.html')) throw new Error('Missing index.html in emitted build');

      const digest = createHash('sha256');
      for (const name of files) {
        const filePath = path.join(outDir, ...name.split('/'));
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
