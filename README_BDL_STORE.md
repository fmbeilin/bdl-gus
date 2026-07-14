# BDL GUS local store

Local analytical store for GUS BDL (Bank Danych Lokalnych) data, pulled from
the BDL API for all levels from gmina upward. Localities (level 7) were never
successfully extracted.

## Primary store: bdl_gus_v2.duckdb

Single DuckDB file holding all facts and metadata. Built by `build_bdl_v2.R`
from the raw `*_all_long.csv` extracts. Query it directly with DuckDB, or via
the `bdlR` R package (`bdlR/`).

### Fact tables (named by actual GUS unit level)

| Table               | unitLevel | Contents                    | Rows   |
|---------------------|-----------|-----------------------------|--------|
| facts_gminy         | 6         | gminy                       | ~1.05B |
| facts_powiaty       | 5         | powiaty                     | ~155M  |
| facts_podregiony    | 4         | podregiony (subregions)     | ~33M   |
| facts_wojewodztwa   | 2         | województwa (voivodeships)  | ~17M   |
| facts_makroregiony  | 1         | makroregiony (macroregions) | ~7.5M  |

No level 0 (Polska) or level 3 (regiony) data was extracted.

Columns: `variable_id`, `unitId` (12-char zero-padded VARCHAR, GUS unit code),
`unitName`, `unitLevel`, `year`, `value`, `attr_id`.

### Metadata

- `variables`, `subjects` — from the BDL API catalog
- `units` — distinct units with level, voivodeship prefix, first/last year
- `codebook` (view) — readable variable descriptions (variables + subjects joined)
- `facts_all` (view) — UNION ALL over the five fact tables

Example: `SELECT * FROM codebook WHERE variable_id = 6`

## Parquet archive: lake_v2/

One compacted zstd parquet file per level (~1 GB total), exported by
`export_parquet_v2.R`. Portable interchange/backup copy of the fact tables.
When globbing, use `lake_v2/facts_*.parquet` — macOS drops AppleDouble
(`._*`) sidecar files on this exFAT volume that break `*.parquet` globs.

## Naming trap in raw files (historical)

The raw CSV names reflect the extraction endpoint, NOT the contents:

| File                     | Actually contains        |
|--------------------------|--------------------------|
| country_all_long.csv     | makroregiony (level 1)   |
| macroregion_all_long.csv | województwa (level 2)    |
| voivod_all_long.csv      | podregiony (level 4)     |
| powiaty_all_long.csv     | powiaty (level 5)        |
| gminy_all_long.csv       | gminy (level 6)          |

The old parquet lake (`lake/`) inherited this naming AND stored `unitId` as
BIGINT (dropping leading zeros) AND is missing ~95% of subregion variables.
It is superseded by bdl_gus_v2.duckdb.

## Legacy paths (superseded, kept until verified)

- `bdl_gus.duckdb` — old metadata-only DB (facts views are empty stubs)
- `lake/` — hive-partitioned parquet, ~450k tiny files, slow on exFAT
- `*_all_long.csv` — raw extracts (source of truth for rebuilds)
