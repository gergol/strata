import { describe, expect, it } from 'vitest';
import {
  buildTippecanoeArgs,
  derivationRecipeSchema,
  loadDerivationRecipe,
  parseTippecanoeVersion,
} from '../src/derive-pmtiles.js';

describe('PMTiles derivation contract', () => {
  it('loads the strict smoke recipe and constructs shell-free Tippecanoe arguments', () => {
    const recipe = loadDerivationRecipe('derive/smoke.pmtiles.json');
    const args = buildTippecanoeArgs(recipe, '/tmp/output.pmtiles');
    expect(args).toContain('--projection=EPSG:4326');
    expect(args).toContain('bidding_zones');
    expect(args).toContain('--include');
    expect(args.at(-1)).toMatch(/regions\/bidding-zones\.json$/);
  });

  it('requires publication-specific output locations', () => {
    const recipe = loadDerivationRecipe('derive/smoke.pmtiles.json');
    const parsed = derivationRecipeSchema.safeParse({
      ...recipe,
      output: {
        path: 'data/derived/not-on-pages.pmtiles',
        publication: { kind: 'pages' },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/pages outputs/);
  });

  it('pins release asset names to their archive basename', () => {
    const recipe = loadDerivationRecipe('derive/smoke.pmtiles.json');
    const parsed = derivationRecipeSchema.safeParse({
      ...recipe,
      output: {
        path: 'data/derived/crops.pmtiles',
        publication: { kind: 'release', asset_name: 'different.pmtiles' },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/must match/);
  });

  it('accepts the minimum PMTiles-capable Tippecanoe release', () => {
    expect(parseTippecanoeVersion('tippecanoe v2.17.0')).toEqual([2, 17, 0]);
    expect(() => parseTippecanoeVersion('unknown')).toThrow(/could not parse/);
  });
});
