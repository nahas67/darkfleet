import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

// The `.ts` extension is explicit because vite's `configLoader: 'native'` warns without it, and a
// warning in a config file is a warning nobody reads until the day the loader changes.
import { darkfleetBuildIdentity } from './build/buildIdentity.ts';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => ({
  plugins: [
    react(),
    tailwindcss(),
    cesium(),
    /*
     * BUILD IDENTITY. Emits `<meta name="darkfleet-build-head">` and friends into index.html, plus
     * `build-manifest.json` carrying a sha256 over the served bundle.
     *
     * This exists because DF-X9.4S invalidated a round of browser evidence against a
     * hand-synced snapshot that was four commits stale: nothing failed, the page loaded, and every
     * measurement was of code that no longer existed. A stale build has no signature, so the answer
     * to "which commit is the browser testing?" has to be readable from the page itself.
     *
     * `DF_REQUIRE_CLEAN_TREE=1` refuses to build from a dirty tree at all, so a verification build
     * cannot be produced from uncommitted source in the first place. See `build/buildIdentity.ts`.
     */
    darkfleetBuildIdentity({
      rootDir,
      strict: process.env.DF_REQUIRE_CLEAN_TREE === '1',
    }),
  ],
  resolve: {
    alias: { '@': rootDir },
  },
  server: {
    proxy: {
      // The Python backend is the single analytical authority; the frontend
      // never computes detections or correlation locally.
      '/api': {
        target: process.env.DARKFLEET_API_URL ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    /*
     * `build/` is included because the build-identity gate is product-surface code: it decides what
     * a browser can prove about itself. A gate that is not in the test run is a gate that does not
     * run, and the previous evidence failure is exactly a gate that did not run.
     */
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'build/**/*.test.ts'],
  },
}));