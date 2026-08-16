# Derivation toolchain

Phase 2's reproducible vector pipeline turns a pinned GeoJSON or FlatGeobuf
input into a PMTiles v3 archive. The runner verifies the input digest, requires
Tippecanoe 2.17 or newer, invokes it without a shell, decodes the completed
archive with the reference PMTiles library, and writes a versioned provenance
sidecar. Existing outputs are replaced only after the temporary archive passes
validation.

Each strict JSON recipe records:

- the canonical source URL, release, source SHA-256, and licence;
- the prepared input path, format, and SHA-256;
- every source-specific transformation performed before tiling;
- the vector layer metadata, zoom range, retained properties, and attribution;
- one publication target: `pages`, `release`, or `local` for the smoke test.

Source-specific scripts remain responsible for downloading, validating, and
transforming upstream releases. That boundary is intentional: crop parcels,
terrain products, and transmitter inventories have different extraction and
join rules, while the final tiling and provenance contract must stay identical.

The first raster recipe is `derive/vienna-surface-cog.sh`. It verifies the
official Vienna DOM archive hash, average-resamples tile 35_4 from 0.5 m to a
browser-sized 2 m surface model, writes a tiled/overviewed ZSTD COG, requires a
bit-identical output hash, and validates the COG structure. The
bounded 7.3 MB COG is committed below the client data tree for same-origin
Pages range reads. The `verify-terrain` workflow independently rebuilds it and
requires a byte-for-byte match with the committed artifact and provenance hash.

Run the real integration smoke test from the repository root:

```sh
npm ci
npm run derive:smoke
```

The smoke command builds the same recipe twice, requires identical archive
SHA-256 digests, and then reopens the result for independent verification.

Build or verify a production recipe explicitly:

```sh
npm run derive:pmtiles -- build derive/recipes/example.pmtiles.json
npm run derive:pmtiles -- verify derive/recipes/example.pmtiles.json
```

`pages` recipes must write below `packages/client/public/data/derived/`; their
archive and sidecar are committed and the normal Pages workflow deploys them.
`release` recipes must write below `data/derived/`; the manual
`publish-derived` workflow uploads both files to an existing immutable GitHub
Release and refuses to replace an existing asset. Large archives belong in
Releases; only bounded assets belong in the repository and Pages artifact.

The smoke recipe uses the tiny internal bidding-zone fixture and writes only to
the ignored `.cache/derive/` directory. CI runs it with real Tippecanoe and then
reopens the archive through the same decoder used for production verification.

## Phase 1 static precomputed indexes

Phase 1 bulk sources are reduced outside the browser with DuckDB, then committed as small same-origin JSON indexes. The application never downloads a global Parquet file to answer one click. Each recipe pins its source URL, columns, geographic cut, ordering, and output path; `data/provenance/precomputed.json` records the output hash and source release.

Run from the repository root with DuckDB 1.4 or newer:

```sh
duckdb < derive/ookla-vienna.sql
duckdb < derive/gisco-population-vienna.sql
sha256sum packages/client/public/data/*vienna*.json
```

These are static release recipes, not part of the hourly Pages build. Updating a source period is a reviewed data change: update the SQL URL/output name, descriptor provenance, canary, and provenance manifest; regenerate; then run the normal browser-boundary verification.
