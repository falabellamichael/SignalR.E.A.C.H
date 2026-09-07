"""Local-extension registry: location, read/write, entry upsert, install stash."""

import hashlib
import json
import os
from pathlib import Path

from . import PLUGIN_ID, SCHEMA_VERSION, SURFACES
from .config import CONFIG_DIR


def extension_home(override=None):
    if override:
        return Path(override).expanduser().resolve()
    configured = os.environ.get("PYMU_RAG_EXTENSION_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    runtime_home = os.environ.get("PYMU_RAG_HOME")
    if runtime_home:
        return Path(runtime_home).expanduser().resolve().parent / "extensions"
    local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local_app_data).expanduser().resolve() / "RAGWorkspace" / "extensions"


def package_dir(home, version):
    return home / "packages" / PLUGIN_ID / version


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def read_registry(home):
    path = home / "registry.json"
    if not path.is_file():
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("warning: could not read %s (%s); starting a fresh registry" % (path, exc))
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    if not isinstance(parsed, dict) or parsed.get("schema_version") != SCHEMA_VERSION:
        print("warning: %s is not a schema-v1 registry; starting a fresh one" % path)
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    entries = parsed.get("extensions")
    if not isinstance(entries, list):
        entries = []
    parsed["extensions"] = [e for e in entries if isinstance(e, dict)]
    return parsed


def write_registry(home, registry):
    """Atomic write: peer installers (Blueprint, gradient-studio) rewrite this
    file concurrently, so a partial write must never be visible to the server."""
    home.mkdir(parents=True, exist_ok=True)
    path = home / "registry.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(registry, separators=(",", ":")),
                   encoding="utf-8")
    os.replace(str(tmp), str(path))


def verify_registry_entry(home, entry_id):
    """Re-read the registry from disk and confirm our entry is present."""
    registry = read_registry(home)
    return any(e.get("id") == entry_id for e in registry.get("extensions", []))


def registry_entry(plugin, assets, manifest_bytes):
    """Hybrid registry entry.

    Current frontend servers require {id, version, enabled, manifest_sha256}
    and read the assets from the package manifest. OLDER installed builds
    read inline scripts/styles off the entry itself and silently drop
    entries without them. Emit both shapes so every build injects the
    panel: new loaders ignore the inline extras, legacy loaders ignore
    manifest_sha256.
    """
    scripts = []
    styles = []
    for name, data in assets:
        item = {"path": name, "sha256": sha256_bytes(data), "size": len(data)}
        if name.endswith(".js"):
            scripts.append(item)
        elif name.endswith(".css"):
            styles.append(item)
    return {
        "id": PLUGIN_ID,
        "version": plugin["version"],
        "enabled": True,
        "manifest_sha256": sha256_bytes(manifest_bytes),
        # legacy inline shape (kept for older app builds)
        "schema_version": SCHEMA_VERSION,
        "surfaces": plugin.get("surfaces") or SURFACES,
        "scripts": scripts,
        "styles": styles,
    }


LEGACY_PLUGIN_IDS = ("simple-reach",)   # pre-rebrand id; removed on install


def upsert_registry(home, entry):
    """Insert/replace ONLY our entry; every other entry is preserved as-is.
    Peers can overwrite the file a moment later — the caller verifies and
    retries (see cmd_install). Legacy pre-rebrand ids are dropped so the
    renamed plugin never appears twice in the panel."""
    registry = read_registry(home)
    entries = [e for e in registry["extensions"]
               if e.get("id") != PLUGIN_ID and e.get("id") not in LEGACY_PLUGIN_IDS]
    entries.append(entry)
    entries.sort(key=lambda e: e.get("id", ""))
    registry["extensions"] = entries
    write_registry(home, registry)
    # tidy the orphaned pre-rebrand package dir
    legacy_dir = home / "packages" / "simple-reach"
    if legacy_dir.is_dir():
        import shutil
        shutil.rmtree(legacy_dir, ignore_errors=True)


STASH_DIR = CONFIG_DIR / "extension-stash"


def stash_extension(entry, assets, manifest_bytes):
    """Keep the built package beside the runtime so `reassert` can restore the
    registry entry WITHOUT the git checkout (peer installers clobber the
    shared registry.json; autostart reasserts on every logon)."""
    STASH_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in assets:
        (STASH_DIR / name).write_bytes(data)
    (STASH_DIR / "manifest.json").write_bytes(manifest_bytes)
    (STASH_DIR / "entry.json").write_text(json.dumps(entry), encoding="utf-8")
