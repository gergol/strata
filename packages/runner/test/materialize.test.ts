import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeLayer, type MaterializedEnvelope } from '../src/materialize.js';

const now = Date.parse('2026-08-16T13:30:00.000Z');
const payload = {
  unix_seconds: [Math.floor(now / 1000) - 900],
  production_types: [
    { name: 'Solar', data: [500] },
    { name: 'Hydro Run-of-River', data: [250] },
  ],
};

describe('Energy-Charts materializer', () => {
  it('writes a versioned, fresh envelope for every configured region', async () => {
    const output = mkdtempSync(join(tmpdir(), 'strata-materialize-'));
    let requestedUrl = '';
    const written = await materializeLayer('layers/grid_generation_mix.yaml', output, {
      now: () => now,
      fetch: (async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(payload), { status: 200 });
      }) as typeof fetch,
    });
    expect(requestedUrl).toBe('https://api.energy-charts.info/public_power?country=at&start=2026-08-16');
    expect(written).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(written[0] as string, 'utf8')) as MaterializedEnvelope;
    expect(envelope).toMatchObject({
      schema_version: 1,
      materialized_at: '2026-08-16T13:30:00.000Z',
      source_updated_at: '2026-08-16T13:15:00.000Z',
      region: 'at',
      payload,
    });
  });

  it('refuses stale source data', async () => {
    const output = mkdtempSync(join(tmpdir(), 'strata-materialize-'));
    const stale = { ...payload, unix_seconds: [Math.floor((now - 7 * 60 * 60 * 1000) / 1000)] };
    await expect(
      materializeLayer('layers/grid_generation_mix.yaml', output, {
        now: () => now,
        fetch: (async () => new Response(JSON.stringify(stale), { status: 200 })) as typeof fetch,
      }),
    ).rejects.toThrow(/outside the allowed age/);
  });

  it('refuses schema drift before publishing an artifact', async () => {
    const output = mkdtempSync(join(tmpdir(), 'strata-materialize-'));
    await expect(
      materializeLayer('layers/grid_generation_mix.yaml', output, {
        now: () => now,
        fetch: (async () => new Response(JSON.stringify({ unix_seconds: [1] }), { status: 200 })) as typeof fetch,
      }),
    ).rejects.toThrow(/production_types/);
  });

  it('rejects an invalid configured lookback before fetching', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'strata-materialize-config-'));
    const descriptor = join(scratch, 'layer.yaml');
    writeFileSync(
      descriptor,
      readFileSync('layers/grid_generation_mix.yaml', 'utf8').replace('materialize_lookback_hours: 12', 'materialize_lookback_hours: 12.5'),
    );
    await expect(
      materializeLayer(descriptor, scratch, {
        now: () => now,
        fetch: (async () => {
          throw new Error('fetch must not run');
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/must be an integer from 0 to 168/);
  });
});
