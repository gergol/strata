import type { LayerDescriptor } from '@strata/core';

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

  if (layer.browser_access === 'materialized') {
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
