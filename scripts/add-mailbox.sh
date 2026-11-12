#!/usr/bin/env bash
# usage: scripts/add-mailbox.sh AGENT
# Starts the two mailbox terminals inbox-AGENT / outbox-AGENT in the local herdr-core and
# registers the agent in the MCP gateway state. Re-run after a reboot: with --keep the old
# terminals survive as plain shells, so box.sh has to be started again.
set -euo pipefail
agent=${1:?usage: add-mailbox.sh AGENT}
here=$(cd "$(dirname "$0")/.." && pwd)
hc=${HC:-herdr-core}
for box in "inbox-$agent" "outbox-$agent"; do
  "$hc" run --bg --name "$box" --no-parent --outlive-parent --keep --label "agent=$agent" "$here/mailbox/box.sh" "$box"
done
node "$here/server/server.mjs" add-agent "$agent" "inbox-$agent" "outbox-$agent"
echo "next: node $here/server/server.mjs connect-code $agent   (OAuth clients)"
echo "  or: node $here/server/server.mjs issue-token $agent    (static bearer, printed once)"
