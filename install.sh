#!/bin/sh
# SimpleREACH one-click installer (Linux/macOS).
# Usage: sh install.sh
# Clones a release or main branch, then runs: python3 tools/reach.py install
# Override the ref with REACH_REF=v26.9.13 (or another tag/branch).
set -eu

REPO='https://github.com/falabellamichael/SignalR.E.A.C.H.git'
REF="${REACH_REF:-main}"

# 0. Use the current folder if it is already a checkout
if [ -f "$PWD/tools/reach.py" ]; then
    DIR="$PWD"
    echo "[SimpleREACH] using current checkout: $DIR"
else
    DIR="$PWD/SignalR.E.A.C.H"
    echo "[SimpleREACH] source: $REPO"
    echo "[SimpleREACH] ref: $REF"
    echo "[SimpleREACH] checkout: $DIR"
fi

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

# 2. Clone or refresh (only when not already in a checkout)
if [ "$DIR" != "$PWD" ]; then
    if [ -d "$DIR/.git" ]; then
        echo "[SimpleREACH] existing checkout at $DIR - fetching $REF"
        git -C "$DIR" fetch --depth 1 origin "$REF"
        git -C "$DIR" checkout --detach FETCH_HEAD
    else
        echo "[SimpleREACH] cloning $REPO at $REF"
        git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
    fi
fi

# 3. Install the public SimpleRAG frontend only.
echo "[SimpleREACH] installing..."
(cd "$DIR" && "$PY" tools/reach.py install)

# 4. `signalreach` command in ~/.local/bin (re-running is safe)
if [ -f "$DIR/tools/signalreach.py" ]; then
    (cd "$DIR" && "$PY" tools/signalreach.py --install-shim)
fi

echo ''
echo '[SignalREACH] done. Reload SimpleRAG -> Advanced -> SignalREACH.'
echo '[SignalREACH] add your own provider URL and API key in Settings.'
