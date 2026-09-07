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


def install(repo_root, quiet=False):
    """Copy the checkout's vscode/ into the user extensions dir. Returns True on success."""
    src = Path(repo_root) / "vscode"
    if not (src / "package.json").is_file():
        print("  vscode/: extension sources missing from checkout — skipped")
        return False
    root = vscode_extensions_dir()
    dst = root / FOLDER
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "extension.js"):
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
    if not quiet:
        print("  VS Code extension installed -> " + str(dst))
        print("  (reload VS Code: Ctrl+Shift+P -> Developer: Reload Window)")
    return True


def uninstall(quiet=False):
    root = vscode_extensions_dir()
    if not root.is_dir():
        return
    for entry in list(root.iterdir()):
        if _is_ours(entry):
            shutil.rmtree(entry, ignore_errors=True)
            if not quiet:
                print("  removed " + str(entry))
