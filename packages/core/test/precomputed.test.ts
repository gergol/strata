import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { PrecomputedAdapter } from '../src/adapters/precomputed.js';
import { CRS_REGISTRY } from '../src/crs.js';
import { parseDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';
import { MemoryCache } from '../src/memory-cache.js';
import { lonLatToTile, tileToQuadkey } from '../src/tile.js';

function descriptor(params: Record<string, unknown>, modes: string[] = ['point', 'tile']) {
  return parseDescriptor({
    id: 'precomputed_test',
    name: 'Precomputed test',
    domain: 'society',
    adapter: 'precomputed',
    endpoint: 'https://assets.test/index.json',
    crs: 'EPSG:4326',
    modes,
    zoom_valid: [8, 18],
    value_type: 'numeric',
    ...(modes.includes('tile') ? { aggregation: { primary: 'mean' } } : {}),
    unit: 'value',
    scale_factor: 1,
    ttl: '90d',
    licence: 'CC-BY-4.0',
    commercial_use: true,
    attribution: 'Test data',
    health_assertion: { at: [16.3738, 48.2082], expect_range: [0, 10000] },
    coverage: 'global',
    provenance_note: 'Static index',
    params,
  });
}

function io(records: unknown[], calls: { count: number }): IO {
  return {
    fetch: (async () => {
      calls.count++;
      return new Response(JSON.stringify(records));
    }) as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

describe('PrecomputedAdapter', () => {
  it('joins a point to its z16 quadkey and computes test-weighted tile means', async () => {
    const at: [number, number] = [16.3738, 48.2082];
    const tile16 = lonLatToTile(at, 16);
    const key = tileToQuadkey(tile16);
    const sibling = `${key.slice(0, 15)}${key.endsWith('0') ? '1' : '0'}`;
    const calls = { count: 0 };
    const adapter = new PrecomputedAdapter();
    const layer = descriptor({ key_scheme: 'quadkey_z16', value_field: 'speed', weight_field: 'tests' });
    const records = [
      { key, speed: 100, tests: 3 },
      { key: sibling, speed: 40, tests: 1 },
    ];
    await expect(adapter.point(layer, at, io(records, calls))).resolves.toMatchObject({
      kind: 'ok',
      value: { kind: 'scalar', value: 100 },
      aggregation: 'mean',
      basis: 'aggregated',
    });
    const parent = { z: 15, x: Math.floor(tile16.x / 2), y: Math.floor(tile16.y / 2) };
    await expect(adapter.tile(layer, parent, io(records, calls))).resolves.toMatchObject({
      kind: 'ok',
      value: { kind: 'scalar', value: 85 },
      aggregation: 'mean',
    });
    expect(calls.count).toBe(1);
  });

  it('joins EPSG:4326 points to the containing GISCO EPSG:3035 kilometre cell', async () => {
    const at: [number, number] = [16.3738, 48.2082];
    const [x, y] = proj4(CRS_REGISTRY['EPSG:4326'] as string, CRS_REGISTRY['EPSG:3035'] as string, at) as [number, number];
    const key = `CRS3035RES1000mN${Math.floor(y / 1000) * 1000}E${Math.floor(x / 1000) * 1000}`;
    const calls = { count: 0 };
    const layer = descriptor({ key_scheme: 'epsg3035_grid_1km', value_field: 'population' }, ['point']);
    await expect(new PrecomputedAdapter().point(layer, at, io([{ key, population: 6863 }], calls))).resolves.toMatchObject({
      kind: 'ok',
      value: { kind: 'scalar', value: 6863 },
      aggregation: 'sum',
      basis: 'aggregated',
    });
  });
});
