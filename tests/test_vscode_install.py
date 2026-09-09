"""VS Code side-loading copies complete runtimes without replacing user state."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach import vscode


class VscodeInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.extensions = self.root / "extensions"
        self.source = self.repo / "vscode"
        self.write_manifest(self.source, "1.2.0")
        (self.source / "extension.js").write_text("require('./ide-context')", encoding="utf-8")
        self.patch_stack = contextlib.ExitStack()
        self.addCleanup(self.patch_stack.close)
        self.patch_stack.enter_context(patch.object(
            vscode, "vscode_extensions_dir", return_value=self.extensions))
        self.configure = self.patch_stack.enter_context(patch.object(vscode, "configure_defaults"))
        self.playwright = self.patch_stack.enter_context(patch.object(vscode, "_install_playwright"))
        self.patch_stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    @staticmethod
    def write_manifest(path, version, publisher="simplereach", name="simplereach"):
        path.mkdir(parents=True, exist_ok=True)
        (path / "package.json").write_text(json.dumps({
            "publisher": publisher, "name": name, "version": version,
            "main": "./extension.js",
        }), encoding="utf-8")

    def make_installed(self, version):
        path = self.extensions / ("simplereach.simplereach-" + version)
        self.write_manifest(path, version)
        (path / "extension.js").write_text("old runtime", encoding="utf-8")
        return path

    def test_install_uses_source_identity_and_copies_every_root_runtime_module(self):
        self.write_manifest(self.source, "2.4.3", publisher="local-team", name="reach-agent")
        for module in ("search.js", "browser-proxy.js", "git-context.js", "ide-context.js"):
            (self.source / module).write_text("runtime: " + module, encoding="utf-8")
        for filename in ("package-lock.json", "node_modules/ignore.js", "tests/ignore.js", "dist/ignore.js"):
            target = self.source / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("do not copy", encoding="utf-8")
        media = self.source / "media/icons/agent.svg"
        media.parent.mkdir(parents=True)
        media.write_text("icon", encoding="utf-8")

        self.assertTrue(vscode.install(self.repo, quiet=True))
        destination = self.extensions / "local-team.reach-agent-2.4.3"
        for module in self.source.glob("*.js"):
            self.assertEqual((destination / module.name).read_bytes(), module.read_bytes())
        self.assertEqual((destination / "media/icons/agent.svg").read_text(), "icon")
        for filename in ("package-lock.json", "node_modules", "tests", "dist"):
            self.assertFalse((destination / filename).exists())
        self.configure.assert_called_once_with(quiet=True)
        self.playwright.assert_not_called()

    def test_upgrade_preserves_browser_dependencies_settings_and_other_extensions(self):
        previous = self.make_installed("1.1.0")
        dependency = previous / "node_modules/playwright/package.json"
        dependency.parent.mkdir(parents=True)
        dependency.write_text('{"version":"installed"}', encoding="utf-8")
        foreign = self.extensions / "other.publisher-1.0.0"
        foreign.mkdir()
        (foreign / "user-state").write_text("keep", encoding="utf-8")
        malformed = self.extensions / "simplereach.simplereach-unknown"
        malformed.mkdir()

        self.assertTrue(vscode.install(self.repo, quiet=True))
        destination = self.extensions / "simplereach.simplereach-1.2.0"
        self.assertEqual((destination / "node_modules/playwright/package.json").read_text(),
                         '{"version":"installed"}')
        self.assertFalse(previous.exists())
        self.assertTrue(malformed.is_dir())
        self.assertEqual((foreign / "user-state").read_text(), "keep")
        self.configure.assert_not_called()

    def test_same_version_preserves_installed_dependencies_and_settings(self):
        destination = self.make_installed("1.2.0")
        dependency = destination / "node_modules/local-state"
        dependency.parent.mkdir()
        dependency.write_bytes(b"keep installed dependencies")
        self.assertTrue(vscode.install(self.repo, quiet=True))
        self.assertEqual(dependency.read_bytes(), b"keep installed dependencies")
        self.assertEqual((destination / "extension.js").read_bytes(),
                         (self.source / "extension.js").read_bytes())
        self.configure.assert_not_called()

    def test_newer_install_is_never_downgraded_or_pruned(self):
        self.write_manifest(self.source, "1.0.0")
        previous = self.make_installed("1.1.0")
        self.assertFalse(vscode.install(self.repo, quiet=True, with_playwright=True))
        self.assertEqual((previous / "extension.js").read_text(), "old runtime")
        self.assertFalse((self.extensions / "simplereach.simplereach-1.0.0").exists())
        self.configure.assert_not_called()
        self.playwright.assert_not_called()

    def test_invalid_source_identity_fails_before_creating_destination(self):
        for field, value in (("publisher", "../outside"), ("name", "a/b"),
                             ("version", "../outside"), ("version", "1.0.0-01")):
            with self.subTest(field=field):
                manifest = {"publisher": "simplereach", "name": "simplereach", "version": "1.2.0"}
                manifest[field] = value
                (self.source / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
                self.assertFalse(vscode.install(self.repo, quiet=True))
                self.assertFalse(self.extensions.exists())
        self.configure.assert_not_called()

    def test_copy_failure_keeps_previous_version(self):
        previous = self.make_installed("1.1.0")
        with patch.object(vscode.shutil, "copy2", side_effect=OSError("copy failed")):
            self.assertFalse(vscode.install(self.repo, quiet=True))
        self.assertEqual((previous / "extension.js").read_text(), "old runtime")
        self.configure.assert_not_called()

    def test_stable_version_is_newer_than_its_prerelease(self):
        self.write_manifest(self.source, "1.2.0-rc.2")
        self.make_installed("1.2.0")
        self.assertFalse(vscode.install(self.repo, quiet=True))
        self.assertLess(vscode._version_key("1.2.0-rc.2"), vscode._version_key("1.2.0-rc.10"))
        self.assertEqual(vscode._version_key("1.2.0+build"), vscode._version_key("1.2.0"))

    def test_optional_browser_install_targets_manifest_version(self):
        self.assertTrue(vscode.install(self.repo, quiet=True, with_playwright=True))
        self.playwright.assert_called_once_with(self.extensions / "simplereach.simplereach-1.2.0")


if __name__ == "__main__":
    unittest.main()
