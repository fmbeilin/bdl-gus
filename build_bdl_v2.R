# Build bdl_gus_v2.duckdb: consolidated native-table store for the BDL data.
#
# Fixes vs the old lake/bdl_gus.duckdb setup:
#   - facts live in native DuckDB tables (no 450k-file parquet lake, no exFAT
#     directory-listing overhead, no AppleDouble ._ file breakage)
#   - tables are named by what they actually contain (the old lake dirs were
#     named after the extraction endpoint: facts_voivod held subregions, etc.)
#   - unitId stored as 12-char zero-padded VARCHAR (old parquet stored BIGINT,
#     dropping the leading zero of the TERYT-style code)
#   - subregion data complete (old lake had 3,674 of 67,962 variables converted)
#   - units table populated; facts views are real, not stubs
#
# Level mapping (GUS BDL unit levels):
#   1 makroregiony   <- country_all_long.csv
#   2 wojewodztwa    <- macroregion_all_long.csv
#   4 podregiony     <- voivod_all_long.csv
#   5 powiaty        <- powiaty_all_long.csv
#   6 gminy          <- gminy_all_long.csv
# No level 0 (Polska) or level 3 (regiony) data was extracted.

library(duckdb)

root <- "/Volumes/Samsung T72/Data/API GUS"
setwd(root)
db_new <- "bdl_gus_v2.duckdb"
if (file.exists(db_new)) file.remove(db_new)

con <- dbConnect(duckdb(), db_new)
dbExecute(con, "SET memory_limit='8GB'")
dbExecute(con, sprintf("SET temp_directory='%s'", file.path(root, "tmp")))

ts <- function(...) cat(format(Sys.time(), "%H:%M:%S"), ..., "\n")

# --- metadata: copy variables + subjects from the old db --------------------
ts("copying metadata tables")
dbExecute(con, sprintf("ATTACH '%s' AS old (READ_ONLY)", file.path(root, "bdl_gus.duckdb")))
dbExecute(con, "CREATE TABLE variables AS SELECT * FROM old.variables")
dbExecute(con, "CREATE TABLE subjects  AS SELECT * FROM old.subjects")
dbExecute(con, "DETACH old")

# --- facts tables, one per real unit level ----------------------------------
sources <- list(
  facts_makroregiony = "country_all_long.csv",
  facts_wojewodztwa  = "macroregion_all_long.csv",
  facts_podregiony   = "voivod_all_long.csv",
  facts_powiaty      = "powiaty_all_long.csv",
  facts_gminy        = "gminy_all_long.csv"
)
for (tbl in names(sources)) {
  csv <- sources[[tbl]]
  ts("loading", tbl, "from", csv)
  dbExecute(con, sprintf("
    CREATE TABLE %s AS
    SELECT variable_id::INTEGER  AS variable_id,
           unitId                 AS unitId,
           unitName               AS unitName,
           unitLevel::TINYINT     AS unitLevel,
           year::SMALLINT         AS year,
           value::DOUBLE          AS value,
           attr_id::TINYINT       AS attr_id
    FROM read_csv('%s', types={'unitId':'VARCHAR'})", tbl, csv))
  n <- dbGetQuery(con, sprintf("SELECT count(*) AS n FROM %s", tbl))$n
  ts("  ->", format(n, big.mark = ","), "rows")
}

# --- units dimension table ---------------------------------------------------
ts("building units table")
dbExecute(con, "
  CREATE TABLE units AS
  SELECT unitId, any_value(unitName) AS unitName, unitLevel,
         substr(unitId, 3, 2) AS voivod_teryt,
         min(year) AS first_year, max(year) AS last_year
  FROM (
    SELECT unitId, unitName, unitLevel, year FROM facts_makroregiony
    UNION ALL SELECT unitId, unitName, unitLevel, year FROM facts_wojewodztwa
    UNION ALL SELECT unitId, unitName, unitLevel, year FROM facts_podregiony
    UNION ALL SELECT unitId, unitName, unitLevel, year FROM facts_powiaty
    UNION ALL SELECT unitId, unitName, unitLevel, year FROM facts_gminy
  )
  GROUP BY unitId, unitLevel")

# --- views -------------------------------------------------------------------
ts("creating views")
dbExecute(con, "
  CREATE VIEW codebook AS
  SELECT v.id AS variable_id, v.subjectId, s.name AS subject_name,
         s.description AS subject_description, s.parentId AS subject_parent_id,
         v.n1, v.n2, v.n3, v.n4, v.n5,
         trim(replace(concat_ws(' | ',
           CASE WHEN v.n1 IS NOT NULL AND v.n1 != 'NA' THEN v.n1 END,
           CASE WHEN v.n2 IS NOT NULL AND v.n2 != 'NA' THEN v.n2 END,
           CASE WHEN v.n3 IS NOT NULL AND v.n3 != 'NA' THEN v.n3 END,
           CASE WHEN v.n4 IS NOT NULL AND v.n4 != 'NA' THEN v.n4 END,
           CASE WHEN v.n5 IS NOT NULL AND v.n5 != 'NA' THEN v.n5 END), ' | ', ' | '))
           AS variable_dimensions,
         v.level AS unit_level, v.measureUnitId, v.measureUnitName,
         concat_ws(': ', s.name, trim(replace(concat_ws(' | ',
           CASE WHEN v.n1 IS NOT NULL AND v.n1 != 'NA' THEN v.n1 END,
           CASE WHEN v.n2 IS NOT NULL AND v.n2 != 'NA' THEN v.n2 END,
           CASE WHEN v.n3 IS NOT NULL AND v.n3 != 'NA' THEN v.n3 END,
           CASE WHEN v.n4 IS NOT NULL AND v.n4 != 'NA' THEN v.n4 END,
           CASE WHEN v.n5 IS NOT NULL AND v.n5 != 'NA' THEN v.n5 END), ' | ', ' | ')))
           AS variable_full_name
  FROM variables v LEFT JOIN subjects s ON v.subjectId = s.id")

dbExecute(con, "
  CREATE VIEW facts_all AS
  SELECT * FROM facts_makroregiony
  UNION ALL SELECT * FROM facts_wojewodztwa
  UNION ALL SELECT * FROM facts_podregiony
  UNION ALL SELECT * FROM facts_powiaty
  UNION ALL SELECT * FROM facts_gminy")

# --- sanity checks -----------------------------------------------------------
ts("running sanity checks")
chk <- dbGetQuery(con, "
  SELECT 'facts_gminy' AS tbl, count(*) AS nrows, count(DISTINCT variable_id) AS nvars,
         count(DISTINCT unitId) AS nunits, min(length(unitId)) AS min_idlen,
         max(length(unitId)) AS max_idlen, count(DISTINCT unitLevel) AS nlevels
  FROM facts_gminy
  UNION ALL
  SELECT 'facts_powiaty', count(*), count(DISTINCT variable_id), count(DISTINCT unitId),
         min(length(unitId)), max(length(unitId)), count(DISTINCT unitLevel) FROM facts_powiaty
  UNION ALL
  SELECT 'facts_podregiony', count(*), count(DISTINCT variable_id), count(DISTINCT unitId),
         min(length(unitId)), max(length(unitId)), count(DISTINCT unitLevel) FROM facts_podregiony
  UNION ALL
  SELECT 'facts_wojewodztwa', count(*), count(DISTINCT variable_id), count(DISTINCT unitId),
         min(length(unitId)), max(length(unitId)), count(DISTINCT unitLevel) FROM facts_wojewodztwa
  UNION ALL
  SELECT 'facts_makroregiony', count(*), count(DISTINCT variable_id), count(DISTINCT unitId),
         min(length(unitId)), max(length(unitId)), count(DISTINCT unitLevel) FROM facts_makroregiony")
print(chk)
lead0 <- dbGetQuery(con, "SELECT count(*) AS n FROM facts_gminy WHERE unitId LIKE '0%'")$n
ts("gminy rows with leading-zero unitId preserved:", format(lead0, big.mark = ","))

dbDisconnect(con, shutdown = TRUE)
ts("done; db size:", round(file.size(db_new) / 1e9, 2), "GB")
