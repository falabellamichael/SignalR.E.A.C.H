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
    destination.mkdir(parents=True, exist_ok=True)
    # Copy tray source files fast; only copy node_modules if not already installed
    files = ['bridge.js', 'economy-models.js', 'endpoint.js', 'main.js', 'package.json',
             'package-lock.json', 'panel.css', 'panel.html', 'panel.js',
             'preload.js', 'tray-icon.png']
    for fname in files:
        src_file = source / fname
        if src_file.is_file():
            shutil.copy2(src_file, destination / fname)
    if not electron_binary(destination).is_file():
        src_nm = source / 'node_modules'
        dst_nm = destination / 'node_modules'
        if src_nm.is_dir():
            shutil.copytree(src_nm, dst_nm, dirs_exist_ok=True, symlinks=True)
    print('  SignalREACH tray installed -> ' + str(destination))
    _update_packaged_app(source)
    return destination


def _update_packaged_app(source):
    if sys.platform != 'darwin':
        return
    asar_bin = source / 'node_modules' / '@electron' / 'asar' / 'bin' / 'asar.js'
    if not asar_bin.is_file():
        return
    app_targets = [
        Path('/Applications/SignalREACH.app/Contents/Resources/app.asar'),
        Path.home() / 'Applications/SignalREACH.app/Contents/Resources/app.asar'
    ]
    targets = [p for p in app_targets if p.parent.is_dir()]
    if not targets:
        return
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        staging = Path(tmpdir)
        files = ['bridge.js', 'economy-models.js', 'endpoint.js', 'main.js', 'package.json',
                 'panel.css', 'panel.html', 'panel.js', 'preload.js', 'tray-icon.png']
        for fname in files:
            src_file = source / fname
            if src_file.is_file():
                shutil.copy2(src_file, staging / fname)
        for target in targets:
            try:
                subprocess.run(['node', str(asar_bin), 'pack', str(staging), str(target)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print('  Packaged app updated -> ' + str(target))
            except Exception:
                pass


def stop_tray():
    if sys.platform == 'win32':
        ps = ("Get-CimInstance Win32_Process | Where-Object { "
              "($_.Name -in 'electron.exe','node.exe') -and "
              "($_.CommandLine -match 'copilot[\\\\/]tray' -or $_.CommandLine -match 'signalreach-copilot') } "
              "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
        subprocess.run(['powershell', '-NoProfile', '-Command', ps],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    if sys.platform == 'darwin':
        subprocess.run(['pkill', '-f', 'SignalREACH'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['pkill', '-f', 'copilot/tray'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['pkill', '-f', 'signalreach-copilot-tray'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def start_tray():
    stop_tray()
    import time
    time.sleep(0.5)
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
