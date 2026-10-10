"""Entry point: argparse wiring for the REACH CLI."""

import argparse
import os
import shlex
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
  reach-cli endpoints                    list saved and protected endpoints
  reach-cli endpoints add lab http://127.0.0.1:8080/v1 --key-env LAB_API_KEY
  reach-cli endpoints test lab            refresh models without selecting
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
        help="endpoint base URL, a saved custom name, 'local', or 'subscription' "
        "('public' is an alias) "
        "(default: REACH_BASE_URL or the local relay; never falls back "
        "to another endpoint)",
    )
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument(
        "--key",
        default=fallback(None),
        help="sk-reach API key for a hosted relay (or set REACH_KEY)",
    )
    credentials.add_argument(
        "--key-env",
        default=fallback(None),
        help="use a credential from an existing environment variable; stores no key",
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
        help="question to answer; with no subcommand this is 'ask'; "
        "with chat, send it first and keep the REPL open",
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
    endpoints = sub.add_parser(
        "endpoints",
        aliases=["endpoint"],
        help="manage saved custom endpoints and protected local/subscription options",
        description="List, add, edit, test, select, or remove custom endpoints. "
        "Local and subscription options are protected. Only model metadata is fetched.",
        epilog="examples:\n  reach-cli endpoints\n"
        "  reach-cli endpoints add lab http://127.0.0.1:8080/v1 --key-env LAB_API_KEY\n"
        "  reach-cli endpoints edit lab --no-key\n"
        "  reach-cli endpoints test lab\n"
        "  reach-cli endpoints select lab\n"
        "  reach-cli endpoints remove lab\n"
        "Common flags precede the operation; add/edit credential references follow it.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    endpoints.add_argument("endpoint_args", nargs=argparse.REMAINDER,
                           help="list | add | edit | test | select | remove, then operation arguments")
    for child in (chat, ask, web, sub.choices["models"], endpoints):
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
    explicit_command = getattr(args, "command", None)
    command = explicit_command or "chat"
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
    if command in ("models", "endpoint", "endpoints") and prompt:
        return None, None, "%s does not take --prompt" % command
    if command == "chat" and prompt:
        if explicit_command is None:
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


def _endpoint_configuration(args):
    """Resolve only local configuration; startup owns all connection checks."""
    from .endpoints import (EndpointError, LOCAL_ENDPOINT_URL, get_custom,
                            normalize_key_env, normalize_url)
    raw = getattr(args, "base", None)
    if raw is None:
        saved = terminal.load_session_config()
        selected = saved.get("endpoint_name")
        if selected:
            if selected.lower() in ("local", "public", "subscription"):
                raw = selected
            else:
                try:
                    get_custom(selected)
                    raw = selected
                except EndpointError:
                    # The normal restore path provides its safe local fallback.
                    raw = "local"
        elif getattr(args, "resume", False) and saved.get("endpoint"):
            raw = saved["endpoint"]
        else:
            raw = DEFAULT_BASE
    key_env = normalize_key_env(getattr(args, "key_env", None))
    explicit_key = getattr(args, "key", None) is not None
    alias = raw.strip().lower() if isinstance(raw, str) else ""
    if alias in ("local", "public", "subscription"):
        base = "subscription" if alias == "public" else alias
        name = "subscription" if alias == "public" else alias
    elif isinstance(raw, str) and "://" in raw:
        base = normalize_url(raw)
        name = "local" if base == LOCAL_ENDPOINT_URL else None
    else:
        record = get_custom(raw)
        base = record["url"]
        name = raw.strip().lower()
        if not explicit_key and key_env is None:
            key_env = record.get("key_env")
    return base, name, key_env


def _restore_endpoint_selection(client, args):
    """Named selections persist; general legacy session resume stays explicit."""
    saved = terminal.load_session_config() if not getattr(args, "base", None) else {}
    if getattr(args, "resume", False):
        terminal.apply_saved_session(client, args)
    elif saved.get("endpoint_name"):
        endpoint_only = argparse.Namespace(**vars(args))
        # These truthy flags suppress the unrelated saved model/workpath fields.
        endpoint_only.model = True
        endpoint_only.workpath = True
        terminal.apply_saved_session(client, endpoint_only)
    if ((getattr(client, "base", "") or "").lower() in ("public", "subscription")
            and not getattr(client, "explicit_credential", False)
            and not getattr(client, "key_env", None)):
        client.key = getattr(client, "_builtin_key", "") or ""
        client.key_env = None
        client.key_ref = "builtin"


def _run_endpoint_command(args, client):
    """Share slash-command CRUD and wait only for its already scheduled refresh."""
    from . import commands
    from .discovery import MODEL_DISCOVERY
    values = getattr(args, "endpoint_args", []) or []
    argument = " ".join(shlex.quote(value) for value in values)
    line = "/" + args.command + (" " + argument if argument else "")
    result = commands.handle_slash(line, client, [])
    target = result.refresh_target
    snapshot = None
    if target is not None:
        base, key, key_ref = target
        snapshot = MODEL_DISCOVERY.wait(base, key_ref=key_ref, key=key, timeout=3)
        commands._print_discovery(target, refresh_requested=False)
    if not result.success:
        return 1
    action = values[0].lower() if values else "list"
    if action in ("test", "check") and (not snapshot or snapshot.get("status") != "ready"):
        return 1
    return 0


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
    # Parent/subparser mutually exclusive groups also need a cross-scope check.
    if getattr(args, "key", None) is not None and getattr(args, "key_env", None) is not None:
        return _usage(parser, "choose either --key or --key-env")
    if getattr(args, "key_env", None) is not None:
        from .endpoints import EndpointError, normalize_key_env
        try:
            if not normalize_key_env(args.key_env):
                raise EndpointError("--key-env requires an environment-variable name")
        except EndpointError as exc:
            return _usage(parser, str(exc))
        if not os.environ.get(args.key_env, "").strip():
            print(c_red("? %s is not set; configure that environment variable separately" % args.key_env))
            return 1

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

    base, endpoint_name, key_env = _endpoint_configuration(args)
    client = ReachClient(
        base,
        model=getattr(args, "model", None),
        no_stream=bool(getattr(args, "no_stream", False)),
        key=getattr(args, "key", None),
        key_env=key_env,
    )
    client.endpoint_name = endpoint_name
    if getattr(args, "key_env", None) is not None:
        client.explicit_credential = True
    if getattr(args, "system", None):
        client.system = args.system
    if getattr(args, "agent", False):
        client.agent = True
    if getattr(args, "workpath", None):
        if _apply_workpath(client, args.workpath) is None:
            return 1

    _restore_endpoint_selection(client, args)

    if command in ("endpoint", "endpoints"):
        return _run_endpoint_command(args, client)

    indicator = terminal.WaitIndicator(message="checking endpoint")
    indicator.start()
    try:
        try:
            base = client.resolve_base()
        except Exception:
            base = None
        if isinstance(base, str):
            base = base.strip().rstrip("/") or None
        else:
            base = None
        reachable = True
        if base is not None:
            client.base = base
            # Chat opens either way so the relay-not-up notice can show.
            # One-shot commands still need a live endpoint.
            if command != "chat":
                try:
                    reachable = bool(ReachClient._reachable(client.base, client.key))
                except Exception:
                    reachable = False
    finally:
        indicator.stop()
    if not base:
        print(c_red("✗ no endpoint — the public pointer is unavailable"))
        print(c_dim("  pass --base with a URL, or choose local"))
        return 1
    if command != "chat" and not reachable:
        print(c_red("✗ endpoint unreachable: %s" % client.base))
        print(c_dim("  start the relay or set --base / REACH_BASE_URL"))
        return 1

    if getattr(args, "base", None) or getattr(args, "model", None) or getattr(args, "workpath", None):
        terminal.save_session_config(
            endpoint=client.base if getattr(args, "base", None) else None,
            **({"endpoint_name": getattr(client, "endpoint_name", None) or ""}
               if getattr(args, "base", None) else {}),
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
            if text:
                run_chat(client, client.base, initial_prompt=text)
            else:
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
