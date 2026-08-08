/**
 * A2 — COG raster adapter (plan M0.3). Reads pixel values from Cloud-Optimized
 * GeoTIFFs over HTTP range requests, at the overview level matching the query,
 * and aggregates them per the descriptor's declaration (R4.1/R4.3).
 *
 * CRS: query coordinates are transformed from EPSG:4326 into the descriptor's
 * pinned CRS via the registry — never inferred from the file (R8.4; a mismatch
 * between file and descriptor is exactly what health assertions catch).
 *
 * Politeness note: geotiff.js manages its own ranged fetching, so COG reads are
 * the one path not routed through the limiter-wrapped fetch. Deliberate for v1:
 * A2 sources are object stores without rate limits (requirements §3), and the
 * descriptor's rate_limit still applies to any non-COG fetches. Revisit if a
 * COG host ever throttles.
 */
import type { GeoTIFF, GeoTIFFImage } from 'geotiff';
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import type { Adapter, AdapterOutcome } from '../adapter.js';
import { CRS_REGISTRY } from '../crs.js';
import type { AggregationId, LayerDescriptor } from '../descriptor.js';
import type { HistogramClass } from '../envelope.js';
import type { IO } from '../io.js';
import type { BBox, LonLat, Tile } from '../tile.js';
import { tileToBBox } from '../tile.js';
import { applyScale, isNodata } from '../units.js';

/** Max pixels read per tile query; above this a coarser overview is forced. */
const MAX_WINDOW_PIXELS = 512 * 512;

export interface CogAdapterDeps {
  /** Injection seam for tests: open a GeoTIFF for an endpoint. Defaults to ranged HTTP reads. */
  open?: (url: string, io: IO) => Promise<GeoTIFF>;
}

interface NativePoint {
  x: number;
  y: number;
}

export class CogAdapter implements Adapter {
  private readonly open: (url: string, io: IO) => Promise<GeoTIFF>;
  private readonly tiffCache = new Map<string, Promise<GeoTIFF>>();

  constructor(deps: CogAdapterDeps = {}) {
    this.open = deps.open ?? ((url) => fromUrl(url));
  }

  private tiff(layer: LayerDescriptor, io: IO): Promise<GeoTIFF> {
    let cached = this.tiffCache.get(layer.endpoint);
    if (!cached) {
      cached = this.open(layer.endpoint, io);
      this.tiffCache.set(layer.endpoint, cached);
    }
    return cached;
  }

  private toNative(layer: LayerDescriptor, lonLat: LonLat): NativePoint {
    const def = CRS_REGISTRY[layer.crs];
    if (!def) throw new Error(`CRS '${layer.crs}' not in registry (R8.4)`); // schema should have caught this
    if (layer.crs === 'EPSG:4326') return { x: lonLat[0], y: lonLat[1] };
    const [x, y] = proj4(CRS_REGISTRY['EPSG:4326'] as string, def, [lonLat[0], lonLat[1]]);
    return { x: x as number, y: y as number };
  }

  async point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    const tiff = await this.tiff(layer, io);
    const image = await tiff.getImage(0); // finest resolution for point reads
    const native = this.toNative(layer, at);
    const [minX, minY, maxX, maxY] = image.getBoundingBox() as [number, number, number, number];
    if (native.x < minX || native.x > maxX || native.y < minY || native.y > maxY) {
      return { kind: 'no_coverage' };
    }
    const col = Math.min(
      image.getWidth() - 1,
      Math.floor(((native.x - minX) / (maxX - minX)) * image.getWidth()),
    );
    const row = Math.min(
      image.getHeight() - 1,
      Math.floor(((maxY - native.y) / (maxY - minY)) * image.getHeight()),
    );
    const rasters = await image.readRasters({ window: [col, row, col + 1, row + 1], samples: [0] });
    const raw = Number((rasters[0] as ArrayLike<number>)[0]);
    if (isNodata(raw, layer.nodata)) return { kind: 'empty' };
    if (layer.value_type === 'categorical') {
      return {
        kind: 'ok',
        value: { kind: 'scalar', value: this.classLabel(layer, raw) },
        aggregation: layer.aggregation?.primary ?? 'modal_with_confidence',
        basis: 'aggregated',
      };
    }
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: applyScale(raw, layer.scale_factor ?? 1) },
      aggregation: 'mean',
      basis: 'aggregated',
    };
  }

  async tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    const tiff = await this.tiff(layer, io);
    const bboxWgs = tileToBBox(tile);
    const corners: NativePoint[] = [
      this.toNative(layer, [bboxWgs[0], bboxWgs[1]]),
      this.toNative(layer, [bboxWgs[0], bboxWgs[3]]),
      this.toNative(layer, [bboxWgs[2], bboxWgs[1]]),
      this.toNative(layer, [bboxWgs[2], bboxWgs[3]]),
    ];
    const nativeBBox: BBox = [
      Math.min(...corners.map((c) => c.x)),
      Math.min(...corners.map((c) => c.y)),
      Math.max(...corners.map((c) => c.x)),
      Math.max(...corners.map((c) => c.y)),
    ];

    const image = await this.pickOverview(tiff, nativeBBox);
    if (!image) return { kind: 'no_coverage' };
    const [minX, minY, maxX, maxY] = image.getBoundingBox() as [number, number, number, number];
    if (nativeBBox[2] < minX || nativeBBox[0] > maxX || nativeBBox[3] < minY || nativeBBox[1] > maxY) {
      return { kind: 'no_coverage' };
    }

    const width = image.getWidth();
    const height = image.getHeight();
    const colOf = (x: number): number => Math.floor(((x - minX) / (maxX - minX)) * width);
    const rowOf = (y: number): number => Math.floor(((maxY - y) / (maxY - minY)) * height);
    const window: [number, number, number, number] = [
      Math.max(0, colOf(nativeBBox[0])),
      Math.max(0, rowOf(nativeBBox[3])),
      Math.min(width, colOf(nativeBBox[2]) + 1),
      Math.min(height, rowOf(nativeBBox[1]) + 1),
    ];
    if (window[2] <= window[0] || window[3] <= window[1]) return { kind: 'no_coverage' };

    const rasters = await image.readRasters({ window, samples: [0] });
    const data = rasters[0] as ArrayLike<number>;
    const raws: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const v = Number(data[i]);
      if (!isNodata(v, layer.nodata)) raws.push(v);
    }
    if (raws.length === 0) return { kind: 'empty' };

    if (layer.value_type === 'categorical') {
      return {
        kind: 'ok',
        value: { kind: 'histogram', classes: this.histogram(layer, raws) },
        aggregation: 'histogram',
        basis: 'aggregated',
      };
    }
    const primary = layer.aggregation?.primary ?? 'mean';
    const scaled = raws.map((v) => applyScale(v, layer.scale_factor ?? 1));
    return {
      kind: 'ok',
      value: { kind: 'scalar', value: aggregate(scaled, primary) },
      aggregation: primary,
      basis: 'aggregated',
    };
  }

  /** Coarsest overview that still gives adequate resolution, capped by MAX_WINDOW_PIXELS. */
  private async pickOverview(tiff: GeoTIFF, nativeBBox: BBox): Promise<GeoTIFFImage | null> {
    const count = await tiff.getImageCount();
    const targetRes = (nativeBBox[2] - nativeBBox[0]) / 256; // aim for ~256px across the tile
    let best: GeoTIFFImage | null = null;
    let bestRes = Infinity;
    for (let i = 0; i < count; i++) {
      const image = await tiff.getImage(i);
      const [minX, , maxX] = image.getBoundingBox() as [number, number, number, number];
      const res = (maxX - minX) / image.getWidth();
      const windowPixels = ((nativeBBox[2] - nativeBBox[0]) / res) * ((nativeBBox[3] - nativeBBox[1]) / res);
      if (windowPixels > MAX_WINDOW_PIXELS) continue;
      // The finest image still within budget that does not oversample below target.
      if (res < bestRes && (res >= targetRes || bestRes === Infinity)) {
        best = image;
        bestRes = res;
      }
    }
    if (!best) {
      // Everything was over budget (absurdly large query bbox) — take the coarsest.
      best = await tiff.getImage(count - 1);
    }
    return best;
  }

  private classLabel(layer: LayerDescriptor, raw: number): string {
    const classes = (layer.params?.['classes'] ?? {}) as Record<string, string>;
    return classes[String(raw)] ?? String(raw);
  }

  private histogram(layer: LayerDescriptor, raws: number[]): HistogramClass[] {
    const counts = new Map<string, number>();
    for (const v of raws) {
      const label = this.classLabel(layer, v);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, n]) => ({ label, share: n / raws.length }))
      .sort((a, b) => b.share - a.share);
  }
}

function aggregate(sorted: number[], fn: AggregationId): number {
  const values = [...sorted].sort((a, b) => a - b);
  const n = values.length;
  const pick = (q: number): number => values[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] as number;
  switch (fn) {
    case 'mean':
      return values.reduce((s, v) => s + v, 0) / n;
    case 'min':
      return values[0] as number;
    case 'max':
      return values[n - 1] as number;
    case 'median':
      return pick(0.5);
    case 'p10':
      return pick(0.1);
    case 'p90':
      return pick(0.9);
    case 'sum':
      return values.reduce((s, v) => s + v, 0);
    default:
      throw new Error(`aggregation '${fn}' is not defined for continuous rasters`);
  }
}
