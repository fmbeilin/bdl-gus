// GUS BDL Explorer — DuckDB-WASM against hosted parquet, no backend.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

// Local dev (http-server at repo root) uses the local lake; anywhere else, HF.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
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
const MAX_SERIES = 8;
const SERIES_VARS = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--series-${i})`);

const $ = id => document.getElementById(id);
const statusEl = $("status");
function setStatus(cls, msg) { statusEl.className = `status status-${cls}`; statusEl.textContent = msg; }

const state = {
  vars: new Map(),   // variable_id -> {id, name, unitName (measure), level}
  units: new Map(),  // unitId -> {id, name}
  lastResult: null,  // {rows, columns, truncated, total}
  view: "chart",
};

let conn;

// ---------- bootstrap ----------
async function init() {
  try {
    setStatus("loading", "Starting DuckDB…");
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await db.connect();

    setStatus("loading", "Loading codebook…");
    // strip_accents leaves Polish ł/Ł untouched (it is not a combining diacritic),
    // so fold it manually — mirrored in normalize() below.
    await conn.query(`
      CREATE TABLE codebook AS
      SELECT variable_id, subjectId, subject_name, variable_dimensions,
             unit_level, measureUnitName, variable_full_name,
             replace(strip_accents(lower(subject_name || ' ' || coalesce(variable_dimensions,''))), 'ł', 'l') AS search_key
      FROM read_parquet('${DATA_BASE}/codebook.parquet')`);
    await conn.query(`
      CREATE TABLE units AS
      SELECT unitId, unitName, unitLevel,
             replace(strip_accents(lower(unitName)), 'ł', 'l') AS search_key
      FROM read_parquet('${DATA_BASE}/units.parquet')`);

    try {
      manifest = await (await fetch(`${DATA_BASE}/manifest.json`, { cache: "no-cache" })).json();
    } catch { manifest = null; }       // older single-file layout still works

    window.__bdl = { conn, duckdb };   // console debugging hook
    $("var-search").disabled = false;
    $("unit-search").disabled = false;
    $("data-source-note").innerHTML = LOCAL
      ? `local <code>lake_v2/</code> parquet (development mode)`
      : `<a href="https://huggingface.co/datasets/fmbeilin/gus-bdl" rel="noopener">huggingface.co/datasets/fmbeilin/gus-bdl</a>`;
    setStatus("ready", "Ready");
  } catch (err) {
    console.error(err);
    setStatus("error", `Failed to start: ${err.message}`);
  }
}

// ---------- search helpers ----------
const normalize = s => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ł/g, "l");
const sqlQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const fmt = new Intl.NumberFormat("en-US");
const fmtVal = v => v == null ? "" : (Math.abs(v) >= 1e6 ? fmt.format(Math.round(v)) : fmt.format(+(+v).toPrecision(6)));

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- variable search ----------
async function searchVariables(q) {
  const box = $("var-results");
  if (q.trim().length < 2) { box.hidden = true; return; }
  const terms = normalize(q).split(/\s+/).filter(Boolean);
  const where = terms.map(t => `search_key LIKE ${sqlQuote("%" + t + "%")}`).join(" AND ");
  const lvl = LEVEL_CODES[$("level-select").value];
  const res = await conn.query(`
    SELECT variable_id, subject_name, variable_dimensions, measureUnitName, unit_level
    FROM codebook WHERE ${where} AND unit_level >= ${lvl}
    ORDER BY subject_name, variable_id LIMIT 200`);
  const rows = res.toArray().map(r => r.toJSON());
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="var-more">No matches. Search uses Polish variable names (diacritics optional).</div>`;
    box.hidden = false; return;
  }
  let lastSubject = null;
  for (const r of rows) {
    if (r.subject_name !== lastSubject) {
      lastSubject = r.subject_name;
      const h = document.createElement("div");
      h.className = "var-group-head"; h.textContent = r.subject_name;
      box.appendChild(h);
    }
    const b = document.createElement("button");
    b.className = "var-row"; b.type = "button";
    b.innerHTML = `<span>${r.variable_dimensions || "ogółem"}</span>
       <span class="meta">#${r.variable_id} · ${r.measureUnitName || ""}</span>`;
    b.onclick = () => addVariable({
      id: Number(r.variable_id),
      name: `${r.subject_name}: ${r.variable_dimensions || "ogółem"}`,
      measure: r.measureUnitName,
    });
    box.appendChild(b);
  }
  if (rows.length === 200) {
    const m = document.createElement("div");
    m.className = "var-more"; m.textContent = "Showing first 200 matches — refine your search.";
    box.appendChild(m);
  }
  box.hidden = false;
}

function addVariable(v) {
  if (state.vars.size >= 12 && !state.vars.has(v.id)) {
    alert("Up to 12 variables per query. Remove one first."); return;
  }
  state.vars.set(v.id, v);
  renderChips("var-chips", state.vars);
  $("var-results").hidden = true;
  $("var-search").value = "";
  updateRunState();
}

// ---------- unit search ----------
async function searchUnits(q) {
  const box = $("unit-results");
  if (q.trim().length < 2) { box.hidden = true; return; }
  const terms = normalize(q).split(/\s+/).filter(Boolean);
  const where = terms.map(t => `search_key LIKE ${sqlQuote("%" + t + "%")}`).join(" AND ");
  const lvl = LEVEL_CODES[$("level-select").value];
  const res = await conn.query(`
    SELECT unitId, unitName FROM units
    WHERE ${where} AND unitLevel = ${lvl}
    ORDER BY unitName LIMIT 100`);
  const rows = res.toArray().map(r => r.toJSON());
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="var-more">No units match at this level.</div>`;
    box.hidden = false; return;
  }
  for (const r of rows) {
    const b = document.createElement("button");
    b.className = "var-row"; b.type = "button";
    b.innerHTML = `<span>${r.unitName}</span><span class="meta">${r.unitId}</span>`;
    b.onclick = () => {
      state.units.set(r.unitId, { id: r.unitId, name: r.unitName });
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
  for (const [id, u] of state.units) {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `<span class="chip-label">${u.name}</span>`;
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", `Remove ${u.name}`);
    x.onclick = () => { state.units.delete(id); renderUnitChips(); };
    c.appendChild(x);
    wrap.appendChild(c);
  }
}

function renderChips(elId, map) {
  const wrap = $(elId);
  wrap.innerHTML = "";
  for (const [id, v] of map) {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `<span class="chip-label" title="${v.name}">${v.name}</span>`;
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", `Remove ${v.name}`);
    x.onclick = () => { map.delete(id); renderChips(elId, map); updateRunState(); };
    c.appendChild(x);
    wrap.appendChild(c);
  }
}

function updateRunState() {
  const ok = state.vars.size > 0 && conn;
  $("run-btn").disabled = !ok;
  $("run-note").textContent = ok ? "" : "Pick at least one variable.";
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

async function runQuery() {
  const level = $("level-select").value;
  const files = filesFor(level, [...state.vars.keys()]);
  const fileListSql = `[${files.map(sqlQuote).join(",")}]`;
  const where = buildWhere();
  setStatus("busy", "Querying…");
  $("run-btn").disabled = true;
  const t0 = performance.now();
  try {
    const res = await conn.query(`
      SELECT variable_id, unitId, unitName, year, value
      FROM read_parquet(${fileListSql})
      WHERE ${where}
      ORDER BY variable_id, unitId, year`);
    const rows = res.toArray().map(r => r.toJSON());
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    state.lastResult = { rows, level };
    $("panel-results").hidden = false;
    $("result-summary").textContent =
      `${fmt.format(rows.length)} observations · ${state.vars.size} variable${state.vars.size > 1 ? "s" : ""} · ` +
      `${state.units.size || "all"} unit${state.units.size === 1 ? "" : "s"} · ${secs}s`;
    renderChart(rows);
    renderTable(rows);
    setStatus("ready", "Ready");
    $("panel-results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    setStatus("error", `Query failed: ${err.message}`);
  } finally {
    updateRunState();
  }
}

// ---------- chart ----------
function seriesKey(r) { return `${r.variable_id}|${r.unitId}`; }
function seriesName(r) {
  const v = state.vars.get(Number(r.variable_id));
  const varPart = state.vars.size > 1 ? `${v ? v.name : r.variable_id}` : null;
  return [r.unitName, varPart].filter(Boolean).join(" — ");
}

function renderChart(rows) {
  const wrap = $("chart");
  wrap.innerHTML = "";
  $("legend").innerHTML = "";
  const note = $("chart-note");
  note.hidden = true;

  if (!rows.length) { wrap.innerHTML = `<p class="hint">No observations matched.</p>`; return; }

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
    note.textContent = `Showing the ${MAX_SERIES} series with the highest average value out of ${fmt.format(totalSeries)}. The table and CSV contain everything.`;
    note.hidden = false;
  }
  if (!series.length) { wrap.innerHTML = `<p class="hint">All matched values are empty.</p>`; return; }

  // Mixed measure units across variables → warn (one axis only)
  const measures = new Set([...state.vars.values()].map(v => v.measure || ""));
  if (state.vars.size > 1 && measures.size > 1) {
    note.textContent = (note.hidden ? "" : note.textContent + " ") +
      `Selected variables use different measure units (${[...measures].join(", ")}); the chart shares one axis — compare with care or use the table.`;
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
function renderTable(rows) {
  const tbl = $("result-table");
  const shown = rows.slice(0, TABLE_LIMIT);
  const varName = id => { const v = state.vars.get(Number(id)); return v ? v.name : id; };
  tbl.innerHTML = `<thead><tr><th>Variable</th><th>Unit</th><th>Unit&nbsp;ID</th><th>Year</th><th>Value</th></tr></thead>` +
    `<tbody>` + shown.map(r =>
      `<tr><td>${truncate(varName(r.variable_id), 70)}</td><td>${r.unitName}</td><td>${r.unitId}</td>` +
      `<td class="num">${r.year}</td><td class="num">${fmtVal(r.value)}</td></tr>`).join("") + `</tbody>`;
  $("table-note").textContent = rows.length > TABLE_LIMIT
    ? `Showing first ${fmt.format(TABLE_LIMIT)} of ${fmt.format(rows.length)} rows — download the CSV for all of them.`
    : "";
}

// ---------- CSV download ----------
function downloadCsv() {
  const res = state.lastResult;
  if (!res) return;
  const varName = id => { const v = state.vars.get(Number(id)); return v ? v.name : id; };
  const esc = s => { s = String(s ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = "variable_id,variable_name,unitId,unitName,year,value";
  const body = res.rows.map(r =>
    [r.variable_id, esc(varName(r.variable_id)), `="${r.unitId}"`, esc(r.unitName), r.year, r.value ?? ""].join(","));
  const blob = new Blob(["﻿" + head + "\n" + body.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bdl_${res.level}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- wire up ----------
$("var-search").addEventListener("input", debounce(e => searchVariables(e.target.value), 200));
$("unit-search").addEventListener("input", debounce(e => searchUnits(e.target.value), 200));
$("level-select").addEventListener("change", () => {
  state.units.clear(); renderUnitChips();
  $("var-results").hidden = true; $("unit-results").hidden = true;
});
$("run-btn").addEventListener("click", runQuery);
$("dl-csv").addEventListener("click", downloadCsv);
$("toggle-view").addEventListener("click", () => {
  const toTable = $("table-wrap").hidden;
  $("table-wrap").hidden = !toTable;
  $("chart-wrap").hidden = toTable;
  $("toggle-view").setAttribute("aria-pressed", String(toTable));
  $("toggle-view").textContent = toTable ? "Chart view" : "Table view";
});
document.addEventListener("click", ev => {
  if (!ev.target.closest("#panel-vars")) $("var-results").hidden = true;
  if (!ev.target.closest("#panel-scope")) $("unit-results").hidden = true;
});

init();
