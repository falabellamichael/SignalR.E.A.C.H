#!/usr/bin/env python3
# -*- coding: utf-8 -*-
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
import html.parser
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"
DEFAULT_BASE = os.environ.get("REACH_BASE_URL", "http://127.0.0.1:20777/v1")
POINTER_GIST = ("https://gist.githubusercontent.com/falabellamichael/"
                "e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt")

DDG_URL = "https://duckduckgo.com/html/"
DDG_LITE_URL = "https://lite.duckduckgo.com/lite/"
MAX_PAGE_CHARS = 4000
PAGE_FETCH_LIMIT = 3

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]


# ---------------------------------------------------------------------------
# ANSI colour helpers (auto-disabled for pipes / NO_COLOR / --no-color)
# ---------------------------------------------------------------------------

class Paint:
    def __init__(self, enabled):
        self.on = enabled

    def __call__(self, code, text):
        if not self.on:
            return text
        return "\x1b[%sm%s\x1b[0m" % (code, text)


PAINT = Paint(False)


def c_red(t):
    return PAINT("31", t)


def c_green(t):
    return PAINT("32", t)


def c_yellow(t):
    return PAINT("33", t)


def c_blue(t):
    return PAINT("34", t)


def c_magenta(t):
    return PAINT("35", t)


def c_cyan(t):
    return PAINT("36", t)


def c_bold(t):
    return PAINT("1", t)


def c_dim(t):
    return PAINT("2", t)


def c_inverse(t):
    return PAINT("7", t)


def spinner_char():
    return "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[int(time.time() * 10) % 10]


# ---------------------------------------------------------------------------
# Search: DuckDuckGo scraping (SimpleRAG's approach)
# ---------------------------------------------------------------------------

class DDGParser(html.parser.HTMLParser):
    """Parses both DDG endpoints:
    - html.duckduckgo.com/html: a.result__a links (uddg= redirect), result__snippet
    - lite.duckduckgo.com/lite: a.result-link links, td.result-snippet
    plus rich answer modules (module--answer etc.)."""

    ANSWER_CLASSES = ("module--answer", "module--about", "module--definition",
                      "module--weather", "module--finance", "module--translation",
                      "zci__result", "zci__main")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self.rich_answer = []
        self._in_rich = 0
        self._in_title = False
        self._in_snippet = False
        self._url = None
        self._title = []
        self._snippet = []

    def handle_starttag(self, tag, attrs):
        attr = {k.lower(): (v or "") for k, v in attrs}
        cls = attr.get("class", "")
        tl = tag.lower()

        if self._in_rich:
            self._in_rich += 1
            return
        if any(a in cls for a in self.ANSWER_CLASSES):
            self._in_rich = 1
            return
        if tl == "a" and ("result__a" in cls or "result-link" in cls):
            href = attr.get("href", "")
            if "uddg=" in href:
                match = re.search(r"uddg=([^&]+)", href)
                self._url = urllib.parse.unquote(match.group(1)) if match else href
            else:
                self._url = href
            self._in_title = True
            self._title = []
        elif "result__snippet" in cls or "result-snippet" in cls:
            self._in_snippet = True
            self._snippet = []

    def handle_endtag(self, tag):
        tl = tag.lower()
        if self._in_rich:
            self._in_rich -= 1
            if self._in_rich <= 0:
                self._in_rich = 0
            return
        if tl == "a" and self._in_title:
            self._in_title = False
            title = " ".join(" ".join(self._title).split())
            if title and self._url and self._url.startswith("http"):
                self.results.append({"title": title, "url": self._url,
                                     "snippet": ""})
            self._url = None
        elif self._in_snippet:
            self._in_snippet = False
            snippet = " ".join(" ".join(self._snippet).split())
            if snippet and self.results:
                self.results[-1]["snippet"] = snippet

    def handle_data(self, data):
        if self._in_rich:
            self.rich_answer.append(data)
        elif self._in_title:
            self._title.append(data)
        elif self._in_snippet:
            self._snippet.append(data)

    def rich_text(self):
        text = " ".join(" ".join(self.rich_answer).split())
        return text[:1200] if text else None


class TextExtractor(html.parser.HTMLParser):
    """Strips a fetched page down to readable text."""

    SKIP_TAGS = {"script", "style", "noscript", "svg", "header", "footer",
                 "nav", "aside", "form"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag.lower() in self.SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag.lower() in self.SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if not self._skip_depth:
            self.parts.append(data)

    def text(self):
        text = re.sub(r"\s+", " ", " ".join(self.parts)).strip()
        return text[:MAX_PAGE_CHARS]


def _open(url, timeout=12, headers=None):
    request = urllib.request.Request(url, headers={
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        **(headers or {}),
    })
    return urllib.request.urlopen(request, timeout=timeout)


def search_web(query, count=6):
    """DuckDuckGo search; html endpoint first, lite as fallback."""
    params = urllib.parse.urlencode({"q": query})
    for base in (DDG_URL, DDG_LITE_URL):
        try:
            with _open(base + "?" + params, timeout=15) as resp:
                body = resp.read().decode("utf-8", "replace")
            parser = DDGParser()
            parser.feed(body)
            results = parser.results[:count]
            if results:
                return {"results": results, "rich": parser.rich_text(),
                        "engine": "duckduckgo"}
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return {"results": [], "rich": None, "engine": None}


def fetch_text(url):
    """Readable text from a page, or None when unfetchable."""
    if not url.startswith("http"):
        return None
    try:
        with _open(url, timeout=12) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "html" not in content_type and "text" not in content_type:
                return None
            body = resp.read(400_000).decode("utf-8", "replace")
        extractor = TextExtractor()
        extractor.feed(body)
        text = extractor.text()
        return text if len(text) > 120 else None
    except (urllib.error.URLError, OSError, ValueError, UnicodeDecodeError):
        return None


# ---------------------------------------------------------------------------
# Endpoint client
# ---------------------------------------------------------------------------

class ReachApiError(RuntimeError):
    pass


def _error_text(raw, base):
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
        error = payload.get("error") or {}
        message = error.get("message") or json.dumps(payload)[:200]
        if error.get("reset_seconds"):
            message += " (retry in ~%ss)" % error["reset_seconds"]
        return message.strip()
    except Exception:
        text = raw.decode("utf-8", "replace").strip()
        return text[:200] or "no response body from %s" % base


class ReachClient:
    def __init__(self, base, model=None, timeout=600, no_stream=False):
        self.base = base.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.no_stream = no_stream
        self.usage = {"prompt": None, "completion": None}
        self.last_latency_ms = 0.0
        self.system = None

    def resolve_base(self):
        """Fall back to the public pointer gist when the local relay is down."""
        if self._reachable(self.base):
            return self.base
        try:
            with urllib.request.urlopen(POINTER_GIST, timeout=8) as resp:
                url = resp.read().decode().strip()
            if url and self._reachable(url):
                return url.rstrip("/")
        except Exception:
            pass
        return None

    @staticmethod
    def _reachable(base):
        try:
            request = urllib.request.Request(base.rstrip("/") + "/models")
            with urllib.request.urlopen(request, timeout=5) as resp:
                return resp.status == 200
        except Exception:
            return False

    def models(self):
        request = urllib.request.Request(self.base + "/models")
        with urllib.request.urlopen(request, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return [m.get("id") for m in data.get("data", []) if m.get("id")]

    def chat(self, messages, stream=True):
        """Yields text deltas; sets usage/last_latency_ms at the end."""
        payload = {"messages": messages}
        if self.model:
            payload["model"] = self.model
        payload["stream"] = stream and not self.no_stream
        started = time.time()
        request = urllib.request.Request(
            self.base + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json"})
        if payload["stream"]:
            chunks = []
            saw_sse = False
            raw_rest = b""
            try:
                response = urllib.request.urlopen(request,
                                                  timeout=self.timeout)
            except urllib.error.HTTPError as exc:
                raise ReachApiError(
                    "endpoint error (HTTP %s): %s"
                    % (exc.code, _error_text(exc.read(), self.base))) from exc
            with response:
                for raw in response:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        # not SSE — likely an inline error body; keep reading
                        raw_rest += raw
                        continue
                    saw_sse = True
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = (json.loads(chunk).get("choices") or [{}])[0] \
                            .get("delta", {})
                    except json.JSONDecodeError:
                        continue
                    content = delta.get("content")
                    if content:
                        chunks.append(content)
                        yield content
            self.last_latency_ms = (time.time() - started) * 1000
            if not chunks and (raw_rest or not saw_sse):
                raise ReachApiError(
                    "endpoint error: " + _error_text(raw_rest, self.base))
            if not chunks and saw_sse:
                raise ReachApiError(
                    "stream ended without content — upstream may be cooling "
                    "down; try another model or retry shortly")
            self.usage = {"prompt": None, "completion": None}
            return
        with urllib.request.urlopen(request, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        self.last_latency_ms = (time.time() - started) * 1000
        usage = data.get("usage") or {}
        self.usage = {"prompt": usage.get("prompt_tokens"),
                      "completion": usage.get("completion_tokens")}
        content = (data.get("choices") or [{}])[0].get("message", {}) \
            .get("content")
        yield content or ""


def discover_public_url():
    try:
        with urllib.request.urlopen(POINTER_GIST, timeout=8) as resp:
            return resp.read().decode().strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Grounded web prompt (SimpleRAG-style: evidence block + [n] citations)
# ---------------------------------------------------------------------------

GROUNDING_SYSTEM = (
    "You are SimpleREACH web chat — a search-grounded assistant.\n"
    "Use the SEARCH RESULTS and PAGE EXCERPTS below to answer accurately.\n"
    "Cite facts with [n] where n is the result number. If the evidence is\n"
    "insufficient, say so instead of guessing. Keep the answer focused and\n"
    "helpful. Today's date: {date}."
)


def build_grounded_messages(query, results, pages, rich=None):
    lines = ["SEARCH RESULTS:", ""]
    for index, result in enumerate(results, start=1):
        lines.append("[%d] %s" % (index, result["title"]))
        lines.append("    %s" % result["url"])
        if result.get("snippet"):
            lines.append("    %s" % result["snippet"])
        if index in pages and pages[index]:
            lines.append("    Excerpt: %s" % pages[index][:700])
    if rich:
        lines += ["", "INSTANT ANSWER:", rich]
    evidence = "\n".join(lines)
    user = ("Question: %s\n\n%s\n\nAnswer with [n] citations." % (query, evidence))
    system = GROUNDING_SYSTEM.format(
        date=time.strftime("%Y-%m-%d"))
    return [{"role": "system", "content": system},
            {"role": "user", "content": user}]


# ---------------------------------------------------------------------------
# UI bits
# ---------------------------------------------------------------------------

def banner(client, base, mode):
    width = 66
    print(c_cyan("┌" + "─" * width + "┐"))
    print(c_cyan("│") + c_bold(c_yellow("  ⚡ SimpleREACH CLI")) + c_dim("  v" + VERSION)
          + (" " * (width - 32)) + c_cyan("│"))
    print(c_cyan("│") + c_dim("  REACH = RAG Endpoint & AI Chat Host — keyless gpt-4o/5, "
                              "Claude") + " " * (width - 72) + c_cyan("│"))
    print(c_cyan("├") + "─" * width + "┤")
    model = client.model or "(auto — set with /model)"
    print(c_cyan("│") + "  " + c_green("endpoint ") + c_dim(base)
          + (" " * max(1, width - 16 - len(base))) + c_cyan("│"))
    print(c_cyan("│") + "  " + c_green("model    ") + c_bold(model)
          + (" " * max(1, width - 15 - len(model))) + c_cyan("│"))
    print(c_cyan("└") + "─" * width + "┘")
    print(c_dim("  /help for commands · /web <question> for grounded search\n"))


def print_footer(client, cited=False):
    parts = ["%s ms" % round(client.last_latency_ms)]
    if client.usage.get("completion"):
        parts.append("%s tok" % client.usage["completion"])
    if cited:
        parts.append("grounded")
    print(c_dim("  · ".join(parts)))


def spinner(message):
    sys.stdout.write("\r" + c_cyan(spinner_char()) + " " + message + "   ")
    sys.stdout.flush()


def spinner_clear():
    sys.stdout.write("\r" + " " * 60 + "\r")
    sys.stdout.flush()


def spin_while(message, seconds):
    """Animated wait for local work (page fetches are quick)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        spinner(message)
        time.sleep(0.08)
    spinner_clear()


def status_line(message):
    print(c_dim("  " + message))


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
                status_line("fetched [%d] %s (%d chars)"
                            % (index, result["title"][:40], len(text)))
        print()

    messages = build_grounded_messages(query, results, pages,
                                       rich=found["rich"])
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
                        print(c_red("  ✗ unknown model %r — try /models"
                                    % argument))
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
                        history = [m for m in history
                                   if m.get("role") != "system"]
                        history.insert(0, {"role": "system",
                                           "content": client.system})
                        print(c_green("  system prompt set"))
                    else:
                        history = [m for m in history
                                   if m.get("role") != "system"]
                        print(c_green("  system prompt cleared"))
                    continue
                if command == "/clear":
                    history = ([{"role": "system", "content": client.system}]
                               if client.system else [])
                    print(c_green("  conversation cleared"))
                    continue
                if command == "/history":
                    for message in history:
                        role = message["role"]
                        color = c_cyan if role == "user" else c_magenta
                        print(color("  %s:" % role),
                              message["content"][:200].replace("\n", " "))
                    continue
                if command == "/save":
                    path = argument or ("reach-chat-%s.jsonl"
                                        % time.strftime("%Y%m%d-%H%M%S"))
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

def enable_ansi():
    if os.environ.get("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        os.system("")  # enable VT processing on Windows consoles
    return True


def main(argv=None):
    global PAINT
    parser = argparse.ArgumentParser(
        prog="reach-cli",
        description="SimpleREACH CLI — terminal chat + web-grounded answers "
                    "over the REACH endpoint (keyless).")
    parser.add_argument("command", nargs="?",
                        choices=("chat", "ask", "web", "models"),
                        default="chat")
    parser.add_argument("text", nargs="?",
                        help="question for 'ask'/'web'")
    parser.add_argument("--base", default=None,
                        help="endpoint base URL (default: local relay, "
                             "falls back to the public pointer)")
    parser.add_argument("--model", default=None, help="model alias")
    parser.add_argument("--system", default=None,
                        help="session system prompt")
    parser.add_argument("--no-stream", action="store_true",
                        help="non-streaming responses")
    parser.add_argument("--no-color", action="store_true",
                        help="disable ANSI colours")
    parser.add_argument("--no-fetch", action="store_true",
                        help="web mode: don't fetch page excerpts")
    args = parser.parse_args(argv)

    PAINT = Paint(enable_ansi() and not args.no_color)
    if os.name == "nt":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")

    client = ReachClient(args.base or DEFAULT_BASE, model=args.model,
                         no_stream=args.no_stream)
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
        print(c_red("✗ no reachable endpoint — start the relay or set "
                    "--base / REACH_BASE_URL"))
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
            if not run_web_answer(client, args.text,
                                  fetch_pages=not args.no_fetch):
                return 1
    except KeyboardInterrupt:
        print(c_dim("\n  bye."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
