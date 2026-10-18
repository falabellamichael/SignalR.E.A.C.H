"""Exercise the suite public installer without modifying the user's extensions."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('editions', ROOT / 'tools/extension_editions.py')
editions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editions)


class PublicInstall(unittest.TestCase):
    def package(self, root, version):
        source = root / ('source-' + version)
        public = source / 'src/public'
        public.mkdir(parents=True)
        for name in ('plugin.json', 'reach-public.js', 'reach-public.css'):
            shutil.copyfile(ROOT / 'src/public' / name, public / name)
        plugin = json.loads((public / 'plugin.json').read_bytes())
        plugin['version'] = version
        (public / 'plugin.json').write_text(json.dumps(plugin), encoding='utf-8')
        package, _ = editions.build(source, 'public', root / 'build')
        return package

    def install(self, package, home):
        return subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
            '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'installer/windows/components.ps1'),
            '-Action', 'InstallPublic', '-Payload', str(package), '-ExtensionHome', str(home)],
            capture_output=True, text=True)

    def test_install_upgrade_and_reject_corruption(self):
        with tempfile.TemporaryDirectory(prefix='reach-suite-test-') as temporary:
            root = Path(temporary)
            package, _ = editions.build(ROOT, 'public', root / 'build')
            home = root / 'extensions'
            home.mkdir()
            registry = home / 'registry.json'
            other = {'id': 'another-extension', 'enabled': True}
            registry.write_text(json.dumps({'schema_version': 1, 'extensions': [other],
                                           'uninstalled_extensions': ['signal-reach-public', 'another-removed']}))
            command = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                       str(ROOT / 'installer/windows/components.ps1'), '-Action', 'InstallPublic',
                       '-Payload', str(package), '-ExtensionHome', str(home)]
            for _ in range(2):
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                data = json.loads(registry.read_text())
                self.assertEqual(data['extensions'][0], other)
                self.assertEqual(len(data['extensions']), 2)
                self.assertEqual(data['extensions'][1]['id'], 'signal-reach-public')
                self.assertEqual(data['uninstalled_extensions'], ['another-removed'])
            before = registry.read_bytes()
            (package / 'reach-public.js').write_text('tampered')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(registry.read_bytes(), before)
            self.assertFalse((home / 'packages/signal-reach-admin').exists())

    def test_old_suite_cannot_downgrade_a_newer_public_extension(self):
        for installed, incoming in [('26.10.3', '26.10.2'), ('26.10.10', '26.10.3'),
                                    ('26.10.3', '26.10.3-rc.1'),
                                    ('26.10.3-rc.10', '26.10.3-rc.2')]:
            with self.subTest(installed=installed, incoming=incoming), tempfile.TemporaryDirectory(prefix='reach-suite-downgrade-') as temporary:
                root = Path(temporary)
                home = root / 'extensions'
                newer = self.package(root, installed)
                older = self.package(root, incoming)
                result = self.install(newer, home)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                before = {path.relative_to(home): path.read_bytes() for path in home.rglob('*') if path.is_file()}
                result = self.install(older, home)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Kept newer public SimpleRAG extension', result.stdout)
                after = {path.relative_to(home): path.read_bytes() for path in home.rglob('*') if path.is_file()}
                self.assertEqual(after, before)

    def test_upgrade_replaces_only_the_public_entry_and_preserves_private_state(self):
        with tempfile.TemporaryDirectory(prefix='reach-suite-upgrade-') as temporary:
            root = Path(temporary)
            home = root / 'extensions'
            home.mkdir()
            peer = {'id': 'signal-reach-admin', 'version': '26.10.4', 'enabled': True}
            registry = home / 'registry.json'
            registry.write_text(json.dumps({'schema_version': 1, 'extensions': [peer]}))
            private = home / 'private-preferences.json'
            private.write_bytes(b'private state sentinel')
            for version in ('26.10.2', '26.10.3-rc.1', '26.10.3'):
                package = self.package(root, version)
                result = self.install(package, home)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                entries = json.loads(registry.read_bytes())['extensions']
                self.assertEqual(entries[0], peer)
                self.assertEqual(entries[1]['version'], version)
                self.assertEqual(private.read_bytes(), b'private state sentinel')
                target = home / 'packages/signal-reach-public' / version
                for asset in ('manifest.json', 'manifest.js', 'reach-public.js', 'reach-public.css'):
                    self.assertEqual((target / asset).read_bytes(), (package / asset).read_bytes())


if __name__ == '__main__':
    unittest.main()
