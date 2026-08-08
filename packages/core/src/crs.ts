/**
 * Pinned CRS registry (R8.4: adapters must never guess CRS).
 *
 * A descriptor's `crs` must name a code registered here; anything else is a
 * load-time hard error. The fix for an unknown code is to add a deliberately
 * chosen, pinned proj4 definition below — never to infer one at runtime.
 * Definitions are append-only configuration; proj4js consumes them from M0.3 on.
 */
export const CRS_REGISTRY: Readonly<Record<string, string>> = {
  // Geographic / web
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:3857':
    '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  // Pan-European
  'EPSG:3035':
    '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // Austria Lambert (Austrian national services, e.g. BEV, GBA, eHYD)
  'EPSG:31287':
    '+proj=lcc +lat_1=49 +lat_2=46 +lat_0=47.5 +lon_0=13.33333333333333 +x_0=400000 +y_0=400000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
  // Interrupted Goode Homolosine (SoilGrids)
  'EPSG:152160': '+proj=igh +lat_0=0 +lon_0=0 +datum=WGS84 +units=m +no_defs',
};

export function isKnownCrs(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CRS_REGISTRY, code);
}

export function knownCrsCodes(): string[] {
  return Object.keys(CRS_REGISTRY);
}
