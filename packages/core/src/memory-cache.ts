/**
 * In-memory KVCache — used by the Actions runner and tests. The browser host
 * supplies an IndexedDB-backed implementation instead; both honour the same
 * contract (TTL enforced at read time against the injected clock).
 */
import type { CacheEntry, KVCache } from './io.js';

interface StoredEntry {
  entry: CacheEntry;
  expiresAt: number;
}

export class MemoryCache implements KVCache {
  private readonly map = new Map<string, StoredEntry>();
  constructor(private readonly now: () => number) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    const stored = this.map.get(key);
    if (!stored) return undefined;
    if (this.now() >= stored.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return stored.entry;
  }

  async set(key: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    this.map.set(key, { entry, expiresAt: this.now() + ttlMs });
  }
}
