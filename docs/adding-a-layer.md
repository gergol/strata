# Adding a layer

This is the operational form of requirements §13. A layer is complete only when its descriptor, browser path, semantics, health assertion, attribution, and failure states have all been verified. “The endpoint returned JSON in Node” is not browser verification.

## 1. Confirm the source before writing YAML

- Read the provider’s current official documentation and terms.
- Record the licence, attribution text/URL, commercial-use restriction, rate limit, and contact/politeness requirements.
- Confirm the native CRS and units from source metadata; never infer them from a familiar-looking value.
- Decide whether the data is measured, modelled, crowd-sourced, or derived and state that in `provenance_note`.
- Check whether an existing adapter already represents the source shape. New provider-specific code belongs in an adapter capability or named format parser, never in a component.

## 2. Choose the access and result semantics

Pick the adapter by the provider’s native access shape:

- `bbox_vector`: query features by point radius or bounding box.
- `cog`: range-read a Cloud-Optimized GeoTIFF.
- `region`: resolve the point to a polygon ID, then query region-keyed data.
- `point_sample`: sample a point-oriented API; Phase 1.
- `stream`: maintain live session state; Phase 3.
- `precomputed`: read a materialized static asset; Phase 1.

Declare every supported interaction in `modes`. Tile mode must state one honest primary aggregation. A point search that reaches beyond the coordinate uses `basis: nearest`; a probe grid uses `basis: sampled`; neither may be presented as a true area statistic.

Overlay mode is a rendering contract independent of the analytical adapter. A raster overlay declares one or more XYZ/WMTS/WMS tile templates, tile size, zoom bounds, default opacity, and an optional structured legend. The client understands `{z}`, `{x}`, `{y}`, and MapLibre's `{bbox-epsg-3857}` token. Keep visual and analytical semantics separate: a rendered WMS PNG can be an overlay for a COG-backed layer, but it cannot replace numeric point values or tile statistics.

A source that exposes only rendered tiles uses `modes: [overlay]`, the `precomputed` adapter classification, and `health_assertion.expect_overlay: true`. It appears only in map controls, never in the point-result stack. Its health canary expands and fetches a real tile at `health_assertion.at`; do not add a synthetic point assertion to make the generic runner happy.

## 3. Author the descriptor

Copy the closest existing descriptor in `layers/` and change every field deliberately. The schema is strict: unknown fields and misspellings fail loading.

Required decisions include:

- stable lowercase `id`, user-facing `name`, and `domain`;
- `endpoint`, pinned `crs`, `modes`, and empirical `zoom_valid`;
- `value_type`, aggregation, display `unit`, native unit, scale factor, and nodata where applicable;
- cache TTL and conservative per-layer rate limit;
- licence, commercial-use flag, attribution, coverage, and provenance;
- a health coordinate on real coverage with a bounded expected result, or `expect_overlay: true` for an overlay-only layer;
- `browser_access: direct | materialized | blocked`.

Descriptor changes invalidate cached results automatically because the descriptor hash is part of every cache key.

When several layers share most fields, use a descriptor pack with top-level `defaults` and `layers`. Entry objects shallow-merge with defaults, while nested descriptor objects such as `params` and `rate_limit` merge one level so an entry only states its real differences. Each expanded descriptor still passes the complete strict schema independently; duplicate IDs fail the entire pack.

Layers that call the same provider must share `rate_limit.group`. The limiter then applies the strictest concurrency/interval declaration and one circuit-breaker state across the group. For the main Overpass instance, use the existing `overpass-api-de` group rather than creating per-layer request lanes.

The OSM POI pack uses bounded `nwr[...]{{spatial}};` templates so nodes, ways, and relations are handled uniformly. Point lists use `out center` and remain explicitly capped; tile counts use `out count` and therefore stay exact even for dense features. Add ordinary POIs to `layers/osm_pois.yaml`; provider defaults, attribution, and politeness settings should not be repeated.

Every `bbox_vector` descriptor declares `params.protocol: overpass | sparql`; protocol selection is explicit rather than inferred from the endpoint. A SPARQL descriptor supplies a trusted WHERE-body fragment in `params.sparql_query` with exactly one `{{spatial}}` placeholder and a required `?item` variable. The adapter injects bounded `wikibase:around` or `wikibase:box` geography, labels, deterministic limits, result shape, and exact `COUNT(DISTINCT ?item)` tile aggregation. Full queries, nested `SERVICE`, query-form keywords, and update operations are rejected at registration.

Add Wikidata geography layers to `layers/wikidata_places.yaml`. Prefer a precise direct `wdt:P31` class and an empirically bounded radius; broad subclass-property paths can exceed the public query service's hard timeout. State direct-class semantics and Wikidata's uneven coordinate/completeness coverage in provenance rather than implying an exhaustive real-world inventory. All WDQS layers share the existing `wikidata-query-service` limiter group, one request slot, and conservative spacing. Point feature lists are capped and visibly labelled when truncated; tile counts remain exact.

## 4. Prove the browser boundary

For `browser_access: direct`, test from the production origin `https://gergol.github.io`, not only with curl or Node:

- the actual request method succeeds with `Access-Control-Allow-Origin: *` or the Pages origin;
- COG assets honor a single-byte `Range` request with HTTP 206 and browser-readable CORS headers;
- redirects retain compatible CORS behavior at the final URL;
- browser-forbidden headers such as `User-Agent` are not required by the provider.

For raster overlays, the health runner expands the tile template at the descriptor's health coordinate and verifies that the real response is an image with production-origin CORS. A successful GetCapabilities request is not sufficient evidence that GetTile/GetMap works in the browser.

If direct access fails, use the mitigation ladder in order:

1. accept and mark the layer blocked if it is optional;
2. materialize it through Actions when bounded staleness is acceptable;
3. consider the named stateless CORS shim only for a must-have live source.

Materialized region layers declare a source endpoint, region list, source-age limit, and deployed-artifact age limit in `params`. The materializer publishes a versioned envelope atomically, and the UI shows the upstream timestamp. A failed refresh preserves the previous Pages deployment; health turns red when the deployed envelope exceeds its freshness limit.

## 5. Verify semantics and failure states

Use known coordinates for all applicable cases:

- a normal result with independently checked value/count;
- `empty`: covered, with genuinely no records;
- `no_coverage`: outside the dataset;
- `zoom_invalid`: outside the declared semantic zoom range;
- upstream/schema/CORS failure: visible as an error, never empty;
- tile aggregation: labelled with the declared function and basis.

Attribution and provenance must ride with every successful result. Health assertions should be stable enough to avoid noise but sensitive enough to catch schema, unit, and coverage drift.

## 6. Run the gates

```sh
npm ci
npm run typecheck
npm test
npm run materialize
npm run build -w @strata/client
npm run bundle:check
npm run test:e2e
npx tsx packages/runner/src/verify.ts verify layers/your_layer.yaml
```

The final command performs the live assertion and browser-access checks. For a new materialized endpoint, deploy it to a preview or Pages first; the production smoke job runs the same command after deployment.

For a descriptor pack, append `#layer_id` to verify one entry (for example `layers/osm_pois.yaml#osm_drinking_water`). Deployment smoke uses one representative canary per shared provider; the scheduled health workflow expands every pack entry and remains the exhaustive per-layer check.

For Wikidata, verify every new layer's positive canary individually before relying on the representative deployment smoke. The public WDQS endpoint has a 60-second hard query limit and may return `429` with `Retry-After`; keep live development probes sequential and sparse. Browser requests use ordinary GET plus `Accept: application/sparql-results+json`, while the runner identifies itself with Strata's contact-bearing user agent.

## 7. Review the change boundary

A descriptor-only layer should normally touch `layers/` plus any static region pack or attribution fixture. If it requires adapter code, state the missing generic capability and test it with at least two descriptor-shaped cases before calling it reusable. Do not hide provider-specific parsing in UI code.

Before merge, confirm the working tree contains no credentials, captured private data, generated browser traces, or unrelated edits. Update `docs/plan.md` only when the change alters a capability, milestone, or accepted limitation.
