# Export parquet archives from bdl_gus_v2.duckdb into lake_v2/.
#
# Large levels (gminy, powiaty) are split into parts by variable_id range so
# remote readers (DuckDB-WASM in the webapp, bdlR over hf://) fetch one small
# file instead of probing a 700 MB footer: each part has a compact footer and
# a query for one variable touches 1 part + 1-2 row groups. A manifest.json
# maps variable_id ranges to part files. Small levels stay single-file.
#
# Data is insertion-ordered by variable_id, so parts are contiguous ranges.

library(duckdb)

root <- "/Volumes/Samsung T72/Data/API GUS"
setwd(root)
dir.create("lake_v2", showWarnings = FALSE)

con <- dbConnect(duckdb(), "bdl_gus_v2.duckdb", read_only = TRUE)
dbExecute(con, "SET memory_limit='8GB'")

ts <- function(...) cat(format(Sys.time(), "%H:%M:%S"), ..., "\n")

PARTS <- list(facts_gminy = 16L, facts_powiaty = 4L,
              facts_podregiony = 1L, facts_wojewodztwa = 1L, facts_makroregiony = 1L)
manifest <- list()

for (tbl in names(PARTS)) {
  n_parts <- PARTS[[tbl]]
  if (n_parts == 1L) {
    out <- file.path("lake_v2", paste0(tbl, ".parquet"))
    ts("exporting", tbl, "->", out)
    dbExecute(con, sprintf(
      "COPY %s TO '%s' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000)", tbl, out))
    rng <- dbGetQuery(con, sprintf("SELECT min(variable_id) AS lo, max(variable_id) AS hi FROM %s", tbl))
    manifest[[tbl]] <- list(list(file = basename(out), var_min = rng$lo, var_max = rng$hi))
    next
  }
  # bucket variables into n_parts groups of roughly equal row count
  buckets <- dbGetQuery(con, sprintf("
    WITH vc AS (
      SELECT variable_id, count(*) AS n FROM %s GROUP BY variable_id
    ), cum AS (
      SELECT variable_id,
             least(%d - 1, floor(%d * (sum(n) OVER (ORDER BY variable_id) - n) /
                                 (SELECT sum(n) FROM vc)))::INT AS bucket
      FROM vc
    )
    SELECT bucket, min(variable_id) AS lo, max(variable_id) AS hi
    FROM cum GROUP BY bucket ORDER BY bucket", tbl, n_parts, n_parts))
  part_dir <- file.path("lake_v2", tbl)
  dir.create(part_dir, showWarnings = FALSE)
  entries <- list()
  for (i in seq_len(nrow(buckets))) {
    out <- file.path(part_dir, sprintf("part-%03d.parquet", buckets$bucket[i]))
    ts("exporting", tbl, "part", buckets$bucket[i],
       sprintf("(vars %d-%d)", buckets$lo[i], buckets$hi[i]))
    dbExecute(con, sprintf(
      "COPY (SELECT * FROM %s WHERE variable_id BETWEEN %d AND %d)
       TO '%s' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000)",
      tbl, buckets$lo[i], buckets$hi[i], out))
    entries[[i]] <- list(file = paste0(tbl, "/", basename(out)),
                         var_min = buckets$lo[i], var_max = buckets$hi[i])
  }
  manifest[[tbl]] <- entries
}

writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE),
           "lake_v2/manifest.json")
ts("manifest written")

# metadata exports (unchanged)
for (m in c("codebook", "units", "variables", "subjects")) {
  out <- file.path("lake_v2", paste0(m, ".parquet"))
  ts("exporting", m)
  dbExecute(con, sprintf("COPY (SELECT * FROM %s) TO '%s' (FORMAT parquet, COMPRESSION zstd)", m, out))
}

dbDisconnect(con, shutdown = TRUE)
ts("done")
