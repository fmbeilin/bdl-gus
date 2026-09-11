# Running the localities extraction on a machine without Dropbox

You do **not** need Dropbox, and you do **not** need Claude Code. Everything
transfers over pip-installable tooling. Only one machine runs at a time, so a
one-time transfer is enough — live sync was never actually required.

## 1. Install (no admin rights, no app installers)

```bash
pip install --user pyarrow huggingface_hub
```
If pip refuses ("externally managed environment"):
```bash
python3 -m venv ~/bdl-venv && ~/bdl-venv/bin/pip install pyarrow huggingface_hub
# then use ~/bdl-venv/bin/python3 and ~/bdl-venv/bin/hf below
```

## 2. Get the code

```bash
git clone https://github.com/fmbeilin/bdl-gus.git
cd bdl-gus
```

## 3. Get the data produced so far (84.6M observations, 164 variables)

```bash
mkdir -p lake_v2
hf download fmbeilin/gus-bdl --repo-type dataset \
    --include "facts_localities/*" --local-dir lake_v2_dl
mv lake_v2_dl/facts_localities lake_v2/facts_localities
```

## 4. Rebuild the checkpoint from that data

No checkpoint file needs to travel — it is derived from the parquet, so it can
never drift out of step with what you actually have:

```bash
export REBUILD_CHECKPOINT=1
```

## 5. Keys

The keys are not in git. Either copy `.bdl_keys` across by any means, or just:
```bash
export BDL_KEYS="key1,key2,key3"
```

## 6. Run

```bash
cd bdl-gus
BDL_ROOT="$PWD" REBUILD_CHECKPOINT=1 nohup ./run_localities.sh >/dev/null 2>&1 &
tail -f fetch_localities.log
```
(If zsh is unavailable: `bash run_localities.sh` — nothing in it is zsh-specific.)

The first log lines should report the checkpoint rebuild and then
`level-7 variables: 7,713 | done: 164 | todo: 7,549`.

## 7. ONE MACHINE AT A TIME

GUS TCP-blocked us after ~24h at ~2.85 req/s. The extractor self-limits to
2 req/s. Two machines behind the same public IP double that. The laptop is
currently stopped — leave it that way.

## 8. Publishing results

Whenever you like (it is safe to do partway):
```bash
hf upload fmbeilin/gus-bdl lake_v2/facts_localities facts_localities \
    --repo-type dataset --exclude "._*"
```
Part files are named `part-{host}-{epoch}-{n}.parquet`, so uploads from a
different machine cannot collide with what is already there.

## Health check

Good batches log `+N obs` with N in the millions. Repeated `+0 obs` means the
API is failing — the extractor aborts after 3 such batches rather than marking
variables done with no data. If it aborts, wait before retrying.
