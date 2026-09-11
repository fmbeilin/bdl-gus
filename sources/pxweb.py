#!/usr/bin/env python3
"""PxWeb adapter — one implementation, several national statistical offices.

Estonia, Latvia and Slovenia (and the Nordics) all expose the same PxWeb v1
contract, so a single adapter plus per-country config covers them:

    GET  {base}/{lang}/{db}[/path]   -> navigation: [{id, type:'l'|'t', text}]
    GET  {base}/{lang}/{db}/{table}  -> metadata:   {title, variables:[...]}
    POST {base}/{lang}/{db}/{table}  -> data as JSON-stat2

Gotchas this handles, learned by probing:
  * even on the /en/ endpoint, variable CODES are in the native language
    (Estonia: 'Haldusüksus või asustusüksuse liik'); only 'text' is English,
    so never key off the code string — classify by role instead.
  * a table's geo dimension MIXES levels: country, type-aggregates, counties
    and municipalities all sit in one dimension, with depth signalled by a
    '..' prefix on the label. Level must be inferred, not assumed.
  * not every table is regional; tables without a geo dimension are skipped.
  * geo values use each office's own scheme, NOT LAU codes — mapping to the
    geography spine is a per-source crosswalk, never a string match.
"""
import json, urllib.request, urllib.error

SOURCES = {
    "EE": {"base": "https://andmed.stat.ee/api/v1", "lang": "en", "db": "stat",
           "office": "Statistics Estonia"},
    "LV": {"base": "https://data.stat.gov.lv/api/v1", "lang": "en", "db": "OSP_PUB",
           "office": "Central Statistical Bureau of Latvia"},
    "SI": {"base": "https://pxweb.stat.si/SiStatData/api/v1", "lang": "en", "db": "Data",
           "office": "Statistical Office of Slovenia"},
}
TIMEOUT = 60

def _url(cc, path=""):
    s = SOURCES[cc]
    return f"{s['base']}/{s['lang']}/{s['db']}" + (f"/{path}" if path else "")

def _get(url):
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
        return json.load(r)

def navigate(cc, path=""):
    """List child nodes: folders (type 'l') and tables (type 't')."""
    return _get(_url(cc, path))

def metadata(cc, table_path):
    """Normalized table metadata: title + dimensions with role classification."""
    m = _get(_url(cc, table_path))
    dims = []
    for v in m.get("variables", []):
        dims.append({
            "code": v["code"], "text": v.get("text", ""),
            "values": v.get("values", []), "labels": v.get("valueTexts", []),
            "is_time": bool(v.get("time")),
            "eliminable": bool(v.get("elimination")),
            "n": len(v.get("values", [])),
        })
    for d in dims:
        d["role"] = _role(d)
    return {"title": m.get("title", ""), "dims": dims}

# A geo dimension is the eliminable, non-time dimension with many values whose
# labels look territorial (hierarchy markers, or simply high cardinality).
def _role(d):
    if d["is_time"]:
        return "time"
    if d["eliminable"] and d["n"] >= 20:
        return "geo"
    return "measure"

def geo_levels(dim):
    """Infer depth per value from PxWeb's '..' label indentation convention."""
    out = {}
    for code, label in zip(dim["values"], dim["labels"]):
        depth = 0
        while label.startswith("." * (2 * (depth + 1))):
            depth += 1
        out[code] = depth
    return out

def fetch(cc, table_path, selections, chunk_geo=None):
    """POST a query, return long rows: (dim_key_tuple..., value).

    selections: {dim_code: [values] or '*'} — '*' selects all.
    """
    meta = metadata(cc, table_path)
    query = []
    for d in meta["dims"]:
        sel = selections.get(d["code"], "*")
        vals = d["values"] if sel == "*" else list(sel)
        query.append({"code": d["code"],
                      "selection": {"filter": "item", "values": vals}})
    body = json.dumps({"query": query, "response": {"format": "json-stat2"}}).encode()
    req = urllib.request.Request(_url(cc, table_path), data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        ds = json.load(r)
    return _to_long(ds)

def _to_long(ds):
    """JSON-stat2 -> long rows. Values are row-major over the dimension sizes."""
    dim_ids, sizes = ds["id"], ds["size"]
    # category.index may be a dict {code: pos} or a list of codes
    order = []
    for dim in dim_ids:
        cat = ds["dimension"][dim]["category"]
        idx = cat.get("index")
        if isinstance(idx, dict):
            order.append([c for c, _ in sorted(idx.items(), key=lambda kv: kv[1])])
        else:
            order.append(list(idx or []))
    labels = [ds["dimension"][d]["category"].get("label", {}) for d in dim_ids]
    rows = []
    for i, val in enumerate(ds["value"]):
        if val is None:
            continue
        pos, n = [], i
        for s in reversed(sizes):
            pos.append(n % s); n //= s
        pos.reverse()
        key = tuple(order[k][pos[k]] for k in range(len(dim_ids)))
        lab = tuple(labels[k].get(key[k], key[k]) for k in range(len(dim_ids)))
        rows.append({"dims": dict(zip(dim_ids, key)),
                     "labels": dict(zip(dim_ids, lab)), "value": val})
    return rows

if __name__ == "__main__":
    for cc, table in (("EE", "RV0291"),):
        m = metadata(cc, table)
        print(f"{cc} {table}: {m['title'][:60]}")
        for d in m["dims"]:
            print(f"   [{d['role']:<7}] {d['text'][:38]:<40} n={d['n']}")
        geo = next(d for d in m["dims"] if d["role"] == "geo")
        tim = next(d for d in m["dims"] if d["role"] == "time")
        oth = [d for d in m["dims"] if d["role"] == "measure"]
        depths = geo_levels(geo)
        muni = [c for c, dep in depths.items() if dep >= 1][:4]
        rows = fetch(cc, table, {geo["code"]: muni,
                                 tim["code"]: tim["values"][-2:],
                                 **{d["code"]: [d["values"][0]] for d in oth}})
        print(f"   fetched {len(rows)} observations; sample:")
        for r in rows[:4]:
            g = r["labels"][geo["code"]]; t = r["labels"][tim["code"]]
            print(f"     {g[:34]:<36} {t}  {r['value']}")
