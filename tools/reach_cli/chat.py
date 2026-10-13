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
    safe_text,
    tool_help_text,
    tool_schemas,
)
from .agent_tools_extra import _display_file, _redact_json
from .client import ReachApiError, ReachTransientError, usage_tokens
from .agent_completion import answer_text, clean_final_answer, incomplete_finish
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
_STUDIO_INFORMATION = object()

AGENT_SYSTEM_PROMPT = (
    "You are SimpleREACH, an agentic coding assistant. You operate inside a "
    "directory called the workpath and act through local tools.\n\n"
    "The local file tools are available to you. For requests to inspect or "
    "improve this workspace, use list or glob to discover relevant files, "
    "then read or search them before drawing conclusions. Use relative paths "
    "within the workpath. Do not ask the user to paste files or choose tools "
    "when those tools can resolve the request. Ask only for a decision or "
    "missing information that inspection cannot resolve.\n\n"
    "For a greeting, small talk, or a question you can answer directly, reply "
    "once without tools or a todo list. Do not invent work to record that you "
    "greeted the user. Plans are for tasks with multiple concrete steps.\n\n"
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
    "RUN CONTROL FOR TOOL TASKS:\n"
    "When the request is fully handled (plan complete, edits applied, changes "
    "verified with shell where possible), deliver the final answer and stop. "
    "Close any open plan items before the final answer. Do not call tools just "
    "to repeat completion. You may also finish with:\n"
    '```agent_status\n{"status": "complete", "summary": "What was done and how it was verified."}\n```\n'
    "If you need a decision from the user, stop with:\n"
    '```agent_status\n{"status": "blocked", "reason": "The question or decision needed from the user."}\n```\n'
    "Do not claim completion while work remains. Do not rewrite a completed "
    "plan or repeat a greeting to keep the run alive. A direct answer with "
    "no pending tools or open plan can finish as ordinary prose, including "
    "after observing tool results."
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


def autopilot_enabled(client):
    preferences = getattr(client, "cli_settings", {}).get("conversation", {})
    return (preferences.get("approvals") == "auto-all"
            and preferences.get("reviewEdits") is False)


def build_system(client, state=None):
    parts = []
    parts.append(client.system or DEFAULT_IDENTITY)
    if client.agent:
        from .settings import effective_budgets
        budgets = effective_budgets(client)
        prompt = AGENT_SYSTEM_PROMPT + "\n\nThe workpath is: " + client.workpath
        if budgets.get("codeContext", True) and budgets.get("codeContextChars", None) != 0:
            context = workpath_context(client.workpath)
            if "codeContextChars" in budgets:
                context = context[:budgets["codeContextChars"]]
            prompt += "\n\nFiles in the workpath:\n" + context
        if autopilot_enabled(client):
            prompt += ("\n\nPermission mode: autopilot. The user has granted all tool approvals, "
                       "including shell execution and file edits. Execute tools without asking "
                       "for y/n confirmation; the runtime approves them automatically. "
                       "Tool validation and operating-system restrictions still apply.")
        parts.append(prompt)
        if state is not None and state.selected_tools:
            # The text protocol sees the same active extra capabilities as
            # native calling; a large registry never fills every prompt.
            active = [name for name in TOOLS if name in state.selected_tools]
            if active:
                parts.append("ADDITIONAL ACTIVE TOOLS (native or fenced):\n"
                             + tool_help_text(active))
    context = getattr(client, "studio_context", None)
    if context is not None:
        block = context.prompt_block()
        if block:
            parts.append(block)
    return "\n\n".join(parts)


def refresh_studio_context(client):
    """Refresh files for an explicitly addressed Studio identity only."""
    context = getattr(client, "studio_context", None)
    if context is not None and context.snapshot()["selected"] is not None:
        context.set_workpath(client.workpath)
        context.read(refresh=True)


def prepare_agent_message(client, line):
    """Address one Studio agent for this turn; ordinary messages stay fresh."""
    from .studio_mentions import parse_agent_address
    from .studio_context import StudioContextManager
    from .studio_settings import SettingsError
    context = getattr(client, "studio_context", None)
    if context is not None:
        context.clear()
    try:
        selector, prompt = parse_agent_address(line)
        if selector is None:
            return None, prompt
        if not selector or selector.lower() in ("agents", "list", "help") and not prompt.strip():
            handle_slash("/studio list", client, [])
            return _STUDIO_INFORMATION, None
        if not prompt.strip():
            tprint(c_yellow('  Add a message after @Name or @"Agent Name"; @agents lists available agents.'))
            return None, None
        if context is None:
            context = StudioContextManager(client.workpath)
            client.studio_context = context
        context.set_workpath(client.workpath)
        kind, separator, ident = selector.partition(":")
        scoped = separator and kind.lower() in ("persona", "conversation")
        selected = context.select(ident if scoped else selector, kind.lower() if scoped else None)
        owner = selected.get("personaId")
        scope = ("persona", owner) if owner else (selected["kind"], selected["id"])
        tprint(c_cyan("  @" + safe_text(selected["name"], 80)))
        return scope, prompt
    except (SettingsError, ValueError) as error:
        if context is not None:
            context.clear()
        tprint(c_yellow("  " + safe_text(str(error), 500)))
        return None, None


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
    return min(BACKOFF_CAP, BACKOFF_BASE * (2 ** min(max(0, attempt - 1), 32)))


def _request_attempts(client):
    from .settings import effective_budgets
    budgets = effective_budgets(client)
    return budgets["retryLimit"] + 1 if "retryLimit" in budgets else MAX_ATTEMPTS


def _retry_wait(client, attempt, error):
    from .settings import effective_budgets
    budgets = effective_budgets(client)
    requested = getattr(error, "retry_after", None)
    if isinstance(requested, (int, float)) and 0 <= requested < float("inf"):
        cap = budgets.get("retryAfterCapMs", 300000) / 1000
        return min(requested, cap) if cap else requested
    if "retryBaseMs" not in budgets and "retryMaxMs" not in budgets:
        return _backoff(attempt)
    base = budgets.get("retryBaseMs", int(BACKOFF_BASE * 1000)) / 1000
    cap = budgets.get("retryMaxMs", int(BACKOFF_CAP * 1000)) / 1000
    # Large configured retry limits must not overflow the backoff calculation.
    return min(cap, base * (2 ** min(attempt - 1, 32)))


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


def _accepts_kwarg(fn, name):
    """True when ``fn`` accepts ``name`` — test doubles pinned to an older
    complete() signature simply do not get the callback."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(p.kind == p.VAR_KEYWORD or (
        p.name == name and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY))
        for p in params)


def request_reply(client, messages, tools=None, on_text=None, on_retry=None,
                  cancelled=None, on_thought=None):
    """Ask the endpoint with retries on the SAME provider and model.

    Returns (ok, {"content", "tool_calls", "thought"}). Transient failures
    back off and retry; text already streamed is kept and the model is asked
    to continue, so a cut stream never loses work. Provider reasoning deltas
    reach ``on_thought`` and collect under ``"thought"``. Never touches
    client.model/base.
    """
    if (getattr(client, "supports_tools", None) is False
            or getattr(client, "_unsupported_tools_endpoint", None) == (
                getattr(client, "base", None), getattr(client, "model", None))):
        tools = None
    kept_text = ""
    kept_thought = ""
    last = None
    attempts = 0
    text_started = False
    fallback_used = False
    extra = {}
    if on_thought is not None and _accepts_kwarg(client.complete, "on_thought"):
        extra["on_thought"] = on_thought
    if cancelled is not None and _accepts_kwarg(client.complete, "cancelled"):
        extra["cancelled"] = cancelled

    def observe_text(delta):
        nonlocal text_started
        if delta:
            text_started = True
        if on_text:
            on_text(delta)

    max_attempts = _request_attempts(client)
    for attempt in range(1, max_attempts + 1):
        if cancelled is not None and cancelled.is_set():
            return False, {"content": kept_text, "tool_calls": [], "stopped": True,
                           "thought": kept_thought}
        convo = list(messages)
        if kept_text:
            convo += [{"role": "assistant", "content": kept_text},
                      {"role": "user", "content": _CONTINUE_PROMPT}]
        attempts = attempt
        try:
            try:
                result = client.complete(convo, tools=tools,
                                         on_text=observe_text if on_text else None,
                                         **extra)
            except ReachApiError as exc:
                partial = getattr(exc, "partial", None) or {}
                if (not tools or fallback_used or text_started or kept_text
                        or (isinstance(partial, dict) and (
                            partial.get("content") or partial.get("tool_calls")))
                        or not _unsupported_native_tools(exc)):
                    raise
                if cancelled is not None and cancelled.is_set():
                    return False, {"content": kept_text, "tool_calls": [], "stopped": True,
                                   "thought": kept_thought}
                # This request was rejected before producing text or actions.
                # Retry once with the same endpoint/model and the existing
                # fenced protocol; remember only this endpoint/model pairing.
                fallback_used = True
                tools = None
                client._unsupported_tools_endpoint = (
                    getattr(client, "base", None), getattr(client, "model", None))
                result = client.complete(convo, tools=None,
                                         on_text=observe_text if on_text else None,
                                         **extra)
            return True, {"content": kept_text + (result.get("content") or ""),
                          "tool_calls": result.get("tool_calls") or [],
                          "thought": kept_thought + (result.get("thought") or ""),
                          **({"finish_reason": result["finish_reason"]}
                             if "finish_reason" in result else {})}
        except ReachTransientError as exc:
            last = exc
            got = exc.partial or {}
            kept_text += got.get("content") or ""
            kept_thought += got.get("thought") or ""
            if cancelled is not None and cancelled.is_set():
                return False, {"content": kept_text, "tool_calls": [], "stopped": True,
                               "thought": kept_thought}
            if incomplete_finish(got):
                break  # a later retry must not make incomplete controls executable
            calls = _complete_tool_calls(got.get("tool_calls"))
            if calls:  # whole calls before a transport cut
                return True, {"content": kept_text, "tool_calls": calls,
                              "thought": kept_thought}
            if attempt < max_attempts:
                if on_retry:
                    on_retry(attempt + 1)
                # Short sleeps keep a stopped worker from starting another
                # request, including when Ctrl-C arrives during backoff.
                remaining = _retry_wait(client, attempt, exc)
                while remaining > 0:
                    if cancelled is not None and cancelled.is_set():
                        return False, {"content": kept_text, "tool_calls": [], "stopped": True,
                                       "thought": kept_thought}
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
    return False, {"content": kept_text, "tool_calls": [], "thought": kept_thought,
                   **({"finish_reason": last.partial["finish_reason"]}
                      if isinstance(last, ReachTransientError) and
                      "finish_reason" in (last.partial or {}) else {}),
                   "error": str(last or ""),
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


def _set_pet_activity(activity):
    """Update the managed header pet without adding plain-output bytes."""
    from .chatbox import active_footer
    try:
        screen = active_footer()
        update = getattr(screen, "set_pet_activity", None)
        if callable(update):
            update(activity)
    except Exception:
        # A cosmetic header update must never stop a model or tool request.
        pass


class _FollowUpCollector:
    """Passive composer that queues prompts typed while a reply streams.

    The VS Code chat queues a message submitted mid-reply and fires it the
    moment the reply completes; this is the terminal counterpart. The
    composer stays editable during the stream under the 'next' label,
    Enter echoes ``you ▸ ...`` into the transcript at once and queues the
    text, and an unsubmitted draft carries into the next prompt. Input
    comes only from the broker's passive ``collect_event`` — never a real
    reader — so approvals and prompts cannot lose keystrokes to it.
    """

    def __init__(self, screen, release=None):
        self._screen = screen
        self._release = release
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._screen is None:
            return
        self._thread = threading.Thread(
            target=self._run, name="reach-followup", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=0.5)

    def _events(self):
        from .footer_input import collect_event, requeue_event
        while not self._stop.is_set():
            event = collect_event(self._stop)
            if event[0] in ("eof", "interrupt"):
                # Quit intents still belong to the next real reader.
                requeue_event(*event)
                return
            yield event

    def _changed(self, text, cursor):
        self._screen.set_input(text, cursor, label="next")

    def _on_key(self, key, editor):
        if key == "enter":
            text = editor.text.strip()
            editor.text, editor.cursor = "", 0
            if text:
                from .pet_care import parse_care_command
                care = parse_care_command(text)
                if care is not None:
                    self._screen.care_pet(care)
                    self._screen.finish_input("", echo=False)
                    return True
                from .input_privacy import sanitize_endpoint_command
                self._screen.queue_followup(text)
                self._screen.finish_input(
                    sanitize_endpoint_command(text), echo=True)
                self._screen.write(c_dim(
                    "      ↳ queued — sends when this reply finishes\n"))
                return True
            has = getattr(self._screen, "has_followups", None)
            if callable(has) and has() and self._release is not None:
                # Devin-style "send now": Enter on an empty composer with a
                # queued follow-up ends this reply and fires the queue.
                self._release()
            return True
        if key == "terminal_toggle":
            self._screen.cycle_pet()
            return True
        return None

    def _run(self, events=None):
        from .footer_input import EditBuffer, _drive
        editor = EditBuffer("")
        # A draft left over from the previous round's collector resumes here
        # instead of disappearing until the next real prompt opens.
        take = getattr(self._screen, "take_draft_carry", None)
        if callable(take):
            try:
                text, cursor = take()
                if text:
                    editor = EditBuffer(str(text))
                    editor.cursor = max(0, min(len(editor.text), int(cursor)))
            except (TypeError, ValueError):
                pass
        try:
            _drive(editor, self._changed,
                   self._events() if events is None else iter(events),
                   on_scroll=self._screen.scroll, on_key=self._on_key)
        except KeyboardInterrupt:
            pass
        except Exception:
            # A collector is disposable; it must never take a reply down.
            pass
        finally:
            try:
                self._screen.carry_draft(editor.text, editor.cursor)
            except Exception:
                pass


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
    While the footer owns the screen the composer stays live: Enter queues a
    follow-up that fires the moment a reply completes (see _FollowUpCollector).
    A reply carrying provider reasoning gets the same '💭...' thought mark
    REACH Studio paints on its bubble — leading when the reasoning arrives
    before the answer text, trailing ' ...💭' when it arrives late.
    """
    checkpoint = getattr(client, "_session_checkpoint", None)
    store = getattr(client, "conversation_store", None)
    if callable(checkpoint):
        checkpoint(status="running")
    live_indent = indent is None

    def continuation_indent():
        return response_indent() if live_indent else indent
    response_open()
    from .chatbox import active_footer
    screen = active_footer()
    source_writer = getattr(screen, "write_markdown_source", None)
    source_mode = callable(source_writer)
    md = render.MarkdownStream(source_mode=source_mode) if render.enabled() else None
    # "midline": the cursor sits after text (or the 'ai ▸' label) on a line
    state = {"at_start": True, "first": True, "wrote": False, "midline": True,
             "need_label": False, "text": [], "thought": [],
             "thought_lead": False, "pet_activity": None,
             "indicator": WaitIndicator(prefix=response_label())}
    state["indicator"].start()

    def note_activity(activity):
        # Reasoning and answer tokens may interleave. Repaint on a phase
        # change only, never for every token or the contents of a thought.
        if state["pet_activity"] != activity:
            state["pet_activity"] = activity
            _set_pet_activity(activity)

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
            if isinstance(line, render.MarkdownSource):
                if not source_writer(line, continuation_indent()):
                    for index, row in enumerate(line.render(render.text_width())):
                        if index:
                            sys.stdout.write(continuation_indent())
                        sys.stdout.write(row + "\n")
            else:
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
        if delta:
            note_activity("responding")
        state["text"].append(delta)
        if store is not None:
            store.partial("".join(state["text"]))
        if control_display is None:
            display(delta)
        else:
            control_display.feed(delta)

    def thought(delta):
        # The mark is transcript chrome; raw (non-colour) output stays exactly
        # what the model sent, so only the rendered reply carries it.
        if not delta:
            return
        note_activity("thinking")
        state["thought"].append(delta)
        if md is None or state["thought_lead"]:
            return
        if state["wrote"]:
            return  # the lead position is gone; the trail mark closes it
        state["thought_lead"] = True
        begin_output()
        mark = THOUGHT_GLYPH + "... "
        sys.stdout.write(c_dim(mark))
        _note_thought(state["thought"], mark)
        state["at_start"] = False
        state["midline"] = True
        sys.stdout.flush()

    def retry(attempt):
        # one dim status line per retry, no blank lines in between
        note_activity("waiting")
        state["indicator"].stop()
        if state["midline"]:
            sys.stdout.write("\n")
            state["midline"] = False
        status_line("model busy — retrying %s (%d/%d)…"
                    % (client.model or "the auto model", attempt, _request_attempts(client)))
        state["at_start"] = True
        if not state["wrote"]:
            state["need_label"] = True

    stopped = False
    cancelled = threading.Event()
    released = threading.Event()
    callback_lock = threading.Lock()

    def guarded(fn):
        def inner(*a):
            with callback_lock:
                if not cancelled.is_set():  # a stopped answer prints nothing more
                    fn(*a)
        return inner

    def release():
        # A queued follow-up asked to run now: suppress the rest of this
        # reply but mark it released so the queue still fires after it.
        released.set()
        cancelled.set()

    from .chatbox import active_footer
    collector = _FollowUpCollector(active_footer(), release=release)
    collector.start()
    try:
        note_activity("waiting")
        ok, result = _interruptible(
            lambda: request_reply(client, messages, tools=tools,
                                  on_text=guarded(write), on_retry=guarded(retry),
                                  on_thought=guarded(thought),
                                  cancelled=cancelled))
    except KeyboardInterrupt:
        with callback_lock:
            cancelled.set()
        _set_pet_activity("cancelled")
        stopped = True
        ok = True
        result = {"content": "".join(state["text"]), "tool_calls": [],
                  "thought": "".join(state["thought"]), "stopped": True}
    except Exception:
        _set_pet_activity("error")
        if store is not None:
            store.partial("".join(state["text"]), final=True)
        raise
    finally:
        state["indicator"].stop()
        collector.stop()
    if released.is_set():
        result["released"] = True
    if store is not None:
        store.partial(result.get("content") or "".join(state["text"]), final=True)
    if result.get("stopped"):
        _set_pet_activity("cancelled")
    if not result.get("stopped") and ok:
        # Full non-stream clients may skip one or both delta callbacks.
        # Keep the last real streamed phase when both callbacks were used.
        if result.get("content") and not any(state["text"]):
            note_activity("responding")
        elif result.get("thought") and not state["thought"] and not result.get("content"):
            note_activity("thinking")
    if control_display is not None:
        control_display.finish()
    if md is not None:
        emit_lines(md.flush())
    if md is not None and state["thought"] and not state["first"]:
        # Studio bookends a thought-ful bubble with ' ...💭'; it is also the
        # only mark possible when reasoning surfaced after the text began.
        if state["midline"]:
            trail = " ..." + THOUGHT_GLYPH
            sys.stdout.write(c_dim(trail))
            sys.stdout.flush()
        else:
            trail = "..." + THOUGHT_GLYPH
            emit_lines([c_dim(trail)])
        _note_thought(state["thought"], trail)
    if stopped:
        if state["midline"]:
            sys.stdout.write("\n")
        tprint(c_red("  ✗ stopped"))
        state["midline"] = False
    elif state["midline"] or (ok and md is None):
        print()
    if not ok:
        _set_pet_activity("cancelled" if result.get("stopped") else "error")
        _calm_failure(result)
    client.last_thought = result.get("thought") or ""
    if full:
        return ok, result
    return ok, result.get("content", "")


# ---- agent loop ------------------------------------------------------------

_JSON_STATUS_FENCE = re.compile(r"\A\s*```json[ \t]*\r?\n(.*?)\r?\n[ \t]*`{3,}[ \t]*\s*\Z", re.DOTALL | re.IGNORECASE)

MAX_AGENT_ROUNDS = 16
MAX_RECOVERY = 2
MAX_NO_PROGRESS = 3
_PLAN_TOOLS = frozenset(("todo_write", "todo_read"))


def _plan_snapshot(todos):
    return tuple(sorted((str(item.get("text") or item.get("content") or ""),
                         item.get("status", "pending")) for item in todos))


def _plan_advanced(before, after):
    """An initial plan or an open item moving forward is useful progress."""
    if not before:
        return bool(after)
    ranks = {"pending": 0, "in_progress": 1, "completed": 2}
    previous = dict(before)
    if all(status == "completed" for _text, status in before):
        return any(status != "completed" for _text, status in after)
    return any(text in previous and ranks.get(status, 0) > ranks.get(previous[text], 0)
               for text, status in after)


def _pause_agent_run(reason, state, results):
    state.resume_results = results
    tprint(c_yellow("  ⏸ agent paused: " + reason))
    tprint(c_dim("  Plan and results are kept. Send 'continue' to resume or give a new request."))
    _set_pet_activity("blocked")
    return True


def _current_request_has_results(history):
    """Retain continuation evidence without recovering from older user turns."""
    start = 0
    for index, message in enumerate(history):
        content = message.get("content") or ""
        if (message.get("role") == "user" and isinstance(content, str) and
                not content.startswith(("[tool result]", "[run control]"))):
            start = index + 1
    return any(message.get("role") == "tool" or (
        message.get("role") == "user" and
        str(message.get("content") or "").startswith("[tool result]"))
        for message in history[start:])


class AgentState:
    """Per-session agent state: the plan and the 'always approve' switch."""

    def __init__(self):
        self.todos = []
        self.auto_approve = False
        self.selected_tools = set()
        self.processes = {}
        self.client = None
        self.permission_signature = None
        self.last_tool_results = []
        self.resume_results = None

    def configure(self, client):
        """Refresh saved permissions without keeping an old 'always' grant."""
        self.client = client
        preferences = getattr(client, "cli_settings", {}).get("conversation", {})
        configured = getattr(client, "cli_settings_explicit_conversation", None)
        signature = (preferences.get("approvals"), preferences.get("reviewEdits"),
                     frozenset(configured) if configured is not None else None)
        if self.permission_signature is not None and signature != self.permission_signature:
            self.auto_approve = False
        self.permission_signature = signature

    def tool_context(self):
        return {"todos": self.todos, "approve": self.approve,
                "selected_tools": self.selected_tools, "processes": self.processes,
                "studio_context": getattr(self.client, "studio_context", None)}

    def approve(self, kind, detail):
        """Approval callback for exec/write tools."""
        preferences = getattr(self.client, "cli_settings", {}).get("conversation", {})
        configured = getattr(self.client, "cli_settings_explicit_conversation", None)
        review_configured = configured is None or bool(set(configured) & {"reviewEdits", "approvals"})
        review = review_configured and preferences.get("reviewEdits") is True and kind in {
            "edit", "write_file", "write_json", "append_file", "replace_all"}
        if not review and (self.auto_approve or preferences.get("approvals") == "auto-all"):
            return True
        _set_pet_activity("blocked")
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


def _explicit_control(block, label="agent_status"):
    """Read a complete JSON control without treating backticks in strings as EOF."""
    opening = re.match(r"\A(?:[ \t]*\r?\n)* {0,3}```" + re.escape(label) + r"[ \t]*\r?\n", block)
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


def _explicit_status_payloads(text, label="agent_status"):
    """Locate controls outside ordinary Markdown fences and indented examples."""
    opener = None
    held = None
    for line in (text or "").splitlines(keepends=True):
        if opener is not None:
            if held is not None:
                held.append(line)
                control = _explicit_control("".join(held), label)
                if control is not None:
                    yield control[0]
                    opener = held = None
                    continue
            if _closes_fence(line, opener):
                if held is not None:
                    yield "".join(held[1:-1])  # retain malformed controls for validation
                opener = held = None
            continue
        fence = _fence_line(line)
        if fence:
            opener = fence[0]
            held = [line] if fence == ("```", label) else None
    if held is not None:
        yield ""  # an unfinished control must not become a final prose answer


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
    tool_payloads = list(_explicit_status_payloads(text, "tool"))
    for raw in tool_payloads:
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
    invalid = bool(tool_payloads) and not actions
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
        return ">", "⎿"
    return ">", "└"


def thought_glyph(env=None, platform=None):
    """Studio's 💭 thought-bubble mark; a small 'o' bubble on legacy conhost."""
    if _modern_console(env, platform):
        return "💭"
    return "o"


TOOL_GLYPH, RESULT_GLYPH = tool_glyphs()
THOUGHT_GLYPH = thought_glyph()


def _note_thought(parts, mark):
    """Bind a thought mark just written to the reply's live reasoning list.

    The managed footer turns these marks into hover targets; plain output
    keeps only the glyph on screen. parts is shared by reference so the
    bubble keeps up with a still-streaming thought.
    """
    from .chatbox import active_footer
    screen = active_footer()
    note = getattr(screen, "note_thought", None)
    if callable(note):
        note(parts, len(mark))


def _tool_call_details(name, args):
    """Sanitized arguments and edit preview for the disclosure's hidden body."""
    shown = _redact_json(dict(args or {}))
    path = str(shown.get("path") or "")
    if os.path.basename(path.replace("\\", "/")).startswith(".env"):
        for key in ("content", "search", "replace", "text"):
            if isinstance(shown.get(key), str):
                shown[key] = _display_file(path, shown[key])
    details = [c_dim("arguments:")]
    serialized = safe_text(json.dumps(shown, ensure_ascii=False, indent=2,
                                     default=str))
    details.extend(c_dim(line) for line in serialized.splitlines())
    if name == "edit":
        for sign, key in (("-", "search"), ("+", "replace")):
            lines = str((args or {}).get(key, "")).splitlines()
            preview = edit_diff({"path": path, key: "\n".join(lines[:3])})
            details.extend(terminal.diff_preview(mark, text) for mark, text in preview)
            if len(lines) > 3:
                remaining = [terminal.diff_preview(sign, _display_file(path, text))
                             for text in lines[3:]]
                details.append({"summary": "> %d more line(s)" % len(remaining),
                                "details": remaining})
    return details


def show_tool_call(name, args):
    """A clickable '> tool args' line, or the same compact plain output."""
    summary = format_args(name, args)
    shown_name = safe_text(name, 200)
    if TOOLS.get(name, {}).get("approval"):
        # exec/write tools keep the bold-yellow look; approval prompt unchanged
        line = c_bold(c_yellow("  %s %s" % (TOOL_GLYPH, shown_name))) + "  " + c_bold(summary)
    else:
        line = (c_dim("  %s " % TOOL_GLYPH) + c_cyan(shown_name)
                + (c_dim("  " + summary) if summary else ""))
    from .chatbox import active_footer
    screen = active_footer()
    begin = getattr(screen, "begin_tool_call", None)
    if callable(begin):
        try:
            token = begin(line, _tool_call_details(name, args))
            if token is not None:
                # Keep the owning screen with the token; a new active footer
                # must never receive the previous screen's completion.
                return screen, token
        except Exception:
            # Cosmetic rendering cannot prevent a registered tool from running.
            pass
    tprint(line)
    if name == "edit":
        for sign, text in edit_diff(args):
            tprint("      " + terminal.diff_preview(sign, text))


def show_tool_result(name, result, *, token=None):
    """Append the summary and output to this call's body; plain output stays compact."""
    ok, summary = summarize_result(name, result)
    marker = c_green("✓") if ok else c_red("✗")
    line = c_dim("    %s " % RESULT_GLYPH) + marker + c_dim(" " + summary)
    if token is not None:
        screen, identity = token
        finish = getattr(screen, "finish_tool_call", None)
        if callable(finish):
            details = [line]
            details.extend(c_dim(extra)
                           for extra in safe_text(result or "").splitlines())
            try:
                if finish(identity, details):
                    return
            except Exception:
                pass
    tprint(line)
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


def _pet_tool_activity(name):
    """Map registered action names to fixed status text, never tool inputs."""
    if name == "websearch":
        return "searching"
    if name in ("read", "batch_read", "read_json", "browse", "process_output"):
        return "reading"
    if name in ("edit", "write_file", "write_json", "append_file", "replace_all",
                "mkdir", "copy", "move", "remove"):
        return "writing"
    if name in ("shell", "run_command", "process_start", "process_stop"):
        return "running"
    return "checking"


def _run_pet_tool(name, args, workpath, ctx):
    """Keep the pet with a tool's execution and real approval boundary."""
    activity = _pet_tool_activity(name)
    _set_pet_activity(activity)
    approve = ctx.get("approve")
    declined = False
    if callable(approve):
        def resume_after_approval(kind, detail):
            nonlocal declined
            allowed = approve(kind, detail)
            declined = not allowed
            # AgentState.approve paints 'blocked' only when it prompts.
            _set_pet_activity(activity if allowed else "blocked")
            return allowed
        ctx = dict(ctx, approve=resume_after_approval)
    result = run_tool(name, args, workpath, ctx)
    # Both command runners return the same exit-code envelope. Reuse its
    # failure parsing without changing the existing transcript summaries.
    summary_name = "shell" if name == "run_command" else name
    if not declined and not summarize_result(summary_name, result)[0]:
        _set_pet_activity("error")
    return result


def _execute_actions(client, actions, state):
    """Run each tool action; return the [tool result] message text."""
    ctx = state.tool_context()
    parts = []
    state.last_tool_results = []
    token = None
    try:
        for action in actions:
            name = str(action.get("action"))
            args = {k: v for k, v in action.items() if k != "action"}
            token = show_tool_call(name, args)
            result = _run_pet_tool(name, args, client.workpath, ctx)
            state.last_tool_results.append((name, result))
            parts.append("tool %s %s:\n%s" % (name, json.dumps(args), result))
            show_tool_result(name, result, token=token)
            token = None
    except KeyboardInterrupt:
        if token is not None:
            show_tool_result(name, "error: tool stopped by the user", token=token)
        parts.append("error: tool batch stopped by the user")
        raise _ToolCancelled([{
            "role": "user", "content": "[tool result]\n" + "\n\n".join(parts),
        }])
    return "[tool result]\n" + "\n\n".join(parts)


def _execute_native(client, tool_calls, state):
    """Run native tool_calls; return the role:tool messages for history."""
    ctx = state.tool_context()
    out = []
    state.last_tool_results = []
    token = None
    try:
        for call in tool_calls:
            fn = call.get("function") or {}
            name = str(fn.get("name") or "")
            args, error = parse_tool_arguments(fn.get("arguments"))
            if error:
                _set_pet_activity("checking")
                result = "error: " + error
                token = show_tool_call(name, {})
            else:
                token = show_tool_call(name, args)
                result = _run_pet_tool(name, args, client.workpath, ctx)
            out.append({"role": "tool", "tool_call_id": call.get("id") or "",
                        "content": result})
            state.last_tool_results.append((name, result))
            show_tool_result(name, result, token=token)
            token = None
    except KeyboardInterrupt:
        if token is not None:
            show_tool_result(name, "error: tool stopped by the user", token=token)
        # Every assistant tool call needs a matching result, including calls
        # never started after cancellation. Preserve results before rendering.
        out.extend({"role": "tool", "tool_call_id": pending.get("id") or "",
                    "content": "error: stopped by the user"}
                   for pending in tool_calls[len(out):])
        raise _ToolCancelled(out)
    return out


def _apply_status(history, reply_text, status, state):
    """Handle a run-control block. Returns True when the turn is over."""
    if status.get("status") == "blocked":
        _set_pet_activity("blocked")
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
    tprint(c_green("  ⏹ agent complete"))
    _set_pet_activity("complete")
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
    no_progress = 0
    answered = False
    seen_plans = {_plan_snapshot(state.todos)}
    meter = TurnMeter(client)
    state.configure(client)
    refresh_studio_context(client)
    from .settings import effective_budgets
    round_limit = effective_budgets(client).get("maxRounds", MAX_AGENT_ROUNDS)
    if instruction:
        history.append({"role": "user", "content": instruction})
    had_results = substantive_results = _current_request_has_results(history)
    # A paused task keeps its tool evidence only when explicitly resumed.
    # New requests must not inherit recovery from an earlier task's results.
    if (state.resume_results is not None and history and
            history[-1].get("role") == "user" and
            str(history[-1].get("content") or "").strip().casefold() == "continue"):
        had_results |= state.resume_results[0]
        substantive_results |= state.resume_results[1]
    state.resume_results = None
    try:
        while round_limit == 0 or rounds < round_limit:
            rounds += 1
            set_system_message(history, client, state)
            tprint(c_dim("  ── agent round %d ──" % rounds))
            ok, result = stream_reply(client, history, tools=_agent_tool_schemas(client, state),
                                      full=True)
            if not ok:
                _set_pet_activity("cancelled" if result.get("stopped") else "error")
                if result.get("content"):
                    history.append({"role": "assistant", "content": result["content"]})
                state.resume_results = (had_results, substantive_results)
                return False
            meter.add_round()
            reply_text = result.get("content") or ""
            if result.get("stopped"):  # Ctrl-C: keep the partial answer, end the turn
                _set_pet_activity("cancelled")
                if reply_text:
                    history.append({"role": "assistant", "content": reply_text})
                state.resume_results = (had_results, substantive_results)
                return False
            if incomplete_finish(result):
                history.append({"role": "assistant", "content": reply_text})
                return _pause_agent_run("the provider ended an incomplete response; its tools were not executed.",
                                        state, (had_results, substantive_results))
            native = result.get("tool_calls") or []
            actions, status, invalid = parse_tool_blocks(reply_text)
            invalid |= answer_text(reply_text) is None
            invalid |= not (native or actions) and result.get("finish_reason") in ("tool_calls", "function_call")
            if status is not None and status.get("status") == "blocked":
                history.append({"role": "assistant", "content": reply_text,
                                **({"tool_calls": native} if native else {})})
                if native:
                    history.extend({"role": "tool", "tool_call_id": call.get("id") or "",
                                    "content": "error: not executed because the model reported blocked"}
                                   for call in native)
                return _apply_status(history, reply_text, status, state)
            before = _plan_snapshot(state.todos)
            if native:
                history.append({"role": "assistant", "content": reply_text,
                                "tool_calls": native})
                history.extend(_execute_native(client, native, state))
            else:
                history.append({"role": "assistant", "content": reply_text})
                if actions:
                    history.append({"role": "user", "content": _execute_actions(client, actions, state)})
            if native or actions:
                had_results = True
                results = state.last_tool_results
                planning_only = bool(results) and all(name in _PLAN_TOOLS for name, _text in results)
                successes = [summarize_result("shell" if name == "run_command" else name, text)[0]
                             for name, text in results]
                successful_batch = bool(successes) and all(successes)
                substantive_results |= not planning_only
                if not planning_only:
                    answered = False  # new tool work needs a new observed answer
                after = _plan_snapshot(state.todos)
                tool_progress = any(ok and name not in _PLAN_TOOLS
                                    for (name, _text), ok in zip(results, successes))
                progress = tool_progress or (successful_batch and after not in seen_plans and
                                             _plan_advanced(before, after))
                if tool_progress:
                    seen_plans.clear()
                seen_plans.add(after)
                if progress:
                    recovery = no_progress = 0
                else:
                    no_progress += 1
                if status is not None and planning_only and successful_batch and not invalid:
                    if _apply_status(history, reply_text, status, state):
                        return True
                    if progress:
                        no_progress += 1
                elif (planning_only and successful_batch and not invalid and not actions and
                      status is None and reply_text.strip() and not substantive_results and
                      all(item.get("status") == "completed" for item in state.todos)):
                    _set_pet_activity("complete")
                    return True  # a direct answer with only bookkeeping, no task work
                if (planning_only and successful_batch and not invalid and
                        (answered or clean_final_answer(result)) and
                        all(item.get("status") == "completed" for item in state.todos)):
                    _set_pet_activity("complete")
                    return True
                if no_progress >= MAX_NO_PROGRESS:
                    return _pause_agent_run("repeated plan updates or failed tools without task progress.",
                                            state, (had_results, substantive_results))
                if not progress or status is not None:
                    history.append({"role": "user", "content": "[run control] " + (
                        "The tool results are now available; observe them before finishing."
                        if not planning_only else
                        "Planning alone is not new task work. Do not repeat the same plan update. "
                        "Use the next necessary tool, or finish with agent_status complete or blocked. "
                        "For a direct conversational answer with no open plan, reply once without tools.")})
                continue
            if status is not None and not invalid:
                if _apply_status(history, reply_text, status, state):
                    return True
                no_progress += 1
                if no_progress >= MAX_NO_PROGRESS:
                    return _pause_agent_run("completion keeps being requested while plan items remain open.",
                                            state, (had_results, substantive_results))
                continue
            # no action, no completion: recover or treat as the final answer
            unfinished_plan = any(t.get("status") != "completed" for t in state.todos)
            answered = clean_final_answer(result, invalid)
            if answered and not unfinished_plan:
                _set_pet_activity("complete")
                return True
            if ((substantive_results or (had_results and unfinished_plan)) and
                    recovery < MAX_RECOVERY):
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
            if invalid or substantive_results or unfinished_plan:
                return _pause_agent_run("the model did not provide a usable next action or completion.",
                                        state, (had_results, substantive_results))
            _set_pet_activity("complete")
            return True  # plain prose answer — turn over
        tprint(c_yellow("  ⏸ agent round limit reached — send 'continue' to resume"))
        state.resume_results = (had_results, substantive_results)
        _set_pet_activity("blocked")
        return True
    except KeyboardInterrupt as exc:  # Ctrl-C during a tool or an approval 'q'
        _set_pet_activity("cancelled")
        if isinstance(exc, _ToolCancelled):
            history.extend(exc.messages)
            # Even a stopped first batch leaves tool results to observe when
            # resumed; preserve that evidence without claiming tool success.
            had_results = substantive_results = True
        state.resume_results = (had_results, substantive_results)
        print()
        tprint(c_red("  ✗ stopped"))
        return False
    except Exception:  # never surface a traceback from the agent loop
        _set_pet_activity("error")
        state.resume_results = (had_results, substantive_results)
        _calm_failure()
        return False
    finally:
        meter.publish()  # client.last_turn after every agent turn




def run_web_answer(client, query, fetch_pages=True):
    try:
        _scope, query = prepare_agent_message(client, query)
        if query is None:
            return _scope is _STUDIO_INFORMATION
        return _run_web_answer(client, query, fetch_pages)
    finally:
        context = getattr(client, "studio_context", None)
        if context is not None:
            context.clear()


def _run_web_answer(client, query, fetch_pages=True):
    _set_pet_activity("searching")
    print()
    status_line("searching the web for: " + c_bold(query))
    started = time.time()
    try:
        found = search_web(query)
        results = found["results"]
    except KeyboardInterrupt:
        _set_pet_activity("cancelled")
        raise
    except Exception:
        _set_pet_activity("error")
        raise
    if not results:
        _set_pet_activity("error")
        tprint(c_red("  ✗ no results (search engine unavailable or blocked)"))
        return False
    status_line("%d result(s) in %.1fs" % (len(results), time.time() - started))

    pages = {}
    if fetch_pages:
        top = results[:PAGE_FETCH_LIMIT]
        _set_pet_activity("reading")
        for index, result in enumerate(top, start=1):
            spinner("reading [%d] %s…" % (index, result["url"][:52]))
            try:
                text = fetch_text(result["url"])
            except KeyboardInterrupt:
                _set_pet_activity("cancelled")
                raise
            except Exception:
                _set_pet_activity("error")
                raise
            finally:
                spinner_clear()
            if text:
                pages[index] = text
                status_line(
                    "fetched [%d] %s (%d chars)"
                    % (index, result["title"][:40], len(text))
                )
        print()

    messages = build_grounded_messages(query, results, pages, rich=found["rich"])
    refresh_studio_context(client)
    context = getattr(client, "studio_context", None)
    if context is not None:
        block = context.prompt_block()
        if block:
            messages[0]["content"] += "\n\n" + block
    meter = TurnMeter(client)
    ok, result = stream_reply(client, messages, full=True)
    if ok:
        meter.add_round()
    meter.publish()
    if ok:
        print_footer(client, cited=True)
    if isinstance(result, dict) and result.get("stopped"):
        _set_pet_activity("cancelled")
    elif ok:
        _set_pet_activity("complete")
    else:
        _set_pet_activity("error")
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
    if not hasattr(client, "conversation_store"):
        from .state import ConversationStore
        client.conversation_store = ConversationStore(client)
        client.conversation_store.apply_preferences()
    try:
        saved = terminal.load_session_config()
        if saved.get("layout"):
            terminal.set_layout(saved["layout"])
        if saved.get("theme"):
            terminal.set_theme(saved["theme"])
        if saved.get("pet"):
            client.pet = saved["pet"]
        if isinstance(saved.get("pet_motion"), bool):
            client.pet_motion = saved["pet_motion"]
    except Exception:
        pass
    from .chatbox import footer_session
    with footer_session(client):
        return _run_chat_loop(client, base, initial_prompt)


def _run_chat_loop(client, base, initial_prompt=None):
    banner(client, base, "chat")
    endpoint_notice(client)
    histories = {None: []}
    agent_states = {None: AgentState()}
    history = histories[None]
    agent_state = agent_states[None]
    session = ReplSession()
    scoped_sessions = {}
    thoughts = {}
    scope = None
    store = getattr(client, "conversation_store", None)
    turn_status = "idle"
    if store is not None:
        restored = store.restore(histories, scoped_sessions, session)
        history = histories.setdefault(None, [])
        if restored:
            tprint(c_dim("  restored the last conversation · /clear resets it · --new-session starts fresh"))
            for message in history:
                if message["role"] == "user":
                    tprint(c_green("  you ▸ ") + message["content"])
                else:
                    response_open()
                    markdown = render.MarkdownStream() if render.enabled() else None
                    if markdown is None:
                        tprint(message["content"])
                    else:
                        for row in markdown.feed(message["content"]) + markdown.flush():
                            tprint(row)
            if any(key is not None for key in histories):
                tprint(c_dim("  addressed conversations restored; use @agent to return to one."))

    def checkpoint(status=None, activity=True):
        if store is None:
            return
        store.checkpoint(histories, scoped_sessions, session, scope,
                         status or turn_status, activity=activity)
        if store.failed and not store.warned:
            store.warned = True
            tprint(c_yellow("  conversation could not be saved; check the config directory permissions or size."))

    client._session_checkpoint = checkpoint
    client.last_thought = ""
    context = getattr(client, "studio_context", None)
    if context is not None:
        context.clear()
    set_system_message(history, client)
    checkpoint(activity=False)
    pending_prompt = initial_prompt
    followups_ready = True  # a queued follow-up fires only after a completed turn
    try:
        while True:
            thoughts[scope] = getattr(client, "last_thought", "")
            client.last_thought = thoughts.get(None, "")
            context = getattr(client, "studio_context", None)
            if context is not None:
                context.clear()
            history = histories[None]
            agent_state = agent_states[None]
            if pending_prompt is not None:
                line, pending_prompt = pending_prompt, None
                from .chatbox import active_footer
                screen = active_footer()
                if screen is not None:
                    from .input_privacy import sanitize_endpoint_command
                    from .pet_care import parse_care_command
                    echo = bool(str(line).strip()) and parse_care_command(line) is None
                    screen.finish_input(sanitize_endpoint_command(line), echo=echo)
            else:
                line = None
                if followups_ready:
                    # The collector already echoed this prompt when it was
                    # queued mid-reply; do not echo it a second time.
                    from .chatbox import active_footer
                    screen = active_footer()
                    take = getattr(screen, "take_followup", None)
                    if callable(take):
                        line = take()
                if line is None:
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
                if line.split()[0].lower() in ("/clear", "/undo"):
                    scope, turn_status = None, "idle"
                checkpoint(activity=not result.quit)
                if result.quit:
                    tprint(c_dim("  bye."))
                    return
                if not result.prompt:
                    continue
                line = result.prompt
            addressed_line = line
            scope, line = prepare_agent_message(client, line)
            if line is None:
                continue
            history = histories.setdefault(scope, [])
            agent_state = agent_states.setdefault(scope, AgentState())
            client.last_thought = thoughts.get(scope, "")
            addressed_session = scoped_sessions.setdefault(scope, ReplSession()) if scope is not None else session
            if scope is not None and line.startswith("/"):
                result = handle_slash(line, client, history, addressed_session)
                if line.split()[0].lower() in ("/clear", "/undo"):
                    turn_status = "idle"
                checkpoint(activity=not result.quit)
                if result.quit:
                    tprint(c_dim("  bye."))
                    return
                if not result.prompt:
                    continue
                line = result.prompt
            session.remember(addressed_line)
            if scope is not None:
                addressed_session.remember(line)
            history.append({"role": "user", "content": line})
            from .state import validate_restored_model
            validate_restored_model(client, refresh=True)
            if client._restored_model_blocked:
                history.pop()
                checkpoint()
                continue
            turn_status = "running"
            checkpoint()
            if client.agent:
                try:
                    followups_ready = bool(
                        run_agent_turn(client, history, agent_state))
                except Exception:
                    _set_pet_activity("error")
                    _calm_failure()
                    followups_ready = False
                interrupted = (not followups_ready or agent_state.resume_results is not None
                               or any(item.get("status") != "completed" for item in agent_state.todos))
                turn_status = "interrupted" if interrupted else "idle"
                checkpoint()
                continue
            try:
                refresh_studio_context(client)
                set_system_message(history, client)
                meter = TurnMeter(client)
                ok, result = stream_reply(client, history, full=True)
                # A released turn counts as complete for the queue — its
                # whole point is firing the follow-up the moment it ends.
                followups_ready = bool(result.get("released")
                                       or (ok and not result.get("stopped")))
                if ok:
                    meter.add_round()
                meter.publish()
                reply_text = result.get("content") or ""
                if result.get("stopped"):  # Ctrl-C: keep partial text, back to you ▸
                    _set_pet_activity("cancelled")
                    if reply_text:
                        history.append({"role": "assistant", "content": reply_text})
                    else:
                        history.pop()
                    turn_status = "interrupted"
                    checkpoint()
                    continue
                if ok:
                    history.append({"role": "assistant", "content": reply_text})
                    print_footer(client)
                    _set_pet_activity("complete")
                    if client.agent:
                        applied = review_and_apply_edits(client.workpath, reply_text,
                                                         auto_yes=autopilot_enabled(client))
                        if applied:
                            status_line(c_green("%d edit(s) applied" % applied))
                else:
                    _set_pet_activity("error")
                    if reply_text:
                        history.append({"role": "assistant", "content": reply_text})
                    else:
                        history.pop()
                turn_status = "idle" if followups_ready else "interrupted"
                checkpoint()
            except Exception as exc:
                _set_pet_activity("error")
                tprint(c_red("  ✗ %s" % exc))
                partial = store.partial_text() if store is not None else ""
                if partial and history[-1].get("role") == "user":
                    history.append({"role": "assistant", "content": partial})
                else:
                    history.pop()
                followups_ready = False
                turn_status = "interrupted"
                checkpoint()
    except KeyboardInterrupt:
        _set_pet_activity("cancelled")
        raise
    finally:
        # footer_session restores the caller's terminal and output stream.
        checkpoint(status="interrupted" if turn_status == "running" else turn_status, activity=False)
        client._session_checkpoint = None
        for state in agent_states.values():
            cleanup_owned_processes(client.workpath, state.tool_context())
        context = getattr(client, "studio_context", None)
        if context is not None:
            context.clear()




def run_ask(client, question, web=False):
    if web:
        return run_web_answer(client, question)
    try:
        _scope, question = prepare_agent_message(client, question)
        if question is None:
            return _scope is _STUDIO_INFORMATION
        return _run_ask(client, question)
    finally:
        context = getattr(client, "studio_context", None)
        if context is not None:
            context.clear()


def _run_ask(client, question):
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
        applied = review_and_apply_edits(client.workpath, reply_text,
                                         auto_yes=autopilot_enabled(client))
        if applied:
            status_line(c_green("%d edit(s) applied" % applied))
    return True
