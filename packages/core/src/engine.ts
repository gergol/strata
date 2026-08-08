/**
 * The location-transparent query surface (plan §4.5, decision D1 rider).
 *
 * The UI codes ONLY against QueryEngine — never against adapters, the cache, or
 * the limiter. Today's implementation is the local engine in a Web Worker (M0.2).
 * If a proxy is ever warranted (triggers in plan §9), a RemoteQueryEngine
 * answering the same interface over HTTP is the entire client-side cost of the
 * switch; everything crossing this boundary is plain JSON-serializable data.
 */
import type { Mode, Domain, AggregationId } from './descriptor.js';
import type { LayerResult, Attribution } from './envelope.js';
import type { LonLat, Tile } from './tile.js';

/** Descriptor-derived, UI-facing layer metadata; never the raw descriptor. */
export interface LayerSummary {
  id: string;
  name: string;
  domain: Domain;
  modes: Mode[];
  zoomValid: [number, number];
  primaryAggregation?: AggregationId;
  unit?: string;
  attribution: Attribution;
  provenance: string;
  /** R8.3: surfaced whenever the layer's health assertion is failing. */
  degraded: boolean;
}

export interface QueryEngine {
  point(layerId: string, at: LonLat): Promise<LayerResult>;
  tile(layerId: string, tile: Tile): Promise<LayerResult>;
  layers(): Promise<LayerSummary[]>;
}
