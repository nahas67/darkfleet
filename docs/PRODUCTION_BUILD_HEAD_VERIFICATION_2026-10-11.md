# Production build HEAD / preview verifier — 2026-10-11

## Purpose and authority

`build-tools/release_build_verifier.py` is a **read-only release gate** for the `darkfleetBuildIdentity` plugin in `build-tools/buildIdentity.ts`. It checks whether a running loopback Vite **preview** serves exactly the files emitted by a production build of the current clean Git revision. It never builds, starts processes, deletes `dist/`, pushes Git, changes application state, or writes report artifacts. It outputs structured JSON to stdout and exits with code **0 only on `VERIFIED`**; failures return code **1** with the exact failing checks.

Use Python 3.10+ (the verifier uses `Path.is_relative_to` and type unions) with no third-party Python dependencies. The regular release gate reads only the repository, built dist and local HTTP responses. The optional self-test creates and removes a temporary isolated Git repository and temporary loopback test HTTP server; it does not change DarkFleet's working tree or `dist/`.

## Identity requirements

All these conditions are mandatory and independently checked:

| Authority | Required property |
| --- | --- |
| Git | `git rev-parse HEAD` returns full 40-character SHA; `git status --porcelain` is empty throughout verification |
| On-disk `dist/index.html` | Unique `darkfleet-build-head`, `darkfleet-build-dirty`, `darkfleet-build-at`, `darkfleet-contract-hash`, `darkfleet-build-mode` meta tags |
| `dist/build-manifest.json` | Valid expected head, dirty JSON boolean, timestamp, 16-character contract hash, mode, 64-character SHA256 digest, sorted unique emitted files including `index.html` |
| HEAD identity | **Git HEAD = dist HTML HEAD = manifest HEAD = served preview HTML HEAD** |
| Clean and mode | Manifest `dirty=false`; built and served HTML `darkfleet-build-dirty=false`; source Git tree clean; manifest and both HTML modes `production` |
| Contract | `sha256(src/api/contract.ts)[:16]` = manifest `contractHash` = built HTML meta contract hash = served HTML meta contract hash |
| Timestamp | Manifest `builtAt` equals built and served HTML meta timestamp |
| Local digest | Recompute SHA-256 using the **exact buildIdentity.ts algorithm**: for each sorted emitted file, `hash.update(filename encoded as UTF-8)` followed by `hash.update(file bytes)`; `build-manifest.json` is excluded. Missing and unsafe manifest filenames are refused. Computed digest must equal manifest `bundleDigest` |
| Served artifact | Served HTML bytes equal `dist/index.html`; served manifest bytes equal `dist/build-manifest.json`; every listed bundle file's served bytes equal the corresponding local bytes |
| Stability | Git HEAD/worktree status, **every emitted dist file**, dist manifest and source contract remain unchanged through preview verification |

The verifier accepts only loopback HTTP URLs at the site root with an explicit port (`127.0.0.1`, `localhost`, or `::1`). It refuses redirects and proxy forwarding, bounds each HTTP response to the corresponding local file size, and fails if the preview is missing, stale, inaccessible, malformed, inconsistent, or serving a different application.

The digest follows the **emitted file list** recorded by the Vite plugin, not a recursive checksum of every file in `dist/`. This is the plugin's current coverage: additional copied Cesium/static files not present in the manifest are **outside its digest** and are not certified by this gate. That limitation would require an explicit change to build-identity producer code, which is outside this worker's assignment.

## Reproduce the verifier checks

In an existing terminal from the repository root:

```powershell
# Hermetic fixtures: positive clean release plus distinct negative cases.
python -B build-tools/release_build_verifier.py --self-test

# Check the existing dist and a PRE-EXISTING preview; starts nothing.
python -B build-tools/release_build_verifier.py --preview-url http://127.0.0.1:4174/
```

The final integration owner should first commit/resolve *all* intended application and documentation changes, verify an empty `git status --porcelain`, and then produce a clean strict production build. One suitable sequence, **after** the tree is clean, is:

```powershell
$env:DF_REQUIRE_CLEAN_TREE = '1'
$env:NODE_ENV = 'production'
npm run build

# In another terminal: keep this preview process running.
npm run preview -- --host 127.0.0.1 --port 4174 --strictPort

# In a third terminal (or first terminal while preview runs):
python -B build-tools/release_build_verifier.py --preview-url http://127.0.0.1:4174/
```

Do not assume that a build produced during uncommitted worker changes represents the final release. Preserve the strict build failure if the tree is dirty. The verifier does not perform deployment and does not authenticate a remote hosted deployment; it proves the local preview's relationship to the local clean artifact only.

## Verification evidence and current status

The isolated tests exercise an actual temporary Git commit and loopback HTTP server for the successful path and deliberate negative cases for dirty Git/source, dirty manifest, stale built HTML HEAD, mismatching source contract, mutated emitted asset digest, **a file changing during verification**, stale served asset, stale served HTML HEAD, stale preview manifest, connection refusal, duplicated build meta, filename traversal, and non-loopback URL. Test outcomes are reported by the `--self-test` invocation; fixture success cannot substitute for a clean production run against DarkFleet.

**Current production release gate: NOT VERIFIED.** During this worker task, `git status --short --branch` showed concurrent frontend modifications and uncommitted prime documents. The existing `dist/build-manifest.json` reported `dirty=true`, with a development-mode build produced amid moving Git HEADs. The verifier's direct release check exited **1** and explicitly reported a dirty Git tree, manifest/HTML dirty flags, development mode, and an unreachable preview at `127.0.0.1:4174` (`WinError 10061` connection refused). In that sampled run, the manifest's bundle digest and the source/manifest/HTML contract hashes happened to match, which **does not** override the failed release gate. Concurrent builds may change the on-disk manifest again; no durable clean HEAD / served production artifact verification has yet occurred.

The prime integration agent owns the final clean strict build, preview launch, and last verifier run. Do not report a passed production release gate until the actual verifier exits **0** against that exact built and served revision.
