#!/usr/bin/env python3
"""Fetch the full BDL subject hierarchy (K theme -> G groups -> P subjects) in
Polish and English. The local metadata lost this tree (P.parentId points at G
codes that were never stored), so browsing by family needs it re-fetched.
Keys from BDL_KEYS env (comma-separated). Writes subject_tree.csv."""
import csv, json, os, sys, time, threading
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://bdl.stat.gov.pl/api/v1"
KEYS = [k.strip() for k in os.environ.get("BDL_KEYS", "").split(",") if k.strip()]
if not KEYS: sys.exit("set BDL_KEYS")
_i = [0]; _lock = threading.Lock()
def key():
    with _lock:
        k = KEYS[_i[0] % len(KEYS)]; _i[0] += 1
    return k

def get(url, tries=6):
    for a in range(tries):
        try:
            with urlopen(Request(url, headers={"X-ClientId": key(),
                         "User-Agent": "bdl-gus-explorer/1.0"}), timeout=40) as r:
                return json.load(r)
        except HTTPError as e:
            if e.code in (429, 503): time.sleep(1.5 * (a + 1)); continue
            if e.code == 404: return None
            time.sleep(1 + a)
        except (URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(1 + a)
    return None

def children_of(node_id, lang):
    out, page = [], 0
    while True:
        d = get(f"{BASE}/subjects?parent-id={node_id}&lang={lang}&format=json&page-size=100&page={page}")
        if not d: break
        out.extend(d.get("results", []))
        if not (d.get("links") or {}).get("next"): break
        page += 1
    return out

def fetch_tree(lang):
    """Return {id: {name, parent, has_vars, children[]}} for the whole tree."""
    nodes = {}
    roots = []
    page = 0
    while True:
        d = get(f"{BASE}/subjects?lang={lang}&format=json&page-size=100&page={page}")
        if not d: break
        roots.extend(d.get("results", []))
        if not (d.get("links") or {}).get("next"): break
        page += 1
    for r in roots:
        nodes[r["id"]] = {"name": r["name"], "parent": None,
                          "has_vars": r.get("hasVariables", False), "kids": list(r.get("children") or [])}
    frontier = [r["id"] for r in roots if (r.get("children") or [])]
    depth = 0
    while frontier:
        depth += 1
        print(f"  [{lang}] depth {depth}: expanding {len(frontier)} nodes", flush=True)
        nxt = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            for pid, kids in zip(frontier, ex.map(lambda p: children_of(p, lang), frontier)):
                for c in kids:
                    nodes[c["id"]] = {"name": c["name"], "parent": pid,
                                      "has_vars": c.get("hasVariables", False),
                                      "kids": list(c.get("children") or [])}
                    if c.get("children"): nxt.append(c["id"])
        frontier = nxt
    return nodes

def main():
    pl = fetch_tree("pl"); print(f"PL nodes: {len(pl)}", flush=True)
    en = fetch_tree("en"); print(f"EN nodes: {len(en)}", flush=True)

    def path(nodes, nid):
        out = []
        cur = nid
        seen = set()
        while cur and cur in nodes and cur not in seen:
            seen.add(cur); out.append(cur); cur = nodes[cur]["parent"]
        return list(reversed(out))

    with open("subject_tree.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["subjectId", "name_pl", "name_en", "parentId", "depth",
                    "has_variables", "path_ids", "theme_id", "theme_pl", "theme_en",
                    "group_id", "group_pl", "group_en"])
        for nid, n in pl.items():
            p = path(pl, nid)
            theme = p[0] if p else ""
            group = p[1] if len(p) > 2 else ""      # only when subject sits below a group
            w.writerow([nid, n["name"], en.get(nid, {}).get("name", ""), n["parent"] or "",
                        len(p), int(n["has_vars"]), "/".join(p),
                        theme, pl.get(theme, {}).get("name", ""), en.get(theme, {}).get("name", ""),
                        group, pl.get(group, {}).get("name", ""), en.get(group, {}).get("name", "")])
    print("wrote subject_tree.csv", flush=True)

if __name__ == "__main__":
    main()
