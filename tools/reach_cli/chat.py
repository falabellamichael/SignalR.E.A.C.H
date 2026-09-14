"""Chat modes: interactive REPL, one-shot ask, grounded web answer."""

import json
import os
import re
import sys
import time

from .client import ReachApiError
from .grounding import build_grounded_messages
from .terminal import (
    banner,
    c_bold,
    c_cyan,
    c_dim,
    c_green,
    c_magenta,
    c_red,
    c_yellow,
    print_footer,
    response_indent,
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
    "directory called the workpath. When the user asks you to change or create "
    "files, act like an agent: briefly explain what you will do, then emit each "
    "file change as a fenced JSON block, one ```edit block per file:\n"
    '```edit\n{"path": "relative/path/from/workpath", "search": "exact existing text", "replace": "new text"}\n```\n'
    'Rules: "path" is relative to the workpath and uses forward slashes. '
    '"search" must be a small exact snippet of the current file; use "" as '
    "search to create a brand-new file with the full content in \"replace\". "
    "Emit multiple blocks for multiple edits. Only emit blocks when the change "
    "is clear, otherwise ask. The user reviews and approves every edit before it "
    "is applied, so never claim a file was already changed — you only propose edits."
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
    """Streams a reply under a styled left rule; returns (ok, full_text)."""
    if indent is None:
        indent = response_indent()
    response_open()
    text_parts = []
    buf = ""
    at_start = True  # next write begins a fresh line
    first = True     # first line continues after the 'ai ▸' label
    try:
        for delta in client.chat(messages):
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
        print()
        print(c_red("  ✗ " + str(exc)))
        return False, ""
    print()
    return True, "".join(text_parts)




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




def repl_commands():
    return {
        "/help": "show this help",
        "/model <alias>": "switch model (aliases below)",
        "/models": "list models served by the endpoint",
        "/web <question>": "grounded search-and-answer (SimpleRAG websearch)",
        "/agent": "toggle agent mode (model can propose file edits)",
        "/workpath <dir>": "set the directory the agent works in",
        "/system <text>": "set/clear the session system prompt",
        "/clear": "reset the conversation",
        "/history": "show the conversation so far",
        "/save [file]": "save the conversation as JSONL",
        "/exit": "quit (also Ctrl+C or Ctrl+D)",
    }




def run_chat(client, base):
    banner(client, base, "chat")
    history = []
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
                command, _, argument = line.partition(" ")
                command = command.lower()
                argument = argument.strip()
                if command == "/exit" or command == "/quit":
                    print(c_dim("  bye."))
                    return
                if command == "/help":
                    for key, description in repl_commands().items():
                        print("  %-16s %s" % (c_cyan(key), description))
                    continue
                if command == "/models":
                    try:
                        models = client.models()
                        print(c_dim("  served models:"))
                        for alias in models:
                            marker = " ●" if alias == client.model else ""
                            print("   - %s%s" % (alias, c_green(marker)))
                    except Exception as exc:
                        print(c_red("  ✗ models: %s" % exc))
                    continue
                if command == "/model":
                    if not argument:
                        print(c_yellow("  usage: /model <alias>"))
                        continue
                    try:
                        served = client.models()
                    except Exception:
                        served = None
                    if served is not None and argument not in served:
                        print(c_red("  ✗ unknown model %r — try /models" % argument))
                        continue
                    client.model = argument
                    print(c_green("  model → ") + c_bold(argument))
                    continue
                if command == "/web":
                    if not argument:
                        print(c_yellow("  usage: /web <question>"))
                        continue
                    query = argument
                    if history:
                        history.append({"role": "user", "content": query})
                    run_web_answer(client, query)
                    continue
                if command == "/system":
                    client.system = argument or None
                    set_system_message(history, client)
                    print(
                        c_green("  system prompt ")
                        + ("set" if client.system else "cleared")
                    )
                    continue
                if command == "/agent":
                    client.agent = not client.agent
                    set_system_message(history, client)
                    print(
                        c_green("  agent mode ")
                        + c_bold("on" if client.agent else "off")
                        + c_dim(" (workpath: " + client.workpath + ")")
                    )
                    continue
                if command == "/workpath":
                    if not argument:
                        print(c_yellow("  usage: /workpath <dir>"))
                        continue
                    target = os.path.abspath(os.path.expanduser(argument))
                    if not os.path.isdir(target):
                        print(c_red("  ✗ not a directory: " + target))
                        continue
                    client.workpath = target
                    set_system_message(history, client)
                    print(c_green("  workpath → ") + c_bold(target))
                    continue
                if command == "/clear":
                    history = []
                    set_system_message(history, client)
                    print(c_green("  conversation cleared"))
                    continue
                if command == "/history":
                    for message in history:
                        role = message["role"]
                        color = c_cyan if role == "user" else c_magenta
                        print(
                            color("  %s:" % role),
                            message["content"][:200].replace("\n", " "),
                        )
                    continue
                if command == "/save":
                    path = argument or (
                        "reach-chat-%s.jsonl" % time.strftime("%Y%m%d-%H%M%S")
                    )
                    with open(path, "w", encoding="utf-8") as handle:
                        for message in history:
                            handle.write(json.dumps(message) + "\n")
                    print(c_green("  saved → ") + path)
                    continue
                print(c_yellow("  unknown command %r — /help" % command))
                continue
            history.append({"role": "user", "content": line})
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
    ok, reply_text = stream_reply(client, messages)
    if not ok:
        return False
    print_footer(client)
    if client.agent:
        applied = review_and_apply_edits(client.workpath, reply_text)
        if applied:
            status_line(c_green("%d edit(s) applied" % applied))
    return True
