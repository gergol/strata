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

## 3. Author the descriptor

Copy the closest existing descriptor in `layers/` and change every field deliberately. The schema is strict: unknown fields and misspellings fail loading.

Required decisions include:

- stable lowercase `id`, user-facing `name`, and `domain`;
- `endpoint`, pinned `crs`, `modes`, and empirical `zoom_valid`;
- `value_type`, aggregation, display `unit`, native unit, scale factor, and nodata where applicable;
- cache TTL and conservative per-layer rate limit;
- licence, commercial-use flag, attribution, coverage, and provenance;
- a health coordinate on real coverage with a bounded expected result;
- `browser_access: direct | materialized | blocked`.

Descriptor changes invalidate cached results automatically because the descriptor hash is part of every cache key.

## 4. Prove the browser boundary

For `browser_access: direct`, test from the production origin `https://gergol.github.io`, not only with curl or Node:

- the actual request method succeeds with `Access-Control-Allow-Origin: *` or the Pages origin;
- COG assets honor a single-byte `Range` request with HTTP 206 and browser-readable CORS headers;
- redirects retain compatible CORS behavior at the final URL;
- browser-forbidden headers such as `User-Agent` are not required by the provider.

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

## 7. Review the change boundary

A descriptor-only layer should normally touch `layers/` plus any static region pack or attribution fixture. If it requires adapter code, state the missing generic capability and test it with at least two descriptor-shaped cases before calling it reusable. Do not hide provider-specific parsing in UI code.

Before merge, confirm the working tree contains no credentials, captured private data, generated browser traces, or unrelated edits. Update `docs/plan.md` only when the change alters a capability, milestone, or accepted limitation.
