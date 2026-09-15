# Reach Studio GUI container — browser-accessible desktop via noVNC.
#
# Build from the repository root:
#   docker build -f docker/studio/Dockerfile -t reach-studio .
# Run:
#   docker run -d --name studio -p 6080:6080 \
#     -v reach-studio-data:/data \
#     -v "$HOME/projects:/projects" \
#     reach-studio
# then open http://localhost:6080/vnc.html
#
# Stage 1 produces dist/linux-unpacked with electron-builder; stage 2 runs it
# on a virtual X display streamed to the browser over websockets. Electron
# runs with --no-sandbox (the SUID helper cannot run inside a container);
# the container boundary itself is the isolation.
FROM node:24-bookworm-slim AS builder

WORKDIR /src/studio
COPY studio/package.json studio/package-lock.json ./
# allowScripts already permits the electron + esbuild postinstall scripts
# this container build needs; nothing else runs.
RUN npm ci
COPY studio/ ./
RUN npm run dist:linux -- --dir

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc x11-utils xauth dbus-x11 \
        novnc websockify \
        libgtk-3-0 libnss3 libnspr4 libgbm1 libasound2 \
        libatk-bridge2.0-0 libatk1.0-0 libcups2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 \
        libpango-1.0-0 libcairo2 libx11-xcb1 libdrm2 libxshmfence1 \
        python3 curl ca-certificates procps \
        fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Debian ships noVNC at /usr/share/novnc; index.html is the vnc client.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

RUN useradd -m -u 1000 studio \
    && mkdir -p /data /projects \
    && chown -R studio:studio /data /projects

COPY --from=builder --chown=studio:studio /src/studio/dist/linux-unpacked /opt/reach-studio
COPY --chown=studio:studio docker/studio/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER studio
ENV HOME=/home/studio \
    DISPLAY=:0 \
    RESOLUTION=1600x900x24 \
    VNC_PORT=5900 \
    WEB_PORT=6080

WORKDIR /projects
EXPOSE 6080

ENTRYPOINT ["/entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:6080/vnc.html', timeout=4).status==200 else 1)"
