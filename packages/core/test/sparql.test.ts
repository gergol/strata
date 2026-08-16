import { describe, expect, it, vi } from 'vitest';
import type { Adapter, AdapterOutcome } from '../src/adapter.js';
import { AdapterError } from '../src/adapter.js';
import { BBoxVectorAdapter } from '../src/adapters/bbox-vector.js';
import { SparqlAdapter } from '../src/adapters/sparql.js';
import { parseDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';
import { MemoryCache } from '../src/memory-cache.js';
import { lonLatToTile } from '../src/tile.js';

const descriptor = parseDescriptor({
  id: 'wikidata_museums',
  name: 'Museums',
  domain: 'history',
  adapter: 'bbox_vector',
  endpoint: 'https://query.wikidata.test/sparql',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [8, 19],
  value_type: 'feature',
  aggregation: { primary: 'count', secondary: ['feature_list'] },
  ttl: '7d',
  rate_limit: { group: 'wikidata-query-service', max_concurrent: 1, min_interval_ms: 1500 },
  licence: 'CC0-1.0',
  commercial_use: true,
  attribution: 'Wikidata contributors',
  health_assertion: { at: [16.3618, 48.2038], expect_min_count: 1 },
  coverage: 'global',
  provenance_note: 'Structured Wikidata statements',
  location_precision: 'exact',
  search_beyond_tile: true,
  params: {
    protocol: 'sparql',
    sparql_query: '{{spatial}}\nFILTER EXISTS { ?item wdt:P31/wdt:P279* wd:Q33506 }',
    point_radius_km: 5,
    feature_cap: 2,
    label_language: 'en',
  },
});

function row(id: string, label: string, location: string, distance = '0.25'): Record<string, unknown> {
  return {
    item: { type: 'uri', value: `http://www.wikidata.org/entity/${id}` },
    itemLabel: { type: 'literal', value: label },
    location: { type: 'literal', value: location },
    distance: { type: 'literal', value: distance },
  };
}

function response(bindings: unknown[]): unknown {
  return { head: { vars: ['item', 'itemLabel', 'location', 'distance'] }, results: { bindings } };
}

function ioReturning(
  body: unknown,
  capture?: { url?: string; init?: RequestInit },
  status = 200,
): IO {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (capture) {
        capture.url = String(input);
        if (init) capture.init = init;
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    }) as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

function capturedQuery(capture: { url?: string }): string {
  return new URL(capture.url as string).searchParams.get('query') ?? '';
}

describe('SparqlAdapter query construction', () => {
  it('injects a bounded around query and requests standard SPARQL JSON over GET', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await new SparqlAdapter().point(
      descriptor,
      [16.37, 48.21],
      ioReturning(response([row('Q1', 'Museum', 'Point(16.38 48.22)')]), capture),
    );
    const query = capturedQuery(capture);
    expect(query).toContain('SERVICE wikibase:around');
    expect(query).toContain('Point(16.37 48.21)');
    expect(query).toContain('wikibase:radius "5"');
    expect(query).toContain('FILTER EXISTS { ?item wdt:P31/wdt:P279* wd:Q33506 }');
    expect(query).toContain('LIMIT 3');
    expect(query).not.toContain('{{spatial}}');
    expect(capture.init?.method).toBe('GET');
    expect(new Headers(capture.init?.headers).get('Accept')).toBe('application/sparql-results+json');
  });

  it('injects tile corners into an exact distinct-count query', async () => {
    const capture: { url?: string } = {};
    const tile = lonLatToTile([16.37, 48.21], 14);
    const result = await new SparqlAdapter().tile(
      descriptor,
      tile,
      ioReturning(response([{ count: { type: 'literal', value: '17' } }]), capture),
    );
    const query = capturedQuery(capture);
    expect(query).toContain('SERVICE wikibase:box');
    expect(query).toContain('wikibase:cornerWest');
    expect(query).toContain('wikibase:cornerEast');
    expect(query).toContain('COUNT(DISTINCT ?item)');
    expect(result).toMatchObject({
      kind: 'ok',
      value: { kind: 'scalar', value: 17 },
      aggregation: 'count',
      basis: 'aggregated',
    });
  });
});

describe('SparqlAdapter response normalization', () => {
  it('returns linked point features ordered by provider distance', async () => {
    const result = await new SparqlAdapter().point(
      descriptor,
      [16.37, 48.21],
      ioReturning(response([row('Q123', 'Test museum', 'Point(16.38 48.22)', '0.125')])),
    );
    expect(result).toMatchObject({
      kind: 'ok',
      aggregation: 'nearest',
      basis: 'nearest',
      value: {
        kind: 'features',
        truncated: false,
        features: [{
          geometry: { type: 'Point', coordinates: [16.38, 48.22] },
          properties: {
            name: 'Test museum',
            wikidata_id: 'Q123',
            wikidata_url: 'https://www.wikidata.org/wiki/Q123',
            distance_km: '0.125',
          },
        }],
      },
    });
  });

  it('caps feature results and marks the list as truncated', async () => {
    const result = await new SparqlAdapter().point(
      descriptor,
      [16.37, 48.21],
      ioReturning(response([
        row('Q1', 'One', 'Point(16.1 48.1)'),
        row('Q2', 'Two', 'Point(16.2 48.2)'),
        row('Q3', 'Three', 'Point(16.3 48.3)'),
      ])),
    );
    if (result.kind === 'ok' && result.value.kind === 'features') {
      expect(result.value.features).toHaveLength(2);
      expect(result.value.truncated).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it('returns empty for no bindings and rejects malformed provider rows', async () => {
    await expect(new SparqlAdapter().point(descriptor, [0, 0], ioReturning(response([]))))
      .resolves.toEqual({ kind: 'empty' });
    const malformed = new SparqlAdapter().point(
      descriptor,
      [0, 0],
      ioReturning(response([row('Q1', 'Bad point', 'not-WKT')])),
    );
    await expect(malformed).rejects.toMatchObject({ name: 'AdapterError', kind: 'schema' });
  });

  it('classifies a final 429 response as rate limited', async () => {
    const request = new SparqlAdapter().point(descriptor, [0, 0], ioReturning({}, undefined, 429));
    await expect(request).rejects.toEqual(expect.objectContaining<Partial<AdapterError>>({ kind: 'rate_limited' }));
  });
});

describe('BBoxVectorAdapter routing', () => {
  it('dispatches an explicit SPARQL protocol without endpoint-name guessing', async () => {
    const overpass: Adapter = { point: vi.fn(), tile: vi.fn() };
    const outcome: AdapterOutcome = { kind: 'empty' };
    const sparql: Adapter = {
      point: vi.fn(async () => outcome),
      tile: vi.fn(async () => outcome),
    };
    const router = new BBoxVectorAdapter(overpass, sparql);
    await expect(router.point(descriptor, [0, 0], ioReturning(response([])))).resolves.toEqual(outcome);
    expect(sparql.point).toHaveBeenCalledOnce();
    expect(overpass.point).not.toHaveBeenCalled();
  });
});
