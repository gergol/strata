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

For a JSON `point_sample` layer, `params.value_path` selects a numeric response field and optional `params.time_path` carries the provider timestamp. `params.query` contains fixed scalar query parameters. Tile mode uses an odd `params.sample_grid` from 1–5 (default 3); set `params.batch_coordinates: true` only when the provider documents comma-separated coordinates. The adapter always returns `basis: sampled`, including for a grid mean.

Queryable `precomputed` layers use a small same-origin JSON record array and declare `params.materialization_kind: static_index`. `key_scheme: quadkey_z16` joins an already tiled provider product and can compute tile means, optionally weighted by `weight_field`; `key_scheme: epsg3035_grid_1km` joins a point to the containing official GISCO kilometre cell. Pin `value_field` and `source_updated_at`. Bulk-to-index recipes live in `derive/`, with source URLs, stable ordering, output hashes, and selection provenance committed alongside the artifact.

GBFS station layers use `adapter: bbox_vector`, `params.protocol: gbfs`, and the system's `gbfs.json` discovery URL. The adapter supports v2 language-keyed and v3 direct discovery, joins `station_information` to each fresh `station_status` snapshot, and normalizes both `num_bikes_available` and `num_vehicles_available`. Declare a bounded `coverage`, `point_radius_m`, `feature_cap`, and `search_beyond_tile: true`; the point list is nearest/capped while tile mode counts stations exactly for that feed snapshot.

Raster overlays with a daily time dimension put `{date}` in every tile URL and declare `overlay.time: { kind: daily_utc, default_offset_days, max_age_days }`. The UI resolves the default UTC date, bounds a date picker, and rebuilds the source when it changes; browser health resolves the same default before fetching a real tile. `max_zoom` is the source's native tile ceiling—MapLibre may overzoom it rather than hiding the layer.

Feature-valued point layers may declare a strict `feature_style` circle contract (colour, radius, opacity, stroke) or fill contract (colour, opacity, outline). This style travels through `LayerSummary` and controls the actual MapLibre result overlay; the domain colour is only a fallback.

A local viewshed remains an A2 COG layer and adds `terrain_analysis: { kind: viewshed, radius_m, observer_height_m, grid_m }`. It must use a projected metre CRS, point mode, feature values, fill styling, bounded coverage inset by at least the analysis radius, and z13+ semantics. The worker returns `basis: modelled`; provenance must identify whether the surface is DTM or DSM and disclose grid resolution, occluders, survey vintage, and that it is not a surveyed sightline.

A local surface-shadow layer uses `terrain_analysis: { kind: shadow, radius_m, cast_distance_m, grid_m }` against the same projected COG contract. Coverage must be inset by `radius_m + cast_distance_m`; the first is the returned area and the second is the explicit occluder-search cap. Set `health_assertion.at_time` to an ISO instant so scheduled canaries are deterministic. The browser supplies a user-selected absolute instant, the worker computes solar altitude/azimuth and casts rays toward the sun, and nodata stays unclassified. Provenance must disclose DSM/DTM semantics, model-grid and ray caps, survey vintage, and omitted effects such as translucency or sub-grid detail.

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

Every `bbox_vector` descriptor declares `params.protocol: overpass | sparql | wfs`; protocol selection is explicit rather than inferred from the endpoint. A SPARQL descriptor supplies a trusted WHERE-body fragment in `params.sparql_query` with exactly one `{{spatial}}` placeholder and a required `?item` variable. The adapter injects bounded `wikibase:around` or `wikibase:box` geography, labels, deterministic limits, result shape, and exact `COUNT(DISTINCT ?item)` tile aggregation. Full queries, nested `SERVICE`, query-form keywords, and update operations are rejected at registration.

Add Wikidata geography layers to `layers/wikidata_places.yaml`. Prefer a precise direct `wdt:P31` class and an empirically bounded radius; broad subclass-property paths can exceed the public query service's hard timeout. State direct-class semantics and Wikidata's uneven coordinate/completeness coverage in provenance rather than implying an exhaustive real-world inventory. All WDQS layers share the existing `wikidata-query-service` limiter group, one request slot, and conservative spacing. Point feature lists are capped and visibly labelled when truncated; tile counts remain exact.

Add standards-based WFS layers to `layers/wfs_features.yaml`. Pin `wfs_version`, the advertised `wfs_type_name`, the exact `wfs_srs_name`, and `wfs_axis_order`; WFS 1.1/2.0 axis conventions are not safe to infer from a familiar-looking EPSG code. `GetCapabilities` must advertise the feature type, the pinned CRS, and a GeoJSON output format before the adapter issues `GetFeature`. Native projected responses are reprojected through the pinned CRS registry into browser GeoJSON. Point mode uses a bounded descriptor radius and is labelled `nearest`; tile `count` uses `resultType=hits`, so it is exact without downloading geometry. Configure `wfs_label_fields` to produce a concise name from provider properties.

The current generic client deliberately requires GeoJSON output. A GML-only service is not compatible merely because its capabilities document loads: record it as blocked, use an equivalent browser-safe service, or materialize it when bounded staleness is acceptable. Do not add an ad-hoc provider parser to UI code.

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

Bounded committed COGs use `browser_access: materialized` with `params.materialization_kind: static_cog` and an exact same-origin Pages URL. The browser verifier still requires HTTP 206 before accepting the asset; the committed provenance sidecar pins its source and output hashes. A GitHub Release download is not a browser path merely because it supports ranges: its final asset host must also prove production-origin CORS.

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

For WFS, verify both point mode and a valid-zoom tile count. The first proves capabilities discovery, bounded GeoJSON retrieval, CRS handling, labels, and browser CORS; the second proves the service's `resultType=hits` count envelope. A national parcel layer must use a hard high-zoom gate so a low-zoom tile cannot ask the service to count millions of polygons.

## 7. Review the change boundary

A descriptor-only layer should normally touch `layers/` plus any static region pack or attribution fixture. If it requires adapter code, state the missing generic capability and test it with at least two descriptor-shaped cases before calling it reusable. Do not hide provider-specific parsing in UI code.

Before merge, confirm the working tree contains no credentials, captured private data, generated browser traces, or unrelated edits. Update `docs/plan.md` only when the change alters a capability, milestone, or accepted limitation.
