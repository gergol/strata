import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

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
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['strata.svg'],
      manifest: {
        name: 'Strata — geospatial exploration',
        short_name: 'Strata',
        description: 'A personal geospatial exploration instrument.',
        theme_color: '#14171c',
        background_color: '#14171c',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'strata.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg}'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/gergol\.github\.io\/strata\/data\/.*\.json$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'strata-materialized-data',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/raw\.githubusercontent\.com\/gergol\/strata\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'strata-repo-data',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 30, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'strata-basemap',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
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
