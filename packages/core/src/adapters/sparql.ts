/**
 * A1 — SPARQL geospatial subtype, first target Wikidata Query Service (M1.3).
 *
 * Descriptors provide a bounded WHERE-body fragment containing one
 * `{{spatial}}` placeholder. This adapter owns point-radius / tile-box
 * injection, SELECT/COUNT wrapping, caps, transport, and strict SPARQL JSON
 * normalization. Descriptor fragments can constrain `?item`; they cannot
 * supply their own SERVICE, nested query, or update operation.
 */
import { AdapterError, type Adapter, type AdapterOutcome } from '../adapter.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import type { LonLat, Tile } from '../tile.js';
import { tileToBBox } from '../tile.js';

type SparqlBinding = Record<string, { type?: unknown; value?: unknown } | undefined>;
interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, string>;
}

const DEFAULT_POINT_RADIUS_KM = 10;
const DEFAULT_FEATURE_CAP = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const NUMBER_PATTERN = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
const WKT_POINT = new RegExp(`^Point\\(\\s*(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s*\\)$`, 'i');
const PREFIXES = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>`;

function finiteParam(layer: LayerDescriptor, key: string, fallback: number, min: number, max: number): number {
  const value = Number(layer.params?.[key] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new AdapterError('schema', `layer '${layer.id}' needs params.${key} between ${min} and ${max}`);
  }
  return value;
}

function featureCap(layer: LayerDescriptor): number {
  const cap = finiteParam(layer, 'feature_cap', DEFAULT_FEATURE_CAP, 1, 500);
  if (!Number.isInteger(cap)) throw new AdapterError('schema', `layer '${layer.id}' needs an integer params.feature_cap`);
  return cap;
}

function queryTemplate(layer: LayerDescriptor): string {
  const template = layer.params?.['sparql_query'];
  if (typeof template !== 'string' || !template.includes('{{spatial}}')) {
    throw new AdapterError('schema', `layer '${layer.id}' needs params.sparql_query containing {{spatial}}`);
  }
  return template;
}

function labelLanguage(layer: LayerDescriptor): string {
  const language = String(layer.params?.['label_language'] ?? 'en');
  if (!/^[a-z][a-z0-9-]{1,11}$/i.test(language)) {
    throw new AdapterError('schema', `layer '${layer.id}' has an invalid params.label_language`);
  }
  return language;
}

function injectSpatial(layer: LayerDescriptor, spatial: string): string {
  const query = queryTemplate(layer).replace('{{spatial}}', spatial);
  if (/\{\{[^}]+\}\}/.test(query)) {
    throw new AdapterError('schema', `layer '${layer.id}' has an unsupported SPARQL placeholder`);
  }
  return query;
}

function aroundSpatial(at: LonLat, radiusKm: number): string {
  return `SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${at[0]} ${at[1]})"^^geo:wktLiteral ;
                    wikibase:radius "${radiusKm}" ;
                    wikibase:distance ?distance .
  }`;
}

function boxSpatial(tile: Tile): string {
  const [west, south, east, north] = tileToBBox(tile);
  return `SERVICE wikibase:box {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:cornerWest "Point(${west} ${south})"^^geo:wktLiteral ;
                    wikibase:cornerEast "Point(${east} ${north})"^^geo:wktLiteral .
  }`;
}

function featuresQuery(layer: LayerDescriptor, spatial: string, cap: number, sortByDistance: boolean): string {
  return `${PREFIXES}
SELECT DISTINCT ?item ?itemLabel ?location ?distance WHERE {
${injectSpatial(layer, spatial)}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${labelLanguage(layer)}". }
}
${sortByDistance ? 'ORDER BY ASC(?distance)\n' : ''}LIMIT ${cap + 1}`;
}

function countQuery(layer: LayerDescriptor, spatial: string): string {
  return `${PREFIXES}
SELECT (COUNT(DISTINCT ?item) AS ?count) WHERE {
${injectSpatial(layer, spatial)}
}`;
}

function bindings(json: unknown): SparqlBinding[] {
  if (typeof json !== 'object' || json === null) throw new AdapterError('schema', 'SPARQL response is not an object');
  const results = (json as { results?: unknown }).results;
  if (typeof results !== 'object' || results === null) throw new AdapterError('schema', 'SPARQL response has no results object');
  const rows = (results as { bindings?: unknown }).bindings;
  if (!Array.isArray(rows) || rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new AdapterError('schema', 'SPARQL response has no valid results.bindings array');
  }
  return rows as SparqlBinding[];
}

function bindingValue(row: SparqlBinding, key: string, required = true): string | undefined {
  const value = row[key]?.value;
  if (typeof value === 'string') return value;
  if (!required) return undefined;
  throw new AdapterError('schema', `SPARQL result row has no string ?${key} binding`);
}

function parseItemUri(value: string): { id: string; url: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterError('schema', `SPARQL ?item is not a valid URI: ${value}`);
  }
  const match = url.pathname.match(/^\/entity\/(Q\d+)$/);
  if (url.hostname !== 'www.wikidata.org' || !match) {
    throw new AdapterError('schema', `SPARQL ?item is not a Wikidata entity URI: ${value}`);
  }
  const id = match[1] as string;
  return { id, url: `https://www.wikidata.org/wiki/${id}` };
}

function parseLocation(value: string): [number, number] {
  const match = value.match(WKT_POINT);
  if (!match) throw new AdapterError('schema', `SPARQL ?location is not a WKT Point: ${value}`);
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new AdapterError('schema', `SPARQL ?location is outside valid longitude/latitude bounds: ${value}`);
  }
  return [lon, lat];
}

function toFeature(row: SparqlBinding): PointFeature {
  const item = parseItemUri(bindingValue(row, 'item') as string);
  const coordinates = parseLocation(bindingValue(row, 'location') as string);
  const label = bindingValue(row, 'itemLabel', false) ?? item.id;
  const distanceText = bindingValue(row, 'distance', false);
  const distance = distanceText === undefined ? undefined : Number(distanceText);
  if (distanceText !== undefined && (!Number.isFinite(distance) || (distance as number) < 0)) {
    throw new AdapterError('schema', `SPARQL ?distance is not a non-negative number: ${distanceText}`);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      name: label,
      wikidata_id: item.id,
      wikidata_url: item.url,
      ...(distance === undefined ? {} : { distance_km: String(distance) }),
    },
  };
}

export class SparqlAdapter implements Adapter {
  private async request(layer: LayerDescriptor, query: string, io: IO): Promise<unknown> {
    const url = new URL(layer.endpoint);
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    let response: Response;
    try {
      response = await io.fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new AdapterError('timeout', `SPARQL request exceeded ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
    if (!response.ok) {
      const kind = response.status === 429 ? 'rate_limited' : 'upstream';
      throw new AdapterError(kind, `SPARQL endpoint returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new AdapterError('schema', 'SPARQL endpoint did not return valid JSON');
    }
  }

  private async runFeatures(
    layer: LayerDescriptor,
    spatial: string,
    io: IO,
    sortByDistance: boolean,
  ): Promise<{ features: PointFeature[]; truncated: boolean }> {
    const cap = featureCap(layer);
    const json = await this.request(layer, featuresQuery(layer, spatial, cap, sortByDistance), io);
    const rows = bindings(json);
    return { features: rows.slice(0, cap).map(toFeature), truncated: rows.length > cap };
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const radius = finiteParam(layer, 'point_radius_km', DEFAULT_POINT_RADIUS_KM, 0.1, 250);
    const result = await this.runFeatures(layer, aroundSpatial(at, radius), io, true);
    if (result.features.length === 0) return { kind: 'empty' };
    return {
      kind: 'ok',
      value: { kind: 'features', ...result },
      aggregation: 'nearest',
      basis: 'nearest',
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const spatial = boxSpatial(tile);
    const primary = layer.aggregation?.primary ?? 'count';
    if (primary === 'count') {
      const json = await this.request(layer, countQuery(layer, spatial), io);
      const rows = bindings(json);
      if (rows.length !== 1) throw new AdapterError('schema', 'SPARQL count response must contain exactly one row');
      const count = Number(bindingValue(rows[0] as SparqlBinding, 'count'));
      if (!Number.isSafeInteger(count) || count < 0) throw new AdapterError('schema', 'SPARQL ?count is not a non-negative integer');
      if (count === 0) return { kind: 'empty' };
      return {
        kind: 'ok',
        value: { kind: 'scalar', value: count },
        aggregation: 'count',
        basis: 'aggregated',
      };
    }
    if (primary === 'feature_list') {
      const result = await this.runFeatures(layer, spatial, io, false);
      if (result.features.length === 0) return { kind: 'empty' };
      return {
        kind: 'ok',
        value: { kind: 'features', ...result },
        aggregation: 'feature_list',
        basis: 'aggregated',
      };
    }
    throw new AdapterError('schema', `unsupported SPARQL tile aggregation '${primary}'`);
  }
}
