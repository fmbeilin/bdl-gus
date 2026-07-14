# Internal connection management

#' Get the BDL data store root path
#'
#' Reads from option `bdlR.path` or environment variable `BDL_PATH`.
#' Set with `options(bdlR.path = "/path/to/API GUS")` or `Sys.setenv(BDL_PATH = ...)`.
#'
#' @return Character scalar: path to the data store root, or `NA_character_`
#'   if not set (in which case connections fall back to the remote store).
#' @export
bdl_path <- function() {
  p <- getOption("bdlR.path", default = Sys.getenv("BDL_PATH", unset = NA_character_))
  if (is.na(p) || !nzchar(p)) return(NA_character_)
  normalizePath(p, mustWork = TRUE)
}

#' Get the Hugging Face dataset repo used as the remote store
#'
#' Reads from option `bdlR.hf_repo`; defaults to `"fmbeilin/gus-bdl"`.
#'
#' @return Character scalar, e.g. `"fmbeilin/gus-bdl"`.
#' @export
bdl_remote_repo <- function() {
  getOption("bdlR.hf_repo", default = "fmbeilin/gus-bdl")
}

# Locate a Hugging Face token for private-repo access: HF_TOKEN env var,
# then the hf CLI token cache. Returns NA if none found (fine for public repos).
#' @keywords internal
.hf_token <- function() {
  tok <- Sys.getenv("HF_TOKEN", unset = NA_character_)
  if (!is.na(tok) && nzchar(tok)) return(tok)
  tf <- path.expand("~/.cache/huggingface/token")
  if (file.exists(tf)) {
    tok <- trimws(readLines(tf, n = 1L, warn = FALSE))
    if (nzchar(tok)) return(tok)
  }
  NA_character_
}

#' Open a DuckDB connection to the remote (Hugging Face) BDL store
#'
#' Creates an in-memory DuckDB with views over the parquet files hosted in the
#' Hugging Face dataset repo, so the same table names work as in the local
#' store (facts_gminy, ..., codebook, units, variables, subjects). Queries are
#' served over HTTP with predicate pushdown — only the row groups a query
#' needs are downloaded.
#'
#' For private repos, a token is picked up from the `HF_TOKEN` environment
#' variable or the `hf` CLI login cache.
#'
#' @param repo Hugging Face dataset repo. Defaults to [bdl_remote_repo()].
#' @return A DBI connection object. Caller is responsible for closing with `DBI::dbDisconnect()`.
#' @export
bdl_connect_remote <- function(repo = bdl_remote_repo()) {
  con <- DBI::dbConnect(duckdb::duckdb(), ":memory:")
  DBI::dbExecute(con, "INSTALL httpfs; LOAD httpfs;")
  tok <- .hf_token()
  if (!is.na(tok)) {
    DBI::dbExecute(con, sprintf(
      "CREATE SECRET IF NOT EXISTS hf_auth (TYPE huggingface, TOKEN '%s')",
      gsub("'", "''", tok)))
  }
  base <- sprintf("hf://datasets/%s", repo)
  tables <- c("facts_gminy", "facts_powiaty", "facts_podregiony",
              "facts_wojewodztwa", "facts_makroregiony",
              "codebook", "units", "variables", "subjects")
  for (t in tables) {
    DBI::dbExecute(con, sprintf(
      "CREATE VIEW %s AS SELECT * FROM read_parquet('%s/%s.parquet')", t, base, t))
  }
  con
}

#' Open a read-only DuckDB connection to the BDL store
#'
#' Connects to the local `bdl_gus_v2.duckdb`, which holds both the fact tables
#' (facts_gminy, facts_powiaty, facts_podregiony, facts_wojewodztwa,
#' facts_makroregiony) and the metadata (variables, subjects, units, codebook).
#'
#' If no local store is available — `bdlR.path`/`BDL_PATH` unset, or the
#' DuckDB file missing — falls back to the remote Hugging Face store via
#' [bdl_connect_remote()], with a message.
#'
#' @param path Path to the data store root. Defaults to `bdl_path()`;
#'   `NA` triggers the remote fallback.
#' @return A DBI connection object. Caller is responsible for closing with `DBI::dbDisconnect()`.
#' @export
bdl_connect <- function(path = bdl_path()) {
  if (!is.na(path)) {
    db_file <- file.path(path, "bdl_gus_v2.duckdb")
    if (file.exists(db_file)) {
      return(DBI::dbConnect(duckdb::duckdb(), db_file, read_only = TRUE))
    }
    legacy <- file.path(path, "bdl_gus.duckdb")
    if (file.exists(legacy)) {
      warning("bdl_gus_v2.duckdb not found; falling back to legacy metadata-only ",
              "bdl_gus.duckdb. Fact queries via get_bdl() will not work. ",
              "Run build_bdl_v2.R to create the v2 store.", call. = FALSE)
      return(DBI::dbConnect(duckdb::duckdb(), legacy, read_only = TRUE))
    }
  }
  message("No local BDL store found; using remote store hf://datasets/",
          bdl_remote_repo(), " (set options(bdlR.path=...) for local).")
  bdl_connect_remote()
}

# Package-level connection cache (one per session)
.bdl_env <- new.env(parent = emptyenv())

#' Get or create a cached metadata connection
#' @keywords internal
.meta_con <- function() {
  if (!exists("con", envir = .bdl_env) || !DBI::dbIsValid(.bdl_env$con)) {
    .bdl_env$con <- bdl_connect()
    reg.finalizer(.bdl_env, function(e) {
      if (exists("con", envir = e) && DBI::dbIsValid(e$con)) {
        DBI::dbDisconnect(e$con, shutdown = TRUE)
      }
    }, onexit = TRUE)
  }
  .bdl_env$con
}

#' Close the cached metadata connection
#' @export
bdl_disconnect <- function() {
  if (exists("con", envir = .bdl_env) && DBI::dbIsValid(.bdl_env$con)) {
    DBI::dbDisconnect(.bdl_env$con, shutdown = TRUE)
    rm("con", envir = .bdl_env)
  }
  invisible(NULL)
}
