#!/usr/bin/env bash
# Keep the localities extraction running indefinitely on a macOS desktop:
#   * caffeinate  -> the machine never idle-sleeps while the job runs
#   * launchd     -> the job starts at login and restarts if it ever dies
#
#   ./install_keepalive.sh "KEY1,KEY2,KEY3" [workdir]
#
# User-level LaunchAgent: no sudo, no admin rights.
set -euo pipefail

KEYS="${1:-${BDL_KEYS:-}}"
WORK="${2:-$HOME/bdl-localities}"
[ -n "$KEYS" ] || { echo "usage: ./install_keepalive.sh \"KEY1,KEY2,KEY3\" [workdir]"; exit 1; }
[ -x "$WORK/run_localities.sh" ] || { echo "!! $WORK/run_localities.sh not found — run bootstrap_desktop.sh first"; exit 1; }

LABEL="com.fmbeilin.bdl-localities"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <!-- caffeinate -i (no idle sleep) -m (no disk sleep) -s (no system sleep on AC).
       Deliberately NOT -d: the display may still sleep, which is fine. -->
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-ims</string>
    <string>$WORK/run_localities.sh</string>
  </array>

  <key>WorkingDirectory</key><string>$WORK</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BDL_ROOT</key><string>$WORK</string>
    <key>BDL_KEYS</key><string>$KEYS</string>
    <key>REBUILD_CHECKPOINT</key><string>1</string>
    <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <!-- restart if it dies, but NOT after a clean finish (the sweep completing) -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>300</integer>

  <key>StandardOutPath</key><string>$WORK/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$WORK/launchd.err.log</string>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST" >/dev/null && echo "==> plist valid: $PLIST"

# reload cleanly if it was already installed
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

echo "==> installed and started"
echo
echo "Status    : launchctl print gui/$UID/$LABEL | head -20"
echo "Progress  : wc -l < $WORK/localities_done.txt      # of 7713"
echo "Watch     : tail -f $WORK/fetch_localities.log"
echo "Stop now  : launchctl bootout gui/$UID/$LABEL"
echo "Uninstall : launchctl bootout gui/$UID/$LABEL; rm $PLIST"
echo
echo "It will now survive: logout, reboot (restarts at login), crashes, and idle sleep."
echo "It will NOT survive: shutdown until you log back in, or the disk filling up."
