"""Runtime maintenance must preserve the selected SimpleRAG frontend."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach import cli


class ExtensionReassertTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "extensions"
        self.stash = self.root / "stash"
        self.stash.mkdir()
        self.entry = {"id": "signal-reach", "version": "26.9.12", "enabled": True}
        (self.stash / "entry.json").write_text(json.dumps(self.entry), encoding="utf-8")
        (self.stash / "reach.js").write_bytes(b"legacy frontend")
        (self.stash / "manifest.json").write_bytes(b"{}")
        for name, value in (("extension_home", lambda _override: self.home),
                            ("STASH_DIR", self.stash)):
            patcher = patch.object(cli, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_registry(self, value):
        self.home.mkdir(exist_ok=True)
        (self.home / "registry.json").write_text(json.dumps(value), encoding="utf-8")

    def read_registry(self):
        return json.loads((self.home / "registry.json").read_bytes())

    def reassert(self):
        with contextlib.redirect_stdout(io.StringIO()):
            cli.cmd_reassert(SimpleNamespace())

    def install_runtime(self):
        source, installed = self.root / "source", self.root / "runtime"
        for name in ("server/reachd.py", "server/reachd/__init__.py",
                     "server/browser-engine/main.cjs", "tools/reach.py",
                     "tools/reach/__init__.py"):
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("new " + name, encoding="utf-8")
        config = installed / "config.json"
        config.parent.mkdir(exist_ok=True)
        config.write_bytes(b'{"custom":"keep"}')
        electron = cli.electron_binary(installed / "copilot/tray")
        electron.parent.mkdir(parents=True, exist_ok=True)
        electron.write_bytes(b"existing electron")
        args = SimpleNamespace(extension_only=True, extension_home=None, no_start=True,
                               no_vscode=True, no_publish=True, tunnel="none")
        with contextlib.ExitStack() as stack:
            replacements = {
                "IS_FULL_REPO": True, "REPO_ROOT": source, "CONFIG_DIR": installed,
                "CONFIG_PATH": config, "runtime_port": lambda: 20777,
                "collect_assets": lambda _plugin: [("reach.js", b"frontend")],
                "validate_assets": lambda _assets: None,
                "build_extension_manifest": lambda *_args: b"{}",
                "registry_entry": lambda *_args: self.entry,
            }
            for name, value in replacements.items():
                stack.enter_context(patch.object(cli, name, value))
            manifest = stack.enter_context(patch.object(
                cli, "load_plugin_manifest", return_value={"version": "26.9.12"}))
            stash = stack.enter_context(patch.object(cli, "stash_extension"))
            with contextlib.redirect_stdout(io.StringIO()):
                cli.cmd_install(args)
        self.assertEqual((installed / "server/reachd.py").read_bytes(),
                         (source / "server/reachd.py").read_bytes())
        self.assertEqual((installed / "server/browser-engine/main.cjs").read_bytes(),
                         (source / "server/browser-engine/main.cjs").read_bytes())
        self.assertEqual(config.read_bytes(), b'{"custom":"keep"}')
        self.assertEqual(electron.read_bytes(), b"existing electron")
        return manifest, stash

    def test_explicit_removal_blocks_stash_restore_without_mutating_registry(self):
        self.write_registry({"schema_version": 1, "extensions": [],
                             "uninstalled_extensions": ["signal-reach"]})
        before = (self.home / "registry.json").read_bytes()
        self.reassert()
        self.assertEqual((self.home / "registry.json").read_bytes(), before)
        self.assertFalse((self.home / "packages").exists())
        self.assertEqual((self.stash / "reach.js").read_bytes(), b"legacy frontend")

    def test_registered_admin_blocks_legacy_restore_even_when_disabled(self):
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                self.write_registry({"schema_version": 1, "extensions": [
                    {"id": "signal-reach-admin", "version": "26.9.10", "enabled": enabled}]})
                before = (self.home / "registry.json").read_bytes()
                self.reassert()
                self.assertEqual((self.home / "registry.json").read_bytes(), before)
                self.assertFalse((self.home / "packages").exists())

    def test_unrelated_removal_does_not_block_existing_recovery(self):
        peer = {"id": "peer", "enabled": False, "custom": "keep"}
        self.write_registry({"schema_version": 1, "extensions": [peer],
                             "uninstalled_extensions": ["other"], "custom": "keep"})
        self.reassert()
        registry = self.read_registry()
        self.assertEqual(registry["extensions"], [peer, self.entry])
        self.assertEqual(registry["uninstalled_extensions"], ["other"])
        self.assertEqual(registry["custom"], "keep")
        self.assertEqual((self.home / "packages/signal-reach/26.9.12/reach.js").read_bytes(),
                         b"legacy frontend")

    def test_runtime_install_preserves_removal_and_updates_runtime(self):
        self.write_registry({"schema_version": 1, "extensions": [{"id": "peer"}],
                             "uninstalled_extensions": ["signal-reach", "other"]})
        before = (self.home / "registry.json").read_bytes()
        manifest, stash = self.install_runtime()
        manifest.assert_not_called()
        stash.assert_not_called()
        self.assertEqual((self.home / "registry.json").read_bytes(), before)
        self.assertFalse((self.home / "packages").exists())

    def test_runtime_install_preserves_registered_admin_even_when_disabled(self):
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                self.write_registry({"schema_version": 1, "extensions": [
                    {"id": "signal-reach-admin", "version": "26.9.10", "enabled": enabled},
                    {"id": "peer", "custom": "keep"}], "uninstalled_extensions": ["other"]})
                before = (self.home / "registry.json").read_bytes()
                manifest, stash = self.install_runtime()
                manifest.assert_not_called()
                stash.assert_not_called()
                self.assertEqual((self.home / "registry.json").read_bytes(), before)
                self.assertFalse((self.home / "packages").exists())

    def test_runtime_install_keeps_legacy_behavior_without_removal_or_admin(self):
        self.write_registry({"schema_version": 1, "extensions": [{"id": "peer"}],
                             "uninstalled_extensions": ["other"]})
        manifest, stash = self.install_runtime()
        manifest.assert_called_once_with()
        stash.assert_called_once()
        registry = self.read_registry()
        self.assertEqual(registry["extensions"], [{"id": "peer"}, self.entry])
        self.assertEqual(registry["uninstalled_extensions"], ["other"])
        self.assertEqual((self.home / "packages/signal-reach/26.9.12/reach.js").read_bytes(),
                         b"frontend")


if __name__ == "__main__":
    unittest.main()
