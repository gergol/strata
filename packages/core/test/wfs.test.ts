import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../src/adapter.js';
import { WfsAdapter } from '../src/adapters/wfs.js';
import { CRS_REGISTRY } from '../src/crs.js';
import { parseDescriptor, type LayerDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';
import { MemoryCache } from '../src/memory-cache.js';
import { lonLatToTile } from '../src/tile.js';

const capabilities = `<?xml version="1.0"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:Parameter name="resultType"><ows:AllowedValues><ows:Value>results</ows:Value><ows:Value>hits</ows:Value></ows:AllowedValues></ows:Parameter>
      <ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/gml+xml; version=3.2</ows:Value><ows:Value>application/json; subtype=geojson</ows:Value></ows:AllowedValues></ows:Parameter>
    </ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>test:sites</wfs:Name>
      <wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS>
      <wfs:OtherCRS>urn:ogc:def:crs:EPSG::3857</wfs:OtherCRS>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;

const descriptor = parseDescriptor({
  id: 'wfs_sites',
  name: 'WFS sites',
  domain: 'environment',
  adapter: 'bbox_vector',
  endpoint: 'https://wfs.test/service?tenant=public',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [8, 19],
  value_type: 'feature',
  aggregation: { primary: 'count', secondary: ['feature_list'] },
  ttl: '7d',
  rate_limit: { group: 'test-wfs', max_concurrent: 1, min_interval_ms: 100 },
  licence: 'CC-BY-4.0',
  commercial_use: true,
  attribution: 'Test provider',
  health_assertion: { at: [16.37, 48.21], expect_min_count: 1 },
  coverage: { bbox: [9, 46, 17, 49] },
  provenance_note: 'Provider polygons',
  search_beyond_tile: true,
  params: {
    protocol: 'wfs',
    wfs_version: '2.0.0',
    wfs_type_name: 'test:sites',
    wfs_srs_name: 'urn:ogc:def:crs:EPSG::4326',
    wfs_axis_order: 'yx',
    wfs_label_fields: ['site_name', 'category'],
    point_radius_m: 100,
    feature_cap: 2,
  },
});

function feature(id: string, name: string, coordinates: [number, number]): Record<string, unknown> {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates },
    properties: { site_name: name, category: 'protected' },
  };
}

function responseFor(url: URL): Response {
  const request = url.searchParams.get('request');
  if (request === 'GetCapabilities') return new Response(capabilities, { headers: { 'Content-Type': 'application/xml' } });
  if (url.searchParams.get('resultType') === 'hits') {
    return new Response('<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="17" numberReturned="0"/>', {
      headers: { 'Content-Type': 'application/xml' },
    });
  }
  return new Response(JSON.stringify({
    type: 'FeatureCollection',
    features: [
      feature('sites.1', 'One', [16.37, 48.21]),
      feature('sites.2', 'Two', [16.38, 48.22]),
      feature('sites.3', 'Three', [16.39, 48.23]),
    ],
  }), { headers: { 'Content-Type': 'application/json' } });
}

function io(captured: URL[] = [], responder: (url: URL) => Response = responseFor): IO {
  return {
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      captured.push(url);
      return responder(url);
    }) as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

describe('WfsAdapter capabilities and queries', () => {
  it('validates capabilities, applies explicit axis order, and normalizes labelled GeoJSON', async () => {
    const captured: URL[] = [];
    const result = await new WfsAdapter().point(descriptor, [16.37, 48.21], io(captured));
    expect(captured).toHaveLength(2);
    expect(captured[0]?.searchParams.get('request')).toBe('GetCapabilities');
    const query = captured[1] as URL;
    expect(query.searchParams.get('typeNames')).toBe('test:sites');
    expect(query.searchParams.get('outputFormat')).toBe('application/json; subtype=geojson');
    expect(query.searchParams.get('count')).toBe('3');
    const bbox = (query.searchParams.get('bbox') as string).split(',').map(Number);
    expect(bbox[0]).toBeLessThan(48.21);
    expect(bbox[1]).toBeLessThan(16.37);
    expect(bbox[2]).toBeGreaterThan(48.21);
    expect(bbox[3]).toBeGreaterThan(16.37);
    expect(result).toMatchObject({
      kind: 'ok',
      aggregation: 'nearest',
      basis: 'nearest',
      value: {
        kind: 'features',
        truncated: true,
      },
    });
    if (result.kind === 'ok' && result.value.kind === 'features') {
      expect(result.value.features).toHaveLength(2);
      expect(result.value.features[0]).toMatchObject({
        geometry: { type: 'Point', coordinates: [16.37, 48.21] },
        properties: { name: 'One · protected', wfs_id: 'sites.1' },
      });
    }
  });

  it('caches capabilities and uses resultType=hits for an exact tile count', async () => {
    const captured: URL[] = [];
    const adapter = new WfsAdapter();
    const first = await adapter.tile(descriptor, lonLatToTile([16.37, 48.21], 14), io(captured));
    const second = await adapter.tile(descriptor, lonLatToTile([16.38, 48.22], 14), io(captured));
    expect(captured.filter((url) => url.searchParams.get('request') === 'GetCapabilities')).toHaveLength(1);
    expect(captured.filter((url) => url.searchParams.get('resultType') === 'hits')).toHaveLength(2);
    expect(first).toMatchObject({ kind: 'ok', value: { kind: 'scalar', value: 17 }, aggregation: 'count' });
    expect(second).toMatchObject({ kind: 'ok', value: { kind: 'scalar', value: 17 }, aggregation: 'count' });
  });

  it('reprojects an advertised native CRS to browser GeoJSON longitude/latitude', async () => {
    const projectedDescriptor = parseDescriptor({
      ...JSON.parse(JSON.stringify(descriptor)),
      id: 'vienna_wfs',
      crs: 'EPSG:31256',
      params: {
        ...descriptor.params,
        wfs_srs_name: 'urn:ogc:def:crs:EPSG::31256',
        wfs_axis_order: 'xy',
      },
    });
    const native = proj4(
      CRS_REGISTRY['EPSG:4326'] as string,
      CRS_REGISTRY['EPSG:31256'] as string,
      [16.37, 48.21],
    ) as [number, number];
    const projectedCapabilities = capabilities.replace(/EPSG::4326/g, 'EPSG::31256');
    const captured: URL[] = [];
    const result = await new WfsAdapter().point(projectedDescriptor, [16.37, 48.21], io(captured, (url) => {
      if (url.searchParams.get('request') === 'GetCapabilities') return new Response(projectedCapabilities);
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [feature('native.1', 'Native', native)] }));
    }));
    const bbox = (captured[1]?.searchParams.get('bbox') as string).split(',').map(Number);
    expect(Math.abs(bbox[0] as number)).toBeGreaterThan(1_000);
    expect(Math.abs(bbox[1] as number)).toBeGreaterThan(1_000);
    if (result.kind === 'ok' && result.value.kind === 'features') {
      const coordinates = (result.value.features[0] as { geometry: { coordinates: number[] } }).geometry.coordinates;
      expect(coordinates[0]).toBeCloseTo(16.37, 6);
      expect(coordinates[1]).toBeCloseTo(48.21, 6);
    } else {
      expect.unreachable();
    }
  });
});

describe('WfsAdapter failure semantics', () => {
  it('rejects a missing feature type before requesting features', async () => {
    const missing: LayerDescriptor = { ...descriptor, params: { ...descriptor.params, wfs_type_name: 'test:missing' } };
    const request = new WfsAdapter().point(missing, [16.37, 48.21], io());
    await expect(request).rejects.toEqual(expect.objectContaining<Partial<AdapterError>>({ kind: 'schema' }));
  });

  it('classifies a final 429 response as rate limited', async () => {
    const request = new WfsAdapter().point(descriptor, [16.37, 48.21], io([], () => new Response('', { status: 429 })));
    await expect(request).rejects.toEqual(expect.objectContaining<Partial<AdapterError>>({ kind: 'rate_limited' }));
  });
});
