/** Generic A4 JSON point sampler with an explicitly sampled tile probe grid. */
import { AdapterError, type Adapter, type AdapterOutcome } from '../adapter.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import { applyScale, isNodata } from '../units.js';
import { tileToBBox, type LonLat, type Tile } from '../tile.js';

interface PointSampleConfig {
  latitudeParam: string;
  longitudeParam: string;
  query: Record<string, string>;
  valuePath: string;
  timePath?: string;
  sampleGrid: number;
  batchCoordinates: boolean;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdapterError('schema', message);
  }
  return value as Record<string, unknown>;
}

function pathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) current = record(current, `response path '${path}' is missing`)[segment];
  return current;
}

function config(layer: LayerDescriptor): PointSampleConfig {
  const params = layer.params ?? {};
  const latitudeParam = params['latitude_param'] ?? 'latitude';
  const longitudeParam = params['longitude_param'] ?? 'longitude';
  const valuePath = params['value_path'];
  const timePath = params['time_path'];
  const rawQuery = params['query'] ?? {};
  const sampleGrid = params['sample_grid'] ?? 3;
  const batchCoordinates = params['batch_coordinates'] ?? false;
  if (typeof latitudeParam !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(latitudeParam)) {
    throw new AdapterError('schema', 'params.latitude_param must be a query-parameter name');
  }
  if (typeof longitudeParam !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(longitudeParam)) {
    throw new AdapterError('schema', 'params.longitude_param must be a query-parameter name');
  }
  if (typeof valuePath !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(valuePath)) {
    throw new AdapterError('schema', 'params.value_path must be a dotted JSON path');
  }
  if (timePath !== undefined && (typeof timePath !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(timePath))) {
    throw new AdapterError('schema', 'params.time_path must be a dotted JSON path');
  }
  if (typeof sampleGrid !== 'number' || !Number.isInteger(sampleGrid) || sampleGrid < 1 || sampleGrid > 5 || sampleGrid % 2 === 0) {
    throw new AdapterError('schema', 'params.sample_grid must be an odd integer from 1 to 5');
  }
  if (typeof batchCoordinates !== 'boolean') {
    throw new AdapterError('schema', 'params.batch_coordinates must be boolean');
  }
  const queryRecord = record(rawQuery, 'params.query must be an object');
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(queryRecord)) {
    if (!/^[A-Za-z_][\w.-]*$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new AdapterError('schema', 'params.query values must be string, number, or boolean scalars');
    }
    query[key] = String(value);
  }
  return {
    latitudeParam,
    longitudeParam,
    query,
    valuePath,
    ...(typeof timePath === 'string' ? { timePath } : {}),
    sampleGrid,
    batchCoordinates,
  };
}

function requestUrl(layer: LayerDescriptor, cfg: PointSampleConfig, points: LonLat[]): string {
  const url = new URL(layer.endpoint);
  for (const [key, value] of Object.entries(cfg.query)) url.searchParams.set(key, value);
  url.searchParams.set(cfg.latitudeParam, points.map((point) => point[1]).join(','));
  url.searchParams.set(cfg.longitudeParam, points.map((point) => point[0]).join(','));
  return url.toString();
}

function samplePoints(tile: Tile, size: number): LonLat[] {
  const [west, south, east, north] = tileToBBox(tile);
  const points: LonLat[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      points.push([
        west + ((column + 0.5) / size) * (east - west),
        south + ((row + 0.5) / size) * (north - south),
      ]);
    }
  }
  return points;
}

function parseTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new AdapterError('schema', `response time at '${path}' must be an ISO string or Unix timestamp`);
  }
  const milliseconds = typeof value === 'number' ? value * 1000 : Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  if (!Number.isFinite(milliseconds)) throw new AdapterError('schema', `response time at '${path}' is invalid`);
  return new Date(milliseconds).toISOString();
}

function parseSample(layer: LayerDescriptor, cfg: PointSampleConfig, payload: unknown): { value: number; time?: string } | null {
  const raw = pathValue(payload, cfg.valuePath);
  if (raw === null || raw === undefined || (typeof raw === 'number' && isNodata(raw, layer.nodata))) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new AdapterError('schema', `response value at '${cfg.valuePath}' must be a finite number`);
  }
  return {
    value: applyScale(raw, layer.scale_factor as number),
    ...(cfg.timePath ? { time: parseTimestamp(pathValue(payload, cfg.timePath), cfg.timePath) } : {}),
  };
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
      throw new AdapterError('timeout', `point-sample request timed out: ${error.message}`);
    }
    throw error;
  }
  if (response.status === 429) throw new AdapterError('rate_limited', 'point-sample provider returned 429');
  if (!response.ok) throw new AdapterError('upstream', `point-sample provider returned ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new AdapterError('schema', `point-sample response is not JSON: ${(error as Error).message}`);
  }
}

export class PointSampleAdapter implements Adapter {
  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const cfg = config(layer);
    const sample = parseSample(layer, cfg, await fetchJson(io, requestUrl(layer, cfg, [at])));
    if (!sample) return { kind: 'empty' };
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: sample.value },
      aggregation: 'latest',
      basis: 'sampled',
      ...(sample.time ? { sourceUpdatedAt: sample.time } : {}),
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const cfg = config(layer);
    const points = samplePoints(tile, cfg.sampleGrid);
    const payloads = cfg.batchCoordinates
      ? await fetchJson(io, requestUrl(layer, cfg, points)).then((payload) => {
          if (!Array.isArray(payload) || payload.length !== points.length) {
            throw new AdapterError('schema', `batched point-sample response must contain ${points.length} items`);
          }
          return payload;
        })
      : await Promise.all(points.map((point) => fetchJson(io, requestUrl(layer, cfg, [point]))));
    const samples = payloads.map((payload) => parseSample(layer, cfg, payload)).filter((sample) => sample !== null);
    if (samples.length === 0) return { kind: 'empty' };
    const mean = samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length;
    const latest = samples.map((sample) => sample.time).filter((time): time is string => time !== undefined).sort().at(-1);
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: mean },
      aggregation: 'mean',
      basis: 'sampled',
      ...(latest ? { sourceUpdatedAt: latest } : {}),
    };
  }
}
