# Shared settings for the bin/ scripts (sourced, zsh). Override any of these in your shell if you need to.
VESPER_HOME=${VESPER_HOME:-$HOME/.vesper}
VESPER_CONFIG_DIR=${VESPER_CONFIG_DIR:-$HOME/.config/vesper}
HERMES_HOME=${HERMES_HOME:-$HOME/.hermes}
VESPER_CONFIG=${VESPER_CONFIG:-$VESPER_CONFIG_DIR/config.json}
VESPER_TEAM=${VESPER_TEAM:-$VESPER_CONFIG_DIR/team.json}
LABEL=${VESPER_LABEL:-com.vesper.app}
BACKUP_LABEL=${VESPER_BACKUP_LABEL:-com.vesper.backup}
DOMAIN=gui/$(id -u)

# Node 24 or newer (node:sqlite). VESPER_NODE wins, then the node on PATH.
find_node() {
  NODE=${VESPER_NODE:-$(command -v node 2>/dev/null || true)}
  if [[ -z $NODE ]]; then echo "Node 24 or newer is needed (https://nodejs.org, or: brew install node)" >&2; return 1; fi
  local major
  major=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if (( major < 24 )); then echo "Node 24 or newer is needed; $NODE is $("$NODE" -v 2>/dev/null)" >&2; return 1; fi
  NODE=${NODE:A}
}

# The hermes command. VESPER_HERMES_BIN wins, then ~/.local/bin/hermes (the installer's default), then PATH.
find_hermes() {
  HERMES=${VESPER_HERMES_BIN:-}
  [[ -z $HERMES && -x $HOME/.local/bin/hermes ]] && HERMES=$HOME/.local/bin/hermes
  [[ -z $HERMES ]] && HERMES=$(command -v hermes 2>/dev/null || true)
  if [[ -z $HERMES ]]; then
    echo "Hermes Agent is not installed. Install it first:" >&2
    echo "  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" >&2
    return 1
  fi
}

# The port Vesper listens on (config.json, default 8802).
vesper_port() {
  local cfg=$VESPER_CONFIG
  if [[ -f $cfg && -n ${NODE:-} ]]; then
    "$NODE" -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port || 8802)) } catch { process.stdout.write("8802") }' "$cfg"
  else
    print -n 8802
  fi
}
