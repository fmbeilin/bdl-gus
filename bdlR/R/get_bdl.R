#' Query BDL data
#'
#' Main function for retrieving data from the local BDL store
#' (`bdl_gus_v2.duckdb`), which holds native fact tables per geographic level.
#'
#' @param variables Integer vector of variable IDs, or `NULL` for all variables
#'   in the selected subjects. At least one of `variables` or `subjects` must be
#'   provided.
#' @param subjects Character vector of subject codes (e.g. `"K3"`, `"P1312"`),
#'   or `NULL`. All variables under each subject are included.
#' @param level Geographic level. One of `"gmina"` (unitLevel 6), `"powiat"`
#'   (5), `"subregion"` (4), `"voivod"` (2), `"macroregion"` (1).
#'   Default: `"gmina"`. Polish aliases (e.g. `"podregion"`, `"wojewodztwo"`,
#'   `"makroregion"`) are also accepted. No national-level (level 0) aggregate
#'   is available.
#' @param years Integer vector of years to include, or `NULL` for all years.
#' @param units Character vector of unit IDs (12-char zero-padded GUS codes;
#'   IDs that lost their leading zeros are normalised automatically) or unit
#'   names, or `NULL` for all units.
#' @param unit_level Deprecated and ignored: each fact table now contains a
#'   single unit level, selected via `level`.
#' @param dims Named list of dimension filters, e.g. `list(n1 = "ogółem")` or
#'   `list(n1 = c("kobiety", "mężczyźni"), n2 = c("ogółem", NA))`. Each name
#'   corresponds to a dimension column (`n1`–`n5`). `NA` in a value vector
#'   matches rows where that column is empty. Applied via the codebook before
#'   scanning facts, so only matching variables are read.
#' @param aggregate Logical. If `TRUE`, shorthand for filtering to aggregate
#'   (ogółem) values across all dimensions — equivalent to
#'   `dims = list(n1="ogółem", n2=c("ogółem",NA), n3=c("ogółem",NA))`.
#'   Returns the "headline" figure without any cross-tabulation. Default `FALSE`.
#' @param add_labels Logical. If `TRUE` (default), joins variable metadata
#'   (subject name, dimensions, measure unit) from the codebook.
#' @param path Path to the data store root. Defaults to `bdl_path()`.
#'
#' @return A `data.frame` with columns:
#'   `variable_id`, `unitId`, `unitName`, `unitLevel`, `year`, `value`,
#'   and (if `add_labels = TRUE`) `subject_name`, `variable_dimensions`,
#'   `measureUnitName`, `variable_full_name`.
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#'
#' # Population totals for all gminy, all years
#' get_bdl(variables = 6, level = "gmina")
#'
#' # Aggregate (ogółem) totals for a subject, all gminy, 2020
#' get_bdl(subjects = "P1312", level = "gmina", years = 2020, aggregate = TRUE)
#'
#' # Female-only breakdown for a subject
#' get_bdl(subjects = "P1313", level = "gmina", years = 2020, dims = list(n1 = "kobiety"))
#'
#' # Specific gminy by GUS unit ID (leading zeros optional)
#' get_bdl(variables = 6, units = c("011212001011", "21200000000"))
#'
#' # All variables for one gmina — fast on the v2 store
#' get_bdl(subjects = "K3", units = "Bochnia", years = 2010:2024)
#' }
#' @export
get_bdl <- function(
  variables  = NULL,
  subjects   = NULL,
  level      = "gmina",
  years      = NULL,
  units      = NULL,
  unit_level = NULL,
  dims       = NULL,
  aggregate  = FALSE,
  add_labels = TRUE,
  path       = bdl_path()
) {
  if (is.null(variables) && is.null(subjects)) {
    stop("Provide at least one of `variables` or `subjects`.", call. = FALSE)
  }
  if (isTRUE(aggregate) && !is.null(dims)) {
    stop("`aggregate` and `dims` cannot both be specified.", call. = FALSE)
  }
  if (!is.null(unit_level)) {
    warning("`unit_level` is deprecated and ignored; each fact table holds a ",
            "single unit level, selected via `level`.", call. = FALSE)
  }

  fact_table <- .resolve_level(level)
  con <- .meta_con()

  # Resolve subject codes -> variable IDs
  var_ids <- if (!is.null(variables)) as.integer(variables) else integer(0)
  if (!is.null(subjects)) {
    subj_var_ids <- .subjects_to_var_ids(subjects, con)
    var_ids <- unique(c(var_ids, subj_var_ids))
  }

  # Resolve dimension filters -> narrow var_ids via codebook
  if (isTRUE(aggregate)) {
    dims <- list(n1 = "ogółem", n2 = c("ogółem", NA), n3 = c("ogółem", NA))
  }
  if (!is.null(dims)) {
    base <- if (length(var_ids) > 0) var_ids else NULL
    var_ids <- .dims_to_var_ids(dims, base, con)
    if (length(var_ids) == 0) {
      warning("No variables matched the specified `dims` filter.", call. = FALSE)
      return(data.frame())
    }
  }

  sql <- paste0(
    "SELECT variable_id, unitId, unitName, unitLevel, year, value FROM ",
    fact_table, " WHERE 1=1"
  )

  if (length(var_ids) > 0) {
    sql <- paste0(sql, " AND variable_id IN (", paste(var_ids, collapse = ", "), ")")
  }

  if (!is.null(years)) {
    sql <- paste0(sql, " AND year IN (", paste(as.integer(years), collapse = ", "), ")")
  }

  if (!is.null(units)) {
    # Split into ID-like values (digits only) and unit names
    units <- trimws(as.character(units))
    id_like <- grepl("^[0-9]+$", units)
    conditions <- character(0)
    if (any(id_like)) {
      ids <- .normalize_unit_id(units[id_like])
      id_sql <- paste0("'", ids, "'", collapse = ", ")
      conditions <- c(conditions, paste0("unitId IN (", id_sql, ")"))
    }
    if (any(!id_like)) {
      name_sql <- paste0("'", gsub("'", "''", units[!id_like]), "'", collapse = ", ")
      conditions <- c(conditions, paste0("unitName IN (", name_sql, ")"))
    }
    sql <- paste0(sql, " AND (", paste(conditions, collapse = " OR "), ")")
  }

  result <- DBI::dbGetQuery(con, sql)

  # Join codebook labels
  if (add_labels && nrow(result) > 0) {
    vid_sql <- paste(unique(result$variable_id), collapse = ", ")
    cb <- DBI::dbGetQuery(
      con,
      paste0(
        "SELECT variable_id, subject_name, variable_dimensions, measureUnitName, variable_full_name ",
        "FROM codebook WHERE variable_id IN (", vid_sql, ")"
      )
    )
    result <- merge(result, cb, by = "variable_id", all.x = TRUE, sort = FALSE)
  }

  result
}
