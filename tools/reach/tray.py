"""Install and launch the SignalREACH tray on macOS, Windows, and Linux."""
import os
import shutil
import subprocess
import sys
from pathlib import Path


def tray_dir(platform=None):
    platform = platform or sys.platform
    if platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    elif platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support'
    else:
        base = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    return base / 'SignalREACH' / 'copilot' / 'tray'


def electron_binary(directory, platform=None):
    platform = platform or sys.platform
    dist = Path(directory) / 'node_modules' / 'electron' / 'dist'
    if platform == 'darwin':
        return dist / 'Electron.app' / 'Contents' / 'MacOS' / 'Electron'
    return dist / ('electron.exe' if platform == 'win32' else 'electron')


def install_tray(repo_root):
    source = Path(repo_root) / 'copilot' / 'tray'
    if not electron_binary(source).is_file():
        raise SystemExit('Install the tray runtime first: cd copilot/tray && npm install')
    destination = tray_dir()
    shutil.copytree(source, destination, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('*.log', 'dist', '__pycache__'))
    print('  SignalREACH tray installed -> ' + str(destination))
    return destination


def start_tray():
    directory = tray_dir()
    binary = electron_binary(directory)
    if not binary.is_file() or not (directory / 'main.js').is_file():
        raise SystemExit('Install the tray first: python tools/reach.py tray install')
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    options = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == 'win32' else {'start_new_session': True}
    subprocess.Popen([str(binary), str(directory)], cwd=directory, env=env,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, **options)
    print('  SignalREACH tray launched (use the menu-bar or system-tray icon).')


def cmd_tray(args):
    if args.tray_cmd == 'install':
        from . import REPO_ROOT
        install_tray(REPO_ROOT)
    else:
        start_tray()
