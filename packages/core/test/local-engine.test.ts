import { describe, it, expect } from 'vitest';
import { AdapterError, type Adapter, type AdapterOutcome } from '../src/adapter.js';
import type { IO } from '../src/io.js';
import { LocalQueryEngine } from '../src/local-engine.js';
import { MemoryCache } from '../src/memory-cache.js';
import { RateLimiter } from '../src/limiter.js';
import type { LimiterClock } from '../src/limiter.js';
import { isOk } from '../src/envelope.js';

const DAY_MS = 86_400_000;

function makeWorld(descriptorOverrides: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const clock: LimiterClock & { advance: (ms: number) => void } = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
  let upstreamCalls = 0;
  let upstreamBehaviour: 'ok' | 'fail' = 'ok';
  const io: IO = {
    fetch: (async () => {
      upstreamCalls++;
      if (upstreamBehaviour === 'fail') throw new Error('upstream unreachable');
      return new Response(JSON.stringify({ raw: 72 }), { status: 200 });
    }) as unknown as typeof fetch,
    cache: new MemoryCache(() => t),
    now: () => t,
  };
  // A minimal but realistic adapter: fetches through the (limiter-wrapped) io,
  // scales via the descriptor, returns a bare outcome — no attribution in sight.
  const adapter: Adapter = {
    async point(layer, _at, aio): Promise<AdapterOutcome> {
      const res = await aio.fetch(layer.endpoint);
      const body = (await res.json()) as { raw: number };
      return {
        kind: 'ok',
        value: { kind: 'scalar', value: body.raw * (layer.scale_factor ?? 1) },
        aggregation: 'mean',
        basis: 'aggregated',
      };
    },
    async tile(layer, _tile, aio): Promise<AdapterOutcome> {
      return this.point(layer, [0, 0], aio);
    },
  };
  const descriptor = {
    id: 'test_ph',
    name: 'Test pH',
    domain: 'subsurface',
    adapter: 'cog',
    endpoint: 'https://upstream.test/data.tif',
    crs: 'EPSG:4326',
    modes: ['point', 'tile'],
    zoom_valid: [10, 18],
    value_type: 'numeric',
    aggregation: { primary: 'mean' },
    unit: 'pH',
    scale_factor: 0.1,
    ttl: '1d',
    licence: 'CC-BY-4.0',
    commercial_use: true,
    attribution: 'Test Provider',
    attribution_url: 'https://provider.test',
    health_assertion: { at: [16.37, 48.21], expect_range: [5, 9] },
    coverage: 'global',
    provenance_note: 'synthetic',
    ...descriptorOverrides,
  };
  const engine = new LocalQueryEngine([descriptor], {
    io,
    adapters: { cog: adapter },
    limiter: new RateLimiter(clock, { circuitThreshold: 3, maxRetries: 0 }),
  });
  return {
    engine,
    clock,
    calls: () => upstreamCalls,
    setUpstream: (b: 'ok' | 'fail') => {
      upstreamBehaviour = b;
    },
    descriptor,
    io,
  };
}

describe('envelope stamping (R6.4, plan §4.3)', () => {
  it('stamps attribution, provenance, unit, and scaled value from the descriptor', async () => {
    const w = makeWorld();
    const r = await w.engine.point('test_ph', [16.37, 48.21]);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({ kind: 'scalar', value: 7.2 });
      expect(r.unit).toBe('pH');
      expect(r.attribution).toEqual({ text: 'Test Provider', url: 'https://provider.test' });
      expect(r.provenance).toBe('synthetic');
      expect(r.aggregation).toBe('mean');
      expect(r.cacheHit).toBe(false);
    }
  });
});

describe('cache (R7.2, plan §4.3)', () => {
  it('serves the second identical query from cache', async () => {
    const w = makeWorld();
    await w.engine.point('test_ph', [16.37, 48.21]);
    const r2 = await w.engine.point('test_ph', [16.37, 48.21]);
    expect(w.calls()).toBe(1);
    expect(isOk(r2) && r2.cacheHit).toBe(true);
  });

  it('refetches after the descriptor ttl expires', async () => {
    const w = makeWorld();
    await w.engine.point('test_ph', [16.37, 48.21]);
    w.clock.advance(DAY_MS + 1);
    await w.engine.point('test_ph', [16.37, 48.21]);
    expect(w.calls()).toBe(2);
  });

  it('a descriptor edit invalidates the cache via the hash key', async () => {
    const w = makeWorld();
    await w.engine.point('test_ph', [16.37, 48.21]);
    // Same cache, same upstream — but the layer's scale factor was corrected.
    const w2 = makeWorld({ scale_factor: 0.01 });
    const shared = new LocalQueryEngine([w2.descriptor], {
      io: w.io,
      adapters: {
        cog: {
          async point(layer, _at, aio) {
            await aio.fetch(layer.endpoint);
            return {
              kind: 'ok',
              value: { kind: 'scalar', value: 72 * (layer.scale_factor ?? 1) },
              aggregation: 'mean',
              basis: 'aggregated',
            };
          },
          async tile() {
            throw new Error('unused');
          },
        },
      },
    });
    const r = await shared.point('test_ph', [16.37, 48.21]);
    expect(w.calls()).toBe(2); // stale mis-scaled entry was NOT served
    expect(isOk(r) && r.value).toEqual({ kind: 'scalar', value: 0.72 });
  });
});

describe('gates (R5.1–R5.3)', () => {
  it('returns zoom_invalid with a reason outside zoom_valid', async () => {
    const w = makeWorld();
    const r = await w.engine.tile('test_ph', { z: 6, x: 33, y: 22 });
    expect(r.status).toBe('zoom_invalid');
    if (r.status === 'zoom_invalid') expect(r.reason).toMatch(/z10.*z18|z6/);
    expect(w.calls()).toBe(0);
  });

  it('returns no_coverage outside the declared coverage bbox — distinct from empty', async () => {
    const w = makeWorld({ coverage: { bbox: [9.5, 46.3, 17.2, 49.0] } }); // Austria-ish
    const inAt = await w.engine.point('test_ph', [16.37, 48.21]);
    const atlantic = await w.engine.point('test_ph', [-30, 45]);
    expect(isOk(inAt)).toBe(true);
    expect(atlantic.status).toBe('no_coverage');
    expect(w.calls()).toBe(1); // the out-of-coverage query never hit the upstream
  });

  it('throws on an unsupported mode (client bug, not an envelope state)', async () => {
    const w = makeWorld({ modes: ['point'] });
    await expect(w.engine.tile('test_ph', { z: 12, x: 0, y: 0 })).rejects.toThrow(/tile mode/);
  });

  it('throws on an unknown layer id', async () => {
    const w = makeWorld();
    await expect(w.engine.point('nope', [0, 0])).rejects.toThrow(/unknown layer/);
  });
});

describe('failure handling (R7.6)', () => {
  it('preserves adapter error taxonomy in the public envelope', async () => {
    const w = makeWorld();
    const engine = new LocalQueryEngine([w.descriptor], {
      io: w.io,
      adapters: {
        cog: {
          async point() {
            throw new AdapterError('schema', 'malformed provider response');
          },
          async tile() {
            throw new AdapterError('rate_limited', 'provider quota exceeded');
          },
        },
      },
    });

    await expect(engine.point('test_ph', [16.37, 48.21])).resolves.toMatchObject({
      status: 'error',
      kind: 'schema',
      message: 'malformed provider response',
    });
    await expect(engine.tile('test_ph', { z: 12, x: 2234, y: 1420 })).resolves.toMatchObject({
      status: 'error',
      kind: 'rate_limited',
      message: 'provider quota exceeded',
    });
  });

  it('maps upstream failures to error envelopes, then circuit-opens without upstream calls', async () => {
    const w = makeWorld();
    w.setUpstream('fail');
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await w.engine.point('test_ph', [i, i])); // distinct points, no cache
    }
    expect(results.every((r) => r.status === 'error' && r.kind === 'upstream')).toBe(true);
    expect(w.calls()).toBe(3);

    const afterOpen = await w.engine.point('test_ph', [9, 9]);
    expect(afterOpen.status).toBe('error');
    if (afterOpen.status === 'error') expect(afterOpen.kind).toBe('circuit_open');
    expect(w.calls()).toBe(3); // circuit stopped the hammering
  });
});

describe('registration (R6.2)', () => {
  it('refuses to construct with an invalid descriptor', () => {
    const w = makeWorld();
    expect(
      () =>
        new LocalQueryEngine([{ ...w.descriptor, licence: undefined }], {
          io: w.io,
          adapters: {},
        }),
    ).toThrow(/licence/);
  });

  it('exposes layer summaries with the degraded flag', async () => {
    const w = makeWorld({
      modes: ['point', 'tile', 'overlay'],
      overlay: {
        kind: 'raster',
        tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
        tile_size: 256,
        min_zoom: 3,
        max_zoom: 14,
        opacity: 0.6,
        legend: { title: 'pH', items: [{ label: 'neutral', color: '#009e73' }] },
      },
    });
    w.engine.setDegraded('test_ph', true);
    const layers = await w.engine.layers();
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      id: 'test_ph',
      degraded: true,
      unit: 'pH',
      primaryAggregation: 'mean',
      attribution: { text: 'Test Provider', url: 'https://provider.test' },
      overlay: {
        kind: 'raster',
        tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
        tileSize: 256,
        minZoom: 3,
        maxZoom: 14,
        opacity: 0.6,
      },
    });
  });
});
