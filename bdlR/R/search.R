#' Search subjects by keyword
#'
#' Returns one row per matching subject (concept), not per variable. Use this
#' as the first step to discover what data is available without being
#' overwhelmed by dimension variants. Follow up with [get_subject_dims()] to
#' see available breakdowns, then pass the `subjectId` to [get_bdl()].
#'
#' @param query Character scalar. Keyword to search in subject names (Polish).
#' @param level Optional integer. Restrict to subjects available at a specific
#'   unit level (`6` = gmina, `5` = powiat, `4` = subregion, `2` = voivodeship).
#'   `NULL` returns all levels.
#'
#' @return A `data.frame` with columns:
#'   - `subjectId` — pass to [get_bdl()] or [get_subject_dims()]
#'   - `subject_name` — human-readable concept label
#'   - `n_variables` — total number of variant variables
#'   - `n_aggregate` — number of aggregate (ogółem) variants
#'   - `n1_breakdowns` — distinct values of the primary dimension (n1)
#'   - `example_variable_id` — smallest variable_id for quick lookup
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#'
#' search_subjects("bezrobocie")
#' search_subjects("ludność", level = 6)
#' }
#' @export
search_subjects <- function(query, level = NULL) {
  con <- .meta_con()
  q <- paste0("%", gsub("'", "''", query), "%")
  sql <- paste0(
    "SELECT ",
    "  subjectId, ",
    "  MAX(subject_name) AS subject_name, ",
    "  COUNT(*) AS n_variables, ",
    "  SUM(CASE WHEN n1 = 'og\u00f3\u0142em' AND (n2 IS NULL OR n2 = 'NA' OR n2 = 'og\u00f3\u0142em') ",
    "           AND (n3 IS NULL OR n3 = 'NA' OR n3 = 'og\u00f3\u0142em') THEN 1 ELSE 0 END) AS n_aggregate, ",
    "  STRING_AGG(DISTINCT n1, ' | ' ORDER BY n1) AS n1_breakdowns, ",
    "  MIN(variable_id) AS example_variable_id ",
    "FROM codebook ",
    "WHERE LOWER(subject_name) LIKE LOWER('", q, "')"
  )
  if (!is.null(level)) {
    sql <- paste0(sql, " AND unit_level = ", as.integer(level))
  }
  sql <- paste0(sql, " GROUP BY subjectId ORDER BY subject_name")
  DBI::dbGetQuery(con, sql)
}

#' Show dimension breakdowns for a subject
#'
#' For a subject identified via [search_subjects()], returns all available
#' dimension combinations with their variable IDs. Use this to decide which
#' specific breakdown to pass via `dims` or `aggregate` in [get_bdl()].
#'
#' @param subject_id Character scalar. A P* subject code (e.g. `"P1313"`).
#'
#' @return A `data.frame` with columns: `variable_id`, `n1`, `n2`, `n3`, `n4`,
#'   `n5`, `variable_dimensions`.
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#'
#' # First find the subject
#' search_subjects("bezrobocie")
#'
#' # Then inspect its breakdowns
#' get_subject_dims("P2917")
#'
#' # Then fetch data with a specific breakdown
#' get_bdl(subjects = "P2917", level = "powiat", years = 2020,
#'         dims = list(n1 = "ogółem"))
#' }
#' @export
get_subject_dims <- function(subject_id) {
  con <- .meta_con()
  sid <- gsub("'", "''", subject_id)
  DBI::dbGetQuery(
    con,
    paste0(
      "SELECT variable_id, n1, n2, n3, n4, n5, variable_dimensions ",
      "FROM codebook WHERE subjectId = '", sid, "' ",
      "ORDER BY variable_id"
    )
  )
}

#' Search variables by keyword
#'
#' Case-insensitive search across subject names and variable dimension labels.
#'
#' @param query Character scalar. Partial string to search for (Polish or English).
#' @param level Optional integer. Filter to variables available at a specific
#'   unit level (e.g. `6` for gmina, `5` for powiat). `NULL` returns all.
#'
#' @return A `data.frame` with columns: `variable_id`, `subjectId`,
#'   `subject_name`, `variable_dimensions`, `variable_full_name`,
#'   `measureUnitName`, `unit_level`.
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#' search_variables("ludność")
#' search_variables("bezrobocie", level = 5)
#' }
#' @export
search_variables <- function(query, level = NULL) {
  con <- .meta_con()
  q <- paste0("%", gsub("'", "''", query), "%")
  sql <- paste0(
    "SELECT variable_id, subjectId, subject_name, variable_dimensions, ",
    "variable_full_name, measureUnitName, unit_level ",
    "FROM codebook ",
    "WHERE (LOWER(subject_name) LIKE LOWER('", q, "') ",
    "OR LOWER(variable_dimensions) LIKE LOWER('", q, "') ",
    "OR LOWER(variable_full_name) LIKE LOWER('", q, "'))"
  )
  if (!is.null(level)) {
    sql <- paste0(sql, " AND unit_level = ", as.integer(level))
  }
  sql <- paste0(sql, " ORDER BY subjectId, variable_id")
  DBI::dbGetQuery(con, sql)
}

#' List top-level subject categories
#'
#' Returns the 33 main thematic categories (K-codes) from the BDL subject
#' hierarchy. To find specific P-level subjects within a category, use
#' [search_subjects()] with a keyword from the category name.
#'
#' @return A `data.frame` with columns: `id`, `name`.
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#' list_subjects()
#' }
#' @export
list_subjects <- function() {
  con <- .meta_con()
  # Top-level subjects have IDs matching K[0-9]+
  DBI::dbGetQuery(
    con,
    "SELECT id, name FROM subjects WHERE id LIKE 'K%' ORDER BY id"
  )
}

#' Get codebook entries for specific variables
#'
#' @param variable_ids Integer vector of variable IDs.
#'
#' @return A `data.frame` with full metadata for the requested variables.
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#' get_codebook(c(6, 7, 8))
#' }
#' @export
get_codebook <- function(variable_ids) {
  con <- .meta_con()
  vid_sql <- paste(as.integer(variable_ids), collapse = ", ")
  DBI::dbGetQuery(
    con,
    paste0("SELECT * FROM codebook WHERE variable_id IN (", vid_sql, ") ORDER BY variable_id")
  )
}

#' List subjects under a top-level category
#'
#' @param parent_id Character. A top-level subject ID (e.g. `"K3"`).
#'
#' @return A `data.frame` with columns: `id`, `name`, and all variables under
#'   that parent.
#'
#' @examples
#' \dontrun{
#' options(bdlR.path = "/Volumes/Samsung T72/Data/API GUS")
#' browse_subject("K3")
#' }
#' @export
browse_subject <- function(parent_id) {
  con <- .meta_con()
  pid <- gsub("'", "''", parent_id)
  DBI::dbGetQuery(
    con,
    paste0(
      "SELECT variable_id, subjectId, subject_name, variable_dimensions, ",
      "variable_full_name, measureUnitName, unit_level ",
      "FROM codebook WHERE subjectId LIKE '", pid, "%' OR subjectId = '", pid, "' ",
      "ORDER BY subjectId, variable_id"
    )
  )
}
