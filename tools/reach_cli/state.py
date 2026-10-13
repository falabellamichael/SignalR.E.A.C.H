"""Passive conversation checkpoints. Loading never executes or contacts a provider."""

import copy
import json
import os
import re
import threading
import time
import uuid

from .session import _write_config, session_config_path

VERSION = 1
MAX_BYTES = 8 * 1024 * 1024
MAX_MESSAGES = 2000
MAX_TEXT = 100000


def state_directory():
    return os.environ.get("REACH_CLI_STATE_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(session_config_path())), "sessions")


def _workspace(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _scrub(text, client=None):
    from .agent_tools_extra import safe_text
    if not isinstance(text, str):
        return ""
    secrets = {getattr(client, name, "") for name in ("key", "_builtin_key")}
    secrets.update(value for name, value in os.environ.items()
                   if re.search(r"(?i)(key|token|secret|password|credential)", name)
                   and len(value) >= 8)
    for secret in sorted((s for s in secrets if isinstance(s, str) and len(s) >= 4),
                         key=len, reverse=True):
        text = text.replace(secret, "[redacted]")
        # A checkpoint may end halfway through a streamed credential.
        for length in range(min(len(secret) - 1, len(text)), 3, -1):
            if text.endswith(secret[:length]):
                text = text[:-length] + "[redacted]"
                break
    return safe_text(text, MAX_TEXT)


def _messages(messages, client=None):
    """Keep conversation text only; omit tool output, controls and system context."""
    from .agent_completion import answer_text
    if not isinstance(messages, list) or len(messages) > MAX_MESSAGES:
        raise ValueError("invalid conversation")
    clean = []
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("invalid message")
        role, text = message.get("role"), message.get("content")
        if role not in ("user", "assistant") or not isinstance(text, str):
            continue
        if role == "user" and text.startswith(("[tool result]", "[run control]")):
            continue
        if role == "assistant":
            visible = answer_text(text)
            if visible is None:
                # Preserve prose preceding an unfinished control in a cut stream.
                opening = re.search(r"(?m)^\s*```(?:tool|agent_status)\s*\n", text)
                visible = text[:opening.start()] if opening else ""
            text = visible
        text = _scrub(text, client)
        if text:
            clean.append({"role": role, "content": text})
    return clean


def _scope(value):
    if value is None:
        return None
    if (isinstance(value, (tuple, list)) and len(value) == 2
            and value[0] in ("persona", "conversation")
            and isinstance(value[1], str) and 0 < len(value[1]) <= 200):
        return tuple(value)
    raise ValueError("invalid conversation scope")


def _decode(data, client=None):
    if not isinstance(data, dict):
        raise ValueError("invalid state")
    version = data.get("version", 0)
    if isinstance(version, bool) or version not in (0, VERSION):
        raise ValueError("unsupported state version")
    workpath = data.get("workpath")
    updated = data.get("updated_ns", 0)
    if (not isinstance(workpath, str) or not workpath or len(workpath) > 32768
            or not isinstance(updated, int) or isinstance(updated, bool) or updated < 0):
        raise ValueError("invalid state metadata")
    rows = data.get("conversations")
    if version == 0 and rows is None:
        rows = [{"scope": None, "messages": data.get("history", [])}]
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValueError("invalid conversations")
    clean, scopes = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid conversation")
        scope = _scope(row.get("scope"))
        if scope in scopes:
            raise ValueError("duplicate scope")
        scopes.add(scope)
        clean.append({"scope": scope, "messages": _messages(row.get("messages"), client),
                      "last_prompt": _scrub(row.get("last_prompt", ""), client)})
    activity = data.get("activity", {})
    if not isinstance(activity, dict):
        raise ValueError("invalid activity")
    status = activity.get("status", "idle")
    if status not in ("idle", "running", "interrupted"):
        raise ValueError("invalid activity status")
    partial = _messages([{"role": "assistant", "content": activity.get("partial", "")}], client)
    return {"version": VERSION, "workpath": workpath, "updated_ns": updated,
            "preferences": {key: value for key, value in data.get("preferences", {}).items()
                            if key in ("agent", "no_stream") and isinstance(value, bool)
                            or key == "system" and isinstance(value, str)}
            if isinstance(data.get("preferences", {}), dict) else {},
            "conversations": clean, "last_prompt": _scrub(data.get("last_prompt", ""), client),
            "activity": {"status": status, "scope": _scope(activity.get("scope")),
                         "partial": partial[0]["content"] if partial else ""}}


def load_last_state(directory=None, workpath=None, client=None):
    """Skip missing, malformed and future files; never alter an original file."""
    directory = directory or state_directory()
    best = None
    try:
        entries = os.scandir(directory)
    except OSError:
        return None
    with entries:
        for entry in entries:
            if not re.fullmatch(r"[0-9a-f]{32}\.json", entry.name):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
                if entry.stat().st_size > MAX_BYTES:
                    continue
                with open(entry.path, encoding="utf-8") as handle:
                    data = _decode(json.load(handle), client)
                if workpath is not None and _workspace(data["workpath"]) != _workspace(workpath):
                    continue
                key = (data["updated_ns"], entry.name)
                if best is None or key > best[0]:
                    best = (key, data)
            except (OSError, ValueError, TypeError, RecursionError):
                continue
    return best[1] if best else None


class ConversationStore:
    """Each live instance forks the last snapshot into a private atomic file."""

    def __init__(self, client, new=False, directory=None):
        self.client = client
        if not hasattr(client, "workpath"):
            client.workpath = os.getcwd()
        self.directory = directory or state_directory()
        self.path = os.path.join(self.directory, uuid.uuid4().hex + ".json")
        self.restored = None if new else load_last_state(self.directory, client.workpath, client)
        self._lock = threading.RLock()
        self._data = None
        self._last_write = 0.0
        self._last_activity = self.restored["updated_ns"] if self.restored else 0
        self._partial = ""
        self.failed = False
        self.warned = False

    def apply_preferences(self, args=None):
        # A restored transcript carries no permission to carry on working.
        self.client._session_permission_choices = set()
        from .settings import apply_client_settings
        apply_client_settings(self.client, args=args)
        if not self.restored:
            return
        for key, value in self.restored["preferences"].items():
            if not getattr(args, key, None):
                setattr(self.client, key, _scrub(value, self.client) if key == "system" else value)

    def restore(self, histories, sessions, session):
        data = self.restored
        if not data:
            return False
        for row in data["conversations"]:
            scope = row["scope"]
            histories[scope] = copy.deepcopy(row["messages"])
            if scope is not None:
                from .commands import ReplSession
                sessions[scope] = ReplSession()
                sessions[scope].last_prompt = row["last_prompt"] or None
        session.last_prompt = data["last_prompt"] or None
        activity = data["activity"]
        if activity["status"] != "idle":
            history = histories.setdefault(activity["scope"], [])
            if activity["partial"]:
                history.append({"role": "assistant", "content": activity["partial"]})
            history.append({"role": "assistant", "content":
                            "[Interrupted activity: no commands, tools or processes were resumed.]"})
        return True

    def checkpoint(self, histories, sessions, session, scope=None, status="idle", activity=True):
        with self._lock:
            try:
                rows = [{"scope": key, "messages": _messages(value, self.client),
                         "last_prompt": _scrub(getattr(sessions.get(key), "last_prompt", ""), self.client)}
                        for key, value in histories.items()]
                self._partial = ""
                if activity or not self._last_activity:
                    self._last_activity = max(time.time_ns(), self._last_activity + 1)
                self._data = {"version": VERSION, "updated_ns": self._last_activity,
                              "workpath": self.client.workpath,
                              "preferences": {"agent": bool(getattr(self.client, "agent", False)),
                                              "no_stream": bool(getattr(self.client, "no_stream", False)),
                                              "system": _scrub(getattr(self.client, "system", ""), self.client)},
                              "conversations": rows,
                              "last_prompt": _scrub(session.last_prompt, self.client),
                              "activity": {"status": status, "scope": scope, "partial": ""}}
                return self._save()
            except (OSError, ValueError, TypeError, RecursionError):
                self.failed = True
                return False

    def _save(self):
        try:
            data = copy.deepcopy(self._data)
            data["activity"]["partial"] = _messages(
                [{"role": "assistant", "content": self._partial}], self.client)
            partial = data["activity"]["partial"]
            data["activity"]["partial"] = partial[0]["content"] if partial else ""
            if len(json.dumps(data, indent=2, sort_keys=True).encode("utf-8")) + 1 > MAX_BYTES:
                raise ValueError("checkpoint too large")
            _write_config(self.path, data)
            self._last_write = time.monotonic()
            self.failed = False
            return True
        except (OSError, ValueError, TypeError, RecursionError):
            self.failed = True
            return False

    def partial(self, text, final=False):
        """Throttle disk writes to once a second; force a flush at reply boundaries."""
        with self._lock:
            if self._data is None:
                return
            self._partial = text[-MAX_TEXT:]
            self._data["activity"]["status"] = "running"
            if final or time.monotonic() - self._last_write >= 1:
                self._last_activity = max(time.time_ns(), self._last_activity + 1)
                self._data["updated_ns"] = self._last_activity
                self._save()

    def partial_text(self):
        with self._lock:
            messages = _messages([{"role": "assistant", "content": self._partial}], self.client)
            return messages[0]["content"] if messages else ""


def validate_restored_model(client, catalog=None, refresh=False):
    """Only a successful fresh catalog disproves a restored choice; offline keeps it."""
    client._restored_model_blocked = False
    restored = getattr(client, "_restored_model", None)
    if not restored or client.model != restored:
        return False
    if catalog is None:
        from .commands import _current_refresh_target
        from .discovery import MODEL_DISCOVERY
        base, key, reference = _current_refresh_target(client)
        catalog = MODEL_DISCOVERY.snapshot(base, key_ref=reference, key=key)
        if refresh and catalog.get("status") == "loading":
            catalog = MODEL_DISCOVERY.wait(base, key_ref=reference, key=key, timeout=2)
        if refresh and (catalog.get("status") in ("idle", "error") or catalog.get("stale")):
            MODEL_DISCOVERY.refresh(base, key=key, key_ref=reference, timeout=2)
            catalog = MODEL_DISCOVERY.wait(base, key_ref=reference, key=key, timeout=2)
    if catalog.get("status") != "ready" or catalog.get("stale"):
        return False
    if restored in catalog.get("models", []):
        client._restored_model = None
        return False
    models = catalog.get("models") or []
    builtin = getattr(client, "endpoint_name", None) in ("local", "public", "subscription")
    if not builtin and not models:
        client._restored_model_blocked = True
        from .terminal import c_yellow, tprint
        tprint(c_yellow("  saved model is unavailable and this endpoint lists no models; choose /model before sending."))
        return True
    client.model = None if builtin or not models else models[0]
    client._restored_model = None
    from .session import save_session_config
    save_session_config(model=client.model, clear_model=client.model is None)
    from .terminal import c_yellow, tprint
    tprint(c_yellow("  saved model is unavailable; using %s. /model changes the selection."
                   % (client.model or "the endpoint's auto model")))
    return True
