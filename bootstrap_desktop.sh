#!/usr/bin/env bash
# One-shot setup for the localities extraction on a machine with no git,
# no Dropbox and no admin rights.
#
#   curl -fsSL https://raw.githubusercontent.com/fmbeilin/bdl-gus/main/bootstrap_desktop.sh \
#     | bash -s -- "KEY1,KEY2,KEY3"
#
# Needs: python3 with pyarrow + huggingface_hub (pip install --user pyarrow huggingface_hub)
# Avoids: git (uses the GitHub tarball) and the `hf` CLI (uses the Python API,
#         so a ~/.local/bin that is not on PATH does not matter).
set -euo pipefail

KEYS="${1:-${BDL_KEYS:-}}"
[ -n "$KEYS" ] || { echo "usage: bootstrap_desktop.sh \"KEY1,KEY2,KEY3\""; exit 1; }
PYBIN="${PYBIN:-python3}"
WORK="${WORK:-$HOME/bdl-localities}"

echo "==> python: $($PYBIN -V 2>&1)"
$PYBIN - <<'PY' || { echo "!! missing deps: pip install --user pyarrow huggingface_hub"; exit 1; }
import pyarrow, huggingface_hub
print(f"    pyarrow {pyarrow.__version__}, huggingface_hub {huggingface_hub.__version__}")
PY

echo "==> fetching code (tarball, no git needed)"
mkdir -p "$WORK" && cd "$WORK"
curl -fsSL "https://github.com/fmbeilin/bdl-gus/archive/refs/heads/main.tar.gz" -o repo.tgz
tar xzf repo.tgz --strip-components=1 \
    bdl-gus-main/fetch_localities.py bdl-gus-main/run_localities.sh \
    bdl-gus-main/variables_catalog.csv bdl-gus-main/SETUP_DESKTOP.md
rm -f repo.tgz
chmod +x run_localities.sh

echo "==> downloading data produced so far (from Hugging Face)"
$PYBIN - <<'PY'
import os
from huggingface_hub import snapshot_download
dest = os.path.join(os.getcwd(), "lake_v2")
os.makedirs(dest, exist_ok=True)
p = snapshot_download(repo_id="fmbeilin/gus-bdl", repo_type="dataset",
                      allow_patterns="facts_localities/*", local_dir=dest)
n = len([f for f in os.listdir(os.path.join(dest, "facts_localities"))
         if f.startswith("part-") and f.endswith(".parquet")])
print(f"    {n} parquet parts in {dest}/facts_localities")
PY

printf '%s\n' "$KEYS" > .bdl_keys && chmod 600 .bdl_keys

echo "==> starting extractor (checkpoint is rebuilt from the parquet)"
cd "$WORK"
BDL_ROOT="$WORK" REBUILD_CHECKPOINT=1 BDL_KEYS="$KEYS" \
  nohup ./run_localities.sh >/dev/null 2>&1 &
sleep 20
echo
echo "==> log so far:"
tail -5 fetch_localities.log 2>/dev/null || echo "    (no log yet — check again in a minute)"
echo
echo "Working dir : $WORK"
echo "Watch       : tail -f $WORK/fetch_localities.log"
echo "Progress    : wc -l < $WORK/localities_done.txt   # of 7713"
echo "Stop        : pkill -f run_localities.sh ; pkill -f fetch_localities.py"
