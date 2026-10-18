"""Verify IDE dispatch with isolated CLI stubs; never install real extensions."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('components.ps1')


@unittest.skipUnless(os.name == 'nt', 'Windows installer')
class IDEInstall(unittest.TestCase):
    def test_each_ide_install_launch_and_failure(self):
        with tempfile.TemporaryDirectory(prefix='reach-ide-test-') as temporary:
            root = Path(temporary)
            env = dict(os.environ, LOCALAPPDATA=str(root), ProgramFiles=str(root),
                       IDE_TEST_LOG=str(root / 'calls.txt'))
            for ide, folder, command in [('VSCode', 'Microsoft VS Code', 'code'),
                                         ('Antigravity', 'Antigravity', 'antigravity'),
                                         ('Cursor', 'cursor', 'cursor')]:
                cli = root / 'Programs' / folder / 'bin' / (command + '.cmd')
                cli.parent.mkdir(parents=True)
                cli.write_text('@echo off\necho ' + ide + ' %*>>"%IDE_TEST_LOG%"\nexit /b 0\n')
                for action, expected in [('InstallCode', '--install-extension'), ('LaunchCode', '--new-window')]:
                    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive',
                        '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-Action', action,
                        '-IDE', ide, '-Payload', str(root / 'extension with spaces.vsix')],
                        env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    last = (root / 'calls.txt').read_text().splitlines()[-1]
                    self.assertTrue(last.startswith(ide + ' ' + expected), last)
                cli.write_text('@echo off\nexit /b 7\n')
                result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive',
                    '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-Action', 'InstallCode',
                    '-IDE', ide, '-Payload', 'unused.vsix'], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('install failed (7)', result.stderr)


if __name__ == '__main__':
    unittest.main()
