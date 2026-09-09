"""Scoped browser upgrades must preserve the existing local installation."""

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach import cli


class BrowserInstallTests(unittest.TestCase):
    def test_extension_upgrade_copies_engine_and_preserves_local_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, installed, extensions = [root / p for p in
                                             ("source", "runtime", "extensions")]
            for name in ("server/reachd.py", "server/reachd/browser_engine.py",
                         "server/browser-engine/main.cjs", "tools/reach.py",
                         "tools/reach/cli.py", "copilot/tray/main.js"):
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("new " + name, encoding="utf-8")
            config = installed / "config.json"
            config.parent.mkdir(parents=True)
            config.write_bytes(b'{"port":20777,"custom":"keep formatting"}\n')
            electron = cli.electron_binary(installed / "copilot/tray")
            electron.parent.mkdir(parents=True)
            electron.write_bytes(b"existing electron")
            tray = installed / "copilot/tray/main.js"
            tray.write_bytes(b"existing tray")
            pkg = extensions / "packages/signal-reach/26.9.1"
            args = SimpleNamespace(extension_only=True, extension_home=None,
                                   no_start=False, restart=True, tunnel="ngrok",
                                   no_publish=False, no_vscode=False)
            with contextlib.ExitStack() as stack:
                replacements = {
                    "IS_FULL_REPO": True, "REPO_ROOT": source,
                    "CONFIG_DIR": installed, "CONFIG_PATH": config,
                    "load_plugin_manifest": lambda: {"version": "26.9.1"},
                    "collect_assets": lambda _: [("browser.js", b"browser")],
                    "validate_assets": lambda _: None,
                    "build_extension_manifest": lambda *_: b"{}",
                    "extension_home": lambda _: extensions,
                    "package_dir": lambda *_: pkg,
                    "registry_entry": lambda *_: {"id": "signal-reach"},
                    "verify_registry_entry": lambda *_: True,
                    "runtime_port": lambda: 20777,
                    "port_open": lambda *_: False,
                }
                for name, value in replacements.items():
                    stack.enter_context(patch.object(cli, name, value))
                mocks = {name: stack.enter_context(patch.object(cli, name))
                         for name in ("upsert_registry", "stash_extension",
                                      "load_config", "save_config", "find_omniroute_key",
                                      "vscode_install", "start_tunnel", "publish",
                                      "start_server", "stop_server")}
                with contextlib.redirect_stdout(io.StringIO()):
                    cli.cmd_install(args)
                self.assertEqual((installed / "server/browser-engine/main.cjs").read_bytes(),
                                 (source / "server/browser-engine/main.cjs").read_bytes())
                self.assertEqual((installed / "server/reachd/browser_engine.py").read_bytes(),
                                 (source / "server/reachd/browser_engine.py").read_bytes())
                self.assertEqual(config.read_bytes(),
                                 b'{"port":20777,"custom":"keep formatting"}\n')
                self.assertEqual(electron.read_bytes(), b"existing electron")
                self.assertEqual(tray.read_bytes(), b"existing tray")
                mocks["start_server"].assert_called_once_with()
                for name in ("load_config", "save_config", "find_omniroute_key",
                             "vscode_install", "start_tunnel", "publish", "stop_server"):
                    mocks[name].assert_not_called()

    def test_missing_installed_engine_fails_before_package_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = root / "server/browser-engine/main.cjs"
            engine.parent.mkdir(parents=True)
            engine.write_text("engine", encoding="utf-8")
            with patch.object(cli, "IS_FULL_REPO", True), \
                    patch.object(cli, "REPO_ROOT", root), \
                    patch.object(cli, "CONFIG_DIR", root / "missing"), \
                    patch.object(cli, "load_plugin_manifest") as manifest, \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(SystemExit, "existing relay"):
                    cli.cmd_install(SimpleNamespace(extension_only=True))
                manifest.assert_not_called()


if __name__ == "__main__":
    unittest.main()
