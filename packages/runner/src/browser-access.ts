import { lonLatToTile, type LayerDescriptor, type Tile } from '@strata/core';

export const APP_ORIGIN = 'https://gergol.github.io';

export interface FetchObservation {
  url: string;
  status: number;
  accessControlAllowOrigin: string | null;
}

export interface BrowserAccessResult {
  ok: boolean;
  note?: string;
}

function corsAllows(observation: FetchObservation): boolean {
  try {
    if (new URL(observation.url).origin === APP_ORIGIN) return true;
  } catch {
    return false;
  }
  return observation.accessControlAllowOrigin === '*' || observation.accessControlAllowOrigin === APP_ORIGIN;
}

function result(ok: boolean, note?: string): BrowserAccessResult {
  return note ? { ok, note } : { ok };
}

function firstMaterializedRegion(layer: LayerDescriptor): string {
  const regions = layer.params?.['materialize_regions'];
  if (!Array.isArray(regions) || typeof regions[0] !== 'string') {
    throw new Error(`layer '${layer.id}' needs params.materialize_regions for browser verification`);
  }
  return regions[0];
}

const WEB_MERCATOR_HALF_WORLD = 20_037_508.342789244;

function tileMercatorBBox(tile: Tile): string {
  const matrixSize = 2 ** tile.z;
  const tileSpan = (2 * WEB_MERCATOR_HALF_WORLD) / matrixSize;
  return [
    -WEB_MERCATOR_HALF_WORLD + tile.x * tileSpan,
    WEB_MERCATOR_HALF_WORLD - (tile.y + 1) * tileSpan,
    -WEB_MERCATOR_HALF_WORLD + (tile.x + 1) * tileSpan,
    WEB_MERCATOR_HALF_WORLD - tile.y * tileSpan,
  ].join(',');
}

export function overlayProbeUrl(layer: LayerDescriptor, now: () => number = Date.now): string {
  const overlay = layer.overlay;
  if (!overlay) throw new Error(`layer '${layer.id}' has no overlay rendering contract`);
  const zoom = Math.min(overlay.max_zoom, Math.max(overlay.min_zoom, 12));
  const tile = lonLatToTile(layer.health_assertion.at, zoom);
  const date = new Date(now() + (overlay.time?.default_offset_days ?? 0) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return overlay.tiles[0]
    .replaceAll('{date}', date)
    .replaceAll('{z}', String(tile.z))
    .replaceAll('{x}', String(tile.x))
    .replaceAll('{y}', String(tile.y))
    .replaceAll('{bbox-epsg-3857}', tileMercatorBBox(tile));
}

export async function checkBrowserAccess(
  layer: LayerDescriptor,
  observations: FetchObservation[],
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<BrowserAccessResult> {
  if (layer.browser_access === 'blocked') return result(false, 'descriptor declares browser access blocked');

  const denied = observations.find((observation) => !corsAllows(observation));
  if (denied) {
    return result(
      false,
      `browser CORS denied for ${new URL(denied.url).origin} from ${APP_ORIGIN} (access-control-allow-origin=${denied.accessControlAllowOrigin ?? 'missing'})`,
    );
  }

  if (layer.adapter === 'cog') {
    const response = await fetchImpl(layer.endpoint, {
      headers: { Origin: APP_ORIGIN, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(30_000),
    });
    const observation: FetchObservation = {
      url: layer.endpoint,
      status: response.status,
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    };
    await response.body?.cancel();
    if (response.status !== 206 || !corsAllows(observation)) {
      return result(false, `browser range/CORS probe failed (${response.status}, access-control-allow-origin=${observation.accessControlAllowOrigin ?? 'missing'})`);
    }
  }

  if (layer.overlay) {
    const url = overlayProbeUrl(layer);
    const response = await fetchImpl(url, {
      headers: { Origin: APP_ORIGIN },
      signal: AbortSignal.timeout(30_000),
    });
    const observation: FetchObservation = {
      url,
      status: response.status,
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    };
    const contentType = response.headers.get('content-type') ?? '';
    await response.body?.cancel();
    if (!response.ok || !contentType.startsWith('image/') || !corsAllows(observation)) {
      return result(
        false,
        `overlay tile browser probe failed (${response.status}, content-type=${contentType || 'missing'}, access-control-allow-origin=${observation.accessControlAllowOrigin ?? 'missing'})`,
      );
    }
  }

  if (layer.browser_access === 'materialized') {
    if (layer.params?.['materialization_kind'] === 'static_index') {
      const url = layer.endpoint;
      if (new URL(url).origin !== APP_ORIGIN) {
        return result(false, `static materialized endpoint must be same-origin with ${APP_ORIGIN}`);
      }
      const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return result(false, `static materialized endpoint returned ${response.status}`);
      const payload: unknown = await response.json();
      if (!Array.isArray(payload) || payload.length === 0) {
        return result(false, 'static materialized endpoint must contain a non-empty record array');
      }
      return result(true);
    }
    const region = firstMaterializedRegion(layer);
    const url = layer.endpoint.replaceAll('{{region}}', region);
    if (new URL(url).origin !== APP_ORIGIN) {
      return result(false, `materialized endpoint must be same-origin with ${APP_ORIGIN}`);
    }
    const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return result(false, `materialized endpoint returned ${response.status}`);
    const envelope = (await response.json()) as { materialized_at?: unknown };
    const materializedAt = typeof envelope.materialized_at === 'string' ? Date.parse(envelope.materialized_at) : NaN;
    const maxAge = Number(layer.params?.['max_materialized_age_ms']);
    if (!Number.isFinite(materializedAt) || !Number.isFinite(maxAge) || maxAge <= 0) {
      return result(false, 'materialized endpoint has no valid freshness contract');
    }
    const age = now() - materializedAt;
    if (age < -10 * 60 * 1000 || age > maxAge) {
      return result(false, `materialized endpoint is stale (${age}ms old; limit ${maxAge}ms)`);
    }
  }

  return result(true);
}
