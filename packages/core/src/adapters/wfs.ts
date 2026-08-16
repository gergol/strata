/**
 * A1 — standards-driven WFS 1.1/2.0 subtype (M1.4).
 *
 * Every query first resolves and caches GetCapabilities for the service. The
 * advertised version, feature type, requested CRS, GeoJSON output format, and
 * `hits` support are validated before GetFeature is attempted. Descriptors pin
 * the WFS axis order and CRS name because neither may be guessed safely.
 */
import proj4 from 'proj4';
import { AdapterError, type Adapter, type AdapterOutcome } from '../adapter.js';
import { CRS_REGISTRY } from '../crs.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import type { BBox, LonLat, Tile } from '../tile.js';
import { tileToBBox } from '../tile.js';

interface WfsFeatureType {
  name: string;
  crs: string[];
}

interface WfsCapabilities {
  version: '1.1.0' | '2.0.0';
  outputFormats: string[];
  featureTypes: WfsFeatureType[];
}

interface WfsProfile {
  capabilities: WfsCapabilities;
  outputFormat: string;
  featureType: WfsFeatureType;
  srsName: string;
}

interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: unknown;
}

interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
  [key: string]: unknown;
}

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POINT_RADIUS_M = 50;
const DEFAULT_FEATURE_CAP = 100;
const GEOJSON_FORMATS = [
  'application/json; subtype=geojson',
  'application/json',
  'json',
];

function textParam(layer: LayerDescriptor, key: string): string {
  const value = layer.params?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterError('schema', `layer '${layer.id}' needs a non-empty params.${key}`);
  }
  return value.trim();
}

function numberParam(layer: LayerDescriptor, key: string, fallback: number, min: number, max: number): number {
  const value = Number(layer.params?.[key] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new AdapterError('schema', `layer '${layer.id}' needs params.${key} between ${min} and ${max}`);
  }
  return value;
}

function featureCap(layer: LayerDescriptor): number {
  const cap = numberParam(layer, 'feature_cap', DEFAULT_FEATURE_CAP, 1, 500);
  if (!Number.isInteger(cap)) throw new AdapterError('schema', `layer '${layer.id}' needs an integer params.feature_cap`);
  return cap;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function openingAttributes(xml: string, localName: string): string | undefined {
  const match = xml.match(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b([^>]*)>`, 'i'));
  return match?.[1];
}

function attribute(attributes: string | undefined, name: string): string | undefined {
  if (!attributes) return undefined;
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? xmlDecode(match[2] as string).trim() : undefined;
}

function blocks(xml: string, localName: string): string[] {
  return [...xml.matchAll(new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    'gi',
  ))].map((match) => match[0]);
}

function childText(xml: string, localName: string): string | undefined {
  const match = xml.match(new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    'i',
  ));
  if (!match) return undefined;
  return xmlDecode((match[1] as string).replace(/<[^>]+>/g, '').trim());
}

function normalizeCrs(value: string): string | undefined {
  if (/^(?:urn:ogc:def:crs:OGC(?::[^:]*)?:CRS84|OGC:CRS84|CRS:84)$/i.test(value)) return 'EPSG:4326';
  const match = value.match(/(?:^EPSG:|urn:ogc:def:crs:EPSG(?::[^:]*)?:|\/def\/crs\/EPSG\/\d*\/)(\d+)$/i);
  return match ? `EPSG:${match[1]}` : undefined;
}

function parseCapabilities(xml: string): WfsCapabilities {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AdapterError('schema', 'WFS capabilities may not contain a DTD or entity declaration');
  const rootAttributes = openingAttributes(xml, 'WFS_Capabilities');
  const version = attribute(rootAttributes, 'version');
  if (version !== '1.1.0' && version !== '2.0.0') {
    throw new AdapterError('schema', `WFS capabilities has unsupported version '${version ?? 'missing'}'`);
  }

  const operation = blocks(xml, 'Operation').find((block) =>
    attribute(openingAttributes(block, 'Operation'), 'name')?.toLowerCase() === 'getfeature'
  );
  if (!operation) throw new AdapterError('schema', 'WFS capabilities does not advertise GetFeature');
  const outputParameter = blocks(operation, 'Parameter').find((block) =>
    attribute(openingAttributes(block, 'Parameter'), 'name')?.toLowerCase() === 'outputformat'
  );
  const outputFormats = outputParameter
    ? blocks(outputParameter, 'Value').map((block) => childText(block, 'Value')).filter((value): value is string => Boolean(value))
    : [];
  if (outputFormats.length === 0) throw new AdapterError('schema', 'WFS capabilities advertises no GetFeature output formats');

  const featureTypes = blocks(xml, 'FeatureType').map((block): WfsFeatureType | undefined => {
    const name = childText(block, 'Name');
    if (!name) return undefined;
    const crs = ['DefaultCRS', 'DefaultSRS', 'OtherCRS', 'OtherSRS']
      .flatMap((tag) => blocks(block, tag).map((crsBlock) => childText(crsBlock, tag)))
      .filter((value): value is string => Boolean(value));
    return { name, crs };
  }).filter((value): value is WfsFeatureType => value !== undefined);
  if (featureTypes.length === 0) throw new AdapterError('schema', 'WFS capabilities advertises no feature types');

  return {
    version,
    outputFormats,
    featureTypes,
  };
}

function parseHits(xml: string): number {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AdapterError('schema', 'WFS hits response may not contain a DTD or entity declaration');
  const attributes = openingAttributes(xml, 'FeatureCollection');
  const raw = attribute(attributes, 'numberMatched') ?? attribute(attributes, 'numberOfFeatures');
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AdapterError('schema', `WFS hits response has no non-negative feature count (received '${raw ?? 'missing'}')`);
  }
  return count;
}

function requestUrl(endpoint: string, params: Record<string, string | number>): URL {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function requestCrs(layer: LayerDescriptor): string {
  const srsName = textParam(layer, 'wfs_srs_name');
  const normalized = normalizeCrs(srsName);
  if (normalized !== layer.crs) {
    throw new AdapterError('schema', `layer '${layer.id}' pins crs '${layer.crs}' but params.wfs_srs_name resolves to '${normalized ?? 'unknown'}'`);
  }
  return srsName;
}

function bboxInLayerCrs(layer: LayerDescriptor, bbox: BBox): BBox {
  if (layer.crs === 'EPSG:4326') return bbox;
  const target = CRS_REGISTRY[layer.crs];
  const source = CRS_REGISTRY['EPSG:4326'];
  if (!target || !source) throw new AdapterError('schema', `no pinned projection is registered for '${layer.crs}'`);
  const corners = [
    [bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]],
  ].map((point) => proj4(source, target, point) as [number, number]);
  return [
    Math.min(...corners.map((point) => point[0])),
    Math.min(...corners.map((point) => point[1])),
    Math.max(...corners.map((point) => point[0])),
    Math.max(...corners.map((point) => point[1])),
  ];
}

function wfsBbox(layer: LayerDescriptor, bbox: BBox, srsName: string): string {
  const [minX, minY, maxX, maxY] = bboxInLayerCrs(layer, bbox);
  const order = layer.params?.['wfs_axis_order'];
  if (order === 'xy') return `${minX},${minY},${maxX},${maxY},${srsName}`;
  if (order === 'yx') return `${minY},${minX},${maxY},${maxX},${srsName}`;
  throw new AdapterError('schema', `layer '${layer.id}' needs params.wfs_axis_order as 'xy' or 'yx'`);
}

function pointBBox(at: LonLat, radiusM: number): BBox {
  const latDegrees = radiusM / 111_320;
  const lonDegrees = radiusM / Math.max(1, 111_320 * Math.cos((at[1] * Math.PI) / 180));
  return [at[0] - lonDegrees, at[1] - latDegrees, at[0] + lonDegrees, at[1] + latDegrees];
}

function transformPosition(layer: LayerDescriptor, position: unknown): number[] {
  if (!Array.isArray(position) || position.length < 2 || typeof position[0] !== 'number' || typeof position[1] !== 'number') {
    throw new AdapterError('schema', 'WFS GeoJSON contains an invalid coordinate position');
  }
  const extras = position.slice(2);
  let lonLat: [number, number];
  if (layer.crs === 'EPSG:4326') {
    lonLat = [position[0], position[1]];
  } else {
    const source = CRS_REGISTRY[layer.crs];
    const target = CRS_REGISTRY['EPSG:4326'];
    if (!source || !target) throw new AdapterError('schema', `no pinned projection is registered for '${layer.crs}'`);
    lonLat = proj4(source, target, [position[0], position[1]]) as [number, number];
  }
  if (!lonLat.every(Number.isFinite) || lonLat[0] < -180 || lonLat[0] > 180 || lonLat[1] < -90 || lonLat[1] > 90) {
    throw new AdapterError('schema', `WFS GeoJSON coordinate is outside longitude/latitude bounds (${lonLat.join(', ')})`);
  }
  return [lonLat[0], lonLat[1], ...extras];
}

function transformCoordinates(layer: LayerDescriptor, coordinates: unknown): unknown {
  if (!Array.isArray(coordinates)) throw new AdapterError('schema', 'WFS GeoJSON geometry has invalid coordinates');
  if (typeof coordinates[0] === 'number') return transformPosition(layer, coordinates);
  return coordinates.map((coordinate) => transformCoordinates(layer, coordinate));
}

function transformGeometry(layer: LayerDescriptor, raw: unknown): GeoJsonGeometry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AdapterError('schema', 'WFS GeoJSON feature has no geometry object');
  }
  const geometry = raw as GeoJsonGeometry;
  if (typeof geometry.type !== 'string') throw new AdapterError('schema', 'WFS GeoJSON geometry has no type');
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) throw new AdapterError('schema', 'WFS GeoJSON geometry collection has no geometries');
    return { ...geometry, geometries: geometry.geometries.map((child) => transformGeometry(layer, child)) };
  }
  return { ...geometry, coordinates: transformCoordinates(layer, geometry.coordinates) };
}

function labelFields(layer: LayerDescriptor): string[] {
  const value = layer.params?.['wfs_label_fields'];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((field) => typeof field === 'string' && field.length > 0)) {
    throw new AdapterError('schema', `layer '${layer.id}' needs params.wfs_label_fields as an array of field names`);
  }
  return value;
}

function parseFeatureCollection(layer: LayerDescriptor, raw: unknown): GeoJsonFeature[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AdapterError('schema', 'WFS response is not a GeoJSON object');
  }
  const collection = raw as { type?: unknown; features?: unknown; crs?: unknown };
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new AdapterError('schema', 'WFS response is not a GeoJSON FeatureCollection');
  }
  const fields = labelFields(layer);
  return collection.features.map((rawFeature): GeoJsonFeature => {
    if (typeof rawFeature !== 'object' || rawFeature === null || Array.isArray(rawFeature)) {
      throw new AdapterError('schema', 'WFS GeoJSON contains a non-object feature');
    }
    const feature = rawFeature as Partial<GeoJsonFeature>;
    if (feature.type !== 'Feature' || typeof feature.properties !== 'object' || feature.properties === null || Array.isArray(feature.properties)) {
      throw new AdapterError('schema', 'WFS GeoJSON contains an invalid feature');
    }
    const properties = { ...feature.properties };
    const label = fields
      .map((field) => properties[field])
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .map(String)
      .filter((value) => value.length > 0)
      .join(' · ');
    if (label && typeof properties['name'] !== 'string') properties['name'] = label;
    if (feature.id !== undefined && properties['wfs_id'] === undefined) properties['wfs_id'] = String(feature.id);
    return {
      ...feature,
      type: 'Feature',
      geometry: transformGeometry(layer, feature.geometry),
      properties,
    } as GeoJsonFeature;
  });
}

function sameFormat(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export class WfsAdapter implements Adapter {
  private readonly capabilitiesCache = new Map<string, Promise<WfsCapabilities>>();

  private async fetchText(url: URL, io: IO, accept: string): Promise<string> {
    let response: Response;
    try {
      response = await io.fetch(url, {
        method: 'GET',
        headers: { Accept: accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new AdapterError('timeout', `WFS request exceeded ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
    if (!response.ok) {
      const kind = response.status === 429 ? 'rate_limited' : 'upstream';
      throw new AdapterError(kind, `WFS endpoint returned ${response.status}`);
    }
    return response.text();
  }

  private capabilities(layer: LayerDescriptor, io: IO): Promise<WfsCapabilities> {
    const version = textParam(layer, 'wfs_version');
    const url = requestUrl(layer.endpoint, { service: 'WFS', request: 'GetCapabilities', version });
    const key = url.href;
    const cached = this.capabilitiesCache.get(key);
    if (cached) return cached;
    const pending = this.fetchText(url, io, 'application/xml,text/xml;q=0.9')
      .then(parseCapabilities)
      .catch((error) => {
        this.capabilitiesCache.delete(key);
        throw error;
      });
    this.capabilitiesCache.set(key, pending);
    return pending;
  }

  private async profile(layer: LayerDescriptor, io: IO): Promise<WfsProfile> {
    const capabilities = await this.capabilities(layer, io);
    const pinnedVersion = textParam(layer, 'wfs_version');
    if (capabilities.version !== pinnedVersion) {
      throw new AdapterError('schema', `WFS returned version '${capabilities.version}', expected '${pinnedVersion}'`);
    }
    const typeName = textParam(layer, 'wfs_type_name');
    const featureType = capabilities.featureTypes.find((candidate) => candidate.name === typeName);
    if (!featureType) throw new AdapterError('schema', `WFS capabilities does not advertise feature type '${typeName}'`);

    const srsName = requestCrs(layer);
    const requestedCrs = normalizeCrs(srsName);
    if (!featureType.crs.some((candidate) => normalizeCrs(candidate) === requestedCrs)) {
      throw new AdapterError('schema', `WFS feature type '${typeName}' does not advertise requested CRS '${srsName}'`);
    }

    const configuredFormat = layer.params?.['wfs_output_format'];
    const outputFormat = typeof configuredFormat === 'string'
      ? capabilities.outputFormats.find((candidate) => sameFormat(candidate, configuredFormat))
      : GEOJSON_FORMATS.map((preferred) => capabilities.outputFormats.find((candidate) => sameFormat(candidate, preferred))).find(Boolean);
    if (!outputFormat) throw new AdapterError('schema', `WFS feature type '${typeName}' advertises no supported GeoJSON output format`);
    return { capabilities, outputFormat, featureType, srsName };
  }

  private getFeatureUrl(layer: LayerDescriptor, profile: WfsProfile, bbox: BBox, extra: Record<string, string | number>): URL {
    const typeKey = profile.capabilities.version === '2.0.0' ? 'typeNames' : 'typeName';
    return requestUrl(layer.endpoint, {
      service: 'WFS',
      version: profile.capabilities.version,
      request: 'GetFeature',
      [typeKey]: profile.featureType.name,
      srsName: profile.srsName,
      bbox: wfsBbox(layer, bbox, profile.srsName),
      ...extra,
    });
  }

  private async features(layer: LayerDescriptor, bbox: BBox, io: IO): Promise<{ features: GeoJsonFeature[]; truncated: boolean }> {
    const profile = await this.profile(layer, io);
    const cap = featureCap(layer);
    const limitKey = profile.capabilities.version === '2.0.0' ? 'count' : 'maxFeatures';
    const url = this.getFeatureUrl(layer, profile, bbox, {
      outputFormat: profile.outputFormat,
      [limitKey]: cap + 1,
    });
    const text = await this.fetchText(url, io, 'application/geo+json,application/json;q=0.9');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AdapterError('schema', 'WFS endpoint did not return valid GeoJSON');
    }
    const features = parseFeatureCollection(layer, json);
    return { features: features.slice(0, cap), truncated: features.length > cap };
  }

  private async count(layer: LayerDescriptor, bbox: BBox, io: IO): Promise<number> {
    const profile = await this.profile(layer, io);
    const url = this.getFeatureUrl(layer, profile, bbox, { resultType: 'hits' });
    return parseHits(await this.fetchText(url, io, 'application/xml,text/xml;q=0.9'));
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const radius = numberParam(layer, 'point_radius_m', DEFAULT_POINT_RADIUS_M, 1, 10_000);
    const result = await this.features(layer, pointBBox(at, radius), io);
    if (result.features.length === 0) return { kind: 'empty' };
    return {
      kind: 'ok',
      value: { kind: 'features', ...result },
      aggregation: 'nearest',
      basis: 'nearest',
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const bbox = tileToBBox(tile);
    const primary = layer.aggregation?.primary ?? 'count';
    if (primary === 'count') {
      const count = await this.count(layer, bbox, io);
      if (count === 0) return { kind: 'empty' };
      return {
        kind: 'ok',
        value: { kind: 'scalar', value: count },
        aggregation: 'count',
        basis: 'aggregated',
      };
    }
    if (primary === 'feature_list') {
      const result = await this.features(layer, bbox, io);
      if (result.features.length === 0) return { kind: 'empty' };
      return {
        kind: 'ok',
        value: { kind: 'features', ...result },
        aggregation: 'feature_list',
        basis: 'aggregated',
      };
    }
    throw new AdapterError('schema', `unsupported WFS tile aggregation '${primary}'`);
  }
}
