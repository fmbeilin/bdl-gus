# Parse the Eurostat LAU<->NUTS3 correspondence (one sheet per country) into a
# single crosswalk table, then verify our Polish BDL codes actually join to it.
suppressMessages({library(readxl); library(duckdb)})
SCRATCH <- Sys.getenv("GEO_SCRATCH"); setwd("/Volumes/Samsung T72/Data/API GUS")
f <- file.path(SCRATCH, "lau_nuts_2021.xlsx")
sheets <- excel_sheets(f)
countries <- sheets[nchar(sheets) == 2]          # skip "File info" / "Overview ..."
out <- list()
for (cc in countries) {
  d <- suppressMessages(read_excel(f, sheet = cc, col_types = "text"))
  names(d) <- toupper(trimws(names(d)))
  need <- c("NUTS 3 CODE", "LAU CODE")
  if (!all(need %in% names(d))) next
  out[[cc]] <- data.frame(
    country    = cc,
    nuts3_code = d[["NUTS 3 CODE"]],
    lau_code   = d[["LAU CODE"]],
    lau_name   = if ("LAU NAME LATIN" %in% names(d)) d[["LAU NAME LATIN"]] else NA_character_,
    degurba    = if ("DEGURBA" %in% names(d)) d[["DEGURBA"]] else NA_character_,
    vintage    = 2021L, stringsAsFactors = FALSE)
}
x <- do.call(rbind, out)
x <- x[!is.na(x$lau_code) & !is.na(x$nuts3_code), ]
cat("crosswalk rows:", nrow(x), "across", length(unique(x$country)), "countries\n")

con <- dbConnect(duckdb())
duckdb_register(con, "xw", x)
dbExecute(con, "COPY (SELECT * FROM xw) TO 'lake_v2/lau_nuts_xwalk.parquet' (FORMAT parquet, COMPRESSION zstd)")

# --- validate the Polish rule: eurostat_lau = '10' || substr(bdl_unitId,1,11) ---
cat("\n=== validating PL BDL -> Eurostat LAU join ===\n")
print(dbGetQuery(con, "
  WITH pl AS (
    SELECT unitId, unitName FROM read_parquet('lake_v2/units.parquet') WHERE unitLevel = 6
  ), mapped AS (
    SELECT p.unitId, p.unitName, '10' || substr(p.unitId, 1, 11) AS lau_guess FROM pl p
  )
  SELECT count(*) AS bdl_gminy,
         count(x.lau_code) AS matched_in_eurostat,
         round(100.0 * count(x.lau_code) / count(*), 1) AS pct
  FROM mapped m LEFT JOIN xw x ON x.lau_code = m.lau_guess AND x.country = 'PL'"))
cat("\n=== sample joined rows (BDL gmina -> NUTS3) ===\n")
print(dbGetQuery(con, "
  SELECT m.unitName, m.unitId AS bdl_code, x.lau_code, x.nuts3_code, x.degurba
  FROM (SELECT unitId, unitName, '10' || substr(unitId,1,11) AS lau_guess
        FROM read_parquet('lake_v2/units.parquet') WHERE unitLevel = 6) m
  JOIN xw x ON x.lau_code = m.lau_guess AND x.country = 'PL'
  ORDER BY m.unitName LIMIT 5"))
dbDisconnect(con, shutdown=TRUE)
