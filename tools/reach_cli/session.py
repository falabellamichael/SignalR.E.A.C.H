"""Saved CLI session: endpoint, model, and workpath."""

import json
import os

from .terminal import c_yellow

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
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    clean = {}
    for key in ("endpoint", "model", "workpath"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            clean[key] = value.strip()
    return clean


def save_session_config(endpoint=None, model=None, workpath=None, path=None):
    """Merge session fields and write them. Returns False instead of raising."""
    path = path or session_config_path()
    try:
        current = load_session_config(path)
        updates = {"endpoint": endpoint, "model": model, "workpath": workpath}
        for key, value in updates.items():
            if isinstance(value, str) and value.strip():
                current[key] = value.strip()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(current, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
        return True
    except Exception:
        return False


def apply_saved_session(client, args, path=None):
    """Apply ~/.config/reach-cli/config.json where flags were not passed."""
    saved = load_session_config(path)
    if not saved:
        print(c_yellow("  no saved session — starting fresh"))
        return saved
    if client is None:
        return saved
    if not getattr(args, "base", None) and saved.get("endpoint"):
        try:
            client.base = saved["endpoint"].rstrip("/")
        except Exception:
            pass
    if not getattr(args, "model", None) and saved.get("model"):
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

