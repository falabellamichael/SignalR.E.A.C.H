"""Edition packaging/install boundary tests; all writes use temporary folders."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import extension_editions as editions  # noqa: E402


class EditionPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        public = self.source / "src" / "public"
        public.mkdir(parents=True)
        (public / "plugin.json").write_text(json.dumps({
            "schemaVersion": 1, "id": "signal-reach-public", "name": "SignalREACH",
            "version": "26.9.9", "edition": "public", "permissions": [],
            "frontend": {"entrypoint": "reach-public.js", "capabilities": ["workspace.page-controller.v1"]},
            "contributes": {"pages": [{"id": "signal-reach-public.reach-page", "title": "SignalREACH"}]},
        }), encoding="utf-8")
        (public / "reach-public.js").write_text("window.__signalReachPublic = Object.freeze({});\n", encoding="utf-8")
        (public / "reach-public.css").write_text(".signal-reach-public { color: inherit; }\n", encoding="utf-8")
        admin = {"id": "signal-reach", "name": "Legacy", "version": "26.9.9",
                 "contributes": {"pages": [{"id": "signal-reach.reach-page", "title": "REACH"}]}}
        (self.source / "src/plugin.json").write_text(json.dumps(admin), encoding="utf-8")
        (self.source / "src/manifest.template.js").write_text("__REACH_MANIFEST_JSON__", encoding="utf-8")
        for name in editions.ADMIN_SCRIPTS + editions.ADMIN_STYLES:
            if name == "manifest.js":
                continue
            text = "/* fixture */\n"
            if name == "reach.js":
                text += "const PLUGIN_ID = 'signal-reach'; const PAGE_ID = 'signal-reach.reach-page'; const APP_ID = 'reach';\nwindow.__reachCore; window.__reachPages; window.signalReach; window.simpleReach;\n"
            if name == "reach-core.js":
                text += "const PREFS_PREFIX = 'signal-reach.ui.'; const LEGACY_PREFS_PREFIX = 'simple-reach.ui.';\n"
            (self.source / "src" / name).write_text(text, encoding="utf-8")
        tool = self.source / "tools/extension_editions.py"
        tool.parent.mkdir()
        tool.write_bytes((ROOT / "tools/extension_editions.py").read_bytes())
        (self.source / "LICENSE").write_text("Fixture license\n", encoding="utf-8")
        self.out = self.base / "output"

    def package(self, edition="public"):
        package, _archive = editions.build(self.source, edition, self.out)
        spec = importlib.util.spec_from_file_location("edition_install_fixture", package / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        return package, installer

    def test_public_package_is_exact_frontend_allowlist_with_integrity_hashes(self):
        package, archive = editions.build(self.source, "public", self.out)
        self.assertEqual(set(path.name for path in package.iterdir()), {
            "manifest.js", "reach-public.js", "reach-public.css", "manifest.json",
            "plugin.json", "install.py", "README.md",
        })
        manifest = json.loads((package / "manifest.json").read_bytes())
        self.assertEqual(manifest["id"], "signal-reach-public")
        for item in manifest["scripts"] + manifest["styles"]:
            data = (package / item["path"]).read_bytes()
            self.assertEqual(item["sha256"], editions.digest(data))
            self.assertEqual(item["size"], len(data))
        with zipfile.ZipFile(archive) as handle:
            self.assertEqual(len(handle.namelist()), 7)

    def test_admin_generated_identity_globals_and_preferences_are_separate(self):
        package, _archive = editions.build(self.source, "admin", self.out)
        plugin = json.loads((package / "plugin.json").read_bytes())
        self.assertEqual(plugin["id"], "signal-reach-admin")
        self.assertEqual(plugin["version"], "26.9.9")
        self.assertEqual(plugin["contributes"]["pages"][0]["id"], "signal-reach-admin.reach-page")
        text = (package / "reach.js").read_text(encoding="utf-8")
        self.assertIn("const APP_ID = 'reach-admin'", text)
        self.assertIn("window.__reachAdminCore", text)
        self.assertIn("window.signalReachAdmin", text)
        core = (package / "reach-core.js").read_text(encoding="utf-8")
        self.assertIn("'signal-reach-admin.ui.'", core)
        self.assertNotIn("'simple-reach.ui.'", core)
        self.assertIn("const APP_ID = 'reach';", (self.source / "src/reach.js").read_text())

    def test_coinstall_preserves_other_registry_entries_and_package_versions(self):
        home = self.base / "extensions"
        home.mkdir()
        original = {"schema_version": 1, "extra": "preserve", "extensions": [
            {"id": "peer", "custom": True}, {"id": "signal-reach", "version": "old"}]}
        (home / "registry.json").write_text(json.dumps(original), encoding="utf-8")
        public, installer = self.package()
        installer.install(public, home)
        admin, admin_installer = self.package("admin")
        admin_installer.install(admin, home)
        registry = json.loads((home / "registry.json").read_bytes())
        self.assertEqual(registry["extra"], "preserve")
        self.assertEqual(registry["extensions"][:2], original["extensions"])
        self.assertEqual({item["id"] for item in registry["extensions"]}, {
            "peer", "signal-reach", "signal-reach-public", "signal-reach-admin"})
        installer.install(public, home)
        registry = json.loads((home / "registry.json").read_bytes())
        self.assertEqual(sum(item["id"] == "signal-reach-public" for item in registry["extensions"]), 1)
        self.assertTrue((home / "packages/signal-reach-admin/26.9.9/reach.js").exists())

    def test_corrupt_registry_is_rejected_without_package_or_registry_mutation(self):
        package, installer = self.package()
        home = self.base / "extensions"
        home.mkdir()
        raw = b'{"schema_version":1,"extensions":"broken"}'
        (home / "registry.json").write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "Invalid extension registry"):
            installer.install(package, home)
        self.assertEqual((home / "registry.json").read_bytes(), raw)
        self.assertFalse((home / "packages").exists())
        self.assertFalse((home / ".reach-editions-install.lock").exists())

    def test_tampered_asset_fails_before_any_install_write(self):
        package, installer = self.package()
        (package / "reach-public.js").write_text("changed", encoding="utf-8")
        home = self.base / "extensions"
        with self.assertRaisesRegex(ValueError, "integrity check failed"):
            installer.install(package, home)
        self.assertFalse(home.exists())

    def test_registry_replace_failure_rolls_back_same_version_package(self):
        package, installer = self.package()
        home = self.base / "extensions"
        target = installer.install(package, home)
        raw_registry = (home / "registry.json").read_bytes()
        (target / "reach-public.js").write_bytes(b"old installed bytes")
        with patch.object(installer.os, "replace", side_effect=OSError("simulated write failure")):
            with self.assertRaisesRegex(OSError, "simulated write failure"):
                installer.install(package, home)
        self.assertEqual((target / "reach-public.js").read_bytes(), b"old installed bytes")
        self.assertEqual((home / "registry.json").read_bytes(), raw_registry)
        self.assertFalse((home / ".reach-editions-install.lock").exists())

    def test_source_export_does_not_walk_history_wallet_env_or_runtime(self):
        for relative in (".git/private", ".env", "RCH/wallet.json", "server/reachd.py", "src/unreviewed.js"):
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"unreviewed local data")
        destination, archive = editions.export_source(self.source, "public", self.out)
        expected = {"src/public/plugin.json", "src/public/reach-public.js", "src/public/reach-public.css",
                    "tools/build.py", "tools/install.py", "LICENSE", "README.md", ".gitignore",
                    "tests/test_public_package.py", "tests/__init__.py"}
        self.assertEqual({p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()}, expected)
        with zipfile.ZipFile(archive) as handle:
            self.assertEqual(len(handle.namelist()), len(expected))

    def test_source_snapshot_rebuilds_without_private_sources_or_git(self):
        destination, _archive = editions.export_source(self.source, "public", self.out)
        spec = importlib.util.spec_from_file_location("public_source_builder", destination / "tools/build.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        package, _archive = builder.build(self.base / "rebuilt")
        self.assertTrue((package / "install.py").is_file())
        self.assertFalse((destination / "src/plugin.json").exists())
        self.assertFalse((destination / "tools/extension_editions.py").exists())

    def test_public_owner_pointer_reference_is_rejected(self):
        (self.source / "src/public/reach-public.js").write_text("fetch('http://127.0.0.1:20777');", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Owner runtime reference"):
            editions.build(self.source, "public", self.out)
        self.assertFalse(self.out.exists())

    def test_default_build_is_public_and_does_not_import_runtime_state(self):
        # Discovery imports the legacy runtime installer in other test modules.
        # Verify this command's imports in a fresh process, as a user runs it.
        code = ("import sys; from pathlib import Path; "
                "sys.path.insert(0,sys.argv[1]); import extension_editions as editions; "
                "editions.ROOT=Path(sys.argv[2]); editions.main(['build','--out',sys.argv[3]]); "
                "assert 'reach.config' not in sys.modules; assert 'reach.cli' not in sys.modules")
        result = subprocess.run([sys.executable, "-c", code, str(ROOT / "tools"),
                                 str(self.source), str(self.out)], cwd=str(ROOT),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.out / "signal-reach-public-26.9.9").exists())
        self.assertFalse((self.out / "signal-reach-admin-26.9.9").exists())

    def test_public_launcher_install_does_not_import_or_migrate_operator_runtime(self):
        home = self.base / "launcher-extensions"
        appdata = self.base / "local-appdata"
        legacy = appdata / "SimpleREACH"
        legacy.mkdir(parents=True)
        (legacy / "config.json").write_text('{"synthetic_owner_config":true}', encoding="utf-8")
        code = ("import runpy,sys; "
                "module=runpy.run_path(sys.argv[1]); "
                "from pathlib import Path; import extension_editions; extension_editions.ROOT=Path(sys.argv[3]); "
                "module['main'](['install','--extension-home',sys.argv[2]]); "
                "assert 'reach.config' not in sys.modules; assert 'reach.cli' not in sys.modules")
        result = subprocess.run([sys.executable, "-c", code, str(ROOT / "tools/reach.py"), str(home), str(self.source)],
                                cwd=str(ROOT), env=dict(os.environ, LOCALAPPDATA=str(appdata)),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        registry = json.loads((home / "registry.json").read_bytes())
        self.assertEqual([item["id"] for item in registry["extensions"]], ["signal-reach-public"])
        self.assertFalse((appdata / "SignalREACH").exists())
        self.assertEqual((legacy / "config.json").read_text(), '{"synthetic_owner_config":true}')

    def test_explicit_runtime_install_preserves_legacy_parser_options(self):
        spec = importlib.util.spec_from_file_location("edition_launcher", ROOT / "tools/reach.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        fake_package, fake_cli = ModuleType("reach"), ModuleType("reach.cli")
        captured = []
        fake_cli.main = lambda: captured.append(sys.argv[1:])
        with patch.dict(sys.modules, {"reach": fake_package, "reach.cli": fake_cli}):
            launcher.main(["install-runtime", "--no-start", "--no-publish"])
        self.assertEqual(captured, [["install", "--no-start", "--no-publish"]])

    def test_build_refuses_to_overwrite_reviewed_output(self):
        package, _archive = editions.build(self.source, "public", self.out)
        raw = (package / "manifest.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "Output already exists"):
            editions.build(self.source, "public", self.out)
        self.assertEqual((package / "manifest.json").read_bytes(), raw)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_installer_rejects_package_directory_symlink(self):
        package, installer = self.package()
        home = self.base / "extensions"
        home.mkdir()
        outside = self.base / "outside"
        outside.mkdir()
        try:
            (home / "packages").symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest("Cannot create directory symlink: " + str(exc))
        with self.assertRaisesRegex(ValueError, "linked package directory"):
            installer.install(package, home)
        self.assertEqual(list(outside.iterdir()), [])

    def test_installer_rejects_resolved_package_directory_escape(self):
        package, installer = self.package()
        home = self.base / "extensions"
        home.mkdir()
        packages = home.resolve() / "packages"
        outside = self.base / "outside"
        original = Path.resolve

        def resolved(path, *args, **kwargs):
            return outside if path == packages else original(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolved):
            with self.assertRaisesRegex(ValueError, "linked package directory"):
                installer.install(package, home)
        self.assertFalse(outside.exists())
        self.assertFalse((home / "registry.json").exists())


if __name__ == "__main__":
    unittest.main()
