/** IndexedDB-backed KVCache (R7.2) — the browser host's cache implementation. */
import type { CacheEntry, KVCache } from '@strata/core';

interface Row {
  key: string;
  entry: CacheEntry;
  expiresAt: number;
}

const DB_NAME = 'strata-cache';
const STORE = 'results';

export class IdbCache implements KVCache {
  private readonly db: Promise<IDBDatabase>;

  constructor(private readonly now: () => number) {
    this.db = new Promise((resolvePromise, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolvePromise(req.result);
      req.onerror = () => reject(req.error as Error);
    });
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db).transaction(STORE, mode).objectStore(STORE);
  }

  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolvePromise, reject) => {
      req.onsuccess = () => resolvePromise(req.result);
      req.onerror = () => reject(req.error as Error);
    });
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const row = (await this.request((await this.tx('readonly')).get(key))) as Row | undefined;
      if (!row) return undefined;
      if (this.now() >= row.expiresAt) {
        await this.request((await this.tx('readwrite')).delete(key));
        return undefined;
      }
      return row.entry;
    } catch {
      return undefined; // cache trouble must never break a query
    }
  }

  async set(key: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    try {
      const row: Row = { key, entry, expiresAt: this.now() + ttlMs };
      await this.request((await this.tx('readwrite')).put(row));
    } catch {
      // best effort — a full or blocked cache is not an error
    }
  }
}
