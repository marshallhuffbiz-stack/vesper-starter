#!/bin/zsh
# Probe a running Vesper: /health must answer within VESPER_PROBE_S (default 240 s) with the database write/read
# passing, and the web app shell must be served. Exit 0 = healthy. A healthy start answers in a second or two;
# the long wait is for a Mac short of memory, where Node can take minutes to start (a short probe would then roll
# back a good release).
set -uo pipefail
source "${0:A:h}/env.sh"
find_node >/dev/null 2>&1 || true
PORT=${VESPER_PORT:-$(vesper_port)}
for i in {1..${VESPER_PROBE_S:-240}}; do
  body=$(curl -fsS -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null) && break
  sleep 1
done
if [[ -z ${body:-} ]]; then echo "probe: /health did not answer" >&2; exit 1; fi
if ! print -r -- "$body" | grep -q '"ok":true'; then echo "probe: unhealthy: $body" >&2; exit 1; fi
if ! curl -fsS -m 3 "http://127.0.0.1:$PORT/" | grep -q '<title>'; then echo "probe: app shell not served" >&2; exit 1; fi
echo "probe: ok $body"
