"""Terminal rendering: ANSI colours, spinners, status lines, banner."""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse

VERSION = "1.0.0"




class Paint:
    def __init__(self, enabled):
        self.on = enabled

    def __call__(self, code, text):
        if not self.on:
            return text
        return "\x1b[%sm%s\x1b[0m" % (code, text)


PAINT = Paint(False)
# Set when --color always forces paint, including over NO_COLOR.
COLOR_FORCED = False




def c_red(t):
    return PAINT("31", t)




def c_green(t):
    return PAINT("32", t)




def c_yellow(t):
    return PAINT("33", t)




def c_blue(t):
    return PAINT("34", t)




def c_magenta(t):
    return PAINT("35", t)




def c_cyan(t):
    return PAINT("36", t)




def c_bold(t):
    return PAINT("1", t)




def c_dim(t):
    return PAINT("2", t)




def c_inverse(t):
    return PAINT("7", t)




def spinner_char():
    return "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[int(time.time() * 10) % 10]




def banner(client, base, mode):
    """Startup splash. A TTY with colour gets the box; otherwise one plain line."""
    try:
        if _plain_chrome():
            print(plain_header(client, base, mode))
            return
        for line in render_banner_lines(client, base, mode):
            print(line)
    except Exception:
        try:
            print(plain_header(client, base, mode))
        except Exception:
            print("REACH CLI v" + VERSION)




def print_footer(client, cited=False):
    """Turn footer sized to the terminal.

    Stats come from ``client.last_turn`` (tokens, rounds, latency in seconds).
    Missing keys are left out. The signature stays ``(client, cited=False)``
    so the chat loop can keep calling it.
    """
    try:
        print(render_footer(client, cited=cited))
        print()
    except Exception as exc:
        print(c_red("  ✗ %s" % exc))



def response_label():
    """Inline label for an AI response: left rule + 'ai ▸' (no newline).

    Separated from response_open so the waiting indicator can re-emit the
    label after clearing its animated line.
    """
    return c_cyan("  │ ") + c_bold(c_magenta("ai ▸") + " ")


def response_open():
    """Opening rule for an AI response: blank line, border, 'ai ▸' label.
    The streamed body continues right after this."""
    sys.stdout.write("\n" + response_label())
    sys.stdout.flush()



def response_indent():
    """Left-rule prefix for continuation lines of a streamed reply."""
    return c_cyan("  │ ")




def spinner(message):
    sys.stdout.write("\r" + c_cyan(spinner_char()) + " " + message + "   ")
    sys.stdout.flush()




def spinner_clear():
    sys.stdout.write("\r" + " " * 60 + "\r")
    sys.stdout.flush()


class WaitIndicator:
    """Animated waiting line while a blocking call is in progress.

    Renders ``prefix + spinner + message + elapsed seconds`` on the current
    line until stop(). The first stop() clears back to ``prefix`` so the
    caller can stream tokens in place. Non-interactive stdout renders
    nothing, keeping piped output clean.
    """

    CR = chr(13)

    def __init__(self, prefix="", message="waiting for the model"):
        self._prefix = prefix
        self._message = message
        self._stop = threading.Event()
        self._started = False
        self._stopped = False
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        started = time.time()
        while not self._stop.is_set():
            self._frame(time.time() - started)
            self._stop.wait(0.1)

    def _frame(self, elapsed):
        glyph = spinner_char() if PAINT.on else "."
        label = "%s… %ds" % (self._message, int(elapsed))
        sys.stdout.write(
            self.CR + self._prefix + glyph + " " + c_dim(label) + "  "
        )
        sys.stdout.flush()

    def start(self):
        if not sys.stdout.isatty():
            return
        self._started = True
        self._thread.start()

    def _clear(self):
        sys.stdout.write(
            self.CR + self._prefix + " " * 80 + self.CR + self._prefix
        )
        sys.stdout.flush()

    def stop(self):
        if self._stopped:
            return
        self._stopped = True
        self._stop.set()
        if self._started:
            self._thread.join(timeout=1.0)
        if sys.stdout.isatty():
            self._clear()




def spin_while(message, seconds):
    """Animated wait for local work (page fetches are quick)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        spinner(message)
        time.sleep(0.08)
    spinner_clear()




def status_line(message):
    print(c_dim("  " + message))




def enable_ansi():
    if os.environ.get("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        os.system("")  # enable VT processing on Windows consoles
    return True


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
    ("/exit", "quit (Ctrl+D, or Ctrl+C twice)"),
)


# Help stays one column (`  %-16s %s`) and is grouped so the list is scannable.
# Every token appears in exactly one section.
HELP_SECTIONS = (
    ("session", ("/help", "/status", "/exit")),
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
    # Explicit switch only. The target was already resolved; do not substitute
    # a different endpoint when this one is down.
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
        ok, detail = copy_to_clipboard(text)
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


# ---- display width, splash, footer, prompt --------------------------------

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# 3-line block wordmark: SIGNAL, a dash, REACH. Each line is 47 columns
# when ambiguous characters are narrow (the usual Western terminal).
LOGO = (
    "█▀▀  █  █▀▀ █▄█ █▀█ █       █▀█ █▀▀ █▀█ █▀▀ █ █",
    "▀▀█  █  █ █ █▀█ █▀█ █   ─── █▀▄ █▀▀ █▀█ █   █▀█",
    "▀▀▀  █  ▀▀▀ █ █ ▀ ▀ █▄▄     ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀",
)

TIPS = (
    "/endpoint switches the relay. /help lists every command.",
    "End a line with \\ to continue. Ctrl-R searches history.",
    "Ctrl-C at an empty prompt warns once; press it again to quit.",
    "Tab completes /commands, and paths after /workpath.",
)

FOOTER_HINT = "? help · ^C stop · ^D quit"
BANNER_MAX_COLUMNS = 90

_READLINE_READY = False
_READLINE = None
_INTERRUPT_ARMED = False


def strip_ansi(text):
    return _ANSI_RE.sub("", "" if text is None else str(text))


def _ambiguous_is_wide():
    """Ambiguous East Asian width is wide in CJK locales and narrow otherwise."""
    lang = os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG") or ""
    lang = lang.upper().replace("-", "_")
    return any(tag in lang for tag in ("ZH", "JA", "JP", "KO", "CN", "TW", "HK"))


def char_width(ch):
    """Columns for one character, using unicodedata.east_asian_width."""
    if not ch:
        return 0
    code = ord(ch)
    if code < 32 or code == 127:
        return 0
    if unicodedata.combining(ch):
        return 0
    kind = unicodedata.east_asian_width(ch)
    if kind in ("W", "F"):
        return 2
    if kind == "A" and _ambiguous_is_wide():
        return 2
    return 1


def display_width(text):
    """Visible columns. ANSI colour codes do not count."""
    return sum(char_width(ch) for ch in strip_ansi(text))


def terminal_columns(default=80):
    try:
        cols = shutil.get_terminal_size(fallback=(default, 24)).columns
    except Exception:
        cols = default
    if not isinstance(cols, int) or cols < 20:
        return default if isinstance(default, int) and default >= 20 else 80
    return cols


def truncate_display(text, width):
    if width <= 0:
        return ""
    if display_width(text) <= width:
        return text
    ellipsis = "…"
    limit = width - char_width(ellipsis)
    if limit < 1:
        limit = width
        ellipsis = ""
    out = []
    used = 0
    for ch in text:
        needed = char_width(ch)
        if used + needed > limit:
            break
        out.append(ch)
        used += needed
    return "".join(out) + ellipsis


def banner_columns():
    cols = terminal_columns()
    if cols > BANNER_MAX_COLUMNS:
        return BANNER_MAX_COLUMNS
    return cols


def _plain_chrome():
    """Plain header when stdout is not a terminal, or colour is off.

    NO_COLOR flattens the splash too, unless ``--color always`` set
    COLOR_FORCED. A non-TTY is always one line, even when paint is on.
    """
    try:
        interactive = bool(sys.stdout.isatty())
    except Exception:
        interactive = False
    if not interactive:
        return True
    if os.environ.get("NO_COLOR") and not COLOR_FORCED:
        return True
    return not PAINT.on


def plain_header(client, base, mode):
    """Single line used when colour or a TTY is unavailable."""
    model = "(auto)"
    if client is not None and getattr(client, "model", None):
        model = str(client.model)
    url = base or (_current_base(client) if client is not None else "") or "(none)"
    mode_label = "agent" if client is not None and getattr(client, "agent", False) else (mode or "chat")
    text = "REACH CLI v%s · RAG Endpoint & AI Chat Host · %s · %s · %s" % (
        VERSION, model, url, mode_label)
    cols = terminal_columns()
    if display_width(text) > cols:
        text = truncate_display(text, cols)
    return text


def git_branch(cwd=None):
    """Current git branch, or None. Never raises."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd or None,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    try:
        name = proc.stdout.decode("utf-8", "replace").strip()
    except Exception:
        return None
    if not name or name == "HEAD":
        return name or None
    return name


def endpoint_label_for(url):
    """Short label for an endpoint URL. Does not contact the network."""
    norm = _normalize_endpoint_url(url or "") or ""
    if not norm:
        return "(none)"
    if norm == LOCAL_ENDPOINT_URL:
        return "local"
    parsed = urllib.parse.urlparse(norm)
    return parsed.netloc or "custom"


def current_tip(index=None):
    if index is None:
        index = time.localtime().tm_yday
    return TIPS[int(index) % len(TIPS)]


def _horizontal(width, left, mid, right):
    side = char_width(left) + char_width(right)
    fill = max(0, width - side)
    unit = char_width(mid) or 1
    count = fill // unit
    extra = fill - count * unit
    return left + (mid * count) + (" " * extra) + right


def _row_colored(content, width):
    left, right = "│", "│"
    inner = max(0, width - char_width(left) - char_width(right))
    visible = display_width(content)
    if visible > inner:
        content = truncate_display(strip_ansi(content), inner)
        visible = display_width(content)
    pad = inner - visible
    if pad < 0:
        pad = 0
    return c_cyan(left) + content + (" " * pad) + c_cyan(right)


def _logo_lines(inner):
    raw = list(LOGO)
    if any(display_width(line) > max(0, inner - 2) for line in raw):
        raw = ["SIGNAL", "───", "REACH"]
    return ["  " + line for line in raw]


def _version_content():
    ident = "⚡ REACH CLI v%s" % VERSION
    tag = " · RAG Endpoint & AI Chat Host"
    return c_bold(c_yellow(ident)) + c_dim(tag)


def _tip_content(index=None):
    return c_yellow("● Tip") + c_dim("  " + current_tip(index))


def _mode_label(client, mode):
    if client is not None and getattr(client, "agent", False):
        return "agent"
    return mode or "chat"


def session_facts(client, base, mode):
    url = base or (_current_base(client) if client is not None else "") or "(none)"
    if not isinstance(url, str):
        url = str(url)
    name = endpoint_label_for(url)
    model = "(auto)"
    if client is not None and getattr(client, "model", None):
        model = str(client.model)
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = "(unknown)"
    branch = git_branch(None if cwd == "(unknown)" else cwd) or "(none)"
    if name in ("(none)",):
        endpoint = url or "(none)"
    else:
        endpoint = "%s · %s" % (name, url)
    return (
        ("endpoint", endpoint),
        ("model", model),
        ("mode", _mode_label(client, mode)),
        ("cwd", cwd),
        ("git", branch),
    )


def render_banner_lines(client, base, mode, tip_index=None):
    width = banner_columns()
    inner = max(0, width - 2 * char_width("│"))
    lines = [c_cyan(_horizontal(width, "┌", "─", "┐"))]
    for logo in _logo_lines(inner):
        lines.append(_row_colored(logo, width))
    lines.append(_row_colored("", width))
    lines.append(_row_colored("  " + _version_content(), width))
    lines.append(_row_colored("  " + _tip_content(tip_index), width))
    lines.append(c_cyan(_horizontal(width, "├", "─", "┤")))
    for label, value in session_facts(client, base, mode):
        text = "  " + label.ljust(8) + "  " + value
        # Colour the label only; keep the value plain so padding stays honest.
        colored = "  " + c_green(label.ljust(8)) + "  " + value
        if display_width(text) > inner:
            colored = "  " + c_green(label.ljust(8)) + "  " + truncate_display(
                value, max(0, inner - display_width("  " + label.ljust(8) + "  ")))
        lines.append(_row_colored(colored, width))
    lines.append(c_cyan(_horizontal(width, "└", "─", "┘")))
    return lines


def _format_tokens(value):
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    if count < 0:
        return None
    if count < 1000:
        return "%d tok" % count
    if count < 10000:
        text = "%.1f" % (count / 1000.0)
        if text.endswith(".0"):
            text = text[:-2]
        return text + "k tok"
    if count < 1000000:
        return "%dk tok" % (count // 1000)
    text = "%.1f" % (count / 1000000.0)
    if text.endswith(".0"):
        text = text[:-2]
    return text + "M tok"


def _format_rounds(value):
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    if count < 0:
        return None
    if count == 1:
        return "1 round"
    return "%d rounds" % count


def _format_latency(value):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds < 0:
        return None
    if seconds < 10:
        return "%.1fs" % seconds
    return "%.0fs" % seconds


def render_footer(client, cited=False, columns=None):
    """Plain-coloured footer line. Left stats, right hint, padded to ``columns``."""
    model = "auto"
    url = ""
    if client is not None:
        if getattr(client, "model", None):
            model = str(client.model)
        url = _current_base(client)
    label = endpoint_label_for(url) if url else "(none)"
    parts = [model, label]
    turn = getattr(client, "last_turn", None) if client is not None else None
    if isinstance(turn, dict):
        if "tokens" in turn:
            text = _format_tokens(turn.get("tokens"))
            if text:
                parts.append(text)
        if "rounds" in turn:
            text = _format_rounds(turn.get("rounds"))
            if text:
                parts.append(text)
        if "latency" in turn:
            text = _format_latency(turn.get("latency"))
            if text:
                parts.append(text)
        elif "latency_ms" in turn:
            try:
                text = _format_latency(float(turn.get("latency_ms")) / 1000.0)
            except (TypeError, ValueError):
                text = None
            if text:
                parts.append(text)
    if cited:
        parts.append("grounded")
    left = "  └─ " + " · ".join(parts)
    right = FOOTER_HINT
    cols = columns if isinstance(columns, int) and columns >= 20 else terminal_columns()
    gap = cols - display_width(left) - display_width(right)
    if gap >= 1:
        return c_cyan(left) + (" " * gap) + c_dim(right)
    room = cols - display_width(right) - 1
    if room < 4:
        return c_dim(truncate_display(right, cols))
    left = truncate_display(left, room)
    gap = cols - display_width(left) - display_width(right)
    return c_cyan(left) + (" " * max(1, gap)) + c_dim(right)


def session_config_path():
    override = os.environ.get("REACH_CLI_CONFIG")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".config", "reach-cli", "config.json")


def history_file_path():
    override = os.environ.get("REACH_CLI_HISTORY")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".reach_cli_history")


def load_session_config(path=None):
    """Return saved endpoint/model/workpath. Corrupt files yield {}."""
    path = path or session_config_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    clean = {}
    for key in ("endpoint", "model", "workpath"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            clean[key] = value.strip()
    return clean


def save_session_config(endpoint=None, model=None, workpath=None, path=None):
    """Merge session fields and write them. Returns False instead of raising."""
    path = path or session_config_path()
    try:
        current = load_session_config(path)
        updates = {"endpoint": endpoint, "model": model, "workpath": workpath}
        for key, value in updates.items():
            if isinstance(value, str) and value.strip():
                current[key] = value.strip()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(current, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
        return True
    except Exception:
        return False


def apply_saved_session(client, args, path=None):
    """Apply ~/.config/reach-cli/config.json where flags were not passed."""
    saved = load_session_config(path)
    if not saved:
        print(c_yellow("  no saved session — starting fresh"))
        return saved
    if client is None:
        return saved
    if not getattr(args, "base", None) and saved.get("endpoint"):
        try:
            client.base = saved["endpoint"].rstrip("/")
        except Exception:
            pass
    if not getattr(args, "model", None) and saved.get("model"):
        try:
            client.model = saved["model"]
        except Exception:
            pass
    if not getattr(args, "workpath", None) and saved.get("workpath"):
        folder = os.path.abspath(os.path.expanduser(saved["workpath"]))
        if os.path.isdir(folder):
            try:
                client.workpath = folder
            except Exception:
                pass
        else:
            print(c_yellow("  saved workpath is missing: %s" % folder))
    return saved


def reset_prompt_interrupt():
    global _INTERRUPT_ARMED
    _INTERRUPT_ARMED = False


def reset_readline_state():
    global _READLINE_READY, _READLINE
    _READLINE_READY = False
    _READLINE = None


def load_readline():
    """GNU readline, or pyreadline3 on Windows. None when neither imports."""
    try:
        import readline
        return readline
    except ImportError:
        pass
    if os.name == "nt":
        try:
            import pyreadline3 as readline
            return readline
        except ImportError:
            return None
    return None


def _install_readline(readline_mod):
    global _READLINE_READY, _READLINE
    if readline_mod is None:
        return False
    if _READLINE_READY and _READLINE is readline_mod:
        return True
    try:
        readline_mod.parse_and_bind("set editing-mode emacs")
        readline_mod.parse_and_bind("tab: complete")
        readline_mod.parse_and_bind('"\\C-r": reverse-search-history')
        readline_mod.set_completer(_readline_complete)
        readline_mod.set_completer_delims(" \t\n")
        readline_mod.set_history_length(1000)
        path = history_file_path()
        if path and os.path.isfile(path):
            readline_mod.read_history_file(path)
        _READLINE = readline_mod
        _READLINE_READY = True
        return True
    except Exception:
        return False


def _persist_readline(readline_mod):
    if readline_mod is None:
        return
    try:
        path = history_file_path()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        readline_mod.write_history_file(path)
    except Exception:
        pass


def _readline_complete(text, state):
    try:
        mod = load_readline()
        buffer = mod.get_line_buffer() if mod is not None else ""
        matches = complete_token(text, buffer)
    except Exception:
        return None
    if state < len(matches):
        return matches[state]
    return None


def complete_token(text, buffer):
    """Tab matches: /commands from the registry, or paths after /workpath."""
    text = "" if text is None else str(text)
    buffer = "" if buffer is None else str(buffer)
    stripped = buffer.lstrip()
    if stripped.startswith("/workpath ") or stripped.startswith("/workpath\t"):
        return _complete_paths(text)
    if text.startswith("/") or stripped.startswith("/"):
        return [token for token in command_tokens() if token.startswith(text)]
    return []


def _complete_paths(text):
    raw = "" if text is None else str(text)
    try:
        expanded = os.path.expanduser(raw)
        if raw.endswith("/") or raw.endswith(os.sep):
            directory = expanded or "."
            stem = ""
            typed_dir = raw
        elif raw == "":
            directory = "."
            stem = ""
            typed_dir = ""
        else:
            directory = os.path.dirname(expanded) or "."
            stem = os.path.basename(expanded)
            leaf = os.path.basename(raw)
            typed_dir = raw[:len(raw) - len(leaf)]
        names = os.listdir(directory)
    except Exception:
        return []
    matches = []
    for name in sorted(names):
        if name.startswith(".") and not stem.startswith("."):
            continue
        if stem and not name.startswith(stem):
            continue
        full = os.path.join(directory, name)
        try:
            suffix = "/" if os.path.isdir(full) else ""
        except OSError:
            suffix = ""
        matches.append(typed_dir + name + suffix)
    return matches


def prompt_rule(client):
    """Top rule framing the input line: ``┌─ <model> ───┐``."""
    model = "auto"
    if client is not None and getattr(client, "model", None):
        model = " ".join(str(client.model).split()) or "auto"
    if display_width(model) > 40:
        model = truncate_display(model, 40)
    return c_cyan("┌─ %s ───┐" % model)


def _interrupt_armed(session):
    if session is not None and getattr(session, "interrupt_armed", None) is not None:
        return bool(session.interrupt_armed)
    return _INTERRUPT_ARMED


def _set_interrupt(session, value):
    global _INTERRUPT_ARMED
    _INTERRUPT_ARMED = bool(value)
    if session is not None:
        try:
            session.interrupt_armed = bool(value)
        except Exception:
            pass


def read_prompt(client=None, session=None):
    """Read the next user turn. The chat loop should call this instead of input().

    Returns a string to handle (empty means ask again) or None to leave the
    REPL. None means EOF or the second Ctrl-C, and ``bye.`` is already
    printed — the caller should not print it again.

    A trailing backslash continues onto the next line. Two trailing
    backslashes are a literal backslash and do not continue. Readline, when
    it imports, persists ``~/.reach_cli_history``, completes /commands and
    /workpath paths on Tab, and binds Ctrl-R to reverse-search. pyreadline3
    is the optional Windows module. With neither installed, input() is used.
    """
    try:
        return _read_prompt(client, session)
    except Exception as exc:
        print(c_red("  ✗ %s" % exc))
        return ""


def _read_prompt(client, session):
    readline_mod = load_readline()
    _install_readline(readline_mod)
    print(prompt_rule(client))
    chunks = []
    first = True
    while True:
        prompt = c_bold(c_green("you ▸ ")) if first else c_dim("... ")
        try:
            line = input(prompt)
        except KeyboardInterrupt:
            if _interrupt_armed(session):
                _set_interrupt(session, False)
                print(c_dim("\n  bye."))
                return None
            _set_interrupt(session, True)
            print(c_yellow("\n  Ctrl-C again to quit · /exit or Ctrl-D also quits"))
            return ""
        except EOFError:
            _set_interrupt(session, False)
            if chunks:
                break
            print(c_dim("\n  bye."))
            return None
        if not isinstance(line, str):
            line = "" if line is None else str(line)
        _set_interrupt(session, False)
        if line.endswith("\\\\"):
            chunks.append(line[:-1])
            break
        if line.endswith("\\"):
            chunks.append(line[:-1])
            first = False
            continue
        chunks.append(line)
        break
    text = "\n".join(chunks)
    _remember_history(text, readline_mod)
    return text


def _remember_history(text, readline_mod):
    """Persist the turn. Readline writes its own file; input() appends a line."""
    if not isinstance(text, str) or not text.strip():
        return
    if readline_mod is not None and _READLINE_READY:
        _persist_readline(readline_mod)
        return
    try:
        path = history_file_path()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        flat = " ".join(part.strip() for part in text.splitlines() if part.strip())
        if not flat:
            return
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(flat + "\n")
    except Exception:
        pass
