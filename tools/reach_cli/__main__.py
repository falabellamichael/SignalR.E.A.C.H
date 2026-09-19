"""Entry point: argparse wiring for the REACH CLI."""

import argparse
import os
import sys

from . import terminal
from .chat import run_ask, run_chat, run_web_answer
from .client import ReachClient
from .terminal import Paint, c_dim, c_red, c_yellow, enable_ansi


DEFAULT_BASE = os.environ.get("REACH_BASE_URL", "http://127.0.0.1:20777/v1")




def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="reach-cli",
        description="SignalR.E.A.C.H CLI — terminal chat + web-grounded answers "
        "over the REACH endpoint. A hosted relay needs an sk-reach key "
        "(--key or REACH_KEY); a relay on this machine does not.",
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
    parser.add_argument(
        "--key", default=None,
        help="sk-reach API key for a hosted relay (or set REACH_KEY)",
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
    parser.add_argument(
        "--agent", action="store_true",
        help="agent mode — a multi-round tool loop in the workpath "
        "(read/search/shell/edit/web; shell and edits need your approval)",
    )
    parser.add_argument(
        "--workpath", default=None,
        help="directory the agent works in (default: current directory)",
    )
    args = parser.parse_args(argv)

    terminal.PAINT = Paint(enable_ansi() and not args.no_color)
    if os.name == "nt":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")

    client = ReachClient(
        args.base or DEFAULT_BASE, model=args.model, no_stream=args.no_stream,
        key=args.key,
    )
    if args.system:
        client.system = args.system
    if args.agent:
        client.agent = True
    if args.workpath:
        workpath = os.path.abspath(os.path.expanduser(args.workpath))
        if not os.path.isdir(workpath):
            print(c_red("✗ workpath not a directory: %s" % workpath))
            return 1
        client.workpath = workpath

    if args.command == "models":
        indicator = terminal.WaitIndicator(
            message="locating endpoint (local relay, then public pointer)"
        )
        indicator.start()
        try:
            base = client.resolve_base()
        finally:
            indicator.stop()
        if not base:
            print(c_red("no reachable endpoint (tried local + pointer)"))
            return 1
        client.base = base
        indicator = terminal.WaitIndicator(message="fetching served models")
        indicator.start()
        try:
            aliases = client.models()
        except Exception as exc:
            print(c_red("✗ %s" % exc))
            return 1
        finally:
            indicator.stop()
        for alias in aliases:
            print(alias)
        return 0

    indicator = terminal.WaitIndicator(
        message="locating endpoint (local relay, then public pointer)"
    )
    indicator.start()
    try:
        base = client.resolve_base()
    finally:
        indicator.stop()
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


if __name__ == "__main__":
    main()
