# Build the cross-country geography spine from Eurostat GISCO reference data.
#
# Why this exists: territorial codes are NOT stable. LAU rows fall from 116,901
# (2011) to 97,987 (2024) through mergers, codes get reused, and NUTS has been
# revised 7 times. Any cross-country panel that treats a code as a fixed place
# will silently compare different territories across years. So every unit is
# stored per VINTAGE, and validity is derived from the vintages it appears in.
library(duckdb)
SCRATCH <- Sys.getenv("GEO_SCRATCH")
setwd("/Volumes/Samsung T72/Data/API GUS")
con <- dbConnect(duckdb())

# ---- NUTS: level and parent are derivable from the code itself ----
dbExecute(con, sprintf("
  CREATE TABLE nuts AS
  SELECT 'NUTS' AS classification,
         CAST(regexp_extract(filename, 'nuts_(\\d{4})', 1) AS INTEGER) AS vintage,
         CNTR_CODE AS country,
         NUTS_ID   AS code,
         CASE length(NUTS_ID) WHEN 2 THEN 'NUTS0' WHEN 3 THEN 'NUTS1'
              WHEN 4 THEN 'NUTS2' WHEN 5 THEN 'NUTS3' ELSE 'NUTS?' END AS level,
         NAME_LATN AS name_latn,
         NUTS_NAME AS name_local,
         CASE WHEN length(NUTS_ID) > 2 THEN substr(NUTS_ID, 1, length(NUTS_ID)-1) END AS parent_code
  FROM read_csv('%s/nuts_*.csv', union_by_name=true, filename=true,
                types={'NUTS_ID':'VARCHAR','CNTR_CODE':'VARCHAR'})", SCRATCH))

# ---- LAU: 2024 dropped LAU_ID, so fall back to the GISCO_ID suffix ----
dbExecute(con, sprintf("
  CREATE TABLE lau AS
  SELECT 'LAU' AS classification,
         CAST(regexp_extract(filename, 'lau_(\\d{4})', 1) AS INTEGER) AS vintage,
         CNTR_CODE AS country,
         coalesce(nullif(LAU_ID,''), regexp_replace(GISCO_ID, '^[A-Z]{2}_', '')) AS code,
         'LAU' AS level,
         LAU_NAME AS name_latn,
         LAU_NAME AS name_local,
         CAST(NULL AS VARCHAR) AS parent_code   -- filled from the Eurostat LAU<->NUTS crosswalk
  FROM read_csv('%s/lau_*.csv', union_by_name=true, filename=true,
                types={'LAU_ID':'VARCHAR','GISCO_ID':'VARCHAR','CNTR_CODE':'VARCHAR','LAU_NAME':'VARCHAR'})
  WHERE CNTR_CODE IS NOT NULL", SCRATCH))

dbExecute(con, "
  CREATE TABLE geo_units AS
  SELECT * FROM nuts UNION ALL BY NAME SELECT * FROM lau")

# ---- validity: which vintages does each code appear in? ----
dbExecute(con, "
  CREATE TABLE geo_validity AS
  SELECT classification, country, level, code,
         any_value(name_latn) AS name_latn,
         min(vintage) AS first_vintage, max(vintage) AS last_vintage,
         count(DISTINCT vintage) AS n_vintages
  FROM geo_units GROUP BY classification, country, level, code")

dbExecute(con, "COPY geo_units    TO 'lake_v2/geo_units.parquet'    (FORMAT parquet, COMPRESSION zstd)")
dbExecute(con, "COPY geo_validity TO 'lake_v2/geo_validity.parquet' (FORMAT parquet, COMPRESSION zstd)")

cat("=== spine built ===\n")
print(dbGetQuery(con, "SELECT classification, level, count(*) AS rows, count(DISTINCT code) AS codes, count(DISTINCT country) AS countries FROM geo_units GROUP BY 1,2 ORDER BY 1,2"))
cat("\n=== code churn (units that did NOT survive all vintages) ===\n")
print(dbGetQuery(con, "
  SELECT classification,
         count(*) FILTER (WHERE n_vintages = (SELECT count(DISTINCT vintage) FROM geo_units g2 WHERE g2.classification = v.classification)) AS stable,
         count(*) FILTER (WHERE n_vintages < (SELECT count(DISTINCT vintage) FROM geo_units g2 WHERE g2.classification = v.classification)) AS churned
  FROM geo_validity v GROUP BY 1"))
dbDisconnect(con, shutdown=TRUE)
