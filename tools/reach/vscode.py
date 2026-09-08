"""VS Code extension side-load helpers.

VS Code picks up extensions from `<user>/.vscode/extensions/<publisher>.<name>-<version>/`
without any marketplace/vsce step, so the installer copies the repo's `vscode/`
directory there directly. Re-running prunes older versions of our extension
(and never touches third-party extensions).
"""

import os
import shutil
from pathlib import Path

EXT_PUBLISHER = "simplereach"
EXT_NAME = "simplereach"
EXT_VERSION = "1.0.0"

EXT_ID = "%s.%s" % (EXT_PUBLISHER, EXT_NAME)
FOLDER = "%s-%s" % (EXT_ID, EXT_VERSION)


def vscode_extensions_dir():
    if os.name == "nt":
        base = os.environ.get("USERPROFILE") or str(Path.home())
    else:
        base = str(Path.home())
    return Path(base) / ".vscode" / "extensions"


def _is_ours(path):
    return path.is_dir() and path.name.startswith(EXT_ID + "-")


def installed():
    root = vscode_extensions_dir()
    return root.is_dir() and any(_is_ours(p) for p in root.iterdir())


def install(repo_root, quiet=False, with_playwright=False):
    """Copy the checkout's vscode/ into the user extensions dir. Returns True on success."""
    src = Path(repo_root) / "vscode"
    if not (src / "package.json").is_file():
        print("  vscode/: extension sources missing from checkout — skipped")
        return False
    root = vscode_extensions_dir()
    dst = root / FOLDER
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "extension.js", "search.js"):
            if (src / name).is_file():
                shutil.copy2(src / name, dst / name)
        media_src = src / "media"
        media_dst = dst / "media"
        media_dst.mkdir(exist_ok=True)
        for name in media_src.iterdir():
            if name.is_file():
                shutil.copy2(name, media_dst / name.name)
    except OSError as exc:
        print("  VS Code extension install failed: %s" % exc)
        return False
    # prune older versions of OUR extension only
    for entry in root.iterdir():
        if _is_ours(entry) and entry.name != FOLDER:
            shutil.rmtree(entry, ignore_errors=True)
            if not quiet:
                print("  pruned old VS Code extension %s" % entry.name)
    # default route: gpt-4o-mini through the REACH relay
    configure_defaults(quiet=quiet)
    # optional Playwright (headless Chromium page fetching)
    if with_playwright:
        _install_playwright(dst)
    if not quiet:
        print("  VS Code extension installed -> " + str(dst))
        print("  default model: gpt-4o-mini (change in Settings -> simplereach.model)")
        print("  (reload VS Code: Ctrl+Shift+P -> Developer: Reload Window)")
    return True


def configure_defaults(quiet=False):
    """Write VS Code user settings so the extension routes to REACH's
    gpt-4o-mini chat out of the box (never clobbers unrelated settings)."""
    import json
    import urllib.request

    public_url = None
    try:
        with urllib.request.urlopen("http://127.0.0.1:20777/public-url",
                                     timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
            public_url = (data.get("public_url") or "").strip() or None
    except Exception:
        pass
    endpoint = (public_url or "http://127.0.0.1:20777") + "/v1"

    settings_paths = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        settings_paths += [
            Path(appdata) / "Code" / "User" / "settings.json",
            Path(appdata) / "Code - Insiders" / "User" / "settings.json",
        ]
    for sp in settings_paths:
        try:
            settings = {}
            if sp.is_file():
                try:
                    settings = json.loads(sp.read_text(encoding="utf-8"))
                    if not isinstance(settings, dict):
                        settings = {}
                except (OSError, json.JSONDecodeError):
                    settings = {}
            settings["simplereach.endpoint"] = endpoint
            settings["simplereach.model"] = "gpt-4o-mini"
            sp.parent.mkdir(parents=True, exist_ok=True)
            sp.write_text(json.dumps(settings, indent=4), encoding="utf-8")
            if not quiet:
                print("  VS Code settings routed to REACH: %s -> %s"
                      % (sp, endpoint))
            return
        except OSError as exc:
            if not quiet:
                print("  could not write VS Code settings %s: %s" % (sp, exc))


def _install_playwright(dst):
    """npm install playwright + headless Chromium inside the extension dir.

    --prefix pins the install to ``dst``: without it npm walks up looking for
    a package.json and can silently install into the user's home directory.
    """
    import subprocess
    npm = shutil.which("npm")
    if not npm:
        print("  --with-playwright: npm not found — skipped")
        return
    print("  installing playwright (npm)…")
    r1 = subprocess.run([npm, "install", "playwright", "--prefix", str(dst),
                         "--no-audit", "--no-fund", "--no-package-lock",
                         "--no-save"],
                        cwd=str(dst), capture_output=True, text=True,
                        timeout=600)
    if r1.returncode != 0:
        print("  playwright npm install failed: %s"
              % (r1.stderr or r1.stdout)[:300])
        return
    print("  downloading headless Chromium…")
    node = shutil.which("node")  # npm ran fine, so node is present
    cli = str(Path(dst) / "node_modules" / "playwright" / "cli.js")
    if node:
        r2 = subprocess.run([node, cli, "install", "chromium"],
                            cwd=str(dst), capture_output=True, text=True,
                            timeout=900)
    else:
        r2 = subprocess.run([npm, "exec", "--prefix", str(dst),
                             "playwright", "install", "chromium"],
                            cwd=str(dst), capture_output=True, text=True,
                            timeout=900)
    if r2.returncode == 0:
        print("  playwright ready — page fetching will use headless Chromium")
    else:
        print("  chromium download failed — page fetching falls back to HTTP")


def uninstall(quiet=False):
    root = vscode_extensions_dir()
    if not root.is_dir():
        return
    for entry in list(root.iterdir()):
        if _is_ours(entry):
            shutil.rmtree(entry, ignore_errors=True)
            if not quiet:
                print("  removed " + str(entry))
