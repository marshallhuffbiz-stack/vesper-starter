#!/bin/zsh
# Roll Vesper back: point `current` at the given release (default: the one before the last deploy), restart the
# service and probe. Old plugin copies are kept in ~/.vesper/plugin-prev.
set -euo pipefail
source "${0:A:h}/env.sh"
TARGET=${1:-$(cat "$VESPER_HOME/releases/.previous" 2>/dev/null || true)}
if [[ -z $TARGET || ! -d $TARGET ]]; then echo "rollback: no previous release to roll back to" >&2; exit 1; fi
ln -sfh "$TARGET" "$VESPER_HOME/current"
launchctl kickstart -k "$DOMAIN/$LABEL"
"${0:A:h}/probe.sh"
echo "rollback: current -> $TARGET"
