import { describe, it, expect } from 'vitest';
import {
  parseDescriptor,
  loadDescriptorYaml,
  descriptorHash,
  DescriptorValidationError,
} from '../src/descriptor.js';

/** A fully valid numeric COG layer, mirroring the requirements §6 example. */
const valid = {
  id: 'soilgrids_ph',
  name: 'Soil pH (0–5 cm)',
  domain: 'subsurface',
  adapter: 'cog',
  endpoint: 'https://files.isric.org/soilgrids/latest/data/phh2o/phh2o_0-5cm_mean.vrt',
  crs: 'EPSG:152160',
  modes: ['point', 'tile'],
  zoom_valid: [10, 18],
  value_type: 'numeric',
  aggregation: { primary: 'mean', secondary: ['min', 'max', 'p10', 'p90'] },
  unit: 'pH',
  native_unit: 'pH*10',
  scale_factor: 0.1,
  nodata: -32768,
  ttl: '30d',
  rate_limit: { max_concurrent: 4, min_interval_ms: 0 },
  licence: 'CC-BY-4.0',
  commercial_use: true,
  attribution: 'ISRIC — World Soil Information',
  attribution_url: 'https://soilgrids.org',
  health_assertion: { at: [16.37, 48.21], expect_range: [5.0, 9.0] },
  coverage: 'global',
  provenance_note: '250 m modelled, not measured',
};

function failsMentioning(input: unknown, ...fragments: string[]): void {
  try {
    parseDescriptor(input);
    expect.unreachable('descriptor should have failed validation');
  } catch (e) {
    expect(e).toBeInstanceOf(DescriptorValidationError);
    const msg = (e as Error).message;
    for (const f of fragments) expect(msg).toContain(f);
  }
}

describe('descriptor validation (R6.2, R6.3, R8.4)', () => {
  it('accepts a fully valid descriptor', () => {
    const d = parseDescriptor(valid);
    expect(d.id).toBe('soilgrids_ph');
    expect(d.browser_access).toBe('direct'); // default applied
    expect(d.search_beyond_tile).toBe(false);
  });

  it('rejects a descriptor missing licence, naming the field (R6.2)', () => {
    const { licence: _licence, ...rest } = valid;
    failsMentioning(rest, 'licence', 'soilgrids_ph');
  });

  it('rejects a descriptor missing attribution (R6.2)', () => {
    const { attribution: _a, ...rest } = valid;
    failsMentioning(rest, 'attribution');
  });

  it('rejects a descriptor missing commercial_use (R6.2)', () => {
    const { commercial_use: _c, ...rest } = valid;
    failsMentioning(rest, 'commercial_use');
  });

  it('rejects a numeric layer without unit (R6.3)', () => {
    const { unit: _u, ...rest } = valid;
    failsMentioning(rest, 'unit is mandatory for numeric layers');
  });

  it('rejects a numeric layer without scale_factor (R6.3)', () => {
    const { scale_factor: _s, ...rest } = valid;
    failsMentioning(rest, 'scale_factor is mandatory for numeric layers');
  });

  it('accepts a categorical layer without unit/scale_factor', () => {
    const d = parseDescriptor({
      ...valid,
      id: 'worldcover',
      value_type: 'categorical',
      aggregation: { primary: 'histogram' },
      unit: undefined,
      scale_factor: undefined,
      nodata: undefined,
    });
    expect(d.value_type).toBe('categorical');
  });

  it('hard-errors on an unknown CRS instead of guessing (R8.4)', () => {
    failsMentioning({ ...valid, crs: 'EPSG:99999' }, "unknown CRS 'EPSG:99999'", 'never guess');
  });

  it('rejects a malformed crs string', () => {
    failsMentioning({ ...valid, crs: 'utm-ish' }, 'crs');
  });

  it('rejects inverted zoom_valid (R5.1)', () => {
    failsMentioning({ ...valid, zoom_valid: [14, 10] }, 'zoom_valid must be [min, max]');
  });

  it('requires a declared aggregation for tile-mode layers (R4.1)', () => {
    const { aggregation: _agg, ...rest } = valid;
    failsMentioning(rest, 'primary aggregation');
  });

  it('allows point/overlay-only layers to omit aggregation', () => {
    const { aggregation: _agg, ...rest } = valid;
    const d = parseDescriptor({ ...rest, modes: ['point', 'overlay'] });
    expect(d.aggregation).toBeUndefined();
  });

  it('forces categorical tile layers to histogram or modal_with_confidence (R4.3)', () => {
    failsMentioning(
      { ...valid, value_type: 'categorical', unit: undefined, scale_factor: undefined, aggregation: { primary: 'mean' } },
      'histogram',
      'modal_with_confidence',
    );
  });

  it('requires location_precision on heritage-domain layers (D5)', () => {
    failsMentioning({ ...valid, domain: 'history' }, 'location_precision');
    const d = parseDescriptor({ ...valid, domain: 'history', location_precision: 'fuzzed' });
    expect(d.location_precision).toBe('fuzzed');
  });

  it('rejects unknown/misspelled keys instead of ignoring them', () => {
    failsMentioning({ ...valid, scale_faktor: 0.1 }, 'scale_faktor');
  });

  it('rejects an invalid ttl duration', () => {
    failsMentioning({ ...valid, ttl: 'monthly' }, 'ttl');
  });

  it('requires health_assertion to declare an expectation (R8.1)', () => {
    failsMentioning(
      { ...valid, health_assertion: { at: [16.37, 48.21] } },
      'at least one expectation',
    );
  });

  it('rejects an inverted expect_range', () => {
    failsMentioning(
      { ...valid, health_assertion: { at: [16.37, 48.21], expect_range: [9, 5] } },
      'expect_range must be [low, high]',
    );
  });
});

describe('YAML loading', () => {
  it('loads a YAML descriptor document', () => {
    const yaml = `
id: soilgrids_ph
name: Soil pH (0–5 cm)
domain: subsurface
adapter: cog
endpoint: https://files.isric.org/soilgrids/latest/data/phh2o/phh2o_0-5cm_mean.vrt
crs: EPSG:152160
modes: [point, tile]
zoom_valid: [10, 18]
value_type: numeric
aggregation:
  primary: mean
  secondary: [min, max]
unit: pH
scale_factor: 0.1
nodata: -32768
ttl: 30d
licence: CC-BY-4.0
commercial_use: true
attribution: "ISRIC — World Soil Information"
attribution_url: https://soilgrids.org
health_assertion:
  at: [16.37, 48.21]
  expect_range: [5.0, 9.0]
coverage: global
provenance_note: "250 m modelled, not measured"
`;
    const d = loadDescriptorYaml(yaml);
    expect(d.scale_factor).toBe(0.1);
    expect(d.rate_limit).toEqual({ max_concurrent: 2, min_interval_ms: 0 }); // default applied
  });

  it('reports invalid YAML as a validation error', () => {
    expect(() => loadDescriptorYaml('id: [unclosed')).toThrow(DescriptorValidationError);
  });
});

describe('descriptor hashing (cache invalidation, plan §4.3)', () => {
  it('is stable across key order', () => {
    const a = parseDescriptor(valid);
    const reordered = Object.fromEntries(Object.entries(valid).reverse());
    const b = parseDescriptor(reordered);
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });

  it('changes when any field changes — a scale_factor fix must invalidate the cache', () => {
    const a = parseDescriptor(valid);
    const b = parseDescriptor({ ...valid, scale_factor: 0.01 });
    expect(descriptorHash(a)).not.toBe(descriptorHash(b));
  });
});
