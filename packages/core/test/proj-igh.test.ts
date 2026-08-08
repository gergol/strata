import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import '../src/proj/igh.js';
import { CRS_REGISTRY } from '../src/crs.js';

const WGS84 = CRS_REGISTRY['EPSG:4326'] as string;
const IGH = CRS_REGISTRY['EPSG:152160'] as string;

/** Reference coordinates computed with pyproj 3.x / PROJ (see src/proj/igh.ts). */
const REFERENCE: Array<[number, number, number, number]> = [
  [16.37, 48.21, 2278988.624, 5347965.08], // Vienna — Mollweide zone, north lobe CM 30°
  [16.37, 30.0, 2025577.664, 3339584.724], // sinusoidal zone
  [-70.0, -50.0, -7439802.634, -5536683.825], // Mollweide zone, south lobe CM -60°
  [140.5, -35.2, 15630210.788, -3918446.076], // sinusoidal zone, south lobe CM 140°
  [-100.0, 60.0, -11131949.079, 6539970.862], // exactly on its lobe's central meridian
  [2.0, 0.5, 222757.665, 55659.745], // near equator
];

describe('Interrupted Goode Homolosine (EPSG:152160)', () => {
  it('matches PROJ reference coordinates within 0.5 m', () => {
    for (const [lon, lat, x, y] of REFERENCE) {
      const [px, py] = proj4(WGS84, IGH, [lon, lat]) as [number, number];
      expect(px, `x of (${lon},${lat})`).toBeCloseTo(x, 0);
      expect(py, `y of (${lon},${lat})`).toBeCloseTo(y, 0);
      expect(Math.abs(px - x)).toBeLessThan(0.5);
      expect(Math.abs(py - y)).toBeLessThan(0.5);
    }
  });

  it('round-trips back to lon/lat within 1e-6 degrees', () => {
    for (const [lon, lat] of REFERENCE) {
      const fwd = proj4(WGS84, IGH, [lon, lat]) as [number, number];
      const [rlon, rlat] = proj4(IGH, WGS84, fwd) as [number, number];
      expect(Math.abs(rlon - lon)).toBeLessThan(1e-6);
      expect(Math.abs(rlat - lat)).toBeLessThan(1e-6);
    }
  });
});
