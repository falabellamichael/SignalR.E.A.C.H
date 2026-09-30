#!/bin/sh
# SimpleREACH one-click installer (Linux/macOS).
# Usage: sh install.sh
# Clones (or reuses) the repo, then runs: python3 tools/reach.py install
set -eu

REPO='https://github.com/falabellamichael/SignalR.E.A.C.H.git'
DIR="$PWD/SignalR.E.A.C.H"

# 1. Python (3.9+)
if command -v python3 >/dev/null 2>&1; then
    PY=python3
elif command -v python >/dev/null 2>&1; then
    PY=python
else
    echo "[SimpleREACH] Python not found. Install Python 3.9+ and re-run." >&2
    exit 1
fi
VER=$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "[SimpleREACH] using $PY ($VER)"

# 2. Clone or refresh
# The public edition is available without private operator repository access.
if [ -d "$DIR/.git" ]; then
    echo "[SimpleREACH] existing checkout at $DIR - pulling latest"
    git -C "$DIR" pull --ff-only
else
    echo "[SimpleREACH] cloning $REPO"
    git clone --depth 1 "$REPO" "$DIR"
fi

# 3. Install the public SimpleRAG frontend only.
echo "[SimpleREACH] installing..."
(cd "$DIR" && "$PY" tools/reach.py install)

echo ''
echo '[SignalREACH] done. Reload SimpleRAG -> Advanced -> SignalREACH.'
echo '[SignalREACH] add your own provider URL and API key in Settings.'
