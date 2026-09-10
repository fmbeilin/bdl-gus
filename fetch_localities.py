#!/usr/bin/env python3
"""Extract BDL statistical-locality (level 7) data.

Localities are NOT served by the normal /data endpoints — they need
/data/localities/by-variable/{var}?unit-parent-id={parent}. The parent may be
coarser than a gmina: macroregion works and returns every locality beneath it,
which cuts the sweep from ~19M requests (per-gmina) to ~3.4M (per-macroregion).

Each returned row carries a locality's FULL year series, and page-size caps at
100, so one request yields ~100 localities x ~18 years.

Rate limit is 50k requests per key per rolling 7 days; keys rotate and exhausted
keys drop out. Progress is checkpointed per (variable, macroregion) so the run
resumes exactly where it stopped — expect this to span several weeks on 3 keys.

CSV shards are converted to parquet and deleted as we go (the full raw CSV would
not fit on disk).
"""
import csv, json, os, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://bdl.stat.gov.pl/api/v1"
ROOT = "/Volumes/Samsung T72/Data/API GUS"
SHARD_DIR = os.path.join(ROOT, "localities_shards")
DONE_FILE = os.path.join(ROOT, "localities_done.txt")
MACROS = ["010000000000", "020000000000", "030000000000", "040000000000",
          "050000000000", "060000000000", "070000000000"]
BATCH_VARS = int(os.environ.get("BATCH_VARS", "40"))
WORKERS = int(os.environ.get("WORKERS", "10"))
MAX_BATCHES = int(os.environ.get("MAX_BATCHES", "0"))   # 0 = unlimited (testing aid)

KEYS = [k.strip() for k in os.environ.get("BDL_KEYS", "").split(",") if k.strip()]
if not KEYS:
    sys.exit("set BDL_KEYS (comma-separated)")
_state = {k: 10**9 for k in KEYS}      # key -> remaining quota (optimistic until seen)
_idx = [0]
_lock = threading.Lock()

def next_key():
    with _lock:
        live = [k for k in KEYS if _state[k] > 50]
        if not live:
            return None
        k = live[_idx[0] % len(live)]
        _idx[0] += 1
        return k

def get(url, tries=6):
    """GET with key rotation; returns parsed json or None. Tracks quota headers."""
    for attempt in range(tries):
        k = next_key()
        if k is None:
            return "EXHAUSTED"
        try:
            with urlopen(Request(url, headers={"X-ClientId": k,
                         "User-Agent": "bdl-gus-explorer/1.0"}), timeout=45) as r:
                rem = r.headers.get("X-Rate-Limit-Remaining")
                if rem is not None:
                    with _lock:
                        _state[k] = int(rem)
                return json.load(r)
        except HTTPError as e:
            if e.code == 429:
                with _lock:
                    _state[k] = 0          # this key is spent
                continue
            if e.code == 404:
                return None
            time.sleep(1 + attempt)
        except (URLError, TimeoutError, json.JSONDecodeError, ValueError):
            time.sleep(1 + attempt)
    return None

def fetch_pair(job):
    """All locality rows for one (variable, macroregion), paged."""
    var, macro = job
    out, page = [], 0
    while True:
        d = get(f"{BASE}/data/localities/by-variable/{var}"
                f"?unit-parent-id={macro}&format=json&page-size=100&page={page}")
        if d == "EXHAUSTED":
            return var, macro, None            # signal: out of quota
        if not d or "results" not in d:
            break
        for row in d["results"]:
            uid = str(row.get("id", ""))
            nm = row.get("name", "")
            for v in row.get("values", []):
                out.append((var, uid, nm, uid[:12], v.get("year"),
                            v.get("val"), v.get("attrId", "")))
        if not (d.get("links") or {}).get("next"):
            break
        page += 1
    return var, macro, out

def convert_shard(path, idx):
    """CSV shard -> parquet part, then drop the CSV (disk would not hold them)."""
    out = os.path.join(ROOT, "lake_v2", "facts_localities", f"part-{idx:05d}.parquet")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = f'''
library(duckdb); con <- dbConnect(duckdb())
dbExecute(con, "COPY (SELECT variable_id::INTEGER AS variable_id, unitId, unitName,
    parent_gmina, year::SMALLINT AS year, value::DOUBLE AS value, attr_id::TINYINT AS attr_id
  FROM read_csv('{path}', header=true,
    types={{'variable_id':'INTEGER','unitId':'VARCHAR','unitName':'VARCHAR',
            'parent_gmina':'VARCHAR','year':'INTEGER','value':'DOUBLE','attr_id':'INTEGER'}}))
  TO '{out}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000)")
dbDisconnect(con, shutdown=TRUE)
'''
    p = subprocess.run(["Rscript", "-e", r], capture_output=True, text=True)
    if p.returncode != 0:
        print("  ! convert failed:", p.stderr.strip()[:200], flush=True)
        return False
    os.remove(path)
    return True

def main():
    os.makedirs(SHARD_DIR, exist_ok=True)
    lvl7 = [r["id"] for r in csv.DictReader(open(os.path.join(ROOT, "variables_catalog.csv")))
            if r["level"] == "7"]
    done = set()
    if os.path.exists(DONE_FILE):
        done = {l.strip() for l in open(DONE_FILE) if l.strip()}
    todo = [v for v in lvl7 if v not in done]
    print(f"level-7 variables: {len(lvl7):,} | done: {len(done):,} | todo: {len(todo):,}", flush=True)

    shard_idx = len([f for f in os.listdir(os.path.join(ROOT, "lake_v2", "facts_localities"))
                     if f.startswith("part-")]) if os.path.isdir(
                     os.path.join(ROOT, "lake_v2", "facts_localities")) else 0
    donef = open(DONE_FILE, "a")

    for bi, start in enumerate(range(0, len(todo), BATCH_VARS)):
        if MAX_BATCHES and bi >= MAX_BATCHES:
            print('MAX_BATCHES reached (test mode)', flush=True); break
        batch = todo[start:start + BATCH_VARS]
        jobs = [(v, m) for v in batch for m in MACROS]
        rows, exhausted, failed = [], False, set()
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for var, macro, res in ex.map(fetch_pair, jobs):
                if res is None:
                    exhausted = True; failed.add(var)
                else:
                    rows.extend(res)
        if rows:
            path = os.path.join(SHARD_DIR, f"shard-{shard_idx:05d}.csv")
            with open(path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["variable_id", "unitId", "unitName", "parent_gmina",
                            "year", "value", "attr_id"])
                w.writerows(rows)
            if convert_shard(path, shard_idx):
                shard_idx += 1
        # only mark variables fully fetched (not the ones cut short by quota)
        for v in batch:
            if v not in failed:
                donef.write(v + "\n")
        donef.flush()
        left = min(_state.values()) if _state else 0
        print(f"  batch {start//BATCH_VARS + 1}: +{len(rows):,} obs | "
              f"vars done {len(done)+start+len(batch)-len(failed):,}/{len(lvl7):,} | "
              f"quota min-key {left:,}", flush=True)
        if exhausted:
            print("QUOTA EXHAUSTED — stopping cleanly; rerun later to resume.", flush=True)
            break
    donef.close()
    print("run finished", flush=True)

if __name__ == "__main__":
    main()
