# Running the localities extraction on another machine

The job is long (~16–20 days at a polite 2 req/s) but small: **~17 MB of inputs,
~3.5 GB of output**. It does not need the Samsung T72 drive — move it to a
desktop that can stay powered and awake.

## 1. Copy these to the new machine (into one working directory)

| file | size | purpose |
|---|---|---|
| `fetch_localities.py` | 10 KB | the extractor |
| `run_localities.sh` | 2 KB | watcher/restart wrapper |
| `variables_catalog.csv` | 16 MB | the level-7 variable list |
| `localities_done.txt` | small | **checkpoint — carries progress over** |
| `.bdl_keys` | 111 B | API keys (one line, comma-separated) |
| `lake_v2/facts_localities/` | 64 MB so far | parquet produced to date |

Copy `localities_done.txt` **and** the existing parquet together — they must
agree, or the run will either redo work or skip variables that have no data.

## 2. Dependencies

- **Python 3** (standard library only for fetching)
- **`pip install pyarrow`** — used to convert each CSV shard to parquet.
  If pyarrow is missing it falls back to **R + the `duckdb` package**. Install
  one or the other; pyarrow is the lighter option.

Nothing else. No DuckDB CLI, no pandas.

## 3. Run

```bash
cd /path/to/workdir
BDL_ROOT=/path/to/workdir nohup ./run_localities.sh >/dev/null 2>&1 &
tail -f fetch_localities.log
```

`BDL_ROOT` defaults to the script's own directory, so running it from inside
the working directory is enough.

## 4. IMPORTANT: do not run two machines at once

GUS TCP-blocked this client after ~24h at ~2.85 req/s. The extractor now
self-limits to 2 req/s (`MAX_RPS`). Two machines behind the **same public IP**
double that and will get you blocked again — and a block cost a full day plus
a corrupted checkpoint last time.

- Same network/NAT as before → **stop the old machine first.**
- Genuinely different network/IP → you *could* split the variable list between
  them, but only deliberately, and each still capped at 2 req/s.

Stop the old run with:
```bash
pkill -f run_localities.sh ; pkill -f fetch_localities.py
```

## 4b. Running it out of Dropbox (current setup)

The working set now lives at:

```
~/Dropbox-Princeton/Felix Beilin/T72 Backup/bdl-localities/
```

so both machines see the same checkpoint and neither repeats work. It holds the
scripts, `variables_catalog.csv`, `localities_done.txt`, `.bdl_keys`,
`lake_v2/facts_localities/`, a `CLAUDE.md` with the operating notes, and a
`memory-snapshot/` copy of the project memory.

Two deliberate choices:

- **Temp CSV shards go to the system temp dir, not Dropbox** (`BDL_TMP`). Each
  batch writes then deletes hundreds of MB; syncing that for weeks would be
  pure churn.
- **Part files are named `part-{host}-{epoch}-{n}.parquet`.** The old
  count-based numbering would collide if Dropbox had not finished syncing when
  the second machine started.

**Let Dropbox finish syncing before starting the other machine**, or it resumes
from a stale checkpoint and redoes work.

## 5. Getting the data back

Output is `lake_v2/facts_localities/part-*.parquet` — independent files, safe to
copy at any time (the extractor only ever appends new parts).

- **rsync when done**: `rsync -av lake_v2/facts_localities/ /Volumes/Samsung\ T72/Data/API\ GUS/lake_v2/facts_localities/`
- **or publish directly from the desktop**:
  `hf upload fmbeilin/gus-bdl lake_v2/facts_localities facts_localities --repo-type dataset`

Part numbering is derived from the count of existing parts, so keep the parts
directory intact when moving; merging two separately-numbered sets would
collide. If you ever do need to merge, renumber one side first.

## 6. Checking progress

```bash
wc -l < localities_done.txt        # variables completed, of 7713
grep batch fetch_localities.log | tail -3
```
A healthy batch logs `+N obs` with N large. Repeated `+0 obs` means trouble —
the extractor now aborts after 3 such batches rather than marching through the
catalogue marking variables done with no data.
