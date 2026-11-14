#!/bin/zsh
# Restart the Hermes gateway to load a new Vesper plugin or changed bot settings. Hermes drains running bot turns
# first, so replies are not cut off. Then wait until every bot's Vesper stream is back.
set -uo pipefail
source "${0:A:h}/env.sh"
find_node >/dev/null 2>&1 || true
find_hermes || exit 1
PORT=${VESPER_PORT:-$(vesper_port)}
"$HERMES" gateway restart || { echo "gateway: restart failed (is it installed? run: $HERMES gateway install)" >&2; exit 1; }
for i in {1..60}; do
  body=$(curl -fsS -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
  if print -r -- "$body" | grep -q '"bots":{[^}]*' && ! print -r -- "$body" | grep -q '"bots":{[^}]*:false'; then
    echo "gateway: restarted, all bots connected to Vesper"; exit 0
  fi
  sleep 5
done
echo "gateway: restarted, but not every bot reconnected to Vesper within 5 minutes: $body" >&2
exit 1
