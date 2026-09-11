#!/usr/bin/env bash
# One-shot status for the localities extraction. Prints and EXITS — never tails.
#   ./status.sh            (or: bash status.sh)
WORK="${BDL_ROOT:-${1:-$HOME/bdl-localities}}"
LABEL="com.fmbeilin.bdl-localities"
TOTAL=7713
cd "$WORK" 2>/dev/null || { echo "no working dir at $WORK"; exit 1; }

echo "=== extraction status ==="
done_n=$(wc -l < localities_done.txt 2>/dev/null | tr -d ' '); done_n=${done_n:-0}
pct=$(awk -v d="$done_n" -v t="$TOTAL" 'BEGIN{printf "%.1f", d/t*100}')
echo "  variables : $done_n / $TOTAL  (${pct}%)"
parts=$(ls lake_v2/facts_localities 2>/dev/null | grep -c 'part-.*\.parquet')
echo "  parquet   : ${parts:-0} parts, $(du -sh lake_v2/facts_localities 2>/dev/null | awk '{print $1}')"

echo
echo "=== is it actually running? ==="
if pgrep -f fetch_localities.py >/dev/null 2>&1; then
  echo "  extractor : RUNNING (pid $(pgrep -f fetch_localities.py | head -1))"
else
  echo "  extractor : idle (normal between batches, or between retries)"
fi
pgrep -f run_localities.sh >/dev/null 2>&1 && echo "  watcher   : alive" || echo "  watcher   : NOT alive"
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  st=$(launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk -F'= ' '/state = /{print $2; exit}')
  echo "  launchd   : installed (state: ${st:-unknown})"
else
  echo "  launchd   : NOT installed (job will not survive reboot)"
fi
# only one extractor should ever exist on a machine
n=$(pgrep -f fetch_localities.py 2>/dev/null | wc -l | tr -d ' ')
[ "${n:-0}" -gt 1 ] && echo "  !! WARNING: $n extractors running — kill all but one (doubles the request rate)"

echo
echo "=== last activity ==="
grep -E "batch |watcher:" fetch_localities.log 2>/dev/null | tail -4 | sed 's/^/  /'
zero=$(grep -c '+0 obs' fetch_localities.log 2>/dev/null || echo 0)
[ "${zero:-0}" -gt 0 ] && echo "  note: $zero zero-observation batches seen in this log (API trouble if recent)"

echo
echo "=== pace ==="
if [ "$done_n" -gt 164 ]; then
  first=$(stat -f %m lake_v2/facts_localities/$(ls -t lake_v2/facts_localities | tail -1) 2>/dev/null)
  now=$(date +%s); elapsed=$(( now - ${first:-$now} ))
  new=$(( done_n - 164 ))
  if [ "$elapsed" -gt 600 ] && [ "$new" -gt 0 ]; then
    rate=$(awk -v n="$new" -v e="$elapsed" 'BEGIN{printf "%.1f", n/(e/3600)}')
    left=$(awk -v r="$rate" -v rem="$(( TOTAL - done_n ))" 'BEGIN{if(r>0) printf "%.1f", rem/r/24; else print "?"}')
    echo "  ~$rate variables/hour  =>  ~$left days remaining"
  else
    echo "  too early to estimate (check again in ~30 min)"
  fi
else
  echo "  no new variables yet since the 164 downloaded from HF"
fi
echo
echo "(this command exits; it does not tail. re-run it any time.)"
