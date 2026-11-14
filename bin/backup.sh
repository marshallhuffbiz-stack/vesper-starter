#!/bin/zsh
# Nightly Vesper backup (launchd com.vesper.backup, 3:20 AM): a consistent SQLite .backup plus the uploaded files,
# kept 14 days. Prints one line per run. Optional: set VESPER_OFFSITE to an rsync target (user@host:/path/) and
# each night's copy also goes off this Mac.
set -euo pipefail
VESPER_HOME=${VESPER_HOME:-$HOME/.vesper}
DEST=$VESPER_HOME/backups
STAMP=$(date +%Y-%m-%d)
mkdir -p "$DEST"
AVAIL_KB=$(df -k "$HOME" | awk 'NR==2 {print $4}')
if (( AVAIL_KB < 1024 * 1024 )); then echo "$(date -u +%FT%TZ) backup: FAILED under 1 GB free"; exit 1; fi
sqlite3 "$VESPER_HOME/data/vesper.db" ".backup '$DEST/vesper-$STAMP.db'"
sqlite3 "$DEST/vesper-$STAMP.db" "PRAGMA integrity_check;" | grep -qx ok
tar -czf "$DEST/files-$STAMP.tgz" -C "$VESPER_HOME/data" files
find "$DEST" -name 'vesper-*.db' -mtime +14 -delete
find "$DEST" -name 'files-*.tgz' -mtime +14 -delete
find "$DEST" -name 'predeploy-*.db' -mtime +14 -delete
OFF=skipped
if [[ -n ${VESPER_OFFSITE:-} ]]; then
  if rsync -az --timeout=60 -e "ssh -o BatchMode=yes -o ConnectTimeout=15" "$DEST/vesper-$STAMP.db" "$DEST/files-$STAMP.tgz" "$VESPER_OFFSITE" 2>/dev/null; then OFF=ok; else OFF=FAILED; fi
fi
echo "$(date -u +%FT%TZ) backup: db ok, files ok, offsite $OFF"
[[ $OFF != FAILED ]]
