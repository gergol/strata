import { describe, it, expect } from 'vitest';
import { OverpassAdapter } from '../src/adapters/overpass.js';
import { MemoryCache } from '../src/memory-cache.js';
import { parseDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';
import { lonLatToTile, tileToBBox } from '../src/tile.js';

const descriptor = parseDescriptor({
  id: 'osm_drinking_water',
  name: 'Drinking water points',
  domain: 'built',
  adapter: 'bbox_vector',
  endpoint: 'https://overpass.test/api/interpreter',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [12, 19],
  value_type: 'feature',
  aggregation: { primary: 'count', secondary: ['feature_list'] },
  ttl: '7d',
  licence: 'ODbL-1.0',
  commercial_use: true,
  attribution: '© OpenStreetMap contributors',
  health_assertion: { at: [16.3725, 48.2082], expect_min_count: 1 },
  coverage: 'global',
  provenance_note: 'OSM',
  params: {
    overpass_query: 'node[amenity=drinking_water]{{spatial}};',
    point_radius_m: 500,
    feature_cap: 3,
  },
});

function ioReturning(elements: unknown[], capture?: { body?: string }): IO {
  return {
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (capture) capture.body = String(init?.body ?? '');
      return new Response(JSON.stringify({ elements }), { status: 200 });
    }) as unknown as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

const node = (id: number, lon: number, lat: number) => ({
  type: 'node',
  id,
  lon,
  lat,
  tags: { amenity: 'drinking_water' },
});

describe('OverpassAdapter query construction', () => {
  it('substitutes an around-filter for point mode with lat,lon order', async () => {
    const capture: { body?: string } = {};
    await new OverpassAdapter().point(descriptor, [16.37, 48.21], ioReturning([node(1, 16.37, 48.21)], capture));
    const decoded = decodeURIComponent(capture.body ?? '');
    expect(decoded).toContain('(around:500,48.21,16.37)');
    expect(decoded).toContain('[out:json]');
    expect(decoded).toContain('out center 4;'); // cap + 1 to detect truncation
  });

  it('substitutes a south,west,north,east bbox for tile mode', async () => {
    const capture: { body?: string } = {};
    const tile = lonLatToTile([16.37, 48.21], 14);
    const [w, s, e, n] = tileToBBox(tile);
    await new OverpassAdapter().tile(descriptor, tile, ioReturning([node(1, 16.37, 48.21)], capture));
    const decoded = decodeURIComponent(capture.body ?? '');
    expect(decoded).toContain(`(${s},${w},${n},${e})`);
  });

  it('rejects a descriptor without the {{spatial}} placeholder', async () => {
    const bad = parseDescriptor({
      ...JSON.parse(JSON.stringify(descriptor)),
      params: { overpass_query: 'node[amenity=x];' },
    });
    await expect(new OverpassAdapter().point(bad, [0, 0], ioReturning([]))).rejects.toThrow(/spatial/);
  });
});

describe('OverpassAdapter outcomes', () => {
  it('point mode returns features labelled nearest (R4.4)', async () => {
    const r = await new OverpassAdapter().point(descriptor, [16.37, 48.21], ioReturning([node(1, 16.4, 48.2)]));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.basis).toBe('nearest');
      expect(r.value.kind).toBe('features');
    }
  });

  it('caps feature lists and flags truncation', async () => {
    const many = Array.from({ length: 5 }, (_, i) => node(i, 16 + i / 100, 48));
    const r = await new OverpassAdapter().point(descriptor, [16, 48], ioReturning(many));
    if (r.kind === 'ok' && r.value.kind === 'features') {
      expect(r.value.features).toHaveLength(3);
      expect(r.value.truncated).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it('tile mode aggregates to the declared count', async () => {
    const tile = lonLatToTile([16.37, 48.21], 14);
    const r = await new OverpassAdapter().tile(descriptor, tile, ioReturning([node(1, 16.37, 48.21), node(2, 16.38, 48.22)]));
    expect(r).toMatchObject({ kind: 'ok', value: { kind: 'scalar', value: 2 }, aggregation: 'count', basis: 'aggregated' });
  });

  it('zero results is empty — information, not an error (R5.3)', async () => {
    const r = await new OverpassAdapter().point(descriptor, [0, 0], ioReturning([]));
    expect(r).toEqual({ kind: 'empty' });
  });

  it('uses way/relation centers when nodes are absent', async () => {
    const way = { type: 'way', id: 9, center: { lat: 48.2, lon: 16.4 }, tags: { amenity: 'drinking_water' } };
    const r = await new OverpassAdapter().point(descriptor, [16.4, 48.2], ioReturning([way]));
    if (r.kind === 'ok' && r.value.kind === 'features') {
      const f = r.value.features[0] as { geometry: { coordinates: [number, number] } };
      expect(f.geometry.coordinates).toEqual([16.4, 48.2]);
    } else {
      expect.unreachable();
    }
  });
});
