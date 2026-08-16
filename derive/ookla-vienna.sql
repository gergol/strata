COPY (
  SELECT
    quadkey AS key,
    round(avg_d_kbps / 1000.0, 1) AS avg_download_mbps,
    round(avg_u_kbps / 1000.0, 1) AS avg_upload_mbps,
    avg_lat_ms AS avg_latency_ms,
    tests,
    devices
  FROM read_parquet(
    'https://ookla-open-data.s3.amazonaws.com/parquet/performance/type=fixed/year=2026/quarter=1/2026-01-01_performance_fixed_tiles.parquet'
  )
  WHERE tile_x BETWEEN 16.15 AND 16.65
    AND tile_y BETWEEN 48.05 AND 48.4
  ORDER BY quadkey
) TO 'packages/client/public/data/ookla-fixed-vienna-2026q1.json'
  (FORMAT JSON, ARRAY true);
