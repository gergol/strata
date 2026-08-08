import { describe, it, expect } from 'vitest';
import { isOk, empty, noCoverage, zoomInvalid, queryError } from '../src/envelope.js';
import type { LayerResult, OkResult } from '../src/envelope.js';

const ok: OkResult = {
  status: 'ok',
  value: { kind: 'scalar', value: 7.2 },
  aggregation: 'mean',
  basis: 'aggregated',
  unit: 'pH',
  fetchedAt: '2026-08-08T12:00:00Z',
  cacheHit: false,
  attribution: { text: 'ISRIC — World Soil Information', url: 'https://soilgrids.org' },
  provenance: '250 m modelled, not measured',
};

describe('envelope semantics (R5.3)', () => {
  it('keeps the three empty-ish outcomes distinct', () => {
    const results: LayerResult[] = [empty(), noCoverage(), queryError('timeout', 'upstream took >10s')];
    const statuses = results.map((r) => r.status);
    expect(new Set(statuses).size).toBe(3);
    expect(results.filter(isOk)).toHaveLength(0);
  });

  it('zoom_invalid always carries a reason (R5.2: no silent garbage)', () => {
    const r = zoomInvalid('soil pH below z10 aggregates a whole region into one number');
    expect(r.reason).toMatch(/z10/);
  });
});

describe('location transparency (plan §4.5)', () => {
  it('every result shape survives a JSON round-trip unchanged', () => {
    const results: LayerResult[] = [
      ok,
      { ...ok, value: { kind: 'histogram', classes: [{ label: 'forest', share: 0.6 }, { label: 'urban', share: 0.4 }] } },
      { ...ok, value: { kind: 'features', features: [{ type: 'Feature' }], truncated: true }, basis: 'nearest' },
      empty(),
      noCoverage(),
      zoomInvalid('reason'),
      queryError('cors', 'blocked by upstream CORS policy'),
      { status: 'degraded', reason: 'health assertion failing since 2026-08-07', lastOkAt: '2026-08-06T00:00:00Z' },
    ];
    for (const r of results) {
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
  });
});
