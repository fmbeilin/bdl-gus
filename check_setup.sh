#!/usr/bin/env bash
# Verify the localities download is set up to run unattended, and optionally fix it.
#
#   check only :  curl -fsSL .../check_setup.sh | bash
#   check + fix:  curl -fsSL .../check_setup.sh | bash -s -- --fix "KEY1,KEY2,KEY3"
#
# Checks: launchd agent installed, caffeinate actually holding a sleep
# assertion, exactly one extractor, disk space, and that progress is moving.
FIX=0; KEYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIX=1; shift; KEYS="${1:-}"; shift 2>/dev/null || true ;;
    *) shift ;;
  esac
done
WORK="${BDL_ROOT:-$HOME/bdl-localities}"
LABEL="com.fmbeilin.bdl-localities"
TOTAL=7713
problems=0
ok()   { echo "  [ OK ] $1"; }
bad()  { echo "  [FAIL] $1"; problems=$((problems+1)); }
note() { echo "         $1"; }

echo "=== 1. working directory ==="
if [ -d "$WORK" ] && [ -x "$WORK/run_localities.sh" ]; then ok "$WORK"
else bad "no working dir at $WORK — run bootstrap_desktop.sh first"; echo; echo "Fix:"; echo "  curl -fsSL https://raw.githubusercontent.com/fmbeilin/bdl-gus/main/bootstrap_desktop.sh | bash -s -- \"YOUR,KEYS\""; exit 1; fi

echo "=== 2. launchd agent (survives reboot / restarts on crash) ==="
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  ok "agent '$LABEL' is loaded"
else
  bad "agent NOT loaded — the job will not survive a reboot"
fi

echo "=== 3. caffeinate (machine will not sleep) ==="
if pmset -g assertions 2>/dev/null | grep -qi "caffeinate"; then
  ok "caffeinate is holding a sleep assertion"
  pmset -g assertions 2>/dev/null | grep -i "PreventUserIdleSystemSleep named" | head -1 | sed 's/^ */         /'
else
  bad "nothing is preventing sleep — the machine can idle-sleep overnight"
fi

echo "=== 4. extractor processes (must be exactly one, or zero between batches) ==="
n=$(pgrep -f fetch_localities.py 2>/dev/null | wc -l | tr -d ' ')
if [ "${n:-0}" -gt 1 ]; then bad "$n extractors running — doubles the request rate, risks another block"
elif [ "${n:-0}" -eq 1 ]; then ok "one extractor running"
else ok "none right now (normal between batches)"; fi
pgrep -f run_localities.sh >/dev/null 2>&1 && ok "watcher alive" || note "watcher not alive right now (launchd will restart it)"

echo "=== 5. disk space (needs ~3.5 GB total) ==="
avail=$(df -g "$WORK" 2>/dev/null | tail -1 | awk '{print $4}')
if [ "${avail:-0}" -ge 5 ]; then ok "${avail} GB free"; else bad "only ${avail:-?} GB free"; fi

echo "=== 6. progress ==="
done_n=$(wc -l < "$WORK/localities_done.txt" 2>/dev/null | tr -d ' '); done_n=${done_n:-0}
echo "         $done_n / $TOTAL variables ($(awk -v d=$done_n -v t=$TOTAL 'BEGIN{printf "%.1f", d/t*100}')%)"
log="$WORK/fetch_localities.log"
if [ -f "$log" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$log") ))
  if [ "$age" -lt 3600 ]; then ok "log updated $((age/60)) min ago"
  else bad "log has not changed in $((age/3600))h — it may be stuck or blocked"; fi
  grep -E "batch " "$log" | tail -2 | sed 's/^/         /'
else
  note "no log yet"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "ALL GOOD — nothing to do. Re-run this any time."
  exit 0
fi
echo "$problems problem(s) found."
if [ "$FIX" = "1" ] && [ -n "$KEYS" ]; then
  echo "==> repairing: reinstalling the launchd agent (this also restores caffeinate)"
  curl -fsSL "https://raw.githubusercontent.com/fmbeilin/bdl-gus/main/install_keepalive.sh" -o "$WORK/install_keepalive.sh"
  chmod +x "$WORK/install_keepalive.sh"
  "$WORK/install_keepalive.sh" "$KEYS" "$WORK"
  echo "==> repaired. Re-run this checker to confirm."
else
  echo
  echo "To fix, run (one line):"
  echo "  curl -fsSL https://raw.githubusercontent.com/fmbeilin/bdl-gus/main/check_setup.sh | bash -s -- --fix \"YOUR,KEYS\""
fi
