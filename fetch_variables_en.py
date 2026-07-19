#!/usr/bin/env python3
"""Fetch ALL English per-variable dimension labels from the BDL API, using
rotating API keys (X-ClientId) for reliable throughput. Keys come from the
BDL_KEYS env var (comma-separated) so they are never committed.
Writes variables_en.csv (id,subjectId,n1..n5,measureUnitName), complete."""
import csv, json, os, sys, time, threading
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://bdl.stat.gov.pl/api/v1"
KEYS = [k.strip() for k in os.environ.get("BDL_KEYS", "").split(",") if k.strip()]
if not KEYS:
    sys.exit("set BDL_KEYS env var (comma-separated API keys)")
_ctr = itertools_counter = [0]
_lock = threading.Lock()

def next_key():
    with _lock:
        k = KEYS[_ctr[0] % len(KEYS)]
        _ctr[0] += 1
    return k

def get(url, tries=8):
    for i in range(tries):
        try:
            req = Request(url, headers={"X-ClientId": next_key(),
                                        "User-Agent": "bdl-gus-explorer/1.0"})
            with urlopen(req, timeout=40) as r:
                return json.load(r)
        except HTTPError as e:
            if e.code in (429, 503):
                time.sleep(1.5 * (i + 1)); continue
            if e.code == 404:
                return None
            time.sleep(1 + i)
        except (URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(1 + i)
    return None  # exhausted

def fetch_page(page):
    d = get(f"{BASE}/variables?lang=en&format=json&page-size=100&page={page}")
    return page, (d.get("results", []) if d else None)

def main():
    total = get(f"{BASE}/variables?lang=en&format=json&page-size=1")["totalRecords"]
    pages = (total + 99) // 100
    print(f"{total} variables in {pages} pages; keys={len(KEYS)}", flush=True)
    results = {}
    failed = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        for page, res in ex.map(fetch_page, range(pages)):
            if res is None:
                failed.append(page)
            else:
                results[page] = res
            if (page + 1) % 200 == 0:
                print(f"  {page + 1}/{pages}  (failed so far: {len(failed)})", flush=True)
    # retry failures once more, sequentially and gently
    for page in list(failed):
        _, res = fetch_page(page)
        if res is not None:
            results[page] = res; failed.remove(page)
    got = sum(len(v) for v in results.values())
    print(f"fetched {got} rows across {len(results)} pages; still-failed pages: {len(failed)}", flush=True)
    with open("variables_en.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["id", "subjectId", "n1", "n2", "n3", "n4", "n5", "measureUnitName"])
        for page in sorted(results):
            for v in results[page]:
                w.writerow([v["id"], v.get("subjectId", ""), v.get("n1", ""), v.get("n2", ""),
                            v.get("n3", ""), v.get("n4", ""), v.get("n5", ""), v.get("measureUnitName", "")])
    print("wrote variables_en.csv", flush=True)

if __name__ == "__main__":
    main()
