import { describe, it, expect } from 'vitest';
import {
  lonLatToTile,
  tileToBBox,
  bboxContains,
  tileKey,
  parseTileKey,
  tileToQuadkey,
  quadkeyToTile,
  MAX_MERCATOR_LAT,
} from '../src/tile.js';
import type { LonLat, Tile } from '../src/tile.js';

const VIENNA: LonLat = [16.37, 48.21];

describe('lonLatToTile / tileToBBox', () => {
  it('maps the world to tile 0/0/0', () => {
    expect(lonLatToTile([0, 0], 0)).toEqual({ z: 0, x: 0, y: 0 });
    const [w, s, e, n] = tileToBBox({ z: 0, x: 0, y: 0 });
    expect(w).toBe(-180);
    expect(e).toBe(180);
    expect(s).toBeCloseTo(-MAX_MERCATOR_LAT, 9);
    expect(n).toBeCloseTo(MAX_MERCATOR_LAT, 9);
  });

  it('places quadrants correctly at z1', () => {
    expect(lonLatToTile([10, 45], 1)).toEqual({ z: 1, x: 1, y: 0 }); // NE
    expect(lonLatToTile([-10, 45], 1)).toEqual({ z: 1, x: 0, y: 0 }); // NW
    expect(lonLatToTile([10, -45], 1)).toEqual({ z: 1, x: 1, y: 1 }); // SE
    expect(lonLatToTile([-10, -45], 1)).toEqual({ z: 1, x: 0, y: 1 }); // SW
  });

  it('round-trips: the tile bbox contains the input point', () => {
    for (const z of [3, 8, 14, 18]) {
      const t = lonLatToTile(VIENNA, z);
      expect(bboxContains(tileToBBox(t), VIENNA)).toBe(true);
    }
  });

  it('y grows as latitude falls (Mercator orientation)', () => {
    const north = lonLatToTile([16.37, 60], 10);
    const south = lonLatToTile([16.37, 30], 10);
    expect(north.y).toBeLessThan(south.y);
  });

  it('clamps polar latitudes and lon=180 into valid tiles', () => {
    const pole = lonLatToTile([0, 90], 5);
    expect(pole.y).toBe(0);
    const antimeridian = lonLatToTile([180, 0], 5);
    expect(antimeridian.x).toBe(31);
  });

  it('rejects out-of-range coordinates and zooms', () => {
    expect(() => lonLatToTile([181, 0], 5)).toThrow(RangeError);
    expect(() => lonLatToTile([0, 91], 5)).toThrow(RangeError);
    expect(() => lonLatToTile([0, 0], 23)).toThrow(RangeError);
    expect(() => lonLatToTile([0, 0], 1.5)).toThrow(RangeError);
  });
});

describe('tile keys', () => {
  it('round-trips through the canonical key form', () => {
    const t = lonLatToTile(VIENNA, 14);
    expect(parseTileKey(tileKey(t))).toEqual(t);
  });

  it('rejects malformed and out-of-range keys', () => {
    expect(() => parseTileKey('x/1/2')).toThrow(RangeError);
    expect(() => parseTileKey('3/8/1')).toThrow(RangeError); // x=8 invalid at z3
  });
});

describe('quadkeys (Bing/Ookla scheme)', () => {
  it('matches the documented Bing example: tile (3,5) at level 3 is "213"', () => {
    expect(tileToQuadkey({ z: 3, x: 3, y: 5 })).toBe('213');
    expect(quadkeyToTile('213')).toEqual({ z: 3, x: 3, y: 5 });
  });

  it('round-trips at the Ookla z16 keying depth', () => {
    const t: Tile = lonLatToTile(VIENNA, 16);
    const q = tileToQuadkey(t);
    expect(q).toHaveLength(16);
    expect(quadkeyToTile(q)).toEqual(t);
  });

  it('rejects invalid quadkey digits', () => {
    expect(() => quadkeyToTile('0142')).toThrow(RangeError);
  });
});
