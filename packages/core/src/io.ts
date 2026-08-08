/**
 * The IO seam (plan §4.1, §4.5): adapters and the query pipeline reach the
 * outside world only through this interface. Hosts supply implementations —
 * the browser worker (fetch + IndexedDB), the Actions runner (fetch + noop or
 * file cache), and, if the proxy option is ever taken, a server process. This
 * injection point is what keeps @strata/core isomorphic and the proxy switch
 * contained. Implementations arrive in M0.2; only the contract lives here.
 */
import type { LayerResult } from './envelope.js';

export interface CacheEntry {
  result: LayerResult;
  storedAt: number;
  /** Descriptor hash at store time; a mismatch is a miss (stale-shape protection). */
  descriptorHash: string;
}

export interface KVCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry, ttlMs: number): Promise<void>;
}

export interface IO {
  /**
   * Host-provided fetch. Non-browser hosts MUST set the identifying User-Agent
   * with contact details here (R7.5 as amended, plan §5); browser hosts cannot,
   * and identify via Origin instead.
   */
  fetch: typeof globalThis.fetch;
  cache: KVCache;
  /** Injected clock — no direct Date.now() in core, for testability. */
  now(): number;
}
