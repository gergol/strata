/** Minimal GeoJSON point-in-polygon (ray casting) for the A3 region adapter. */
import type { LonLat } from './tile.js';

type Ring = Array<[number, number]>;

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

function inRing(pt: LonLat, ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(pt: LonLat, rings: Ring[]): boolean {
  if (rings.length === 0 || !inRing(pt, rings[0] as Ring)) return false;
  // Holes: inside any interior ring means outside the polygon.
  for (let i = 1; i < rings.length; i++) {
    if (inRing(pt, rings[i] as Ring)) return false;
  }
  return true;
}

export function pointInFeature(pt: LonLat, feature: GeoJsonFeature): boolean {
  const g = feature.geometry;
  if (g.type === 'Polygon') return inPolygon(pt, g.coordinates);
  return g.coordinates.some((poly) => inPolygon(pt, poly));
}

/** First feature containing the point, or undefined. */
export function findContainingFeature(
  pt: LonLat,
  fc: GeoJsonFeatureCollection,
): GeoJsonFeature | undefined {
  return fc.features.find((f) => pointInFeature(pt, f));
}
