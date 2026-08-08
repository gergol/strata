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
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import {
  CRS_REGISTRY,
  CogAdapter,
  LocalQueryEngine,
  MemoryCache,
  loadDescriptorYaml,
  isOk,
} from '@strata/core';
import type { IO, LayerResult } from '@strata/core';

const USER_AGENT = 'Strata-verify/0.1 (+https://github.com/gergol/strata)';

function makeIo(): IO {
  const identifyingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', USER_AGENT);
    return fetch(input, { ...init, headers });
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
  console.log(`${layerFile}: ${JSON.stringify(result)}`);
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

async function verify(files: string[]): Promise<number> {
  let failures = 0;
  for (const file of files) {
    try {
      const descriptor = loadDescriptorYaml(readFileSync(file, 'utf8'));
      const engine = new LocalQueryEngine([descriptor], {
        io: makeIo(),
        adapters: { cog: new CogAdapter() },
      });
      const result = await engine.point(descriptor.id, descriptor.health_assertion.at);
      const pass = checkAssertion(file, result, descriptor.health_assertion);
      console.log(`${file}: ${pass ? 'PASS' : 'FAIL'}`);
      if (!pass) failures++;
    } catch (e) {
      console.log(`${file}: ERROR ${(e as Error).message}`);
      failures++;
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

const [mode, ...args] = process.argv.slice(2);
if (mode === 'probe' && args.length > 0) {
  process.exit(await probe(args));
} else if (mode === 'verify' && args.length > 0) {
  process.exit(await verify(args));
} else if (mode === 'sample' && args.length === 3) {
  process.exit(await sample(args[0] as string, Number(args[1]), Number(args[2])));
} else {
  console.error('usage: verify.ts probe <url...> | verify <layer.yaml...> | sample <layer.yaml> <lon> <lat>');
  process.exit(2);
}
