#!/bin/zsh
# Watch for GUS to unblock us, then resume the level-7 (localities) extraction.
#
# We were TCP-blocked after ~24h of sustained scraping, so this deliberately
# waits rather than hammers: it only runs the extractor while the API accepts
# connections, and backs off exponentially whenever a run makes no progress
# (which is what a fresh block, or the extractor's circuit breaker, looks like).
#
# Start:  nohup ./run_localities.sh >/dev/null 2>&1 &
# Watch:  tail -f fetch_localities.log
# Stop:   pkill -f run_localities.sh ; pkill -f fetch_localities.py
cd "/Volumes/Samsung T72/Data/API GUS" || exit 1
export BDL_KEYS="$(cat .bdl_keys)"
TOTAL=7713
BACKOFF=300                 # grows to 6h while no progress is being made
log() { echo "[$(date '+%F %T')] watcher: $1" >> fetch_localities.log }
reachable() { python3 -c "import socket;socket.create_connection(('bdl.stat.gov.pl',443),timeout=15).close()" 2>/dev/null }

log "started; waiting for bdl.stat.gov.pl to accept connections"
while true; do
  done_n=$(wc -l < localities_done.txt 2>/dev/null | tr -d ' '); done_n=${done_n:-0}
  if [ "$done_n" -ge "$TOTAL" ]; then log "ALL DONE ($done_n/$TOTAL)"; break; fi

  if reachable; then
    before=$done_n
    log "API reachable — running extractor from $before/$TOTAL"
    BATCH_VARS=${BATCH_VARS:-5} WORKERS=${WORKERS:-8} MAX_RPS=${MAX_RPS:-2.0} \
      python3 fetch_localities.py >> fetch_localities.log 2>&1
    after=$(wc -l < localities_done.txt 2>/dev/null | tr -d ' '); after=${after:-0}
    if [ "$after" -gt "$before" ]; then
      log "progress: $before -> $after/$TOTAL"
      BACKOFF=300                                   # healthy; short pause
    else
      BACKOFF=$(( BACKOFF * 2 )); [ $BACKOFF -gt 21600 ] && BACKOFF=21600
      log "no progress (likely re-blocked); backing off ${BACKOFF}s"
    fi
    sleep $BACKOFF
  else
    log "still unreachable; retrying in 30min"
    sleep 1800
  fi
done
