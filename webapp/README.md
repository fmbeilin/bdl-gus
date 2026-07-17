# GUS BDL Explorer

Static, serverless web interface for the BDL data store: search variables,
chart them, and download CSV slices. All queries run in the browser via
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) with HTTP range
requests against the Parquet files — no backend.

## Data source resolution

`app.js` picks the parquet base URL automatically:

- **localhost** → `http://localhost:<port>/lake_v2` (the local export next to
  this repo; serve the repo root with a server that supports Range requests,
  e.g. `npx http-server . -p 8321 --cors -c-1`)
- **anywhere else** → `https://huggingface.co/datasets/fmbeilin/gus-bdl/resolve/main`

## Deploying

The app is three static files (`index.html`, `style.css`, `app.js`). Host them
on GitHub Pages, Hugging Face Spaces (static), Cloudflare Pages, or any static
host. Two requirements for the hosted version:

1. The HF dataset `fmbeilin/gus-bdl` must be **public** (browsers cannot attach
   auth headers to DuckDB-WASM parquet reads). While it is private, the app
   only works locally.
2. DuckDB-WASM loads from the jsDelivr CDN, so the host must allow third-party
   scripts (any normal static host does).

## Notes

- Variable/unit search folds Polish diacritics on both sides (including ł→l,
  which Unicode NFD does not decompose).
- The chart caps at 8 series (top by average value, with a notice); the table
  and CSV always contain the full result.
- Chart colors follow the repo's data-viz conventions: fixed-order categorical
  palette, single axis, direct labels ≤ 4 series, legend for ≥ 2.
