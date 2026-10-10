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
    TOOLS,
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
)
from .websearch import PAGE_FETCH_LIMIT, fetch_text, search_web


# ---- agent mode -----------------------------------------------------------

DEFAULT_IDENTITY = (
    "You are SimpleREACH, the REACH coding assistant."
)

AGENT_SYSTEM_PROMPT = (
    "You are SimpleREACH, an agentic coding assistant. You operate inside a "
    "directory called the workpath and act through local tools.\n\n"
    "TOOLS:\n"
    + tool_help_text()
    + "\n\nTo take an action, emit one standalone fenced tool block as your "
    "whole reply (one action per turn):\n"
    '```tool\n{"action": "search", "pattern": "def \\w+", "regex": true}\n```\n'
    "After every tool block you receive a [tool result] message. React to it "
    "with the next action. Never guess what a tool returned. Before starting a "
    "multi-step task, write a plan with todo_write and keep it updated.\n\n"
    "RUN CONTROL (required; ordinary prose never ends the task):\n"
    "When the request is fully handled (plan complete, edits applied, changes "
    "verified with shell where possible), finish with exactly:\n"
    '```agent_status\n{"status": "complete", "summary": "What was done and how it was verified."}\n```\n'
    "If you need a decision from the user, ask in plain prose and stop — do not "
    "emit agent_status. Do not claim completion while work remains."
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
        print(c_bold(c_cyan("  agent edit:")), c_bold(block["path"]))
        if block["search"]:
            print(c_dim("    search:  ") + c_dim(block["search"][:90]))
        print(c_dim("    replace: ") + c_dim(block["replace"][:90]))
    print()
    applied = 0
    for block in blocks:
        if auto_yes:
            answer = "y"
        else:
            try:
                answer = input(
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
            print(c_dim("    skipped %s" % block["path"]))
            continue
        ok, error = apply_edit(workpath, block["path"], block["search"], block["replace"])
        if ok:
            applied += 1
            print(c_green("    ✓ applied %s" % block["path"]))
        else:
            print(c_red("    ✗ %s" % error))
    return applied


def workpath_context(workpath):
    try:
        entries = sorted(os.listdir(workpath))[:120]
    except OSError:
        return workpath
    return "\n".join(
        os.path.join(workpath, e).replace("\\", "/") for e in entries
    )


def build_system(client):
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
    return "\n\n".join(parts)


def set_system_message(history, client):
    prompt = build_system(client)
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


def request_reply(client, messages, tools=None, on_text=None, on_retry=None):
    """Ask the endpoint with retries on the SAME provider and model.

    Returns (ok, {"content", "tool_calls"}). Transient failures back off and
    retry; text already streamed is kept and the model is asked to continue,
    so a cut stream never loses work. Never touches client.model/base.
    """
    kept_text = ""
    last = None
    attempts = 0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        convo = list(messages)
        if kept_text:
            convo += [{"role": "assistant", "content": kept_text},
                      {"role": "user", "content": _CONTINUE_PROMPT}]
        attempts = attempt
        try:
            result = client.complete(convo, tools=tools, on_text=on_text)
            return True, {"content": kept_text + (result.get("content") or ""),
                          "tool_calls": result.get("tool_calls") or []}
        except ReachTransientError as exc:
            last = exc
            got = exc.partial or {}
            kept_text += got.get("content") or ""
            calls = _complete_tool_calls(got.get("tool_calls"))
            if calls:  # the call(s) arrived whole before the cut: use them
                return True, {"content": kept_text, "tool_calls": calls}
            if attempt < MAX_ATTEMPTS:
                if on_retry:
                    on_retry(attempt + 1)
                _sleep(_backoff(attempt))
                continue
        except ReachApiError as exc:
            last = exc
            break
        except Exception as exc:  # never let an unexpected error escape
            last = exc
            break
    if kept_text:  # keep what arrived rather than discarding it
        return True, {"content": kept_text, "tool_calls": []}
    return False, {"content": "", "tool_calls": [], "error": str(last or ""),
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
    print(c_red("  ✗ the model didn't answer: %s — "
                "send your message again or /retry" % reason))


class TurnMeter:
    """Collects tokens/latency for one user turn and publishes client.last_turn."""

    def __init__(self, client):
        self.client = client
        self.started = time.time()
        self.tokens = None
        self.rounds = 0

    def add_round(self):
        self.rounds += 1
        got = usage_tokens(getattr(self.client, "usage", None))
        if got is not None:
            self.tokens = (self.tokens or 0) + got

    def publish(self):
        turn = {
            "rounds": max(1, self.rounds),
            "latency": round(time.time() - self.started, 3),
        }
        if self.tokens is not None:  # contract: omit unknown keys
            turn["tokens"] = self.tokens
        self.client.last_turn = turn
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
        print(c_dim("\n  bye."))
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
    Ctrl-C stops only this answer: partial text is kept and '✗ stopped' shown.
    """
    if indent is None:
        indent = response_indent()
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
                sys.stdout.write(indent)
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
                sys.stdout.write(indent)
            sys.stdout.write(line + "\n")
            state["at_start"] = True
            state["first"] = False
        if buf:
            if not state["first"] and state["at_start"]:
                sys.stdout.write(indent)
            sys.stdout.write(buf)
            state["at_start"] = False
            state["first"] = False
        state["midline"] = not delta.endswith("\n")
        sys.stdout.flush()

    def write(delta):
        state["text"].append(delta)
        if md is None:
            write_raw(delta)
        else:
            emit_lines(md.feed(delta))

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

    def guarded(fn):
        def inner(*a):
            if not cancelled.is_set():  # a stopped answer prints nothing more
                fn(*a)
        return inner

    try:
        ok, result = _interruptible(
            lambda: request_reply(client, messages, tools=tools,
                                  on_text=guarded(write), on_retry=guarded(retry)))
    except KeyboardInterrupt:
        cancelled.set()
        stopped = True
        ok = True
        result = {"content": "".join(state["text"]), "tool_calls": [],
                  "stopped": True}
    finally:
        state["indicator"].stop()
    if md is not None:
        emit_lines(md.flush())
    if stopped:
        if state["midline"]:
            sys.stdout.write("\n")
        print(c_red("  ✗ stopped"))
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
_STATUS_FENCE = re.compile(r"```agent_status\s*\n(.*?)```", re.DOTALL)

MAX_AGENT_ROUNDS = 16
MAX_RECOVERY = 2


class AgentState:
    """Per-session agent state: the plan and the 'always approve' switch."""

    def __init__(self):
        self.todos = []
        self.auto_approve = False

    def approve(self, kind, detail):
        """Approval callback for exec/write tools."""
        if self.auto_approve:
            return True
        print()
        print(c_bold(c_yellow("  agent %s: " % kind)) + c_bold(detail))
        try:
            answer = input(c_bold(c_yellow("  allow? [y/n/a/q] "))).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return False
        if answer == "a":
            self.auto_approve = True
            return True
        if answer == "q":
            raise KeyboardInterrupt  # stop the whole run
        return answer in ("y", "yes")


def parse_tool_blocks(text):
    """Split a reply into (actions, status, invalid)."""
    actions = []
    for raw in _TOOL_FENCE.findall(text or ""):
        try:
            data = json.loads(raw.strip())
        except (ValueError, AttributeError):
            continue
        if isinstance(data, dict) and data.get("action"):
            actions.append(data)
    status = None
    for raw in _STATUS_FENCE.findall(text or ""):
        try:
            data = json.loads(raw.strip())
        except (ValueError, AttributeError):
            continue
        if isinstance(data, dict) and data.get("status") in ("complete", "blocked"):
            status = data
    invalid = bool(_TOOL_FENCE.search(text or "")) and not actions
    return actions, status, invalid


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
        print(c_bold(c_yellow("  %s %s" % (TOOL_GLYPH, name))) + "  " + c_bold(summary))
    else:
        print(c_dim("  %s " % TOOL_GLYPH) + c_cyan(name)
              + (c_dim("  " + summary) if summary else ""))
    if name == "edit":
        for sign, text in edit_diff(args):
            paint = c_red if sign == "-" else c_green
            print("      " + paint("%s %s" % (sign, text)))


def show_tool_result(name, result):
    """'    ⎿ ✓ summary' (green) or '    ⎿ ✗ summary' (red)."""
    ok, summary = summarize_result(name, result)
    marker = c_green("✓") if ok else c_red("✗")
    print(c_dim("    %s " % RESULT_GLYPH) + marker + c_dim(" " + summary))


def _execute_actions(client, actions, state):
    """Run each tool action; return the [tool result] message text."""
    ctx = {"todos": state.todos, "approve": state.approve}
    parts = []
    for action in actions:
        name = str(action.get("action"))
        args = {k: v for k, v in action.items() if k != "action"}
        show_tool_call(name, args)
        result = run_tool(name, args, client.workpath, ctx)
        show_tool_result(name, result)
        parts.append("tool %s %s:\n%s" % (name, json.dumps(args), result))
    return "[tool result]\n" + "\n\n".join(parts)


def _execute_native(client, tool_calls, state):
    """Run native tool_calls; return the role:tool messages for history."""
    ctx = {"todos": state.todos, "approve": state.approve}
    out = []
    for call in tool_calls:
        fn = call.get("function") or {}
        name = str(fn.get("name") or "")
        args, error = parse_tool_arguments(fn.get("arguments"))
        if error:
            result = "error: " + error
            print(c_dim("  ⏺ %s  (unreadable arguments, asking again)" % name))
        else:
            show_tool_call(name, args)
            result = run_tool(name, args, client.workpath, ctx)
            show_tool_result(name, result)
        out.append({"role": "tool", "tool_call_id": call.get("id") or "",
                    "content": result})
    return out


def _apply_status(history, reply_text, status, state):
    """Handle a run-control block. Returns True when the turn is over."""
    if status.get("status") == "blocked":
        print(c_yellow("  ⏸ agent blocked: " + str(status.get("reason", ""))[:300]))
        return True
    open_items = [t for t in state.todos if t.get("status") != "completed"]
    if open_items:
        # completion rejected — nudge the model to finish the plan
        history.append({"role": "assistant", "content": reply_text})
        history.append({
            "role": "user",
            "content": "[run control] Completion rejected: %d plan item(s) "
            "remain open: %s. Continue working; request the next tool."
            % (len(open_items), json.dumps(open_items)),
        })
        return False
    print(c_green("  ⏹ agent complete: " + str(status.get("summary", ""))[:300]))
    return True


def run_agent_turn(client, history, state, instruction=None):
    """One full agent run: act → observe → act … until complete/blocked/paused.

    ``instruction`` optionally injects a recovery prompt before the first
    round. History is mutated with the tool exchanges; the visible transcript
    stays readable because tool blocks live inside the assistant messages.
    """
    rounds = 0
    recovery = 0
    meter = TurnMeter(client)
    if instruction:
        history.append({"role": "user", "content": instruction})
    try:
        while rounds < MAX_AGENT_ROUNDS:
            rounds += 1
            set_system_message(history, client)
            print(c_dim("  ── agent round %d ──" % rounds))
            ok, result = stream_reply(client, history, tools=tool_schemas(),
                                      full=True)
            if not ok:
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
                if _apply_status(history, reply_text, status, state):
                    return True
                continue
            if actions:
                recovery = 0
                history.append({
                    "role": "user",
                    "content": _execute_actions(client, actions, state),
                })
                continue
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
        print(c_yellow("  ⏸ agent round limit reached — send 'continue' to resume"))
        return True
    except KeyboardInterrupt:  # Ctrl-C during a tool or an approval 'q'
        print()
        print(c_red("  ✗ stopped"))
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
        print(c_red("  ✗ no results (search engine unavailable or blocked)"))
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
    print_footer(client, cited=True)
    return True




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
        hint = "start SignalREACH (python %s start)" % os.path.join("tools", "reach.py")
    else:
        hint = "check the endpoint"
    print(c_yellow("  ! no answer from %s yet — %s, or switch with /endpoint"
                   % (where, hint)))
    return True


def run_chat(client, base):
    banner(client, base, "chat")
    endpoint_notice(client)
    history = []
    agent_state = AgentState()
    session = ReplSession()
    set_system_message(history, client)
    try:
        while True:
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
                    print(c_dim("  bye."))
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
                    history.pop()
            except Exception as exc:
                print(c_red("  ✗ %s" % exc))
                history.pop()
    finally:
        pass




def run_ask(client, question, web=False):
    if web:
        return run_web_answer(client, question)
    messages = []
    prompt = build_system(client)
    if prompt:
        messages.append({"role": "system", "content": prompt})
    messages.append({"role": "user", "content": question})
    if client.agent:
        return run_agent_turn(client, messages, AgentState())
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
