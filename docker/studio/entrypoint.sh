#!/bin/bash
# Reach Studio GUI container entrypoint.
# Pipeline: Xvfb (virtual display) -> x11vnc (screen capture) ->
# noVNC websockify (browser client on :6080) -> Electron app on the display.
#
# Electron runs with --no-sandbox: the SUID chrome-sandbox cannot run inside
# a container, and the container boundary itself is the isolation.
# Settings/conversations persist in /data (mount a volume there).
set -e

: "${DISPLAY:=:0}"
: "${RESOLUTION:=1600x900x24}"
: "${VNC_PORT:=5900}"
: "${WEB_PORT:=6080}"

echo "[reach-studio] starting Xvfb on ${DISPLAY} (${RESOLUTION})"
Xvfb "${DISPLAY}" -screen 0 "${RESOLUTION}" -nolisten tcp &
XVFB_PID=$!

# Wait for the X socket before anything attaches to it.
for _ in $(seq 1 50); do
    [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
    sleep 0.2
done

VNC_ARGS=(-display "${DISPLAY}" -forever -shared -rfbport "${VNC_PORT}" -quiet)
if [ -n "${VNC_PASSWORD:-}" ]; then
    VNC_ARGS+=(-passwd "${VNC_PASSWORD}")
else
    echo "[reach-studio] WARNING: no VNC_PASSWORD set — the noVNC page is open."
    echo "[reach-studio]          Bind the port to localhost, or set VNC_PASSWORD."
    VNC_ARGS+=(-nopw)
fi
echo "[reach-studio] starting x11vnc on :${VNC_PORT}"
x11vnc "${VNC_ARGS[@]}" &

echo "[reach-studio] starting noVNC on :${WEB_PORT}"
websockify --web /usr/share/novnc "${WEB_PORT}" "localhost:${VNC_PORT}" &

# Reap children if any display layer dies, so the container fails loudly.
trap 'kill ${XVFB_PID} 2>/dev/null || true' TERM INT

echo "[reach-studio] launching Reach Studio — open http://localhost:${WEB_PORT}/vnc.html"
exec /opt/reach-studio/reach-studio \
    --no-sandbox \
    --disable-gpu \
    --user-data-dir=/data \
    "$@"
