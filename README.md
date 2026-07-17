# bdl-gus — Polish Local Data Bank, unlocked

A complete extract of the GUS [Bank Danych Lokalnych](https://bdl.stat.gov.pl)
(Local Data Bank of Statistics Poland) — **~1.26 billion observations**: every
published variable at every administrative level from gmina (municipality)
upward, 1995–2024 — plus the tools to query it in seconds instead of clicking
through the official download interface.

## Use the data

**🌐 Explorer app** — search variables, chart them, download CSV, straight from
your browser (no install, no server; DuckDB-WASM queries hosted Parquet in
place): see [webapp/](webapp/), live at the GitHub Pages URL of this repo.

**🗄️ Bulk data** — hosted as Parquet at
[huggingface.co/datasets/fmbeilin/gus-bdl](https://huggingface.co/datasets/fmbeilin/gus-bdl).
Query it from anywhere with DuckDB:

```sql
SELECT f.year, f.value, c.variable_full_name
FROM read_parquet('hf://datasets/fmbeilin/gus-bdl/facts_gminy.parquet') f
JOIN read_parquet('hf://datasets/fmbeilin/gus-bdl/codebook.parquet') c USING (variable_id)
WHERE f.unitId = '011212001011'          -- gmina Bochnia
  AND c.subject_name LIKE 'Ludność wg płci%';
```

**📦 R package** — [bdlR/](bdlR/) provides `search_subjects()`,
`search_variables()`, `get_bdl()` and friends over a local store, falling back
to the hosted dataset automatically when no local store is present:

```r
# install.packages("devtools"); devtools::install_github("fmbeilin/bdl-gus", subdir = "bdlR")
library(bdlR)
search_subjects("bezrobocie")
get_bdl(subjects = "P2917", level = "powiat", years = 2015:2024, aggregate = TRUE)
```

## Repository layout

| Path | What |
|---|---|
| `webapp/` | Serverless explorer (vanilla JS + DuckDB-WASM) |
| `bdlR/` | R package for querying the store |
| `build_bdl_v2.R` | Builds the consolidated DuckDB store from raw API extracts |
| `export_parquet_v2.R` | Exports the compacted Parquet files hosted on HF |
| `variables_catalog.csv`, `subjects_catalog.csv` | Variable/subject metadata from the BDL API |
| `gmina_teryt_codes.txt`, `swagger.json` | Unit codes and the BDL API spec |
| `README_BDL_STORE.md` | Store layout, schema, and the raw-file naming caveats |

Data files themselves are not in git — they live on Hugging Face (see above).

## Level naming, or: read this before touching raw extracts

BDL unit levels: 1 makroregiony, 2 województwa, 4 podregiony, 5 powiaty,
6 gminy. The historical raw extract files are named after the API endpoint
used, *not* their contents (e.g. `voivod_all_long.csv` holds subregions) — the
mapping table is in [README_BDL_STORE.md](README_BDL_STORE.md). Everything
published on Hugging Face and in the v2 store uses correct level names.

## License & attribution

Code and documentation: [MIT](LICENSE). Data source: Główny Urząd Statystyczny
(Statistics Poland), Bank Danych Lokalnych, bdl.stat.gov.pl — reusable with
attribution to GUS. This project is independent and not affiliated with or
endorsed by GUS.
