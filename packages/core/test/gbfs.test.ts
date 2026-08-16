import { describe, expect, it } from 'vitest';
import { GbfsAdapter } from '../src/adapters/gbfs.js';
import { parseDescriptor } from '../src/descriptor.js';
import type { IO } from '../src/io.js';
import { MemoryCache } from '../src/memory-cache.js';
import { lonLatToTile } from '../src/tile.js';

const descriptor = parseDescriptor({
  id: 'bike_share_test',
  name: 'Bike share',
  domain: 'transport',
  adapter: 'bbox_vector',
  endpoint: 'https://gbfs.test/gbfs.json',
  crs: 'EPSG:4326',
  modes: ['point', 'tile'],
  zoom_valid: [10, 18],
  value_type: 'feature',
  aggregation: { primary: 'count', secondary: ['feature_list'] },
  ttl: '1m',
  rate_limit: { max_concurrent: 2, min_interval_ms: 0 },
  licence: 'CC0-1.0',
  commercial_use: true,
  attribution: 'Bike-share operator',
  health_assertion: { at: [16.3738, 48.2082], expect_min_count: 1 },
  coverage: { bbox: [16.1, 48.0, 16.7, 48.4] },
  provenance_note: 'Live GBFS station availability',
  search_beyond_tile: true,
  params: { protocol: 'gbfs', gbfs_language: 'en', point_radius_m: 2000, feature_cap: 1 },
});

const discovery = {
  version: '2.3',
  data: {
    en: {
      feeds: [
        { name: 'station_information', url: 'https://gbfs.test/station_information.json' },
        { name: 'station_status', url: 'https://gbfs.test/station_status.json' },
      ],
    },
  },
};

const information = {
  data: {
    stations: [
      { station_id: 'near', name: 'Near station', lon: 16.374, lat: 48.208, capacity: 20 },
      { station_id: 'second', name: 'Second station', lon: 16.38, lat: 48.21, capacity: 15 },
      { station_id: 'far', name: 'Far station', lon: 17.0, lat: 49.0 },
    ],
  },
};

const status = {
  data: {
    stations: [
      { station_id: 'near', num_bikes_available: 7, num_docks_available: 13, is_renting: 1, is_returning: 1, last_reported: 1786910400 },
      { station_id: 'second', num_vehicles_available: 2, num_docks_available: 13, is_renting: true, is_returning: true, last_reported: 1786910460 },
      { station_id: 'far', num_vehicles_available: 1 },
    ],
  },
};

function io(captured: string[]): IO {
  return {
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      captured.push(url);
      const payload = url.endsWith('/gbfs.json') ? discovery : url.includes('station_information') ? information : status;
      return new Response(JSON.stringify(payload));
    }) as typeof fetch,
    cache: new MemoryCache(() => 0),
    now: () => 0,
  };
}

describe('GbfsAdapter', () => {
  it('discovers v2 feeds, joins live status, sorts stations, and caps visibly', async () => {
    const captured: string[] = [];
    const result = await new GbfsAdapter().point(descriptor, [16.3738, 48.2082], io(captured));
    expect(captured).toEqual([
      'https://gbfs.test/gbfs.json',
      'https://gbfs.test/station_information.json',
      'https://gbfs.test/station_status.json',
    ]);
    expect(result).toMatchObject({
      kind: 'ok',
      aggregation: 'nearest',
      basis: 'nearest',
      value: {
        kind: 'features',
        truncated: true,
        features: [{
          geometry: { type: 'Point', coordinates: [16.374, 48.208] },
          properties: {
            name: 'Near station',
            vehicles_available: 7,
            docks_available: 13,
            is_renting: true,
          },
        }],
      },
    });
  });

  it('counts stations inside a tile and caches only discovery, not live status', async () => {
    const captured: string[] = [];
    const adapter = new GbfsAdapter();
    const tile = lonLatToTile([16.374, 48.208], 14);
    await expect(adapter.tile(descriptor, tile, io(captured))).resolves.toMatchObject({
      kind: 'ok',
      value: { kind: 'scalar', value: 2 },
      aggregation: 'count',
      basis: 'aggregated',
    });
    await adapter.tile(descriptor, tile, io(captured));
    expect(captured.filter((url) => url.endsWith('/gbfs.json'))).toHaveLength(1);
    expect(captured.filter((url) => url.includes('station_status'))).toHaveLength(2);
  });

  it('accepts v3 direct feeds and localized station names', async () => {
    const captured: string[] = [];
    const v3Io: IO = {
      ...io(captured),
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        captured.push(url);
        if (url.endsWith('/gbfs.json')) {
          return new Response(JSON.stringify({ data: { feeds: discovery.data.en.feeds } }));
        }
        if (url.includes('station_information')) {
          return new Response(JSON.stringify({ data: { stations: [{ station_id: 'v3', name: [{ text: 'Localized', language: 'en' }], lon: 16.374, lat: 48.208 }] } }));
        }
        return new Response(JSON.stringify({ data: { stations: [{ station_id: 'v3', num_vehicles_available: 3 }] } }));
      }) as typeof fetch,
    };
    const result = await new GbfsAdapter().point(descriptor, [16.374, 48.208], v3Io);
    expect(result).toMatchObject({ kind: 'ok', value: { features: [{ properties: { name: 'Localized' } }] } });
  });
});
