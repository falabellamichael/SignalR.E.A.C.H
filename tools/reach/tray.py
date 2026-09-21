"""Install and launch the SignalREACH tray on macOS, Windows, and Linux."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

BRIDGE_PORT = 21302  # the tray's OpenAI-compatible bridge (127.0.0.1 only)


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


def _resolve_exe(name, fallback=None):
    """Absolute path for an executable name.

    Bare names can fail to spawn from a windowless pythonw process — observed
    as FileNotFoundError for 'powershell' while the identical call works from
    a console python (2026-09-21: it silently killed the tray watchdog's first
    restart attempt). shutil.which sees the same PATH, so resolve first.
    """
    import shutil
    found = shutil.which(name)
    if found:
        return found
    if fallback and Path(fallback).is_file():
        return str(fallback)
    return name


def stop_tray():
    if sys.platform == 'win32':
        ps = ("Get-CimInstance Win32_Process | Where-Object { "
              "($_.Name -in 'electron.exe','node.exe') -and "
              "($_.CommandLine -match 'copilot[\\\\/]tray' -or $_.CommandLine -match 'signalreach-copilot') } "
              "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
        powershell = _resolve_exe(
            'powershell',
            Path(os.environ.get('SystemRoot', r'C:\Windows'))
            / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe')
        try:
            subprocess.run([powershell, '-NoProfile', '-Command', ps],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass  # the kill is best-effort; the start below must still run
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


def _bridge_alive(timeout=3.0):
    """TCP probe: the bridge is alive when its port accepts a connection."""
    import socket
    try:
        with socket.create_connection(('127.0.0.1', BRIDGE_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def watch_tray(interval=60.0):
    """Stay resident and revive the tray whenever its bridge goes dark.

    The tray is the browser-backed provider gateway (codegpt / chatgpt /
    copilot via 127.0.0.1:21302). If the process dies — for ANY reason; it has
    been seen to vanish with no quit line, no crash dump and no Windows event —
    every one of those models goes silent until someone notices. This loop
    probes the bridge and, after three consecutive misses, restarts the
    installed tray. A busy-but-alive bridge is never killed for a hiccup, and
    repeated restarts back off instead of crash-looping.
    """
    import io
    import time
    from .config import CONFIG_DIR
    directory = tray_dir()
    if not electron_binary(directory).is_file() or not (directory / 'main.js').is_file():
        raise SystemExit('Install the tray first: python tools/reach.py tray install')
    log_path = CONFIG_DIR / 'copilot-tray.log'

    def note(msg):
        line = time.strftime('%H:%M:%S') + ' watchdog: ' + msg
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, 'a', encoding='utf-8') as fh:
                fh.write(line + '\n')
        except OSError:
            pass

    class _LogStream(io.TextIOBase):
        """pythonw has no stdio: forward prints and tracebacks into the log
        so a watchdog failure is never silent again."""
        def __init__(self, prefix):
            self._prefix = prefix
            self._buf = ''

        def write(self, text):
            self._buf += text
            while '\n' in self._buf:
                line, self._buf = self._buf.split('\n', 1)
                if line.strip():
                    note(self._prefix + line.rstrip())
            return len(text)

    if sys.stdout is None:
        sys.stdout = _LogStream('out: ')
    if sys.stderr is None:
        sys.stderr = _LogStream('err: ')

    misses = 0
    restarts = []
    backoff_until = 0.0
    note('armed (probe every %ds; restarts after 3 misses)' % int(interval))
    while True:
        time.sleep(interval)
        if _bridge_alive():
            misses = 0
            continue
        misses += 1
        note('bridge not answering (%d/3)' % min(misses, 3))
        if misses < 3:
            continue
        misses = 0
        now = time.time()
        restarts = [t for t in restarts if now - t < 600]
        if now < backoff_until:
            continue
        if len(restarts) >= 3:
            backoff_until = now + 600
            note('3 restarts in 10 minutes — pausing 10 minutes (see the tray log)')
            continue
        restarts.append(now)
        note('bridge dark for ~%ds — restarting the tray' % int(3 * interval))
        try:
            start_tray()
            note('tray relaunched; bridge %s'
                 % ('answering' if _bridge_alive(10.0) else 'still not answering'))
        except SystemExit as exc:
            note('restart failed: ' + str(exc))
        except Exception as exc:  # a watchdog must never die silently
            note('restart failed: ' + repr(exc))


def cmd_tray(args):
    if args.tray_cmd == 'install':
        from . import REPO_ROOT
        install_tray(REPO_ROOT)
    elif args.tray_cmd == 'watch':
        watch_tray()
    else:
        start_tray()
