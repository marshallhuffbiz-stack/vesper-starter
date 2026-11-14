#!/bin/zsh
# Deploy Vesper: tests first, copy HEAD to releases/<sha>, swap `current`, install the Hermes plugin from the same
# release into every bot profile, start or restart the launchd agent, probe. A failed probe rolls back.
# The Hermes gateway is NOT restarted here; run bin/restart-gateway.sh when the plugin changed.
#   --skip-tests   deploy without running the test suite (bin/setup uses it on a first install)
set -euo pipefail
REPO=${0:A:h:h}
source "$REPO/bin/env.sh"
find_node
find_hermes || HERMES=hermes
SKIP_TESTS=0
[[ ${1:-} == --skip-tests ]] && SKIP_TESTS=1

cd "$REPO"
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "deploy: this folder is not a git checkout with a commit; a release is the committed HEAD" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "deploy: uncommitted changes; commit first (a release is the committed HEAD)" >&2
  exit 1
fi

AVAIL_KB=$(df -k "$HOME" | awk 'NR==2 {print $4}')
if (( AVAIL_KB < 2 * 1024 * 1024 )); then
  echo "deploy: under 2 GB free on this Mac; refusing" >&2
  exit 1
fi

if (( ! SKIP_TESTS )); then
  echo "deploy: running tests"
  VESPER_TEAM="$REPO/test/fixtures/team.json" "$NODE" --no-warnings --test --test-concurrency=1
fi

SHA=$(git rev-parse --short=12 HEAD)
REL=$VESPER_HOME/releases/$SHA
mkdir -p "$VESPER_HOME/releases" "$VESPER_HOME/data" "$VESPER_HOME/logs" "$VESPER_HOME/backups"
chmod 700 "$VESPER_HOME" "$VESPER_HOME/data"
if [[ ! -d $REL ]]; then
  TMP=$REL.tmp.$$
  mkdir -p "$TMP"
  git archive HEAD | tar -x -C "$TMP"
  mv "$TMP" "$REL"
fi

# Snapshot the database before the swap.
if [[ -f $VESPER_HOME/data/vesper.db ]]; then
  sqlite3 "$VESPER_HOME/data/vesper.db" ".backup '$VESPER_HOME/backups/predeploy-$SHA.db'"
fi

# Make sure config (VAPID keys, token hashes) exists before the service starts.
VESPER_CONFIG=$VESPER_CONFIG "$NODE" --no-warnings --input-type=module -e "import('$REL/server/config.mjs').then(m => m.loadConfig())"

PREV=$(readlink "$VESPER_HOME/current" 2>/dev/null || true)
if [[ -n $PREV && $PREV != $REL ]]; then print -r -- "$PREV" > "$VESPER_HOME/releases/.previous"; fi
ln -sfh "$REL" "$VESPER_HOME/current"
echo "deploy: current -> $REL (previous: ${PREV:-none})"

# Hermes plugin: every bot profile discovers plugins in its own plugins folder, so the plugin is copied (not
# linked) into the root and each profile. A copy swap means the gateway never reads a half-written tree. The old
# copy goes OUT of the plugins folder: left beside the new one it is a second plugin with the same name, and the
# gateway may load it instead.
PROFILES=(${(z)$(VESPER_TEAM=$VESPER_TEAM "$NODE" --no-warnings --input-type=module -e "import('$REL/server/team.mjs').then(m => console.log(m.BOTS.map(b => b.profile).join(' ')))")})
PLUGIN_DIR=$HERMES_HOME/plugins/holler
PLUGIN_CHANGED=0
for dir in "$PLUGIN_DIR" ${^PROFILES/#/$HERMES_HOME/profiles/}/plugins/holler; do
  [[ $dir == $PLUGIN_DIR || -d ${dir:h:h} ]] || continue
  if ! diff -rq -x __pycache__ "$REL/hermes-plugin/holler" "$dir" >/dev/null 2>&1; then
    mkdir -p "${dir:h}"
    rm -rf "$dir.new"
    cp -R "$REL/hermes-plugin/holler" "$dir.new"
    if [[ -d $dir ]]; then
      keep=$VESPER_HOME/plugin-prev/${${dir:h:h}:t}-$(date +%s)
      mkdir -p "${keep:h}"
      mv "$dir" "$keep"
    fi
    mv "$dir.new" "$dir"
    PLUGIN_CHANGED=1
  fi
done
for stray in $HERMES_HOME/plugins/holler.*(N) $HERMES_HOME/profiles/*/plugins/holler.*(N); do
  [[ -d $stray ]] || continue
  mkdir -p "$VESPER_HOME/plugin-prev"
  mv "$stray" "$VESPER_HOME/plugin-prev/${${stray:h:h}:t}-${stray:t}"
  PLUGIN_CHANGED=1
done
if [[ -d $VESPER_HOME/plugin-prev ]]; then
  for old in $VESPER_HOME/plugin-prev/*(Nom[13,-1]); do mv "$old" "$HOME/.Trash/vesper-plugin-${old:t}-$$" 2>/dev/null || true; done
fi
(( PLUGIN_CHANGED )) && echo "deploy: Hermes plugin updated; run bin/restart-gateway.sh to load it (bot turns drain first)"

# launchd agents, rendered from the templates for this Mac.
for f in "$REPO"/launchd/*.plist.in; do
  case ${f:t} in com.vesper.app.*) name=$LABEL ;; com.vesper.backup.*) name=$BACKUP_LABEL ;; *) continue ;; esac
  dest=$HOME/Library/LaunchAgents/$name.plist
  rendered=$(sed -e "s|@NODE@|$NODE|g" -e "s|@VESPER_HOME@|$VESPER_HOME|g" -e "s|@HOME@|$HOME|g" \
    -e "s|@HERMES@|$HERMES|g" -e "s|@HERMES_HOME@|$HERMES_HOME|g" -e "s|@LABEL@|$LABEL|g" -e "s|@BACKUP_LABEL@|$BACKUP_LABEL|g" \
    -e "s|@VESPER_CONFIG@|$VESPER_CONFIG|g" -e "s|@VESPER_TEAM@|$VESPER_TEAM|g" "$f")
  if [[ ! -f $dest ]] || [[ $(cat "$dest") != "$rendered" ]]; then
    mkdir -p "${dest:h}"
    print -r -- "$rendered" > "$dest"
    # bootout returns before the job is gone; a bootstrap that races it fails with "Input/output error" and
    # leaves the service unloaded. Wait, then retry.
    launchctl bootout "$DOMAIN/$name" 2>/dev/null || true
    for i in {1..20}; do launchctl print "$DOMAIN/$name" >/dev/null 2>&1 || break; sleep 0.5; done
    for i in {1..10}; do launchctl bootstrap "$DOMAIN" "$dest" 2>/dev/null && break; sleep 1; done
    if ! launchctl print "$DOMAIN/$name" >/dev/null 2>&1; then echo "deploy: could not load $name; run: launchctl bootstrap $DOMAIN $dest" >&2; exit 1; fi
    echo "deploy: installed $dest"
  fi
done
launchctl kickstart -k "$DOMAIN/$LABEL"

"$REPO/bin/probe.sh" || {
  echo "deploy: probe failed, rolling back" >&2
  if [[ -n $PREV && -d $PREV ]]; then "$REPO/bin/rollback.sh" "$PREV"; fi
  exit 1
}
echo "deploy: $SHA is live"
