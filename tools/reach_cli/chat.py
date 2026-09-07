"""Chat modes: interactive REPL, one-shot ask, grounded web answer."""

import json
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
    spinner,
    spinner_clear,
    status_line,
)
from .websearch import PAGE_FETCH_LIMIT, fetch_text, search_web




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
