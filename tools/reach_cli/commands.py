"""Slash commands: one registry, no provider alias, no endpoint fallback."""

import difflib
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.parse

from .session import save_session_config
from .terminal import (
    c_bold,
    c_cyan,
    c_dim,
    c_green,
    c_magenta,
    c_red,
    c_yellow,
    status_line,
    tprint,
)

# ---- slash commands -------------------------------------------------------
# One registry drives /help, dispatch, and typo suggestions. Endpoint choice
# is /endpoint only. A failed switch never substitutes a different endpoint.

LOCAL_ENDPOINT_URL = "http://127.0.0.1:20777/v1"
COMPACT_KEEP_EXCHANGES = 2
COMPACT_MAX_CHARS = 1600
COMPACT_SNIPPET = 120

COMMANDS = (
    ("/help", "show this help"),
    ("/status", "show endpoint, model, agent, workpath, and key"),
    ("/endpoint [arg]", "manage saved endpoints (add/edit/test/select/remove)"),
    ("/endpoints", "list endpoints; alias for /endpoint"),
    ("/settings", "show saved settings and endpoint model discovery"),
    ("/model <alias>", "switch model (aliases below)"),
    ("/models", "list models served by the endpoint"),
    ("/web <question>", "grounded search-and-answer (SimpleRAG websearch)"),
    ("/agent", "toggle agent mode (multi-round tool loop: read/search/shell/edit/web)"),
    ("/tools [query]", "list agent tools or search by name/category"),
    ("/workpath <dir>", "set the directory the agent works in"),
    ("/system [text]", "show prompt; set text or clear/reset to default"),
    ("/clear", "reset the conversation"),
    ("/history", "show the conversation so far"),
    ("/retry", "resend the last prompt"),
    ("/undo", "drop the last exchange"),
    ("/compact", "shrink the conversation history"),
    ("/copy", "copy the last answer to the clipboard"),
    ("/save [file]", "save the conversation as JSONL"),
    ("/layout <mode>", "centred page column or full-width UI"),
    ("/theme [name|preview|current|reset]", "list, preview, or select an app-local terminal theme"),
    ("/themes", "list available app-local terminal themes"),
    ("/exit", "quit (Ctrl+D, or Ctrl+C twice)"),
)


# Help stays one column (`  %-16s %s`) and is grouped so the list is scannable.
# Every token appears in exactly one section.
HELP_SECTIONS = (
    ("session", ("/help", "/status", "/settings", "/layout", "/theme", "/themes", "/exit")),
    ("endpoint", ("/endpoint", "/endpoints", "/model", "/models")),
    ("chat", ("/web", "/retry", "/undo", "/compact", "/copy", "/clear", "/history", "/save")),
    ("agent", ("/agent", "/tools", "/workpath", "/system")),
)


class SlashResult(object):
    """What the chat loop should do after a slash command.

    ``quit`` ends the REPL. ``prompt`` is a user message to send (``/retry``).
    """

    def __init__(self, quit=False, prompt=None, success=True, refresh_target=None):
        self.quit = bool(quit)
        self.prompt = prompt
        self.success = bool(success)
        self.refresh_target = refresh_target
        self.discovery = None


class ReplSession(object):
    """Last real prompt, so /retry still works after a failed turn."""

    def __init__(self):
        self.last_prompt = None

    def remember(self, prompt):
        text = (prompt or "").strip() if isinstance(prompt, str) else ""
        if text and not text.startswith("/"):
            self.last_prompt = text


def repl_commands():
    """Ordered help map: usage string -> one-line description."""
    return dict(COMMANDS)


def command_tokens():
    return [spec.split()[0] for spec, _description in COMMANDS]


class _Presentation(object):
    """One command's formatted output, painted with a single transcript write."""

    def __init__(self):
        self.parts = []

    def line(self, *args, sep=" "):
        from .terminal import margin_pad
        pad = margin_pad()
        self.parts.append(pad + sep.join(str(arg) for arg in args).replace("\n", "\n" + pad) + "\n")

    def blank(self):
        self.parts.append("\n")

    def flush(self):
        if self.parts:
            text = "".join(self.parts)
            self.parts[:] = []
            sys.stdout.write(text)


def print_help(output=None):
    """Grouped /help. Command lines keep the `  %-16s %s` column."""
    owned = output is None
    output = output or _Presentation()
    tprint = output.line
    by_token = {}
    for spec, description in COMMANDS:
        by_token[spec.split()[0]] = (spec, description)
    shown = []
    for title, tokens in HELP_SECTIONS:
        tprint(c_dim("  " + title))
        for token in tokens:
            spec, description = by_token[token]
            tprint("  %-16s %s" % (c_cyan(spec), description))
            shown.append(token)
        output.blank()
    for spec, description in COMMANDS:
        token = spec.split()[0]
        if token not in shown:
            tprint("  %-16s %s" % (c_cyan(spec), description))
    if owned:
        output.flush()


def _command_similarity(query, candidate):
    """Blend sequence, character overlap, and shared prefix.

    Prefix matches (``/mod`` -> ``/model``) get a bonus. Character overlap
    keeps near-misses such as ``/ednpoint`` on ``/endpoint``.
    """
    seq = difflib.SequenceMatcher(None, query, candidate).ratio()
    left = set(query)
    right = set(candidate)
    union = left | right
    overlap = (len(left & right) / float(len(union))) if union else 0.0
    shared = 0
    for left_ch, right_ch in zip(query, candidate):
        if left_ch != right_ch:
            break
        shared += 1
    longest = max(len(query), len(candidate)) or 1
    pref = shared / float(longest)
    bonus = 0.0
    if len(query) >= 2 and (candidate.startswith(query) or query.startswith(candidate)):
        bonus = 0.25
    return 0.50 * seq + 0.35 * overlap + 0.15 * pref + bonus


def suggest_command(query, names=None):
    """Return the closest command token for an unknown slash command."""
    if names is None:
        names = command_tokens()
    query = (query or "").strip().lower()
    best_name = None
    best_key = None
    for index, name in enumerate(names):
        candidate = (name or "").lower()
        if candidate == query:
            return name
        value = _command_similarity(query, candidate)
        key = (-value, index)
        if best_key is None or key < best_key:
            best_key = key
            best_name = name
    return best_name or "/help"


def _mask_key(key):
    """Display mask. Prefer the shared helper; never raise."""
    try:
        from reach.keys import mask_key
        return mask_key(key)
    except Exception:
        if not key or not isinstance(key, str):
            return "(none)"
        if len(key) <= 12:
            return "set (short)"
        if key.startswith("sk-reach-"):
            return "sk-reach-…"
        return key[:8] + "…" + key[-4:]


def _normalize_endpoint_url(text):
    """Return a bare http(s) URL, or None when it is not one."""
    if not isinstance(text, str):
        return None
    raw = text.strip()
    if not raw or any(ch.isspace() or ord(ch) < 32 for ch in raw):
        return None
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        return None
    if parsed.username or parsed.password:
        return None
    return raw.rstrip("/")


def _public_endpoint_url():
    """Pointer-gist URL, or None. Never substitutes the local relay."""
    try:
        from . import client as client_mod
        url = client_mod.discover_public_url()
    except Exception:
        return None
    if not isinstance(url, str):
        return None
    return _normalize_endpoint_url(url.strip())


def _endpoint_reachable(client, url):
    try:
        from . import client as client_mod
        key = getattr(client, "key", "") or ""
        return bool(client_mod.ReachClient._reachable(url, key))
    except Exception:
        return False


def _current_base(client):
    raw = getattr(client, "base", None) or ""
    if not isinstance(raw, str):
        raw = str(raw)
    return raw.strip()


def _endpoint_label(client):
    current = _normalize_endpoint_url(_current_base(client))
    if not current:
        return "(none)"
    if current == LOCAL_ENDPOINT_URL:
        return "local"
    return "custom"


def _refresh_system(history, client):
    from . import chat as chat_mod
    chat_mod.set_system_message(history, client)


def _is_real_user(message):
    if not isinstance(message, dict) or message.get("role") != "user":
        return False
    content = message.get("content")
    if not isinstance(content, str):
        content = "" if content is None else str(content)
    if content.startswith("[tool result]") or content.startswith("[run control]"):
        return False
    return True


def _split_history(history):
    """Split leading system messages from user-led exchanges."""
    system = []
    index = 0
    while (
        index < len(history)
        and isinstance(history[index], dict)
        and history[index].get("role") == "system"
    ):
        system.append(history[index])
        index += 1
    exchanges = []
    bucket = None
    for message in history[index:]:
        if _is_real_user(message):
            if bucket:
                exchanges.append(bucket)
            bucket = [message]
        elif bucket is None:
            bucket = [message]
        else:
            bucket.append(message)
    if bucket:
        exchanges.append(bucket)
    return system, exchanges


def _message_chars(messages):
    total = 0
    for message in messages:
        if isinstance(message, dict):
            total += len(str(message.get("content") or ""))
        else:
            total += len(str(message))
    return total


def _history_chars(system, exchanges):
    return _message_chars(system) + sum(_message_chars(ex) for ex in exchanges)


def undo_last_exchange(history):
    """Drop the last user-led exchange. Returns True when something was removed."""
    if not isinstance(history, list) or not history:
        return False
    system, exchanges = _split_history(history)
    if not exchanges:
        return False
    exchanges.pop()
    history[:] = list(system) + [message for ex in exchanges for message in ex]
    return True


def _digest(exchanges):
    lines = ["[compacted history]"]
    for exchange in exchanges:
        for message in exchange:
            if isinstance(message, dict):
                role = message.get("role") or "?"
                content = message.get("content")
            else:
                role = "?"
                content = message
            text = " ".join(str(content or "").split())
            if len(text) > COMPACT_SNIPPET:
                text = text[: COMPACT_SNIPPET - 3] + "..."
            lines.append("%s: %s" % (role, text))
    return "\n".join(lines)


def compact_history(history):
    """Shrink history locally. Returns (changed, reason). Never calls a model."""
    if not isinstance(history, list) or not history:
        return False, "nothing to compact"
    system, exchanges = _split_history(history)
    if not exchanges:
        return False, "nothing to compact"
    original_chars = _history_chars(system, exchanges)

    def shorten(message):
        if not isinstance(message, dict):
            return message
        content = message.get("content")
        if not isinstance(content, str) or len(content) <= COMPACT_MAX_CHARS:
            return message
        clone = dict(message)
        clone["content"] = content[:COMPACT_MAX_CHARS] + "\n… [truncated]"
        return clone

    trimmed = [[shorten(message) for message in exchange] for exchange in exchanges]
    if len(trimmed) > COMPACT_KEEP_EXCHANGES:
        older = trimmed[:-COMPACT_KEEP_EXCHANGES]
        recent = trimmed[-COMPACT_KEEP_EXCHANGES:]
    else:
        older = []
        recent = trimmed
    pieces = list(recent)
    if older:
        digest = _digest(older)
        bridge = "Earlier turns were compacted locally."
        old_chars = sum(_message_chars(exchange) for exchange in older)
        if len(digest) + len(bridge) < old_chars:
            pieces = [[
                {"role": "user", "content": digest},
                {"role": "assistant", "content": bridge},
            ]] + recent
        else:
            pieces = older + recent
    new_messages = list(system) + [message for exchange in pieces for message in exchange]
    new_chars = _message_chars(new_messages)
    if new_chars >= original_chars and len(new_messages) >= len(history):
        return False, "history already compact"
    history[:] = new_messages
    return True, "compacted"


def _last_real_user_text(history):
    if not isinstance(history, list):
        return None
    for message in reversed(history):
        if _is_real_user(message):
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content
    return None


def _last_assistant_text(history):
    if not isinstance(history, list):
        return None
    for message in reversed(history):
        if isinstance(message, dict) and message.get("role") == "assistant":
            content = message.get("content")
            if content is None:
                return ""
            return content if isinstance(content, str) else str(content)
    return None


def copy_to_clipboard(text):
    """Copy ``text``. Returns (ok, detail). Never raises.

    Fails with a short reason when the machine has no clipboard tool.
    """
    try:
        if text is None:
            return False, "nothing to copy"
        data = text if isinstance(text, str) else str(text)
        if data == "":
            return False, "nothing to copy"
        if sys.platform == "darwin":
            commands = [["pbcopy"]]
        elif os.name == "nt":
            commands = [["clip"]]
        else:
            commands = [
                ["wl-copy"],
                ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"],
            ]
        last = "no clipboard available"
        payload = data.encode("utf-8")
        for cmd in commands:
            try:
                proc = subprocess.run(
                    cmd,
                    input=payload,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                    check=False,
                )
            except FileNotFoundError:
                continue
            except subprocess.TimeoutExpired:
                last = "clipboard tool %s timed out" % cmd[0]
                continue
            except OSError:
                continue
            if proc.returncode == 0:
                return True, None
            last = "clipboard tool %s failed" % cmd[0]
        return False, last
    except Exception as exc:
        return False, str(exc) or "no clipboard available"


def _cmd_help(_client, _history, _session, _argument):
    output = _Presentation()
    print_help(output=output)
    _print_endpoint_usage(output=output)
    output.line(c_dim("  Available models refresh once in the background for /help, /settings and /endpoint commands."))
    output.flush()
    return SlashResult()


def _safe_endpoint_url(value):
    """Never echo credential-bearing or malformed URLs from old configuration."""
    from .endpoints import EndpointError, normalize_url
    if value in ("local", "public", "subscription"):
        return value
    try:
        return normalize_url(value)
    except (EndpointError, TypeError, ValueError):
        return "(invalid endpoint URL; select a saved endpoint)"


def _endpoint_identity(client, records=None):
    from .endpoints import BUILTIN_NAMES, LOCAL_ENDPOINT_URL, list_custom
    records = list_custom() if records is None else records
    name = getattr(client, "endpoint_name", None)
    base = _current_base(client)
    if name in BUILTIN_NAMES:
        return "subscription" if name == "public" else name
    if name in records and records[name]["url"] == base:
        return name
    if base in ("local", LOCAL_ENDPOINT_URL):
        return "local"
    if base in ("public", "subscription"):
        return "subscription"
    for candidate, record in records.items():
        if record["url"] == base:
            return candidate
    return "custom" if base else "(none)"


def _current_refresh_target(client):
    if client is None:
        return (LOCAL_ENDPOINT_URL, "", "")
    from .endpoints import credential_for, list_custom, normalize_key_env
    records = list_custom()
    name = _endpoint_identity(client, records)
    reference = getattr(client, "key_env", None)
    explicit = bool(getattr(client, "explicit_credential", False))
    if reference and (explicit or getattr(client, "endpoint_name", None) is None):
        reference = normalize_key_env(reference)
        return (_current_base(client), os.environ.get(reference, "").strip(), "env:" + reference)
    if explicit:
        return (_current_base(client), getattr(client, "key", "") or "", "explicit")
    if name in records:
        record = records[name]
        reference = record.get("key_env")
        return (record["url"], credential_for(record), "env:" + reference if reference else "")
    key = getattr(client, "key", "") or ""
    key_ref = "builtin" if name in ("local", "subscription") else ""
    # Arbitrary URL endpoints never inherit the subscription credential.
    if name == "custom":
        key = ""
    return (_current_base(client) or LOCAL_ENDPOINT_URL, key, key_ref)


def _credential_description(client, records=None):
    from .endpoints import list_custom
    records = list_custom() if records is None else records
    name = _endpoint_identity(client, records)
    reference = getattr(client, "key_env", None)
    explicit = bool(getattr(client, "explicit_credential", False))
    if reference and (explicit or getattr(client, "endpoint_name", None) is None):
        from .endpoints import normalize_key_env
        reference = normalize_key_env(reference)
        return "environment %s (%s)" % (reference, "set" if os.environ.get(reference) else "not set")
    if explicit:
        return "explicit credential (%s)" % ("set" if getattr(client, "key", "") else "not set")
    if name in records:
        reference = records[name].get("key_env")
        if reference:
            state = "set" if os.environ.get(reference) else "not set"
            return "environment %s (%s)" % (reference, state)
        return "none (anonymous)"
    if name in ("local", "subscription"):
        return "built-in credential (%s)" % ("set" if getattr(client, "key", "") else "not set")
    return "none (anonymous)"


def _print_discovery(target, refresh_requested=True, output=None):
    owned = output is None
    output = output or _Presentation()
    tprint = output.line
    from .discovery import MODEL_DISCOVERY
    base, _key, key_ref = target
    snapshot = MODEL_DISCOVERY.snapshot(base, key_ref=key_ref, key=_key)
    status = snapshot.get("status", "idle")
    suffix = "; refresh requested in background" if refresh_requested else ""
    tprint(c_dim("  model discovery: %s%s" % (status, suffix)))
    models = snapshot.get("models") or []
    if models:
        qualifier = "stale cached" if snapshot.get("stale") else "last fetched"
        preview, size = [], 0
        for model in models[:20]:
            if size + len(model) > 1200:
                break
            preview.append(model)
            size += len(model) + 2
        remainder = len(models) - len(preview)
        extra = "; %d more available via /models" % remainder if remainder else ""
        tprint(c_dim("  %s models: " % qualifier) + ", ".join(preview) + extra)
    elif status in ("error", "busy"):
        tprint(c_yellow("  no cached models; use /endpoint test after checking the URL and credential reference"))
    else:
        tprint(c_dim("  no cached models yet; /settings shows the latest result"))
    error = snapshot.get("error")
    if error:
        tprint(c_yellow("  " + error))
    if owned:
        output.flush()


def _cmd_status(client, _history, _session, _argument, output=None):
    owned = output is None
    output = output or _Presentation()
    tprint = output.line
    from .endpoints import list_custom
    records = list_custom()
    name = _endpoint_identity(client, records)
    rows = (
        ("endpoint", "%s  (%s)" % (_safe_endpoint_url(_current_base(client)), name)),
        ("model", str(getattr(client, "model", None) or "(auto)")),
        ("agent", "on" if getattr(client, "agent", False) else "off"),
        ("workpath", str(getattr(client, "workpath", None) or "(none)")),
        ("api key", _credential_description(client, records)),
    )
    for name, value in rows:
        tprint("  %-12s %s" % (c_dim(name), value))
    if owned:
        output.flush()
    return SlashResult()


def _print_endpoint_usage(output=None):
    owned = output is None
    output = output or _Presentation()
    tprint = output.line
    for line in (
        "/endpoint list                         list saved and protected options",
        "/endpoint add NAME URL [--key-env ENV]  save a custom endpoint",
        "/endpoint edit NAME [URL] [--key-env ENV|--no-key]",
        "/endpoint test [NAME]                  fetch models without selecting",
        "/endpoint select NAME                 select a saved or protected option",
        "/endpoint remove NAME                 remove a custom endpoint",
        "/endpoint <local|public|subscription|URL|NAME>  select directly",
    ):
        tprint(c_dim("  " + line))
    tprint(c_dim("  /endpoints is an alias. Add/edit prompt for missing values; Ctrl+C or 'cancel' cancels."))
    tprint(c_dim("  Operation aliases: ls=list, update=edit, use=select, check=test, rm/delete=remove."))
    tprint(c_dim("  --key-env stores an existing environment-variable name, never an API key."))
    tprint(c_dim("  local and subscription (public alias) are protected. Model fetching never downloads weights."))
    if owned:
        output.flush()


def _print_endpoints(client):
    output = _Presentation()
    tprint = output.line
    from .discovery import MODEL_DISCOVERY
    from .endpoints import LOCAL_ENDPOINT_URL, credential_for, list_custom
    records = list_custom()
    active = _endpoint_identity(client, records)
    tprint(c_dim("  current: ") + c_bold(active) + "  " + _safe_endpoint_url(_current_base(client)))
    tprint(c_dim("  available endpoints:"))
    for name, url in (("local", LOCAL_ENDPOINT_URL), ("subscription", "public pointer (resolved in background)")):
        marker = " * current" if active == name else ""
        tprint("   - %s  %s  [protected]%s" % (name, url, marker))
    tprint(c_dim("     public is an alias for subscription"))
    for name, record in records.items():
        reference = record.get("key_env")
        credential = "key-env: %s (%s)" % (reference, "set" if os.environ.get(reference) else "not set") if reference else "anonymous"
        marker = " * current" if active == name else ""
        tprint("   - %s  %s  [%s]%s" % (name, record["url"], credential, marker))
        cached = MODEL_DISCOVERY.snapshot(record["url"], key_ref="env:" + reference if reference else "", key=credential_for(record))
        state = cached.get("status", "idle")
        stale = "; stale cache retained" if cached.get("stale") else ""
        tprint(c_dim("     models: %s%s" % (state, stale)))
        if cached.get("error"):
            tprint(c_yellow("     " + cached["error"]))
    if not records:
        tprint(c_dim("  no custom endpoints saved; /endpoint add NAME URL"))
    if active == "custom":
        tprint(c_dim("  the current URL is not saved by name; add it to manage it"))
    _print_endpoint_usage(output=output)
    _print_discovery(_current_refresh_target(client), output=output)
    output.flush()


class _EndpointCancelled(Exception):
    pass


def _endpoint_prompt(message, allow_empty=False):
    from .terminal import read_input
    value = read_input(message).strip()
    if value.lower() in ("cancel", "/cancel", "/exit") or (not value and not allow_empty):
        raise _EndpointCancelled()
    return value


def _endpoint_arguments(argument):
    from .endpoints import EndpointError
    if "\\" in argument:
        raise EndpointError("backslashes are not valid endpoint arguments; use forward slashes in the URL")
    try:
        tokens = shlex.split(argument)
    except ValueError:
        raise EndpointError("unclosed quote; quote values as \"URL\" and try again")
    values, options = [], {}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--key-env":
            if "key_env" in options or index + 1 >= len(tokens) or tokens[index + 1].startswith("--"):
                raise EndpointError("--key-env requires one environment-variable name")
            options["key_env"] = tokens[index + 1]
            index += 2
        elif token == "--no-key":
            if "key_env" in options:
                raise EndpointError("choose either --key-env ENV or --no-key")
            options["key_env"] = None
            index += 1
        elif token.startswith("--"):
            raise EndpointError("unknown option; use --key-env ENV or --no-key")
        else:
            values.append(token)
            index += 1
    return values, options


def _endpoint_target(client, value):
    from .endpoints import BUILTIN_NAMES, EndpointError, credential_for, get_custom, normalize_name, normalize_url
    lowered = value.lower()
    if lowered in BUILTIN_NAMES:
        if lowered == "local":
            return (LOCAL_ENDPOINT_URL, "", "builtin"), "local", None
        key = getattr(client, "_builtin_key", "") or ""
        if not key and _endpoint_identity(client) in ("local", "subscription"):
            key = getattr(client, "key", "") or ""
        return ("public", key, "builtin"), "subscription", None
    if "://" in value:
        url = normalize_url(value)
        if (url == _current_base(client) and getattr(client, "endpoint_name", None) is None
                and (getattr(client, "key_env", None) or getattr(client, "explicit_credential", False))):
            return _current_refresh_target(client), None, None
        return (url, "", ""), None, None
    try:
        name = normalize_name(value)
        record = get_custom(name)
    except EndpointError:
        raise EndpointError("unknown endpoint; use /endpoints, or /endpoint add NAME URL")
    reference = record.get("key_env")
    return (record["url"], credential_for(record), "env:" + reference if reference else ""), name, record


def _select_endpoint(client, value):
    from .endpoints import EndpointError, select_custom
    if not hasattr(client, "_builtin_key") and _endpoint_identity(client) in ("local", "subscription"):
        client._builtin_key = getattr(client, "key", "") or ""
    target, name, record = _endpoint_target(client, value)
    base, key, _key_ref = target
    changed = _current_base(client) != base
    keep_explicit = (record is None and name is None and not changed
                     and getattr(client, "endpoint_name", None) is None
                     and (getattr(client, "key_env", None) or getattr(client, "explicit_credential", False)))
    if keep_explicit:
        target = _current_refresh_target(client)
        base, key, _key_ref = target
    if record is not None:
        record = select_custom(name)
    elif not save_session_config(endpoint=base, endpoint_name=name or "", clear_model=changed):
        raise EndpointError("could not save endpoint selection; check configuration-file permissions")
    client.base = base
    client.key = key
    client.endpoint_name = name
    client.key_env = record.get("key_env") if record else getattr(client, "key_env", None) if keep_explicit else None
    client.key_ref = target[2]
    client.explicit_credential = bool(keep_explicit and getattr(client, "explicit_credential", False))
    if changed:
        client.model = None
    tprint(c_green("  endpoint → ") + c_bold(name or "custom") + "  " + _safe_endpoint_url(base))
    tprint(c_dim("  selection saved; availability and models are checked in the background"))
    _print_discovery(target)
    return SlashResult(refresh_target=target)


def _cmd_endpoint(client, _history, _session, argument):
    from .endpoints import BUILTIN_NAMES, EndpointError, UNSET, add_custom, credential_for, edit_custom, get_custom, normalize_name, remove_custom
    try:
        values, options = _endpoint_arguments(argument)
        action = values[0].lower() if values else "list"
        action = {"ls": "list", "update": "edit", "use": "select", "check": "test",
                  "rm": "remove", "delete": "remove"}.get(action, action)
        rest = values[1:]
        if action in ("help", "?"):
            if options or rest:
                raise EndpointError("usage: /endpoint help")
            _print_endpoint_usage()
            return SlashResult()
        if action == "list":
            if options or rest:
                raise EndpointError("usage: /endpoint list")
            _print_endpoints(client)
            return SlashResult()
        if action in ("add", "edit"):
            if len(rest) > 2:
                raise EndpointError("usage: /endpoint %s NAME [URL] [--key-env ENV]" % action)
            interactive = len(rest) < 2 and not options
            name = rest[0] if rest else _endpoint_prompt("Endpoint name (cancel to stop): ")
            name = normalize_name(name)
            if name in BUILTIN_NAMES:
                raise EndpointError("local and subscription/public are protected; choose a custom name")
            existing = get_custom(name) if action == "edit" else None
            url = rest[1] if len(rest) > 1 else None
            if url is None and (action == "add" or interactive):
                prompt = "Endpoint URL (blank keeps current; cancel stops): " if action == "edit" else "Endpoint URL (http(s)://.../v1; cancel stops): "
                url = _endpoint_prompt(prompt, allow_empty=action == "edit") or None
            key_env = options.get("key_env", UNSET)
            if interactive:
                prompt = "Key environment-variable name (blank keeps current; '-' clears): " if action == "edit" else "Key environment-variable name (blank for anonymous): "
                entered = _endpoint_prompt(prompt, allow_empty=True)
                if entered:
                    key_env = None if entered == "-" else entered
            if action == "add":
                record = add_custom(name, url, key_env=None if key_env is UNSET else key_env)
            else:
                active = _endpoint_identity(client) == name
                record = edit_custom(name, url=url, key_env=key_env)
                if active:
                    changed = _current_base(client) != record["url"]
                    client.base = record["url"]
                    client.key = credential_for(record)
                    client.key_env = record.get("key_env")
                    client.key_ref = "env:" + record["key_env"] if record.get("key_env") else ""
                    client.explicit_credential = False
                    if changed:
                        client.model = None
            reference = record.get("key_env")
            target = (record["url"], credential_for(record), "env:" + reference if reference else "")
            tprint(c_green("  endpoint %s: %s  %s" % ("added" if action == "add" else "updated", name, record["url"])))
            if record.get("key_env") and not os.environ.get(record["key_env"]):
                tprint(c_yellow("  %s is not set; configure that environment variable separately before authenticated use" % record["key_env"]))
            _print_discovery(target)
            return SlashResult(refresh_target=target)
        if options:
            raise EndpointError("credential options apply only to add/edit")
        if action == "test":
            if len(rest) > 1:
                raise EndpointError("usage: /endpoint test [NAME]")
            target = _endpoint_target(client, rest[0])[0] if rest else _current_refresh_target(client)
            tprint(c_dim("  model-discovery test queued: " + _safe_endpoint_url(target[0])))
            _print_discovery(target)
            tprint(c_dim("  /endpoints shows the latest cached result for saved targets"))
            return SlashResult(refresh_target=target)
        if action == "select":
            if len(rest) > 1:
                raise EndpointError("usage: /endpoint select NAME")
            value = rest[0] if rest else _endpoint_prompt("Endpoint to select (cancel to stop): ")
            return _select_endpoint(client, value)
        if action == "remove":
            if len(rest) > 1:
                raise EndpointError("usage: /endpoint remove NAME")
            name = normalize_name(rest[0] if rest else _endpoint_prompt("Custom endpoint to remove (cancel to stop): "))
            record = get_custom(name)
            identity = _endpoint_identity(client)
            active = identity == name or (identity == "custom" and _current_base(client) == record["url"])
            remove_custom(name)
            if active:
                client.base = LOCAL_ENDPOINT_URL
                client.endpoint_name = "local"
                client.key = ""
                client.key_env = None
                client.key_ref = "builtin"
                client.explicit_credential = False
                client.model = None
            tprint(c_green("  endpoint removed: " + name))
            if active:
                tprint(c_yellow("  active endpoint removed; selected protected local and reset the model to auto"))
            return SlashResult(refresh_target=_current_refresh_target(client))
        if len(values) != 1:
            raise EndpointError("unknown endpoint operation; use /endpoint help")
        return _select_endpoint(client, values[0])
    except (_EndpointCancelled, EOFError, KeyboardInterrupt):
        tprint(c_yellow("  endpoint operation cancelled; no changes made"))
        return SlashResult(success=False)
    except EndpointError as exc:
        tprint(c_red("  endpoint: " + str(exc)))
        return SlashResult(success=False)


def _cmd_settings(client, _history, _session, argument):
    if argument:
        tprint(c_yellow("  usage: /settings"))
        return SlashResult(success=False)
    from .session import session_config_path
    output = _Presentation()
    _cmd_status(client, _history, _session, "", output=output)
    output.line(c_dim("  config       " + session_config_path()))
    _print_discovery(_current_refresh_target(client), output=output)
    output.line(c_dim("  /endpoints lists options; /endpoint help shows add/edit/test/select/remove"))
    output.flush()
    return SlashResult()



def _read_single_key():
    """Read a single keypress or escape sequence cross-platform."""
    import os, sys
    if os.name == "nt":
        import msvcrt
        ch = msvcrt.getch()
        if ch in (b"\x00", b"\xe0"):
            ext = msvcrt.getch()
            if ext == b"H":
                return "up"
            elif ext == b"P":
                return "down"
            elif ext == b"I":
                return "page_up"
            elif ext == b"Q":
                return "page_down"
            return "unknown"
        if ch in (b"\r", b"\n"):
            return "enter"
        if ch in (b"\x1b", b"q", b"Q"):
            return "escape"
        if ch == b"k" or ch == b"K":
            return "up"
        if ch == b"j" or ch == b"J":
            return "down"
        if ch == b"\x03":
            raise KeyboardInterrupt()
        try:
            return ch.decode("utf-8", "ignore")
        except Exception:
            return "unknown"
    else:
        import tty, termios, select
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
            if ch == "\x1b":
                r, _, _ = select.select([sys.stdin], [], [], 0.05)
                if r:
                    seq = sys.stdin.read(2)
                    if seq == "[A":
                        return "up"
                    elif seq == "[B":
                        return "down"
                    elif seq == "[5~":
                        return "page_up"
                    elif seq == "[6~":
                        return "page_down"
                return "escape"
            elif ch in ("\r", "\n"):
                return "enter"
            elif ch in ("q", "Q"):
                return "escape"
            elif ch in ("k", "K"):
                return "up"
            elif ch in ("j", "J"):
                return "down"
            elif ch == "\x03":
                raise KeyboardInterrupt()
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _interactive_pick_model(models, current=None):
    """Interactive arrow-key and quick-number picker for served models."""
    import os, sys
    if not models or not sys.stdin.isatty():
        return None
    models = [m for m in models if m]
    if not models:
        return None

    if os.name == "nt":
        os.system("")

    selected_idx = 0
    if current in models:
        selected_idx = models.index(current)

    page_size = 10
    total = len(models)

    sys.stdout.write("\033[?25l")
    sys.stdout.flush()

    last_lines = 0

    try:
        while True:
            start_idx = max(0, min(selected_idx - page_size // 2, total - page_size))
            end_idx = min(total, start_idx + page_size)
            visible = models[start_idx:end_idx]

            if last_lines > 0:
                sys.stdout.write(f"\033[{last_lines}A\r\033[0J")

            lines = []
            header = c_dim("  Select model ") + c_dim("(↑/↓ navigate, Enter select, 1-9 quick-pick, Esc cancel):")
            lines.append(header)

            for rel_idx, model_name in enumerate(visible):
                abs_idx = start_idx + rel_idx
                is_selected = (abs_idx == selected_idx)
                is_current = (model_name == current)

                num_tag = f"[{abs_idx + 1}]" if abs_idx < 9 else "   "
                curr_tag = c_dim(" (current)") if is_current else ""

                if is_selected:
                    line = f"  {c_green('❯')} {c_bold(c_green(num_tag))} {c_bold(c_green(model_name))}{curr_tag}"
                else:
                    line = f"    {c_dim(num_tag)} {model_name}{curr_tag}"
                lines.append(line)

            if total > page_size:
                footer = c_dim(f"  ({selected_idx + 1}/{total} models · scroll with ↑/↓)")
                lines.append(footer)

            rendered = "\n".join(lines) + "\n"
            sys.stdout.write(rendered)
            sys.stdout.flush()
            last_lines = len(lines)

            try:
                key = _read_single_key()
            except KeyboardInterrupt:
                break

            if key == "up":
                selected_idx = (selected_idx - 1) % total
            elif key == "down":
                selected_idx = (selected_idx + 1) % total
            elif key == "page_up":
                selected_idx = max(0, selected_idx - 5)
            elif key == "page_down":
                selected_idx = min(total - 1, selected_idx + 5)
            elif key == "enter":
                sys.stdout.write(f"\033[{last_lines}A\r\033[0J")
                sys.stdout.flush()
                return models[selected_idx]
            elif key == "escape":
                break
            elif isinstance(key, str) and key.isdigit():
                d = int(key)
                if 1 <= d <= total and d <= 9:
                    selected_idx = d - 1
                    sys.stdout.write(f"\033[{last_lines}A\r\033[0J")
                    sys.stdout.flush()
                    return models[selected_idx]
    finally:
        sys.stdout.write("\033[?25h")
        sys.stdout.flush()

    if last_lines > 0:
        sys.stdout.write(f"\033[{last_lines}A\r\033[0J")
        sys.stdout.flush()
    return None


def _cmd_model(client, _history, _session, argument):
    served = None
    try:
        status_line("checking served models…")
        models_fn = getattr(client, "models", None)
        if callable(models_fn):
            served = models_fn()
    except Exception:
        served = None

    if not argument:
        if sys.stdin.isatty() and served:
            current = getattr(client, "model", None)
            chosen = _interactive_pick_model(served, current)
            if not chosen:
                tprint(c_dim("  (model selection cancelled)"))
                return SlashResult()
            argument = chosen
        else:
            tprint(c_yellow("  usage: /model <alias>"))
            return SlashResult()

    if isinstance(served, (list, tuple)) and argument not in served:
        tprint(c_red("  ✗ unknown model %r — try /models" % argument))
        return SlashResult()
    try:
        client.model = argument
    except Exception as exc:
        tprint(c_red("  ✗ model: %s" % exc))
        return SlashResult()
    tprint(c_green("  model → ") + c_bold(argument))
    save_session_config(model=argument)
    return SlashResult()


def _cmd_models(client, _history, _session, _argument):
    try:
        status_line("fetching served models…")
        models_fn = getattr(client, "models", None)
        if not callable(models_fn):
            tprint(c_red("  ✗ models: unavailable"))
            return SlashResult()
        models = models_fn()
    except Exception as exc:
        tprint(c_red("  ✗ models: %s" % exc))
        return SlashResult()
    if not isinstance(models, (list, tuple)):
        tprint(c_red("  ✗ models: unexpected response"))
        return SlashResult()
    current = getattr(client, "model", None)
    label = current or "(auto)"
    tprint(c_dim("  served models") + c_dim(" · current: ") + c_bold(str(label)))
    shown = False
    for alias in models:
        if not alias:
            continue
        shown = True
        if alias == current:
            tprint("   - %s%s" % (c_bold(str(alias)), c_green(" ● current")))
        else:
            tprint("   - %s" % alias)
    if not shown:
        tprint(c_dim("  (none served)"))
    elif current and current not in models:
        tprint(c_yellow("  current model %r is not in the served list" % current))
    return SlashResult()


def _cmd_web(client, history, _session, argument):
    if not argument:
        tprint(c_yellow("  usage: /web <question>"))
        return SlashResult()
    try:
        if history:
            history.append({"role": "user", "content": argument})
        from . import chat as chat_mod
        chat_mod.run_web_answer(client, argument)
    except Exception as exc:
        tprint(c_red("  ✗ %s" % exc))
    return SlashResult()


def _cmd_tools(_client, _history, _session, argument):
    try:
        from .agent_tools import TOOLS, help_lines
    except Exception as exc:
        tprint(c_red("  ✗ tools: %s" % exc))
        return SlashResult()
    tprint(c_dim("  agent tools: %d available" % len(TOOLS)))
    if not TOOLS:
        tprint(c_dim("  (none)"))
        return SlashResult()
    lines = help_lines(argument)
    if not lines:
        tprint(c_yellow("  no tools matched; /tools lists every category"))
    for line in lines:
        tprint("  " + line)
    return SlashResult()


def _cmd_system(client, history, _session, argument):
    argument = (argument or "").strip()
    if not argument:
        from .chat import DEFAULT_IDENTITY
        custom = getattr(client, "system", None)
        tprint(c_dim("  system prompt: ") + c_bold("custom" if custom else "default"))
        tprint(custom or DEFAULT_IDENTITY)
        tprint(c_dim("  Agent tool instructions are retained when agent mode is on."))
        tprint(c_dim("  usage: /system <text> | /system set <text> | /system clear | /system reset"))
        return SlashResult()

    action, _, value = argument.partition(" ")
    action = action.lower()
    if action == "set":
        value = value.strip()
        if not value:
            tprint(c_yellow("  usage: /system set <text>"))
            return SlashResult()
    elif action in ("clear", "reset") and not value:
        value = None
    else:
        value = argument

    try:
        client.system = value
        _refresh_system(history, client)
    except Exception as exc:
        tprint(c_red("  ✗ system: %s" % exc))
        return SlashResult()
    tprint(c_green("  system prompt ") + ("set" if value else "reset to default"))
    tprint(c_dim("  Agent tool instructions are retained when agent mode is on."))
    return SlashResult()


def _cmd_agent(client, history, _session, _argument):
    try:
        client.agent = not bool(getattr(client, "agent", False))
        _refresh_system(history, client)
    except Exception as exc:
        tprint(c_red("  ✗ agent: %s" % exc))
        return SlashResult()
    workpath = getattr(client, "workpath", "") or ""
    print(
        c_green("  agent mode ")
        + c_bold("on" if client.agent else "off")
        + c_dim(" (workpath: " + str(workpath) + ")")
    )
    return SlashResult()


def _cmd_workpath(client, history, _session, argument):
    if not argument:
        tprint(c_yellow("  usage: /workpath <dir>"))
        return SlashResult()
    try:
        target = os.path.abspath(os.path.expanduser(argument))
        if not os.path.isdir(target):
            tprint(c_red("  ✗ not a directory: " + target))
            return SlashResult()
        client.workpath = target
        _refresh_system(history, client)
    except Exception as exc:
        tprint(c_red("  ✗ workpath: %s" % exc))
        return SlashResult()
    tprint(c_green("  workpath → ") + c_bold(target))
    save_session_config(workpath=target)
    return SlashResult()


def _cmd_clear(client, history, session, _argument):
    try:
        if isinstance(history, list):
            history[:] = []
        if session is not None:
            session.last_prompt = None
        _refresh_system(history, client)
    except Exception as exc:
        tprint(c_red("  ✗ clear: %s" % exc))
        return SlashResult()
    tprint(c_green("  conversation cleared"))
    return SlashResult()


def _cmd_history(_client, history, _session, _argument):
    if not history:
        tprint(c_dim("  conversation is empty"))
        return SlashResult()
    for message in history:
        if not isinstance(message, dict):
            tprint(c_dim("  ?:"), str(message)[:200])
            continue
        role = str(message.get("role") or "?")
        content = message.get("content")
        text = "" if content is None else str(content)
        color = c_cyan if role == "user" else c_magenta
        tprint(color("  %s:" % role), text[:200].replace("\n", " "))
    return SlashResult()


def _cmd_retry(_client, history, session, _argument):
    prompt = None
    if session is not None and getattr(session, "last_prompt", None):
        prompt = session.last_prompt
    if not prompt:
        prompt = _last_real_user_text(history)
    if not prompt:
        tprint(c_yellow("  nothing to retry"))
        return SlashResult()
    preview = " ".join(str(prompt).split())
    if len(preview) > 80:
        preview = preview[:77] + "..."
    tprint(c_dim("  retrying: " + preview))
    return SlashResult(prompt=str(prompt))


def _cmd_undo(_client, history, _session, _argument):
    if not undo_last_exchange(history):
        tprint(c_yellow("  nothing to undo"))
        return SlashResult()
    tprint(c_green("  dropped last exchange"))
    return SlashResult()


def _cmd_compact(_client, history, _session, _argument):
    before = len(history) if isinstance(history, list) else 0
    changed, reason = compact_history(history)
    if not changed:
        tprint(c_yellow("  %s" % reason))
        return SlashResult()
    after = len(history) if isinstance(history, list) else before
    tprint(c_green("  history compacted") + c_dim(" (%d → %d messages)" % (before, after)))
    return SlashResult()


def _cmd_copy(_client, history, _session, _argument):
    text = _last_assistant_text(history)
    if not text:
        tprint(c_yellow("  nothing to copy"))
        return SlashResult()
    try:
        from . import terminal as term
        ok, detail = term.copy_to_clipboard(text)
    except Exception as exc:
        tprint(c_yellow("  ✗ could not copy: %s" % exc))
        return SlashResult()
    if not ok:
        tprint(c_yellow("  ✗ could not copy: %s" % (detail or "no clipboard available")))
        return SlashResult()
    tprint(c_green("  copied last answer"))
    return SlashResult()


def _cmd_save(_client, history, _session, argument):
    path = argument or ("reach-chat-%s.jsonl" % time.strftime("%Y%m%d-%H%M%S"))
    try:
        with open(path, "w", encoding="utf-8") as handle:
            for message in history or []:
                handle.write(json.dumps(message) + "\n")
    except (OSError, TypeError, ValueError) as exc:
        tprint(c_red("  ✗ could not save: %s" % exc))
        return SlashResult()
    tprint(c_green("  saved → ") + path)
    return SlashResult()


def _cmd_layout(_client, _history, _session, argument):
    """Show or switch the UI layout: centred column or full width."""
    from .splash import layout_mode, set_layout
    arg = (argument or "").strip().lower()
    if not arg:
        tprint(c_dim("  layout: %s — /layout center|full" % layout_mode()))
        return SlashResult()
    if set_layout(arg) is None:
        tprint(c_yellow("  usage: /layout center|full"))
        return SlashResult()
    try:
        save_session_config(layout=layout_mode())
    except Exception:
        pass
    tprint(c_green("  layout: %s" % layout_mode()))
    return SlashResult()


def _cmd_theme(_client, _history, _session, argument):
    """List, preview, select, or reset the app-local terminal palette."""
    from . import themes
    from . import terminal as term

    argument = (argument or "").strip()
    lowered = argument.casefold()
    if not argument or lowered == "list":
        active = themes.current_theme()
        tprint(c_dim("  available themes · app-local only"))
        for theme in themes.all_themes():
            marker = "  (current)" if theme.key == active.key else ""
            tprint("  %-34s %s" % (c_cyan(theme.name),
                                   (theme.note or "default terminal palette") + marker))
        tprint(c_dim("  /theme preview <name> shows colors without selecting"))
        tprint(c_dim("  /theme <name> saves selection · /theme reset returns to Default"))
        return SlashResult()

    if lowered == "current":
        tprint(c_dim("  current theme: ") + c_bold(themes.current_theme().name))
        return SlashResult()

    if lowered.startswith("preview"):
        parts = argument.split(None, 1)
        name = parts[1].strip() if len(parts) > 1 else ""
        theme = themes.get_theme(name)
        if theme is None:
            tprint(c_yellow("  usage: /theme preview <name> · see /themes"))
            return SlashResult(success=False)
        for line in themes.preview_lines(theme.key, color_enabled=term.PAINT.on):
            tprint(line)
        return SlashResult()

    requested = "default" if lowered == "reset" else argument
    theme = themes.get_theme(requested)
    if theme is None:
        tprint(c_yellow("  unknown theme %r · see /themes" % argument))
        return SlashResult(success=False)

    applied = themes.select_theme(theme.key)
    saved = save_session_config(theme=applied.key)
    try:
        from .chatbox import active_footer
        screen = active_footer()
        if screen is not None:
            screen.refresh_theme()
    except (ImportError, AttributeError, RuntimeError):
        pass

    if applied.key == "default":
        tprint(c_green("  theme reset to Default"))
    else:
        tprint(c_green("  theme → ") + c_bold(applied.name))
    if not saved:
        tprint(c_yellow("  applied for this session; could not save the theme in the config file"))
    return SlashResult()


def _cmd_exit(_client, _history, _session, _argument):
    return SlashResult(quit=True)


HANDLERS = {
    "/help": _cmd_help,
    "/status": _cmd_status,
    "/endpoint": _cmd_endpoint,
    "/endpoints": _cmd_endpoint,
    "/settings": _cmd_settings,
    "/model": _cmd_model,
    "/models": _cmd_models,
    "/web": _cmd_web,
    "/agent": _cmd_agent,
    "/tools": _cmd_tools,
    "/workpath": _cmd_workpath,
    "/system": _cmd_system,
    "/clear": _cmd_clear,
    "/history": _cmd_history,
    "/retry": _cmd_retry,
    "/undo": _cmd_undo,
    "/compact": _cmd_compact,
    "/copy": _cmd_copy,
    "/save": _cmd_save,
    "/layout": _cmd_layout,
    "/theme": _cmd_theme,
    "/themes": _cmd_theme,
    "/exit": _cmd_exit,
}


def _dispatch_slash(line, client, history, session):
    if not isinstance(line, str):
        line = "" if line is None else str(line)
    line = line.strip()
    if session is None:
        session = ReplSession()
    if not isinstance(history, list):
        history = []
    if not line.startswith("/"):
        return SlashResult()
    parts = line.split(None, 1)
    command = parts[0]
    argument = parts[1] if len(parts) > 1 else ""
    command = command.lower()
    argument = argument.strip()
    handler = HANDLERS.get(command)
    if handler is None:
        suggestion = suggest_command(command, command_tokens())
        tprint(c_yellow("  unknown command %r — did you mean %s?" % (command, suggestion)))
        return SlashResult(success=False)
    if client is None and command != "/help":
        tprint(c_red("  ✗ no session"))
        return SlashResult(success=False)
    result = handler(client, history, session, argument)
    if not isinstance(result, SlashResult):
        return SlashResult()
    return result


def handle_slash(line, client, history, session=None):
    """Dispatch once; schedule exactly one metadata refresh for endpoint commands.

    Handlers read cached discovery only. Scheduling here also covers aliases,
    invalid operations, cancelled prompts, and direct CLI calls through this
    dispatcher without issuing a second model-list request.
    """
    result = SlashResult(success=False)
    command = str(line or "").strip().split(None, 1)
    command = command[0].lower() if command else ""
    try:
        result = _dispatch_slash(line, client, history, session)
    except Exception:
        # Provider errors and malformed configuration can contain credentials.
        tprint(c_red("  command failed; check /settings and the configuration-file permissions"))
    finally:
        if command in ("/help", "/settings", "/endpoint", "/endpoints"):
            try:
                target = result.refresh_target or _current_refresh_target(client)
            except Exception:
                target = (_current_base(client) or LOCAL_ENDPOINT_URL, "", "")
            result.refresh_target = target
            try:
                from .discovery import MODEL_DISCOVERY
                result.discovery = MODEL_DISCOVERY.refresh(target[0], key=target[1], key_ref=target[2])
            except Exception:
                tprint(c_yellow("  model discovery could not start; cached settings are retained"))
    return result

