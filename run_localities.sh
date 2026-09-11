#!/bin/zsh
# Keep the level-7 (statistical localities) extraction going until it completes.
# The extractor checkpoints per variable, so restarting is always safe.
# Usage:  ./run_localities.sh &          (monitor: tail -f fetch_localities.log)
# Stop:   pkill -f fetch_localities.py ; pkill -f run_localities.sh
cd "/Volumes/Samsung T72/Data/API GUS" || exit 1
export BDL_KEYS="$(cat .bdl_keys)"
TOTAL=7713
while true; do
  BATCH_VARS=${BATCH_VARS:-5} WORKERS=${WORKERS:-8} MAX_RPS=${MAX_RPS:-2.0} python3 fetch_localities.py >> fetch_localities.log 2>&1
  done_n=$(wc -l < localities_done.txt 2>/dev/null | tr -d ' ')
  echo "[$(date '+%F %T')] wrapper: ${done_n}/${TOTAL} variables done" >> fetch_localities.log
  [ "${done_n:-0}" -ge "$TOTAL" ] && { echo "ALL DONE" >> fetch_localities.log; break; }
  # If the API is unreachable (we have been TCP-blocked before), wait it out
  # rather than hammering: the extractor refuses to start when unreachable.
  if ! python3 -c "import socket;socket.create_connection(('bdl.stat.gov.pl',443),timeout=15).close()" 2>/dev/null; then
    echo "[$(date '+%F %T')] wrapper: API unreachable, sleeping 30min" >> fetch_localities.log
    sleep 1800
  else
    sleep 60
  fi
done
