"""Slash commands: one registry, no provider alias, no endpoint fallback."""

import difflib
import json
import os
import subprocess
import sys
import urllib.parse

from .session import save_session_config
from .terminal import (
    c_bold,
    c_cyan,
    c_dim,
    c_green,
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
    ("/endpoint [url]", "show, list, or switch the endpoint"),
    ("/model <alias>", "switch model (aliases below)"),
    ("/models", "list models served by the endpoint"),
    ("/web <question>", "grounded search-and-answer (SimpleRAG websearch)"),
    ("/agent", "toggle agent mode (multi-round tool loop: read/search/shell/edit/web)"),
    ("/tools", "list the tools the agent can use"),
    ("/workpath <dir>", "set the directory the agent works in"),
    ("/system <text>", "set/clear the session system prompt"),
    ("/clear", "reset the conversation"),
    ("/history", "show the conversation so far"),
    ("/retry", "resend the last prompt"),
    ("/undo", "drop the last exchange"),
    ("/compact", "shrink the conversation history"),
    ("/copy", "copy the last answer to the clipboard"),
    ("/save [file]", "save the conversation as JSONL"),
    ("/layout <mode>", "centred page column or full-width UI"),
    ("/exit", "quit (Ctrl+D, or Ctrl+C twice)"),
)


# Help stays one column (`  %-16s %s`) and is grouped so the list is scannable.
# Every token appears in exactly one section.
HELP_SECTIONS = (
    ("session", ("/help", "/status", "/layout", "/exit")),
    ("endpoint", ("/endpoint", "/model", "/models")),
    ("chat", ("/web", "/retry", "/undo", "/compact", "/copy", "/clear", "/history", "/save")),
    ("agent", ("/agent", "/tools", "/workpath", "/system")),
)


class SlashResult(object):
    """What the chat loop should do after a slash command.

    ``quit`` ends the REPL. ``prompt`` is a user message to send (``/retry``).
    """

    def __init__(self, quit=False, prompt=None):
        self.quit = bool(quit)
        self.prompt = prompt


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


def print_help():
    """Grouped /help. Command lines keep the `  %-16s %s` column."""
    by_token = {}
    for spec, description in COMMANDS:
        by_token[spec.split()[0]] = (spec, description)
    shown = []
    for title, tokens in HELP_SECTIONS:
        print(c_dim("  " + title))
        for token in tokens:
            spec, description = by_token[token]
            print("  %-16s %s" % (c_cyan(spec), description))
            shown.append(token)
        print()
    for spec, description in COMMANDS:
        token = spec.split()[0]
        if token not in shown:
            print("  %-16s %s" % (c_cyan(spec), description))


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
    print_help()
    return SlashResult()


def _cmd_status(client, _history, _session, _argument):
    raw = _current_base(client) or "(none)"
    label = _endpoint_label(client)
    if label == "local":
        endpoint = "%s  (local)" % raw
    elif label == "(none)":
        endpoint = "(none)"
    else:
        endpoint = "%s  (%s)" % (raw, label)
    model = getattr(client, "model", None) or "(auto)"
    agent = "on" if getattr(client, "agent", False) else "off"
    workpath = getattr(client, "workpath", None) or "(none)"
    masked = _mask_key(getattr(client, "key", None))
    rows = (
        ("endpoint", endpoint),
        ("model", str(model)),
        ("agent", agent),
        ("workpath", str(workpath)),
        ("api key", masked),
    )
    for name, value in rows:
        print("  %-12s %s" % (c_dim(name), value))
    return SlashResult()


def _print_endpoints(client):
    status_line("resolving endpoints…")
    current_raw = _current_base(client)
    current = _normalize_endpoint_url(current_raw) or ""
    public = _public_endpoint_url()
    label = _endpoint_label(client)
    if label == "local":
        label = "local"
    elif public and current == public:
        label = "public"
    elif current:
        label = "custom"
    else:
        label = "(none)"
    shown = current_raw or "(none)"
    print(c_dim("  current: ") + c_bold(label) + "  " + shown)
    print(c_dim("  available:"))
    local_marker = c_green(" ●") if current == LOCAL_ENDPOINT_URL else ""
    print("   - local  %s%s" % (LOCAL_ENDPOINT_URL, local_marker))
    if public:
        public_marker = c_green(" ●") if current == public else ""
        print("   - public  %s%s" % (public, public_marker))
    else:
        print("   - public  " + c_dim("(pointer unavailable)"))
    if current and current != LOCAL_ENDPOINT_URL and current != public:
        print("   - custom  %s%s" % (current, c_green(" ●")))
    print(c_dim("  usage: /endpoint <local|public|url>"))


def _resolve_endpoint_argument(argument):
    """Return ('url', url), ('error', message), or ('unknown', None).

    A known name that cannot be resolved is an error, not a cue to try
    another endpoint.
    """
    lowered = argument.strip().lower()
    if lowered == "local":
        return ("url", LOCAL_ENDPOINT_URL)
    if lowered == "public":
        url = _public_endpoint_url()
        if not url:
            return ("error", "public pointer unavailable")
        return ("url", url)
    url = _normalize_endpoint_url(argument.strip())
    if url:
        return ("url", url)
    return ("unknown", None)


def _note_model_on_endpoint(client):
    model = getattr(client, "model", None)
    if not model:
        return
    models_fn = getattr(client, "models", None)
    if not callable(models_fn):
        return
    try:
        served = models_fn()
    except Exception:
        return
    if isinstance(served, (list, tuple)) and model not in served:
        print(c_yellow("  model %r is not served here — try /models" % model))


def _cmd_endpoint(client, _history, _session, argument):
    if not argument:
        try:
            _print_endpoints(client)
        except Exception as exc:
            print(c_red("  ✗ endpoint: %s" % exc))
        return SlashResult()
    kind, value = _resolve_endpoint_argument(argument)
    if kind == "unknown":
        print(c_red("  ✗ unknown endpoint %r" % argument))
        print(c_yellow("  usage: /endpoint <local|public|url>"))
        return SlashResult()
    if kind == "error":
        print(c_red("  ✗ %s" % value))
        print(c_dim("  stayed on %s" % (_current_base(client) or "(none)")))
        return SlashResult()
    url = value
    # Explicit switch only. The target was already resolved; do not call
    # resolve_base() or substitute a different endpoint when this one is down.
    status_line("checking endpoint…")
    if not _endpoint_reachable(client, url):
        print(c_red("  ✗ endpoint unreachable: %s" % url))
        print(c_dim("  stayed on %s" % (_current_base(client) or "(none)")))
        return SlashResult()
    client.base = url
    save_session_config(endpoint=url)
    print(c_green("  endpoint → ") + c_bold(url))
    _note_model_on_endpoint(client)
    return SlashResult()


def _cmd_model(client, _history, _session, argument):
    if not argument:
        print(c_yellow("  usage: /model <alias>"))
        return SlashResult()
    served = None
    try:
        status_line("checking served models…")
        models_fn = getattr(client, "models", None)
        if callable(models_fn):
            served = models_fn()
    except Exception:
        served = None
    if isinstance(served, (list, tuple)) and argument not in served:
        print(c_red("  ✗ unknown model %r — try /models" % argument))
        return SlashResult()
    try:
        client.model = argument
    except Exception as exc:
        print(c_red("  ✗ model: %s" % exc))
        return SlashResult()
    print(c_green("  model → ") + c_bold(argument))
    save_session_config(model=argument)
    return SlashResult()


def _cmd_models(client, _history, _session, _argument):
    try:
        status_line("fetching served models…")
        models_fn = getattr(client, "models", None)
        if not callable(models_fn):
            print(c_red("  ✗ models: unavailable"))
            return SlashResult()
        models = models_fn()
    except Exception as exc:
        print(c_red("  ✗ models: %s" % exc))
        return SlashResult()
    if not isinstance(models, (list, tuple)):
        print(c_red("  ✗ models: unexpected response"))
        return SlashResult()
    current = getattr(client, "model", None)
    label = current or "(auto)"
    print(c_dim("  served models") + c_dim(" · current: ") + c_bold(str(label)))
    shown = False
    for alias in models:
        if not alias:
            continue
        shown = True
        if alias == current:
            print("   - %s%s" % (c_bold(str(alias)), c_green(" ● current")))
        else:
            print("   - %s" % alias)
    if not shown:
        print(c_dim("  (none served)"))
    elif current and current not in models:
        print(c_yellow("  current model %r is not in the served list" % current))
    return SlashResult()


def _cmd_web(client, history, _session, argument):
    if not argument:
        print(c_yellow("  usage: /web <question>"))
        return SlashResult()
    try:
        if history:
            history.append({"role": "user", "content": argument})
        from . import chat as chat_mod
        chat_mod.run_web_answer(client, argument)
    except Exception as exc:
        print(c_red("  ✗ %s" % exc))
    return SlashResult()


def _cmd_tools(_client, _history, _session, _argument):
    try:
        from .agent_tools import TOOLS
    except Exception as exc:
        print(c_red("  ✗ tools: %s" % exc))
        return SlashResult()
    print(c_dim("  agent tools:"))
    if not TOOLS:
        print(c_dim("  (none)"))
        return SlashResult()
    for name, tool in TOOLS.items():
        approval = c_yellow(" (approval)") if tool.get("approval") else ""
        print("   - %s%s" % (c_cyan(name), approval))
        help_line = tool.get("help") or ""
        print(c_dim("     %s" % help_line))
    return SlashResult()


def _cmd_system(client, history, _session, argument):
    try:
        client.system = argument or None
        _refresh_system(history, client)
    except Exception as exc:
        print(c_red("  ✗ system: %s" % exc))
        return SlashResult()
    print(c_green("  system prompt ") + ("set" if getattr(client, "system", None) else "cleared"))
    return SlashResult()


def _cmd_agent(client, history, _session, _argument):
    try:
        client.agent = not bool(getattr(client, "agent", False))
        _refresh_system(history, client)
    except Exception as exc:
        print(c_red("  ✗ agent: %s" % exc))
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
        print(c_yellow("  usage: /workpath <dir>"))
        return SlashResult()
    try:
        target = os.path.abspath(os.path.expanduser(argument))
        if not os.path.isdir(target):
            print(c_red("  ✗ not a directory: " + target))
            return SlashResult()
        client.workpath = target
        _refresh_system(history, client)
    except Exception as exc:
        print(c_red("  ✗ workpath: %s" % exc))
        return SlashResult()
    print(c_green("  workpath → ") + c_bold(target))
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
        print(c_red("  ✗ clear: %s" % exc))
        return SlashResult()
    print(c_green("  conversation cleared"))
    return SlashResult()


def _cmd_history(_client, history, _session, _argument):
    if not history:
        print(c_dim("  conversation is empty"))
        return SlashResult()
    for message in history:
        if not isinstance(message, dict):
            print(c_dim("  ?:"), str(message)[:200])
            continue
        role = str(message.get("role") or "?")
        content = message.get("content")
        text = "" if content is None else str(content)
        color = c_cyan if role == "user" else c_magenta
        print(color("  %s:" % role), text[:200].replace("\n", " "))
    return SlashResult()


def _cmd_retry(_client, history, session, _argument):
    prompt = None
    if session is not None and getattr(session, "last_prompt", None):
        prompt = session.last_prompt
    if not prompt:
        prompt = _last_real_user_text(history)
    if not prompt:
        print(c_yellow("  nothing to retry"))
        return SlashResult()
    preview = " ".join(str(prompt).split())
    if len(preview) > 80:
        preview = preview[:77] + "..."
    print(c_dim("  retrying: " + preview))
    return SlashResult(prompt=str(prompt))


def _cmd_undo(_client, history, _session, _argument):
    if not undo_last_exchange(history):
        print(c_yellow("  nothing to undo"))
        return SlashResult()
    print(c_green("  dropped last exchange"))
    return SlashResult()


def _cmd_compact(_client, history, _session, _argument):
    before = len(history) if isinstance(history, list) else 0
    changed, reason = compact_history(history)
    if not changed:
        print(c_yellow("  %s" % reason))
        return SlashResult()
    after = len(history) if isinstance(history, list) else before
    print(c_green("  history compacted") + c_dim(" (%d → %d messages)" % (before, after)))
    return SlashResult()


def _cmd_copy(_client, history, _session, _argument):
    text = _last_assistant_text(history)
    if not text:
        print(c_yellow("  nothing to copy"))
        return SlashResult()
    try:
        from . import terminal as term
        ok, detail = term.copy_to_clipboard(text)
    except Exception as exc:
        print(c_yellow("  ✗ could not copy: %s" % exc))
        return SlashResult()
    if not ok:
        print(c_yellow("  ✗ could not copy: %s" % (detail or "no clipboard available")))
        return SlashResult()
    print(c_green("  copied last answer"))
    return SlashResult()


def _cmd_save(_client, history, _session, argument):
    path = argument or ("reach-chat-%s.jsonl" % time.strftime("%Y%m%d-%H%M%S"))
    try:
        with open(path, "w", encoding="utf-8") as handle:
            for message in history or []:
                handle.write(json.dumps(message) + "\n")
    except (OSError, TypeError, ValueError) as exc:
        print(c_red("  ✗ could not save: %s" % exc))
        return SlashResult()
    print(c_green("  saved → ") + path)
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


def _cmd_exit(_client, _history, _session, _argument):
    return SlashResult(quit=True)


HANDLERS = {
    "/help": _cmd_help,
    "/status": _cmd_status,
    "/endpoint": _cmd_endpoint,
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
    command, _, argument = line.partition(" ")
    command = command.lower()
    argument = argument.strip()
    handler = HANDLERS.get(command)
    if handler is None:
        suggestion = suggest_command(command, command_tokens())
        print(c_yellow("  unknown command %r — did you mean %s?" % (command, suggestion)))
        return SlashResult()
    if client is None and command != "/help":
        print(c_red("  ✗ no session"))
        return SlashResult()
    result = handler(client, history, session, argument)
    if not isinstance(result, SlashResult):
        return SlashResult()
    return result


def handle_slash(line, client, history, session=None):
    """Dispatch one REPL slash command. Never raises."""
    try:
        return _dispatch_slash(line, client, history, session)
    except Exception as exc:
        print(c_red("  ✗ " + str(exc)))
        return SlashResult()

