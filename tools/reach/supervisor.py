"""Loopback control and watchdog for the installed REACH relay and tunnel."""

import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from pathlib import Path

from .config import CONFIG_DIR, CONFIG_PATH, LOG_PATH, runtime_port
from .publish import publish
from .runtime import (
    no_window_kwargs,
    port_open,
    public_url_from_server,
    resolve_pythonw,
    start_server,
)
from .tunnel import start_tunnel

CONTROL_PORT = 20778
ACCOUNT_PORT = 20978
ACCOUNT_LOG_PATH = CONFIG_DIR / "accounts" / "service.log"
_lock = threading.Lock()
_last_published_url = None
_last_publish_attempt = 0.0
_server = None
_cli_module = None


def _load_cli(override=None):
    """Load the installed ``reach.cli`` module.

    Imported lazily because ``reach.cli`` imports this module for `start`/`stop`
    — a module-level import here would be circular. The supervisor is spawned
    from the INSTALLED tree, so run under the installed interpreter and import
    the installed CLI; that keeps root and installed invocations identical.
    ``override`` is a test seam.
    """
    global _cli_module
    if override is not None:
        return override
    if _cli_module is not None:
        return _cli_module
    import importlib.util
    import sys

    # Resolve the INSTALLED tools directory directly. It must not go through
    # _runtime_dir(): that asks the CLI for its config, and the CLI is what we
    # are importing here (mutual recursion, which hangs the interpreter).
    tools_dir = CONFIG_DIR / "tools"
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    try:
        import reach.cli as cli
    except ImportError:
        spec = importlib.util.spec_from_file_location("reach_cli_cli", tools_dir / "reach.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
    _cli_module = cli
    return cli


def ensure_supervisor_running():
    """Start the local control/watchdog server when it is not already up.

    ``reach.py start`` must leave the one-click Start control usable: without
    this, a stopped supervisor leaves port 20778 closed and the panel's button
    fails with a generic network error (or, before the origin fix, a bare 403).
    Returns True when a new supervisor was spawned.
    """
    if port_open(CONTROL_PORT):
        return False
    script = CONFIG_DIR / "tools" / "reach.py"
    if not script.is_file():
        return False
    with open(LOG_PATH, "ab") as log:
        subprocess.Popen(
            [resolve_pythonw(), str(script), "supervise"],
            cwd=str(CONFIG_DIR), stdout=log, stderr=subprocess.STDOUT,
            **no_window_kwargs())
    return True


def stop_supervisor():
    """Ask the supervisor to exit. CLI-only by design.

    Kill-requested via the control port rather than a pid file, so it works no
    matter how the supervisor was launched (CLI, or the logon batch). The relay
    would otherwise be revived by the watchdog within 20s of `reach.py stop`.
    Returns True when a supervisor was running.
    """
    import urllib.error
    import urllib.request

    if not port_open(CONTROL_PORT):
        return False
    req = urllib.request.Request(
        "http://127.0.0.1:%d/shutdown" % CONTROL_PORT, method="POST")
    req.add_header("X-Reach-Action", "shutdown")
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except (urllib.error.URLError, OSError):
        return False
    for _ in range(40):
        if not port_open(CONTROL_PORT):
            break
        time.sleep(0.25)
    return True


def _runtime_dir():
    """The directory holding the installed runtime."""
    return CONFIG_PATH.parent


def _host_plugin_path():
    """The RCH checkout able to run the account service, if this relay owns one.

    Read from the config FILE rather than through reach.cli: importing the CLI
    from here would be mutual recursion (the CLI imports this module for
    start/stop).
    """
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    path = config.get("host_plugin_path", "")
    if not path:
        return None
    candidate = Path(path)
    return candidate if (candidate / "RCH" / "scripts" / "accounts-host.mjs").is_file() else None


# The account service carries customer entitlements, so WHICH config it loads
# decides which database answers. A host that provisions one keeps its own
# scheduled task for it; this module only adopts that task, so it can never
# start a service over a different (empty) database and silently zero an
# account's allowance.
ACCOUNTS_TASK = "REACH Accounts"


def accounts_dir():
    """Where a self-provisioned account service keeps its config and key."""
    return CONFIG_DIR / "accounts"


def accounts_ready():
    """True when the account service has a private config AND upstream key."""
    base = accounts_dir()
    return (base / "accounts.json").is_file() and (base / "upstream.key").is_file()


def accounts_task_present():
    try:
        result = subprocess.run(
            ["schtasks", "/Query", "/TN", ACCOUNTS_TASK],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            **no_window_kwargs())
    except OSError:
        return False
    return result.returncode == 0


def _start_accounts_task():
    result = subprocess.run(
        ["schtasks", "/Run", "/TN", ACCOUNTS_TASK],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        **no_window_kwargs())
    return result.returncode == 0


def ensure_accounts_running():
    """Bring the hosted account service up when it is provisioned but not up.

    Without this the relay answers 503 ``accounts_unavailable`` for every wallet
    route: the proxy is healthy but its loopback target is not listening.

    Only a service the host itself provisioned is started. This never invents a
    configuration: an unprovisioned host is a silent no-op, and a host that
    runs its own task is adopted so its entitlements database stays the one
    that answers.
    """
    if port_open(ACCOUNT_PORT):
        return "running"
    if accounts_task_present():
        return "started" if _start_accounts_task() else "task_failed"
    host = _host_plugin_path()
    if host is None:
        return "unconfigured"
    if not accounts_ready():
        # A plugin checkout alone is not authorization: the operator's private
        # config and dedicated upstream key are what decide the database.
        return "unconfigured"
    base = accounts_dir()
    with open(ACCOUNT_LOG_PATH, "ab") as log:
        subprocess.Popen(
            [resolve_node(), str(host / "RCH" / "scripts" / "accounts-host.mjs"),
             str(base / "accounts.json"), str(base / "upstream.key")],
            cwd=str(host / "RCH"), stdout=log, stderr=subprocess.STDOUT,
            **no_window_kwargs())
    return "started"


def _bring_up(restart_relay):
    """Start the relay/tunnel so a public URL exists; publish when warranted.

    ``restart_relay`` stops a healthy relay first, which is what the panel's
    Restart button means: reload the relay so it picks up changed settings.
    """
    global _last_published_url, _last_publish_attempt
    port = runtime_port()
    if restart_relay and port_open(port):
        _load_cli().stop_server()
        time.sleep(1)
    if not port_open(port) and not start_server():
        return {"ok": False, "error": "Relay did not start; check reach.log"}
    url = public_url_from_server(port)
    if not url:
        if not start_tunnel("ngrok", port):
            return {"ok": False, "error": "Tunnel did not start; check tunnel.log"}
        url = public_url_from_server(port)
    if not url:
        return {"ok": False, "error": "Tunnel has no public URL"}
    # Publish only when the URL changed AND the cooldown elapsed. Tell the
    # caller when the pointer was skipped: the button stays "one click" and
    # the panel can say the public pointer is stale instead of hiding it.
    publish_state = "skipped"
    if url != _last_published_url:
        if time.monotonic() - _last_publish_attempt >= 300:
            _last_publish_attempt = time.monotonic()
            if publish(quiet=True):
                _last_published_url = url
                publish_state = "published"
            else:
                publish_state = "failed"
    return {"ok": True, "public_url": url,
            "local_url": "http://127.0.0.1:%d/v1" % port,
            "published": publish_state}


def ensure_endpoint():
    """Start only the missing components; leave a healthy relay untouched."""
    with _lock:
        return _bring_up(restart_relay=False)


def restart_endpoint():
    """Reload the relay (and restore the tunnel) so settings apply."""
    with _lock:
        return _bring_up(restart_relay=True)


def _allowed_origin(origin):
    """Accept the panel's own renderer origins plus local CLI callers.

    The REACH page is served from an app-owned origin (http://127.0.0.1 / localhost)
    or runs as an opaque document: a file:// page and a VS Code webview both send
    ``Origin: null``, and ``Origin: vscode-webview://...`` shows up in the
    built-in browser. Rejecting those made the panel's one-click "Start
    Endpoint" fail CORS preflight with a bare 403, which is the bug this guard
    used to cause. Anything else (a real site, the public tunnel host) is still
    refused, so the loopback control port is never reachable from the web.
    """
    if not origin:
        return True  # local CLI callers
    if origin == "null":
        return True  # file:// page or sandboxed webview (opaque origin)
    parsed = urlsplit(origin)
    if parsed.scheme == "vscode-webview":
        return True
    return (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
            and parsed.port is not None and not parsed.username and not parsed.password)


class ControlHandler(BaseHTTPRequestHandler):
    def _reply(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin", "")
        if origin and _allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Reach-Action")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not _allowed_origin(self.headers.get("Origin", "")):
            self._reply(403, {"ok": False})
        else:
            self._reply(200, {"ok": True})

    def do_GET(self):
        if self.path != "/status" or not _allowed_origin(self.headers.get("Origin", "")):
            self._reply(404, {"ok": False})
            return
        port = runtime_port()
        url = public_url_from_server(port) if port_open(port) else None
        self._reply(200, {"ok": bool(url), "relay": port_open(port), "public_url": url})

    def do_POST(self):
        if self.path == "/restart":
            self._restart()
            return
        if self.path == "/shutdown":
            # CLI-only: a browser always attaches an Origin, and a web page must
            # never be able to stop the host's relay.
            if self.headers.get("Origin") or self.headers.get("X-Reach-Action") != "shutdown":
                self._reply(403, {"ok": False, "error": "Shutdown request not allowed"})
                return
            self._reply(200, {"ok": True})
            threading.Thread(target=_stop_serving, daemon=True).start()
            return
        if (self.path != "/start" or self.headers.get("X-Reach-Action") != "start"
                or not _allowed_origin(self.headers.get("Origin", ""))):
            # Distinguish a refused origin from a malformed call: the panel's
            # one-click button used to fail here with no way to tell why.
            if self.path == "/start" and not _allowed_origin(self.headers.get("Origin", "")):
                self._reply(403, {"ok": False, "error":
                                  "This page's origin is not allowed to start the "
                                  "endpoint. Run `reach.py start` from a terminal."})
                return
            self._reply(403, {"ok": False, "error": "Start request not allowed"})
            return
        result = ensure_endpoint()
        self._reply(200 if result["ok"] else 503, result)

    def _restart(self):
        """Reload the relay so changed settings apply.

        The Status panel's Restart button used to POST /_reach/restart to the
        RELAY, which has no such route (404) — the button did nothing. Relay
        lifecycle belongs to the process manager, so it is served here.
        """
        origin = self.headers.get("Origin", "")
        if self.headers.get("X-Reach-Action") != "restart" or not _allowed_origin(origin):
            self._reply(403, {"ok": False, "error": "Restart request not allowed"})
            return
        result = restart_endpoint()
        self._reply(200 if result["ok"] else 503, result)

    def log_message(self, format_string, *args):
        pass


def _stop_serving():
    time.sleep(0.1)  # let the reply flush before the socket closes
    if _server is not None:
        _server.shutdown()


def resolve_node():
    """A Node 22.13+ with built-in sqlite; the account service needs it."""
    import shutil

    for name in ("node", "node.exe"):
        found = shutil.which(name)
        if found:
            return found
    # Next to the Python interpreter, then the usual Windows install.
    beside = Path(resolve_pythonw()).with_name("node.exe")
    if beside.is_file():
        return str(beside)
    for candidate in (Path("C:/Program Files/nodejs/node.exe"),
                      Path.home() / "AppData/Local/Programs/nodejs/node.exe"):
        if candidate.is_file():
            return str(candidate)
    return "node"


def run():
    global _server

    def watch():
        while True:
            try:
                ensure_endpoint()
                ensure_accounts_running()
            except Exception as exc:
                print("supervisor: %s" % exc, flush=True)
            time.sleep(20)

    threading.Thread(target=watch, daemon=True).start()
    _server = ThreadingHTTPServer(("127.0.0.1", CONTROL_PORT), ControlHandler)
    try:
        _server.serve_forever()
    finally:
        _server.server_close()
        _server = None
