"""VS Code extension side-load helpers.

VS Code picks up extensions from `<user>/.vscode/extensions/<publisher>.<name>-<version>/`
without any marketplace/vsce step, so the installer copies the repo's `vscode/`
directory there directly. Re-running prunes older versions of our extension
(and never touches third-party extensions).
"""

import json
import os
import re
import shutil
from pathlib import Path


def _version_key(version):
    """Comparable SemVer key (build metadata does not affect precedence)."""
    match = re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
        r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
        r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", version)
    if not match:
        raise ValueError("invalid extension version")
    prerelease = match.group(4)
    parts = prerelease.split(".") if prerelease else []
    if any(p.isdigit() and len(p) > 1 and p.startswith("0") for p in parts):
        raise ValueError("invalid extension prerelease version")
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)),
            not prerelease,
            tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts))


def _manifest_identity(src):
    manifest = json.loads((src / "package.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("extension manifest must be an object")
    for field in ("publisher", "name"):
        if not isinstance(manifest.get(field), str) or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9-]*", manifest[field]):
            raise ValueError("invalid extension " + field)
    version = manifest.get("version")
    if not isinstance(version, str):
        raise ValueError("missing extension version")
    _version_key(version)
    return manifest["publisher"], manifest["name"], version


# Keep these exports for the CLI's display path, without a second version value
# that can drift away from package.json. Minimal relay copies may omit vscode/.
try:
    EXT_PUBLISHER, EXT_NAME, EXT_VERSION = _manifest_identity(
        Path(__file__).resolve().parents[2] / "vscode")
except (OSError, ValueError):
    EXT_PUBLISHER, EXT_NAME, EXT_VERSION = "simplereach", "simplereach", ""

EXT_ID = "%s.%s" % (EXT_PUBLISHER, EXT_NAME)
FOLDER = "%s-%s" % (EXT_ID, EXT_VERSION) if EXT_VERSION else EXT_ID


def vscode_extensions_dir():
    if os.name == "nt":
        base = os.environ.get("USERPROFILE") or str(Path.home())
    else:
        base = str(Path.home())
    return Path(base) / ".vscode" / "extensions"


def _is_ours(path, extension_id=EXT_ID):
    return path.is_dir() and path.name.startswith(extension_id + "-")


def _installed_versions(root, extension_id):
    versions = []
    if root.is_dir():
        for path in root.iterdir():
            # Never copy or recursively remove a linked folder outside this root.
            if _is_ours(path, extension_id) and path.resolve().parent == root.resolve():
                try:
                    publisher, name, version = _manifest_identity(path)
                    if ("%s.%s" % (publisher, name) == extension_id and
                            path.name == "%s-%s" % (extension_id, version)):
                        versions.append((_version_key(version), path))
                except (OSError, ValueError):
                    continue
    return sorted(versions, key=lambda entry: entry[0], reverse=True)


def installed():
    root = vscode_extensions_dir()
    return root.is_dir() and any(_is_ours(p) for p in root.iterdir())


def install(repo_root, quiet=False, with_playwright=False):
    """Copy the checkout's vscode/ into the user extensions dir. Returns True on success."""
    src = Path(repo_root) / "vscode"
    if not (src / "package.json").is_file():
        print("  vscode/: extension sources missing from checkout — skipped")
        return False
    try:
        publisher, name, version = _manifest_identity(src)
        extension_id = "%s.%s" % (publisher, name)
        folder = "%s-%s" % (extension_id, version)
        root = vscode_extensions_dir()
        previous = _installed_versions(root, extension_id)
        if previous and previous[0][0] > _version_key(version):
            print("  VS Code extension install skipped: %s is newer than checkout %s"
                  % (previous[0][1].name, version))
            return False
        dst = root / folder
        if dst.resolve().parent != root.resolve():
            raise ValueError("extension destination resolves outside the extensions directory")
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / "package.json", dst / "package.json")
        # Runtime modules are deliberately root-only: never copy the checkout's
        # node_modules, lockfiles, test directories or build artifacts.
        for module in src.glob("*.js"):
            if module.is_file():
                shutil.copy2(module, dst / module.name)
        media_src = src / "media"
        media_dst = dst / "media"
        if media_src.is_dir():
            shutil.copytree(media_src, media_dst, dirs_exist_ok=True)
        # A versioned upgrade must carry forward the optional browser runtime
        # before deleting its old directory. Same-version installs keep it intact.
        if not (dst / "node_modules").exists():
            for _, old in previous:
                dependencies = old / "node_modules"
                if old != dst and dependencies.is_dir():
                    shutil.copytree(dependencies, dst / "node_modules", symlinks=True)
                    break
    except (OSError, ValueError) as exc:
        print("  VS Code extension install failed: %s" % exc)
        return False
    # prune older versions of OUR extension only
    for key, entry in previous:
        if key < _version_key(version) and entry != dst:
            shutil.rmtree(entry, ignore_errors=True)
            if not quiet:
                print("  pruned old VS Code extension %s" % entry.name)
    # default route: gpt-4o-mini through the REACH relay
    if not previous:
        configure_defaults(quiet=quiet)
    # optional Playwright (headless Chromium page fetching)
    if with_playwright:
        _install_playwright(dst)
    if not quiet:
        print("  VS Code extension installed -> " + str(dst))
        if not previous:
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
            settings.setdefault("simplereach.endpoint", endpoint)
            settings.setdefault("simplereach.model", "gpt-4o-mini")
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
