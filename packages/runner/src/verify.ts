/**
 * Layer verification runner — the Actions-hosted arm of the §13 checklist and
 * an early slice of the M0.6 health runner. Runs OUTSIDE the browser, so it can
 * (and must, R7.5-as-amended) send a full identifying User-Agent.
 *
 * Modes:
 *   probe <url...>          HEAD each URL, print status/size/range/CORS headers
 *   verify <layer.yaml...>  run each layer's health_assertion through the real
 *                           pipeline against the live endpoint; exit 1 on failure
 *   sample <layer.yaml> <lon> <lat>   print raster metadata and a raw 5x5 pixel
 *                           grid around the coordinate (debugging aid)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import {
  CRS_REGISTRY,
  LocalQueryEngine,
  MemoryCache,
  RateLimiter,
  defaultAdapters,
  loadDescriptorYaml,
  loadDescriptorsYaml,
  isOk,
} from '@strata/core';
import type { IO, LayerDescriptor, LayerResult } from '@strata/core';
import { APP_ORIGIN, checkBrowserAccess, type FetchObservation } from './browser-access.js';

const USER_AGENT = 'Strata-verify/0.1 (+https://github.com/gergol/strata)';

export function makeIo(observations: FetchObservation[] = []): IO {
  const identifyingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', USER_AGENT);
    // CORS-capable servers commonly emit ACAO only when the request carries an
    // Origin header. Node does not add one, so reproduce the browser request
    // boundary explicitly before inspecting the response.
    headers.set('Origin', APP_ORIGIN);
    const response = await fetch(input, { ...init, headers });
    observations.push({
      url: String(input),
      status: response.status,
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    });
    return response;
  }) as typeof fetch;
  return {
    fetch: identifyingFetch,
    cache: new MemoryCache(() => Date.now()),
    now: () => Date.now(),
  };
}

async function probe(urls: string[]): Promise<number> {
  let failures = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT, Origin: 'https://gergol.github.io' },
      });
      const h = (name: string): string => res.headers.get(name) ?? '-';
      console.log(
        [
          `${res.status} ${url}`,
          `  content-type: ${h('content-type')}  content-length: ${h('content-length')}`,
          `  accept-ranges: ${h('accept-ranges')}  access-control-allow-origin: ${h('access-control-allow-origin')}`,
        ].join('\n'),
      );
      if (!res.ok) failures++;
    } catch (e) {
      console.log(`ERR ${url}\n  ${(e as Error).message}`);
      failures++;
    }
  }
  return failures === 0 ? 0 : 1;
}

function checkAssertion(layerFile: string, result: LayerResult, expected: unknown): boolean {
  const assertion = expected as {
    expect_range?: [number, number];
    expect_min_count?: number;
    expect_status?: 'ok' | 'empty';
  };
  const summary = result.status === 'ok'
    ? result.value.kind === 'features'
      ? { status: result.status, kind: result.value.kind, count: result.value.features.length, truncated: result.value.truncated }
      : result.value.kind === 'histogram'
        ? { status: result.status, kind: result.value.kind, classes: result.value.classes.length }
        : { status: result.status, kind: result.value.kind, value: result.value.value }
    : result;
  console.log(`${layerFile}: ${JSON.stringify(summary)}`);
  if (assertion.expect_status !== undefined) {
    return result.status === assertion.expect_status;
  }
  if (assertion.expect_range !== undefined) {
    if (!isOk(result) || result.value.kind !== 'scalar' || typeof result.value.value !== 'number') {
      return false;
    }
    const [lo, hi] = assertion.expect_range;
    return result.value.value >= lo && result.value.value <= hi;
  }
  if (assertion.expect_min_count !== undefined) {
    return isOk(result) && result.value.kind === 'features' && result.value.features.length >= assertion.expect_min_count;
  }
  return false;
}

function supportsPointHealth(descriptor: { modes: readonly string[] }): boolean {
  return descriptor.modes.includes('point');
}

function fileLayers(target: string): Array<{ label: string; descriptor: LayerDescriptor }> {
  const separator = target.lastIndexOf('#');
  const file = separator === -1 ? target : target.slice(0, separator);
  const selectedId = separator === -1 ? undefined : target.slice(separator + 1);
  const descriptors = loadDescriptorsYaml(readFileSync(file, 'utf8'));
  const selected = selectedId === undefined
    ? descriptors
    : descriptors.filter((descriptor) => descriptor.id === selectedId);
  if (selected.length === 0) {
    throw new Error(`descriptor pack '${file}' has no layer '${selectedId}'`);
  }
  return selected.map((descriptor) => ({
    label: descriptors.length === 1 ? file : `${file}#${descriptor.id}`,
    descriptor,
  }));
}

async function verify(files: string[]): Promise<number> {
  let failures = 0;
  const limiter = new RateLimiter();
  for (const file of files) {
    let layers: Array<{ label: string; descriptor: LayerDescriptor }>;
    try {
      layers = fileLayers(file);
    } catch (e) {
      console.log(`${file}: ERROR ${(e as Error).message}`);
      failures++;
      continue;
    }
    for (const { label, descriptor } of layers) {
      try {
        const observations: FetchObservation[] = [];
        const engine = new LocalQueryEngine([descriptor], {
          io: makeIo(observations),
          adapters: defaultAdapters(),
          limiter,
        });
        const result = supportsPointHealth(descriptor)
          ? await engine.point(descriptor.id, descriptor.health_assertion.at)
          : undefined;
        const livePass = result
          ? checkAssertion(label, result, descriptor.health_assertion)
          : descriptor.health_assertion.expect_overlay === true;
        const browser = await checkBrowserAccess(descriptor, observations);
        const pass = livePass && browser.ok;
        if (!result) console.log(`${label}: overlay tile canary`);
        console.log(`${label}: browser ${browser.ok ? 'PASS' : `FAIL — ${browser.note}`}`);
        console.log(`${label}: ${pass ? 'PASS' : 'FAIL'}`);
        if (!pass) failures++;
      } catch (e) {
        console.log(`${label}: ERROR ${(e as Error).message}`);
        failures++;
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

async function sample(file: string, lon: number, lat: number): Promise<number> {
  const d = loadDescriptorYaml(readFileSync(file, 'utf8'));
  const tiff = await fromUrl(d.endpoint);
  const count = await tiff.getImageCount();
  console.log(`images: ${count}`);
  const base = await tiff.getImage(0);
  const baseBB = base.getBoundingBox();
  for (let i = 0; i < count; i++) {
    const img = await tiff.getImage(i);
    const res = (baseBB[2]! - baseBB[0]!) / img.getWidth();
    console.log(`  [${i}] ${img.getWidth()}x${img.getHeight()} res=${res.toFixed(1)} (bbox shared from image 0)`);
  }
  const img = await tiff.getImage(0);
  const fd = img.fileDirectory as unknown as Record<string, unknown>;
  console.log(
    `GDAL_NODATA=${JSON.stringify(fd['GDAL_NODATA'])} BitsPerSample=${JSON.stringify(fd['BitsPerSample'])} SampleFormat=${JSON.stringify(fd['SampleFormat'])}`,
  );
  const native =
    d.crs === 'EPSG:4326'
      ? [lon, lat]
      : (proj4(CRS_REGISTRY['EPSG:4326'] as string, CRS_REGISTRY[d.crs] as string, [lon, lat]) as [number, number]);
  const [minX, minY, maxX, maxY] = img.getBoundingBox() as [number, number, number, number];
  console.log(`native: ${native[0]}, ${native[1]} (bbox x ${minX}..${maxX}, y ${minY}..${maxY})`);
  const col = Math.floor(((native[0]! - minX) / (maxX - minX)) * img.getWidth());
  const row = Math.floor(((maxY - native[1]!) / (maxY - minY)) * img.getHeight());
  console.log(`pixel: col=${col} row=${row} of ${img.getWidth()}x${img.getHeight()}`);
  const window = [Math.max(0, col - 2), Math.max(0, row - 2), col + 3, row + 3];
  const rasters = await img.readRasters({ window: window as [number, number, number, number], samples: [0] });
  const data = rasters[0] as ArrayLike<number>;
  const w = (window[2]! - window[0]!);
  for (let r = 0; r < (window[3]! - window[1]!); r++) {
    console.log(`  ${Array.from({ length: w }, (_, c) => String(data[r * w + c])).join('\t')}`);
  }
  return 0;
}

/**
 * M0.6 health mode (R8.1–R8.3, R8.5): run every layer's assertion, write
 * data/status/status.json (read by the client for degraded badges) and append
 * to data/status/history.jsonl (git history answers "when did this break").
 * Always exits 0 — failures are data, not a broken health run.
 */
async function health(files: string[]): Promise<number> {
  const layers: Record<string, { ok: boolean; browserOk: boolean; status: string; checkedAt: string; note?: string }> = {};
  const limiter = new RateLimiter();
  for (const file of files) {
    let loaded: Array<{ label: string; descriptor: LayerDescriptor }>;
    try {
      loaded = fileLayers(file);
    } catch (e) {
      layers[file] = {
        ok: false,
        browserOk: false,
        status: 'error',
        checkedAt: new Date().toISOString(),
        note: (e as Error).message,
      };
      continue;
    }
    for (const { label, descriptor } of loaded) {
      const checkedAt = new Date().toISOString();
      try {
        const observations: FetchObservation[] = [];
        const engine = new LocalQueryEngine([descriptor], {
          io: makeIo(observations),
          adapters: defaultAdapters(),
          limiter,
        });
        const result = supportsPointHealth(descriptor)
          ? await engine.point(descriptor.id, descriptor.health_assertion.at)
          : undefined;
        const liveOk = result
          ? checkAssertion(label, result, descriptor.health_assertion)
          : descriptor.health_assertion.expect_overlay === true;
        const browser = await checkBrowserAccess(descriptor, observations);
        const entry = {
          ok: liveOk && browser.ok,
          browserOk: browser.ok,
          status: result?.status ?? (browser.ok ? 'overlay_ok' : 'error'),
          checkedAt,
        };
        layers[descriptor.id] = browser.note ? { ...entry, note: browser.note } : entry;
      } catch (e) {
        layers[descriptor.id] = { ok: false, browserOk: false, status: 'error', checkedAt, note: (e as Error).message };
      }
    }
  }
  mkdirSync('data/status', { recursive: true });
  const snapshot = { generatedAt: new Date().toISOString(), layers };
  writeFileSync('data/status/status.json', `${JSON.stringify(snapshot, null, 2)}\n`);
  appendFileSync(
    'data/status/history.jsonl',
    `${JSON.stringify({
      t: snapshot.generatedAt,
      ok: Object.fromEntries(Object.entries(layers).map(([id, s]) => [id, s.ok])),
    })}\n`,
  );
  const failing = Object.entries(layers).filter(([, s]) => !s.ok);
  console.log(`health: ${Object.keys(layers).length - failing.length} ok, ${failing.length} failing`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  if (mode === 'probe' && args.length > 0) return probe(args);
  if (mode === 'verify' && args.length > 0) return verify(args);
  if (mode === 'health' && args.length > 0) return health(args);
  if (mode === 'sample' && args.length === 3) {
    return sample(args[0] as string, Number(args[1]), Number(args[2]));
  }
  console.error('usage: verify.ts probe <url...> | verify <layer.yaml...> | health <layer.yaml...> | sample <layer.yaml> <lon> <lat>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
