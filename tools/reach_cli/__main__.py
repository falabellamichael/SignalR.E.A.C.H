"""Entry point: argparse wiring for the REACH CLI."""

import argparse
import os
import sys

from . import terminal
from .chat import run_ask, run_chat, run_web_answer
from .client import ReachClient
from .terminal import VERSION, c_dim, c_red, enable_ansi


DEFAULT_BASE = os.environ.get("REACH_BASE_URL", "http://127.0.0.1:20777/v1")

EXAMPLES = """
examples:
  reach-cli                              start the chat REPL
  reach-cli ask "what is REACH"          one-shot answer
  reach-cli -p "what is REACH"           same as ask
  reach-cli web "latest REACH notes"     search, then a cited answer
  reach-cli models                       list model aliases
  reach-cli --continue                   resume endpoint, model, and workpath
""".strip("\n")

ASK_EXAMPLES = """
examples:
  reach-cli ask "what is REACH"
  reach-cli -p "what is REACH"
""".strip("\n")

WEB_EXAMPLES = """
examples:
  reach-cli web "latest REACH notes"
  reach-cli web "latest REACH notes" --no-fetch
""".strip("\n")


class ReachParser(argparse.ArgumentParser):
    """Usage errors exit 2 and never dump a traceback."""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write(c_red("✗ %s\n" % message))
        self.exit(2)


def _add_common(parser, suppress):
    """Shared flags. Subparsers suppress defaults so parent values survive."""

    def fallback(value):
        return argparse.SUPPRESS if suppress else value

    parser.add_argument(
        "--base",
        default=fallback(None),
        help="endpoint base URL (default: REACH_BASE_URL or the local relay; "
        "no fallback to another endpoint)",
    )
    parser.add_argument(
        "--key",
        default=fallback(None),
        help="sk-reach API key for a hosted relay (or set REACH_KEY)",
    )
    parser.add_argument("--model", default=fallback(None), help="model alias")
    parser.add_argument(
        "--system", default=fallback(None), help="session system prompt"
    )
    parser.add_argument(
        "--no-stream",
        action="store_true",
        default=fallback(False),
        help="non-streaming responses",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        default=fallback(False),
        help="disable ANSI colours (same as --color never)",
    )
    parser.add_argument(
        "--no-fetch",
        action="store_true",
        default=fallback(False),
        help="web mode: don't fetch page excerpts",
    )
    parser.add_argument(
        "--agent",
        action="store_true",
        default=fallback(False),
        help="agent mode — a multi-round tool loop in the workpath "
        "(read/search/shell/edit/web; shell and edits need your approval)",
    )
    parser.add_argument(
        "--workpath",
        default=fallback(None),
        help="directory the agent works in (default: current directory)",
    )
    parser.add_argument(
        "-p",
        "--prompt",
        default=fallback(None),
        help="question to answer; with no subcommand this is 'ask'",
    )
    parser.add_argument(
        "--color",
        choices=("auto", "always", "never"),
        default=fallback("auto"),
        help="when to colour output (default: auto; NO_COLOR forces off "
        "unless always)",
    )
    parser.add_argument(
        "--continue",
        dest="resume",
        action="store_true",
        default=fallback(False),
        help="resume the endpoint, model, and workpath saved in "
        "~/.config/reach-cli/config.json",
    )
    parser.add_argument(
        "-V",
        "--version",
        action="store_true",
        default=fallback(False),
        help="print reach-cli %s and exit" % VERSION,
    )


def build_parser():
    parser = ReachParser(
        prog="reach-cli",
        description="SignalR.E.A.C.H CLI — terminal chat + web-grounded answers "
        "over the REACH endpoint. A hosted relay needs an sk-reach key "
        "(--key or REACH_KEY); a relay on this machine does not.",
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    _add_common(parser, suppress=False)
    sub = parser.add_subparsers(dest="command", required=False, parser_class=ReachParser)

    chat = sub.add_parser(
        "chat",
        help="interactive REPL",
        description="Interactive REPL. /help lists commands.",
        epilog="examples:\n  reach-cli chat\n  reach-cli chat --agent\n  reach-cli --continue",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ask = sub.add_parser(
        "ask",
        help="answer one question and exit",
        description="Answer one question and exit.",
        epilog=ASK_EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ask.add_argument("text", nargs="?", help="the question")
    web = sub.add_parser(
        "web",
        help="search, read pages, and answer with citations",
        description="Search, read the top pages, and answer with citations.",
        epilog=WEB_EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    web.add_argument("text", nargs="?", help="the question")
    sub.add_parser(
        "models",
        help="list model aliases served by the endpoint",
        description="List model aliases served by the endpoint.",
        epilog="examples:\n  reach-cli models\n  reach-cli --base http://127.0.0.1:20777/v1 models",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    for child in (chat, ask, web, sub.choices["models"]):
        _add_common(child, suppress=True)
    return parser


def _exit_code(exc):
    code = exc.code
    if code is None or code == 0:
        return 0
    if isinstance(code, int):
        return code
    return 2


def _paint_enabled(args):
    choice = getattr(args, "color", None) or "auto"
    if getattr(args, "no_color", False) or choice == "never":
        return False
    if choice == "always":
        return True
    return enable_ansi()


def _resolve_invocation(args):
    """Return (command, text, error). -p with no subcommand means ask."""
    command = getattr(args, "command", None) or "chat"
    text = getattr(args, "text", None)
    prompt = getattr(args, "prompt", None)
    if isinstance(text, str):
        text = text.strip() or None
    else:
        text = None
    if isinstance(prompt, str):
        prompt = prompt.strip() or None
    else:
        prompt = None
    if command == "models" and prompt:
        return None, None, "models does not take --prompt"
    if command == "chat" and prompt:
        command = "ask"
        text = prompt
        prompt = None
    if command in ("ask", "web"):
        if prompt and text and prompt != text:
            return None, None, "pass the question once (argument or --prompt)"
        if not text:
            text = prompt
        if not text:
            return command, None, "%s needs a question" % command
    return command, text, None


def _usage(parser, message, examples=None):
    parser.print_usage(sys.stderr)
    sys.stderr.write(c_red("✗ %s\n" % message))
    if examples:
        sys.stderr.write(examples + "\n")
    return 2


def _apply_workpath(client, path):
    workpath = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(workpath):
        print(c_red("✗ workpath not a directory: %s" % workpath))
        return None
    client.workpath = workpath
    return workpath


def main(argv=None):
    try:
        return _main(argv)
    except KeyboardInterrupt:
        print(c_dim("\n  bye."))
        return 130
    except Exception as exc:
        print(c_red("✗ %s" % exc))
        return 1


def _main(argv=None):
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return _exit_code(exc)

    if getattr(args, "version", False):
        print("reach-cli %s" % VERSION)
        return 0

    choice = getattr(args, "color", None) or "auto"
    if choice == "always" and getattr(args, "no_color", False):
        return _usage(parser, "--color always and --no-color conflict")

    command, text, problem = _resolve_invocation(args)
    if problem:
        examples = ASK_EXAMPLES if command == "ask" else WEB_EXAMPLES if command == "web" else None
        return _usage(parser, problem, examples)

    terminal.COLOR_FORCED = choice == "always"
    terminal.PAINT = terminal.Paint(_paint_enabled(args))
    if os.name == "nt":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    client = ReachClient(
        getattr(args, "base", None) or DEFAULT_BASE,
        model=getattr(args, "model", None),
        no_stream=bool(getattr(args, "no_stream", False)),
        key=getattr(args, "key", None),
    )
    if getattr(args, "system", None):
        client.system = args.system
    if getattr(args, "agent", False):
        client.agent = True
    if getattr(args, "workpath", None):
        if _apply_workpath(client, args.workpath) is None:
            return 1

    if getattr(args, "resume", False):
        terminal.apply_saved_session(client, args)

    indicator = terminal.WaitIndicator(message="checking endpoint")
    indicator.start()
    try:
        reachable = ReachClient._reachable(client.base, client.key)
    except Exception:
        reachable = False
    finally:
        indicator.stop()
    if not reachable:
        print(c_red("✗ endpoint unreachable: %s" % client.base))
        print(c_dim("  start the relay or set --base / REACH_BASE_URL"))
        return 1

    if getattr(args, "base", None) or getattr(args, "model", None) or getattr(args, "workpath", None):
        terminal.save_session_config(
            endpoint=client.base if getattr(args, "base", None) else None,
            model=client.model if getattr(args, "model", None) else None,
            workpath=client.workpath if getattr(args, "workpath", None) else None,
        )

    try:
        if command == "models":
            indicator = terminal.WaitIndicator(message="fetching served models")
            indicator.start()
            try:
                aliases = client.models()
            except Exception as exc:
                print(c_red("✗ %s" % exc))
                return 1
            finally:
                indicator.stop()
            for alias in aliases or []:
                print(alias)
            return 0
        if command == "chat":
            run_chat(client, client.base)
        elif command == "ask":
            if not run_ask(client, text, web=False):
                return 1
        elif command == "web":
            if not run_web_answer(client, text, fetch_pages=not getattr(args, "no_fetch", False)):
                return 1
        else:
            return _usage(parser, "unknown command %r" % command)
    except KeyboardInterrupt:
        print(c_dim("\n  bye."))
        return 130
    except Exception as exc:
        print(c_red("✗ %s" % exc))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
