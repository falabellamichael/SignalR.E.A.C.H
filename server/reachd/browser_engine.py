"""Local-only transport to SignalREACH's isolated interactive Chromium process.

The engine exposes only an authenticated, random-port loopback bridge without a
debugger. Browser tabs are scoped to unguessable, expiring client sessions.
"""

import atexit
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from reachd.browser import BrowserError, _parse_url


MAX_BODY_BYTES = 128 * 1024
MAX_REPLY_BYTES = 12 * 1024 * 1024
SESSION_TTL = 30 * 60
MAX_SESSIONS = 32
MAX_TABS = 8
_TAB = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ACTIONS = {"create", "navigate", "frame", "input", "text", "snapshot", "find",
            "close", "pause", "resume", "back", "forward", "reload", "stop"}


def allowed_origin(origin):
    """No-Origin native clients and literal loopback web origins are allowed.

    In particular, 'null' is not proof of Electron: public sites can manufacture
    it with sandboxed frames, so it must not gain this browser capability.
    """
    if origin is None:
        return True
    try:
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or parts.username is not None or parts.password is not None:
            return False
        if parts.path or parts.query or parts.fragment or not parts.hostname:
            return False
        if parts.port is not None and not 1 <= parts.port <= 65535:
            return False
        return parts.hostname == "localhost" or ipaddress.ip_address(parts.hostname).is_loopback
    except (ValueError, TypeError):
        return False


def _integer(value, name, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise BrowserError("Invalid browser %s." % name, code="invalid_request")
    return value


def _command_body(body):
    action = body.get("action")
    if not isinstance(action, str) or action not in _ACTIONS:
        raise BrowserError("Unsupported browser command.", code="invalid_request")
    tab = body.get("tab")
    if not isinstance(tab, str) or not _TAB.fullmatch(tab):
        raise BrowserError("Invalid browser tab.", code="invalid_request")
    command = {"action": action, "tab": tab}
    if action in ("create", "frame"):
        for name, default, lower, upper in (("width", 1000, 160, 2400), ("height", 700, 120, 1800)):
            command[name] = _integer(body.get(name, default), name, lower, upper)
        if "since" in body:
            command["since"] = _integer(body["since"], "frame sequence", 0, 2 ** 53 - 1)
    if action == "navigate" or (action == "create" and body.get("url")):
        # Chromium owns DNS and navigation. This validation blocks dangerous
        # schemes and credentials without weakening the reader's pinned fetcher.
        _parse_url(body.get("url"))
        command["url"] = body["url"].strip()
    if action in ("text", "find"):
        value = body.get("text", "")
        if not isinstance(value, str) or len(value) > (16384 if action == "text" else 4096):
            raise BrowserError("Browser text is too long.", code="invalid_request")
        command["text"] = value
        if action == "find":
            command["forward"] = body.get("forward", True) is not False
            command["findNext"] = body.get("findNext", False) is True
    if action == "input":
        events = body.get("events", [body["event"]] if "event" in body else None)
        if not isinstance(events, list) or not 1 <= len(events) <= 64:
            raise BrowserError("Send up to 64 browser input events.", code="invalid_request")
        command["events"] = []
        for event in events:
            if not isinstance(event, dict) or not isinstance(event.get("type"), str) or event.get("type") not in {
                    "mouseMove", "mouseDown", "mouseUp", "mouseWheel", "keyDown", "keyUp", "char"}:
                raise BrowserError("Invalid browser input event.", code="invalid_request")
            clean = {"type": event["type"]}
            for field in ("x", "y", "deltaX", "deltaY", "clickCount"):
                if field in event:
                    clean[field] = _integer(event[field], field, -10000, 10000)
            if "button" in event:
                if event["button"] not in ("left", "middle", "right"):
                    raise BrowserError("Invalid mouse button.", code="invalid_request")
                clean["button"] = event["button"]
            if "keyCode" in event:
                if not isinstance(event["keyCode"], str) or len(event["keyCode"]) > 64:
                    raise BrowserError("Invalid key code.", code="invalid_request")
                clean["keyCode"] = event["keyCode"]
            if "modifiers" in event:
                modifiers = event["modifiers"]
                if not isinstance(modifiers, list) or len(modifiers) > 12 or any(
                        not isinstance(item, str) or item not in {"shift", "control", "ctrl", "alt", "meta", "command", "cmd", "super",
                                     "leftButtonDown", "middleButtonDown", "rightButtonDown", "capsLock",
                                     "numLock", "isAutoRepeat", "left", "right"} for item in modifiers):
                    raise BrowserError("Invalid key modifiers.", code="invalid_request")
                clean["modifiers"] = modifiers
            command["events"].append(clean)
    return command


class BrowserEngine:
    def __init__(self, root=None):
        self.root = Path(root or Path(__file__).resolve().parents[2])
        self._lock = threading.RLock()
        self._start_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(16)
        self._process = None
        self._bridge = None
        self._sessions = {}
        self._diagnostic = ""

    def _ensure_process(self):
        with self._start_lock:
            if self._process is not None and self._process.poll() is None:
                return self._process
            if self._process is not None:
                self._fail_process(self._process)
            suffix = Path("copilot/tray/node_modules/electron/dist/electron.exe")
            installed = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) / "SignalREACH" / suffix
            executable = installed if installed.is_file() else self.root / suffix
            engine = self.root / "server" / "browser-engine" / "main.cjs"
            if not executable.is_file() or not engine.is_file():
                raise BrowserError("The interactive browser runtime is missing. Reinstall SignalREACH.",
                                   503, "engine_missing")
            profile = self.root / "browser-profile"
            profile.mkdir(exist_ok=True)
            environment = os.environ.copy()
            environment.pop("ELECTRON_RUN_AS_NODE", None)
            environment.pop("NODE_OPTIONS", None)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            secret = secrets.token_urlsafe(48)
            environment.update(REACH_BROWSER_PORT=str(port), REACH_BROWSER_SECRET=secret,
                               REACH_BROWSER_PARENT_PID=str(os.getpid()))
            startup = subprocess.STARTUPINFO() if os.name == "nt" else None
            if startup is not None:
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = subprocess.SW_HIDE
            try:
                process = subprocess.Popen(
                    [str(executable), str(engine), "--profile=" + str(profile.resolve())],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    cwd=str(self.root), env=environment, startupinfo=startup,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            except OSError:
                raise BrowserError("The interactive browser could not start. Reinstall SignalREACH.",
                                   503, "engine_unavailable") from None
            self._process = process
            self._bridge = (port, secret)
            self._diagnostic = ""
            threading.Thread(target=self._read_diagnostics, args=(process,), daemon=True,
                             name="reach-browser-diagnostics").start()
            threading.Thread(target=self._watch_process, args=(process,), daemon=True,
                             name="reach-browser-process").start()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    status = self._http_request((port, secret), "GET", "/status", timeout=1)
                    if isinstance(status, dict) and status.get("ready") is True:
                        return process
                except (OSError, ValueError, http.client.HTTPException, BrowserError):
                    pass
                time.sleep(0.1)
            self._fail_process(process)
            raise BrowserError(self._stopped_message("could not start"), 503, "engine_unavailable")

    def _watch_process(self, process):
        process.wait()
        self._fail_process(process)

    def _stopped_message(self, state="stopped"):
        detail = " (%s)" % self._diagnostic if self._diagnostic else ""
        return "The browser engine %s%s. Reload this browser tab." % (state, detail)

    def _http_request(self, bridge, method, path, payload=None, timeout=20):
        port, secret = bridge
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        try:
            headers = {"Authorization": "Bearer " + secret, "Content-Type": "application/json"}
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                raise BrowserError("The browser engine rejected its local connection.", 503, "engine_unavailable")
            raw = response.read(MAX_REPLY_BYTES + 1)
            if len(raw) > MAX_REPLY_BYTES:
                raise BrowserError("The browser engine response is too large.", 502, "engine_protocol_error")
            return json.loads(raw)
        finally:
            connection.close()

    def _read_diagnostics(self, process):
        """Keep only fixed error categories and our source line numbers.

        Chromium diagnostics can contain site URLs and other page data. Never
        store or return raw stderr, even when diagnosing an engine startup.
        """
        try:
            while True:
                line = process.stderr.readline(4097)
                if not line:
                    break
                text = line.decode("utf-8", "replace")
                category = re.search(r"\b(SyntaxError|TypeError|ReferenceError|RangeError)\b", text)
                location = re.search(r"\bmain\.cjs:(\d+)(?::(\d+))?\b", text)
                reason = ""
                if "Cannot find module" in text or "Unable to find Electron app" in text:
                    reason = "a browser runtime module is missing"
                elif category:
                    reason = category.group(1)
                if location:
                    reason = (reason + " at " if reason else "main.cjs at ") + location.group(0)
                if reason:
                    with self._lock:
                        if self._process is process:
                            self._diagnostic = reason[:160]
        except (OSError, ValueError):
            pass
        finally:
            process.stderr.close()

    def _fail_process(self, process):
        with self._lock:
            if self._process is not process:
                return
            self._process = None
            self._bridge = None
            self._sessions.clear()
        if process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass

    def _command(self, command):
        if not self._slots.acquire(blocking=False):
            raise BrowserError("The browser is busy. Try again shortly.", 429, "engine_busy")
        try:
            identifier = secrets.token_hex(16)
            with self._lock:
                process = self._process
                bridge = self._bridge
                if process is None or process.poll() is not None or bridge is None:
                    if process is not None:
                        self._fail_process(process)
                    raise BrowserError(self._stopped_message(), 503, "engine_restarted")
            # Bound the entire command, including a non-responsive engine.
            watchdog = threading.Timer(20, self._fail_process, args=(process,))
            watchdog.daemon = True
            watchdog.start()
            try:
                message = self._http_request(bridge, "POST", "/command", {**command, "id": identifier})
                if not isinstance(message, dict) or message.get("id") != identifier:
                    raise BrowserError("Invalid browser engine response.", 502, "engine_protocol_error")
                if "error" in message:
                    error = message["error"]
                    if isinstance(error, dict):
                        error = error.get("message", "The browser command failed.")
                    raise BrowserError(str(error)[:1000], 502, "engine_command_failed")
                return message.get("result", {})
            except BrowserError:
                raise
            except TimeoutError:
                # A stuck engine must not retain sessions and unlimited late work.
                self._fail_process(process)
                raise BrowserError("The browser engine timed out. Reload this browser tab.",
                                   504, "engine_timeout") from None
            except (OSError, ValueError, http.client.HTTPException):
                self._fail_process(process)
                raise BrowserError(self._stopped_message("disconnected"), 503, "engine_restarted") from None
            finally:
                watchdog.cancel()
        finally:
            self._slots.release()

    def request(self, body):
        if not isinstance(body, dict):
            raise BrowserError("Send a browser command object.", code="invalid_request")
        now = time.monotonic()
        with self._lock:
            expired = [token for token, session in self._sessions.items() if now - session["touched"] > SESSION_TTL]
            stale_tabs = [tab for token in expired for tab in self._sessions.pop(token)["tabs"].values()]
        for tab in stale_tabs:
            try:
                self._command({"action": "close", "tab": tab})
            except BrowserError:
                break
        if body.get("action") == "session":
            self._ensure_process()
            with self._lock:
                if len(self._sessions) >= MAX_SESSIONS:
                    raise BrowserError("Too many browser sessions are open.", 429, "engine_busy")
                token = secrets.token_urlsafe(32)
                self._sessions[token] = {"prefix": secrets.token_hex(16), "touched": now, "tabs": {}}
            return {"token": token}
        if body.get("action") == "close_session":
            token = body.get("token")
            with self._lock:
                session = self._sessions.pop(token, None) if isinstance(token, str) else None
            if session is None:
                raise BrowserError("The browser session expired. Reload this browser tab.", 401, "engine_session_expired")
            for tab in session["tabs"].values():
                try:
                    self._command({"action": "close", "tab": tab})
                except BrowserError:
                    # An exiting engine already disposes all of its tabs.
                    pass
            return {"closed": True}
        command = _command_body(body)
        token = body.get("token")
        with self._lock:
            session = self._sessions.get(token) if isinstance(token, str) else None
            if session is None:
                raise BrowserError("The browser session expired. Reload this browser tab.", 401, "engine_session_expired")
            session["touched"] = now
            tab = command["tab"]
            new_tab = command["action"] == "create" and tab not in session["tabs"]
            if command["action"] == "create":
                if tab not in session["tabs"] and sum(len(item["tabs"]) for item in self._sessions.values()) >= MAX_TABS:
                    raise BrowserError("Close a browser tab before opening another (maximum eight).", 429, "engine_tab_limit")
                session["tabs"].setdefault(tab, session["prefix"] + "-" + tab)
            elif tab not in session["tabs"]:
                raise BrowserError("This browser tab is no longer open.", 404, "engine_tab_missing")
            command["tab"] = session["tabs"][tab]
        try:
            result = self._command(command)
        except BrowserError:
            if new_tab:
                with self._lock:
                    session["tabs"].pop(tab, None)
            raise
        if command["action"] == "close":
            with self._lock:
                session["tabs"].pop(tab, None)
        if isinstance(result, dict) and "tab" in result:
            result = {**result, "tab": tab}
        return result

    def close(self):
        with self._lock:
            process = self._process
        if process is not None:
            self._fail_process(process)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


ENGINE = BrowserEngine()
atexit.register(ENGINE.close)
