COPY (
  SELECT
    GRD_ID AS key,
    CAST(TOT_P_2021 AS BIGINT) AS population,
    X_LLC AS x_llc,
    Y_LLC AS y_llc
  FROM read_parquet('https://gisco-services.ec.europa.eu/grid/grid_1km.parquet')
  WHERE CNTR_ID = 'AT'
    AND NUTS2021_2 = 'AT13'
    AND TOT_P_2021 IS NOT NULL
  ORDER BY GRD_ID
) TO 'packages/client/public/data/gisco-population-vienna-2021.json'
  (FORMAT JSON, ARRAY true);
