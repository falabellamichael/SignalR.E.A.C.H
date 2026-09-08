"""Admin-API client: requests, dotted-path helpers, value coercion."""

import json
import urllib.request

from .config import load_config, runtime_port
from .runtime import port_open


def admin_token():
    return (load_config().get("system") or {}).get("admin_token") or ""


def admin_request(path, method="GET", payload=None, port=None):
    url = "http://127.0.0.1:%d%s" % (port or runtime_port(), path)
    req = urllib.request.Request(url, method=method)
    token = admin_token()
    if token:
        req.add_header("X-Reach-Admin", token)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=10) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8", "replace"))


def require_relay():
    if not port_open(runtime_port()):
        raise SystemExit("error: relay not running — `python tools/reach.py start`")


def split_dotted(path):
    """Split a settings path. Model aliases may contain dots
    (e.g. models.claude-opus-4.6.description), so the models section gets
    special handling: everything between 'models.' and the LAST dot is the
    alias."""
    parts = path.split(".")
    if len(parts) >= 3 and parts[0] == "models":
        return "models", ".".join(parts[1:-1]), parts[-1]
    return None, None, None


def get_dotted(cfg, path):
    section, alias, key = split_dotted(path)
    if section:
        spec = (cfg.get("models") or {}).get(alias)
        return spec.get(key) if isinstance(spec, dict) else None
    node = cfg
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None
    return node


def set_dotted_patch(path, value):
    """Build a nested PUT patch from a dotted path, e.g. models.gpt-4o.rpm."""
    section, alias, key = split_dotted(path)
    if section:
        return {"models": {alias: {key: value}}}
    parts = path.split(".")
    patch = {}
    node = patch
    for part in parts[:-1]:
        node[part] = {}
        node = node[part]
    node[parts[-1]] = value
    return patch


def coerce_value(current, raw):
    """Coerce a CLI string to the type of the current value."""
    if isinstance(current, bool):
        if raw.lower() in ("true", "1", "yes", "on"):
            return True
        if raw.lower() in ("false", "0", "no", "off"):
            return False
        raise ValueError("expected true/false")
    if isinstance(current, int) and not isinstance(current, bool):
        if not raw.lstrip("-").isdigit():
            raise ValueError("expected an integer")
        return int(raw)
    if isinstance(current, float):
        try:
            return float(raw)
        except ValueError:
            raise ValueError("expected a number")
    if isinstance(current, list):
        return [item.strip() for item in raw.split(",") if item.strip()]
    if current is None:
        if raw.lower() in ("null", "none", "~"):
            return None
        if raw.lower() in ("true", "false"):
            return raw.lower() == "true"
        if raw.lstrip("-").isdigit():
            return int(raw)
        try:
            return float(raw)
        except ValueError:
            return raw
    return raw
