#!/usr/bin/env python3
"""SimpleREACH CLI — a terminal suite for the REACH endpoint.

REACH = RAG Endpoint & AI Chat Host.

Commands
  chat                 interactive multi-turn chat (streaming, /commands)
  ask "question"       one-shot answer (add --web to ground it in live search)
  web "question"       search the web, read the top pages, answer with citations
                       (SimpleRAG's DuckDuckGo scraping approach, ported)

The search engine mirrors SimpleRAG's web search: DuckDuckGo's HTML endpoint
(with the lite endpoint as fallback), rotating user agents, rich answer
modules, then a grounded prompt with [n] citations.

Stdlib only. No API key needed — the endpoint is keyless.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from . import terminal
from .terminal import (
    Paint,
    banner,
    c_bold,
    c_cyan,
    c_dim,
    c_green,
    c_magenta,
    c_red,
    c_yellow,
    enable_ansi,
    print_footer,
    spinner,
    spinner_clear,
    status_line,
)
from .websearch import (
    PAGE_FETCH_LIMIT,
    fetch_text,
    search_web,
)
from .client import (
    ReachApiError,
    ReachClient,
)
from .grounding import build_grounded_messages

DEFAULT_BASE = os.environ.get("REACH_BASE_URL", "http://127.0.0.1:20777/v1")
# ---------------------------------------------------------------------------
# ANSI colour helpers (auto-disabled for pipes / NO_COLOR / --no-color)
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# UI bits
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Chat modes
# ---------------------------------------------------------------------------


def stream_reply(client, messages):
    """Streams a reply; returns False when the endpoint refused."""
    try:
        for delta in client.chat(messages):
            sys.stdout.write(delta)
            sys.stdout.flush()
    except ReachApiError as exc:
        print(c_red("  ✗ " + str(exc)))
        return False
    print()
    return True


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
        "/system <text>": "set/clear the session system prompt",
        "/clear": "reset the conversation",
        "/history": "show the conversation so far",
        "/save [file]": "save the conversation as JSONL",
        "/exit": "quit (also Ctrl+C or Ctrl+D)",
    }


def run_chat(client, base):
    banner(client, base, "chat")
    history = []
    if client.system:
        history.append({"role": "system", "content": client.system})
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
                    if client.system:
                        history = [m for m in history if m.get("role") != "system"]
                        history.insert(0, {"role": "system", "content": client.system})
                        print(c_green("  system prompt set"))
                    else:
                        history = [m for m in history if m.get("role") != "system"]
                        print(c_green("  system prompt cleared"))
                    continue
                if command == "/clear":
                    history = (
                        [{"role": "system", "content": client.system}]
                        if client.system
                        else []
                    )
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
            print(c_bold(c_magenta("ai  ▸ ")), end="")
            sys.stdout.flush()
            try:
                ok = stream_reply(client, history)
                if ok:
                    print_footer(client)
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
    if client.system:
        messages.append({"role": "system", "content": client.system})
    messages.append({"role": "user", "content": question})
    if not stream_reply(client, messages):
        return False
    print_footer(client)
    return True


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="reach-cli",
        description="SimpleREACH CLI — terminal chat + web-grounded answers "
        "over the REACH endpoint (keyless).",
    )
    parser.add_argument(
        "command", nargs="?", choices=("chat", "ask", "web", "models"), default="chat"
    )
    parser.add_argument("text", nargs="?", help="question for 'ask'/'web'")
    parser.add_argument(
        "--base",
        default=None,
        help="endpoint base URL (default: local relay, "
        "falls back to the public pointer)",
    )
    parser.add_argument("--model", default=None, help="model alias")
    parser.add_argument("--system", default=None, help="session system prompt")
    parser.add_argument(
        "--no-stream", action="store_true", help="non-streaming responses"
    )
    parser.add_argument("--no-color", action="store_true", help="disable ANSI colours")
    parser.add_argument(
        "--no-fetch", action="store_true", help="web mode: don't fetch page excerpts"
    )
    args = parser.parse_args(argv)

    terminal.PAINT = Paint(enable_ansi() and not args.no_color)
    if os.name == "nt":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")

    client = ReachClient(
        args.base or DEFAULT_BASE, model=args.model, no_stream=args.no_stream
    )
    if args.system:
        client.system = args.system

    if args.command == "models":
        try:
            base = client.resolve_base()
            if not base:
                print(c_red("no reachable endpoint (tried local + pointer)"))
                return 1
            client.base = base
            for alias in client.models():
                print(alias)
        except Exception as exc:
            print(c_red("✗ %s" % exc))
            return 1
        return 0

    base = client.resolve_base()
    if not base:
        print(
            c_red(
                "✗ no reachable endpoint — start the relay or set "
                "--base / REACH_BASE_URL"
            )
        )
        return 1
    client.base = base
    if args.base and client.base != args.base.rstrip("/"):
        print(c_yellow("! %s unreachable — using %s" % (args.base, base)))

    try:
        if args.command == "chat":
            run_chat(client, base)
        elif args.command == "ask":
            if not args.text:
                parser.error("ask needs a question")
            if not run_ask(client, args.text, web=False):
                return 1
        elif args.command == "web":
            if not args.text:
                parser.error("web needs a question")
            if not run_web_answer(client, args.text, fetch_pages=not args.no_fetch):
                return 1
    except KeyboardInterrupt:
        print(c_dim("\n  bye."))
    return 0
