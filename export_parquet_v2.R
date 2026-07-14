# Export compacted parquet archives from bdl_gus_v2.duckdb.
# One file per level under lake_v2/ — portable, openable by any parquet reader.
# Row-group stats give predicate pushdown on variable_id (insertion order is
# grouped by variable) and on unitId within each variable block.

library(duckdb)

root <- "/Volumes/Samsung T72/Data/API GUS"
setwd(root)
dir.create("lake_v2", showWarnings = FALSE)

con <- dbConnect(duckdb(), "bdl_gus_v2.duckdb", read_only = TRUE)
dbExecute(con, "SET memory_limit='8GB'")

ts <- function(...) cat(format(Sys.time(), "%H:%M:%S"), ..., "\n")

for (tbl in c("facts_makroregiony", "facts_wojewodztwa", "facts_podregiony",
              "facts_powiaty", "facts_gminy")) {
  out <- file.path("lake_v2", paste0(tbl, ".parquet"))
  ts("exporting", tbl, "->", out)
  dbExecute(con, sprintf(
    "COPY %s TO '%s' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000)",
    tbl, out))
  ts("  ->", round(file.size(out) / 1e9, 2), "GB")
}

dbDisconnect(con, shutdown = TRUE)
ts("done")
