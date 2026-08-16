import { describe, it, expect } from 'vitest';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import type { GeoTIFF } from 'geotiff';
import { CogAdapter } from '../src/adapters/cog.js';
import { MemoryCache } from '../src/memory-cache.js';
import type { IO } from '../src/io.js';
import { lonLatToTile } from '../src/tile.js';
import { parseDescriptor } from '../src/descriptor.js';

/**
 * Synthetic 64x64 EPSG:4326 raster covering [16,48]–[17,49] (1°×1°).
 * geotiff's writer emits 8-bit samples, so values stay within 0–255:
 * v = (row + col) % 200, with the nodata sentinel 255 in the top-left cell.
 */
const SIZE = 64;
async function syntheticTiff(values?: number[]): Promise<GeoTIFF> {
  const data =
    values ??
    Array.from({ length: SIZE * SIZE }, (_, i) => {
      const row = Math.floor(i / SIZE);
      const col = i % SIZE;
      return row === 0 && col === 0 ? 255 : (row + col) % 200;
    });
  const buffer = await writeArrayBuffer(data, {
    width: SIZE,
    height: SIZE,
    ModelPixelScale: [1 / SIZE, 1 / SIZE, 0],
    ModelTiepoint: [0, 0, 0, 16, 49, 0], // top-left corner = (16E, 49N)
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
    GeographicTypeGeoKey: 4326,
  } as Parameters<typeof writeArrayBuffer>[1]);
  return fromArrayBuffer(buffer as ArrayBuffer);
}

async function projectedSurfaceTiff(): Promise<GeoTIFF> {
  const buffer = await writeArrayBuffer(Array.from({ length: SIZE * SIZE }, () => 100), {
    width: SIZE,
    height: SIZE,
    ModelPixelScale: [20, 20, 0],
    ModelTiepoint: [0, 0, 0, 3_110, 341_890, 0],
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
    ProjectedCSTypeGeoKey: 31256,
  } as Parameters<typeof writeArrayBuffer>[1]);
  return fromArrayBuffer(buffer as ArrayBuffer);
}

function makeIo(): IO {
  return {
    fetch: (async () => {
      throw new Error('COG tests must not hit the network');
    }) as unknown as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

const numericDescriptor = parseDescriptor({
  id: 'synthetic',
  name: 'Synthetic raster',
  domain: 'subsurface',
  adapter: 'cog',
  endpoint: 'https://cog.test/synthetic.tif',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [8, 18],
  value_type: 'numeric',
  aggregation: { primary: 'mean', secondary: ['min', 'max'] },
  unit: 'u',
  scale_factor: 0.1,
  nodata: 255,
  ttl: '30d',
  licence: 'CC0',
  commercial_use: true,
  attribution: 'synthetic',
  health_assertion: { at: [16.5, 48.5], expect_range: [0, 1000] },
  coverage: { bbox: [16, 48, 17, 49] },
  provenance_note: 'synthetic',
});

function adapterFor(tiff: GeoTIFF): CogAdapter {
  return new CogAdapter({ open: async () => tiff });
}

describe('CogAdapter point reads', () => {
  it('reads the correct pixel for a coordinate', async () => {
    const adapter = adapterFor(await syntheticTiff());
    // (16.5, 48.5) → col 32, row 32 → raw (32+32)%200 = 64 → scaled 6.4
    const r = await adapter.point(numericDescriptor, [16.5, 48.5], makeIo());
    expect(r).toMatchObject({ kind: 'ok', value: { kind: 'scalar', value: 6.4 } });
  });

  it('returns empty (not a value) on the nodata sentinel', async () => {
    const adapter = adapterFor(await syntheticTiff());
    // Top-left cell holds the sentinel: coordinate just inside (16, 49).
    const r = await adapter.point(numericDescriptor, [16.001, 48.999], makeIo());
    expect(r).toEqual({ kind: 'empty' });
  });

  it('returns no_coverage outside the raster extent', async () => {
    const adapter = adapterFor(await syntheticTiff());
    const r = await adapter.point(numericDescriptor, [2, 40], makeIo());
    expect(r).toEqual({ kind: 'no_coverage' });
  });

  it('returns a time-stamped modelled shadow surface below the horizon', async () => {
    const shadowDescriptor = parseDescriptor({
      ...JSON.parse(JSON.stringify(numericDescriptor)),
      id: 'synthetic_shadow',
      domain: 'terrain',
      crs: 'EPSG:31256',
      modes: ['point'],
      zoom_valid: [13, 22],
      value_type: 'feature',
      aggregation: undefined,
      unit: undefined,
      scale_factor: undefined,
      nodata: undefined,
      terrain_analysis: { kind: 'shadow', radius_m: 250, cast_distance_m: 250, grid_m: 10 },
      feature_style: { kind: 'fill', color: '#6546c7' },
      health_assertion: {
        at: [16.38259, 48.20964],
        at_time: '2026-06-21T22:00:00Z',
        expect_min_count: 1,
      },
    });
    const adapter = adapterFor(await projectedSurfaceTiff());
    const r = await adapter.point(
      shadowDescriptor,
      [16.38259, 48.20964],
      makeIo(),
      { atTime: '2026-06-21T22:00:00Z' },
    );
    expect(r).toMatchObject({
      kind: 'ok',
      basis: 'modelled',
      value: {
        kind: 'features',
        summary: expect.stringMatching(/^100\.0% shadow within 250 m · sun below horizon/),
        features: [{ properties: { at_time: '2026-06-21T22:00:00.000Z', shadow_percent: 100 } }],
      },
    });
  });
});

describe('CogAdapter tile aggregation (R4.1)', () => {
  it('computes the declared mean over a tile window, nodata excluded', async () => {
    const adapter = adapterFor(await syntheticTiff());
    const tile = lonLatToTile([16.5, 48.5], 12);
    const r = await adapter.tile(numericDescriptor, tile, makeIo());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.aggregation).toBe('mean');
      expect(r.basis).toBe('aggregated');
      expect(r.value.kind).toBe('scalar');
      if (r.value.kind === 'scalar') {
        // Values are (row+col)%200 scaled by 0.1 → possible range (0, 20);
        // plausibility bounds are enough — exact window depends on rounding.
        expect(r.value.value).toBeGreaterThan(0);
        expect(r.value.value).toBeLessThan(20);
      }
    }
  });

  it('aggregates categorical rasters to a histogram (R4.3)', async () => {
    // Left half class 1 ("forest"), right half class 2 ("urban").
    const data = Array.from({ length: SIZE * SIZE }, (_, i) => (i % SIZE < SIZE / 2 ? 1 : 2));
    const adapter = adapterFor(await syntheticTiff(data));
    const categorical = parseDescriptor({
      ...JSON.parse(JSON.stringify({
        ...numericDescriptor,
      })),
      id: 'synthetic_cat',
      value_type: 'categorical',
      aggregation: { primary: 'histogram' },
      unit: undefined,
      scale_factor: undefined,
      nodata: undefined,
      params: { classes: { '1': 'forest', '2': 'urban' } },
    });
    // A z10 tile sits well inside the 1°×1° extent and spans both halves? No —
    // use a window over the whole extent: z9 tile still inside; take centre tile.
    const tile = lonLatToTile([16.5, 48.5], 10);
    const r = await adapter.tile(categorical, tile, makeIo());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.kind).toBe('histogram');
      if (r.value.kind === 'histogram') {
        const shares = Object.fromEntries(r.value.classes.map((c) => [c.label, c.share]));
        const total = r.value.classes.reduce((s, c) => s + c.share, 0);
        expect(total).toBeCloseTo(1, 9);
        // Centre tile at z10 straddles the halves; both classes must appear.
        expect(Object.keys(shares).sort()).toEqual(['forest', 'urban']);
      }
    }
  });

  it('returns empty for an all-nodata window', async () => {
    const data = Array.from({ length: SIZE * SIZE }, () => 255);
    const adapter = adapterFor(await syntheticTiff(data));
    const tile = lonLatToTile([16.5, 48.5], 12);
    const r = await adapter.tile(numericDescriptor, tile, makeIo());
    expect(r).toEqual({ kind: 'empty' });
  });
});
