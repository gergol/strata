export {
  ADAPTERS,
  MODES,
  DOMAINS,
  AGGREGATIONS,
  VALUE_TYPES,
  layerDescriptorSchema,
  DescriptorValidationError,
  parseDescriptor,
  loadDescriptorsYaml,
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
  RasterOverlaySpec,
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
export type { LayerSummary, QueryEngine, RasterOverlaySummary } from './engine.js';

export { AdapterError } from './adapter.js';
export type { Adapter, AdapterOutcome } from './adapter.js';
export { RateLimiter, CircuitOpenError } from './limiter.js';
export type { LimiterClock, LimiterOptions, LayerRateConfig } from './limiter.js';
export { MemoryCache } from './memory-cache.js';
export { LocalQueryEngine } from './local-engine.js';
export type { LocalEngineDeps } from './local-engine.js';
export { CogAdapter } from './adapters/cog.js';
export type { CogAdapterDeps } from './adapters/cog.js';
export { OverpassAdapter } from './adapters/overpass.js';
export { SparqlAdapter } from './adapters/sparql.js';
export { WfsAdapter } from './adapters/wfs.js';
export { PointSampleAdapter } from './adapters/point-sample.js';
export { PrecomputedAdapter } from './adapters/precomputed.js';
export { BBoxVectorAdapter } from './adapters/bbox-vector.js';
export { RegionAdapter, parseEnergyChartsPublicPower } from './adapters/region.js';
export { findContainingFeature, pointInFeature } from './geometry.js';
export type { GeoJsonFeature, GeoJsonFeatureCollection } from './geometry.js';

import { CogAdapter as CogAdapterClass } from './adapters/cog.js';
import { BBoxVectorAdapter as BBoxVectorAdapterClass } from './adapters/bbox-vector.js';
import { RegionAdapter as RegionAdapterClass } from './adapters/region.js';
import { PointSampleAdapter as PointSampleAdapterClass } from './adapters/point-sample.js';
import { PrecomputedAdapter as PrecomputedAdapterClass } from './adapters/precomputed.js';
import type { Adapter } from './adapter.js';
import type { AdapterId } from './descriptor.js';

/** The standard adapter set — everything implemented so far, keyed by adapter id. */
export function defaultAdapters(): Partial<Record<AdapterId, Adapter>> {
  return {
    cog: new CogAdapterClass(),
    bbox_vector: new BBoxVectorAdapterClass(),
    region: new RegionAdapterClass(),
    point_sample: new PointSampleAdapterClass(),
    precomputed: new PrecomputedAdapterClass(),
  };
}
