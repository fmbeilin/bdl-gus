# Build variables_en.parquet from variables_en.csv (English per-variable dims).
# Columns: id, n1_en..n5_en, measureUnitName_en, variable_dimensions_en
# (the English analogue of the Polish variable_dimensions label).
library(duckdb)
setwd("/Volumes/Samsung T72/Data/API GUS")
con <- dbConnect(duckdb())
dbExecute(con, "
  COPY (
    SELECT id,
           nullif(nullif(n1,''),'NA') AS n1_en,
           nullif(nullif(n2,''),'NA') AS n2_en,
           nullif(nullif(n3,''),'NA') AS n3_en,
           nullif(nullif(n4,''),'NA') AS n4_en,
           nullif(nullif(n5,''),'NA') AS n5_en,
           measureUnitName AS measureUnitName_en,
           trim(replace(concat_ws(' | ',
             nullif(nullif(n1,''),'NA'), nullif(nullif(n2,''),'NA'),
             nullif(nullif(n3,''),'NA'), nullif(nullif(n4,''),'NA'),
             nullif(nullif(n5,''),'NA')), ' | ', ' | ')) AS variable_dimensions_en
    FROM read_csv('variables_en.csv', header=true,
                  types={'id':'INTEGER','n1':'VARCHAR','n2':'VARCHAR','n3':'VARCHAR',
                         'n4':'VARCHAR','n5':'VARCHAR','measureUnitName':'VARCHAR'})
  ) TO 'lake_v2/variables_en.parquet' (FORMAT parquet, COMPRESSION zstd)")
r <- dbGetQuery(con, "SELECT count(*) n, count(DISTINCT id) u FROM read_parquet('lake_v2/variables_en.parquet')")
cat("variables_en.parquet:", r$n, "rows,", r$u, "distinct ids\n")
print(dbGetQuery(con, "SELECT id, n1_en, variable_dimensions_en, measureUnitName_en FROM read_parquet('lake_v2/variables_en.parquet') LIMIT 4"))
dbDisconnect(con, shutdown=TRUE)
