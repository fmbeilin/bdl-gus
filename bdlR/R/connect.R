# Internal connection management

#' Get the BDL data store root path
#'
#' Reads from option `bdlR.path` or environment variable `BDL_PATH`.
#' Set with `options(bdlR.path = "/path/to/API GUS")` or `Sys.setenv(BDL_PATH = ...)`.
#'
#' @return Character scalar: path to the data store root.
#' @export
bdl_path <- function() {
  p <- getOption("bdlR.path", default = Sys.getenv("BDL_PATH", unset = NA_character_))
  if (is.na(p) || !nzchar(p)) {
    stop(
      "BDL data store path not set.\n",
      "Use options(bdlR.path = '/path/to/API GUS') or Sys.setenv(BDL_PATH = '...')",
      call. = FALSE
    )
  }
  normalizePath(p, mustWork = TRUE)
}

#' Open a read-only DuckDB connection to the BDL store
#'
#' Connects to `bdl_gus_v2.duckdb`, which holds both the fact tables
#' (facts_gminy, facts_powiaty, facts_podregiony, facts_wojewodztwa,
#' facts_makroregiony) and the metadata (variables, subjects, units, codebook).
#' Falls back to the legacy metadata-only `bdl_gus.duckdb` with a warning if
#' the v2 store is not present.
#'
#' @param path Path to the data store root. Defaults to `bdl_path()`.
#' @return A DBI connection object. Caller is responsible for closing with `DBI::dbDisconnect()`.
#' @export
bdl_connect <- function(path = bdl_path()) {
  db_file <- file.path(path, "bdl_gus_v2.duckdb")
  if (!file.exists(db_file)) {
    legacy <- file.path(path, "bdl_gus.duckdb")
    if (!file.exists(legacy)) {
      stop("DuckDB store not found: ", db_file, call. = FALSE)
    }
    warning("bdl_gus_v2.duckdb not found; falling back to legacy metadata-only ",
            "bdl_gus.duckdb. Fact queries via get_bdl() will not work. ",
            "Run build_bdl_v2.R to create the v2 store.", call. = FALSE)
    db_file <- legacy
  }
  DBI::dbConnect(duckdb::duckdb(), db_file, read_only = TRUE)
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
