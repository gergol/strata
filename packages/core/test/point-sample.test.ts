import { describe, expect, it } from 'vitest';
import { PointSampleAdapter } from '../src/adapters/point-sample.js';
import { parseDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';
import { MemoryCache } from '../src/memory-cache.js';
import { lonLatToTile } from '../src/tile.js';

const descriptor = parseDescriptor({
  id: 'temperature_now',
  name: 'Temperature now',
  domain: 'weather',
  adapter: 'point_sample',
  endpoint: 'https://weather.test/forecast',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [3, 18],
  value_type: 'numeric',
  aggregation: { primary: 'mean', secondary: ['latest'] },
  unit: '°C',
  native_unit: '°C',
  scale_factor: 1,
  ttl: '15m',
  rate_limit: { max_concurrent: 2, min_interval_ms: 0 },
  licence: 'CC-BY-4.0',
  commercial_use: true,
  attribution: 'Weather provider',
  health_assertion: { at: [16.37, 48.21], expect_range: [-60, 60] },
  coverage: 'global',
  provenance_note: 'Modelled current conditions',
  params: {
    query: { current: 'temperature_2m', timezone: 'GMT' },
    value_path: 'current.temperature_2m',
    time_path: 'current.time',
    sample_grid: 3,
    batch_coordinates: true,
  },
});

function io(responder: (url: URL) => unknown, captured: URL[] = []): IO {
  return {
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      captured.push(url);
      return new Response(JSON.stringify(responder(url)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

describe('PointSampleAdapter', () => {
  it('queries a coordinate, extracts the declared field, and marks it sampled', async () => {
    const captured: URL[] = [];
    const result = await new PointSampleAdapter().point(
      descriptor,
      [16.37, 48.21],
      io(() => ({ current: { temperature_2m: 21.5, time: '2026-08-16T20:00' } }), captured),
    );
    expect(captured[0]?.searchParams.get('latitude')).toBe('48.21');
    expect(captured[0]?.searchParams.get('longitude')).toBe('16.37');
    expect(captured[0]?.searchParams.get('current')).toBe('temperature_2m');
    expect(result).toEqual({
      kind: 'ok',
      value: { kind: 'scalar', value: 21.5 },
      aggregation: 'latest',
      basis: 'sampled',
      sourceUpdatedAt: '2026-08-16T20:00:00.000Z',
    });
  });

  it('batches a 3×3 tile probe grid and returns a sampled mean', async () => {
    const captured: URL[] = [];
    const result = await new PointSampleAdapter().tile(
      descriptor,
      lonLatToTile([16.37, 48.21], 12),
      io((url) => {
        const latitudes = (url.searchParams.get('latitude') as string).split(',');
        return latitudes.map((_, index) => ({
          current: { temperature_2m: index + 1, time: '2026-08-16T20:00' },
        }));
      }, captured),
    );
    expect(captured).toHaveLength(1);
    expect((captured[0]?.searchParams.get('latitude') as string).split(',')).toHaveLength(9);
    expect(result).toMatchObject({
      kind: 'ok',
      value: { kind: 'scalar', value: 5 },
      aggregation: 'mean',
      basis: 'sampled',
    });
  });

  it('returns empty for provider nulls and rejects malformed numeric fields', async () => {
    await expect(new PointSampleAdapter().point(
      descriptor,
      [0, 0],
      io(() => ({ current: { temperature_2m: null, time: '2026-08-16T20:00' } })),
    )).resolves.toEqual({ kind: 'empty' });
    await expect(new PointSampleAdapter().point(
      descriptor,
      [0, 0],
      io(() => ({ current: { temperature_2m: 'warm', time: '2026-08-16T20:00' } })),
    )).rejects.toMatchObject({ name: 'AdapterError', kind: 'schema' });
  });
});
