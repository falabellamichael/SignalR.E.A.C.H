"""Config directory, runtime file paths, and config load/save."""

import json
import os
import shutil
import sys
from pathlib import Path

from . import DEFAULT_PORT


def config_dir():
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    new_dir = base / "SignalREACH"
    old_dir = base / "SimpleREACH"
    legacy_appdata = Path.home() / "AppData" / "Local" / "SignalREACH"
    if not new_dir.exists() and legacy_appdata.exists():
        try:
            shutil.copytree(legacy_appdata, new_dir)
        except Exception:
            pass
    if not new_dir.exists() and old_dir.exists():
        try:
            shutil.copytree(old_dir, new_dir)
        except Exception:
            pass
    return new_dir

CONFIG_DIR = config_dir()

CONFIG_PATH = CONFIG_DIR / "config.json"

PID_PATH = CONFIG_DIR / "reach.pid"

TUNNEL_PID_PATH = CONFIG_DIR / "tunnel.pid"

LOG_PATH = CONFIG_DIR / "reach.log"

TUNNEL_LOG = CONFIG_DIR / "tunnel.log"

BAT_PATH = CONFIG_DIR / "start_reach.bat"

def load_config():
    if CONFIG_PATH.is_file():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return {}

def save_config(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

def runtime_port():
    return int(load_config().get("port", DEFAULT_PORT))

