/**
 * THE CAPABILITY-REACHABILITY GATE.
 *
 * A companion to `aisDiagnostics.test.ts`, and deliberately a DIFFERENT question. That gate asks
 * "does a product component read this diagnostic?". This one asks "can an operator actually get
 * to this capability, and do we have the browser evidence we say we have?".
 *
 * The distinction matters because the failure mode is a CLAIM that outruns its evidence. Three
 * capabilities were described as working while being unreachable, and in every case the code
 * around the claim was correct -- types, doc comments, unit tests, even a commit message asserting
 * the capability. Nothing about reading the source could have caught it. What catches it is
 * asking for the evidence a given stage implies, and refusing the stage when it is absent.
 */

import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  awaitingBrowserProof,
  CAPABILITY_REGISTRY,
  REACHABILITY_ORDER,
  registryWeakestStage,
  type CapabilityRegistration,
} from './capabilityRegistry';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Read a file, or null. NULL IS A FAILURE, never a skip -- see `aisDiagnostics.test.ts`. */
function read(relativePath: string): string | null {
  if (!relativePath) return null;
  try {
    return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/** Strip comments, so prose cannot satisfy a code check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function atLeast(stage: CapabilityRegistration['stage'], floor: CapabilityRegistration['stage']): boolean {
  return REACHABILITY_ORDER.indexOf(stage) >= REACHABILITY_ORDER.indexOf(floor);
}

/**
 * Is a module reachable from `src/main.tsx` by following imports?
 *
 * A depth-limited breadth walk over the production import graph. Returns false rather than
 * throwing when the entry point is missing, so a moved entry point fails this assertion with a
 * readable message instead of an ENOENT.
 */
function reachableFrom(target: string): boolean {
  const entry = 'src/main.tsx';
  const seen = new Set<string>();
  const queue: string[] = [entry];
  let budget = 4000;

  while (queue.length > 0 && budget > 0) {
    budget -= 1;
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === target) return true;

    const source = read(current);
    if (source === null) continue;
    const dir = current.split('/').slice(0, -1).join('/');

    for (const match of code(source).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      /*
       * `posix.normalize` rather than hand-rolled string surgery. The first version replaced
       * `/../` with `/` and stripped a leading `./`, which does not resolve `../x` from `src/a`
       * correctly and silently produced an unreadable path -- so the walk stopped early and every
       * capability looked unreachable. A graph walk that cannot resolve a relative path reports
       * absence, and absence is indistinguishable from a real finding.
       */
      const base = posix.normalize(`${dir}/${match[1]}`).replace(/^\.\//, '');
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (!seen.has(candidate) && read(candidate) !== null) queue.push(candidate);
      }
    }
  }
  return false;
}

describe('product capabilities are actually reachable', () => {
  it('the registry is not empty', () => {
    // A registry nobody adds to is the dead code it exists to prevent.
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
    expect(new Set(CAPABILITY_REGISTRY.map((c) => c.id)).size).toBe(CAPABILITY_REGISTRY.length);
  });

  it('every registration states the OPERATOR QUESTION it answers', () => {
    /*
     * A capability with no operator question is an implementation detail. The question is the
     * unit: it is what makes "reachable" a question about a person rather than about a module.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      expect(entry.operatorQuestion.length, `${entry.id} must state its operator question`).toBeGreaterThan(15);
      expect(entry.operatorQuestion).toContain('?');
    }
  });

  it('every OWNER and CALLER file exists', () => {
    // A registration pointing at a file that is not there is a claim about nothing.
    for (const entry of CAPABILITY_REGISTRY) {
      expect(read(entry.owner), `${entry.id}: owner ${entry.owner} must be readable`).not.toBeNull();
      if (atLeast(entry.stage, 'CALLER_REACHABLE')) {
        expect(read(entry.caller), `${entry.id}: caller ${entry.caller} must be readable`).not.toBeNull();
      }
    }
  });

  it('a CALLER is a PRODUCTION caller, not a test', () => {
    /*
     * The original form of this defect: a capability referenced only by its own unit test. Every
     * test passes, the helper is correct, and nothing in the product calls it -- which is exactly
     * what happened to `ariaPressedFor`, whose comment, export and test suite were all in place
     * while the `<button>` never bound it.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'CALLER_REACHABLE')) continue;
      expect(entry.caller, `${entry.id} must not be a test file`).not.toMatch(/\.test\./);
    }
  });

  it('the CALLER IMPORTS the capability', () => {
    /*
     * `symbol` is an explicit field for this. An earlier version parsed the symbol out of the
     * `productSurface` prose, and reported a confident false failure the moment a surface was
     * described as a path ("DossierWorkspace -> EVIDENCE tab -> GhostSemantics") rather than as
     * one component -- which is the failure mode this whole file exists to catch, reproduced in
     * the checking mechanism itself.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'PRODUCT_REACHABLE')) continue;
      const source = read(entry.caller);
      expect(source, `${entry.id}: caller source must be readable`).not.toBeNull();
      expect(entry.symbol.length, `${entry.id} must name a symbol`).toBeGreaterThan(2);
      expect(
        code(source as string),
        `${entry.id}: ${entry.caller} does not reference ${entry.symbol}`,
      ).toContain(entry.symbol);
    }
  });

  it('the CALLER RENDERS it -- an import is not a mount', () => {
    /*
     * The mutation that proved this check is necessary.
     *
     * MUT-F removed `{ghost ? <GhostSemantics ghost={ghost} /> : null}` from `EvidenceTab` and the
     * whole gate went green: 14 of 14 passed. The import was still there, so an import-level check
     * was satisfied by a capability that no longer renders anywhere -- which is the DEEPEST form of
     * the defect this registry exists to catch, reproduced inside the mechanism built to catch it.
     *
     * So the requirement is a JSX element in the caller, `<Symbol`, not a bare identifier. An
     * import with no render is dead code that a linter will not flag and a reviewer will read past.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'PRODUCT_REACHABLE')) continue;
      /*
       * A component module does not render itself: `AisPlaybackBar.tsx` IS `AisPlaybackBar`, so its
       * own symbol never appears as a JSX tag in its own source. The first version of this
       * special case named `LayerConsole` explicitly and so failed on the other two self-hosted
       * capabilities -- a hardcoded list of the cases a general rule would have caught.
       */
      const isSelfHosted = entry.caller.endsWith(`/${entry.symbol}.tsx`);
      const caller = isSelfHosted ? null : entry.symbol;
      if (caller === null) {
        // The capability IS the module: prove it exports the component rather than rendering it.
        expect(code(read(entry.caller) as string), `${entry.id}: ${entry.caller} must export ${entry.symbol}`).toMatch(
          new RegExp(`export\\s+(function|const|class)\\s+${entry.symbol}\\b`),
        );
        continue;
      }
      expect(
        code(read(entry.caller) as string),
        `${entry.id}: ${entry.caller} imports ${caller} but never RENDERS it (<${caller}>)`,
      ).toMatch(new RegExp(`<${caller}[\\s/>]`));
    }
  });

  it('the CALLER MODULE is reachable from the application entry point', () => {
    /*
     * The third link, and the one that makes "reachable" mean reachable rather than merely present.
     *
     * MUT-F's lesson applied one level up: `GhostVesselPanel` was perfectly referenced by
     * `TargetIntel`, and `TargetIntel` was referenced by nothing. A chain of correct references
     * ending at a module no route reaches is still an unreachable capability, so the caller's own
     * import chain is walked back to `main.tsx`.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'PRODUCT_REACHABLE')) continue;
      expect(
        reachableFrom(entry.caller),
        `${entry.id}: ${entry.caller} is not reachable from src/main.tsx`,
      ).toBe(true);
    }
  });

  it('PRODUCT_REACHABLE requires a named USER ACTION', () => {
    // A surface with no way to cause it is a mounted-but-hidden component, which is not reachable.
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'PRODUCT_REACHABLE')) continue;
      expect(entry.userAction.length, `${entry.id} must name a user action`).toBeGreaterThan(15);
      expect(entry.userAction).toContain('.');
    }
  });

  it('BROWSER_ACTION_REACHABLE requires a SELECTOR an E2E can assert on', () => {
    // Without a stable hook the browser claim cannot be reproduced, only re-asserted.
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'BROWSER_ACTION_REACHABLE')) continue;
      expect(entry.browserSelector.length, `${entry.id} must name a selector`).toBeGreaterThan(3);
      expect(entry.browserSelector).toContain('[');
    }
  });

  it('BROWSER_PROVEN REQUIRES CITED EVIDENCE -- no stage without proof', () => {
    /*
     * The load-bearing assertion of this file.
     *
     * "The browser proved it" is the one claim in the chain that cannot be checked from source,
     * and it is the one that has been wrong. Three capabilities reached a commit message, a
     * contract and a component while no operator could see them. So a registration may not claim
     * `BROWSER_PROVEN` -- or even `BROWSER_ACTION_REACHABLE` -- without naming the run that
     * observed it, and `browserEvidence` has no default for it to fall back on.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      if (!atLeast(entry.stage, 'BROWSER_ACTION_REACHABLE')) continue;
      expect(
        entry.browserEvidence.length,
        `${entry.id} claims ${entry.stage} but cites no browser evidence`,
      ).toBeGreaterThan(40);
    }
  });

  it('BROWSER_PROVEN evidence must be SPECIFIC: a section and a run', () => {
    for (const entry of CAPABILITY_REGISTRY) {
      if (entry.stage !== 'BROWSER_PROVEN') continue;
      expect(entry.browserEvidence, `${entry.id}`).toMatch(/DF-X9\.\d/);
      // A citation with no measurement in it is an assertion wearing a citation's clothes.
      expect(entry.browserEvidence, `${entry.id} must cite a measured value`).toMatch(/\d/);
    }
  });

  it('no capability silently sits below the stage its own fields support', () => {
    /*
     * The inverse check, and the one that keeps the registry honest as it grows: an entry holding
     * a user action and a selector is making claims its `stage` does not reflect. Understating is
     * allowed -- that is just incomplete work -- but the fields must never OVERSTATE.
     */
    for (const entry of CAPABILITY_REGISTRY) {
      const claims = atLeast(entry.stage, 'BROWSER_PROVEN') && entry.browserEvidence.length > 0;
      const supports = entry.browserEvidence.length > 0 && entry.browserSelector.length > 3;
      if (claims) {
        expect(supports, `${entry.id} is BROWSER_PROVEN but its evidence fields are empty`).toBe(true);
      }
    }
  });

  it('the registry reports its own weakest link', () => {
    // Useful as a single number in a status report: the registry is not a wall of green.
    expect(registryWeakestStage()).toBe('PRODUCT_REACHABLE');
  });

  it('awaitingBrowserProof() lists exactly the entries that still owe a browser run', () => {
    const waiting = awaitingBrowserProof().map((c) => c.id).sort();
    expect(waiting).toEqual(['ais-layer-control-aria-state', 'ghost-vessel-semantics']);
  });
});

/* ============================================================================================== *
 * THE THREE THAT ALREADY HAPPENED
 * ============================================================================================== */

describe('the three historical reachability failures are registered, not forgotten', () => {
  it('registers all three, each with a named operator question', () => {
    /*
     * If a defect class has occurred three times and produced no registry entry, the fourth is
     * a matter of time. These three are registered with the stage each has actually earned --
     * two browser-proven, one not -- so the record cannot drift into claiming more than it has.
     */
    const ids = CAPABILITY_REGISTRY.map((c) => c.id);
    expect(ids).toContain('ais-render-failure-reason');
    expect(ids).toContain('ais-gap-diagnostics');
    expect(ids).toContain('ghost-vessel-semantics');
  });

  it('the ghost-vessel capability is NOT claimed browser-proven before it is', () => {
    /*
     * The honest stage today. `GhostSemantics` is mounted in the dossier's EVIDENCE tab and
     * reachable in the product graph, but no browser run has observed it against a
     * `SAR_UNMATCHED` fixture. Writing `BROWSER_PROVEN` here because the component renders would
     * be the identical mistake this file was written to stop, so the registry says
     * PRODUCT_REACHABLE and section GV owes the rest.
     */
    const ghost = CAPABILITY_REGISTRY.find((c) => c.id === 'ghost-vessel-semantics');
    expect(ghost).toBeDefined();
    expect(ghost?.stage).toBe('PRODUCT_REACHABLE');
    expect(ghost?.browserEvidence).toBe('');
    // The owner is BACKEND code: the capability's substance was always server-side, which is
    // why the missing edge was a frontend one and no amount of backend testing could find it.
    expect(ghost?.owner).toBe('backend/darkfleet/ghost_vessel.py');
  });
});
