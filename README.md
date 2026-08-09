# Strata

A personal geospatial exploration instrument. The question it answers:

> *"What can I find out about the place I am standing in — or the place I am looking at?"*

Breadth across domains — weather, subsurface, energy, traffic, history, wildlife, infrastructure — is the whole point. No single specialist app can answer a question that spans domains; Strata trades depth in any one of them for reach across all of them. Coverage is permanently uneven by design, hence the name: what you get is layers, not completeness.

**Status: Phase 0 complete — [live at gergol.github.io/strata](https://gergol.github.io/strata/).** Three live-verified layers (soil pH via SoilGrids COG, OSM drinking-water points via Overpass, the Austrian electricity generation mix via Energy-Charts), a MapLibre client with the worker-hosted query engine, and a 6-hourly health runner committing per-layer status to this repo. Next: Phase 1, cheap breadth. The project is defined by three documents:

| Document | Contents |
|---|---|
| [docs/requirements.md](docs/requirements.md) | Requirements — interaction modes, the six-adapter architecture, aggregation semantics, the layer catalogue (~70 candidate sources), phasing |
| [docs/plan.md](docs/plan.md) | Technical plan — architecture shape, stack, core contracts, work breakdown for Phases 0–4 |
| [docs/decisions.md](docs/decisions.md) | Decisions register — accepted positions on the nine decisions (D1–D9) |

## Design ideas in one paragraph

Every data source collapses into one of six access adapters (bbox vector, COG raster, region lookup, point sample, stream, precomputed); each concrete layer is then pure configuration — a YAML descriptor declaring endpoint, CRS, licence, attribution, units, cache TTL, rate limits, zoom validity, and crucially its **aggregation semantics**, because "the value of this tile" means something different for geology than for air-quality sensors. The whole thing runs client-only: a static PWA querying upstreams directly from the browser, with scheduled GitHub Actions doing the two server-shaped jobs (health assertions against every layer, so silent upstream schema drift surfaces as a visible *degraded* badge instead of quiet garbage; and materializing awkward sources into static tiles). No server, no database.

## Licence

Code is AGPL-3.0 (see [LICENSE](LICENSE)). Data layers carry their own licences and attribution requirements, recorded per-layer in their descriptors; several accepted sources are non-commercial-only, which this project — strictly non-commercial — can use, but downstream users must check per layer.
