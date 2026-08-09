/**
 * A1 — BBOX-native vector adapter, first target Overpass (plan M0.4).
 *
 * The descriptor supplies an Overpass QL body template with a `{{spatial}}`
 * placeholder; the adapter substitutes a bbox filter (tile mode) or an
 * around-filter (point mode) and wraps it in `[out:json]`. All requests go
 * through the limiter-wrapped io.fetch — Overpass politeness (R7.3/R7.6) is
 * enforced below this code, configured by the descriptor's rate_limit.
 *
 * Point mode returns the nearby features labelled basis='nearest' (R4.4:
 * reaching beyond the exact coordinate is said out loud, never implied).
 * Tile mode returns the declared aggregation: count, density, or a capped
 * feature list with an explicit truncation flag.
 */
import type { Adapter, AdapterOutcome } from '../adapter.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import type { LonLat, Tile } from '../tile.js';
import { tileToBBox } from '../tile.js';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

const DEFAULT_POINT_RADIUS_M = 300;
const DEFAULT_FEATURE_CAP = 200;

function queryTemplate(layer: LayerDescriptor): string {
  const template = layer.params?.['overpass_query'];
  if (typeof template !== 'string' || !template.includes('{{spatial}}')) {
    throw new Error(
      `layer '${layer.id}' needs params.overpass_query containing a {{spatial}} placeholder`,
    );
  }
  return template;
}

function toFeature(el: OverpassElement): unknown {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  return {
    type: 'Feature',
    geometry: lat !== undefined && lon !== undefined ? { type: 'Point', coordinates: [lon, lat] } : null,
    properties: { ...el.tags, osm_type: el.type, osm_id: el.id },
  };
}

export class OverpassAdapter implements Adapter {
  private async run(layer: LayerDescriptor, spatial: string, io: IO): Promise<OverpassElement[]> {
    const cap = Number(layer.params?.['feature_cap'] ?? DEFAULT_FEATURE_CAP);
    const body = queryTemplate(layer).replaceAll('{{spatial}}', spatial);
    const query = `[out:json][timeout:25];${body}out center ${cap + 1};`;
    const res = await io.fetch(layer.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
    const json = (await res.json()) as OverpassResponse;
    return json.elements ?? [];
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const radius = Number(layer.params?.['point_radius_m'] ?? DEFAULT_POINT_RADIUS_M);
    const elements = await this.run(layer, `(around:${radius},${at[1]},${at[0]})`, io);
    if (elements.length === 0) return { kind: 'empty' };
    const cap = Number(layer.params?.['feature_cap'] ?? DEFAULT_FEATURE_CAP);
    return {
      kind: 'ok',
      value: {
        kind: 'features',
        features: elements.slice(0, cap).map(toFeature),
        truncated: elements.length > cap,
      },
      aggregation: 'nearest',
      basis: 'nearest',
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const [w, s, e, n] = tileToBBox(tile);
    const elements = await this.run(layer, `(${s},${w},${n},${e})`, io);
    if (elements.length === 0) return { kind: 'empty' };
    const cap = Number(layer.params?.['feature_cap'] ?? DEFAULT_FEATURE_CAP);
    const primary = layer.aggregation?.primary ?? 'count';
    if (primary === 'feature_list') {
      return {
        kind: 'ok',
        value: {
          kind: 'features',
          features: elements.slice(0, cap).map(toFeature),
          truncated: elements.length > cap,
        },
        aggregation: 'feature_list',
        basis: 'aggregated',
      };
    }
    // count (and density once tile areas are surfaced; count is the honest default)
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: Math.min(elements.length, cap + 1) },
      aggregation: 'count',
      basis: 'aggregated',
    };
  }
}
