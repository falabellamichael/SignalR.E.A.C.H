"""Build: asset collection, validation, and registry manifest rendering."""

import json

from . import (
    CONFLICT_MARKERS,
    MANIFEST_PLACEHOLDER,
    MANIFEST_TEMPLATE,
    MAX_ASSET_BYTES,
    MAX_ASSETS,
    MAX_EXTENSION_BYTES,
    PLUGIN_ID,
    PLUGIN_JSON,
    SCHEMA_VERSION,
    SCRIPT_SOURCES,
    SRC_DIR,
    STYLE_SOURCES,
    SURFACES,
)
from .registry import sha256_bytes


def load_plugin_manifest():
    if not PLUGIN_JSON.is_file():
        raise SystemExit("error: missing " + str(PLUGIN_JSON))
    return json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))


def build_manifest_js(plugin):
    if not MANIFEST_TEMPLATE.is_file():
        raise SystemExit("error: missing " + str(MANIFEST_TEMPLATE))
    template = MANIFEST_TEMPLATE.read_text(encoding="utf-8")
    if MANIFEST_PLACEHOLDER not in template:
        raise SystemExit("error: manifest template lost its placeholder")
    payload = json.dumps(plugin, separators=(",", ":"), ensure_ascii=False)
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return template.replace(MANIFEST_PLACEHOLDER, payload).encode("utf-8")


def collect_assets(plugin):
    assets = []
    for name in STYLE_SOURCES:
        path = SRC_DIR / name
        if not path.is_file():
            raise SystemExit("error: missing style source " + str(path))
        assets.append((name, path.read_bytes()))
    for name in SCRIPT_SOURCES:
        if name == "manifest.js":
            assets.append((name, build_manifest_js(plugin)))
            continue
        path = SRC_DIR / name
        if not path.is_file():
            raise SystemExit("error: missing script source " + str(path))
        assets.append((name, path.read_bytes()))
    return assets


def validate_assets(assets):
    if len(assets) > MAX_ASSETS:
        raise SystemExit("error: %d assets exceeds the host limit of %d"
                         % (len(assets), MAX_ASSETS))
    total = 0
    for name, data in assets:
        if not data:
            raise SystemExit("error: asset %s is empty" % name)
        if len(data) > MAX_ASSET_BYTES:
            raise SystemExit("error: asset %s exceeds the %d-byte host limit"
                             % (name, MAX_ASSET_BYTES))
        if any(marker in data for marker in CONFLICT_MARKERS):
            raise SystemExit("error: unresolved merge-conflict markers in %s "
                             "— refusing to install a bundle that would not "
                             "parse" % name)
        total += len(data)
    if total > MAX_EXTENSION_BYTES:
        raise SystemExit("error: total payload %d bytes exceeds the %d-byte "
                         "host limit" % (total, MAX_EXTENSION_BYTES))


def build_extension_manifest(plugin, assets):
    scripts = [{"path": name, "sha256": sha256_bytes(data), "size": len(data)}
               for name, data in assets if name.endswith(".js")]
    order = {name: index for index, name in enumerate(SCRIPT_SOURCES)}
    scripts.sort(key=lambda item: order.get(item["path"], 999))
    styles = [{"path": name, "sha256": sha256_bytes(data), "size": len(data)}
              for name, data in assets if name.endswith(".css")]
    style_order = {name: index for index, name in enumerate(STYLE_SOURCES)}
    styles.sort(key=lambda item: style_order.get(item["path"], 999))
    return json.dumps({
        "schema_version": SCHEMA_VERSION,
        "id": PLUGIN_ID,
        "version": plugin["version"],
        "enabled": True,
        "surfaces": SURFACES,
        "scripts": scripts,
        "styles": styles,
    }, separators=(",", ":")).encode("utf-8")
