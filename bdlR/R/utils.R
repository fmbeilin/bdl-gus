# Internal helpers

# Map user-facing level names to fact tables in bdl_gus_v2.duckdb.
# Tables are named by the GUS unit level they actually contain:
#   facts_gminy        -> unitLevel 6 (gminy)
#   facts_powiaty      -> unitLevel 5 (powiaty)
#   facts_podregiony   -> unitLevel 4 (podregiony / subregions)
#   facts_wojewodztwa  -> unitLevel 2 (województwa / voivodeships)
#   facts_makroregiony -> unitLevel 1 (makroregiony / macroregions)
# No level 0 (Polska) or level 3 (regiony) data was extracted.
.level_tables <- c(
  # Gmina
  gmina        = "facts_gminy",
  gminy        = "facts_gminy",
  # Powiat
  powiat       = "facts_powiaty",
  powiaty      = "facts_powiaty",
  # Subregion (level 4)
  subregion    = "facts_podregiony",
  podregion    = "facts_podregiony",
  subregiony   = "facts_podregiony",
  podregiony   = "facts_podregiony",
  # Voivodeship (level 2)
  voivod       = "facts_wojewodztwa",
  voivodeship  = "facts_wojewodztwa",
  woj          = "facts_wojewodztwa",
  wojewodztwo  = "facts_wojewodztwa",
  wojewodztwa  = "facts_wojewodztwa",
  # Macroregion (level 1)
  macroregion  = "facts_makroregiony",
  makroregion  = "facts_makroregiony",
  makroregiony = "facts_makroregiony"
)

#' @keywords internal
.resolve_level <- function(level) {
  level <- tolower(trimws(level))
  tbl <- .level_tables[level]
  if (is.na(tbl)) {
    stop(
      "Unknown level '", level, "'. ",
      "Use one of: gmina, powiat, subregion, voivod, macroregion.",
      call. = FALSE
    )
  }
  unname(tbl)
}

# Resolve subject codes to variable IDs.
# Accepts P* codes (direct lookup) or K* codes (name-based fallback via codebook).
# The database lacks the intermediate G* group layer that links K* -> P*,
# so K* codes are resolved by matching the K* category name against P* subject names.
#' @keywords internal
.subjects_to_var_ids <- function(subject_codes, con) {
  p_codes <- subject_codes[!grepl("^K", subject_codes, ignore.case = FALSE)]
  k_codes <- subject_codes[grepl("^K", subject_codes, ignore.case = FALSE)]

  var_ids <- integer(0)

  # P* codes: direct lookup
  if (length(p_codes) > 0) {
    codes_sql <- paste0("'", p_codes, "'", collapse = ", ")
    vars <- DBI::dbGetQuery(
      con,
      paste0("SELECT id FROM variables WHERE subjectId IN (", codes_sql, ")")
    )
    if (nrow(vars) == 0) {
      warning("No variables found for subject codes: ", paste(p_codes, collapse = ", "),
              call. = FALSE)
    } else {
      var_ids <- c(var_ids, vars$id)
    }
  }

  # K* codes: resolve via category name -> matching P* subject names in codebook
  if (length(k_codes) > 0) {
    k_sql <- paste0("'", k_codes, "'", collapse = ", ")
    k_names <- DBI::dbGetQuery(
      con,
      paste0("SELECT id, name FROM subjects WHERE id IN (", k_sql, ")")
    )
    if (nrow(k_names) == 0) {
      warning("K-level subjects not found: ", paste(k_codes, collapse = ", "), call. = FALSE)
    } else {
      # For each K* name, find P* subjects whose names contain any keyword from the K* name
      for (i in seq_len(nrow(k_names))) {
        # Match P* subjects via keyword in their parent_id or subject name in codebook
        # Use first significant word of the category name as the search term
        name_parts <- strsplit(k_names$name[i], "[[:space:]]+")[[1]]
        kw <- name_parts[nchar(name_parts) > 3][1]  # first word with >3 chars
        if (is.na(kw)) kw <- k_names$name[i]
        kw_sql <- paste0("%", gsub("'", "''", kw), "%")
        matching <- DBI::dbGetQuery(
          con,
          paste0(
            "SELECT DISTINCT subjectId FROM codebook ",
            "WHERE LOWER(subject_name) LIKE LOWER('", kw_sql, "')"
          )
        )
        if (nrow(matching) == 0) {
          warning("No subjects matched for K-level code '", k_names$id[i],
                  "' (", k_names$name[i], "). ",
                  "K* resolution uses approximate keyword matching. ",
                  "Use search_subjects() for precise subject lookup.",
                  call. = FALSE)
        } else {
          sub_sql <- paste0("'", matching$subjectId, "'", collapse = ", ")
          vars <- DBI::dbGetQuery(
            con,
            paste0("SELECT id FROM variables WHERE subjectId IN (", sub_sql, ")")
          )
          var_ids <- c(var_ids, vars$id)
        }
      }
    }
  }

  unique(as.integer(var_ids))
}

# Filter variable IDs by dimension values.
# dims: named list, e.g. list(n1="ogółem", n2=c("kobiety", NA)).
# NA in a value vector means "accept NULL or 'NA' in that column".
# base_var_ids: integer vector to restrict to, or NULL for all variables.
# Returns integer vector of matching variable_ids.
#' @keywords internal
.dims_to_var_ids <- function(dims, base_var_ids = NULL, con) {
  clauses <- character(0)
  for (nm in names(dims)) {
    vals <- dims[[nm]]
    null_ok <- any(is.na(vals))
    vals_clean <- vals[!is.na(vals)]
    vals_clean <- gsub("'", "''", vals_clean)

    if (length(vals_clean) > 0) {
      vq <- paste0("'", vals_clean, "'", collapse = ", ")
      clause <- paste0(nm, " IN (", vq, ")")
      if (null_ok) {
        clause <- paste0("(", clause, " OR ", nm, " IS NULL OR ", nm, " = 'NA')")
      }
    } else {
      clause <- paste0("(", nm, " IS NULL OR ", nm, " = 'NA')")
    }
    clauses <- c(clauses, clause)
  }

  base_clause <- ""
  if (!is.null(base_var_ids) && length(base_var_ids) > 0) {
    base_clause <- paste0("variable_id IN (", paste(base_var_ids, collapse = ", "), ") AND ")
  }

  sql <- paste0(
    "SELECT variable_id FROM codebook WHERE ",
    base_clause,
    paste(clauses, collapse = " AND ")
  )
  as.integer(DBI::dbGetQuery(con, sql)$variable_id)
}

# Normalise user-supplied unit IDs to the stored 12-char zero-padded form.
# Accepts already-padded strings, or numeric-looking IDs that lost leading zeros.
#' @keywords internal
.normalize_unit_id <- function(x) {
  x <- trimws(as.character(x))
  numeric_like <- grepl("^[0-9]+$", x)
  pad <- pmax(0L, 12L - nchar(x[numeric_like]))
  x[numeric_like] <- paste0(strrep("0", pad), x[numeric_like])
  x
}
