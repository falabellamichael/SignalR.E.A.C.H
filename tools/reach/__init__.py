"""SimpleREACH installer + runtime manager — package (v3.2.0).

Shared constants for the ``reach.*`` modules; the CLI lives in ``reach.cli``.
"""

from pathlib import Path

PLUGIN_ID = "simple-reach"
SCHEMA_VERSION = 1
SURFACES = ["advanced"]
SCRIPT_SOURCES = ["manifest.js", "reach-core.js", "pages-common.js",
                   "pages-dashboard.js", "reach-pages.js", "reach.js"]
STYLE_SOURCES = ["reach.css"]
MANIFEST_PLACEHOLDER = "__REACH_MANIFEST_JSON__"
DEFAULT_PORT = 20777

GIST_ID = "e261e0c31ad08c373bcd667b6982847a"
GIST_FILE = "simple-reach-endpoint.txt"
GIST_RAW = ("https://gist.githubusercontent.com/falabellamichael/"
            + GIST_ID + "/raw/" + GIST_FILE)
REPO_URL = "https://github.com/falabellamichael/SimpleREACH"

MAX_ASSETS = 32
MAX_ASSET_BYTES = 8 * 1024 * 1024
MAX_EXTENSION_BYTES = 16 * 1024 * 1024
CONFLICT_MARKERS = (b"<<<<<<<", b">>>>>>>", b"\n=======")

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = REPO_ROOT / "src"
PLUGIN_JSON = SRC_DIR / "plugin.json"
MANIFEST_TEMPLATE = SRC_DIR / "manifest.template.js"
IS_FULL_REPO = SRC_DIR.is_dir() and PLUGIN_JSON.is_file()
