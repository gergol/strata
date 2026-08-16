/**
 * LocalQueryEngine — the pipeline of plan §4.3 behind the location-transparent
 * QueryEngine interface (plan §4.5):
 *
 *   request → descriptor lookup → zoom gate → coverage gate →
 *   cache lookup (id + key + descriptor hash) → limiter-wrapped adapter fetch →
 *   envelope stamping → cache write
 *
 * Attribution, provenance, unit, and fetch metadata are stamped here, from the
 * descriptor — never by adapters (R6.4, plan §4.1).
 */
import { AdapterError, type Adapter, type AdapterOutcome } from './adapter.js';
import type { AdapterId, LayerDescriptor } from './descriptor.js';
import { descriptorHash, parseDescriptor } from './descriptor.js';
import type { LayerResult, OkResult } from './envelope.js';
import { noCoverage, queryError, zoomInvalid } from './envelope.js';
import type { LayerSummary, PointQueryOptions, QueryEngine } from './engine.js';
import type { IO } from './io.js';
import { CircuitOpenError, RateLimiter } from './limiter.js';
import type { BBox, LonLat, Tile } from './tile.js';
import { bboxContains, tileKey, tileToBBox } from './tile.js';
import { parseDuration } from './units.js';

interface RegisteredLayer {
  descriptor: LayerDescriptor;
  hash: string;
  ttlMs: number;
}

export interface LocalEngineDeps {
  io: IO;
  adapters: Partial<Record<AdapterId, Adapter>>;
  limiter?: RateLimiter;
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export class LocalQueryEngine implements QueryEngine {
  private readonly layerMap = new Map<string, RegisteredLayer>();
  private readonly io: IO;
  private readonly adapters: Partial<Record<AdapterId, Adapter>>;
  private readonly limiter: RateLimiter;
  private readonly degradedLayers = new Set<string>();

  constructor(descriptors: unknown[], deps: LocalEngineDeps) {
    this.io = deps.io;
    this.adapters = deps.adapters;
    this.limiter = deps.limiter ?? new RateLimiter();
    for (const raw of descriptors) {
      // R6.2: a descriptor failing validation must not register; parse throws.
      const descriptor = parseDescriptor(raw);
      if (this.layerMap.has(descriptor.id)) {
        throw new Error(`duplicate layer id '${descriptor.id}'`);
      }
      this.layerMap.set(descriptor.id, {
        descriptor,
        hash: descriptorHash(descriptor),
        ttlMs: parseDuration(descriptor.ttl),
      });
    }
  }

  /** R8.3: health runner flips this; queries on a degraded layer still run, the flag rides along in layers(). */
  setDegraded(layerId: string, degraded: boolean): void {
    this.requireLayer(layerId);
    if (degraded) this.degradedLayers.add(layerId);
    else this.degradedLayers.delete(layerId);
  }

  async layers(): Promise<LayerSummary[]> {
    return [...this.layerMap.values()].map(({ descriptor: d }) => {
      const summary: LayerSummary = {
        id: d.id,
        name: d.name,
        domain: d.domain,
        modes: [...d.modes],
        zoomValid: [d.zoom_valid[0], d.zoom_valid[1]],
        attribution: d.attribution_url
          ? { text: d.attribution, url: d.attribution_url }
          : { text: d.attribution },
        provenance: d.provenance_note,
        degraded: this.degradedLayers.has(d.id),
      };
      if (d.aggregation) summary.primaryAggregation = d.aggregation.primary;
      if (d.unit !== undefined) summary.unit = d.unit;
      if (d.overlay) {
        summary.overlay = {
          kind: d.overlay.kind,
          tiles: [...d.overlay.tiles],
          tileSize: d.overlay.tile_size,
          minZoom: d.overlay.min_zoom,
          maxZoom: d.overlay.max_zoom,
          opacity: d.overlay.opacity,
          ...(d.overlay.time
            ? {
                time: {
                  kind: d.overlay.time.kind,
                  defaultOffsetDays: d.overlay.time.default_offset_days,
                  maxAgeDays: d.overlay.time.max_age_days,
                },
              }
            : {}),
          ...(d.overlay.legend
            ? {
                legend: {
                  title: d.overlay.legend.title,
                  items: d.overlay.legend.items.map((item) => ({ ...item })),
                },
              }
            : {}),
        };
      }
      if (d.feature_style) {
        summary.featureStyle = d.feature_style.kind === 'circle'
          ? {
              kind: 'circle',
              color: d.feature_style.color,
              radius: d.feature_style.radius,
              opacity: d.feature_style.opacity,
              strokeColor: d.feature_style.stroke_color,
              strokeWidth: d.feature_style.stroke_width,
            }
          : {
              kind: 'fill',
              color: d.feature_style.color,
              opacity: d.feature_style.opacity,
              outlineColor: d.feature_style.outline_color,
            };
      }
      if (d.terrain_analysis) {
        summary.terrainAnalysis = {
          kind: d.terrain_analysis.kind,
          radiusM: d.terrain_analysis.radius_m,
          observerHeightM: d.terrain_analysis.observer_height_m,
          gridM: d.terrain_analysis.grid_m,
        };
      }
      return summary;
    });
  }

  async point(layerId: string, at: LonLat, options: PointQueryOptions = {}): Promise<LayerResult> {
    const layer = this.requireLayer(layerId);
    this.requireMode(layer.descriptor, 'point');
    if (layer.descriptor.terrain_analysis && options.zoom !== undefined) {
      const [zMin, zMax] = layer.descriptor.zoom_valid;
      if (options.zoom < zMin || options.zoom > zMax) {
        return zoomInvalid(
          `'${layer.descriptor.name}' is only computed between z${zMin} and z${zMax} (map at z${options.zoom})`,
        );
      }
    }
    if (!this.covers(layer.descriptor, [at[0], at[1], at[0], at[1]])) return noCoverage();
    const cacheKey = `${layerId}:${layer.hash}:point:${at[0].toFixed(6)},${at[1].toFixed(6)}`;
    return this.run(layer, cacheKey, (adapter, io) => adapter.point(layer.descriptor, at, io));
  }

  async tile(layerId: string, tile: Tile): Promise<LayerResult> {
    const layer = this.requireLayer(layerId);
    this.requireMode(layer.descriptor, 'tile');
    const [zMin, zMax] = layer.descriptor.zoom_valid;
    if (tile.z < zMin || tile.z > zMax) {
      // R5.1/R5.2: semantically invalid, said out loud — never silent garbage.
      return zoomInvalid(
        `'${layer.descriptor.name}' is only meaningful between z${zMin} and z${zMax} (queried at z${tile.z})`,
      );
    }
    if (!this.covers(layer.descriptor, tileToBBox(tile))) return noCoverage();
    const cacheKey = `${layerId}:${layer.hash}:tile:${tileKey(tile)}`;
    return this.run(layer, cacheKey, (adapter, io) => adapter.tile(layer.descriptor, tile, io));
  }

  private requireLayer(layerId: string): RegisteredLayer {
    const layer = this.layerMap.get(layerId);
    if (!layer) throw new TypeError(`unknown layer '${layerId}'`);
    return layer;
  }

  private requireMode(d: LayerDescriptor, mode: 'point' | 'tile'): void {
    if (!d.modes.includes(mode)) {
      throw new TypeError(`layer '${d.id}' does not support ${mode} mode`);
    }
  }

  /** R5.3 case 1: decided here from the descriptor's coverage — never by the UI. */
  private covers(d: LayerDescriptor, queryBBox: BBox): boolean {
    if (d.coverage === 'global') return true;
    if ('bbox' in d.coverage) return bboxIntersects(d.coverage.bbox, queryBBox);
    // Region-list coverage is resolved by the region adapter itself.
    return true;
  }

  private async run(
    layer: RegisteredLayer,
    cacheKey: string,
    exec: (adapter: Adapter, io: IO) => Promise<AdapterOutcome>,
  ): Promise<LayerResult> {
    const { descriptor: d } = layer;
    const cached = await this.io.cache.get(cacheKey);
    if (cached && cached.descriptorHash === layer.hash) {
      return cached.result.status === 'ok' ? { ...cached.result, cacheHit: true } : cached.result;
    }

    const adapter = this.adapters[d.adapter];
    if (!adapter) {
      return queryError('schema', `no adapter registered for '${d.adapter}' (layer '${d.id}')`);
    }

    const limitedIo: IO = {
      ...this.io,
      fetch: this.limiter.wrapFetch(d.rate_limit.group ?? d.id, d.rate_limit, this.io.fetch),
    };

    let outcome: AdapterOutcome;
    try {
      outcome = await exec(adapter, limitedIo);
    } catch (e) {
      if (e instanceof CircuitOpenError) return queryError('circuit_open', e.message);
      if (e instanceof AdapterError) return queryError(e.kind, e.message);
      return queryError('upstream', e instanceof Error ? e.message : String(e));
    }

    const result = this.stamp(d, outcome);
    if (result.status === 'ok' || result.status === 'empty' || result.status === 'no_coverage') {
      await this.io.cache.set(
        cacheKey,
        { result, storedAt: this.io.now(), descriptorHash: layer.hash },
        layer.ttlMs,
      );
    }
    return result;
  }

  private stamp(d: LayerDescriptor, outcome: AdapterOutcome): LayerResult {
    if (outcome.kind === 'empty') return { status: 'empty' };
    if (outcome.kind === 'no_coverage') return { status: 'no_coverage' };
    const ok: OkResult = {
      status: 'ok',
      value: outcome.value,
      aggregation: outcome.aggregation,
      basis: outcome.basis,
      unit: d.unit ?? '',
      fetchedAt: new Date(this.io.now()).toISOString(),
      cacheHit: false,
      attribution: d.attribution_url
        ? { text: d.attribution, url: d.attribution_url }
        : { text: d.attribution },
      provenance: d.provenance_note,
    };
    if (outcome.region !== undefined) ok.region = outcome.region;
    if (outcome.sourceUpdatedAt !== undefined) ok.sourceUpdatedAt = outcome.sourceUpdatedAt;
    return ok;
  }
}
