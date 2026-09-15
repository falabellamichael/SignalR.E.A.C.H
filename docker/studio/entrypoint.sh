#!/bin/bash
# Reach Studio GUI container entrypoint.
#
# Two display modes, auto-detected:
#
# 1. NATIVE PASSTHROUGH — an external display was handed to the container, so
#    Electron launches directly on it and the window appears on the host
#    desktop (the "real app" mode):
#      X11 unix socket:  -e DISPLAY=:0 -v /tmp/.X11-unix:/tmp/.X11-unix:ro
#      X11 over TCP:     -e DISPLAY=host.docker.internal:0   (Docker Desktop)
#      Wayland:          -e WAYLAND_DISPLAY=wayland-0 -v $XDG_RUNTIME_DIR:/run/user/1000
#
# 2. VIRTUAL DISPLAY + noVNC (default, headless-safe) — Xvfb -> x11vnc ->
#    websockify; open http://localhost:6080/vnc.html in a browser.
#
# Electron runs with --no-sandbox: the SUID chrome-sandbox cannot run inside
# a container, and the container boundary itself is the isolation.
# Settings/conversations persist in /data (mount a volume there).
set -e

APP_ARGS=(--no-sandbox --disable-gpu --user-data-dir=/data)

# ---------- native passthrough detection ----------
xdg_runtime="${XDG_RUNTIME_DIR:-/run/user/1000}"
display_host="${DISPLAY%%:*}"   # empty for ":0", non-empty for "somehost:0"

if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${xdg_runtime}/${WAYLAND_DISPLAY}" ]; then
    echo "[reach-studio] Wayland display ${WAYLAND_DISPLAY} detected — launching native window"
    exec /opt/reach-studio/reach-studio \
        "${APP_ARGS[@]}" --ozone-platform-hint=auto "$@"
fi
if [ -n "${DISPLAY:-}" ] && { [ -n "${display_host}" ] || [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; }; then
    echo "[reach-studio] X11 display ${DISPLAY} detected — launching native window"
    exec /opt/reach-studio/reach-studio \
        "${APP_ARGS[@]}" --ozone-platform-hint=auto "$@"
fi

# ---------- virtual display + noVNC ----------
: "${DISPLAY:=:0}"
: "${RESOLUTION:=1600x900x24}"
: "${VNC_PORT:=5900}"
: "${WEB_PORT:=6080}"

echo "[reach-studio] no external display — starting Xvfb on ${DISPLAY} (${RESOLUTION})"
Xvfb "${DISPLAY}" -screen 0 "${RESOLUTION}" -nolisten tcp &
XVFB_PID=$!

# Wait for the X socket before anything attaches to it.
for _ in $(seq 1 50); do
    [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
    sleep 0.2
done

VNC_ARGS=(-display "${DISPLAY}" -forever -shared -rfbport "${VNC_PORT}" -quiet)
if [ -n "${VNC_PASSWORD-}" ]; then
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
exec /opt/reach-studio/reach-studio "${APP_ARGS[@]}" "$@"
