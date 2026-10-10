"""Chat modes: interactive REPL, one-shot ask, grounded web answer."""

import json
import os
import re
import sys
import time
import urllib.parse

from .agent_tools import TOOLS, run_tool, tool_help_text
from .client import ReachApiError
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


def stream_reply(client, messages, indent=None):
    """Streams a reply under a styled left rule; returns (ok, full_text).

    Shows an animated waiting line until the first token arrives, so a
    long upstream wait (reasoning models, slow aliases, cold relays) is
    never silent.
    """
    if indent is None:
        indent = response_indent()
    response_open()
    indicator = WaitIndicator(prefix=response_label())
    indicator.start()
    text_parts = []
    buf = ""
    at_start = True  # next write begins a fresh line
    first = True     # first line continues after the 'ai ▸' label
    try:
        for delta in client.chat(messages):
            indicator.stop()
            text_parts.append(delta)
            buf += delta
            while True:
                newline = buf.find("\n")
                if newline == -1:
                    break
                line, buf = buf[:newline], buf[newline + 1:]
                if not first and at_start:
                    sys.stdout.write(indent)
                sys.stdout.write(line + "\n")
                at_start = True
                first = False
            if buf:
                if not first and at_start:
                    sys.stdout.write(indent)
                sys.stdout.write(buf)
                buf = ""  # consumed — never re-emit this chunk on the next delta
                at_start = False
                first = False
            sys.stdout.flush()
    except ReachApiError as exc:
        indicator.stop()
        print()
        print(c_red("  ✗ " + str(exc)))
        return False, ""
    finally:
        indicator.stop()
    print()
    return True, "".join(text_parts)


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


def _execute_actions(client, actions, state):
    """Run each tool action; return the [tool result] message text."""
    ctx = {"todos": state.todos, "approve": state.approve}
    parts = []
    for action in actions:
        name = str(action.get("action"))
        args = {k: v for k, v in action.items() if k != "action"}
        if TOOLS.get(name, {}).get("approval"):
            preview = args.get("command") or args.get("path") or name
            print(c_bold(c_yellow("  agent %s → ")) % name, c_bold(str(preview)))  # noqa: E501
        else:
            print(c_dim("  agent %s → %s" % (name, json.dumps(args)[:90])))
        result = run_tool(name, args, client.workpath, ctx)
        first = result.splitlines()[0][:100] if result else ""
        marker = c_red("✗") if result.startswith("error:") else c_green("✓")
        print(marker + c_dim("  " + first))
        parts.append("tool %s %s:\n%s" % (name, json.dumps(args), result))
    return "[tool result]\n" + "\n\n".join(parts)


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
    if instruction:
        history.append({"role": "user", "content": instruction})
    try:
        while rounds < MAX_AGENT_ROUNDS:
            rounds += 1
            set_system_message(history, client)
            print(c_dim("  ── agent round %d ──" % rounds))
            ok, reply_text = stream_reply(client, history)
            if not ok:
                return False
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
                m.get("role") == "user" and m.get("content", "").startswith("[tool result]")
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
            print_footer(client)
            return True  # plain prose answer — turn over
        print(c_yellow("  ⏸ agent round limit reached — send 'continue' to resume"))
        return True
    except KeyboardInterrupt:
        print(c_dim("\n  agent stopped."))
        return False




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
    stream_reply(client, messages)
    print_footer(client, cited=True)
    return True




def _host_port(base):
    try:
        parsed = urllib.parse.urlparse(base or "")
    except ValueError:
        return ""
    if not parsed.hostname:
        return ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return "%s:%s" % (parsed.hostname, port)


def endpoint_notice(client):
    """One-line heads-up when the chosen endpoint is down. Never switches."""
    base = getattr(client, "base", "") or ""
    try:
        up = type(client)._reachable(base, getattr(client, "key", "") or "")
    except Exception:
        up = True
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
    try:
        endpoint_notice(client)
    except Exception:
        pass
    history = []
    agent_state = AgentState()
    session = ReplSession()
    set_system_message(history, client)
    try:
        while True:
            try:
                line = input(c_bold(c_green("you ▸ ")))
            except (EOFError, KeyboardInterrupt):
                print(c_dim("\n  bye."))
                return
            line = line.strip()
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
                except Exception as exc:
                    print(c_red("  ✗ %s" % exc))
                continue
            try:
                ok, reply_text = stream_reply(client, history)
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
    ok, reply_text = stream_reply(client, messages)
    if not ok:
        return False
    print_footer(client)
    if client.agent:
        applied = review_and_apply_edits(client.workpath, reply_text)
        if applied:
            status_line(c_green("%d edit(s) applied" % applied))
    return True
