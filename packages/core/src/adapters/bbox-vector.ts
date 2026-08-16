/** Routes the A1 bbox-vector adapter family by an explicit descriptor protocol. */
import { AdapterError, type Adapter, type AdapterOutcome } from '../adapter.js';
import type { LayerDescriptor } from '../descriptor.js';
import type { IO } from '../io.js';
import type { LonLat, Tile } from '../tile.js';
import { OverpassAdapter } from './overpass.js';
import { SparqlAdapter } from './sparql.js';
import { WfsAdapter } from './wfs.js';
import { GbfsAdapter } from './gbfs.js';

export class BBoxVectorAdapter implements Adapter {
  constructor(
    private readonly overpass: Adapter = new OverpassAdapter(),
    private readonly sparql: Adapter = new SparqlAdapter(),
    private readonly wfs: Adapter = new WfsAdapter(),
    private readonly gbfs: Adapter = new GbfsAdapter(),
  ) {}

  private subtype(layer: LayerDescriptor): Adapter {
    const protocol = layer.params?.['protocol'];
    if (protocol === 'overpass') return this.overpass;
    if (protocol === 'sparql') return this.sparql;
    if (protocol === 'wfs') return this.wfs;
    if (protocol === 'gbfs') return this.gbfs;
    throw new AdapterError('schema', `bbox-vector layer '${layer.id}' has unsupported protocol '${String(protocol)}'`);
  }

  point(layer: LayerDescriptor, at: LonLat, io: IO): Promise<AdapterOutcome> {
    return this.subtype(layer).point(layer, at, io);
  }

  tile(layer: LayerDescriptor, tile: Tile, io: IO): Promise<AdapterOutcome> {
    return this.subtype(layer).tile(layer, tile, io);
  }
}
