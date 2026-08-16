# Strata

A personal geospatial exploration instrument. The question it answers:

> *"What can I find out about the place I am standing in — or the place I am looking at?"*

Breadth across domains — weather, subsurface, energy, traffic, history, wildlife, infrastructure — is the whole point. No single specialist app can answer a question that spans domains; Strata trades depth in any one of them for reach across all of them. Coverage is permanently uneven by design, hence the name: what you get is layers, not completeness.

**Status: Phase 1 underway — [live at gergol.github.io/strata](https://gergol.github.io/strata/).** Twenty-seven browser-verified query layers: a 15-layer OpenStreetMap POI pack via Overpass, 10 geospatial Wikidata layers via SPARQL, soil pH via SoilGrids COG, and an hourly same-origin materialization of Austria's electricity generation mix from Energy-Charts. The 28-layer catalogue also includes two raster overlays for SoilGrids pH and ESA WorldCover 2021. The MapLibre PWA selects and centers the current location on startup (with a reusable location control), and has searchable lazy result panels, shared provider-level rate limiting, browser-aware scheduled health, BYOK settings, and deterministic UI/offline regression tests. WorldCover is deliberately visual-only: its official multi-file COG distribution remains unsuitable for browser analytics because it omits CORS headers.

| Document | Contents |
|---|---|
| [docs/requirements.md](docs/requirements.md) | Requirements — interaction modes, the six-adapter architecture, aggregation semantics, the layer catalogue (~70 candidate sources), phasing |
| [docs/plan.md](docs/plan.md) | Technical plan — architecture shape, stack, core contracts, work breakdown for Phases 0–4 |
| [docs/decisions.md](docs/decisions.md) | Decisions register — accepted positions on the nine decisions (D1–D9) |
| [docs/adding-a-layer.md](docs/adding-a-layer.md) | Operational checklist — descriptor semantics, CORS/Range proof, health, and release gates |

## Design ideas in one paragraph

Every data source collapses into one of six access adapters (bbox vector, COG raster, region lookup, point sample, stream, precomputed); each concrete layer is then configuration — a YAML descriptor declaring endpoint, browser-access path, CRS, licence, attribution, units, cache TTL, rate limits, zoom validity, and crucially its **aggregation semantics**, because "the value of this tile" means something different for geology than for air-quality sensors. The whole thing runs client-only: a static PWA queries browser-safe upstreams directly, while scheduled GitHub Actions verify both data and browser reachability and materialize bounded-staleness sources that cannot satisfy CORS. No server, no database.

## Licence

Code is AGPL-3.0 (see [LICENSE](LICENSE)). Data layers carry their own licences and attribution requirements, recorded per-layer in their descriptors; several accepted sources are non-commercial-only, which this project — strictly non-commercial — can use, but downstream users must check per layer.
