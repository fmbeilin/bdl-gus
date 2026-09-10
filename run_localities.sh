#!/bin/zsh
# Keep the level-7 (statistical localities) extraction going until it completes.
# The extractor checkpoints per variable, so restarting is always safe.
# Usage:  ./run_localities.sh &          (monitor: tail -f fetch_localities.log)
# Stop:   pkill -f fetch_localities.py ; pkill -f run_localities.sh
cd "/Volumes/Samsung T72/Data/API GUS" || exit 1
export BDL_KEYS="$(cat .bdl_keys)"
TOTAL=7713
while true; do
  BATCH_VARS=${BATCH_VARS:-10} WORKERS=${WORKERS:-12} python3 fetch_localities.py >> fetch_localities.log 2>&1
  done_n=$(wc -l < localities_done.txt 2>/dev/null | tr -d ' ')
  echo "[$(date '+%F %T')] wrapper: ${done_n}/${TOTAL} variables done" >> fetch_localities.log
  [ "${done_n:-0}" -ge "$TOTAL" ] && { echo "ALL DONE" >> fetch_localities.log; break; }
  sleep 30   # transient failure or clean stop -> resume from checkpoint
done
