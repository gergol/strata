/** QueryEngine implementation that proxies to the engine worker (plan §4.5). */
import type { LayerResult, LayerSummary, LonLat, QueryEngine, Tile } from '@strata/core';

interface Reply {
  id: number;
  result?: unknown;
  error?: string;
}

export class WorkerQueryEngine implements QueryEngine {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const { id, result, error } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (error !== undefined) entry.reject(new Error(error));
      else entry.resolve(result);
    };
  }

  private call<T>(method: string, args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // JSON round-trip strips Svelte $state proxies, which structured clone rejects.
      this.worker.postMessage({ id, method, args: JSON.parse(JSON.stringify(args)) });
    });
  }

  point(layerId: string, at: LonLat): Promise<LayerResult> {
    return this.call('point', [layerId, at]);
  }

  tile(layerId: string, tile: Tile): Promise<LayerResult> {
    return this.call('tile', [layerId, tile]);
  }

  layers(): Promise<LayerSummary[]> {
    return this.call('layers', []);
  }
}
