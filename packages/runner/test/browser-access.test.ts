import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '@strata/core';
import { APP_ORIGIN, checkBrowserAccess, overlayProbeUrl, type FetchObservation } from '../src/browser-access.js';

const base = parseDescriptor({
  id: 'test_layer',
  name: 'Test layer',
  domain: 'energy',
  adapter: 'region',
  endpoint: 'https://gergol.github.io/strata/data/test_layer-{{region}}.json',
  crs: 'EPSG:4326',
  modes: ['point'],
  zoom_valid: [0, 18],
  value_type: 'categorical',
  ttl: '15m',
  licence: 'CC-BY-4.0',
  commercial_use: false,
  attribution: 'Test',
  health_assertion: { at: [14.5, 47.5], expect_status: 'ok' },
  coverage: { regions: ['at'] },
  provenance_note: 'test',
  browser_access: 'materialized',
  params: {
    materialize_regions: ['at'],
    max_materialized_age_ms: 7_200_000,
  },
});

const now = Date.parse('2026-08-16T13:30:00.000Z');

describe('browser access verification', () => {
  it('accepts same-origin fresh materialized data and wildcard CORS dependencies', async () => {
    const observations: FetchObservation[] = [
      { url: 'https://raw.githubusercontent.com/example/regions.json', status: 200, accessControlAllowOrigin: '*' },
    ];
    const checked = await checkBrowserAccess(
      base,
      observations,
      (async () => new Response(JSON.stringify({ materialized_at: '2026-08-16T13:15:00.000Z' }), { status: 200 })) as typeof fetch,
      () => now,
    );
    expect(checked).toEqual({ ok: true });
  });

  it('detects the Energy-Charts origin mismatch that Node fetch ignores', async () => {
    const checked = await checkBrowserAccess(
      { ...base, browser_access: 'direct' },
      [{ url: 'https://api.energy-charts.info/public_power', status: 200, accessControlAllowOrigin: 'https://www.api.energy-charts.info' }],
      fetch,
      () => now,
    );
    expect(checked).toMatchObject({ ok: false });
    expect(checked.note).toContain('browser CORS denied');
    expect(checked.note).toContain(APP_ORIGIN);
  });

  it('rejects stale materialized data', async () => {
    const checked = await checkBrowserAccess(
      base,
      [],
      (async () => new Response(JSON.stringify({ materialized_at: '2026-08-16T10:00:00.000Z' }), { status: 200 })) as typeof fetch,
      () => now,
    );
    expect(checked.note).toContain('stale');
  });

  it('requires range support and CORS for direct COG layers', async () => {
    const cog = parseDescriptor({
      ...JSON.parse(JSON.stringify(base)),
      id: 'test_cog',
      adapter: 'cog',
      endpoint: 'https://cog.test/data.tif',
      value_type: 'numeric',
      unit: 'pH',
      scale_factor: 1,
      coverage: 'global',
      browser_access: 'direct',
      params: undefined,
    });
    const checked = await checkBrowserAccess(
      cog,
      [],
      (async () => new Response(new Uint8Array([0]), { status: 206, headers: { 'Access-Control-Allow-Origin': '*' } })) as typeof fetch,
      () => now,
    );
    expect(checked).toEqual({ ok: true });
  });

  it('expands and verifies the actual browser overlay tile URL', async () => {
    const overlayLayer = parseDescriptor({
      ...JSON.parse(JSON.stringify(base)),
      adapter: 'precomputed',
      modes: ['overlay'],
      health_assertion: { at: [14.5, 47.5], expect_overlay: true },
      browser_access: 'direct',
      params: undefined,
      overlay: {
        kind: 'raster',
        tiles: ['https://tiles.test/wms?z={z}&x={x}&y={y}&bbox={bbox-epsg-3857}'],
        min_zoom: 2,
        max_zoom: 14,
      },
    });
    const expectedUrl = overlayProbeUrl(overlayLayer);
    expect(expectedUrl).not.toContain('{');
    const requested: string[] = [];
    const checked = await checkBrowserAccess(
      overlayLayer,
      [],
      (async (input) => {
        requested.push(String(input));
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
        });
      }) as typeof fetch,
      () => now,
    );
    expect(requested).toEqual([expectedUrl]);
    expect(checked).toEqual({ ok: true });
  });

  it('fails an overlay whose rendered tiles deny the Pages origin', async () => {
    const overlayLayer = parseDescriptor({
      ...JSON.parse(JSON.stringify(base)),
      adapter: 'precomputed',
      modes: ['overlay'],
      health_assertion: { at: [14.5, 47.5], expect_overlay: true },
      browser_access: 'direct',
      params: undefined,
      overlay: {
        kind: 'raster',
        tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
        min_zoom: 2,
        max_zoom: 14,
      },
    });
    const checked = await checkBrowserAccess(
      overlayLayer,
      [],
      (async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })) as typeof fetch,
      () => now,
    );
    expect(checked.note).toContain('overlay tile browser probe failed');
  });
});
