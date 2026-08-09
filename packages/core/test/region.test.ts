import { describe, it, expect } from 'vitest';
import { RegionAdapter } from '../src/adapters/region.js';
import { findContainingFeature } from '../src/geometry.js';
import type { GeoJsonFeatureCollection } from '../src/geometry.js';
import { MemoryCache } from '../src/memory-cache.js';
import { parseDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';

const pack: GeoJsonFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { id: 'at', name: 'Austria' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[9.5, 46.4], [17.2, 46.4], [17.2, 49.0], [9.5, 49.0], [9.5, 46.4]]],
      },
    },
  ],
};

const apiBody = {
  unix_seconds: [1, 2, 3],
  production_types: [
    { name: 'Hydro run-of-river', data: [500, 520, 540] },
    { name: 'Solar', data: [100, 80, null] },
    { name: 'Wind onshore', data: [200, 210, 260] },
    { name: 'Residual load', data: [-50, -40, -30] },
  ],
};

const descriptor = parseDescriptor({
  id: 'grid_generation_mix',
  name: 'Electricity generation mix',
  domain: 'energy',
  adapter: 'region',
  endpoint: 'https://api.test/public_power?country={{region}}',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [4, 18],
  value_type: 'categorical',
  aggregation: { primary: 'histogram' },
  ttl: '15m',
  licence: 'CC-BY-4.0',
  commercial_use: false,
  attribution: 'Energy-Charts (Fraunhofer ISE)',
  health_assertion: { at: [14.5, 47.5], expect_status: 'ok' },
  coverage: { regions: ['at'] },
  provenance_note: 'test',
  params: { regions_url: 'https://packs.test/zones.json', format: 'energy_charts_public_power' },
});

function makeIo(): IO & { urls: string[] } {
  const urls: string[] = [];
  const io = {
    urls,
    fetch: (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('packs.test')) return new Response(JSON.stringify(pack), { status: 200 });
      if (u.includes('country=at')) return new Response(JSON.stringify(apiBody), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
  return io as IO & { urls: string[] };
}

describe('point-in-polygon', () => {
  it('finds the containing feature and rejects outside points', () => {
    expect(findContainingFeature([14.5, 47.5], pack)?.properties['id']).toBe('at');
    expect(findContainingFeature([-30, 45], pack)).toBeUndefined();
  });
});

describe('RegionAdapter', () => {
  it('resolves a point to its region and returns the generation mix histogram', async () => {
    const io = makeIo();
    const r = await new RegionAdapter().point(descriptor, [14.5, 47.5], io);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.region).toBe('at');
      expect(r.value.kind).toBe('histogram');
      if (r.value.kind === 'histogram') {
        // Latest index with values is idx 2: hydro 540, wind 260 (solar null, negatives dropped)
        const total = r.value.classes.reduce((s, c) => s + c.share, 0);
        expect(total).toBeCloseTo(1, 9);
        expect(r.value.classes[0]).toMatchObject({ label: 'Hydro run-of-river' });
        expect(r.value.classes.map((c) => c.label)).not.toContain('Residual load'); // not generation
        expect(r.value.classes.map((c) => c.label)).not.toContain('Solar'); // null at latest index
      }
    }
  });

  it('returns no_coverage outside every region polygon (the Atlantic test)', async () => {
    const r = await new RegionAdapter().point(descriptor, [-30, 45], makeIo());
    expect(r).toEqual({ kind: 'no_coverage' });
  });

  it('caches the region pack across queries', async () => {
    const io = makeIo();
    const adapter = new RegionAdapter();
    await adapter.point(descriptor, [14.5, 47.5], io);
    await adapter.point(descriptor, [15.5, 47.6], io);
    expect(io.urls.filter((u) => u.includes('packs.test'))).toHaveLength(1);
  });

  it('answers tile queries with the tile-centre region', async () => {
    const r = await new RegionAdapter().tile(descriptor, { z: 8, x: 138, y: 89 }, makeIo());
    // z8 tile 138/89 covers eastern Austria; centre resolves to 'at'
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.region).toBe('at');
  });

  it('rejects unknown formats loudly', async () => {
    const bad = parseDescriptor({
      ...JSON.parse(JSON.stringify(descriptor)),
      params: { ...descriptor.params, format: 'mystery' },
    });
    await expect(new RegionAdapter().point(bad, [14.5, 47.5], makeIo())).rejects.toThrow(/unknown format/);
  });
});
