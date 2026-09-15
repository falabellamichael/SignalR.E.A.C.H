# SignalR.E.A.C.H relay — stdlib-only, no pip dependencies.
# Build from the repository root:
#   docker build -f docker/reachd/Dockerfile -t signalreach-relay .
# Run:
#   docker run -d --name reachd -p 20777:20777 -v reachd-data:/data signalreach-relay
FROM python:3.12-slim

# The relay binds to /data/config.json (see --config-dir below). A fresh
# container starts with defaults; mount a named volume or host directory to
# keep settings, caches and analytics across restarts.
RUN useradd -m -u 1000 reachd \
 && mkdir -p /data \
 && chown -R reachd:reachd /data

WORKDIR /app
COPY --chown=reachd:reachd server/reachd.py ./reachd.py
COPY --chown=reachd:reachd server/reachd ./reachd
COPY --chown=reachd:reachd docker/reachd/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER reachd
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 20777

# Host binding: the relay seals its secrets to the machine it was installed
# on (machine-id fingerprint). Each container instance has its own
# /etc/machine-id, so a fresh volume starts unbound and binds to the
# container — which is what you want for a portable relay host.
#
# The entrypoint seeds host 0.0.0.0 into a FRESH /data/config.json (an
# existing config is never touched) — the relay defaults to 127.0.0.1,
# which inside a container is unreachable through the published port.
ENTRYPOINT ["/entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:20777/v1/models', timeout=4).status==200 else 1)"
