#!/usr/bin/env python3
"""Build isolated SimpleRAG frontend editions and history-free source exports.

This module deliberately does not import reach: that package reads and migrates
the operator's installed runtime state at import time.
"""

import argparse
import copy
import hashlib
import json
import re
import runpy
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN_SCRIPTS = (
    "manifest.js", "reach-core.js", "pages-common.js", "pages-dashboard.js",
    "browser-engine.js", "pages-browser.js", "pages-endpoint.js",
    "pages-models.js", "pages-usage.js", "pages-logs.js", "pages-settings.js",
    "pages-about.js", "reach-pages.js", "reach.js",
)
ADMIN_STYLES = (
    "reach.css", "reach-components.css", "reach-telemetry.css", "reach-tools.css",
    "reach-theme.css", "reach-responsive.css", "reach-browser.css",
)
PUBLIC_SCRIPTS = ("manifest.js", "reach-public.js")
PUBLIC_STYLES = ("reach-public.css",)
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\Z")
# Only generated Admin assets are changed. Existing source/runtime stays intact.
ADMIN_REPLACEMENTS = (
    ("__signalReachControllerDispose", "__signalReachAdminControllerDispose"),
    ("__simpleReachControllerDispose", "__simpleReachAdminControllerDispose"),
    ("__signalReachManifest", "__signalReachAdminManifest"),
    ("__simpleReachManifest", "__simpleReachAdminManifest"),
    ("__reachInteractiveBrowser", "__reachAdminInteractiveBrowser"),
    ("__reachPageRegistry", "__reachAdminPageRegistry"),
    ("__reachPageWidgets", "__reachAdminPageWidgets"),
    ("__reachPages", "__reachAdminPages"),
    ("__reachCore", "__reachAdminCore"),
    ("window.signalReach", "window.signalReachAdmin"),
    ("window.simpleReach", "window.simpleReachAdmin"),
    ("signalReach.openPage", "signalReachAdmin.openPage"),
    ("simpleReach.openPage", "simpleReachAdmin.openPage"),
    ("signal-reach.reach-page", "signal-reach-admin.reach-page"),
    ("signal-reach-boot-failure", "signal-reach-admin-boot-failure"),
    ("'signal-reach'", "'signal-reach-admin'"),
    ('"signal-reach"', '"signal-reach-admin"'),
    ("'signal-reach.ui.'", "'signal-reach-admin.ui.'"),
    ("'simple-reach.ui.'", "'signal-reach-admin.legacy.ui.'"),
    ("const APP_ID = 'reach';", "const APP_ID = 'reach-admin';"),
    ("contexts: ['reach']", "contexts: ['reach-admin']"),
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def checked_source(root, relative):
    root = root.resolve()
    source = root / relative
    if source.is_symlink() or root not in source.resolve().parents:
        raise ValueError("Source must be a regular file inside the checkout: " + relative)
    if not source.is_file():
        raise ValueError("Missing edition source: " + relative)
    data = source.read_bytes()
    if re.search(rb"(?m)^(?:<<<<<<<|>>>>>>>|=======)(?:\s|$)", data):
        raise ValueError("Unresolved conflict marker in " + relative)
    return data


def admin_asset(data):
    text = data.decode("utf-8")
    for before, after in ADMIN_REPLACEMENTS:
        text = text.replace(before, after)
    return text.encode("utf-8")


def edition_assets(root, edition):
    if edition == "public":
        plugin = json.loads(checked_source(root, "src/public/plugin.json"))
        if plugin.get("id") != "signal-reach-public":
            raise ValueError("Public plugin identity must be signal-reach-public")
        scripts, styles = PUBLIC_SCRIPTS, PUBLIC_STYLES
        assets = {name: checked_source(root, "src/public/" + name)
                  for name in scripts + styles if name != "manifest.js"}
        manifest_global = "__signalReachPublicManifest"
    else:
        plugin = json.loads(checked_source(root, "src/plugin.json"))
        plugin = copy.deepcopy(plugin)
        plugin["id"] = "signal-reach-admin"
        plugin["name"] = "REACH Admin"
        plugin["description"] = "Private operator control panel for the owner's existing local REACH runtime."
        page = plugin["contributes"]["pages"][0]
        page.update(id="signal-reach-admin.reach-page", title="REACH Admin",
                    ariaLabel="Open the private REACH Admin control panel")
        scripts, styles = ADMIN_SCRIPTS, ADMIN_STYLES
        assets = {name: admin_asset(checked_source(root, "src/" + name))
                  for name in scripts + styles if name != "manifest.js"}
        manifest_global = "__signalReachAdminManifest"
    if not VERSION_RE.fullmatch(str(plugin.get("version", ""))):
        raise ValueError("Edition version must be a valid three-part version")
    plugin["edition"] = edition
    payload = json.dumps(plugin, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    assets["manifest.js"] = ("window." + manifest_global + " = " + payload + ";\n").encode("utf-8")
    if edition == "public":
        # Discovery of the owner's endpoint must never reappear through a
        # reused frontend asset. Check asset bytes, not filenames alone.
        forbidden = (b"gist.githubusercontent.com", b"20777", b"20778",
                     b"__reachCore", b"__signalReachAdminManifest", b"/_reach/",
                     b"github.com/falabellamichael/SignalR.E.A.C.H", b"/api/account")
        for name, data in assets.items():
            if any(token in data for token in forbidden):
                raise ValueError("Owner runtime reference in public asset: " + name)
    entries = lambda names: [{"path": name, "sha256": digest(assets[name]),
                              "size": len(assets[name])} for name in names]
    manifest = {"schema_version": 1, "id": plugin["id"],
                "version": plugin["version"], "edition": edition, "enabled": True,
                "surfaces": ["advanced"], "scripts": entries(scripts),
                "styles": entries(styles)}
    if len(assets) > 32 or any(not data or len(data) > 8 * 1024 * 1024 for data in assets.values()) \
            or sum(map(len, assets.values())) > 16 * 1024 * 1024:
        raise ValueError("Edition assets exceed SimpleRAG host limits or are empty")
    return plugin, manifest, assets


# Included in each frontend package. No runtime import, credential discovery,
# process launch, network request, scheduled task, or tunnel registration.
INSTALLER = r'''#!/usr/bin/env python3
"""Install this frontend package into SimpleRAG's local extension registry."""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path


def extension_home(override=None):
    if override:
        return Path(override).expanduser().resolve()
    if os.environ.get("PYMU_RAG_EXTENSION_HOME"):
        return Path(os.environ["PYMU_RAG_EXTENSION_HOME"]).expanduser().resolve()
    if os.environ.get("PYMU_RAG_HOME"):
        return Path(os.environ["PYMU_RAG_HOME"]).expanduser().resolve().parent / "extensions"
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return (base / "RAGWorkspace" / "extensions").resolve()


def install(package, home):
    package, home = Path(package).resolve(), Path(home).resolve()
    raw_manifest = (package / "manifest.json").read_bytes()
    manifest = json.loads(raw_manifest)
    plugin_id = manifest.get("id")
    if plugin_id not in ("signal-reach-public", "signal-reach-admin"):
        raise ValueError("Unsupported edition identity")
    version = manifest.get("version", "")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid package version")
    if manifest.get("schema_version") != 1 or manifest.get("surfaces") != ["advanced"]:
        raise ValueError("Invalid package manifest")
    scripts, styles = manifest.get("scripts"), manifest.get("styles")
    if not isinstance(scripts, list) or not isinstance(styles, list):
        raise ValueError("Invalid asset lists")
    assets = scripts + styles
    names = []
    for item in assets:
        name = item.get("path", "") if isinstance(item, dict) else ""
        if not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:js|css)", name) or name in names:
            raise ValueError("Invalid or duplicate asset path")
        source = package / name
        if source.is_symlink():
            raise ValueError("Linked package asset")
        data = source.read_bytes()
        if len(data) != item.get("size") or hashlib.sha256(data).hexdigest() != item.get("sha256"):
            raise ValueError("Package integrity check failed: " + name)
        names.append(name)
    if plugin_id == "signal-reach-public" and names != ["manifest.js", "reach-public.js", "reach-public.css"]:
        raise ValueError("Public package contains an unexpected asset")
    if not names or len(names) > 32 or sum(item["size"] for item in assets) > 16 * 1024 * 1024:
        raise ValueError("Package exceeds host asset limits")
    home.mkdir(parents=True, exist_ok=True)
    lock = home / ".reach-editions-install.lock"
    try:
        descriptor = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError("Another edition install is active; retry after it finishes")
    os.close(descriptor)
    stage = None
    backup = None
    target = None
    installed = False
    registry_temp = None
    try:
        registry_path = home / "registry.json"
        if registry_path.is_symlink():
            raise ValueError("Refusing a linked extension registry")
        registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {"schema_version": 1, "extensions": []}
        if not isinstance(registry, dict) or registry.get("schema_version") != 1 or not isinstance(registry.get("extensions"), list) or any(not isinstance(entry, dict) for entry in registry["extensions"]):
            raise ValueError("Invalid extension registry; existing data was preserved")
        parent = home / "packages" / plugin_id
        packages = home / "packages"
        if packages.is_symlink() or packages.resolve() != packages or parent.is_symlink() or parent.resolve() != parent:
            raise ValueError("Refusing a linked package directory")
        parent.mkdir(parents=True, exist_ok=True)
        target = parent / version
        if target.is_symlink() or target.resolve() != target:
            raise ValueError("Refusing a linked installed package")
        stage = Path(tempfile.mkdtemp(prefix=".edition-stage-", dir=str(parent)))
        for name in names:
            shutil.copyfile(package / name, stage / name)
        (stage / "manifest.json").write_bytes(raw_manifest)
        entry = {"id": plugin_id, "version": version, "enabled": True,
                 "manifest_sha256": hashlib.sha256(raw_manifest).hexdigest(),
                 "schema_version": 1, "surfaces": ["advanced"],
                 "scripts": scripts, "styles": styles}
        registry["extensions"] = [value for value in registry["extensions"] if value.get("id") != plugin_id] + [entry]
        descriptor, temporary = tempfile.mkstemp(prefix=".registry-edition-", dir=str(home))
        registry_temp = Path(temporary)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(registry, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        if target.exists():
            backup = Path(tempfile.mkdtemp(prefix=".edition-backup-", dir=str(parent)))
            backup.rmdir()
            target.rename(backup)
        stage.rename(target)
        stage = None
        installed = True
        os.replace(str(registry_temp), str(registry_path))
        registry_temp = None
    except Exception:
        if installed and target is not None:
            shutil.rmtree(target)
        if backup is not None and backup.exists():
            backup.rename(target)
            backup = None
        raise
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage)
        if backup is not None and backup.exists():
            shutil.rmtree(backup)
        if registry_temp is not None and registry_temp.exists():
            registry_temp.unlink()
        lock.unlink()
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-home", help="Optional isolated SimpleRAG extension directory")
    args = parser.parse_args()
    try:
        destination = install(Path(__file__).resolve().parent, extension_home(args.extension_home))
    except (ValueError, OSError) as exc:
        parser.exit(1, "error: " + str(exc) + "\n")
    print("Installed frontend package: " + str(destination))
    print("Reload SimpleRAG's Advanced page to show this edition.")
'''


PUBLIC_BUILD = r'''#!/usr/bin/env python3
"""Build the SignalREACH public frontend from its three reviewed source files."""
import argparse
import hashlib
import json
import re
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(out):
    plugin = json.loads((ROOT / "src/public/plugin.json").read_text(encoding="utf-8"))
    version = plugin.get("version", "")
    if plugin.get("id") != "signal-reach-public" or not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid public plugin identity/version")
    plugin["edition"] = "public"
    payload = json.dumps(plugin, ensure_ascii=False, separators=(",", ":")).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    assets = {"manifest.js": ("window.__signalReachPublicManifest = " + payload + ";\n").encode("utf-8")}
    for name in ("reach-public.js", "reach-public.css"):
        source = ROOT / "src/public" / name
        if source.is_symlink():
            raise ValueError("Linked public source")
        data = source.read_bytes()
        if not data or len(data) > 8 * 1024 * 1024 or re.search(rb"(?m)^(?:<<<<<<<|>>>>>>>|=======)(?:\s|$)", data):
            raise ValueError("Invalid source asset: " + name)
        assets[name] = data
    entries = lambda names: [{"path": name, "size": len(assets[name]), "sha256": hashlib.sha256(assets[name]).hexdigest()} for name in names]
    manifest = {"schema_version": 1, "id": "signal-reach-public", "version": version,
                "edition": "public", "enabled": True, "surfaces": ["advanced"],
                "scripts": entries(("manifest.js", "reach-public.js")), "styles": entries(("reach-public.css",))}
    files = dict(assets)
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    files["plugin.json"] = (json.dumps(plugin, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    files["install.py"] = (ROOT / "tools/install.py").read_bytes()
    files["README.md"] = b"Install this public frontend from this package folder: python install.py\nReload SimpleRAG's Advanced page after installation.\n\nSimpleRAG loads this extension as trusted code in its page context. Install only trusted extension code. Provider requests may charge your own account under your provider's terms.\n"
    name = "signal-reach-public-" + version
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    destination, archive = out / name, out / (name + ".zip")
    if destination.exists() or archive.exists():
        raise ValueError("Output already exists; use a fresh output directory")
    with tempfile.TemporaryDirectory(prefix=".public-build-", dir=str(out)) as temporary:
        stage = Path(temporary) / name
        stage.mkdir()
        for filename, data in files.items():
            (stage / filename).write_bytes(data)
        zip_stage = Path(temporary) / (name + ".zip")
        with zipfile.ZipFile(zip_stage, "w", compression=zipfile.ZIP_DEFLATED) as handle:
            for filename in sorted(files):
                handle.write(stage / filename, name + "/" + filename)
        stage.rename(destination)
        zip_stage.rename(archive)
    return destination, archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        for path in build(args.out):
            print(path)
    except (ValueError, OSError) as exc:
        parser.exit(1, "error: " + str(exc) + "\n")
'''


PUBLIC_PACKAGE_TEST = r'''"""Public-only package build and isolated installer smoke."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class PublicPackageTest(unittest.TestCase):
    def test_build_install_and_preserve_peer(self):
        builder = module(ROOT / "tools/build.py", "public_builder")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, archive = builder.build(root / "build")
            self.assertTrue(archive.is_file())
            manifest = json.loads((package / "manifest.json").read_bytes())
            self.assertEqual([entry["path"] for entry in manifest["scripts"] + manifest["styles"]],
                             ["manifest.js", "reach-public.js", "reach-public.css"])
            installer = module(package / "install.py", "public_installer")
            home = root / "extensions"
            home.mkdir()
            peer = {"id": "peer", "enabled": True}
            (home / "registry.json").write_text(json.dumps({"schema_version": 1, "extensions": [peer]}), encoding="utf-8")
            installer.install(package, home)
            registry = json.loads((home / "registry.json").read_bytes())
            self.assertEqual(registry["extensions"][0], peer)
            self.assertEqual(registry["extensions"][1]["id"], "signal-reach-public")
            self.assertFalse((home / "SignalREACH").exists())


if __name__ == "__main__":
    unittest.main()
'''


def package_readme(edition):
    scope = ("Uses only connections and keys entered by the user. No owner endpoint, relay, tunnel, "
             "billing service, wallet, Supabase project, VS Code extension, or tray is bundled."
             if edition == "public" else
             "Private frontend for the owner's already-installed local REACH relay. "
             "This package does not install, restart, migrate, or copy that runtime or its credentials.")
    return ("# " + ("SignalREACH Public" if edition == "public" else "REACH Admin")
            + "\n\n" + scope
            + ("\n\nSimpleRAG loads this extension as trusted code in its page context. Install only trusted "
               "extension code. Provider requests may charge your own account under your provider's terms."
               if edition == "public" else "")
            + "\n\nInstall from this package folder:\n\n```text\npython install.py\n```\n\n"
            "For an isolated verification install:\n\n```text\npython install.py --extension-home PATH_TO_TEST_EXTENSIONS\n```\n\n"
            "The installer changes only this edition's package and its entry in SimpleRAG's extension "
            "registry. Existing registry entries and other package versions are preserved. "
            "Reload the Advanced page after installation.\n").encode("utf-8")


def installer_source(edition):
    return INSTALLER.replace('if plugin_id not in ("signal-reach-public", "signal-reach-admin"):',
                             'if plugin_id != "signal-reach-' + edition + '":').encode("utf-8")


def write_new_tree(out, name, files):
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    destination, archive = out / name, out / (name + ".zip")
    if destination.exists() or archive.exists():
        raise ValueError("Output already exists; choose a new output directory: " + name)
    with tempfile.TemporaryDirectory(prefix=".edition-export-", dir=str(out)) as temporary:
        stage = Path(temporary) / name
        stage.mkdir()
        for relative, data in files.items():
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        zip_stage = Path(temporary) / (name + ".zip")
        with zipfile.ZipFile(zip_stage, "w", compression=zipfile.ZIP_DEFLATED) as handle:
            for relative in sorted(files):
                handle.write(stage / relative, name + "/" + relative)
        stage.rename(destination)
        zip_stage.rename(archive)
    return destination, archive


def build(root, edition, out):
    plugin, manifest, assets = edition_assets(Path(root), edition)
    files = dict(assets)
    files.update({"manifest.json": json_bytes(manifest), "plugin.json": json_bytes(plugin),
                  "install.py": installer_source(edition), "README.md": package_readme(edition)})
    return write_new_tree(out, plugin["id"] + "-" + plugin["version"], files)


def install_edition(root, edition, extension_home=None):
    # Build into temporary storage, then use the same verified standalone
    # installer shipped to users. No persistent build output is needed.
    with tempfile.TemporaryDirectory(prefix="reach-frontend-install-") as temporary:
        package, _archive = build(root, edition, temporary)
        installer = runpy.run_path(str(package / "install.py"))
        home = installer["extension_home"](extension_home)
        return installer["install"](package, home)


def export_source(root, edition, out):
    root = Path(root)
    plugin, _manifest, _assets = edition_assets(root, edition)
    sources = (["src/public/plugin.json", "src/public/reach-public.js", "src/public/reach-public.css"]
               if edition == "public" else
               ["src/plugin.json", "src/manifest.template.js"]
               + ["src/" + name for name in ADMIN_SCRIPTS + ADMIN_STYLES if name != "manifest.js"])
    if edition == "public":
        sources += ["LICENSE"]
    else:
        sources += ["tools/extension_editions.py", "LICENSE", "tests/test_extension_editions.py"]
        # Tracked runtime sources only. This never walks runtime/config data,
        # unrelated product trees, probes, Git history, or user credentials.
        result = subprocess.run(["git", "ls-files", "-z", "--", "server/reachd.py",
            "server/reachd/*.py", "server/browser-engine/main.cjs", "tools/reach.py",
            "tools/reach/*.py", "tools/endpoint-client.cjs", "tests/test_reachd*.py",
            "tests/test_hostid.py", "tests/__init__.py"], cwd=str(root), check=True,
            capture_output=True)
        sources += result.stdout.decode("utf-8").strip("\0").split("\0") if result.stdout else []
    files = {relative: checked_source(root, relative) for relative in sources}
    guide = "docs/EXTENSION_EDITIONS.md"
    if edition == "admin" and (root / guide).is_file():
        files[guide] = checked_source(root, guide)
    frontend_test = "tests/public_extension.test.cjs" if edition == "public" else "tests/settings_model_dropdowns.test.cjs"
    if (root / frontend_test).is_file():
        files[frontend_test] = checked_source(root, frontend_test)
    build_command = ("python tools/build.py --out dist" if edition == "public" else
                     "python tools/extension_editions.py build --edition admin --out dist/extension-editions")
    built_folder = ("dist/" if edition == "public" else "dist/extension-editions/") + plugin["id"] + "-" + plugin["version"]
    test_command = ("python -m unittest tests.test_public_package -v" if edition == "public" else
                    "python -m unittest tests.test_extension_editions tests.test_reachd tests.test_reachd_access -v")
    if edition == "public":
        files.update({"tools/build.py": PUBLIC_BUILD.encode("utf-8"),
                      "tools/install.py": installer_source("public"),
                      "tests/test_public_package.py": PUBLIC_PACKAGE_TEST.encode("utf-8"),
                      "tests/__init__.py": b"",
                      ".gitignore": b"dist/\n__pycache__/\n*.py[cod]\nnode_modules/\n.env\n.env.*\n"})
    else:
        files[".gitignore"] = b"dist/\n__pycache__/\n*.py[cod]\nnode_modules/\n.env\n.env.*\nconfig.json\n*.sqlite*\n*.log\n"
    files["README.md"] = ("# " + plugin["name"] + " source\n\n"
        "This is an allowlisted source snapshot with no Git history or local user data.\n\n"
        "Build this edition from the snapshot root:\n\n```text\n" + build_command + "\n```\n\n"
        "Install the built frontend from its package folder:\n\n```text\ncd " + built_folder + "\npython install.py\n```\n\n"
        "Reload SimpleRAG's Advanced page after installation.\n\n"
        "Validate from this source snapshot's root without touching a live installation:\n\n```text\n"
        + test_command + "\n```\n\n"
        + ("Frontend behavior tests:\n\n```text\nnode --test " + frontend_test + "\n```\n\n" if frontend_test in files else "")
        + ("Admin runtime sources are included for private maintenance. `tools/reach.py install-runtime` is "
           "the explicit legacy full runtime installer and requires the full operator checkout plus its optional "
           "tray/Electron dependencies for browser features. This maintenance snapshot is not a self-contained full "
           "runtime installer. Use the built package's `install.py` to install only REACH Admin's page against an "
           "existing owner runtime. No installed config, credentials, browser profile, wallet, billing, Studio, VS Code "
           "extension, or Supabase files are included. See `docs/EXTENSION_EDITIONS.md` for the edition boundaries.\n"
           if edition == "admin" else
           "The public edition uses only the user's own explicitly configured provider or local model. It contains no "
           "owner endpoint or operator runtime. SimpleRAG loads this extension as trusted code in its page context; "
           "install only trusted extension code. Provider requests may charge your own account under your provider's terms.\n"
           )).encode("utf-8")
    return write_new_tree(out, plugin["id"] + "-source-" + plugin["version"], files)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("build", "export"):
        action = sub.add_parser(command)
        action.add_argument("--edition", choices=("public", "admin", "all"), default="public")
        action.add_argument("--out", type=Path, default=ROOT / "dist" / "extension-editions")
    install = sub.add_parser("install", help="Install a frontend edition; public is the default")
    install.add_argument("--edition", choices=("public", "admin"), default="public")
    install.add_argument("--extension-home", default=None)
    args = parser.parse_args(argv)
    try:
        if args.command == "install":
            destination = install_edition(ROOT, args.edition, args.extension_home)
            print("Installed frontend package: " + str(destination))
            print("Reload SimpleRAG's Advanced page to show this edition.")
            return
        editions = ("public", "admin") if args.edition == "all" else (args.edition,)
        for edition in editions:
            operation = build if args.command == "build" else export_source
            destination, archive = operation(ROOT, edition, args.out)
            print(str(destination))
            print(str(archive))
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(1, "error: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
