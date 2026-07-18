#!/usr/bin/env python3
"""Fetch English BDL metadata: subject names + per-variable dimension labels.
Anonymous API, so be polite (modest concurrency, retry/backoff on 429).
Outputs subjects_en.csv (subjectId,name_en) and variables_en.csv
(id,subjectId,n1..n5,measureUnitName) — all in English."""
import csv, json, time, sys
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://bdl.stat.gov.pl/api/v1"
UA = {"User-Agent": "bdl-gus-explorer/1.0 (metadata; contact fmbeilin)"}

def get(url, tries=6):
    for i in range(tries):
        try:
            with urlopen(Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except HTTPError as e:
            if e.code in (429, 503):
                time.sleep(2 * (i + 1)); continue
            if e.code == 404:
                return None
            time.sleep(1 + i)
        except (URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(1 + i)
    return None

def fetch_subject(sid):
    d = get(f"{BASE}/subjects/{sid}?lang=en&format=json")
    return (sid, d.get("name") if d else None)

def fetch_var_page(page):
    d = get(f"{BASE}/variables?lang=en&format=json&page-size=100&page={page}")
    return d.get("results", []) if d else []

def main():
    ids = [l.strip() for l in open("/tmp/subject_ids.txt") if l.strip()]
    print(f"subjects: {len(ids)}", flush=True)
    with open("subjects_en.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["subjectId", "name_en"])
        done = 0
        with ThreadPoolExecutor(max_workers=6) as ex:
            for sid, name in ex.map(fetch_subject, ids):
                w.writerow([sid, name or ""]); done += 1
                if done % 200 == 0: print(f"  subjects {done}/{len(ids)}", flush=True)
    print("subjects done", flush=True)

    # variables: 172,525 -> ceil/100 pages
    total = get(f"{BASE}/variables?lang=en&format=json&page-size=1")["totalRecords"]
    pages = (total + 99) // 100
    print(f"variables: {total} in {pages} pages", flush=True)
    with open("variables_en.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["id", "subjectId", "n1", "n2", "n3", "n4", "n5", "measureUnitName"])
        done = 0
        with ThreadPoolExecutor(max_workers=6) as ex:
            for res in ex.map(fetch_var_page, range(pages)):
                for v in res:
                    w.writerow([v["id"], v.get("subjectId", ""), v.get("n1", ""), v.get("n2", ""),
                                v.get("n3", ""), v.get("n4", ""), v.get("n5", ""), v.get("measureUnitName", "")])
                done += 1
                if done % 100 == 0: print(f"  var pages {done}/{pages}", flush=True)
    print("variables done", flush=True)

if __name__ == "__main__":
    main()
