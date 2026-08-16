import { describe, expect, it } from 'vitest';
import { computeShadowMask, computeViewshedMask, solarPosition } from '../src/terrain.js';

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

function shadowGrid(
  values: number[],
  width: number,
  overrides: Partial<Parameters<typeof computeShadowMask>[0]> = {},
) {
  return computeShadowMask({
    values,
    width,
    height: values.length / width,
    observerCol: Math.floor(width / 2),
    observerRow: Math.floor(values.length / width / 2),
    cellWidthM: 10,
    cellHeightM: 10,
    radiusM: 1_000,
    castDistanceM: 1_000,
    sunAltitudeDegrees: 20,
    sunAzimuthDegrees: 90,
    ...overrides,
  });
}

describe('surface-shadow terrain kernel', () => {
  it('keeps a flat valid surface sunlit while the sun is above the horizon', () => {
    const result = shadowGrid(Array.from({ length: 25 }, () => 100), 5);
    expect(result.consideredCells).toBe(25);
    expect(result.shadowCells).toBe(0);
  });

  it('casts westward shadow from a surface obstacle when the sun is east', () => {
    const values = [0, 0, 0, 30, 0, 0, 0];
    const result = shadowGrid(values, 7, {
      observerCol: 3,
      observerRow: 0,
      sunAltitudeDegrees: 20,
      sunAzimuthDegrees: 90,
    });
    expect([...result.shadow]).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it('honours the cast-distance cap', () => {
    const result = shadowGrid([0, 0, 0, 30, 0], 5, {
      observerCol: 0,
      observerRow: 0,
      castDistanceM: 20,
      sunAltitudeDegrees: 5,
      sunAzimuthDegrees: 90,
    });
    expect(result.shadow[0]).toBe(0);
  });

  it('marks every valid output cell shadowed below the horizon', () => {
    const result = shadowGrid([0, 0, -9999, 0, 0], 5, {
      observerCol: 2,
      observerRow: 0,
      nodata: -9999,
      sunAltitudeDegrees: -5,
    });
    expect(result.consideredCells).toBe(4);
    expect(result.shadowCells).toBe(4);
  });

  it('does not classify a target whose ray crosses nodata', () => {
    const result = shadowGrid([0, -9999, 0], 3, {
      observerCol: 0,
      observerRow: 0,
      nodata: -9999,
      sunAzimuthDegrees: 90,
    });
    expect(result.consideredCells).toBe(1);
    expect(result.shadow[0]).toBe(0);
  });
});

describe('solar position convention', () => {
  it('returns a high south-eastern sun over Vienna before midsummer solar noon', () => {
    const position = solarPosition(new Date('2026-06-21T10:00:00Z'), [16.38259, 48.20964]);
    expect(position.altitudeDegrees).toBeCloseTo(62.836, 2);
    expect(position.azimuthDegrees).toBeCloseTo(150.757, 2);
  });

  it('returns a negative altitude at local midnight', () => {
    expect(solarPosition(new Date('2026-06-21T22:00:00Z'), [16.38259, 48.20964]).altitudeDegrees).toBeLessThan(0);
  });
});
