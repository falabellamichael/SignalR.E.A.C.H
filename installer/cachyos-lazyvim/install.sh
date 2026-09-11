#!/usr/bin/env bash
# SignalREACH client setup for CachyOS / Arch Linux + LazyVim.
#
# What it does (a CLIENT machine — it never starts a relay, tunnel or host):
#   1. checks/installs node + python3 (pacman, with your consent)
#   2. grabs the project (uses the checkout this script lives in, or clones it)
#   3. runs the endpoint client as a systemd --user service on 127.0.0.1:20777
#      (an OpenAI-compatible bridge that follows the published REACH pointer)
#   4. installs a `reach` command (the REACH Agent CLI) into ~/.local/bin
#   5. adds REACH keymaps to LazyVim (~/.config/nvim/lua/plugins/reach.lua)
#
# Usage:
#   bash install.sh                 # full setup
#   bash install.sh --no-nvim       # skip the LazyVim integration
#   bash install.sh --dir ~/src/signalreach   # pin the project directory
#   bash install.sh --uninstall     # remove service + command + keymaps
#   bash install.sh -y              # never ask (install missing packages)
#
# The repo is private: either accept the GitHub invite and clone first, or ask
# for the source bundle and run this script from inside the extracted folder.
set -euo pipefail

REPO_URL="https://github.com/falabellamichael/SignalR.E.A.C.H.git"
DEFAULT_DIR="$HOME/.local/share/signalreach"
MARKER="SignalREACH (installer/cachyos-lazyvim)"

DIR=""
SKIP_NVIM=0
UNINSTALL=0
ASSUME_YES=0

say() { printf '\033[1;33m[reach]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31m[reach]\033[0m %s\n' "$*" >&2; }

usage() {
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR="${2:-}"; [ -n "$DIR" ] || { echo "--dir needs a path" >&2; exit 2; }; shift 2 ;;
        --no-nvim) SKIP_NVIM=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/signalreach-endpoint.service"
BIN="$HOME/.local/bin/reach"
NVIM_FILE="$HOME/.config/nvim/lua/plugins/reach.lua"

# Use the checkout this script lives in when there is one (installer/../..),
# otherwise the default clone location.
if [ -z "$DIR" ]; then
    CHECKOUT="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || true)"
    if [ -n "$CHECKOUT" ] && [ -f "$CHECKOUT/tools/endpoint-client.cjs" ]; then
        DIR="$CHECKOUT"
    else
        DIR="$DEFAULT_DIR"
    fi
fi

# ---------------------------------------------------------------- uninstall --
if [ "$UNINSTALL" = 1 ]; then
    say "removing SignalREACH client pieces"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now signalreach-endpoint.service 2>/dev/null || true
    fi
    rm -f "$UNIT" "$BIN"
    if [ -f "$NVIM_FILE" ] && grep -q "$MARKER" "$NVIM_FILE"; then
        rm -f "$NVIM_FILE"
        say "removed $NVIM_FILE"
    fi
    command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true
    say "done. The project directory ($DIR) was kept; delete it manually if you want."
    exit 0
fi

# -------------------------------------------------------------- dependencies --
MISSING=()
command -v node >/dev/null 2>&1 || MISSING+=(nodejs)
command -v python3 >/dev/null 2>&1 || MISSING+=(python)
if [ "${#MISSING[@]}" -gt 0 ]; then
    if ! command -v pacman >/dev/null 2>&1; then
        warn "missing: ${MISSING[*]} — install them and re-run."
        exit 1
    fi
    say "missing packages: ${MISSING[*]}"
    DO_INSTALL=0
    if [ "$ASSUME_YES" = 1 ]; then
        DO_INSTALL=1
    elif [ -t 0 ]; then
        read -r -p "[reach] install them with pacman now? [Y/n] " ANSWER || true
        case "${ANSWER:-y}" in ""|y|Y) DO_INSTALL=1 ;; esac
    fi
    if [ "$DO_INSTALL" = 1 ]; then
        sudo pacman -S --needed --noconfirm "${MISSING[@]}"
    else
        warn "install them first: sudo pacman -S --needed ${MISSING[*]}"
        exit 1
    fi
fi

# ------------------------------------------------------------------ project --
if [ ! -f "$DIR/tools/endpoint-client.cjs" ]; then
    if ! command -v git >/dev/null 2>&1; then
        warn "the project is not in place and git is missing — install git or extract the bundle here first."
        exit 1
    fi
    say "fetching the project into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --depth 1 "$REPO_URL" "$DIR"
fi
say "project directory: $DIR"

# ------------------------------------------------- endpoint client (service) --
mkdir -p "$UNIT_DIR" "$HOME/.local/bin"
cat > "$UNIT" <<EOF
# $MARKER — see installer/cachyos-lazyvim/README.md
[Unit]
Description=SignalREACH endpoint client (local OpenAI-compatible bridge on 127.0.0.1:20777)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node $DIR/tools/endpoint-client.cjs
WorkingDirectory=$DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user daemon-reload 2>/dev/null \
        && systemctl --user enable --now signalreach-endpoint.service 2>/dev/null; then
        say "endpoint client running: 127.0.0.1:20777 (systemctl --user status signalreach-endpoint)"
    else
        warn "could not start the user service automatically — run:"
        warn "  systemctl --user enable --now signalreach-endpoint"
    fi
else
    warn "systemd not found — start it manually: node $DIR/tools/endpoint-client.cjs"
fi

# -------------------------------------------------------------- reach command --
cat > "$BIN" <<EOF
#!/usr/bin/env bash
# $MARKER
exec python3 "$DIR/tools/reach-cli.py" "\$@"
EOF
chmod +x "$BIN"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
        warn "$HOME/.local/bin is not on PATH — add it, e.g.:"
        warn "  fish : fish_add_path \$HOME/.local/bin"
        warn "  bash : echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
        warn "  zsh  : echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
        ;;
esac

# ------------------------------------------------------------------- LazyVim --
if [ "$SKIP_NVIM" != 1 ]; then
    if [ -d "$HOME/.config/nvim" ]; then
        mkdir -p "$(dirname "$NVIM_FILE")"
        if [ -f "$NVIM_FILE" ] && ! grep -q "$MARKER" "$NVIM_FILE"; then
            cp "$NVIM_FILE" "$NVIM_FILE.bak.$(date +%s)"
            say "existing reach.lua backed up"
        fi
        if [ -f "$SCRIPT_DIR/reach.lua" ]; then
            cp "$SCRIPT_DIR/reach.lua" "$NVIM_FILE"
            say "LazyVim keymaps installed: $NVIM_FILE (<leader>ac chat, <leader>af file, <leader>as selection)"
        else
            warn "reach.lua not found next to this script — skipping Neovim keymaps"
        fi
    else
        say "no ~/.config/nvim directory — skipping LazyVim integration"
    fi
fi

# --------------------------------------------------------------------- verify --
probe() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 4 "$1"
    else
        python3 -c 'import sys,urllib.request; print(urllib.request.urlopen(sys.argv[1], timeout=4).read().decode())' "$1"
    fi
}
say "checking the endpoint client (the pointer lookup needs network)..."
OK=0
for _ in $(seq 1 15); do
    if OUT="$(probe http://127.0.0.1:20777/public-url 2>/dev/null)"; then
        OK=1
        break
    fi
    sleep 1
done
if [ "$OK" = 1 ]; then
    say "endpoint client is live."
    say "published endpoint: $OUT"
else
    warn "the client did not answer yet — check: systemctl --user status signalreach-endpoint"
fi

cat <<EOF

[reach] done.

  reach chat              interactive chat in this terminal
  reach ask "question"    one-shot answer
  reach web "question"    grounded web answer with sources

  In LazyVim: <leader>ac chat, <leader>af ask about the file, <leader>as ask
  about the selection (visual mode). Reload Neovim after installing.

  Notes:
    - The host must be online: this client follows the published pointer.
    - Uninstall: bash install.sh --uninstall
EOF
