"""Saved CLI session: endpoint, model, workpath, layout, and theme."""

import json
import os
import tempfile
import threading

# Registry edits and ordinary model/workpath saves share one transaction lock.
_CONFIG_LOCK = threading.RLock()
_UNSET = object()


def _read_config(path, strict=False):
    """Read the original object so future/unknown fields survive a save."""
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate configuration field")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("invalid JSON number")

    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle, object_pairs_hook=unique_object,
                             parse_constant=invalid_constant) if strict else json.load(handle)
    except FileNotFoundError:
        return {}
    except Exception:
        if strict:
            raise ValueError("Cannot read endpoint configuration. Check the config JSON and permissions before editing endpoints.")
        return {}
    if not isinstance(data, dict):
        if strict:
            raise ValueError("Endpoint configuration must be a JSON object; no changes were saved.")
        return {}
    return data


def _write_config(path, data):
    """Replace an entire configuration atomically with a unique temp file."""
    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=".%s." % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

def session_config_path():
    override = os.environ.get("REACH_CLI_CONFIG")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".config", "reach-cli", "config.json")


def history_file_path():
    override = os.environ.get("REACH_CLI_HISTORY")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".reach_cli_history")


def load_session_config(path=None):
    """Return saved endpoint/model/workpath. Corrupt files yield {}."""
    path = path or session_config_path()
    with _CONFIG_LOCK:
        data = _read_config(path)
    clean = {}
    for key in ("endpoint", "endpoint_name", "model", "workpath", "layout", "theme"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            clean[key] = value.strip()
    if isinstance(data.get("custom_endpoints"), dict):
        clean["custom_endpoints"] = data["custom_endpoints"]
    return clean


def save_session_config(endpoint=None, model=None, workpath=None, path=None,
                        layout=None, theme=None, endpoint_name=_UNSET,
                        clear_model=False):
    """Merge session fields and write them. Returns False instead of raising."""
    path = path or session_config_path()
    try:
        with _CONFIG_LOCK:
            current = _read_config(path, strict=True)
            updates = {"endpoint": endpoint, "model": model, "workpath": workpath,
                       "layout": layout, "theme": theme}
            for key, value in updates.items():
                if isinstance(value, str) and value.strip():
                    current[key] = value.strip()
            if isinstance(endpoint_name, str) and endpoint_name.strip():
                current["endpoint_name"] = endpoint_name.strip().lower()
            elif endpoint_name is not _UNSET or isinstance(endpoint, str) and endpoint.strip():
                current.pop("endpoint_name", None)
            if clear_model:
                current.pop("model", None)
            _write_config(path, current)
        return True
    except Exception:
        return False


def apply_saved_session(client, args, path=None):
    """Apply ~/.config/reach-cli/config.json where flags were not passed."""
    from .terminal import c_yellow
    saved = load_session_config(path)
    if not saved:
        print(c_yellow("  no saved session — starting fresh"))
        return saved
    if client is None:
        return saved
    explicit_key = getattr(args, "key", None) is not None
    explicit_env = getattr(args, "key_env", None)
    endpoint_failed = False
    if not getattr(args, "base", None) and saved.get("endpoint_name"):
        # Resolve only the local registry here; startup discovery owns network I/O.
        from .endpoints import BUILTIN_NAMES, EndpointError, credential_for, get_custom
        name = saved["endpoint_name"].lower()
        try:
            if name in BUILTIN_NAMES:
                client.endpoint_name = "subscription" if name == "public" else name
                client.base = "local" if name == "local" else "subscription"
                if explicit_key or explicit_env:
                    pass  # The constructor has already scoped this explicit credential.
                elif name == "local":
                    client.key = ""
                else:
                    client.key = (getattr(args, "key", None) or os.environ.get("REACH_KEY") or "").strip()
            else:
                record = get_custom(name, path=path)
                client.base = record["url"]
                client.endpoint_name = name
                if not explicit_key and not explicit_env:
                    client.key = credential_for(record)
                    client.key_env = record.get("key_env")
                    client.key_ref = "env:" + client.key_env if client.key_env else "anonymous"
                    client.explicit_credential = False
        except EndpointError:
            client.base = "local"
            client.endpoint_name = "local"
            client.key = ""
            endpoint_failed = True
            client.model = None
            print(c_yellow("  saved custom endpoint is unavailable; using local. Check /endpoints."))
    elif not getattr(args, "base", None) and saved.get("endpoint"):
        try:
            client.base = saved["endpoint"].rstrip("/")
            # Legacy URL-only saves have no proof of subscription identity.
            # Honor an explicit --key, but never attach the subscription env key.
            if not explicit_key and not explicit_env:
                client.key = ""
                client.key_env = None
                client.key_ref = "anonymous"
                client.explicit_credential = False
        except Exception:
            pass
    if not endpoint_failed and not getattr(args, "model", None) and saved.get("model"):
        try:
            client.model = saved["model"]
        except Exception:
            pass
    if not getattr(args, "workpath", None) and saved.get("workpath"):
        folder = os.path.abspath(os.path.expanduser(saved["workpath"]))
        if os.path.isdir(folder):
            try:
                client.workpath = folder
            except Exception:
                pass
        else:
            print(c_yellow("  saved workpath is missing: %s" % folder))
    return saved

