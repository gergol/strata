import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

interface Budget {
  name: string;
  pattern: RegExp;
  maxBytes: number;
  maxGzipBytes: number;
}

const budgets: Budget[] = [
  { name: 'application entry', pattern: /^index-.*\.js$/, maxBytes: 150_000, maxGzipBytes: 50_000 },
  { name: 'MapLibre vendor', pattern: /^maplibre-.*\.js$/, maxBytes: 1_400_000, maxGzipBytes: 400_000 },
  { name: 'query worker', pattern: /^engine-worker-.*\.js$/, maxBytes: 450_000, maxGzipBytes: 150_000 },
];

function main(dist: string): number {
  const assetDir = join(dist, 'assets');
  const files = readdirSync(assetDir).filter((file) => file.endsWith('.js'));
  let failed = false;
  for (const budget of budgets) {
    const matches = files.filter((file) => budget.pattern.test(file));
    if (matches.length !== 1) {
      console.error(`${budget.name}: expected one matching chunk, found ${matches.length}`);
      failed = true;
      continue;
    }
    const path = join(assetDir, matches[0] as string);
    const bytes = statSync(path).size;
    const gzipBytes = gzipSync(readFileSync(path)).byteLength;
    const ok = bytes <= budget.maxBytes && gzipBytes <= budget.maxGzipBytes;
    console.log(`${budget.name}: ${basename(path)} ${bytes} bytes (${gzipBytes} gzip) ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

const dist = process.argv[2];
if (!dist) {
  console.error('usage: check-bundle.ts <dist-dir>');
  process.exit(2);
}
process.exit(main(dist));
