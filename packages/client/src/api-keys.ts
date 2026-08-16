export interface ApiKeyDefinition {
  id: string;
  label: string;
  purpose: string;
}

/** Planned BYOK providers from decisions D1/D8; values never enter the bundle. */
export const API_KEY_DEFINITIONS: readonly ApiKeyDefinition[] = [
  { id: 'firms', label: 'NASA FIRMS', purpose: 'Fire and thermal-anomaly layers' },
  { id: 'ebird', label: 'eBird', purpose: 'Near-real-time bird observations' },
  { id: 'entsoe', label: 'ENTSO-E', purpose: 'European electricity data' },
  { id: 'opencellid', label: 'OpenCellID', purpose: 'Cell-tower data' },
  { id: 'aisstream', label: 'aisstream.io', purpose: 'Live vessel positions' },
] as const;

const STORAGE_PREFIX = 'strata:api-key:';

export function apiKeyStorageKey(id: string): string {
  if (!API_KEY_DEFINITIONS.some((definition) => definition.id === id)) throw new Error(`unknown API key '${id}'`);
  return `${STORAGE_PREFIX}${id}`;
}

export function readApiKey(id: string): string | null {
  return localStorage.getItem(apiKeyStorageKey(id));
}
