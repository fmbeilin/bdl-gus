#!/usr/bin/env bash
# Why can this machine not reach the GUS API? Distinguishes a local network
# block from GUS blocking us. Prints and exits.
#   curl -fsSL .../diagnose_network.sh | bash
H=bdl.stat.gov.pl
echo "=== this machine ==="
echo "  hostname : $(hostname)"
echo "  public IP: $(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo '(could not determine)')"
ipconfig getsummary en0 2>/dev/null | awk -F' : ' '/SSID/{print "  SSID     :",$2; exit}'
echo "  proxy    : $(scutil --proxy 2>/dev/null | awk '/HTTPEnable|HTTPSEnable/{print $0}' | tr '\n' ' ' | sed 's/  */ /g')"

echo
echo "=== DNS ==="
ip=$(python3 -c "import socket;print(socket.gethostbyname('$H'))" 2>/dev/null)
[ -n "$ip" ] && echo "  $H -> $ip  (DNS fine)" || echo "  DNS FAILED for $H"

echo
echo "=== TCP 443 reachability (5s each) ==="
probe() {
python3 - "$1" <<'PY'
import socket,sys,time
h=sys.argv[1]; t0=time.time()
try:
    socket.create_connection((h,443),timeout=5).close()
    print(f"  {h:<28} OK   ({time.time()-t0:.1f}s)")
except OSError as e:
    print(f"  {h:<28} FAIL ({type(e).__name__} after {time.time()-t0:.1f}s)")
PY
}
probe "$H"
probe stat.gov.pl
probe github.com
probe huggingface.co
probe www.google.com

echo
echo "=== HTTPS request to GUS ==="
code=$(curl -s -o /dev/null -m 20 -w "%{http_code}" "https://$H/api/v1/version" 2>/dev/null)
echo "  GET /api/v1/version -> HTTP ${code:-no response}"

echo
echo "=== verdict ==="
if [ -n "$ip" ] && python3 -c "
import socket,sys
try: socket.create_connection(('$H',443),timeout=5).close(); sys.exit(0)
except OSError: sys.exit(1)" 2>/dev/null; then
  echo "  GUS is reachable from here — the extractor should work."
else
  if python3 -c "
import socket,sys
try: socket.create_connection(('github.com',443),timeout=5).close(); sys.exit(0)
except OSError: sys.exit(1)" 2>/dev/null; then
    cat <<'TXT'
  This machine has internet (github reachable) but CANNOT reach GUS.
  DNS resolves, so it is a firewall dropping the connection, not a DNS block.

  Most likely this network restricts outbound traffic. The hostname pattern
  'wifirestricted' is Princeton's restricted wireless.

  Try, in order:
    1. Plug into wired Ethernet, or join eduroam instead of the restricted SSID
    2. Connect the Princeton VPN (GlobalProtect), then re-run this
    3. Tether to a phone hotspot briefly to confirm it is the network
  After changing networks, re-run this script. If GUS becomes reachable, the
  extractor resumes on its own within 30 minutes (the watcher retries).
TXT
  else
    echo "  This machine cannot reach the internet at all — fix connectivity first."
  fi
fi
