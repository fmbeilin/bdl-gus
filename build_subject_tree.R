library(duckdb); setwd("/Volumes/Samsung T72/Data/API GUS")
con <- dbConnect(duckdb())
dbExecute(con, "
  COPY (
    SELECT subjectId,
           name_pl, name_en,
           nullif(theme_id,'') AS theme_id,
           coalesce(nullif(theme_pl,''),'POZOSTAŁE')  AS theme_pl,
           coalesce(nullif(theme_en,''),'OTHER')      AS theme_en,
           nullif(group_id,'') AS group_id,
           coalesce(nullif(group_pl,''),'—')          AS group_pl,
           coalesce(nullif(group_en,''),'—')          AS group_en
    FROM read_csv('subject_tree.csv', header=true, types={'subjectId':'VARCHAR'})
    WHERE has_variables = 1 OR subjectId LIKE 'P%'
  ) TO 'lake_v2/subject_tree.parquet' (FORMAT parquet, COMPRESSION zstd)")
r <- dbGetQuery(con, "SELECT count(*) n, count(DISTINCT theme_id) themes, count(DISTINCT group_id) groups FROM read_parquet('lake_v2/subject_tree.parquet')")
cat("subject_tree.parquet:", r$n, "subjects,", r$themes, "themes,", r$groups, "groups\n")
dbDisconnect(con, shutdown=TRUE)
