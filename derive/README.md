# Static precomputed indexes

Phase 1 bulk sources are reduced outside the browser with DuckDB, then committed as small same-origin JSON indexes. The application never downloads a global Parquet file to answer one click. Each recipe pins its source URL, columns, geographic cut, ordering, and output path; `data/provenance/precomputed.json` records the output hash and source release.

Run from the repository root with DuckDB 1.4 or newer:

```sh
duckdb < derive/ookla-vienna.sql
duckdb < derive/gisco-population-vienna.sql
sha256sum packages/client/public/data/*vienna*.json
```

These are static release recipes, not part of the hourly Pages build. Updating a source period is a reviewed data change: update the SQL URL/output name, descriptor provenance, canary, and provenance manifest; regenerate; then run the normal browser-boundary verification.
