/**
 * A3 — region lookup adapter (plan M0.5). Coordinates resolve to a region
 * polygon from a static region pack; data is then fetched by region id from
 * an endpoint template. This converts region-keyed data (bidding zones, NUTS,
 * warning regions) into map-queryable layers.
 *
 * Response parsing: a region API's JSON shape is upstream-specific, so the
 * descriptor declares a named format from the small registry below. This is
 * the honest pressure point of R6.1 ("no layer-specific logic outside its
 * adapter") — formats are adapter-level parsers selected by configuration,
 * and the M0.8 exit review owns the call on whether this needs to become a
 * declarative extraction language instead.
 */
import type { Adapter, AdapterOutcome } from '../adapter.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { HistogramClass } from '../envelope.js';
import type { GeoJsonFeatureCollection } from '../geometry.js';
import { findContainingFeature } from '../geometry.js';
import type { IO } from '../io.js';
import type { LonLat, Tile } from '../tile.js';
import { tileToBBox } from '../tile.js';

type FormatParser = (body: unknown) => AdapterOutcome;

interface MaterializedEnvelope {
  schema_version: 1;
  materialized_at: string;
  source_updated_at: string;
  payload: unknown;
}

/** Series in /public_power that are loads or derived ratios, not generation. */
const NON_GENERATION_SERIES = /^(load|residual load|renewable share|cross border)/i;

function unwrapMaterialized(body: unknown): { payload: unknown; sourceUpdatedAt?: string } {
  if (typeof body !== 'object' || body === null || !('schema_version' in body)) return { payload: body };
  const envelope = body as Partial<MaterializedEnvelope>;
  if (
    envelope.schema_version !== 1 ||
    typeof envelope.materialized_at !== 'string' ||
    typeof envelope.source_updated_at !== 'string' ||
    !('payload' in envelope)
  ) {
    throw new Error('invalid materialized layer envelope');
  }
  if (!Number.isFinite(Date.parse(envelope.materialized_at)) || !Number.isFinite(Date.parse(envelope.source_updated_at))) {
    throw new Error('invalid timestamp in materialized layer envelope');
  }
  return { payload: envelope.payload, sourceUpdatedAt: envelope.source_updated_at };
}

/** Energy-Charts /public_power: latest non-null values per production type → share histogram. */
export function parseEnergyChartsPublicPower(body: unknown): AdapterOutcome {
  const { payload, sourceUpdatedAt } = unwrapMaterialized(body);
  if (typeof payload !== 'object' || payload === null) throw new Error('Energy-Charts response must be an object');
  const data = payload as { production_types?: unknown };
  if (!Array.isArray(data.production_types)) throw new Error('Energy-Charts response missing production_types');
  const parsed = data.production_types.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('invalid Energy-Charts production series');
    const series = candidate as { name?: unknown; data?: unknown };
    if (typeof series.name !== 'string' || !Array.isArray(series.data)) {
      throw new Error('invalid Energy-Charts production series');
    }
    if (!series.data.every((value) => value === null || typeof value === 'number')) {
      throw new Error(`invalid Energy-Charts data values for '${series.name}'`);
    }
    return { name: series.name, data: series.data as Array<number | null> };
  });
  const series = parsed.filter((s) => !NON_GENERATION_SERIES.test(s.name));
  if (series.length === 0) return { kind: 'empty' };
  // Latest index where at least one series has a value.
  const len = Math.max(...series.map((s) => s.data.length));
  let idx = -1;
  for (let i = len - 1; i >= 0 && idx < 0; i--) {
    if (series.some((s) => s.data[i] !== null && s.data[i] !== undefined)) idx = i;
  }
  if (idx < 0) return { kind: 'empty' };
  const values = series
    .map((s) => ({ name: s.name, mw: s.data[idx] ?? 0 }))
    .filter((v) => typeof v.mw === 'number' && v.mw > 0);
  const total = values.reduce((sum, v) => sum + v.mw, 0);
  if (total <= 0) return { kind: 'empty' };
  const classes: HistogramClass[] = values
    .map((v) => ({ label: v.name, share: v.mw / total }))
    .sort((a, b) => b.share - a.share);
  return {
    kind: 'ok',
    value: { kind: 'histogram', classes },
    aggregation: 'histogram',
    basis: 'aggregated',
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

const FORMATS: Record<string, FormatParser> = {
  energy_charts_public_power: parseEnergyChartsPublicPower,
};

export class RegionAdapter implements Adapter {
  private readonly packs = new Map<string, Promise<GeoJsonFeatureCollection>>();

  private pack(url: string, io: IO): Promise<GeoJsonFeatureCollection> {
    let cached = this.packs.get(url);
    if (!cached) {
      cached = io
        .fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`region pack ${url} returned ${res.status}`);
          return res.json() as Promise<GeoJsonFeatureCollection>;
        })
        .catch((e) => {
          this.packs.delete(url); // don't cache failures
          throw e;
        });
      this.packs.set(url, cached);
    }
    return cached;
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const regionsUrl = layer.params?.['regions_url'];
    const format = layer.params?.['format'];
    if (typeof regionsUrl !== 'string') throw new Error(`layer '${layer.id}' needs params.regions_url`);
    const parser = FORMATS[String(format)];
    if (!parser) throw new Error(`layer '${layer.id}' declares unknown format '${String(format)}'`);
    if (!layer.endpoint.includes('{{region}}')) {
      throw new Error(`layer '${layer.id}' endpoint must contain a {{region}} placeholder`);
    }

    const fc = await this.pack(regionsUrl, io);
    const feature = findContainingFeature(at, fc);
    if (!feature) return { kind: 'no_coverage' }; // R5.3 case 1: territory not in any region
    const regionId = String(feature.properties['id'] ?? '');
    if (!regionId) throw new Error(`region feature without an 'id' property in ${regionsUrl}`);

    const res = await io.fetch(layer.endpoint.replaceAll('{{region}}', regionId));
    if (!res.ok) throw new Error(`region endpoint returned ${res.status} for '${regionId}'`);
    const outcome = parser(await res.json());
    return outcome.kind === 'ok' ? { ...outcome, region: regionId } : outcome;
  }

  /** A tile's answer is its containing region's answer, resolved at the tile centre. */
  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const [w, s, e, n] = tileToBBox(tile);
    return this.point(layer, [(w + e) / 2, (s + n) / 2], io);
  }
}
