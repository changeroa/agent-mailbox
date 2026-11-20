#!/bin/bash
# ssh ProxyCommand with a primary and a fallback network path to the mailbox host.
# Example ~/.ssh/config:
#   Host mailbox-host
#     HostKeyAlias mailbox-host
#     ProxyCommand ~/agent-mailbox/scripts/ssh-route.sh
# Env: ROUTE_PRIMARY (e.g. private-mesh IP), ROUTE_FALLBACK (e.g. Tailscale IP), ROUTE_PORT (22),
#      ROUTE_LOG (optional file; one line per connection with the path taken).
# HostKeyAlias keeps one known_hosts entry whichever address is used.
set -u
port=${ROUTE_PORT:-22}
: "${ROUTE_PRIMARY:?set ROUTE_PRIMARY}" "${ROUTE_FALLBACK:?set ROUTE_FALLBACK}"
note() { [ -n "${ROUTE_LOG:-}" ] && echo "$(date -u +%FT%TZ) $1" >> "$ROUTE_LOG"; return 0; }
# -G (connect timeout) is BSD nc; GNU/OpenBSD nc on Linux use -w
if nc -h 2>&1 | grep -q -- ' -G'; then probe=(-z -G 3); else probe=(-z -w 3); fi
if nc "${probe[@]}" "$ROUTE_PRIMARY" "$port" 2>/dev/null; then
  note primary; exec nc "$ROUTE_PRIMARY" "$port"
else
  note fallback; exec nc "$ROUTE_FALLBACK" "$port"
fi
