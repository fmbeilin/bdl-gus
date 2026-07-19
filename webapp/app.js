// GUS BDL Explorer — DuckDB-WASM against hosted parquet, no backend.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";

// Local dev (http-server at repo root) uses the local lake; anywhere else, HF.
// ?data=remote forces the hosted dataset even on localhost (for testing).
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).get("data") !== "remote";
const DATA_BASE = LOCAL
  ? `${location.origin}/lake_v2`
  : "https://huggingface.co/datasets/fmbeilin/gus-bdl/resolve/main";

const LEVEL_TABLES = {
  gminy: "facts_gminy",
  powiaty: "facts_powiaty",
  podregiony: "facts_podregiony",
  wojewodztwa: "facts_wojewodztwa",
  makroregiony: "facts_makroregiony",
};
// manifest.json maps variable_id ranges to part files for split levels;
// fetching only the overlapping parts keeps remote queries to a few requests.
let manifest = null;
function filesFor(level, varIds) {
  const tbl = LEVEL_TABLES[level];
  const entries = manifest?.[tbl];
  if (!entries) return [`${DATA_BASE}/${tbl}.parquet`];
  const hit = entries.filter(e => varIds.some(v => v >= e.var_min && v <= e.var_max));
  return (hit.length ? hit : entries).map(e => `${DATA_BASE}/${e.file}`);
}
const LEVEL_CODES = { gminy: 6, powiaty: 5, podregiony: 4, wojewodztwa: 2, makroregiony: 1 };
const LEVEL_LABEL = { gminy: "Gminy", powiaty: "Powiaty", podregiony: "Podregiony", wojewodztwa: "Województwa", makroregiony: "Makroregiony" };
const LEVEL_SHORT = { 6: "gmina", 5: "powiat", 4: "podregion", 2: "woj.", 1: "makro" };
const LEVEL_NAME = { 6: "gmina", 5: "powiat", 4: "podregion", 2: "wojewodztwo", 1: "makroregion" };
const MAX_SERIES = 8;
const PREVIEW_LIMIT = 3000;
const SERIES_VARS = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--series-${i})`);

function selectedLevels() {
  return [...document.querySelectorAll("#level-checks input:checked")].map(c => c.value);
}

const $ = id => document.getElementById(id);
const statusEl = $("status");
function setStatus(cls, msg) { statusEl.className = `status status-${cls}`; statusEl.textContent = msg; }

// ---------- i18n ----------
// Polish plural: 1 → one; 2–4 (but not 12–14) → few; else → many.
function plForm(n, one, few, many) {
  const d = n % 10, h = n % 100;
  if (n === 1) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}
const I18N = {
  en: {
    tagline: "Polish Local Data Bank — 1.26 billion observations, queried live in your browser",
    find_data: "Find data",
    search_ph: "Search a topic in English or Polish, e.g. population, unemployment, ludność…",
    your_dataset: "Your dataset",
    clear_all: "Clear all",
    choose_scope: "Choose scope",
    geo_levels: "Geographic levels",
    tick_hint: "(tick one or more)",
    gl_municipalities: "municipalities", gl_counties: "counties", gl_subregions: "subregions", gl_voivodeships: "voivodeships",
    years: "Years", year_from: "from", year_to: "to",
    units: "Units", units_hint: "(empty = all units at the selected levels)",
    unit_search_ph: "Search units, e.g. Bochnia, Kraków…",
    build_dataset: "Build dataset",
    table_view: "Table view", chart_view: "Chart view",
    layout: "Layout", long: "Long", long_hint: "(one row per observation)",
    wide: "Wide", wide_hint: "(one column per indicator)",
    data_files: "Data files", one_file: "One file", one_file_hint: "(level in a column)", per_level: "Per level",
    incl_docs: "Include codebook & README", incl_docs_hint: "(as .zip)",
    download: "Download",
    about: "About",
    about_body: 'Every published variable of the GUS <a href="https://bdl.stat.gov.pl" rel="noopener">Bank Danych Lokalnych</a> at every level from gmina upward, extracted via the official API (1995–2024 where available). Queries run entirely in your browser with <a href="https://duckdb.org/docs/api/wasm/overview" rel="noopener">DuckDB-WASM</a> against hosted Parquet files — only the row groups your query needs are downloaded; there is no server.',
    bulk_data: "Bulk data:",
    attribution: "Data source: Główny Urząd Statystyczny (Statistics Poland), Bank Danych Lokalnych, bdl.stat.gov.pl. This is an independent interface, not affiliated with or endorsed by GUS.",
    // status
    st_starting: "Starting DuckDB…", st_loading: "Loading metadata…", st_ready: "Ready",
    st_building: "Building dataset…", st_preparing: "Preparing download…",
    st_fail_start: e => `Failed to start: ${e}`, st_fail_build: e => `Build failed: ${e}`, st_fail_dl: e => `Download failed: ${e}`,
    // run note / cart
    note_add_var: "Add at least one indicator to your dataset.",
    note_tick_level: "Tick at least one geographic level.",
    cart_count: n => `Your dataset: ${n} ${n === 1 ? "indicator" : "indicators"}`,
    // summary / estimate
    summary: (obs, nv, lvl, unitsDesc) =>
      `${fmt.format(obs)} observation${obs === 1 ? "" : "s"} · ${nv} ${nv === 1 ? "indicator" : "indicators"} · ${lvl} · ${unitsDesc}`,
    lvls_n: n => `${n} levels`,
    units_all: "all units", units_n: n => `${n} unit${n === 1 ? "" : "s"}`,
    est: (rows, size, note) => `≈ ${fmt.format(rows)} rows · ${size} <span class="${note[0]}">${note[1]}</span>`,
    feas_ok: "compiles instantly in your browser",
    feas_warn: "large — may take a few seconds to build",
    feas_heavy: "very large — the browser may struggle; narrow units, years, or levels",
    // facet
    facet_sub: "Tick one or more values in each breakdown — pick several to add a whole family at once. Total (ogółem) is preselected.",
    facet_single: "This topic has a single series.",
    facet_add: "Add to dataset", facet_cancel: "Cancel",
    facet_count: n => `Adds <strong>${fmt.format(n)}</strong> indicator${n === 1 ? "" : "s"}`,
    facet_toomany: n => ` — too many; narrow to ≤ ${n} per add`,
    facet_all: "All", facet_none: "None", facet_filter: n => `filter ${n}…`,
    breakdown: "Breakdown", breakdowns: n => `${fmt.format(n)} breakdowns`, single_series: "single series",
    // search
    no_match: "No topics match at this level. Try English or Polish keywords (diacritics optional).",
    level_hint: (q, lvl) => `No topic is named “${q}” at <strong>${lvl}</strong> — it may be collected only at another level (e.g. wages are powiat-and-up). The topics below just mention it inside a breakdown.`,
    the_levels: "the selected levels",
    tick_level_first: "Tick a geographic level first.",
    no_units: "No units match at the selected level(s).",
    // table
    th_variable: "Variable", th_unit: "Unit", th_unitid: "Unit ID", th_level: "Level", th_year: "Year", th_value: "Value",
    table_note: (shown, total) => `Showing first ${fmt.format(shown)} of ${fmt.format(total)} rows — download for the full dataset.`,
    // chart
    chart_top: (m, total) => `Showing the ${m} series with the highest average value out of ${fmt.format(total)}. The table and download contain everything.`,
    chart_mixed: units => `Selected indicators use different measure units (${units}); the chart shares one axis — compare with care or use the table.`,
    no_obs: "No observations matched.", all_empty: "All matched values are empty.",
    src_local: "local <code>lake_v2/</code> parquet (development mode)",
  },
  pl: {
    tagline: "Bank Danych Lokalnych GUS — 1,26 mld obserwacji, przeszukiwanych na żywo w przeglądarce",
    find_data: "Znajdź dane",
    search_ph: "Szukaj tematu po polsku lub angielsku, np. ludność, bezrobocie, population…",
    your_dataset: "Twój zbiór danych",
    clear_all: "Wyczyść",
    choose_scope: "Wybierz zakres",
    geo_levels: "Poziomy terytorialne",
    tick_hint: "(zaznacz jeden lub więcej)",
    gl_municipalities: "", gl_counties: "", gl_subregions: "", gl_voivodeships: "",
    years: "Lata", year_from: "od", year_to: "do",
    units: "Jednostki", units_hint: "(puste = wszystkie jednostki na wybranych poziomach)",
    unit_search_ph: "Szukaj jednostek, np. Bochnia, Kraków…",
    build_dataset: "Zbuduj zbiór",
    table_view: "Widok tabeli", chart_view: "Widok wykresu",
    layout: "Układ", long: "Długi", long_hint: "(jeden wiersz na obserwację)",
    wide: "Szeroki", wide_hint: "(jedna kolumna na wskaźnik)",
    data_files: "Pliki danych", one_file: "Jeden plik", one_file_hint: "(poziom w kolumnie)", per_level: "Wg poziomu",
    incl_docs: "Dołącz książkę kodową i README", incl_docs_hint: "(jako .zip)",
    download: "Pobierz",
    about: "O aplikacji",
    about_body: 'Wszystkie opublikowane zmienne GUS <a href="https://bdl.stat.gov.pl" rel="noopener">Banku Danych Lokalnych</a> na każdym poziomie od gminy wzwyż, pobrane przez oficjalne API (1995–2024, gdy dostępne). Zapytania wykonują się w całości w przeglądarce dzięki <a href="https://duckdb.org/docs/api/wasm/overview" rel="noopener">DuckDB-WASM</a> na hostowanych plikach Parquet — pobierane są tylko potrzebne fragmenty; nie ma serwera.',
    bulk_data: "Dane zbiorcze:",
    attribution: "Źródło danych: Główny Urząd Statystyczny, Bank Danych Lokalnych, bdl.stat.gov.pl. Niezależny interfejs, niepowiązany z GUS ani przez GUS nieautoryzowany.",
    st_starting: "Uruchamianie DuckDB…", st_loading: "Wczytywanie metadanych…", st_ready: "Gotowe",
    st_building: "Budowanie zbioru…", st_preparing: "Przygotowywanie pliku…",
    st_fail_start: e => `Błąd uruchomienia: ${e}`, st_fail_build: e => `Błąd budowania: ${e}`, st_fail_dl: e => `Błąd pobierania: ${e}`,
    note_add_var: "Dodaj co najmniej jeden wskaźnik do zbioru.",
    note_tick_level: "Zaznacz co najmniej jeden poziom terytorialny.",
    cart_count: n => `Twój zbiór: ${n} ${plForm(n, "wskaźnik", "wskaźniki", "wskaźników")}`,
    summary: (obs, nv, lvl, unitsDesc) =>
      `${fmt.format(obs)} ${plForm(obs, "obserwacja", "obserwacje", "obserwacji")} · ${nv} ${plForm(nv, "wskaźnik", "wskaźniki", "wskaźników")} · ${lvl} · ${unitsDesc}`,
    lvls_n: n => `${n} ${plForm(n, "poziom", "poziomy", "poziomów")}`,
    units_all: "wszystkie jednostki", units_n: n => `${n} ${plForm(n, "jednostka", "jednostki", "jednostek")}`,
    est: (rows, size, note) => `≈ ${fmt.format(rows)} ${plForm(rows, "wiersz", "wiersze", "wierszy")} · ${size} <span class="${note[0]}">${note[1]}</span>`,
    feas_ok: "kompiluje się natychmiast w przeglądarce",
    feas_warn: "duży — budowa potrwa kilka sekund",
    feas_heavy: "bardzo duży — przeglądarka może nie podołać; zawęź jednostki, lata lub poziomy",
    facet_sub: "Zaznacz co najmniej jedną wartość w każdym podziale — wybierz kilka, aby dodać całą rodzinę naraz. Ogółem jest domyślnie zaznaczone.",
    facet_single: "Ten temat ma jeden szereg.",
    facet_add: "Dodaj do zbioru", facet_cancel: "Anuluj",
    facet_count: n => `Dodaje <strong>${fmt.format(n)}</strong> ${plForm(n, "wskaźnik", "wskaźniki", "wskaźników")}`,
    facet_toomany: n => ` — za dużo; zawęź do ≤ ${n} na dodanie`,
    facet_all: "Wszystkie", facet_none: "Żadne", facet_filter: n => `filtruj ${n}…`,
    breakdown: "Podział", breakdowns: n => `${fmt.format(n)} ${plForm(n, "podział", "podziały", "podziałów")}`, single_series: "jeden szereg",
    no_match: "Brak tematów na tym poziomie. Spróbuj słów po polsku lub angielsku (znaki diakrytyczne opcjonalne).",
    level_hint: (q, lvl) => `Żaden temat nie nazywa się „${q}” na poziomie <strong>${lvl}</strong> — może być zbierany tylko na innym poziomie (np. wynagrodzenia są od powiatu wzwyż). Poniższe tematy jedynie wspominają to hasło w podziale.`,
    the_levels: "wybranych poziomach",
    tick_level_first: "Najpierw zaznacz poziom terytorialny.",
    no_units: "Brak jednostek na wybranych poziomach.",
    th_variable: "Wskaźnik", th_unit: "Jednostka", th_unitid: "Kod jednostki", th_level: "Poziom", th_year: "Rok", th_value: "Wartość",
    table_note: (shown, total) => `Pokazano pierwsze ${fmt.format(shown)} z ${fmt.format(total)} wierszy — pobierz pełny zbiór.`,
    chart_top: (m, total) => `Pokazano ${m} szeregów o najwyższej średniej wartości z ${fmt.format(total)}. Tabela i plik zawierają wszystko.`,
    chart_mixed: units => `Wybrane wskaźniki mają różne jednostki miary (${units}); wykres używa jednej osi — porównuj ostrożnie lub użyj tabeli.`,
    no_obs: "Brak pasujących obserwacji.", all_empty: "Wszystkie dopasowane wartości są puste.",
    src_local: "lokalny <code>lake_v2/</code> parquet (tryb deweloperski)",
  },
};
let LANG = localStorage.getItem("bdl_lang") ||
  ((navigator.language || "").toLowerCase().startsWith("pl") ? "pl" : "en");
function t(key, ...args) {
  const v = (I18N[LANG] || I18N.en)[key];
  return typeof v === "function" ? v(...args) : v;
}
// Pick the label to lead with, given a Polish/English pair, per active language.
function bi(pl, en) {
  const main = LANG === "pl" ? (pl || en) : (en || pl);
  const sub = LANG === "pl" ? (en && en !== pl ? en : null) : (pl && pl !== en ? pl : null);
  return { main: main || "", sub: sub || null };
}
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  // level checkbox glosses (English helper text; hidden in Polish where the term is already Polish)
  document.querySelectorAll("#level-checks .lvl-note").forEach(el => { el.textContent = t(el.dataset.gloss) || ""; });
  document.querySelectorAll("[data-lang-btn]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.langBtn === LANG)));
}

const state = {
  vars: new Map(),   // variable_id -> {id, name, measure}
  units: new Map(),  // unitId -> {id, name, level}
  snapshot: null,    // {levels, varKeys, where} captured at Build time
  view: "chart",
};

let conn, db;

// ---------- bootstrap ----------
async function init() {
  applyStaticI18n();
  try {
    setStatus("loading", t("st_starting"));
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await db.connect();

    setStatus("loading", t("st_loading"));
    // strip_accents leaves Polish ł/Ł untouched (it is not a combining diacritic),
    // so fold it manually — mirrored in normalize() below.
    // English subject names (from the BDL API, lang=en) enable English search.
    // Optional file — fall back to Polish-only if it isn't hosted yet.
    // English subject names + per-variable dimension labels (BDL API lang=en)
    // enable English search & display. Both files are optional — fall back to
    // Polish-only if either isn't hosted yet.
    let hasEn = true, hasVarEn = true;
    try { await conn.query(`CREATE TABLE subjects_en AS SELECT subjectId, name_en FROM read_parquet('${DATA_BASE}/subjects_en.parquet')`); }
    catch { hasEn = false; }
    try { await conn.query(`CREATE TABLE variables_en AS SELECT * FROM read_parquet('${DATA_BASE}/variables_en.parquet')`); }
    catch { hasVarEn = false; }
    const enName = hasEn ? "e.name_en" : "NULL";
    const enDims = hasVarEn ? "v.variable_dimensions_en" : "NULL";
    const enUnit = hasVarEn ? "v.measureUnitName_en" : "NULL";
    // English full name = English subject + English dims (falls back to subject only)
    const enFull = hasVarEn
      ? `nullif(concat_ws(': ', ${enName}, nullif(v.variable_dimensions_en,'')), '')`
      : enName;
    // English search text = subject_en + dims_en
    const enSearch = `lower(coalesce(${enName},'') || ' ' || coalesce(${enDims},''))`;
    await conn.query(`
      CREATE TABLE codebook AS
      SELECT c.variable_id, c.subjectId, c.subject_name, c.variable_dimensions,
             c.n1, c.n2, c.n3, c.n4, c.n5,
             ${hasVarEn ? "v.n1_en, v.n2_en, v.n3_en, v.n4_en, v.n5_en" : "NULL AS n1_en, NULL AS n2_en, NULL AS n3_en, NULL AS n4_en, NULL AS n5_en"},
             c.unit_level, c.measureUnitName, ${enUnit} AS measureUnitName_en, c.variable_full_name,
             ${enName} AS subject_name_en, ${enDims} AS variable_dimensions_en, ${enFull} AS variable_full_name_en,
             replace(strip_accents(lower(c.subject_name || ' ' || coalesce(c.variable_dimensions,''))), 'ł', 'l') AS search_key,
             replace(strip_accents(lower(c.subject_name)), 'ł', 'l') AS subj_norm,
             lower(coalesce(${enName},'')) AS subj_en_norm,
             ${enSearch} AS search_key_en
      FROM read_parquet('${DATA_BASE}/codebook.parquet') c
      ${hasEn ? "LEFT JOIN subjects_en e ON c.subjectId = e.subjectId" : ""}
      ${hasVarEn ? "LEFT JOIN variables_en v ON c.variable_id = v.id" : ""}`);
    await conn.query(`
      CREATE TABLE units AS
      SELECT unitId, unitName, unitLevel,
             replace(strip_accents(lower(unitName)), 'ł', 'l') AS search_key
      FROM read_parquet('${DATA_BASE}/units.parquet')`);

    try {
      manifest = await (await fetch(`${DATA_BASE}/manifest.json`, { cache: "no-cache" })).json();
    } catch { manifest = null; }       // older single-file layout still works

    window.__bdl = { conn, db, duckdb };   // console debugging hook
    renderQuickStarts();
    $("var-search").disabled = false;
    $("unit-search").disabled = false;
    updateDataSourceNote();
    setStatus("ready", t("st_ready"));
  } catch (err) {
    console.error(err);
    setStatus("error", t("st_fail_start", err.message));
  }
}

function updateDataSourceNote() {
  $("data-source-note").innerHTML = LOCAL ? t("src_local")
    : `<a href="https://huggingface.co/datasets/fmbeilin/gus-bdl" rel="noopener">huggingface.co/datasets/fmbeilin/gus-bdl</a>`;
}

// Switch UI language and re-render everything currently on screen.
function setLang(lang) {
  if (lang === LANG || !I18N[lang]) return;
  LANG = lang;
  localStorage.setItem("bdl_lang", lang);
  applyStaticI18n();
  updateDataSourceNote();
  renderQuickStarts();
  renderChips("var-chips", state.vars);
  renderUnitChips();
  updateRunState();
  $("toggle-view").textContent = $("table-wrap").hidden ? t("table_view") : t("chart_view");
  if (conn && statusEl.classList.contains("status-ready")) setStatus("ready", t("st_ready"));
  if (facetState) renderFacetPanel();
  else if ($("var-search").value.trim().length >= 2) searchSubjects($("var-search").value);
  if (!$("panel-results").hidden && state.preview) refreshResults();
}

// ---------- search helpers ----------
const normalize = s => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ł/g, "l");
const sqlQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const fmt = new Intl.NumberFormat("en-US");
const fmtVal = v => v == null ? "" : (Math.abs(v) >= 1e6 ? fmt.format(Math.round(v)) : fmt.format(+(+v).toPrecision(6)));

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- subject (concept) search ----------
const DIMS = ["n1", "n2", "n3", "n4", "n5"];
const MAX_VARS = 60;
const QUICK_STARTS = [
  { en: "Population", pl: "Ludność", q: "ludność" },
  { en: "Unemployment", pl: "Bezrobocie", q: "bezrobotni" },
  { en: "Wages", pl: "Wynagrodzenia", q: "wynagrodzenia" },
  { en: "Dwellings", pl: "Mieszkania", q: "mieszkania" },
  { en: "Businesses", pl: "Podmioty gospodarcze", q: "podmioty gospodarki" },
  { en: "Municipal revenue", pl: "Dochody gmin", q: "dochody" },
];

function renderQuickStarts() {
  const wrap = $("quick-starts");
  wrap.innerHTML = "";
  for (const qs of QUICK_STARTS) {
    const label = qs[LANG];
    const b = document.createElement("button");
    b.className = "quick-start"; b.type = "button"; b.textContent = label;
    b.onclick = () => { const i = $("var-search"); i.value = label; i.focus(); searchSubjects(qs.q); };
    wrap.appendChild(b);
  }
}

// Light English suffix stemmer: return the term plus a stem so common word
// forms match (unemployment→unemploy, dwellings→dwelling, activities→activ…).
function termVariants(t) {
  const v = new Set([t]);
  if (t.length > 5) {
    if (t.endsWith("ies")) v.add(t.slice(0, -3) + "y");
    for (const suf of ["ments", "ment", "tions", "tion", "sions", "sion", "ing", "ers", "ed", "es", "s"]) {
      if (t.endsWith(suf) && t.length - suf.length >= 4) { v.add(t.slice(0, -suf.length)); break; }
    }
  }
  return [...v];
}

async function searchSubjects(q) {
  const box = $("subj-results");
  $("facet-panel").hidden = true;
  if (q.trim().length < 2) { box.hidden = true; return; }
  const terms = normalize(q).split(/\s+/).filter(Boolean);
  // Each term matches if any of its variants (the word or a light stem) is a
  // substring — so English "unemployment" finds "unemployed", "dwellings"
  // finds "dwelling", etc.
  const likeAny = (cols, t) =>
    "(" + termVariants(t).flatMap(v => cols.map(c => `${c} LIKE ${sqlQuote("%" + v + "%")}`)).join(" OR ") + ")";
  // Broad filter: Polish name/breakdown OR English name/breakdown.
  const where = terms.map(t => likeAny(["search_key", "search_key_en"], t)).join(" AND ");
  // name_all: every term appears in the SUBJECT NAME (Polish or English).
  const nameAll = terms.map(t => likeAny(["norm", "en_norm"], t)).join(" AND ");
  // A subject is available at a facts level X iff its unit_level >= X. Across
  // several selected levels, it's relevant if available at any — i.e. the
  // coarsest (smallest code) selected level.
  const lvls = selectedLevels();
  const minCode = lvls.length ? Math.min(...lvls.map(l => LEVEL_CODES[l])) : 1;
  const prefix = sqlQuote(normalize(q) + "%");
  // One row per subject (concept). Rank: name matches above dimension-only
  // matches, then prefix hits, then simpler (shorter, fewer-qualifier) names.
  const res = await conn.query(`
    WITH s AS (
      SELECT subjectId,
             any_value(subject_name) AS name,
             any_value(subject_name_en) AS name_en,
             any_value(subj_norm)   AS norm,
             any_value(subj_en_norm) AS en_norm,
             count(*)               AS n_vars,
             any_value(measureUnitName) AS unit
      FROM codebook WHERE ${where} AND unit_level >= ${minCode}
      GROUP BY subjectId
    )
    SELECT subjectId, name, name_en, n_vars, unit,
      (CASE WHEN ${nameAll} THEN 0 ELSE 1 END) AS name_match,
      (CASE WHEN norm LIKE ${prefix} OR en_norm LIKE ${prefix} THEN 0 ELSE 1 END) AS is_prefix,
      (length(name) - length(replace(name, ',', ''))) AS commas,
      length(name) AS namelen
    FROM s ORDER BY name_match, is_prefix, commas, namelen, n_vars DESC LIMIT 40`);
  const rows = res.toArray().map(r => r.toJSON());
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="var-more">${t("no_match")}</div>`;
    box.hidden = false; return;
  }
  // If nothing matches by NAME at this level, the term only appears inside
  // breakdowns — usually because the topic isn't collected at this level.
  if (Number(rows[0].name_match) === 1) {
    const levelName = lvls.length === 1 ? LEVEL_LABEL[lvls[0]] : t("the_levels");
    const h = document.createElement("div");
    h.className = "var-more";
    h.innerHTML = t("level_hint", normalize(q), levelName);
    box.appendChild(h);
  }
  for (const r of rows) {
    const b = document.createElement("button");
    b.className = "var-row subj-row"; b.type = "button";
    const breakdowns = r.n_vars > 1 ? t("breakdowns", Number(r.n_vars)) : t("single_series");
    const label = bi(r.name, r.name_en);
    const subHtml = label.sub ? `<span class="subj-en">${esc(label.sub)}</span>` : "";
    b.innerHTML = `<span class="subj-main">${esc(label.main)}${subHtml}</span>
      <span class="subj-meta">${breakdowns}${r.unit && r.unit !== "-" ? " · " + r.unit : ""}</span>`;
    b.onclick = () => openSubject(r.subjectId, r.name);
    box.appendChild(b);
  }
  box.hidden = false;
}

// Try to name each breakdown axis from the subject title
// ("… wg płci i wieku" / "… by sex and age"). Returns null if it can't.
function parseDimLabels(name, count, lang) {
  if (!name) return null;
  const re = lang === "en" ? /\bby\s+(.+)$/i : /(?:wg|według)\s+(.+)$/i;
  const sep = lang === "en" ? /\s*,\s*|\s+and\s+/ : /\s*,\s*|\s+i\s+/;
  const m = name.match(re);
  if (m) {
    const parts = m[1].split(sep).map(s => s.trim()).filter(Boolean);
    if (parts.length === count) return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1));
  }
  return null;
}
function dimLabelsFromName(name, count) {
  return parseDimLabels(name, count, "pl") ||
    Array.from({ length: count }, (_, i) => count === 1 ? t("breakdown") : `${t("breakdown")} ${i + 1}`);
}

function sortVals(vals) {
  return vals.slice().sort((a, b) =>
    a === "ogółem" ? -1 : b === "ogółem" ? 1 : a.localeCompare(b, "pl"));
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let facetState = null;   // { rows, facets:[{dim,label,values}], name }

async function openSubject(subjectId, name) {
  $("subj-results").hidden = true;
  const res = await conn.query(`
    SELECT variable_id, n1, n2, n3, n4, n5, n1_en, n2_en, n3_en, n4_en, n5_en,
           variable_full_name, variable_full_name_en, measureUnitName,
           any_value(subject_name_en) OVER () AS subject_name_en
    FROM codebook WHERE subjectId = ${sqlQuote(subjectId)} ORDER BY variable_id`);
  const rows = res.toArray().map(r => r.toJSON());
  const nameEn = rows[0]?.subject_name_en || null;
  const activeDims = DIMS.filter(d => {
    const vals = new Set(rows.map(r => r[d]).filter(v => v != null && v !== "NA"));
    return vals.size > 1;
  });
  const plLabels = dimLabelsFromName(name, activeDims.length);
  const enLabels = parseDimLabels(nameEn, activeDims.length, "en");
  const facets = activeDims.map((d, i) => {
    // Polish value -> English value, from variables that carry both.
    const enMap = new Map();
    for (const r of rows) {
      if (r[d] != null && r[d] !== "NA" && r[`${d}_en`]) enMap.set(r[d], r[`${d}_en`]);
    }
    return {
      dim: d,
      label: plLabels[i],
      labelEn: enLabels ? enLabels[i] : null,
      values: sortVals([...new Set(rows.map(r => r[d]).filter(v => v != null && v !== "NA"))]),
      enMap,
    };
  });
  facetState = { rows, facets, name, nameEn };
  renderFacetPanel();
}

// Which values are checked for a dimension (multi-select).
function checkedVals(dim) {
  return new Set([...document.querySelectorAll(`#facet-list-${dim} input:checked`)].map(c => c.value));
}
// Resolved variables = cross-product of the checked values across dimensions.
function resolveVars() {
  const sel = facetState.facets.map(f => checkedVals(f.dim));
  return facetState.rows.filter(r =>
    facetState.facets.every((f, i) => sel[i].has(r[f.dim])));
}

function renderFacetPanel() {
  const panel = $("facet-panel");
  const { facets, name, nameEn } = facetState;
  const facetHtml = facets.map(f => {
    const withFilter = f.values.length > 8;
    const items = f.values.map(v => {
      const lab = bi(v, f.enMap.get(v));
      const subTxt = lab.sub ? ` <span class="val-en">${esc(lab.sub)}</span>` : "";
      const filterKey = esc((v + " " + (f.enMap.get(v) || "")).toLowerCase());
      return `<label data-val="${filterKey}"><input type="checkbox" value="${esc(v)}"${v === "ogółem" ? " checked" : ""}> ${esc(lab.main)}${subTxt}</label>`;
    }).join("");
    // if no ogółem, default-check the first value so a selection always resolves
    const hasTotal = f.values.includes("ogółem");
    const lbl = bi(f.label, f.labelEn);
    const labelSub = lbl.sub ? ` <span class="val-en">${esc(lbl.sub)}</span>` : "";
    return `<div class="facet"><span>${esc(lbl.main)}${labelSub} <span class="hint">${f.values.length}</span></span>
      <div class="facet-ms">
        <div class="facet-tools">
          ${withFilter ? `<input class="facet-filter" data-dim="${f.dim}" placeholder="${esc(t("facet_filter", f.values.length))}">` : ""}
          <a data-act="all" data-dim="${f.dim}">${t("facet_all")}</a>
          <a data-act="none" data-dim="${f.dim}">${t("facet_none")}</a>
        </div>
        <div class="facet-list" id="facet-list-${f.dim}" data-default-first="${hasTotal ? '' : '1'}">${items}</div>
      </div></div>`;
  }).join("");
  const title = bi(name, nameEn);
  panel.innerHTML = `
    <div class="facet-title">${esc(title.main)}${title.sub ? ` <span class="val-en">${esc(title.sub)}</span>` : ""}</div>
    <div class="facet-sub">${facets.length ? t("facet_sub") : t("facet_single")}</div>
    ${facets.length ? `<div class="facet-grid">${facetHtml}</div>` : ""}
    <div class="facet-foot">
      <button class="facet-add" id="facet-add">${t("facet_add")}</button>
      <button class="facet-cancel" id="facet-cancel">${t("facet_cancel")}</button>
      <span class="facet-count" id="facet-count"></span>
    </div>`;
  // default-check first value where there's no ogółem
  facets.forEach(f => {
    const list = $(`facet-list-${f.dim}`);
    if (list.dataset.defaultFirst) list.querySelector("input").checked = true;
    list.addEventListener("change", updateFacetCount);
  });
  panel.querySelectorAll(".facet-tools a").forEach(a => a.addEventListener("click", () => {
    const list = $(`facet-list-${a.dataset.dim}`);
    list.querySelectorAll("input").forEach(c => { c.checked = a.dataset.act === "all"; });
    updateFacetCount();
  }));
  panel.querySelectorAll(".facet-filter").forEach(inp => inp.addEventListener("input", () => {
    const q = normalize(inp.value);
    $(`facet-list-${inp.dataset.dim}`).querySelectorAll("label").forEach(l =>
      l.classList.toggle("hidden", q && !l.dataset.val.includes(q)));
  }));
  $("facet-add").addEventListener("click", addFacetSelection);
  $("facet-cancel").addEventListener("click", () => { panel.hidden = true; facetState = null; });
  panel.hidden = false;
  updateFacetCount();
}

function updateFacetCount() {
  const n = resolveVars().length;
  const el = $("facet-count");
  el.innerHTML = t("facet_count", n);
  $("facet-add").disabled = n === 0 || n > MAX_VARS;
  if (n > MAX_VARS) el.innerHTML += t("facet_toomany", MAX_VARS);
}

function addFacetSelection() {
  const resolved = resolveVars();
  if (!resolved.length || resolved.length > MAX_VARS) return;
  if (state.vars.size + resolved.length > MAX_VARS && !resolved.every(r => state.vars.has(Number(r.variable_id)))) {
    alert(t("facet_toomany", MAX_VARS)); return;
  }
  for (const r of resolved) {
    state.vars.set(Number(r.variable_id), {
      id: Number(r.variable_id),
      name: r.variable_full_name,
      nameEn: r.variable_full_name_en,
      measure: r.measureUnitName,
    });
  }
  renderChips("var-chips", state.vars);
  $("facet-panel").hidden = true;
  facetState = null;
  $("var-search").value = "";
  updateRunState();
}

// ---------- unit search ----------
async function searchUnits(q) {
  const box = $("unit-results");
  if (q.trim().length < 2) { box.hidden = true; return; }
  const terms = normalize(q).split(/\s+/).filter(Boolean);
  const where = terms.map(t => `search_key LIKE ${sqlQuote("%" + t + "%")}`).join(" AND ");
  const lvls = selectedLevels();
  if (!lvls.length) { box.innerHTML = `<div class="var-more">${t("tick_level_first")}</div>`; box.hidden = false; return; }
  const codes = lvls.map(l => LEVEL_CODES[l]);
  const multiLvl = codes.length > 1;
  const res = await conn.query(`
    SELECT unitId, unitName, unitLevel FROM units
    WHERE ${where} AND unitLevel IN (${codes.join(",")})
    ORDER BY unitLevel DESC, unitName LIMIT 100`);
  const rows = res.toArray().map(r => r.toJSON());
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="var-more">${t("no_units")}</div>`;
    box.hidden = false; return;
  }
  for (const r of rows) {
    const lvlTag = multiLvl ? ` · ${LEVEL_SHORT[r.unitLevel]}` : "";
    const b = document.createElement("button");
    b.className = "var-row"; b.type = "button";
    b.innerHTML = `<span>${r.unitName}</span><span class="meta">${r.unitId}${lvlTag}</span>`;
    b.onclick = () => {
      state.units.set(r.unitId, { id: r.unitId, name: r.unitName, level: Number(r.unitLevel) });
      renderUnitChips();
      box.hidden = true; $("unit-search").value = "";
    };
    box.appendChild(b);
  }
  box.hidden = false;
}

function renderUnitChips() {
  const wrap = $("unit-chips");
  wrap.innerHTML = "";
  const multiLvl = selectedLevels().length > 1;
  for (const [id, u] of state.units) {
    const c = document.createElement("span");
    c.className = "chip";
    const tag = multiLvl && u.level ? ` <span class="hint">${LEVEL_SHORT[u.level]}</span>` : "";
    c.innerHTML = `<span class="chip-label">${u.name}${tag}</span>`;
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", `Remove ${u.name}`);
    x.onclick = () => { state.units.delete(id); renderUnitChips(); };
    c.appendChild(x);
    wrap.appendChild(c);
  }
}

function varLabel(v) { return bi(v.name, v.nameEn).main || v.name; }

function renderChips(elId, map) {
  const wrap = $(elId);
  wrap.innerHTML = "";
  for (const [id, v] of map) {
    const label = varLabel(v);
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `<span class="chip-label" title="${esc(label)}">${esc(label)}</span>`;
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", `Remove ${esc(label)}`);
    x.onclick = () => { map.delete(id); renderChips(elId, map); updateRunState(); };
    c.appendChild(x);
    wrap.appendChild(c);
  }
}

function updateRunState() {
  // cart header
  const n = state.vars.size;
  $("cart-head").hidden = n === 0;
  $("cart-count").textContent = t("cart_count", n);
  // run button
  const hasLevel = selectedLevels().length > 0;
  const ok = n > 0 && hasLevel && conn;
  $("run-btn").disabled = !ok;
  $("run-note").textContent = !conn ? "" : n === 0 ? t("note_add_var")
    : !hasLevel ? t("note_tick_level") : "";
}

// ---------- query ----------
function buildWhere() {
  const parts = [`variable_id IN (${[...state.vars.keys()].join(",")})`];
  if (state.units.size) parts.push(`unitId IN (${[...state.units.keys()].map(sqlQuote).join(",")})`);
  const yf = parseInt($("year-from").value, 10), yt = parseInt($("year-to").value, 10);
  if (!Number.isNaN(yf)) parts.push(`year >= ${yf}`);
  if (!Number.isNaN(yt)) parts.push(`year <= ${yt}`);
  return parts.join(" AND ");
}

// One level's raw SELECT over its parquet part-files, honoring the snapshot's
// variable/unit/year filters. unitLevel is carried through from the data.
function levelSelect(level, snap) {
  const files = filesFor(level, snap.varKeys);
  const fileListSql = `[${files.map(sqlQuote).join(",")}]`;
  return `SELECT variable_id, unitId, unitName, unitLevel, year, value ` +
    `FROM read_parquet(${fileListSql}) WHERE ${snap.where}`;
}

async function runQuery() {
  const levels = selectedLevels();
  if (!state.vars.size || !levels.length) return;
  const snap = { levels, varKeys: [...state.vars.keys()], where: buildWhere() };
  state.snapshot = snap;
  setStatus("busy", t("st_building"));
  $("run-btn").disabled = true;
  const t0 = performance.now();
  try {
    const inner = levels.map(l => levelSelect(l, snap)).join("\nUNION ALL\n");
    const total = Number((await conn.query(`SELECT count(*) AS n FROM (${inner})`)).toArray()[0].toJSON().n);
    snap.total = total;
    const res = await conn.query(
      `SELECT * FROM (${inner}) ORDER BY variable_id, unitLevel DESC, unitId, year LIMIT ${PREVIEW_LIMIT}`);
    const rows = res.toArray().map(r => r.toJSON());
    // remember for re-rendering (e.g. on language switch) without re-querying
    state.preview = { rows, total, nUnits: state.units.size, nLevels: levels.length, level1: levels[0] };
    $("panel-results").hidden = false;
    refreshResults();
    setSeparateEnabled(levels.length > 1);
    setStatus("ready", t("st_ready"));
    $("panel-results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    setStatus("error", t("st_fail_build", err.message));
  } finally {
    updateRunState();
  }
}

// Re-render summary + chart + table + estimate from the stored preview (used on
// build and on language switch — no re-query needed).
function refreshResults() {
  const p = state.preview;
  if (!p) return;
  const lvlLabel = p.nLevels === 1 ? LEVEL_LABEL[p.level1] : t("lvls_n", p.nLevels);
  const unitsDesc = (p.nUnits || 0) === 0 ? t("units_all") : t("units_n", p.nUnits);
  $("result-summary").textContent = t("summary", p.total, state.snapshot.varKeys.length, lvlLabel, unitsDesc);
  renderChart(p.rows);
  renderTable(p.rows, p.total);
  showEstimate(p.total);
}

function setSeparateEnabled(on) {
  const opt = $("dl-opt-separate");
  const radio = opt.querySelector("input");
  radio.disabled = !on;
  opt.classList.toggle("disabled", !on);
  if (!on && radio.checked) document.querySelector('input[name="dl-format"][value="combined"]').checked = true;
}

// Estimate export size and flag feasibility. Everything is compiled locally in
// the browser (no server timeout like the GUS portal) — the real limit is
// browser memory when building a very large file.
const HEAVY_ROWS = 3_000_000, WARN_ROWS = 500_000;
function showEstimate(total) {
  const el = $("dl-estimate");
  const bytes = total * 95;                 // ~95 B per long-format row
  const size = bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB`
    : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  let cls = "feas-ok", note = t("feas_ok");
  if (total > HEAVY_ROWS) { cls = "feas-heavy"; note = t("feas_heavy"); }
  else if (total > WARN_ROWS) { cls = "feas-warn"; note = t("feas_warn"); }
  el.innerHTML = t("est", total, size, [cls, note]);
  $("dl-csv").disabled = total === 0;
}

// ---------- chart ----------
function seriesKey(r) { return `${r.variable_id}|${r.unitId}|${r.unitLevel}`; }
function seriesName(r) {
  const v = state.vars.get(Number(r.variable_id));
  const multiLvl = (state.snapshot?.levels.length || 1) > 1;
  const parts = [r.unitName];
  if (multiLvl) parts.push(LEVEL_SHORT[r.unitLevel]);
  if (state.vars.size > 1) parts.push(v ? varLabel(v) : r.variable_id);
  return parts.filter(Boolean).join(" — ");
}

function renderChart(rows) {
  const wrap = $("chart");
  wrap.innerHTML = "";
  $("legend").innerHTML = "";
  const note = $("chart-note");
  note.hidden = true;

  if (!rows.length) { wrap.innerHTML = `<p class="hint">${t("no_obs")}</p>`; return; }

  // Group into series
  const seriesMap = new Map();
  for (const r of rows) {
    const k = seriesKey(r);
    if (!seriesMap.has(k)) seriesMap.set(k, { name: seriesName(r), points: new Map() });
    if (r.value != null) seriesMap.get(k).points.set(Number(r.year), Number(r.value));
  }
  let series = [...seriesMap.values()].filter(s => s.points.size > 0);
  const totalSeries = series.length;

  if (totalSeries > MAX_SERIES) {
    series.sort((a, b) => {
      const am = [...a.points.values()].reduce((x, y) => x + y, 0) / a.points.size;
      const bm = [...b.points.values()].reduce((x, y) => x + y, 0) / b.points.size;
      return bm - am;
    });
    series = series.slice(0, MAX_SERIES);
    note.textContent = t("chart_top", MAX_SERIES, totalSeries);
    note.hidden = false;
  }
  if (!series.length) { wrap.innerHTML = `<p class="hint">${t("all_empty")}</p>`; return; }

  // Mixed measure units across variables → warn (one axis only)
  const measures = new Set([...state.vars.values()].map(v => v.measure || ""));
  if (state.vars.size > 1 && measures.size > 1) {
    note.textContent = (note.hidden ? "" : note.textContent + " ") + t("chart_mixed", [...measures].join(", "));
    note.hidden = false;
  }

  const years = [...new Set(rows.map(r => Number(r.year)))].sort((a, b) => a - b);
  const allVals = series.flatMap(s => [...s.points.values()]);
  const yMin = Math.min(0, ...allVals), yMax = Math.max(...allVals);

  const W = 960, H = 420, M = { t: 16, r: 170, b: 34, l: 64 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const x = yr => years.length === 1 ? M.l + iw / 2
    : M.l + (yr - years[0]) / (years[years.length - 1] - years[0]) * iw;
  const y = v => M.t + ih - (v - yMin) / ((yMax - yMin) || 1) * ih;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Time series chart of selected BDL variables");

  // gridlines + y ticks
  const yTicks = niceTicks(yMin, yMax, 5);
  for (const tv of yTicks) {
    const ln = document.createElementNS(svgNS, "line");
    ln.setAttribute("x1", M.l); ln.setAttribute("x2", W - M.r);
    ln.setAttribute("y1", y(tv)); ln.setAttribute("y2", y(tv));
    ln.setAttribute("class", tv === 0 ? "baseline-line" : "gridline");
    svg.appendChild(ln);
    const tx = document.createElementNS(svgNS, "text");
    tx.setAttribute("x", M.l - 8); tx.setAttribute("y", y(tv) + 4);
    tx.setAttribute("text-anchor", "end"); tx.setAttribute("class", "axis-label");
    tx.textContent = fmtVal(tv);
    svg.appendChild(tx);
  }
  // x ticks
  const xt = years.length <= 8 ? years : niceYearTicks(years);
  for (const yr of xt) {
    const tx = document.createElementNS(svgNS, "text");
    tx.setAttribute("x", x(yr)); tx.setAttribute("y", H - 10);
    tx.setAttribute("text-anchor", "middle"); tx.setAttribute("class", "axis-label");
    tx.textContent = yr;
    svg.appendChild(tx);
  }

  // series lines (2px), markers on sparse series
  series.forEach((s, i) => {
    const col = SERIES_VARS[i];
    const pts = years.filter(yr => s.points.has(yr)).map(yr => [x(yr), y(s.points.get(yr))]);
    // CSS var() colors must go through style.*, not presentation attributes
    if (pts.length > 1) {
      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("d", "M" + pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join("L"));
      p.style.fill = "none";
      p.style.stroke = col;
      p.style.strokeWidth = "2";
      p.style.strokeLinejoin = "round";
      svg.appendChild(p);
    }
    if (pts.length <= 2) {
      for (const [a, b] of pts) {
        const c = document.createElementNS(svgNS, "circle");
        c.setAttribute("cx", a); c.setAttribute("cy", b); c.setAttribute("r", 4);
        c.style.fill = col;
        svg.appendChild(c);
      }
    }
    // direct label at line end for ≤4 series
    if (series.length <= 4 && pts.length) {
      const [lx, ly] = pts[pts.length - 1];
      const t = document.createElementNS(svgNS, "text");
      t.setAttribute("x", lx + 7); t.setAttribute("y", ly + 4);
      t.setAttribute("class", "direct-label");
      t.style.fill = col;
      t.textContent = truncate(s.name, 24);
      svg.appendChild(t);
    }
  });

  // crosshair + tooltip
  const cross = document.createElementNS(svgNS, "line");
  cross.setAttribute("class", "crosshair");
  cross.setAttribute("y1", M.t); cross.setAttribute("y2", H - M.b);
  cross.setAttribute("visibility", "hidden");
  svg.appendChild(cross);

  const tip = document.createElement("div");
  tip.className = "chart-tip"; tip.hidden = true;
  wrap.appendChild(svg);
  wrap.appendChild(tip);

  svg.addEventListener("pointermove", ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    if (px < M.l || px > W - M.r) { cross.setAttribute("visibility", "hidden"); tip.hidden = true; return; }
    let best = years[0], bd = Infinity;
    for (const yr of years) { const d = Math.abs(x(yr) - px); if (d < bd) { bd = d; best = yr; } }
    cross.setAttribute("x1", x(best)); cross.setAttribute("x2", x(best));
    cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<div class="tip-year">${best}</div>` + series.map((s, i) => {
      const v = s.points.get(best);
      return v == null ? "" : `<div class="tip-row"><span class="swatch" style="background:${SERIES_VARS[i]}"></span>
        <span class="tip-name">${truncate(s.name, 30)}</span><span class="tip-val">${fmtVal(v)}</span></div>`;
    }).join("");
    tip.hidden = false;
    const tipX = (x(best) / W) * r.width;
    tip.style.left = `${Math.min(tipX + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${(ev.clientY - r.top) + 14}px`;
  });
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });

  // legend (always for ≥2 series)
  if (series.length >= 2) {
    $("legend").innerHTML = series.map((s, i) =>
      `<span class="legend-item"><span class="swatch" style="background:${SERIES_VARS[i]}"></span>${truncate(s.name, 46)}</span>`
    ).join("");
  }
}

function niceTicks(lo, hi, n) {
  const span = (hi - lo) || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = mult * step;
  const ticks = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + s * 1e-9; v += s) ticks.push(+v.toFixed(10));
  return ticks;
}
function niceYearTicks(years) {
  const lo = years[0], hi = years[years.length - 1];
  const step = Math.ceil((hi - lo) / 8);
  const out = [];
  for (let yr = lo; yr <= hi; yr += step) out.push(yr);
  if (out[out.length - 1] !== hi) out.push(hi);
  return out;
}
const truncate = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;

// ---------- table ----------
const TABLE_LIMIT = 1000;
function renderTable(rows, total) {
  const tbl = $("result-table");
  const shown = rows.slice(0, TABLE_LIMIT);
  const multiLvl = (state.snapshot?.levels.length || 1) > 1;
  const varName = id => { const v = state.vars.get(Number(id)); return v ? varLabel(v) : id; };
  const lvlHead = multiLvl ? `<th>${t("th_level")}</th>` : "";
  tbl.innerHTML =
    `<thead><tr><th>${t("th_variable")}</th><th>${t("th_unit")}</th><th>${t("th_unitid")}</th>${lvlHead}<th>${t("th_year")}</th><th>${t("th_value")}</th></tr></thead>` +
    `<tbody>` + shown.map(r =>
      `<tr><td>${esc(truncate(varName(r.variable_id), 70))}</td><td>${esc(r.unitName)}</td><td>${r.unitId}</td>` +
      `${multiLvl ? `<td>${LEVEL_NAME[r.unitLevel] || r.unitLevel}</td>` : ""}` +
      `<td class="num">${r.year}</td><td class="num">${fmtVal(r.value)}</td></tr>`).join("") + `</tbody>`;
  total = total ?? rows.length;
  $("table-note").textContent = total > shown.length ? t("table_note", shown.length, total) : "";
}

// ---------- dataset download ----------
// Generated in DuckDB via COPY (streams to the virtual FS) so large exports
// don't have to be built as one giant string in JS. unitId stays a string, so
// leading zeros survive for R/Python/pandas.
const LEVEL_CASE =
  "CASE d.unitLevel WHEN 6 THEN 'gmina' WHEN 5 THEN 'powiat' WHEN 4 THEN 'podregion' " +
  "WHEN 2 THEN 'wojewodztwo' WHEN 1 THEN 'makroregion' ELSE CAST(d.unitLevel AS VARCHAR) END";

// Long (tidy): one row per observation.
function wrapExportLong(innerSql) {
  return `WITH d AS (${innerSql}) ` +
    `SELECT d.variable_id, c.variable_full_name AS variable_name, d.unitId, d.unitName, ` +
    `d.unitLevel, ${LEVEL_CASE} AS level, d.year, d.value ` +
    `FROM d LEFT JOIN codebook c USING (variable_id) ` +
    `ORDER BY d.variable_id, d.unitLevel DESC, d.unitId, d.year`;
}
// Wide: one column per indicator; rows keyed by unit × year.
function wrapExportWide(innerSql) {
  return `PIVOT (WITH d AS (${innerSql}) ` +
    `SELECT d.unitId, d.unitName, d.unitLevel, ${LEVEL_CASE} AS level, d.year, ` +
    `c.variable_full_name AS indicator, d.value ` +
    `FROM d LEFT JOIN codebook c USING (variable_id)) ` +
    `ON indicator USING first(value) ` +
    `GROUP BY unitId, unitName, unitLevel, level, year ` +
    `ORDER BY unitLevel DESC, unitId, year`;
}
function wrapExport(innerSql, layout) {
  return layout === "wide" ? wrapExportWide(innerSql) : wrapExportLong(innerSql);
}

async function copyToBuffer(sql, fname) {
  await conn.query(`COPY (${sql}) TO '${fname}' (HEADER, DELIMITER ',')`);
  const buf = await db.copyFileToBuffer(fname);
  await db.dropFile(fname).catch(() => {});
  return buf;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Per-variable documentation (PL + EN names, subject, breakdown, unit, level).
function codebookSql(snap) {
  return `SELECT variable_id, ` +
    `variable_full_name AS variable_name, variable_full_name_en AS variable_name_en, ` +
    `subject_name AS subject_pl, subject_name_en AS subject_en, ` +
    `variable_dimensions AS breakdown_pl, variable_dimensions_en AS breakdown_en, ` +
    `measureUnitName AS measure_unit, measureUnitName_en AS measure_unit_en, ` +
    `CASE unit_level WHEN 6 THEN 'gmina' WHEN 5 THEN 'powiat' WHEN 4 THEN 'podregion' ` +
    `WHEN 3 THEN 'region' WHEN 2 THEN 'wojewodztwo' WHEN 1 THEN 'makroregion' WHEN 0 THEN 'Polska' ` +
    `ELSE CAST(unit_level AS VARCHAR) END AS lowest_level, subjectId ` +
    `FROM codebook WHERE variable_id IN (${snap.varKeys.join(",")}) ORDER BY variable_id`;
}

function buildReadme(snap, layout, stamp, dataFileList) {
  const lvlNames = snap.levels.map(l => LEVEL_LABEL[l]).join(", ");
  const unitDesc = state.units.size
    ? [...state.units.values()].map(u => u.name).join("; ")
    : "all units at the selected level(s)";
  const yf = parseInt($("year-from").value, 10), yt = parseInt($("year-to").value, 10);
  const yearDesc = Number.isNaN(yf) && Number.isNaN(yt) ? "all available years"
    : `${Number.isNaN(yf) ? "earliest" : yf}–${Number.isNaN(yt) ? "latest" : yt}`;
  const dataCols = layout === "wide"
    ? `  unitId        GUS territorial unit code (TERYT-style, 12 chars — keep as text; leading zeros matter)
  unitName      Territorial unit name
  unitLevel     6=gmina, 5=powiat, 4=podregion, 2=wojewodztwo, 1=makroregion
  level         Readable level name
  year          Year
  <indicator…>  One column per indicator; the header is the full indicator name (see codebook.csv)`
    : `  variable_id   GUS variable id (join key to codebook.csv)
  variable_name Full indicator name (Polish)
  unitId        GUS territorial unit code (TERYT-style, 12 chars — keep as text; leading zeros matter)
  unitName      Territorial unit name
  unitLevel     6=gmina, 5=powiat, 4=podregion, 2=wojewodztwo, 1=makroregion
  level         Readable level name
  year          Year
  value         Observed value`;
  return `GUS BDL — custom dataset
Generated ${stamp} with the GUS BDL Explorer
https://fmbeilin.github.io/bdl-gus/webapp/

CONTENTS
${dataFileList.map(f => `  ${f.padEnd(16)}data (${layout} format)`).join("\n")}
  codebook.csv    documentation — one row per indicator (PL + EN names, subject, breakdown, unit of measure, lowest available level)
  README.txt      this file

SCOPE
  Indicators:        ${snap.varKeys.length}
  Geographic levels: ${lvlNames}
  Units:             ${unitDesc}
  Years:             ${yearDesc}
  Rows (data):       ${fmt.format(snap.total ?? 0)}

DATA COLUMNS (${layout})
${dataCols}

SOURCE
  Statistics Poland (Główny Urząd Statystyczny), Bank Danych Lokalnych
  https://bdl.stat.gov.pl — data reusable with attribution to GUS, retrieved via the BDL API.
  Assembled with an independent tool, not affiliated with or endorsed by GUS.
`;
}

async function downloadDataset() {
  const snap = state.snapshot;
  if (!snap) return;
  const format = document.querySelector('input[name="dl-format"]:checked').value;
  const layout = document.querySelector('input[name="dl-layout"]:checked').value;
  const withDocs = $("dl-docs").checked;
  const stamp = new Date().toISOString().slice(0, 10);
  setStatus("busy", t("st_preparing"));
  $("dl-csv").disabled = true;
  try {
    // Build the data file(s): one combined, or one per non-empty level.
    const dataFiles = [];
    if (format === "separate" && snap.levels.length > 1) {
      for (const lvl of snap.levels) {
        const rowCount = Number((await conn.query(
          `SELECT count(*) AS n FROM (${levelSelect(lvl, snap)})`)).toArray()[0].toJSON().n);
        if (rowCount === 0) continue;   // skip a level with no data for this cart
        const buf = await copyToBuffer(wrapExport(levelSelect(lvl, snap), layout), `data_${lvl}.csv`);
        dataFiles.push({ name: `data_${lvl}.csv`, data: buf });
      }
    } else {
      const inner = snap.levels.map(l => levelSelect(l, snap)).join("\nUNION ALL\n");
      const buf = await copyToBuffer(wrapExport(inner, layout), "data.csv");
      dataFiles.push({ name: "data.csv", data: buf });
    }
    if (!dataFiles.length) { setStatus("ready", t("st_ready")); return; }

    if (withDocs) {
      const codebook = await copyToBuffer(codebookSql(snap), "codebook.csv");
      const readme = new TextEncoder().encode(buildReadme(snap, layout, stamp, dataFiles.map(f => f.name)));
      const zip = makeZip([...dataFiles, { name: "codebook.csv", data: codebook }, { name: "README.txt", data: readme }]);
      downloadBlob(zip, `bdl_dataset_${stamp}.zip`);
    } else if (dataFiles.length === 1) {
      downloadBlob(new Blob([dataFiles[0].data], { type: "text/csv;charset=utf-8" }), `bdl_dataset_${stamp}.csv`);
    } else {
      downloadBlob(makeZip(dataFiles), `bdl_dataset_${stamp}.zip`);
    }
    setStatus("ready", t("st_ready"));
  } catch (err) {
    console.error(err);
    setStatus("error", t("st_fail_dl", err.message));
  } finally {
    $("dl-csv").disabled = false;
  }
}

// Minimal store-only (uncompressed) ZIP writer — no dependencies.
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const u16 = n => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nb = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const local = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nb.length), ...u16(0)];
    parts.push(new Uint8Array(local), nb, f.data);
    central.push({ nb, crc, sz, offset });
    offset += local.length + nb.length + sz;
  }
  const cdStart = offset;
  for (const c of central) {
    const h = [0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.sz), ...u32(c.sz), ...u16(c.nb.length), ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u32(0), ...u32(c.offset)];
    parts.push(new Uint8Array(h), c.nb);
    offset += h.length + c.nb.length;
  }
  const eocd = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - cdStart), ...u32(cdStart), ...u16(0)];
  parts.push(new Uint8Array(eocd));
  return new Blob(parts, { type: "application/zip" });
}

// ---------- wire up ----------
$("var-search").addEventListener("input", debounce(e => searchSubjects(e.target.value), 200));
$("unit-search").addEventListener("input", debounce(e => searchUnits(e.target.value), 200));
$("level-checks").addEventListener("change", () => {
  // units are level-specific — drop any that no longer match a selected level
  const codes = new Set(selectedLevels().map(l => LEVEL_CODES[l]));
  for (const [id, u] of state.units) if (u.level && !codes.has(u.level)) state.units.delete(id);
  renderUnitChips();
  $("subj-results").hidden = true; $("unit-results").hidden = true;
  $("facet-panel").hidden = true; facetState = null;
  updateRunState();
  if ($("var-search").value.trim().length >= 2) searchSubjects($("var-search").value);
});
$("cart-clear").addEventListener("click", () => {
  state.vars.clear(); renderChips("var-chips", state.vars); updateRunState();
});
$("run-btn").addEventListener("click", runQuery);
$("dl-csv").addEventListener("click", downloadDataset);
$("toggle-view").addEventListener("click", () => {
  const toTable = $("table-wrap").hidden;
  $("table-wrap").hidden = !toTable;
  $("chart-wrap").hidden = toTable;
  $("toggle-view").setAttribute("aria-pressed", String(toTable));
  $("toggle-view").textContent = toTable ? t("chart_view") : t("table_view");
});
document.querySelectorAll("[data-lang-btn]").forEach(b =>
  b.addEventListener("click", () => setLang(b.dataset.langBtn)));
document.addEventListener("click", ev => {
  // keep the subject dropdown open while interacting with the facet panel
  if (!ev.target.closest("#panel-vars")) $("subj-results").hidden = true;
  if (!ev.target.closest("#panel-scope")) $("unit-results").hidden = true;
});

init();
