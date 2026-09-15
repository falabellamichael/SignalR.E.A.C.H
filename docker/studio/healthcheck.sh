#!/bin/sh
# Reach Studio container healthcheck — mode-aware.
# noVNC mode: the web client must answer on WEB_PORT.
# Native mode: no web listener exists; health is the Electron main process
# (PID 1) being alive and its window mapped on the external display.
set -e

WEB_PORT="${WEB_PORT:-6080}"

if pgrep -f "websockify.*${WEB_PORT}" >/dev/null 2>&1; then
    python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${WEB_PORT}/vnc.html', timeout=4).status==200 else 1)"
    exit $?
fi

# Native passthrough mode: main Electron process must be alive.
kill -0 1 2>/dev/null || exit 1
pgrep -f "/opt/reach-studio/reach-studio" >/dev/null 2>&1 || exit 1
exit 0
