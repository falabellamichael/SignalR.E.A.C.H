"""Chat modes: interactive REPL, one-shot ask, grounded web answer."""

import inspect
import json
import os
import re
import sys
import threading
import time
import urllib.parse

from .agent_tools import (
    DEFAULT_TOOL_NAMES,
    TOOLS,
    cleanup_owned_processes,
    edit_diff,
    format_args,
    summarize_result,
    parse_tool_arguments,
    run_tool,
    tool_help_text,
    tool_schemas,
)
from .client import ReachApiError, ReachTransientError, usage_tokens
from . import render, terminal
from .grounding import build_grounded_messages
from .terminal import (
    ReplSession,
    WaitIndicator,
    banner,
    c_bold,
    c_cyan,
    c_dim,
    c_green,
    c_magenta,
    c_red,
    c_yellow,
    handle_slash,
    print_footer,
    response_indent,
    response_label,
    response_open,
    spinner,
    spinner_clear,
    status_line,
    tprint,
)
from .websearch import PAGE_FETCH_LIMIT, fetch_text, search_web


# ---- agent mode -----------------------------------------------------------

DEFAULT_IDENTITY = (
    "You are SimpleREACH, the REACH coding assistant."
)

AGENT_SYSTEM_PROMPT = (
    "You are SimpleREACH, an agentic coding assistant. You operate inside a "
    "directory called the workpath and act through local tools.\n\n"
    "The local file tools are available to you. For requests to inspect or "
    "improve this workspace, use list or glob to discover relevant files, "
    "then read or search them before drawing conclusions. Use relative paths "
    "within the workpath. Do not ask the user to paste files or choose tools "
    "when those tools can resolve the request. Ask only for a decision or "
    "missing information that inspection cannot resolve.\n\n"
    "TOOLS:\n"
    + tool_help_text()
    + "\n\nUse the provided native function tools when available. If native "
    "tools are unavailable, emit one standalone fenced tool block as your "
    "whole reply (one action per turn). Use tool_discover to search and "
    "activate additional tools before calling them:\n"
    '```tool\n{"action": "search", "pattern": "def \\w+", "regex": true}\n```\n'
    "After every tool block you receive a [tool result] message. React to it "
    "with the next action. Never guess what a tool returned. Before starting a "
    "multi-step task, write a plan with todo_write and keep it updated.\n\n"
    "RUN CONTROL (required; ordinary prose never ends the task):\n"
    "When the request is fully handled (plan complete, edits applied, changes "
    "verified with shell where possible), finish with exactly:\n"
    '```agent_status\n{"status": "complete", "summary": "What was done and how it was verified."}\n```\n'
    "If you need a decision from the user, stop with:\n"
    '```agent_status\n{"status": "blocked", "reason": "The question or decision needed from the user."}\n```\n'
    "Do not claim completion while work remains."
)


_EDIT_FENCE = re.compile(r"```edit\s*\n(.*?)```", re.DOTALL)


def parse_edit_blocks(text):
    """Return [{path, search, replace}] for every ```edit block in ``text``."""
    blocks = []
    for raw in _EDIT_FENCE.findall(text or ""):
        try:
            data = json.loads(raw.strip())
        except (ValueError, AttributeError):
            continue
        if not isinstance(data, dict):
            continue
        path = str(data.get("path") or "").strip()
        if not path:
            continue
        blocks.append(
            {
                "path": path.replace("\\", "/"),
                "search": str(data.get("search", "")),
                "replace": str(data.get("replace", "")),
            }
        )
    return blocks


def _safe_rel(path):
    rel = (path or "").replace("\\", "/")
    if not rel or rel.startswith("/") or re.match(r"^[a-zA-Z]:", rel):
        return None
    if any(part == ".." for part in rel.split("/")):
        return None
    return rel


def apply_edit(workpath, path, search, replace):
    """Apply one edit inside ``workpath``. Returns (ok, error)."""
    rel = _safe_rel(path)
    if rel is None:
        return False, "invalid path: %s" % path
    target = os.path.join(workpath, *rel.split("/"))
    try:
        if not os.path.exists(target):
            if search != "":
                return (
                    False,
                    rel + " does not exist (use empty search to create it)",
                )
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(replace)
            return True, None
        if search == "":
            return (
                False,
                rel + " already exists (empty search only allowed when creating a file)",
            )
        with open(target, "r", encoding="utf-8") as handle:
            current = handle.read()
        idx = current.find(search)
        if idx == -1:
            return (
                False,
                "search text not found in " + rel + " — the file may have changed",
            )
        new_text = current[:idx] + replace + current[idx + len(search):]
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(new_text)
        return True, None
    except OSError as exc:
        return False, str(exc)


def review_and_apply_edits(workpath, text, auto_yes=False):
    """Prompt for approval on each ```edit block; return the count applied."""
    blocks = parse_edit_blocks(text)
    if not blocks:
        return 0
    print()
    for block in blocks:
        tprint(c_bold(c_cyan("  agent edit:")), c_bold(block["path"]))
        if block["search"]:
            tprint(c_dim("    search:  ") + c_dim(block["search"][:90]))
        tprint(c_dim("    replace: ") + c_dim(block["replace"][:90]))
    print()
    applied = 0
    for block in blocks:
        if auto_yes:
            answer = "y"
        else:
            try:
                answer = terminal.read_input(
                    c_bold(c_yellow("  apply to %s? [y/n/a/q] " % block["path"]))
                ).strip().lower()
            except (EOFError, KeyboardInterrupt):
                print()
                answer = "n"
            if answer == "a":
                auto_yes = True
                answer = "y"
            elif answer == "q":
                break
        if answer not in ("y", "yes"):
            tprint(c_dim("    skipped %s" % block["path"]))
            continue
        ok, error = apply_edit(workpath, block["path"], block["search"], block["replace"])
        if ok:
            applied += 1
            tprint(c_green("    ✓ applied %s" % block["path"]))
        else:
            tprint(c_red("    ✗ %s" % error))
    return applied


def workpath_context(workpath):
    try:
        entries = sorted(os.listdir(workpath))[:120]
    except OSError:
        return workpath
    return "\n".join(
        os.path.join(workpath, e).replace("\\", "/") for e in entries
    )


def build_system(client, state=None):
    parts = []
    parts.append(client.system or DEFAULT_IDENTITY)
    if client.agent:
        parts.append(
            AGENT_SYSTEM_PROMPT
            + "\n\nThe workpath is: "
            + client.workpath
            + "\n\nFiles in the workpath:\n"
            + workpath_context(client.workpath)
        )
        if state is not None and state.selected_tools:
            # The text protocol sees the same active extra capabilities as
            # native calling; a large registry never fills every prompt.
            active = [name for name in TOOLS if name in state.selected_tools]
            if active:
                parts.append("ADDITIONAL ACTIVE TOOLS (native or fenced):\n"
                             + tool_help_text(active))
    return "\n\n".join(parts)


def set_system_message(history, client, state=None):
    prompt = build_system(client, state)
    history[:] = [m for m in history if m.get("role") != "system"]
    if prompt:
        history.insert(0, {"role": "system", "content": prompt})


# ---- resilient requests ----------------------------------------------------

MAX_ATTEMPTS = 4
BACKOFF_BASE = 1.0
BACKOFF_CAP = 8.0
_sleep = time.sleep  # patched in tests

_CONTINUE_PROMPT = (
    "[run control] Your previous reply was cut off by a connection drop. "
    "Continue exactly where it stopped; do not repeat earlier text."
)


def _backoff(attempt):
    return min(BACKOFF_CAP, BACKOFF_BASE * (2 ** (attempt - 1)))


def _complete_tool_calls(calls):
    """Tool calls whose arguments decode cleanly (safe to keep after a cut)."""
    return [c for c in calls or []
            if parse_tool_arguments(c["function"].get("arguments"))[1] is None]


def _unsupported_native_tools(exc):
    """Only a clear request-level capability rejection permits text fallback."""
    if getattr(exc, "status", None) not in (400, 422):
        return False
    message = str(exc).lower()
    noun = r"(?:tools?|tool_choice|function(?:s| calling|_calling)?)"
    patterns = (
        noun + r"\s+(?:are\s+|is\s+)?(?:not supported|unsupported|not permitted|not allowed)\b",
        r"(?:does not|doesn't|cannot)\s+support\s+" + noun + r"\b",
        r"(?:unsupported|unknown|unrecognized|unexpected|disallowed)\s+"
        r"(?:request\s+)?(?:parameter|field|argument|feature)\s*[:=]?\s*[\"']?" + noun + r"\b",
    )
    return any(re.search(pattern, message) for pattern in patterns)


def request_reply(client, messages, tools=None, on_text=None, on_retry=None,
                  cancelled=None):
    """Ask the endpoint with retries on the SAME provider and model.

    Returns (ok, {"content", "tool_calls"}). Transient failures back off and
    retry; text already streamed is kept and the model is asked to continue,
    so a cut stream never loses work. Never touches client.model/base.
    """
    if (getattr(client, "supports_tools", None) is False
            or getattr(client, "_unsupported_tools_endpoint", None) == (
                getattr(client, "base", None), getattr(client, "model", None))):
        tools = None
    kept_text = ""
    last = None
    attempts = 0
    text_started = False
    fallback_used = False

    def observe_text(delta):
        nonlocal text_started
        if delta:
            text_started = True
        if on_text:
            on_text(delta)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if cancelled is not None and cancelled.is_set():
            return False, {"content": kept_text, "tool_calls": [], "stopped": True}
        convo = list(messages)
        if kept_text:
            convo += [{"role": "assistant", "content": kept_text},
                      {"role": "user", "content": _CONTINUE_PROMPT}]
        attempts = attempt
        try:
            try:
                result = client.complete(convo, tools=tools, on_text=observe_text if on_text else None)
            except ReachApiError as exc:
                partial = getattr(exc, "partial", None) or {}
                if (not tools or fallback_used or text_started or kept_text
                        or (isinstance(partial, dict) and (
                            partial.get("content") or partial.get("tool_calls")))
                        or not _unsupported_native_tools(exc)):
                    raise
                if cancelled is not None and cancelled.is_set():
                    return False, {"content": kept_text, "tool_calls": [], "stopped": True}
                # This request was rejected before producing text or actions.
                # Retry once with the same endpoint/model and the existing
                # fenced protocol; remember only this endpoint/model pairing.
                fallback_used = True
                tools = None
                client._unsupported_tools_endpoint = (
                    getattr(client, "base", None), getattr(client, "model", None))
                result = client.complete(convo, tools=None,
                                         on_text=observe_text if on_text else None)
            return True, {"content": kept_text + (result.get("content") or ""),
                          "tool_calls": result.get("tool_calls") or []}
        except ReachTransientError as exc:
            last = exc
            got = exc.partial or {}
            kept_text += got.get("content") or ""
            if cancelled is not None and cancelled.is_set():
                return False, {"content": kept_text, "tool_calls": [], "stopped": True}
            calls = _complete_tool_calls(got.get("tool_calls"))
            if calls:  # the call(s) arrived whole before the cut: use them
                return True, {"content": kept_text, "tool_calls": calls}
            if attempt < MAX_ATTEMPTS:
                if on_retry:
                    on_retry(attempt + 1)
                # Short sleeps keep a stopped worker from starting another
                # request, including when Ctrl-C arrives during backoff.
                remaining = _backoff(attempt)
                while remaining > 0:
                    if cancelled is not None and cancelled.is_set():
                        return False, {"content": kept_text, "tool_calls": [], "stopped": True}
                    delay = min(remaining, 0.1) if cancelled is not None else remaining
                    _sleep(delay)
                    remaining -= delay
                continue
        except ReachApiError as exc:
            last = exc
            break
        except Exception as exc:  # never let an unexpected error escape
            last = exc
            break
    # Partial text is recovery context, not a successful completion.
    # Never execute a cut-off fenced tool block after exhausting retries.
    return False, {"content": kept_text, "tool_calls": [], "error": str(last or ""),
                   "reason": failure_reason(last, getattr(client, "base", "")),
                   "attempts": attempts,
                   "retryable": isinstance(last, ReachTransientError)}


def _host_port(base):
    try:
        parsed = urllib.parse.urlparse(base or "")
    except ValueError:
        return ""
    if not parsed.hostname:
        return ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return "%s:%s" % (parsed.hostname, port)


def failure_reason(exc, base=""):
    """A short plain reason for a failed request, e.g. 'rate limited (429)'."""
    status = getattr(exc, "status", None)
    if status == "timeout":
        return "timed out"
    if status == "unreachable":
        where = _host_port(base)
        return "endpoint unreachable (%s)" % where if where else "endpoint unreachable"
    if status == "cut":
        return "stream cut off"
    if isinstance(status, int):
        if status in (401, 403):
            return "auth rejected (%d)" % status
        if status == 404:
            return "model not available (404)"
        if status == 429:
            return "rate limited (429)"
        if status == 408:
            return "timed out (408)"
        if status >= 500:
            return "endpoint unavailable (%d)" % status
        return "request rejected (%d)" % status
    if isinstance(exc, ReachTransientError):
        return "endpoint unavailable"
    return "unexpected client error"


def _calm_failure(result=None):
    result = result or {}
    attempts = result.get("attempts") or 0
    reason = result.get("reason") or "unexpected client error"
    if attempts > 1:
        reason += ", after %d tries" % attempts
    elif attempts == 1 and not result.get("retryable"):
        reason += ", not retried"
    elif attempts == 1:
        reason += ", after 1 try"
    outcome = "the answer is incomplete" if result.get("content") else "the model didn't answer"
    tprint(c_red("  ✗ %s: %s — "
                "send your message again or /retry" % (outcome, reason)))


class TurnMeter:
    """Collects tokens/latency for one user turn and publishes client.last_turn."""

    def __init__(self, client):
        self.client = client
        self.started = time.time()
        self.tokens = None
        self.rounds = 0
        self.published = None

    def add_round(self):
        self.rounds += 1
        got = usage_tokens(getattr(self.client, "usage", None))
        if got is not None:
            self.tokens = (self.tokens or 0) + got

    def publish(self):
        if self.published is not None:
            return self.published
        turn = {
            "rounds": max(1, self.rounds),
            "latency": round(time.time() - self.started, 3),
        }
        if self.tokens is not None:  # contract: omit unknown keys
            turn["tokens"] = self.tokens
        self.client.last_turn = turn
        totals = getattr(self.client, "session_totals", None)
        if not isinstance(totals, dict):
            totals = {"turns": 0, "tokens": 0, "rounds": 0, "latency": 0.0}
            self.client.session_totals = totals
        totals["turns"] = totals.get("turns", 0) + 1
        totals["rounds"] = totals.get("rounds", 0) + turn["rounds"]
        totals["latency"] = totals.get("latency", 0.0) + turn["latency"]
        if self.tokens is not None:
            totals["tokens"] = totals.get("tokens", 0) + self.tokens
        self.published = turn
        return turn


def _reader_arity(reader):
    """How many positional args read_prompt takes (2 = current contract)."""
    try:
        params = inspect.signature(reader).parameters.values()
    except (TypeError, ValueError):
        return 2
    if any(p.kind == p.VAR_POSITIONAL for p in params):
        return 2
    return len([p for p in params
                if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)])


def read_user_line(client=None, session=None):
    """Next user line: a str (``""`` = ask again) or None = leave the REPL.

    Contract with terminal.read_prompt(client, session): ``""`` means a blank
    line or a first Ctrl-C whose hint is already printed; None means EOF or a
    second Ctrl-C and ``bye.`` is already printed. Without read_prompt (or
    with an old zero-arg one) EOF/Ctrl-C print ``bye.`` here and return None.
    """
    reader = getattr(terminal, "read_prompt", None)
    try:
        if callable(reader):
            if _reader_arity(reader) >= 2:
                return reader(client, session)
            line = reader()  # old zero-arg hook
            return "" if line is None else line
        return input(c_bold(c_green("you ▸ ")))
    except (EOFError, KeyboardInterrupt):
        tprint(c_dim("\n  bye."))
        return None


def _interruptible(fn, poll=0.1):
    """Run ``fn`` in a worker thread; the main thread waits in short slices.

    On Windows a Ctrl-C does not interrupt a blocking socket read, so a
    reply waiting on a slow upstream would ignore it until the read returns.
    Waiting with Thread.join(timeout) keeps the main thread responsive on
    every platform. A KeyboardInterrupt raised inside ``fn`` is re-raised here.
    """
    box = {}

    def run():
        try:
            box["value"] = fn()
        except BaseException as exc:  # handed to the main thread
            box["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    while worker.is_alive():
        worker.join(poll)
    if "error" in box:
        raise box["error"]
    return box["value"]


def stream_reply(client, messages, indent=None, tools=None, full=False):
    """Streams a reply under a styled left rule; returns (ok, full_text).

    With ``full=True`` returns (ok, result) where result also carries native
    ``tool_calls`` and ``stopped`` (Ctrl-C). Shows an animated waiting line
    until the first token, and one dim status line per retry of the same
    model. With colour on, markdown is rendered line by line (render.py) and
    wrapped inside the gutter; NO_COLOR / non-TTY output is the raw text.
    In agent mode, terminal control blocks are kept in history but displayed
    only once, after the agent loop validates completion.
    Ctrl-C stops only this answer: partial text is kept and '✗ stopped' shown.
    """
    live_indent = indent is None

    def continuation_indent():
        return response_indent() if live_indent else indent
    response_open()
    md = render.MarkdownStream() if render.enabled() else None
    # "midline": the cursor sits after text (or the 'ai ▸' label) on a line
    state = {"at_start": True, "first": True, "wrote": False, "midline": True,
             "need_label": False, "text": [],
             "indicator": WaitIndicator(prefix=response_label())}
    state["indicator"].start()

    def begin_output():
        state["indicator"].stop()
        if state["need_label"]:  # text after a retry: reopen 'ai ▸' once
            sys.stdout.write(response_label())
            state["need_label"] = False
            state["first"] = True
        state["wrote"] = True

    def emit_lines(lines):
        if not lines:
            return
        begin_output()
        for line in lines:
            if not state["first"]:
                sys.stdout.write(continuation_indent())
            sys.stdout.write(line + "\n")
            state["first"] = False
        state["at_start"] = True
        state["midline"] = False
        sys.stdout.flush()

    def write_raw(delta):
        begin_output()
        buf = delta
        while True:
            newline = buf.find("\n")
            if newline == -1:
                break
            line, buf = buf[:newline], buf[newline + 1:]
            if not state["first"] and state["at_start"]:
                sys.stdout.write(continuation_indent())
            sys.stdout.write(line + "\n")
            state["at_start"] = True
            state["first"] = False
        if buf:
            if not state["first"] and state["at_start"]:
                sys.stdout.write(continuation_indent())
            sys.stdout.write(buf)
            state["at_start"] = False
            state["first"] = False
        state["midline"] = not delta.endswith("\n")
        sys.stdout.flush()

    def display(delta):
        if md is None:
            write_raw(delta)
        else:
            emit_lines(md.feed(delta))

    control_display = _AgentReplyDisplay(display) if getattr(client, "agent", False) else None

    def write(delta):
        state["text"].append(delta)
        if control_display is None:
            display(delta)
        else:
            control_display.feed(delta)

    def retry(attempt):
        # one dim status line per retry, no blank lines in between
        state["indicator"].stop()
        if state["midline"]:
            sys.stdout.write("\n")
            state["midline"] = False
        status_line("model busy — retrying %s (%d/%d)…"
                    % (client.model or "the auto model", attempt, MAX_ATTEMPTS))
        state["at_start"] = True
        if not state["wrote"]:
            state["need_label"] = True

    stopped = False
    cancelled = threading.Event()
    callback_lock = threading.Lock()

    def guarded(fn):
        def inner(*a):
            with callback_lock:
                if not cancelled.is_set():  # a stopped answer prints nothing more
                    fn(*a)
        return inner

    try:
        ok, result = _interruptible(
            lambda: request_reply(client, messages, tools=tools,
                                  on_text=guarded(write), on_retry=guarded(retry),
                                  cancelled=cancelled))
    except KeyboardInterrupt:
        with callback_lock:
            cancelled.set()
        stopped = True
        ok = True
        result = {"content": "".join(state["text"]), "tool_calls": [],
                  "stopped": True}
    finally:
        state["indicator"].stop()
    if control_display is not None:
        control_display.finish()
    if md is not None:
        emit_lines(md.flush())
    if stopped:
        if state["midline"]:
            sys.stdout.write("\n")
        tprint(c_red("  ✗ stopped"))
        state["midline"] = False
    elif state["midline"] or (ok and md is None):
        print()
    if not ok:
        _calm_failure(result)
    if full:
        return ok, result
    return ok, result.get("content", "")


# ---- agent loop ------------------------------------------------------------

_TOOL_FENCE = re.compile(r"```tool\s*\n(.*?)```", re.DOTALL)
_STATUS_OPEN = re.compile(r"\A(?:[ \t]*\r?\n)* {0,3}```agent_status[ \t]*\r?\n")
_JSON_STATUS_FENCE = re.compile(r"\A\s*```json[ \t]*\r?\n(.*?)\r?\n[ \t]*`{3,}[ \t]*\s*\Z", re.DOTALL | re.IGNORECASE)

MAX_AGENT_ROUNDS = 16
MAX_RECOVERY = 2


class AgentState:
    """Per-session agent state: the plan and the 'always approve' switch."""

    def __init__(self):
        self.todos = []
        self.auto_approve = False
        self.selected_tools = set()
        self.processes = {}

    def tool_context(self):
        return {"todos": self.todos, "approve": self.approve,
                "selected_tools": self.selected_tools, "processes": self.processes}

    def approve(self, kind, detail):
        """Approval callback for exec/write tools."""
        if self.auto_approve:
            return True
        print()
        tprint(c_bold(c_yellow("  agent %s: " % kind)) + c_bold(detail))
        try:
            answer = terminal.read_input(c_bold(c_yellow("  allow? [y/n/a/q] "))).strip().lower()
        except EOFError:
            print()
            return False
        if answer == "a":
            self.auto_approve = True
            return True
        if answer == "q":
            raise KeyboardInterrupt  # stop the whole run
        return answer in ("y", "yes")


# The spec says {"status": "complete"} but models also write "done",
# "finished", "stuck"… — normalise or the completion silently never lands.
_STATUS_ALIASES = {
    "complete": "complete", "completed": "complete", "done": "complete",
    "finished": "complete", "success": "complete", "succeeded": "complete",
    "blocked": "blocked", "stuck": "blocked", "waiting": "blocked",
    "needs_help": "blocked", "failed": "blocked",
}


def _normalise_action(data):
    """Accept action/tool/name keys and flatten function-call shaped args
    nested under parameters/arguments/input. Returns the action or None."""
    if not isinstance(data, dict):
        return None
    name = data.get("action") or data.get("tool") or data.get("name")
    if not name:
        return None
    data["action"] = name
    for src in ("parameters", "arguments", "input"):
        nested = data.pop(src, None)
        if isinstance(nested, dict):
            for k, v in nested.items():
                data.setdefault(k, v)
    return data


def _normalise_status(raw, compatible=False):
    """Accept control metadata; ordinary JSON needs a strict terminal schema."""
    try:
        data = json.loads(raw.strip())
    except (ValueError, AttributeError):
        return None
    if not isinstance(data, dict):
        return None
    # Some models use the fence name as the JSON key. This dedicated key is
    # run control even without a description; generic status JSON remains
    # strict so ordinary data and quoted examples are not mistaken for it.
    dedicated = "agent_status" in data
    key = str(data.get("agent_status" if dedicated else "status", "")).strip().lower().replace("-", "_").replace(" ", "_")
    canon = _STATUS_ALIASES.get(key)
    if canon is None:
        return None
    if dedicated and "status" in data:
        other = str(data["status"]).strip().lower().replace("-", "_").replace(" ", "_")
        if _STATUS_ALIASES.get(other) != canon:
            return None
    if compatible:
        if not set(data).issubset({"agent_status", "status", "summary", "reason", "message"}):
            return None
        if any(not isinstance(data[field], str) for field in ("summary", "reason", "message") if field in data):
            return None
    field = "summary" if canon == "complete" else "reason"
    if not data.get(field) and isinstance(data.get("message"), str):
        data[field] = data["message"]
    if compatible:
        explanation = data.get(field) or data.get("message")
        if not dedicated and (not isinstance(explanation, str) or not explanation.strip()):
            return None
        if isinstance(explanation, str) and explanation.strip():
            data[field] = explanation
    data["status"] = canon
    return data


def _fence_line(line):
    # Four spaces/tabs make an indented code example, not a control fence.
    match = re.match(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)", line)
    return (match.group(1), match.group(2).strip()) if match else None


def _closes_fence(line, opener):
    fence = _fence_line(line)
    return bool(fence and not fence[1] and fence[0][0] == opener[0] and len(fence[0]) >= len(opener))


def _explicit_control(block):
    """Read a complete JSON control without treating backticks in strings as EOF."""
    opening = _STATUS_OPEN.match(block)
    if opening is None:
        return None
    body = block[opening.end():]
    raw = body.lstrip()
    try:
        _, end = json.JSONDecoder().raw_decode(raw)
    except ValueError:
        return None
    closing = re.match(r"\s*`{3,}", raw[end:])
    if closing is None:
        return None
    return raw[:end], raw[end + closing.end():]


def _explicit_status_payloads(text):
    """Locate controls outside ordinary Markdown fences and indented examples."""
    opener = None
    held = None
    for line in (text or "").splitlines(keepends=True):
        if opener is not None:
            if held is not None:
                held.append(line)
                control = _explicit_control("".join(held))
                if control is not None:
                    yield control[0]
                    opener = held = None
                    continue
            if _closes_fence(line, opener):
                opener = held = None
            continue
        fence = _fence_line(line)
        if fence:
            opener = fence[0]
            held = [line] if fence == ("```", "agent_status") else None


def _standalone_json_status(text):
    """Compatibility for a model's entire reply, never a JSON example in prose."""
    lines = [line for line in (text or "").splitlines() if line.strip()]
    opening = _fence_line(lines[0]) if lines else None
    if not opening or opening[0] != "```" or opening[1].lower() != "json":
        return None
    if not _closes_fence(lines[-1], "```"):
        return None
    match = _JSON_STATUS_FENCE.fullmatch(text or "")
    return _normalise_status(match.group(1), compatible=True) if match else None


def parse_tool_blocks(text):
    """Split a reply into (actions, status, invalid)."""
    actions = []
    for raw in _TOOL_FENCE.findall(text or ""):
        try:
            data = json.loads(raw.strip())
        except (ValueError, AttributeError):
            continue
        action = _normalise_action(data)
        if action:
            actions.append(action)
    status = None
    for raw in _explicit_status_payloads(text):
        data = _normalise_status(raw)
        if data is not None:
            status = data
    invalid = bool(_TOOL_FENCE.search(text or "")) and not actions
    if status is None and not actions and not invalid:
        status = _standalone_json_status(text)
    return actions, status, invalid


class _AgentReplyDisplay:
    """Stream prose/code while holding possible terminal metadata for validation.

    Explicit control fences are hidden when valid. A compatible JSON envelope
    is hidden only if it occupies the whole reply. Malformed blocks, examples,
    and ordinary chat content keep their original bytes.
    """

    def __init__(self, emit):
        self.emit = emit
        self.buf = ""
        self.held = []
        self.mode = None
        self.first = True
        self.leading = ""
        self.code_fence = None
        self.plain_line = False

    def feed(self, delta):
        self.buf += delta or ""
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self._line(line + "\n")
        if self.buf and self.mode is None:
            # Raw/non-TTY replies retain token streaming. Hold only a possible
            # fence opener/closer at the start of a line, not ordinary prose.
            stripped = self.buf.lstrip(" \t\r")
            fences = (self.code_fence,) if self.code_fence else ("```", "~~~")
            possible_fence = not self.plain_line and any(
                fence.startswith(stripped) or stripped.startswith(fence) for fence in fences)
            if self.plain_line or (stripped and not possible_fence):
                self.emit(self.leading + self.buf)
                self.leading = ""
                self.buf = ""
                self.first = False
                self.plain_line = True

    def _line(self, line):
        if self.plain_line:
            self.emit(line)
            self.plain_line = not line.endswith("\n")
            return
        stripped = line.strip()
        if self.mode == "candidate":
            if not stripped:
                self.held.append(line)
                return
            self.emit("".join(self.held))
            self.held = []
            self.mode = None
        if self.mode in ("explicit", "json"):
            self.held.append(line)
            block = "".join(self.held)
            control = _explicit_control(block) if self.mode == "explicit" else None
            if control is None and not _closes_fence(line, "```"):
                return
            if self.mode == "json" and _standalone_json_status(block) is not None:
                self.mode = "candidate"
                return
            hidden = self.mode == "explicit" and control and _normalise_status(control[0]) is not None
            if hidden:
                suffix = control[1]
                if suffix.strip():
                    self.emit(suffix)
            else:
                self.emit(block)
            self.held = []
            self.mode = None
            return
        if self.first and not stripped:
            self.leading += line
            return
        if self.code_fence is not None:
            self.emit(line)
            if _closes_fence(line, self.code_fence):
                self.code_fence = None
            return
        fence = _fence_line(line)
        explicit = fence == ("```", "agent_status")
        compatible = self.first and fence and fence[0] == "```" and fence[1].lower() == "json"
        if explicit or compatible:
            self.mode = "explicit" if explicit else "json"
            self.held = [self.leading, line]
            self.leading = ""
            self.first = False
            return
        self.emit(self.leading + line)
        self.leading = ""
        self.first = False
        if fence:
            self.code_fence = fence[0]

    def finish(self):
        if self.buf:
            self._line(self.buf)
            self.buf = ""
        if self.mode != "candidate" and self.held:
            self.emit("".join(self.held))
        if self.leading:
            self.emit(self.leading)
        self.held = []
        self.leading = ""
        self.mode = None


def _modern_console(env=None, platform=None):
    """Windows Terminal / VS Code / non-Windows render ⏺ and ⎿; the legacy
    conhost fonts (Consolas, Lucida Console) show them as boxes."""
    env = os.environ if env is None else env
    platform = os.name if platform is None else platform
    if platform != "nt":
        return True
    return bool(env.get("WT_SESSION") or env.get("TERM_PROGRAM")
                or env.get("ConEmuANSI") == "ON")


def tool_glyphs(env=None, platform=None):
    if _modern_console(env, platform):
        return "⏺", "⎿"
    return "●", "└"


TOOL_GLYPH, RESULT_GLYPH = tool_glyphs()


def show_tool_call(name, args):
    """One compact line per tool call: '  ⏺ tool  key=value …'."""
    summary = format_args(name, args)
    if TOOLS.get(name, {}).get("approval"):
        # exec/write tools keep the bold-yellow look; approval prompt unchanged
        tprint(c_bold(c_yellow("  %s %s" % (TOOL_GLYPH, name))) + "  " + c_bold(summary))
    else:
        tprint(c_dim("  %s " % TOOL_GLYPH) + c_cyan(name)
              + (c_dim("  " + summary) if summary else ""))
    if name == "edit":
        for sign, text in edit_diff(args):
            paint = c_red if sign == "-" else c_green
            tprint("      " + paint("%s %s" % (sign, text)))


def show_tool_result(name, result):
    """'    ⎿ ✓ summary' (green) or '    ⎿ ✗ summary' (red)."""
    ok, summary = summarize_result(name, result)
    marker = c_green("✓") if ok else c_red("✗")
    tprint(c_dim("    %s " % RESULT_GLYPH) + marker + c_dim(" " + summary))
    if name in ("todo_write", "todo_read") and ok and result:
        # echo the whole checklist under the compact line — same card the
        # VS Code panel paints (◐ row highlighted like its bold row)
        for extra in result.splitlines()[1:]:
            if extra.startswith("◐"):
                tprint("      " + c_yellow(extra))
            else:
                tprint(c_dim("      " + extra))


class _ToolCancelled(KeyboardInterrupt):
    """A stopped tool batch with result messages needed to close its history."""

    def __init__(self, messages):
        super().__init__()
        self.messages = messages


def _execute_actions(client, actions, state):
    """Run each tool action; return the [tool result] message text."""
    ctx = state.tool_context()
    parts = []
    try:
        for action in actions:
            name = str(action.get("action"))
            args = {k: v for k, v in action.items() if k != "action"}
            show_tool_call(name, args)
            result = run_tool(name, args, client.workpath, ctx)
            parts.append("tool %s %s:\n%s" % (name, json.dumps(args), result))
            show_tool_result(name, result)
    except KeyboardInterrupt:
        parts.append("error: tool batch stopped by the user")
        raise _ToolCancelled([{
            "role": "user", "content": "[tool result]\n" + "\n\n".join(parts),
        }])
    return "[tool result]\n" + "\n\n".join(parts)


def _execute_native(client, tool_calls, state):
    """Run native tool_calls; return the role:tool messages for history."""
    ctx = state.tool_context()
    out = []
    try:
        for call in tool_calls:
            fn = call.get("function") or {}
            name = str(fn.get("name") or "")
            args, error = parse_tool_arguments(fn.get("arguments"))
            if error:
                result = "error: " + error
                tprint(c_dim("  %s %s  (unreadable arguments, asking again)" % (TOOL_GLYPH, name)))
            else:
                show_tool_call(name, args)
                result = run_tool(name, args, client.workpath, ctx)
            out.append({"role": "tool", "tool_call_id": call.get("id") or "",
                        "content": result})
            if not error:
                show_tool_result(name, result)
    except KeyboardInterrupt:
        # Every assistant tool call needs a matching result, including calls
        # never started after cancellation. Preserve results before rendering.
        out.extend({"role": "tool", "tool_call_id": pending.get("id") or "",
                    "content": "error: stopped by the user"}
                   for pending in tool_calls[len(out):])
        raise _ToolCancelled(out)
    return out


def _apply_status(history, reply_text, status, state, fallback_summary=""):
    """Handle a run-control block. Returns True when the turn is over."""
    if status.get("status") == "blocked":
        tprint(c_yellow("  ⏸ agent blocked: " + str(status.get("reason", ""))[:300]))
        return True
    open_items = [t for t in state.todos if t.get("status") != "completed"]
    if open_items:
        # completion rejected — nudge the model to finish the plan
        history.append({
            "role": "user",
            "content": "[run control] Completion rejected: %d plan item(s) "
            "remain open: %s. Continue working; request the next tool."
            % (len(open_items), json.dumps(open_items)),
        })
        return False
    summary = str(status.get("summary") or "").strip() or fallback_summary.strip()
    if not summary:
        summary = "The model reported completion without a description."
    tprint(c_green("  ⏹ agent complete: " + summary[:300]))
    return True


def _agent_tool_schemas(client, state):
    if getattr(client, "supports_tools", None) is False:
        return None
    if getattr(client, "_unsupported_tools_endpoint", None) == (
            getattr(client, "base", None), getattr(client, "model", None)):
        return None
    selected = [name for name in TOOLS if name in state.selected_tools
                and name not in DEFAULT_TOOL_NAMES]
    names = list(DEFAULT_TOOL_NAMES) + selected
    explicit = getattr(client, "tool_limit", None)
    limit = min(16, explicit) if isinstance(explicit, int) and not isinstance(explicit, bool) and explicit > 0 else 16
    if len(names) > limit:
        # Discovery and newly selected tools remain usable with small native
        # limits. The fenced protocol still supports the complete active set.
        names = ["tool_discover"] + selected + [
            name for name in DEFAULT_TOOL_NAMES if name != "tool_discover"]
    return tool_schemas(names[:limit])


def run_agent_turn(client, history, state, instruction=None):
    """One full agent run: act → observe → act … until complete/blocked/paused.

    ``instruction`` optionally injects a recovery prompt before the first
    round. History is mutated with the tool exchanges; the visible transcript
    stays readable because tool blocks live inside the assistant messages.
    """
    rounds = 0
    recovery = 0
    last_answer = ""
    meter = TurnMeter(client)
    if instruction:
        history.append({"role": "user", "content": instruction})
    try:
        while rounds < MAX_AGENT_ROUNDS:
            rounds += 1
            set_system_message(history, client, state)
            tprint(c_dim("  ── agent round %d ──" % rounds))
            ok, result = stream_reply(client, history, tools=_agent_tool_schemas(client, state),
                                      full=True)
            if not ok:
                if result.get("content"):
                    history.append({"role": "assistant", "content": result["content"]})
                return False
            meter.add_round()
            reply_text = result.get("content") or ""
            if result.get("stopped"):  # Ctrl-C: keep the partial answer, end the turn
                if reply_text:
                    history.append({"role": "assistant", "content": reply_text})
                return False
            native = result.get("tool_calls") or []
            if native:
                recovery = 0
                history.append({"role": "assistant", "content": reply_text,
                                "tool_calls": native})
                history.extend(_execute_native(client, native, state))
                continue
            actions, status, invalid = parse_tool_blocks(reply_text)
            history.append({"role": "assistant", "content": reply_text})

            if status is not None:
                if _apply_status(history, reply_text, status, state, last_answer):
                    return True
                continue
            if actions:
                recovery = 0
                history.append({
                    "role": "user",
                    "content": _execute_actions(client, actions, state),
                })
                continue
            if not invalid and reply_text.strip():
                # Keep only this run's substantive answer as an honest
                # description when later terminal metadata omits its own.
                last_answer = reply_text.strip()
            # no action, no completion: recover or treat as the final answer
            had_results = any(
                m.get("role") == "tool"
                or (m.get("role") == "user"
                    and str(m.get("content") or "").startswith("[tool result]"))
                for m in history
            )
            if had_results and recovery < MAX_RECOVERY:
                recovery += 1
                history.append({
                    "role": "user",
                    "content": "[run control] "
                    + ("The tool block was invalid." if invalid
                       else "The response ended without an action or an explicit "
                            "task completion.")
                    + " Use the tool-block response format now: request the next "
                      "actual tool, or finish with an agent_status complete block.",
                })
                continue
            meter.publish()
            print_footer(client)
            return True  # plain prose answer — turn over
        tprint(c_yellow("  ⏸ agent round limit reached — send 'continue' to resume"))
        return True
    except KeyboardInterrupt as exc:  # Ctrl-C during a tool or an approval 'q'
        if isinstance(exc, _ToolCancelled):
            history.extend(exc.messages)
        print()
        tprint(c_red("  ✗ stopped"))
        return False
    except Exception:  # never surface a traceback from the agent loop
        _calm_failure()
        return False
    finally:
        meter.publish()  # client.last_turn after every agent turn




def run_web_answer(client, query, fetch_pages=True):
    print()
    status_line("searching the web for: " + c_bold(query))
    started = time.time()
    found = search_web(query)
    results = found["results"]
    if not results:
        tprint(c_red("  ✗ no results (search engine unavailable or blocked)"))
        return False
    status_line("%d result(s) in %.1fs" % (len(results), time.time() - started))

    pages = {}
    if fetch_pages:
        top = results[:PAGE_FETCH_LIMIT]
        for index, result in enumerate(top, start=1):
            spinner("reading [%d] %s…" % (index, result["url"][:52]))
            text = fetch_text(result["url"])
            spinner_clear()
            if text:
                pages[index] = text
                status_line(
                    "fetched [%d] %s (%d chars)"
                    % (index, result["title"][:40], len(text))
                )
        print()

    messages = build_grounded_messages(query, results, pages, rich=found["rich"])
    meter = TurnMeter(client)
    ok, _text = stream_reply(client, messages)
    if ok:
        meter.add_round()
    meter.publish()
    if ok:
        print_footer(client, cited=True)
    return ok




def endpoint_notice(client):
    """One-line heads-up when the chosen endpoint is down. Never switches."""
    base = getattr(client, "base", "") or ""
    try:
        up = type(client)._reachable(base, getattr(client, "key", "") or "")
    except Exception:
        up = True  # unknown: say nothing rather than guess
    if up:
        return False
    where = _host_port(base) or base
    if where.startswith(("127.0.0.1:", "localhost:")):
        # Forward slashes work in cmd, PowerShell and POSIX shells alike.
        hint = "start SignalREACH (python tools/reach.py start)"
    else:
        hint = "check the endpoint"
    tprint(c_yellow("  ! no answer from %s yet — %s, or switch with /endpoint"
                   % (where, hint)))
    return True


def run_chat(client, base, initial_prompt=None):
    try:
        saved = terminal.load_session_config()
        if saved.get("layout"):
            terminal.set_layout(saved["layout"])
        if saved.get("theme"):
            terminal.set_theme(saved["theme"])
    except Exception:
        pass
    from .chatbox import footer_session
    with footer_session(client):
        return _run_chat_loop(client, base, initial_prompt)


def _run_chat_loop(client, base, initial_prompt=None):
    banner(client, base, "chat")
    endpoint_notice(client)
    history = []
    agent_state = AgentState()
    from .chatbox import active_footer
    screen = active_footer()
    if screen is not None:
        def run_mini_command(command):
            context = agent_state.tool_context()
            approve = context.get("approve")

            def approve_mini(kind, detail):
                screen.mini_terminal.set_status("awaiting approval")
                screen.refresh_header()
                allowed = bool(approve and approve(kind, detail))
                screen.mini_terminal.set_status(
                    "running" if allowed else "denied")
                screen.refresh_header()
                return allowed

            context["approve"] = approve_mini
            return run_tool("shell", {"command": command},
                            client.workpath, context)

        screen.set_mini_runner(run_mini_command)
    session = ReplSession()
    set_system_message(history, client)
    pending_prompt = initial_prompt
    try:
        while True:
            if pending_prompt is not None:
                line, pending_prompt = pending_prompt, None
                from .chatbox import active_footer
                screen = active_footer()
                if screen is not None:
                    from .input_privacy import sanitize_endpoint_command
                    screen.finish_input(sanitize_endpoint_command(line), echo=bool(str(line).strip()))
            else:
                line = read_user_line(client, session)
            if line is None:  # EOF / second Ctrl-C: 'bye.' already printed
                return
            line = str(line).strip()
            if not line:
                continue
            if line.startswith("/"):
                # Command implementations live in terminal.py. This loop only
                # quits or sends the prompt /retry asks to resend.
                result = handle_slash(line, client, history, session)
                if result.quit:
                    tprint(c_dim("  bye."))
                    return
                if not result.prompt:
                    continue
                line = result.prompt
            session.remember(line)
            history.append({"role": "user", "content": line})
            if client.agent:
                try:
                    run_agent_turn(client, history, agent_state)
                except Exception:
                    _calm_failure()
                continue
            try:
                meter = TurnMeter(client)
                ok, result = stream_reply(client, history, full=True)
                if ok:
                    meter.add_round()
                meter.publish()
                reply_text = result.get("content") or ""
                if result.get("stopped"):  # Ctrl-C: keep partial text, back to you ▸
                    if reply_text:
                        history.append({"role": "assistant", "content": reply_text})
                    else:
                        history.pop()
                    continue
                if ok:
                    history.append({"role": "assistant", "content": reply_text})
                    print_footer(client)
                    if client.agent:
                        applied = review_and_apply_edits(client.workpath, reply_text)
                        if applied:
                            status_line(c_green("%d edit(s) applied" % applied))
                else:
                    if reply_text:
                        history.append({"role": "assistant", "content": reply_text})
                    else:
                        history.pop()
            except Exception as exc:
                tprint(c_red("  ✗ %s" % exc))
                history.pop()
    finally:
        # footer_session restores the caller's terminal and output stream.
        cleanup_owned_processes(client.workpath, agent_state.tool_context())




def run_ask(client, question, web=False):
    if web:
        return run_web_answer(client, question)
    messages = []
    prompt = build_system(client)
    if prompt:
        messages.append({"role": "system", "content": prompt})
    messages.append({"role": "user", "content": question})
    if client.agent:
        state = AgentState()
        try:
            return run_agent_turn(client, messages, state)
        finally:
            cleanup_owned_processes(client.workpath, state.tool_context())
    meter = TurnMeter(client)
    ok, reply_text = stream_reply(client, messages)
    if ok:
        meter.add_round()
    meter.publish()
    if not ok:
        return False
    print_footer(client)
    if client.agent:
        applied = review_and_apply_edits(client.workpath, reply_text)
        if applied:
            status_line(c_green("%d edit(s) applied" % applied))
    return True
