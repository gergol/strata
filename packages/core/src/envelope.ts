/**
 * The result envelope: every query, from every adapter, in every mode, returns
 * exactly one of these shapes. This is where R4.2 (declared aggregation surfaced),
 * R5.3 (three empty states distinguished), R6.4 (provenance surfaced) and the A4
 * sampled-marking rule are structural rather than UI discipline.
 *
 * Everything here must remain plain JSON-serializable data (no classes, no Dates,
 * no functions): results cross the Web Worker boundary today and may cross an HTTP
 * boundary if the proxy option is ever taken (plan §4.5).
 */
import type { AggregationId } from './descriptor.js';

export interface Attribution {
  text: string;
  url?: string;
}

export interface ScalarValue {
  kind: 'scalar';
  value: number | string;
}

export interface HistogramClass {
  label: string;
  /** Share in [0, 1] of the aggregated area/count. */
  share: number;
}

export interface HistogramValue {
  kind: 'histogram';
  classes: HistogramClass[];
}

/** GeoJSON features, deliberately untyped here; adapters validate upstream shapes. */
export interface FeaturesValue {
  kind: 'features';
  features: unknown[];
  /** True when the adapter hit the descriptor's feature cap (A1 capped lists). */
  truncated: boolean;
}

export type ResultValue = ScalarValue | HistogramValue | FeaturesValue;

/**
 * How the value was obtained:
 *  - 'aggregated': a true statistic over the queried geometry
 *  - 'sampled': a small probe grid (A4) — must never be presented as a statistic
 *  - 'nearest': found outside the queried geometry (R4.4) — labelled, not contained
 */
export type ResultBasis = 'aggregated' | 'sampled' | 'nearest';

export type ErrorKind = 'upstream' | 'timeout' | 'schema' | 'rate_limited' | 'cors';

export interface OkResult {
  status: 'ok';
  value: ResultValue;
  aggregation: AggregationId;
  basis: ResultBasis;
  /** Post-scaling display unit (R6.3). Empty string for unitless/categorical. */
  unit: string;
  fetchedAt: string;
  cacheHit: boolean;
  attribution: Attribution;
  provenance: string;
  /** For A3: which region answered (e.g. a NUTS or bidding-zone id). */
  region?: string;
}

export interface EmptyResult {
  /** Coverage exists here and there is genuinely nothing — this is information. */
  status: 'empty';
}

export interface NoCoverageResult {
  /** The dataset does not include this territory — a gap in the app, not in the world. */
  status: 'no_coverage';
}

export interface ZoomInvalidResult {
  status: 'zoom_invalid';
  /** Human-readable reason from the descriptor's zoom semantics (R5.2: no silent garbage). */
  reason: string;
}

export interface ErrorResult {
  status: 'error';
  kind: ErrorKind;
  message: string;
}

export interface DegradedResult {
  /** The layer's health assertion is currently failing (R8.3): shown, not hidden. */
  status: 'degraded';
  reason: string;
  /** ISO timestamp of the last passing health check, when known. */
  lastOkAt?: string;
}

export type LayerResult =
  | OkResult
  | EmptyResult
  | NoCoverageResult
  | ZoomInvalidResult
  | ErrorResult
  | DegradedResult;

export function isOk(r: LayerResult): r is OkResult {
  return r.status === 'ok';
}

export const empty = (): EmptyResult => ({ status: 'empty' });
export const noCoverage = (): NoCoverageResult => ({ status: 'no_coverage' });
export const zoomInvalid = (reason: string): ZoomInvalidResult => ({ status: 'zoom_invalid', reason });
export const queryError = (kind: ErrorKind, message: string): ErrorResult => ({
  status: 'error',
  kind,
  message,
});
