#!/bin/sh
# SignalR.E.A.C.H relay container entrypoint.
#
# The relay defaults to host 127.0.0.1, which inside a container is only
# reachable from the container itself — the healthcheck would pass while the
# published port stays dead. A FRESH /data volume therefore seeds
# config.json with host 0.0.0.0 so `-p 20777:20777` actually works.
# An existing config.json is NEVER modified: operators who mount their own
# volume keep exactly the host/port/model settings they wrote.
set -e

DATA_DIR="${REACHD_DATA_DIR:-/data}"
CONFIG="$DATA_DIR/config.json"

if [ ! -f "$CONFIG" ]; then
    mkdir -p "$DATA_DIR"
    cat > "$CONFIG" <<'JSON'
{
  "host": "0.0.0.0"
}
JSON
    echo "reachd: seeded $CONFIG (host 0.0.0.0 for container networking)"
fi

exec python /app/reachd.py --config-dir "$DATA_DIR" "$@"
