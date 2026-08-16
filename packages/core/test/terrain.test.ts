import { describe, expect, it } from 'vitest';
import { computeViewshedMask } from '../src/terrain.js';

function grid(values: number[], width: number, overrides: Partial<Parameters<typeof computeViewshedMask>[0]> = {}) {
  return computeViewshedMask({
    values,
    width,
    height: values.length / width,
    observerCol: 0,
    observerRow: 0,
    cellWidthM: 10,
    cellHeightM: 10,
    radiusM: 1_000,
    observerHeightM: 1.7,
    ...overrides,
  });
}

describe('viewshed terrain kernel', () => {
  it('marks a flat surface visible from an elevated observer', () => {
    const result = grid(Array.from({ length: 25 }, () => 100), 5, { observerCol: 2, observerRow: 2 });
    expect(result.consideredCells).toBe(25);
    expect(result.visibleCells).toBe(25);
    expect([...result.visible]).toEqual(Array.from({ length: 25 }, () => 1));
  });

  it('hides lower cells behind a taller intervening surface', () => {
    const result = grid([100, 120, 100, 100, 100], 5);
    expect([...result.visible]).toEqual([1, 1, 0, 0, 0]);
  });

  it('allows a sufficiently tall target to reappear behind an obstruction', () => {
    const result = grid([100, 120, 100, 100, 200], 5);
    expect(result.visible[2]).toBe(0);
    expect(result.visible[4]).toBe(1);
  });

  it('excludes nodata and cells beyond the configured radius', () => {
    const result = grid([100, -9999, 100, 100, 100], 5, { nodata: -9999, radiusM: 25 });
    expect(result.consideredCells).toBe(2);
    expect([...result.visible]).toEqual([1, 0, 0, 0, 0]);
  });
});
