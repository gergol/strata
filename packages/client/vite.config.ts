import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Build metadata, injected at build time and surfaced in the settings panel so
 * a browser can always be checked against the latest deploy. In CI these come
 * from the GitHub Actions environment; locally they fall back to "dev".
 */
const buildInfo = {
  number: process.env.STRATA_BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER ?? 'dev',
  sha: (process.env.STRATA_BUILD_SHA ?? process.env.GITHUB_SHA ?? 'local').slice(0, 7),
  date: process.env.STRATA_BUILD_DATE ?? new Date().toISOString(),
};

/** Layer descriptors are repo content (`layers/*.yaml`); inline them at build time. */
const layersDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../layers');
const layerYamls = readdirSync(layersDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => readFileSync(resolve(layersDir, f), 'utf8'));

export default defineConfig({
  // Project pages are served from /<repo>/; the workflow sets STRATA_BASE=/strata/
  base: process.env.STRATA_BASE ?? '/',
  worker: { format: 'es' },
  plugins: [
    svelte(),
    {
      name: 'emit-version-json',
      // version.json rides next to index.html so the running app can later
      // poll what the server currently has and prompt for a reload.
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(buildInfo) });
      },
    },
  ],
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
    __LAYER_YAMLS__: JSON.stringify(layerYamls),
  },
});
