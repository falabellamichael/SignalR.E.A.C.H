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
    """Load config.json with host-sealed secrets decrypted.

    The relay writes secrets encrypted (see reachd.hostid); this is the CLI's
    reader, so it must unseal or every consumer here — admin_token(), the
    status mask, the tunnel publisher — would try to use a dict as if it were
    the secret string. Unsealing is a no-op for plaintext/legacy values.
    """
    if CONFIG_PATH.is_file():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        return _unseal(raw)
    return {}


def _unseal(raw):
    """Decrypt any sealed fields in a loaded config; never raises.

    A wrong-host config yields blank secrets rather than an exception: the CLI
    should still be able to report status and guide the operator to rekey.
    """
    try:
        server_dir = str(Path(__file__).resolve().parents[2] / "server")
        if server_dir not in sys.path:
            sys.path.insert(0, server_dir)
        from reachd import hostid  # local import: tools must work standalone
    except Exception:
        return raw
    system = raw.get("system") or {}
    if not system.get("host_bind", True) or not system.get("host_salt"):
        return raw
    machine = hostid.raw_machine_id()
    if not machine:
        return raw
    material = machine + "\x00" + system["host_salt"]

    def _open(value):
        if not hostid.is_sealed(value):
            return value
        try:
            return hostid.open_sealed(value, material)
        except hostid.HostIdentityError:
            return ""

    if "omniroute_key" in raw:
        raw["omniroute_key"] = _open(raw["omniroute_key"])
    if "admin_token" in system:
        system["admin_token"] = _open(system["admin_token"])
    access = raw.get("access")
    if isinstance(access, dict):
        if "access_key" in access:
            access["access_key"] = _open(access["access_key"])
        for entry in access.get("keys") or []:
            if isinstance(entry, dict) and "key" in entry:
                entry["key"] = _open(entry["key"])
    return raw

def save_config(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

def runtime_port():
    return int(load_config().get("port", DEFAULT_PORT))

