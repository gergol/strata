/**
 * Materialize browser-blocked region APIs into same-origin Pages assets.
 *
 * The source response is preserved inside a small versioned envelope so the
 * browser adapter can parse the provider's native contract while health checks
 * can reject stale deployments. Files are replaced atomically; a failed fetch
 * never destroys the last build artifact.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDescriptorYaml, parseEnergyChartsPublicPower } from '@strata/core';

const USER_AGENT = 'Strata-materializer/0.1 (+https://github.com/gergol/strata)';
const DEFAULT_MAX_SOURCE_AGE_MS = 2 * 60 * 60 * 1000;

export interface MaterializedEnvelope {
  schema_version: 1;
  materialized_at: string;
  source_updated_at: string;
  source: string;
  region: string;
  payload: unknown;
}

export interface MaterializeDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

function stringParam(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`params.${name} must be a non-empty string`);
  return value;
}

function regionParams(params: Record<string, unknown> | undefined): string[] {
  const value = params?.['materialize_regions'];
  if (!Array.isArray(value) || value.length === 0 || !value.every((region) => typeof region === 'string' && /^[a-z0-9_-]+$/.test(region))) {
    throw new Error('params.materialize_regions must be a non-empty array of safe region ids');
  }
  return value as string[];
}

function lookbackHours(params: Record<string, unknown> | undefined): number {
  const value = params?.['materialize_lookback_hours'] ?? 0;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 168) {
    throw new Error('params.materialize_lookback_hours must be an integer from 0 to 168');
  }
  return Number(value);
}

function latestSourceTimestamp(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) throw new Error('Energy-Charts response must be an object');
  const timestamps = (payload as { unix_seconds?: unknown }).unix_seconds;
  if (!Array.isArray(timestamps) || timestamps.length === 0 || !timestamps.every((value) => typeof value === 'number')) {
    throw new Error('Energy-Charts response missing numeric unix_seconds');
  }
  return Math.max(...timestamps) * 1000;
}

export async function materializeLayer(
  layerFile: string,
  outputDir: string,
  deps: MaterializeDeps = {},
): Promise<string[]> {
  const descriptor = loadDescriptorYaml(readFileSync(layerFile, 'utf8'));
  if (descriptor.browser_access !== 'materialized') {
    throw new Error(`layer '${descriptor.id}' is not declared browser_access: materialized`);
  }
  const sourceTemplate = stringParam(descriptor.params, 'materialize_source_endpoint');
  if (!sourceTemplate.includes('{{region}}')) {
    throw new Error('params.materialize_source_endpoint must contain {{region}}');
  }
  const regions = regionParams(descriptor.params);
  const sourceLookbackHours = lookbackHours(descriptor.params);
  const maxSourceAgeMs = Number(descriptor.params?.['max_source_age_ms'] ?? DEFAULT_MAX_SOURCE_AGE_MS);
  if (!Number.isFinite(maxSourceAgeMs) || maxSourceAgeMs <= 0) throw new Error('params.max_source_age_ms must be positive');

  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const written: string[] = [];
  mkdirSync(outputDir, { recursive: true });

  for (const region of regions) {
    const sourceUrl = new URL(sourceTemplate.replaceAll('{{region}}', region));
    if (sourceLookbackHours > 0) {
      const start = new Date(now() - sourceLookbackHours * 3_600_000).toISOString().slice(0, 10);
      sourceUrl.searchParams.set('start', start);
    }
    const source = sourceUrl.toString();
    const response = await fetchImpl(source, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`materialization source returned ${response.status} for '${region}'`);
    const payload: unknown = await response.json();
    const parsed = parseEnergyChartsPublicPower(payload);
    if (parsed.kind !== 'ok') throw new Error(`materialization source returned no generation data for '${region}'`);

    const sourceUpdatedAtMs = latestSourceTimestamp(payload);
    const ageMs = now() - sourceUpdatedAtMs;
    if (ageMs < -10 * 60 * 1000 || ageMs > maxSourceAgeMs) {
      throw new Error(`materialization source timestamp for '${region}' is outside the allowed age (${ageMs}ms)`);
    }

    const envelope: MaterializedEnvelope = {
      schema_version: 1,
      materialized_at: new Date(now()).toISOString(),
      source_updated_at: new Date(sourceUpdatedAtMs).toISOString(),
      source,
      region,
      payload,
    };
    const fileName = `${descriptor.id}-${region}.json`;
    const destination = join(outputDir, fileName);
    const temporary = `${destination}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o644 });
    renameSync(temporary, destination);
    written.push(destination);
  }
  return written;
}

async function main(args: string[]): Promise<number> {
  const [outputDir, ...layerFiles] = args;
  if (!outputDir || layerFiles.length === 0) {
    console.error('usage: materialize.ts <output-dir> <layer.yaml...>');
    return 2;
  }
  for (const layerFile of layerFiles) {
    const written = await materializeLayer(layerFile, outputDir);
    for (const file of written) console.log(`materialized ${basename(file)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
