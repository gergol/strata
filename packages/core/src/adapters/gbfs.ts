/** Generic GBFS v2/v3 station availability adapter (A1). */
import { AdapterError, type Adapter, type AdapterOutcome } from '../adapter.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import { tileToBBox, type LonLat, type Tile } from '../tile.js';

interface FeedUrls {
  stationInformation: string;
  stationStatus: string;
}

interface Station {
  id: string;
  name: string;
  lon: number;
  lat: number;
  capacity?: number;
}

interface StationStatus {
  vehicles: number;
  docks?: number;
  renting?: boolean;
  returning?: boolean;
  updatedAt?: string;
}

interface Config {
  language: string;
  pointRadiusM: number;
  featureCap: number;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AdapterError('schema', message);
  return value as Record<string, unknown>;
}

function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new AdapterError('schema', message);
  return value;
}

function finite(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AdapterError('schema', message);
  return value;
}

function config(layer: LayerDescriptor): Config {
  const language = layer.params?.['gbfs_language'] ?? 'en';
  const pointRadiusM = layer.params?.['point_radius_m'] ?? 1500;
  const featureCap = layer.params?.['feature_cap'] ?? 20;
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) {
    throw new AdapterError('schema', 'params.gbfs_language must be a language code');
  }
  if (typeof pointRadiusM !== 'number' || !Number.isFinite(pointRadiusM) || pointRadiusM <= 0 || pointRadiusM > 20_000) {
    throw new AdapterError('schema', 'params.point_radius_m must be in (0, 20000]');
  }
  if (typeof featureCap !== 'number' || !Number.isInteger(featureCap) || featureCap < 1 || featureCap > 100) {
    throw new AdapterError('schema', 'params.feature_cap must be an integer from 1 to 100');
  }
  return { language, pointRadiusM, featureCap };
}

async function fetchJson(io: IO, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await io.fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new AdapterError('timeout', `GBFS request timed out: ${error.message}`);
    }
    throw error;
  }
  if (response.status === 429) throw new AdapterError('rate_limited', 'GBFS provider returned 429');
  if (!response.ok) throw new AdapterError('upstream', `GBFS provider returned ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new AdapterError('schema', `GBFS response is not JSON: ${(error as Error).message}`);
  }
}

function localizedName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { text?: unknown }).text === 'string');
    if (first) return String((first as { text: string }).text).trim();
  }
  return undefined;
}

function discoveryFeeds(payload: unknown, language: string): FeedUrls {
  const root = object(payload, 'GBFS discovery response must be an object');
  const data = object(root['data'], 'GBFS discovery response missing data');
  let feedsValue: unknown = data['feeds'];
  if (feedsValue === undefined) {
    const languageData = data[language] ?? Object.values(data)[0];
    feedsValue = object(languageData, `GBFS discovery response has no '${language}' language`)["feeds"];
  }
  const feeds = array(feedsValue, 'GBFS discovery response missing feeds').map((entry) => object(entry, 'GBFS feed entry must be an object'));
  const url = (name: string): string => {
    const feed = feeds.find((entry) => entry['name'] === name);
    if (!feed || typeof feed['url'] !== 'string') throw new AdapterError('schema', `GBFS discovery missing '${name}' feed`);
    try {
      return new URL(feed['url']).toString();
    } catch {
      throw new AdapterError('schema', `GBFS '${name}' URL is invalid`);
    }
  };
  return { stationInformation: url('station_information'), stationStatus: url('station_status') };
}

function stations(payload: unknown): Station[] {
  const root = object(payload, 'GBFS station information must be an object');
  const rows = array(object(root['data'], 'GBFS station information missing data')['stations'], 'GBFS station information missing stations');
  return rows.map((value, index) => {
    const row = object(value, `GBFS station ${index} must be an object`);
    const id = row['station_id'];
    const name = localizedName(row['name']);
    const lon = finite(row['lon'], `GBFS station ${index} has invalid longitude`);
    const lat = finite(row['lat'], `GBFS station ${index} has invalid latitude`);
    if ((typeof id !== 'string' && typeof id !== 'number') || !name || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new AdapterError('schema', `GBFS station ${index} has invalid identity or coordinates`);
    }
    const capacity = row['capacity'];
    return {
      id: String(id),
      name,
      lon,
      lat,
      ...(typeof capacity === 'number' && Number.isFinite(capacity) ? { capacity } : {}),
    };
  });
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

function statuses(payload: unknown): Map<string, StationStatus> {
  const root = object(payload, 'GBFS station status must be an object');
  const rows = array(object(root['data'], 'GBFS station status missing data')['stations'], 'GBFS station status missing stations');
  const result = new Map<string, StationStatus>();
  for (const [index, value] of rows.entries()) {
    const row = object(value, `GBFS station status ${index} must be an object`);
    const id = row['station_id'];
    const vehiclesRaw = row['num_vehicles_available'] ?? row['num_bikes_available'];
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof vehiclesRaw !== 'number' || !Number.isFinite(vehiclesRaw)) {
      throw new AdapterError('schema', `GBFS station status ${index} has invalid identity or vehicle count`);
    }
    const docks = row['num_docks_available'];
    const updatedAt = timestamp(row['last_reported']);
    result.set(String(id), {
      vehicles: vehiclesRaw,
      ...(typeof docks === 'number' && Number.isFinite(docks) ? { docks } : {}),
      ...(typeof row['is_renting'] === 'boolean' ? { renting: row['is_renting'] } :
        typeof row['is_renting'] === 'number' ? { renting: row['is_renting'] === 1 } : {}),
      ...(typeof row['is_returning'] === 'boolean' ? { returning: row['is_returning'] } :
        typeof row['is_returning'] === 'number' ? { returning: row['is_returning'] === 1 } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return result;
}

function distanceM(a: LonLat, b: LonLat): number {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLon = (b[0] - a[0]) * radians;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export class GbfsAdapter implements Adapter {
  private readonly discovery = new Map<string, Promise<FeedUrls>>();

  private feedUrls(layer: LayerDescriptor, io: IO, cfg: Config): Promise<FeedUrls> {
    const cached = this.discovery.get(layer.endpoint);
    if (cached) return cached;
    const request = fetchJson(io, layer.endpoint).then((payload) => discoveryFeeds(payload, cfg.language));
    this.discovery.set(layer.endpoint, request);
    request.catch(() => this.discovery.delete(layer.endpoint));
    return request;
  }

  private async snapshot(layer: LayerDescriptor, io: IO, cfg: Config): Promise<{ stations: Station[]; statuses: Map<string, StationStatus> }> {
    const urls = await this.feedUrls(layer, io, cfg);
    const [information, status] = await Promise.all([
      fetchJson(io, urls.stationInformation),
      fetchJson(io, urls.stationStatus),
    ]);
    return { stations: stations(information), statuses: statuses(status) };
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const cfg = config(layer);
    const snapshot = await this.snapshot(layer, io, cfg);
    const matching = snapshot.stations
      .map((station) => ({ station, distance: distanceM(at, [station.lon, station.lat] as LonLat) }))
      .filter(({ distance }) => distance <= cfg.pointRadiusM)
      .sort((a, b) => a.distance - b.distance);
    if (matching.length === 0) return { kind: 'empty' };
    const features = matching.slice(0, cfg.featureCap).map(({ station, distance }) => {
      const status = snapshot.statuses.get(station.id);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
        properties: {
          name: station.name,
          station_id: station.id,
          distance_m: Math.round(distance),
          ...(station.capacity !== undefined ? { capacity: station.capacity } : {}),
          ...(status ? {
            vehicles_available: status.vehicles,
            ...(status.docks !== undefined ? { docks_available: status.docks } : {}),
            ...(status.renting !== undefined ? { is_renting: status.renting } : {}),
            ...(status.returning !== undefined ? { is_returning: status.returning } : {}),
            ...(status.updatedAt ? { last_reported: status.updatedAt } : {}),
          } : {}),
        },
      };
    });
    const sourceUpdatedAt = [...snapshot.statuses.values()].map((status) => status.updatedAt).filter((value): value is string => value !== undefined).sort().at(-1);
    return {
      kind: 'ok',
      value: { kind: 'features', features, truncated: matching.length > cfg.featureCap },
      aggregation: 'nearest',
      basis: 'nearest',
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const cfg = config(layer);
    const snapshot = await this.snapshot(layer, io, cfg);
    const [west, south, east, north] = tileToBBox(tile);
    const count = snapshot.stations.filter((station) =>
      station.lon >= west && station.lon <= east && station.lat >= south && station.lat <= north,
    ).length;
    if (count === 0) return { kind: 'empty' };
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: count },
      aggregation: 'count',
      basis: 'aggregated',
    };
  }
}
