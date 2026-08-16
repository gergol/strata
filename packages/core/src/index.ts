export {
  ADAPTERS,
  MODES,
  DOMAINS,
  AGGREGATIONS,
  VALUE_TYPES,
  layerDescriptorSchema,
  DescriptorValidationError,
  parseDescriptor,
  loadDescriptorYaml,
  descriptorHash,
} from './descriptor.js';
export type {
  AdapterId,
  Mode,
  Domain,
  AggregationId,
  ValueType,
  LayerDescriptor,
} from './descriptor.js';

export { CRS_REGISTRY, isKnownCrs, knownCrsCodes } from './crs.js';

export {
  MAX_MERCATOR_LAT,
  MIN_ZOOM,
  MAX_ZOOM,
  assertTile,
  lonLatToTile,
  tileToBBox,
  bboxContains,
  tileKey,
  parseTileKey,
  tileToQuadkey,
  quadkeyToTile,
} from './tile.js';
export type { Tile, LonLat, BBox } from './tile.js';

export { isNodata, applyScale, applyScaleAll, parseDuration, isValidDuration } from './units.js';

export { isOk, empty, noCoverage, zoomInvalid, queryError } from './envelope.js';
export type {
  Attribution,
  ScalarValue,
  HistogramClass,
  HistogramValue,
  FeaturesValue,
  ResultValue,
  ResultBasis,
  ErrorKind,
  OkResult,
  EmptyResult,
  NoCoverageResult,
  ZoomInvalidResult,
  ErrorResult,
  DegradedResult,
  LayerResult,
} from './envelope.js';

export type { CacheEntry, KVCache, IO } from './io.js';
export type { LayerSummary, QueryEngine } from './engine.js';

export type { Adapter, AdapterOutcome } from './adapter.js';
export { RateLimiter, CircuitOpenError } from './limiter.js';
export type { LimiterClock, LimiterOptions, LayerRateConfig } from './limiter.js';
export { MemoryCache } from './memory-cache.js';
export { LocalQueryEngine } from './local-engine.js';
export type { LocalEngineDeps } from './local-engine.js';
export { CogAdapter } from './adapters/cog.js';
export type { CogAdapterDeps } from './adapters/cog.js';
export { OverpassAdapter } from './adapters/overpass.js';
export { RegionAdapter, parseEnergyChartsPublicPower } from './adapters/region.js';
export { findContainingFeature, pointInFeature } from './geometry.js';
export type { GeoJsonFeature, GeoJsonFeatureCollection } from './geometry.js';

import { CogAdapter as CogAdapterClass } from './adapters/cog.js';
import { OverpassAdapter as OverpassAdapterClass } from './adapters/overpass.js';
import { RegionAdapter as RegionAdapterClass } from './adapters/region.js';
import type { Adapter } from './adapter.js';
import type { AdapterId } from './descriptor.js';

/** The standard adapter set — everything implemented so far, keyed by adapter id. */
export function defaultAdapters(): Partial<Record<AdapterId, Adapter>> {
  return {
    cog: new CogAdapterClass(),
    bbox_vector: new OverpassAdapterClass(),
    region: new RegionAdapterClass(),
  };
}
