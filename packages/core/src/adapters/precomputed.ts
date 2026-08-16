/** A6 adapter for compact, same-origin indexes produced from already tile-shaped bulk data. */
import proj4 from 'proj4';
import { AdapterError, type Adapter, type AdapterOutcome } from '../adapter.js';
import { CRS_REGISTRY } from '../crs.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import { lonLatToTile, tileToQuadkey, type LonLat, type Tile } from '../tile.js';

interface IndexedRecord {
  key: string;
  [field: string]: unknown;
}

interface Config {
  keyScheme: 'quadkey_z16' | 'epsg3035_grid_1km';
  valueField: string;
  weightField?: string;
  recordsPath?: string;
  sourceUpdatedAt?: string;
}

function config(layer: LayerDescriptor): Config {
  const keyScheme = layer.params?.['key_scheme'];
  const valueField = layer.params?.['value_field'];
  const weightField = layer.params?.['weight_field'];
  const recordsPath = layer.params?.['records_path'];
  const sourceUpdatedAt = layer.params?.['source_updated_at'];
  if (keyScheme !== 'quadkey_z16' && keyScheme !== 'epsg3035_grid_1km') {
    throw new AdapterError('schema', "params.key_scheme must be 'quadkey_z16' or 'epsg3035_grid_1km'");
  }
  if (typeof valueField !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(valueField)) {
    throw new AdapterError('schema', 'params.value_field must be a field name');
  }
  if (weightField !== undefined && (typeof weightField !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(weightField))) {
    throw new AdapterError('schema', 'params.weight_field must be a field name');
  }
  if (recordsPath !== undefined && (typeof recordsPath !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(recordsPath))) {
    throw new AdapterError('schema', 'params.records_path must be a dotted JSON path');
  }
  if (sourceUpdatedAt !== undefined && (
    typeof sourceUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(sourceUpdatedAt))
  )) {
    throw new AdapterError('schema', 'params.source_updated_at must be an ISO timestamp');
  }
  return {
    keyScheme,
    valueField,
    ...(typeof weightField === 'string' ? { weightField } : {}),
    ...(typeof recordsPath === 'string' ? { recordsPath } : {}),
    ...(typeof sourceUpdatedAt === 'string' ? { sourceUpdatedAt: new Date(sourceUpdatedAt).toISOString() } : {}),
  };
}

function nested(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new AdapterError('schema', `precomputed records path '${path}' is missing`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateRecords(value: unknown): IndexedRecord[] {
  if (!Array.isArray(value)) throw new AdapterError('schema', 'precomputed asset must contain a record array');
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || typeof (item as { key?: unknown }).key !== 'string') {
      throw new AdapterError('schema', `precomputed record ${index} must be an object with a string key`);
    }
    return item as IndexedRecord;
  });
}

function numeric(record: IndexedRecord, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdapterError('schema', `precomputed field '${field}' must be finite numeric data`);
  }
  return value;
}

function pointKey(scheme: Config['keyScheme'], at: LonLat): string {
  if (scheme === 'quadkey_z16') return tileToQuadkey(lonLatToTile(at, 16));
  const [x, y] = proj4(
    CRS_REGISTRY['EPSG:4326'] as string,
    CRS_REGISTRY['EPSG:3035'] as string,
    at,
  ) as [number, number];
  const xLlc = Math.floor(x / 1000) * 1000;
  const yLlc = Math.floor(y / 1000) * 1000;
  return `CRS3035RES1000mN${yLlc}E${xLlc}`;
}

function aggregate(records: IndexedRecord[], cfg: Config): number {
  if (cfg.weightField) {
    let weighted = 0;
    let weight = 0;
    for (const record of records) {
      const nextWeight = numeric(record, cfg.weightField);
      weighted += numeric(record, cfg.valueField) * nextWeight;
      weight += nextWeight;
    }
    if (weight <= 0) throw new AdapterError('schema', `precomputed weight field '${cfg.weightField}' sums to zero`);
    return weighted / weight;
  }
  return records.reduce((sum, record) => sum + numeric(record, cfg.valueField), 0) / records.length;
}

export class PrecomputedAdapter implements Adapter {
  private readonly assets = new Map<string, Promise<IndexedRecord[]>>();

  private records(layer: LayerDescriptor, io: IO, cfg: Config): Promise<IndexedRecord[]> {
    const cached = this.assets.get(layer.endpoint);
    if (cached) return cached;
    const request = (async () => {
      const response = await io.fetch(layer.endpoint, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new AdapterError('upstream', `precomputed asset returned ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new AdapterError('schema', `precomputed asset is not JSON: ${(error as Error).message}`);
      }
      return validateRecords(cfg.recordsPath ? nested(payload, cfg.recordsPath) : payload);
    })();
    this.assets.set(layer.endpoint, request);
    request.catch(() => this.assets.delete(layer.endpoint));
    return request;
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const cfg = config(layer);
    const key = pointKey(cfg.keyScheme, at);
    const record = (await this.records(layer, io, cfg)).find((candidate) => candidate.key === key);
    if (!record) return { kind: 'empty' };
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: numeric(record, cfg.valueField) },
      aggregation: cfg.keyScheme === 'quadkey_z16' ? 'mean' : 'sum',
      basis: 'aggregated',
      ...(cfg.sourceUpdatedAt ? { sourceUpdatedAt: cfg.sourceUpdatedAt } : {}),
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const cfg = config(layer);
    if (cfg.keyScheme !== 'quadkey_z16') {
      throw new AdapterError('schema', 'tile mode is currently supported only for quadkey_z16 indexes');
    }
    const queryKey = tileToQuadkey(tile);
    const matches = (await this.records(layer, io, cfg)).filter((record) =>
      tile.z <= 16 ? record.key.startsWith(queryKey) : record.key === queryKey.slice(0, 16),
    );
    if (matches.length === 0) return { kind: 'empty' };
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: aggregate(matches, cfg) },
      aggregation: 'mean',
      basis: 'aggregated',
      ...(cfg.sourceUpdatedAt ? { sourceUpdatedAt: cfg.sourceUpdatedAt } : {}),
    };
  }
}
