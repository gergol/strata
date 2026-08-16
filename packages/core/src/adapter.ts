/**
 * The adapter contract (plan §4.1): one implementation per adapter class
 * (A1–A6), zero per layer (R6.1). Adapters return a bare outcome — the
 * pipeline stamps attribution, provenance, unit, and cache metadata onto it
 * (plan §4.3), so an adapter cannot forget attribution even in principle.
 *
 * The IO an adapter receives has the rate limiter already wrapped around
 * `fetch`; adapters must do all network access through it.
 */
import type { LayerDescriptor } from './descriptor.js';
import type { AggregationId } from './descriptor.js';
import type { PointQueryOptions } from './engine.js';
import type { ErrorKind, ResultValue, ResultBasis } from './envelope.js';
import type { IO } from './io.js';
import type { LonLat, Tile } from './tile.js';

export type AdapterOutcome =
  | {
      kind: 'ok';
      value: ResultValue;
      aggregation: AggregationId;
      basis: ResultBasis;
      /** For region adapters: which region answered (e.g. bidding zone id). */
      region?: string;
      /** ISO timestamp of the upstream data represented by a materialized result. */
      sourceUpdatedAt?: string;
    }
  | { kind: 'empty' }
  | { kind: 'no_coverage' };

/** A provider failure whose stable UI/error-envelope class is known by the adapter. */
export class AdapterError extends Error {
  constructor(readonly kind: ErrorKind, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface Adapter {
  point(layer: LayerDescriptor, at: LonLat, io: IO, options?: PointQueryOptions): Promise<AdapterOutcome>;
  tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome>;
  /** How M3 renders this layer; null when the layer has no overlay form. */
  overlaySpec?(layer: LayerDescriptor): unknown | null;
}
