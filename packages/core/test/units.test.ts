import { describe, it, expect } from 'vitest';
import { applyScale, applyScaleAll, isNodata, parseDuration, isValidDuration } from '../src/units.js';

describe('applyScale (R6.3)', () => {
  it('scales raw values by the descriptor factor', () => {
    expect(applyScale(72, 0.1)).toBeCloseTo(7.2, 12); // SoilGrids pH*10 → pH
    expect(applyScale(-5, 1)).toBe(-5);
  });

  it('refuses non-finite input rather than propagating it silently', () => {
    expect(() => applyScale(Number.NaN, 0.1)).toThrow(RangeError);
    expect(() => applyScale(Infinity, 0.1)).toThrow(RangeError);
    expect(() => applyScale(1, Number.NaN)).toThrow(RangeError);
  });
});

describe('nodata handling', () => {
  it('identifies the sentinel exactly', () => {
    expect(isNodata(-32768, -32768)).toBe(true);
    expect(isNodata(-32767, -32768)).toBe(false);
    expect(isNodata(-32768, undefined)).toBe(false);
  });

  it('drops sentinels before scaling — never scales a sentinel into a plausible value', () => {
    expect(applyScaleAll([72, -32768, 68], 0.1, -32768)).toEqual([
      applyScale(72, 0.1),
      applyScale(68, 0.1),
    ]);
  });
});

describe('parseDuration (descriptor ttl)', () => {
  it('parses each supported suffix', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  it('rejects everything else', () => {
    for (const bad of ['monthly', '1w', '5', 'd', '1.5h', '-3d', '']) {
      expect(isValidDuration(bad), bad).toBe(false);
      expect(() => parseDuration(bad)).toThrow(RangeError);
    }
  });
});
