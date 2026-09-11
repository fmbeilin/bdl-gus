#!/usr/bin/env python3
"""Extract BDL statistical-locality (level 7) data.

Localities are NOT served by the normal /data endpoints — they need
/data/localities/by-variable/{var}?unit-parent-id={parent}. The parent may be
coarser than a gmina: macroregion works and returns every locality beneath it,
which cuts the sweep from ~19M requests (per-gmina) to ~3.4M (per-macroregion).

Each returned row carries a locality's FULL year series, and page-size caps at
100, so one request yields ~100 localities x ~18 years.

MEASURED: the 50k/key/7d rate limit applies to METADATA endpoints only — /data/*
requests do not decrement it. The binding constraint is throughput, and the
server throttles above ~10 concurrent workers (50 workers is slower AND starts
failing), so ~10-14 workers at ~15-20 req/s is the sweet spot => roughly 2-4 days
of continuous running for the full sweep. Keys still rotate; progress is
checkpointed per variable so the run resumes exactly where it stopped.

CSV shards are converted to parquet and deleted as we go (the full raw CSV would
not fit on disk).
"""
import csv, json, os, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://bdl.stat.gov.pl/api/v1"
# Portable: set BDL_ROOT to run this anywhere (e.g. a UPS-backed desktop that
# can stay up for weeks). Only ~17MB of inputs are needed and the full output
# is ~3.5GB, so the job does not need the original drive.
ROOT = os.environ.get("BDL_ROOT") or os.path.dirname(os.path.abspath(__file__))
# Scratch CSVs are written then deleted every batch. Keep them OUT of any synced
# folder (Dropbox would upload and remove hundreds of MB per batch for weeks).
SHARD_DIR = os.environ.get("BDL_TMP") or os.path.join(
    os.environ.get("TMPDIR", "/tmp"), "bdl_localities_shards")
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

# Sustained scraping got this client TCP-blocked by GUS once (connections to
# stat.gov.pl silently dropped while the rest of the internet was fine), so the
# fetcher now self-limits rather than going as fast as the server allows.
MAX_RPS = float(os.environ.get("MAX_RPS", "2.0"))
_rl_lock = threading.Lock()
_next_slot = [0.0]
def throttle():
    with _rl_lock:
        now = time.time()
        slot = max(now, _next_slot[0])
        _next_slot[0] = slot + 1.0 / MAX_RPS
    wait = slot - time.time()
    if wait > 0:
        time.sleep(wait)

def reachable():
    """Preflight: is the API answering at all? Avoids burning the catalogue."""
    import socket
    try:
        socket.create_connection(("bdl.stat.gov.pl", 443), timeout=15).close()
        return True
    except OSError:
        return False

def next_key():
    with _lock:
        live = [k for k in KEYS if _state[k] > 50]
        if not live:
            return None
        k = live[_idx[0] % len(live)]
        _idx[0] += 1
        return k

def get(url, tries=6):
    """GET with key rotation. Returns dict on success, None for a real 404,
    or "FAIL" when the request could not be completed — the caller MUST NOT
    treat "FAIL" as 'this variable has no data'."""
    for attempt in range(tries):
        throttle()
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
            time.sleep(2 ** attempt)          # back off properly, don't hammer
    return "FAIL"

def fetch_pair(job):
    """All locality rows for one (variable, macroregion), paged.
    Returns (var, macro, rows, ok). ok=False means the fetch FAILED and the
    variable must not be checkpointed as done."""
    var, macro = job
    out, page = [], 0
    while True:
        d = get(f"{BASE}/data/localities/by-variable/{var}"
                f"?unit-parent-id={macro}&format=json&page-size=100&page={page}")
        if d == "EXHAUSTED" or d == "FAIL":
            return var, macro, out, False      # out of quota / unreachable
        if d is None:
            break                              # genuine 404 -> nothing here
        if "results" not in d:
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
    return var, macro, out, True

def _convert_with_pyarrow(path, out):
    """Preferred on a ported machine: needs only `pip install pyarrow`."""
    import pyarrow as pa, pyarrow.csv as pacsv, pyarrow.parquet as pq
    schema = pa.schema([("variable_id", pa.int32()), ("unitId", pa.string()),
                        ("unitName", pa.string()), ("parent_gmina", pa.string()),
                        ("year", pa.int16()), ("value", pa.float64()),
                        ("attr_id", pa.int8())])
    tbl = pacsv.read_csv(path, convert_options=pacsv.ConvertOptions(column_types=schema))
    pq.write_table(tbl, out, compression="zstd")

def convert_shard(path, idx):
    """CSV shard -> parquet part, then drop the CSV (disk would not hold them).
    Uses pyarrow when available, else falls back to R+duckdb."""
    import socket
    host = socket.gethostname().split(".")[0][:12].replace("_", "-")
    out = os.path.join(ROOT, "lake_v2", "facts_localities",
                       f"part-{host}-{int(time.time())}-{idx:05d}.parquet")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        _convert_with_pyarrow(path, out)
        os.remove(path)
        return True
    except ImportError:
        pass          # no pyarrow -> use the R path below
    except Exception as e:
        print(f"  ! pyarrow convert failed ({e}); trying R", flush=True)
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

    shard_idx = 0   # filenames carry host+timestamp, so this is just a counter
    if not reachable():
        sys.exit("bdl.stat.gov.pl:443 is not reachable — refusing to start "
                 "(a failed run would otherwise mark variables as done). "
                 "We were TCP-blocked once after sustained scraping; wait it out.")
    donef = open(DONE_FILE, "a")
    consecutive_bad = 0

    for bi, start in enumerate(range(0, len(todo), BATCH_VARS)):
        if MAX_BATCHES and bi >= MAX_BATCHES:
            print('MAX_BATCHES reached (test mode)', flush=True); break
        batch = todo[start:start + BATCH_VARS]
        jobs = [(v, m) for v in batch for m in MACROS]
        rows, exhausted, failed = [], False, set()
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for var, macro, res, ok in ex.map(fetch_pair, jobs):
                rows.extend(res)
                if not ok:
                    exhausted = True; failed.add(var)   # never checkpoint these
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
        if failed:
            consecutive_bad += 1
        else:
            consecutive_bad = 0
        # Circuit breaker: if the API stops answering, STOP. Previously a dead
        # API looked like "no data" and 579 variables were checkpointed empty.
        if consecutive_bad >= 3:
            print(f"ABORTING: {consecutive_bad} consecutive batches had failed fetches "
                  f"({len(failed)} vars in the last one). The API is unreachable or "
                  f"throttling us — nothing was checkpointed for them. "
                  f"Wait, verify reachability, then rerun to resume.", flush=True)
            break
        if exhausted:
            print(f"  (batch had {len(failed)} failed variables — left for a later run)", flush=True)
    donef.close()
    print("run finished", flush=True)

if __name__ == "__main__":
    main()
