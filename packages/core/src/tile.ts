/** Web Mercator (XYZ "slippy") tile math. Latitudes are clamped to the Mercator limit. */

export interface Tile {
  z: number;
  x: number;
  y: number;
}

/** [lon, lat] in EPSG:4326, always lon first — matching descriptor `health_assertion.at`. */
export type LonLat = [number, number];

/** [west, south, east, north] in EPSG:4326. */
export type BBox = [number, number, number, number];

export const MAX_MERCATOR_LAT = 85.05112877980659;
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 22;

function assertZoom(z: number): void {
  if (!Number.isInteger(z) || z < MIN_ZOOM || z > MAX_ZOOM) {
    throw new RangeError(`zoom must be an integer in [${MIN_ZOOM}, ${MAX_ZOOM}], got ${z}`);
  }
}

export function assertTile(t: Tile): void {
  assertZoom(t.z);
  const n = 2 ** t.z;
  if (!Number.isInteger(t.x) || t.x < 0 || t.x >= n || !Number.isInteger(t.y) || t.y < 0 || t.y >= n) {
    throw new RangeError(`tile x/y must be integers in [0, ${n - 1}] at z${t.z}, got x=${t.x} y=${t.y}`);
  }
}

export function lonLatToTile(lonLat: LonLat, z: number): Tile {
  assertZoom(z);
  const [lon, lat] = lonLat;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`longitude must be in [-180, 180], got ${lon}`);
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`latitude must be in [-90, 90], got ${lat}`);
  }
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const n = 2 ** z;
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x: Math.min(x, n - 1), y: Math.max(0, Math.min(y, n - 1)) };
}

export function tileToBBox(t: Tile): BBox {
  assertTile(t);
  const n = 2 ** t.z;
  const lon = (x: number): number => (x / n) * 360 - 180;
  const lat = (y: number): number => {
    const m = Math.PI * (1 - (2 * y) / n);
    return (Math.atan(Math.sinh(m)) * 180) / Math.PI;
  };
  return [lon(t.x), lat(t.y + 1), lon(t.x + 1), lat(t.y)];
}

export function bboxContains(bbox: BBox, lonLat: LonLat): boolean {
  const [w, s, e, nrth] = bbox;
  const [lon, lat] = lonLat;
  return lon >= w && lon <= e && lat >= s && lat <= nrth;
}

/** Canonical cache-key form, e.g. "14/8936/5679". */
export function tileKey(t: Tile): string {
  assertTile(t);
  return `${t.z}/${t.x}/${t.y}`;
}

export function parseTileKey(key: string): Tile {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!m) throw new RangeError(`invalid tile key '${key}', expected "z/x/y"`);
  const t = { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
  assertTile(t);
  return t;
}

/** Bing/Ookla-style quadkey (needed for the A6 Ookla join, keyed by z16 quadkey). */
export function tileToQuadkey(t: Tile): string {
  assertTile(t);
  let q = '';
  for (let i = t.z; i > 0; i--) {
    const mask = 1 << (i - 1);
    let digit = 0;
    if (t.x & mask) digit += 1;
    if (t.y & mask) digit += 2;
    q += digit;
  }
  return q;
}

export function quadkeyToTile(q: string): Tile {
  if (!/^[0-3]*$/.test(q)) throw new RangeError(`invalid quadkey '${q}'`);
  let x = 0;
  let y = 0;
  const z = q.length;
  for (let i = 0; i < z; i++) {
    const mask = 1 << (z - i - 1);
    const digit = q.charCodeAt(i) - 48;
    if (digit & 1) x |= mask;
    if (digit & 2) y |= mask;
  }
  const t = { z, x, y };
  assertTile(t);
  return t;
}
