"""Offline unit tests for the SimpleREACH CLI (parser + grounding)."""
import json
import os
import re
import sys
import time
import unittest
import unittest.mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "tools")
sys.path.insert(0, TOOLS)

from reach_cli.grounding import build_grounded_messages  # noqa: E402
from reach_cli.websearch import DDGParser, TextExtractor  # noqa: E402

DDG_HTML_FIXTURE = """<!DOCTYPE html>
<html><body>
<a class="module module--answer">The capital of France is <b>Paris</b>.</a>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a"
     href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FParis">Paris — Wikipedia</a>
  <a class="result__snippet">Paris is the capital and most populous city of France.</a>
</div>
<div class="result results_links">
  <a class="result__a"
     href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fparis-guide">Paris Travel Guide</a>
  <a class="result__snippet">Plan your visit to Paris with our guide.</a>
</div>
<a class="result__a" href="/l/?uddg=ftp://not-http.example/file">Skipped: non-http</a>
</body></html>"""

DDG_LITE_FIXTURE = """<html><body>
<a rel="nofollow" href="https://example.org/one" class="result-link">First result</a>
<div class="result-snippet">Snippet for the first result.</div>
</body></html>"""

PAGE_FIXTURE = """<html><head><style>.x{color:red}</style>
<script>var a = 1;</script></head>
<body><nav>menu junk</nav><h1>Hello</h1><p>Readable  text  here.</p></body></html>"""


class DDGParserTests(unittest.TestCase):
    def test_html_endpoint_results_and_uddg_unwrap(self):
        parser = DDGParser()
        parser.feed(DDG_HTML_FIXTURE)
        results = parser.results
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["title"], "Paris — Wikipedia")
        self.assertEqual(results[0]["url"],
                         "https://en.wikipedia.org/wiki/Paris")
        self.assertEqual(results[0]["snippet"],
                         "Paris is the capital and most populous city of France.")
        self.assertEqual(results[1]["url"],
                         "https://example.com/paris-guide")

    def test_rich_answer_module_captured(self):
        parser = DDGParser()
        parser.feed(DDG_HTML_FIXTURE)
        self.assertIn("capital of France", parser.rich_text())

    def test_lite_endpoint_results(self):
        parser = DDGParser()
        parser.feed(DDG_LITE_FIXTURE)
        results = parser.results
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "First result")
        self.assertEqual(results[0]["url"], "https://example.org/one")
        self.assertEqual(results[0]["snippet"],
                         "Snippet for the first result.")

    def test_non_http_links_skipped(self):
        parser = DDGParser()
        parser.feed(DDG_HTML_FIXTURE)
        urls = [r["url"] for r in parser.results]
        self.assertFalse(any(u.startswith("ftp:") for u in urls))


class TextExtractorTests(unittest.TestCase):
    def test_strips_scripts_styles_and_nav(self):
        extractor = TextExtractor()
        extractor.feed(PAGE_FIXTURE)
        text = extractor.text()
        self.assertIn("Hello", text)
        self.assertIn("Readable text here.", text)
        self.assertNotIn("menu junk", text)
        self.assertNotIn("color:red", text)


class GroundingTests(unittest.TestCase):
    def setUp(self):
        self.results = [
            {"title": "Paris — Wikipedia",
             "url": "https://en.wikipedia.org/wiki/Paris",
             "snippet": "Capital of France."},
            {"title": "France facts",
             "url": "https://example.com/france",
             "snippet": "France is in Europe."},
        ]
        self.pages = {1: "Paris has 2 million residents. " * 30}

    def test_grounded_messages_number_and_cite(self):
        messages = build_grounded_messages(
            "What is Paris?", self.results, self.pages)
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("[1]", messages[1]["content"])
        self.assertIn("https://en.wikipedia.org/wiki/Paris",
                      messages[1]["content"])
        self.assertIn("Answer with [n] citations", messages[1]["content"])
        self.assertIn("Excerpt:", messages[1]["content"])
        self.assertTrue(time_placeholder_ok(messages[0]["content"]))

    def test_rich_answer_included_when_present(self):
        messages = build_grounded_messages(
            "What is Paris?", self.results, {}, rich="Paris is big.")
        self.assertIn("INSTANT ANSWER", messages[1]["content"])
        self.assertIn("Paris is big.", messages[1]["content"])


class BuildManifestTests(unittest.TestCase):
    def test_scripts_and_styles_sorted_by_declared_order(self):
        from reach import SCRIPT_SOURCES, STYLE_SOURCES
        from reach.build import build_extension_manifest

        assets = [(name, b"x") for name in reversed(SCRIPT_SOURCES)]
        assets += [(name, b"y") for name in reversed(STYLE_SOURCES)]
        payload = json.loads(
            build_extension_manifest({"version": "9.9.9"}, assets))
        self.assertEqual(
            [s["path"] for s in payload["scripts"]], SCRIPT_SOURCES)
        self.assertEqual(
            [s["path"] for s in payload["styles"]], STYLE_SOURCES)


def time_placeholder_ok(system_prompt):
    """The system prompt embeds today's date; assert it rendered."""
    return re.search(r"\d{4}-\d{2}-\d{2}", system_prompt) is not None


class ClientKeyTests(unittest.TestCase):
    """A hosted relay requires an sk-reach key; the CLI must be able to send it."""

    def test_key_is_sent_as_bearer(self):
        from reach_cli.client import ReachClient
        client = ReachClient("http://relay/v1", key="sk-reach-abc")
        self.assertEqual(client._headers({"Content-Type": "application/json"}),
                         {"Content-Type": "application/json",
                          "Authorization": "Bearer sk-reach-abc"})

    def test_no_key_sends_no_authorization_header(self):
        from reach_cli.client import ReachClient
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("REACH_KEY", None)
            self.assertNotIn("Authorization", ReachClient("http://relay/v1")._headers())

    def test_key_falls_back_to_the_environment(self):
        from reach_cli.client import ReachClient
        with unittest.mock.patch.dict(os.environ, {"REACH_KEY": " sk-reach-env "}):
            self.assertEqual(ReachClient("http://relay/v1").key, "sk-reach-env")

    def test_explicit_key_beats_the_environment(self):
        from reach_cli.client import ReachClient
        with unittest.mock.patch.dict(os.environ, {"REACH_KEY": "sk-reach-env"}):
            self.assertEqual(ReachClient("http://relay/v1", key="sk-reach-arg").key,
                             "sk-reach-arg")

    def test_a_relay_that_answers_401_counts_as_reachable(self):
        # It is up and wants a key. Reporting "no endpoint found" would send the
        # user hunting for the wrong problem.
        import urllib.error
        from reach_cli.client import ReachClient
        err = urllib.error.HTTPError("http://relay/v1/models", 401, "unauthorized", {}, None)
        with unittest.mock.patch("urllib.request.urlopen", side_effect=err):
            self.assertTrue(ReachClient._reachable("http://relay/v1"))
        err500 = urllib.error.HTTPError("http://relay/v1/models", 500, "boom", {}, None)
        with unittest.mock.patch("urllib.request.urlopen", side_effect=err500):
            self.assertFalse(ReachClient._reachable("http://relay/v1"))


class KeyCommandTests(unittest.TestCase):
    def test_key_command_prints_only_the_key_on_stdout(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from types import SimpleNamespace
        from reach import cli
        with unittest.mock.patch.object(cli, "require_relay"),                 unittest.mock.patch.object(cli, "admin_request", return_value=(
                    200, {"name": "Default", "key": "sk-reach-xyz", "created": True})) as call:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                cli.cmd_key(SimpleNamespace(name="Default"))
        call.assert_called_once_with("/_reach/keys/ensure", "POST", {"name": "Default"})
        self.assertEqual(out.getvalue().strip(), "sk-reach-xyz")
        self.assertIn("created", err.getvalue())


class MaskKeyTests(unittest.TestCase):
    """The CLI copy of mask_key must redact exactly like the relay (#26)."""

    SAMPLES = (None, "", "short", 12345, "sk-reach-" + "a" * 32,
               "sk-reach-0123456789abcdef", "legacy-secret-123")

    def test_sk_reach_keys_show_no_secret_characters(self):
        from reach.keys import mask_key
        masked = mask_key("sk-reach-" + "0123456789abcdef" * 2)
        self.assertEqual(masked, "sk-reach-…")
        self.assertNotIn("cdef", masked)

    def test_empty_short_and_non_string_keys(self):
        from reach.keys import mask_key
        self.assertEqual(mask_key(None), "(none)")
        self.assertEqual(mask_key(""), "(none)")
        self.assertEqual(mask_key(12345), "(none)")
        self.assertEqual(mask_key("short"), "set (short)")

    def test_matches_the_relay_implementation(self):
        from reach.keys import mask_key as cli_mask
        server_dir = os.path.join(os.path.dirname(TOOLS), "server")
        if server_dir not in sys.path:
            sys.path.insert(0, server_dir)
        from reachd.settings import mask_key as server_mask
        for sample in self.SAMPLES:
            self.assertEqual(cli_mask(sample), server_mask(sample), repr(sample))


class AgentEditTests(unittest.TestCase):
    """Agent mode: ```edit block parsing, path safety, and file application."""

    def setUp(self):
        self.work = os.path.join(os.environ.get("TEMP") or "/tmp",
                                 "reach-cli-agent-tests")
        os.makedirs(self.work, exist_ok=True)
        self.existing = os.path.join(self.work, "existing.txt")
        with open(self.existing, "w", encoding="utf-8") as handle:
            handle.write("hello world\nsecond line\n")

    def tearDown(self):
        for name in ("existing.txt", "created.txt"):
            path = os.path.join(self.work, name)
            if os.path.exists(path):
                os.remove(path)

    def test_parse_edit_blocks_single_and_multiple(self):
        from reach_cli.chat import parse_edit_blocks
        text = (
            'Before text.\n```edit\n{"path": "a.txt", "search": "x",'
            ' "replace": "y"}\n```\n'
            'middle\n```edit\n{"path": "b/c.txt", "search": "",'
            ' "replace": "new"}\n```\nafter'
        )
        blocks = parse_edit_blocks(text)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0], {"path": "a.txt", "search": "x",
                                     "replace": "y"})
        self.assertEqual(blocks[1]["path"], "b/c.txt")

    def test_parse_edit_blocks_ignores_malformed(self):
        from reach_cli.chat import parse_edit_blocks
        text = '```edit\nnot json\n```\n```edit\n{"no": "path"}\n```'
        self.assertEqual(parse_edit_blocks(text), [])

    def test_apply_edit_creates_new_file_with_empty_search(self):
        from reach_cli.chat import apply_edit
        ok, err = apply_edit(self.work, "created.txt", "", "brand new\n")
        self.assertTrue(ok, err)
        with open(os.path.join(self.work, "created.txt"),
                  encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "brand new\n")

    def test_apply_edit_rejects_create_with_nonempty_search(self):
        from reach_cli.chat import apply_edit
        ok, err = apply_edit(self.work, "missing.txt", "x", "y")
        self.assertFalse(ok)
        self.assertIn("does not exist", err)

    def test_apply_edit_replaces_snippet(self):
        from reach_cli.chat import apply_edit
        ok, err = apply_edit(self.work, "existing.txt", "hello world",
                             "goodbye world")
        self.assertTrue(ok, err)
        with open(self.existing, encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("goodbye world", content)
        self.assertNotIn("hello world", content)

    def test_apply_edit_reports_missing_search_text(self):
        from reach_cli.chat import apply_edit
        ok, err = apply_edit(self.work, "existing.txt", "nope nope", "y")
        self.assertFalse(ok)
        self.assertIn("not found", err)

    def test_safe_rel_blocks_escapes(self):
        from reach_cli.chat import _safe_rel
        self.assertIsNone(_safe_rel("../evil"))
        self.assertIsNone(_safe_rel("a/../../evil"))
        self.assertIsNone(_safe_rel("/abs/path"))
        self.assertIsNone(_safe_rel("C:/win/path"))
        self.assertEqual(_safe_rel("sub/dir/file.txt"), "sub/dir/file.txt")

    def test_build_system_agent_appends_workpath(self):
        from reach_cli.chat import build_system
        from reach_cli.client import ReachClient
        client = ReachClient("http://127.0.0.1:1")
        client.agent = True
        client.workpath = self.work
        prompt = build_system(client)
        self.assertIn("workpath is", prompt)
        self.assertIn("existing.txt", prompt)
        client.agent = False
        self.assertNotIn("workpath is", build_system(client))


class SlashCommandTests(unittest.TestCase):
    """REPL slash commands: one registry, no provider alias, no tracebacks."""

    def setUp(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from reach_cli import terminal
        from reach_cli.terminal import Paint

        self.io = io
        self.redirect_stdout = redirect_stdout
        self.redirect_stderr = redirect_stderr
        terminal.PAINT = Paint(False)
        self.client = self.make_client()

    def make_client(self):
        client = type("FakeClient", (), {})()
        client.base = "http://127.0.0.1:20777/v1"
        client.model = "gpt-4o"
        client.key = "sk-reach-" + ("UNIQUESECRET99" * 3)
        client.agent = False
        client.workpath = self.workpath()
        client.system = None
        client.usage = {"prompt": None, "completion": None}
        client.last_latency_ms = 0.0
        client._models = ["gpt-4o", "claude"]

        def models():
            return list(client._models)

        client.models = models
        return client

    def workpath(self):
        path = os.path.join(os.environ.get("TEMP") or "/tmp", "reach-cli-slash")
        os.makedirs(path, exist_ok=True)
        return path

    def invoke(self, line, history=None, session=None, client=None):
        from reach_cli.terminal import handle_slash

        if history is None:
            history = []
        out, err = self.io.StringIO(), self.io.StringIO()
        with self.redirect_stdout(out), self.redirect_stderr(err):
            result = handle_slash(line, self.client if client is None else client, history, session)
        text, errors = out.getvalue(), err.getvalue()
        self.assertNotIn("Traceback", text)
        self.assertNotIn("Traceback", errors)
        self.assertEqual(errors, "")
        return result, text, history

    def endpoint_patches(self, reachable=True, public="https://public.example/v1", boom=False):
        def discover():
            if boom:
                raise RuntimeError("gist down")
            return public

        def is_up(url, key=""):
            if callable(reachable):
                return reachable(url, key)
            return bool(reachable)

        return (
            unittest.mock.patch("reach_cli.client.discover_public_url", side_effect=discover),
            unittest.mock.patch("reach_cli.client.ReachClient._reachable", side_effect=is_up),
            unittest.mock.patch(
                "reach_cli.client.ReachClient.resolve_base",
                side_effect=AssertionError("fallback"),
            ),
        )

    def test_registry_is_unique_and_has_no_provider_command(self):
        from reach_cli.terminal import COMMANDS, HANDLERS, command_tokens

        tokens = command_tokens()
        self.assertEqual(tokens, [
            "/help", "/status", "/endpoint", "/model", "/models", "/web",
            "/agent", "/tools", "/workpath", "/system", "/clear", "/history",
            "/retry", "/undo", "/compact", "/copy", "/save", "/exit",
        ])
        self.assertEqual(len(tokens), len(set(tokens)))
        self.assertEqual(set(HANDLERS), set(tokens))
        self.assertNotIn("/provider", HANDLERS)
        self.assertNotIn("/quit", HANDLERS)
        blob = " ".join(spec + " " + desc for spec, desc in COMMANDS).lower()
        self.assertNotIn("provider", blob)
        width = len("/web <question>")
        for spec, desc in COMMANDS:
            self.assertLessEqual(len(spec), width, spec)
            self.assertTrue(desc)
            self.assertNotIn("\n", desc)

    def test_help_keeps_the_column_layout(self):
        from reach_cli.terminal import COMMANDS, print_help

        out = self.io.StringIO()
        with self.redirect_stdout(out):
            print_help()
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), len(COMMANDS))
        for line, (key, description) in zip(lines, COMMANDS):
            self.assertEqual(line, "  %-16s %s" % (key, description))
        self.assertNotIn("provider", out.getvalue().lower())

    def test_unknown_command_suggests_the_closest(self):
        from reach_cli.terminal import suggest_command

        expected = {
            "/hlep": "/help",
            "/modle": "/model",
            "/modles": "/models",
            "/ednpoint": "/endpoint",
            "/stat": "/status",
            "/quit": "/exit",
            "/provider": "/endpoint",
            "/histroy": "/history",
            "/wrkpath": "/workpath",
            "/agnt": "/agent",
            "/staus": "/status",
            "/sytem": "/system",
        }
        for query, suggestion in expected.items():
            self.assertEqual(suggest_command(query), suggestion, query)
        _result, text, _history = self.invoke("/provider")
        self.assertIn("did you mean /endpoint?", text)
        self.assertNotIn("endpoint →", text)

    def test_provider_never_switches_the_endpoint(self):
        self.client.base = "http://original.example/v1"
        patches = self.endpoint_patches(reachable=True, public="https://public.example/v1")
        with patches[0], patches[1], patches[2] as resolve:
            _result, text, _history = self.invoke("/provider local")
        self.assertEqual(self.client.base, "http://original.example/v1")
        self.assertIn("/endpoint", text)
        self.assertNotIn("endpoint →", text)
        self.assertFalse(resolve.called)

    def test_endpoint_lists_and_marks_the_current_one(self):
        patches = self.endpoint_patches()
        with patches[0], patches[1], patches[2]:
            _result, text, _history = self.invoke("/endpoint")
        self.assertIn("http://127.0.0.1:20777/v1", text)
        self.assertIn("https://public.example/v1", text)
        self.assertIn("usage: /endpoint <local|public|url>", text)
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("- local"):
                self.assertIn("●", line)
            if stripped.startswith("- public"):
                self.assertNotIn("●", line)

    def test_endpoint_switches_without_falling_back(self):
        self.client.base = "https://public.example/v1"
        self.client.model = "gpt-4o"

        def reachable(url, key=""):
            return "public" in url

        patches = self.endpoint_patches(reachable=reachable, public="https://public.example/v1")
        with patches[0], patches[1], patches[2] as resolve:
            _result, text, _history = self.invoke("/endpoint local")
        self.assertEqual(self.client.base, "https://public.example/v1")
        self.assertIn("unreachable", text)
        self.assertIn("stayed on https://public.example/v1", text)
        self.assertFalse(resolve.called)

        patches = self.endpoint_patches(reachable=True, public="https://public.example/v1")
        with patches[0], patches[1], patches[2] as resolve:
            _result, text, _history = self.invoke("/endpoint public")
        self.assertEqual(self.client.base, "https://public.example/v1")
        self.assertIn("endpoint →", text)
        self.assertFalse(resolve.called)

        patches = self.endpoint_patches(reachable=True, public=None)
        self.client.base = "http://127.0.0.1:20777/v1"
        with patches[0], patches[1], patches[2]:
            _result, text, _history = self.invoke("/endpoint public")
        self.assertEqual(self.client.base, "http://127.0.0.1:20777/v1")
        self.assertIn("unavailable", text)
        self.assertIn("stayed on", text)

    def test_endpoint_rejects_bad_urls_and_a_dead_pointer(self):
        original = self.client.base
        patches = self.endpoint_patches(boom=True)
        with patches[0], patches[1], patches[2]:
            _result, text, _history = self.invoke("/endpoint")
        self.assertIn("pointer unavailable", text)
        self.assertIn(original, text)
        for bad in ("file:///etc/passwd", "javascript:alert(1)", "ftp://files.example/v1", "nope"):
            _result, text, _history = self.invoke("/endpoint " + bad)
            self.assertEqual(self.client.base, original)
            self.assertIn("unknown endpoint", text)

    def test_endpoint_switch_to_an_explicit_url(self):
        patches = self.endpoint_patches(reachable=True)
        with patches[0], patches[1], patches[2] as resolve:
            _result, text, _history = self.invoke("/endpoint http://relay.example/v1/")
        self.assertEqual(self.client.base, "http://relay.example/v1")
        self.assertIn("endpoint →", text)
        self.assertFalse(resolve.called)

    def test_status_masks_the_key_and_reports_session(self):
        self.client.agent = True
        _result, text, _history = self.invoke("/status")
        self.assertIn("http://127.0.0.1:20777/v1", text)
        self.assertIn("(local)", text)
        self.assertIn("gpt-4o", text)
        self.assertIn("on", text)
        self.assertIn(self.client.workpath, text)
        self.assertIn("sk-reach-…", text)
        self.assertNotIn("UNIQUESECRET99", text)
        self.client.key = ""
        self.client.model = None
        self.client.agent = False
        _result, text, _history = self.invoke("/status")
        self.assertIn("(none)", text)
        self.assertIn("(auto)", text)
        self.assertIn("off", text)

    def test_models_marks_the_current_alias(self):
        self.client.model = "claude"
        _result, text, _history = self.invoke("/models")
        self.assertIn("current: claude", text)
        for line in text.splitlines():
            if "claude" in line and line.strip().startswith("-"):
                self.assertIn("●", line)
                self.assertIn("current", line)
            if "gpt-4o" in line and line.strip().startswith("-"):
                self.assertNotIn("current", line)
                self.assertNotIn("●", line)

    def test_models_empty_unknown_and_errors(self):
        self.client.model = None
        self.client._models = []
        _result, text, _history = self.invoke("/models")
        self.assertIn("(auto)", text)
        self.assertIn("(none served)", text)

        self.client.model = "ghost"
        self.client._models = ["gpt-4o"]
        _result, text, _history = self.invoke("/models")
        self.assertIn("not in the served list", text)

        def boom():
            raise RuntimeError("boom")

        self.client.models = boom
        _result, text, _history = self.invoke("/models")
        self.assertIn("✗ models: boom", text)

        self.client.models = lambda: ["gpt-4o", "claude"]
        self.client.model = "gpt-4o"
        _result, text, _history = self.invoke("/model")
        self.assertIn("usage: /model <alias>", text)
        _result, text, _history = self.invoke("/model missing")
        self.assertIn("unknown model", text)
        self.assertEqual(self.client.model, "gpt-4o")
        _result, text, _history = self.invoke("/model claude")
        self.assertEqual(self.client.model, "claude")
        self.assertIn("model →", text)

        def down():
            raise RuntimeError("down")

        self.client.models = down
        _result, text, _history = self.invoke("/model gpt-4o")
        self.assertEqual(self.client.model, "gpt-4o")
        self.assertNotIn("Traceback", text)

    def test_retry_undo_and_empty_states(self):
        from reach_cli.terminal import ReplSession

        session = ReplSession()
        result, text, _history = self.invoke("/retry", session=session)
        self.assertIsNone(result.prompt)
        self.assertIn("nothing to retry", text)

        session.remember("hello there")
        history = [
            {"role": "user", "content": "older"},
            {"role": "assistant", "content": "old-answer"},
        ]
        result, text, _history = self.invoke("/retry", history=history, session=session)
        self.assertEqual(result.prompt, "hello there")
        self.assertIn("retrying:", text)

        result, _text, _history = self.invoke("/retry", history=history, session=ReplSession())
        self.assertEqual(result.prompt, "older")
        tool_only = [{"role": "user", "content": "[tool result]\nnope"}]
        result, text, _history = self.invoke("/retry", history=tool_only, session=ReplSession())
        self.assertIsNone(result.prompt)
        self.assertIn("nothing to retry", text)

        history = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "keep"},
            {"role": "assistant", "content": "kept"},
            {"role": "user", "content": "fix it"},
            {"role": "assistant", "content": "tool"},
            {"role": "user", "content": "[tool result]\nok"},
            {"role": "assistant", "content": "done"},
        ]
        _result, text, history = self.invoke("/undo", history=history)
        self.assertIn("dropped last exchange", text)
        self.assertEqual(
            [message["content"] for message in history],
            ["sys", "keep", "kept"],
        )
        _result, _text, history = self.invoke("/undo", history=history)
        self.assertEqual([message["role"] for message in history], ["system"])
        _result, text, history = self.invoke("/undo", history=history)
        self.assertIn("nothing to undo", text)
        self.assertEqual(history, [{"role": "system", "content": "sys"}])

    def test_compact_shrinks_and_handles_empty_history(self):
        history = [{"role": "system", "content": "SYSKEEP"}]
        _result, text, history = self.invoke("/compact", history=history)
        self.assertIn("nothing to compact", text)
        self.assertEqual(history, [{"role": "system", "content": "SYSKEEP"}])

        short = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        snapshot = [dict(message) for message in short]
        _result, text, short = self.invoke("/compact", history=short)
        self.assertIn("already compact", text)
        self.assertEqual(short, snapshot)

        old = "OLDWORD " + ("x" * 3000)
        mid = "MIDWORD " + ("y" * 200)
        history = [
            {"role": "system", "content": "SYSKEEP"},
            {"role": "user", "content": old},
            {"role": "assistant", "content": "old-answer " + ("z" * 2000)},
            {"role": "user", "content": mid},
            {"role": "assistant", "content": "mid-answer"},
            {"role": "user", "content": "RECENTWORD"},
            {"role": "assistant", "content": "recent-answer"},
        ]
        before = sum(len(message["content"]) for message in history)
        _result, text, history = self.invoke("/compact", history=history)
        after = sum(len(str(message.get("content") or "")) for message in history)
        self.assertIn("compacted", text)
        self.assertLess(after, before)
        self.assertTrue(any(message.get("content") == "SYSKEEP" for message in history))
        self.assertTrue(any(message.get("content") == "RECENTWORD" for message in history))
        self.assertTrue(any(message.get("content") == mid for message in history))
        self.assertFalse(any(message.get("content") == old for message in history))
        self.assertTrue(any(
            isinstance(message.get("content"), str)
            and message["content"].startswith("[compacted history]")
            and "OLDWORD" in message["content"]
            for message in history
        ))

        huge = "H" * 5000
        history = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": huge},
            {"role": "assistant", "content": "short"},
        ]
        _result, text, history = self.invoke("/compact", history=history)
        self.assertIn("compacted", text)
        user = next(message for message in history if message.get("role") == "user")
        self.assertLess(len(user["content"]), 5000)
        self.assertIn("[truncated]", user["content"])
        self.assertTrue(user["content"].startswith("H"))

    def test_copy_succeeds_and_fails_without_a_clipboard(self):
        result, text, _history = self.invoke("/copy", history=[])
        self.assertIn("nothing to copy", text)
        self.assertFalse(result.quit)

        history = [
            {"role": "assistant", "content": "first"},
            {"role": "user", "content": "again"},
            {"role": "assistant", "content": "second answer"},
        ]
        with unittest.mock.patch(
            "reach_cli.terminal.copy_to_clipboard", return_value=(True, None)
        ) as copied:
            _result, text, _history = self.invoke("/copy", history=history)
        copied.assert_called_once_with("second answer")
        self.assertIn("copied last answer", text)

        with unittest.mock.patch(
            "reach_cli.terminal.copy_to_clipboard",
            return_value=(False, "no clipboard available"),
        ):
            _result, text, _history = self.invoke("/copy", history=history)
        self.assertIn("no clipboard available", text)
        self.assertNotIn("copied last answer", text)

        with unittest.mock.patch(
            "reach_cli.terminal.copy_to_clipboard",
            side_effect=RuntimeError("clipboard exploded"),
        ):
            _result, text, _history = self.invoke("/copy", history=history)
        self.assertIn("could not copy", text)

        from reach_cli.terminal import copy_to_clipboard
        ok, detail = copy_to_clipboard("")
        self.assertFalse(ok)
        self.assertTrue(detail)
        ok, detail = copy_to_clipboard("hello from reach")
        self.assertIsInstance(ok, bool)
        if not ok:
            self.assertTrue(detail)

    def test_save_history_clear_workpath_and_tools(self):
        import tempfile
        from reach_cli.terminal import ReplSession

        history = [{"role": "user", "content": "saved-line"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "chat.jsonl")
            _result, text, _history = self.invoke("/save " + path, history=history)
            self.assertIn("saved →", text)
            with open(path, encoding="utf-8") as handle:
                rows = [json.loads(line) for line in handle if line.strip()]
            self.assertEqual(rows, history)
            fd, blocker = tempfile.mkstemp(dir=tmp)
            os.close(fd)
            _result, text, _history = self.invoke(
                "/save " + os.path.join(blocker, "nope.jsonl"), history=history
            )
            self.assertIn("could not save", text)

        _result, text, _history = self.invoke("/history", history=[])
        self.assertIn("conversation is empty", text)
        _result, text, _history = self.invoke("/history", history=history)
        self.assertIn("saved-line", text)
        self.assertIn("user:", text)

        session = ReplSession()
        session.remember("hello")
        convo = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        _result, text, convo = self.invoke("/clear", history=convo, session=session)
        self.assertIn("conversation cleared", text)
        self.assertIsNone(session.last_prompt)
        self.assertTrue(any(message.get("role") == "system" for message in convo))
        self.assertFalse(any(message.get("role") == "user" for message in convo))

        _result, text, _history = self.invoke("/workpath")
        self.assertIn("usage: /workpath <dir>", text)
        _result, text, _history = self.invoke("/workpath /no/such/reach-cli-dir")
        self.assertIn("not a directory", text)
        self.assertNotEqual(self.client.workpath, "/no/such/reach-cli-dir")
        with tempfile.TemporaryDirectory() as tmp:
            _result, text, _history = self.invoke("/workpath " + tmp)
            self.assertEqual(self.client.workpath, os.path.abspath(tmp))
            self.assertIn("workpath →", text)

        _result, text, _history = self.invoke("/tools")
        self.assertIn("shell", text)
        self.assertIn("read", text)

        _result, text, _history = self.invoke("/system be brief")
        self.assertEqual(self.client.system, "be brief")
        self.assertIn("set", text)
        _result, text, _history = self.invoke("/system")
        self.assertIsNone(self.client.system)
        self.assertIn("cleared", text)

        _result, text, _history = self.invoke("/agent")
        self.assertTrue(self.client.agent)
        self.assertIn("on", text)
        _result, text, _history = self.invoke("/agent")
        self.assertFalse(self.client.agent)
        self.assertIn("off", text)

    def test_web_usage_and_dispatch(self):
        _result, text, history = self.invoke("/web")
        self.assertIn("usage: /web <question>", text)
        self.assertEqual(history, [])
        with unittest.mock.patch("reach_cli.chat.run_web_answer", return_value=True) as web:
            history = [{"role": "system", "content": "sys"}]
            _result, _text, history = self.invoke("/web what is paris", history=history)
        web.assert_called_once()
        self.assertEqual(history[-1]["content"], "what is paris")

    def test_bad_input_never_traces_back(self):
        from reach_cli.terminal import ReplSession

        patches = self.endpoint_patches(boom=True, reachable=False)
        session = ReplSession()
        lines = [
            None, "", "   ", "/", "/nope", "/provider", "/provider local",
            "/endpoint", "/endpoint nope", "/endpoint file:///etc/passwd",
            "/model", "/model not-a-model", "/models", "/retry", "/copy",
            "/undo", "/compact", "/workpath", "/workpath /no/such/dir",
            "/history", "/clear", "/status", "/agent", "/tools", "/system",
            "/web", "/HELP", "/exit now",
        ]
        with patches[0], patches[1], patches[2]:
            for line in lines:
                result, text, _history = self.invoke(line, history=[], session=session)
                self.assertNotIn("Traceback", text)
                if line == "/exit now":
                    self.assertTrue(result.quit)

    def test_repl_hook_retries_and_keeps_prompts(self):
        from reach_cli.chat import run_chat
        from reach_cli.client import ReachApiError, ReachClient

        client = ReachClient("http://127.0.0.1:1", model="gpt-4o")
        client.workpath = self.workpath()
        seen = []

        # chat mode now goes through request_reply -> client.complete
        def fake_complete(messages, tools=None, on_text=None, stream=True):
            seen.append([m.get("content") for m in messages if m.get("role") == "user"])
            if on_text:
                on_text("ok")
            return {"content": "ok", "tool_calls": []}

        client.complete = fake_complete
        prompts = []
        answers = iter(["hello", "/retry", "/exit"])

        def fake_input(prompt=""):
            prompts.append(prompt)
            return next(answers)

        out = self.io.StringIO()
        with unittest.mock.patch("builtins.input", side_effect=fake_input), self.redirect_stdout(out):
            run_chat(client, client.base)
        self.assertEqual(seen, [["hello"], ["hello", "hello"]])
        self.assertTrue(any("you ▸" in prompt for prompt in prompts))
        self.assertIn("ai ▸", out.getvalue())
        self.assertIn("bye.", out.getvalue())

        seen[:] = []
        calls = {"n": 0}

        def failing_then_ok(messages, tools=None, on_text=None, stream=True):
            calls["n"] += 1
            seen.append([m.get("content") for m in messages if m.get("role") == "user"])
            if calls["n"] == 1:
                raise ReachApiError("nope", status=400)  # non-retryable: fails fast
            if on_text:
                on_text("recovered")
            return {"content": "recovered", "tool_calls": []}

        client.complete = failing_then_ok
        answers = iter(["hello", "/retry", "/exit"])
        with unittest.mock.patch("builtins.input", side_effect=lambda _prompt="": next(answers)), self.redirect_stdout(self.io.StringIO()):
            run_chat(client, client.base)
        self.assertEqual(seen, [["hello"], ["hello"]])

        def refuse_send(*_args, **_kwargs):
            raise AssertionError("slash commands must not be sent as prompts")

        client.chat = refuse_send
        client.complete = refuse_send
        client.base = "http://stay.example/v1"
        answers = iter(["/provider", "/no-such-command", "/exit"])
        quiet = self.io.StringIO()
        with unittest.mock.patch("builtins.input", side_effect=lambda _prompt="": next(answers)), self.redirect_stdout(quiet):
            run_chat(client, client.base)
        self.assertEqual(client.base, "http://stay.example/v1")
        self.assertIn("did you mean /endpoint?", quiet.getvalue())
        self.assertIn("bye.", quiet.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)


# ---- agent loop robustness (native tool_calls, retries, partial streams) ----

import io  # noqa: E402
import contextlib  # noqa: E402
import urllib.error  # noqa: E402

from reach_cli import chat as chat_mod  # noqa: E402
from reach_cli.agent_tools import tool_schemas, parse_tool_arguments  # noqa: E402
from reach_cli.client import ReachClient, ReachTransientError  # noqa: E402


class _Resp:
    """Fake urlopen response: iterable SSE lines or a JSON body."""

    def __init__(self, lines=None, body=None, cut_after=None):
        self._lines = [l.encode() if isinstance(l, str) else l for l in (lines or [])]
        self._body = body
        self._cut = cut_after

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self._body).encode()

    def __iter__(self):
        for i, line in enumerate(self._lines):
            if self._cut is not None and i >= self._cut:
                raise ConnectionResetError("reset by peer")
            yield line


def _sse(obj):
    return "data: " + json.dumps(obj) + "\n"


def _delta(**delta):
    return _sse({"choices": [{"delta": delta}]})


def _http_error(code):
    return urllib.error.HTTPError("http://x/chat/completions", code, "err", {},
                                  io.BytesIO(b'{"error":{"message":"busy"}}'))


class _Recorder:
    """Patch urlopen with a scripted sequence; records every payload."""

    def __init__(self, script):
        self.script = list(script)
        self.payloads = []
        self.urls = []

    def __call__(self, request, timeout=None):
        self.urls.append(request.full_url)
        self.payloads.append(json.loads(request.data.decode()))
        # the last step repeats (the loop may nudge a prose answer up to
        # MAX_RECOVERY times after tool results)
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, Exception):
            raise step
        return step


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = __import__("tempfile").mkdtemp()
        with open(os.path.join(self.tmp, "hello.txt"), "w") as fh:
            fh.write("hi there\n")
        self.client = ReachClient("http://relay/v1", model="codegpt-eco")
        self.client.agent = True
        self.client.workpath = self.tmp
        self.sleep = unittest.mock.patch.object(chat_mod, "_sleep", lambda s: None)
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()

    def run_agent(self, script):
        rec = _Recorder(script)
        out = io.StringIO()
        history = [{"role": "user", "content": "read hello.txt"}]
        with unittest.mock.patch("urllib.request.urlopen", rec), \
                contextlib.redirect_stdout(out):
            ok = chat_mod.run_agent_turn(self.client, history, chat_mod.AgentState())
        return ok, history, rec, out.getvalue()

    def test_tool_schemas_openai_format(self):
        schemas = tool_schemas()
        names = {s["function"]["name"] for s in schemas}
        self.assertIn("read", names)
        for s in schemas:
            self.assertEqual(s["type"], "function")
            self.assertEqual(s["function"]["parameters"]["type"], "object")

    def test_native_tool_calls_streamed(self):
        first = _Resp([
            _delta(tool_calls=[{"index": 0, "id": "call_1", "type": "function",
                                "function": {"name": "read", "arguments": ""}}]),
            _delta(tool_calls=[{"index": 0, "function": {"arguments": '{"pa'}}]),
            _delta(tool_calls=[{"index": 0, "function": {"arguments": 'th": "hello.txt"}'}}]),
            _sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
            "data: [DONE]\n",
        ])
        second = _Resp([_delta(content="It says hi there."), "data: [DONE]\n"])
        ok, history, rec, out = self.run_agent([first, second])
        self.assertTrue(ok)
        self.assertIn("tools", rec.payloads[0])
        assistant = [m for m in history if m.get("tool_calls")][0]
        self.assertEqual(assistant["tool_calls"][0]["function"]["name"], "read")
        tool_msg = [m for m in history if m["role"] == "tool"][0]
        self.assertEqual(tool_msg["tool_call_id"], "call_1")
        self.assertIn("hi there", tool_msg["content"])
        # the second request carries the tool exchange back to the model
        roles = [m["role"] for m in rec.payloads[1]["messages"]]
        self.assertIn("tool", roles)
        self.assertNotIn("Traceback", out)

    def test_native_tool_calls_non_streamed(self):
        self.client.no_stream = True
        first = _Resp(body={"choices": [{"message": {"content": None, "tool_calls": [
            {"id": "c9", "type": "function",
             "function": {"name": "read", "arguments": '{"path": "hello.txt"}'}}]}}]})
        second = _Resp(body={"choices": [{"message": {"content": "done"}}]})
        ok, history, rec, _ = self.run_agent([first, second])
        self.assertTrue(ok)
        tool_msg = [m for m in history if m["role"] == "tool"][0]
        self.assertEqual(tool_msg["tool_call_id"], "c9")
        self.assertIn("hi there", tool_msg["content"])

    def test_malformed_tool_arguments_handled(self):
        self.assertIsNotNone(parse_tool_arguments("{not json")[1])
        self.client.no_stream = True
        first = _Resp(body={"choices": [{"message": {"tool_calls": [
            {"id": "c1", "function": {"name": "read", "arguments": "{bad"}}]}}]})
        second = _Resp(body={"choices": [{"message": {"content": "ok"}}]})
        ok, history, _, out = self.run_agent([first, second])
        self.assertTrue(ok)
        tool_msg = [m for m in history if m["role"] == "tool"][0]
        self.assertTrue(tool_msg["content"].startswith("error:"))
        self.assertNotIn("Traceback", out)

    def test_text_tool_block_path_still_works(self):
        block = '```tool\n{"action": "read", "path": "hello.txt"}\n```'
        first = _Resp([_delta(content=block), "data: [DONE]\n"])
        second = _Resp([_delta(content="Read it."), "data: [DONE]\n"])
        ok, history, _, _ = self.run_agent([first, second])
        self.assertTrue(ok)
        results = [m for m in history if m["role"] == "user"
                   and m["content"].startswith("[tool result]")]
        self.assertEqual(len(results), 1)
        self.assertIn("hi there", results[0]["content"])

    def test_retries_same_provider_and_model(self):
        ok_resp = _Resp([_delta(content="hello"), "data: [DONE]\n"])
        ok, _, rec, out = self.run_agent(
            [_http_error(502), _http_error(503), TimeoutError("slow"), ok_resp])
        self.assertTrue(ok)
        self.assertEqual(len(rec.payloads), 4)
        self.assertEqual({p["model"] for p in rec.payloads}, {"codegpt-eco"})
        self.assertEqual(set(rec.urls), {"http://relay/v1/chat/completions"})
        self.assertEqual(self.client.model, "codegpt-eco")
        self.assertIn("retrying", out)
        self.assertNotIn("✗", out)

    def test_partial_stream_is_kept_and_continued(self):
        cut = _Resp([_delta(content="Hello "), _delta(content="wor"),
                     _delta(content="ld")], cut_after=2)
        rest = _Resp([_delta(content="ld!"), "data: [DONE]\n"])
        ok, history, rec, out = self.run_agent([cut, rest])
        self.assertTrue(ok)
        self.assertEqual(history[-1]["content"], "Hello world!")
        retry_msgs = rec.payloads[1]["messages"]
        self.assertEqual(retry_msgs[-2], {"role": "assistant", "content": "Hello wor"})
        self.assertEqual(rec.payloads[1]["model"], "codegpt-eco")
        self.assertNotIn("Traceback", out)

    def test_cut_after_complete_tool_call_keeps_it(self):
        cut = _Resp([
            _delta(tool_calls=[{"index": 0, "id": "k1", "function": {
                "name": "read", "arguments": '{"path": "hello.txt"}'}}]),
            "data: never\n"], cut_after=1)
        final = _Resp([_delta(content="fine"), "data: [DONE]\n"])
        ok, history, rec, _ = self.run_agent([cut, final])
        self.assertTrue(ok)
        # no re-request of the cut turn: request 2 already carries the tool result
        self.assertIn("tool", [m["role"] for m in rec.payloads[1]["messages"]])
        self.assertTrue(any(m["role"] == "tool" for m in history))

    def test_graceful_final_failure_no_traceback(self):
        ok, _, rec, out = self.run_agent([_http_error(502)] * chat_mod.MAX_ATTEMPTS)
        self.assertFalse(ok)
        self.assertEqual(len(rec.payloads), chat_mod.MAX_ATTEMPTS)
        self.assertEqual({p["model"] for p in rec.payloads}, {"codegpt-eco"})
        self.assertNotIn("Traceback", out)
        self.assertNotIn("HTTP 502", out)
        self.assertEqual(out.count("✗ the model didn't answer"), 1)
        self.assertNotIn("⏸", out)
        line = ("  ✗ the model didn't answer: endpoint unavailable (502), after 4 tries"
                " — send your message again or /retry")
        self.assertIn(chat_mod.c_red(line), out)  # same red helper as the old error line
        self.assertIn("endpoint unavailable (502), after 4 tries", out)

    def test_non_retryable_4xx_fails_fast_with_reason(self):
        for code, reason in ((401, "auth rejected (401)"),
                             (403, "auth rejected (403)"),
                             (404, "model not available (404)"),
                             (400, "request rejected (400)")):
            ok, _, rec, out = self.run_agent([_http_error(code)])
            self.assertFalse(ok)
            self.assertEqual(len(rec.payloads), 1, code)
            self.assertIn(reason + ", not retried", out)
            self.assertNotIn("retrying", out)
            self.assertNotIn("Traceback", out)

    def test_rate_limit_and_timeout_reasons(self):
        n = chat_mod.MAX_ATTEMPTS
        _, _, rec, out = self.run_agent([_http_error(429)] * n)
        self.assertEqual(len(rec.payloads), n)
        self.assertIn("rate limited (429), after %d tries" % n, out)
        _, _, _, out = self.run_agent([TimeoutError("slow")] * n)
        self.assertIn("timed out, after %d tries" % n, out)
        _, _, _, out = self.run_agent(
            [urllib.error.URLError(ConnectionRefusedError("refused"))] * n)
        self.assertIn("endpoint unreachable (relay:80), after %d tries" % n, out)

    def test_real_openai_tool_call_shapes_list_and_glob(self):
        # exact shapes from the bridge: id, type function, arguments as JSON string
        streamed = _Resp([
            _sse({"id": "chatcmpl-1", "object": "chat.completion.chunk",
                  "choices": [{"index": 0, "delta": {"role": "assistant", "content": None,
                   "tool_calls": [{"index": 0, "id": "call_abc", "type": "function",
                                   "function": {"name": "list", "arguments": ""}}]},
                   "finish_reason": None}]}),
            _delta(tool_calls=[{"index": 0, "function": {"arguments": "{\"path\": \"\"}"}}]),
            _delta(tool_calls=[{"index": 1, "id": "call_def", "type": "function",
                                "function": {"name": "glob",
                                             "arguments": "{\"pattern\": \"*.txt\"}"}}]),
            _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
            "data: [DONE]\n",
        ])
        final = _Resp([_delta(content="done"), "data: [DONE]\n"])
        ok, history, rec, _ = self.run_agent([streamed, final])
        self.assertTrue(ok)
        call_msg = [m for m in history if m.get("tool_calls")][0]
        self.assertEqual([c["id"] for c in call_msg["tool_calls"]], ["call_abc", "call_def"])
        self.assertTrue(all(c["type"] == "function" for c in call_msg["tool_calls"]))
        self.assertTrue(all(isinstance(c["function"]["arguments"], str)
                            for c in call_msg["tool_calls"]))
        tools = {m["tool_call_id"]: m["content"] for m in history if m["role"] == "tool"}
        self.assertIn("hello.txt", tools["call_abc"])
        self.assertIn("hello.txt", tools["call_def"])
        # non-streamed, same shapes
        self.client.no_stream = True
        body = {"id": "chatcmpl-2", "object": "chat.completion", "choices": [{
            "index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [
                    {"id": "call_x", "type": "function",
                     "function": {"name": "glob", "arguments": "{\"pattern\": \"**/*.txt\"}"}}]}}]}
        ok, history, _, _ = self.run_agent(
            [_Resp(body=body), _Resp(body={"choices": [{"message": {"content": "ok"}}]})])
        self.assertTrue(ok)
        tools = {m["tool_call_id"]: m["content"] for m in history if m["role"] == "tool"}
        self.assertIn("hello.txt", tools["call_x"])

    def test_unexpected_exception_never_escapes(self):
        ok, _, _, out = self.run_agent([RuntimeError("boom")])
        self.assertFalse(ok)
        self.assertNotIn("Traceback", out)

    def test_transient_error_carries_partial(self):
        err = ReachTransientError("x", {"content": "ab", "tool_calls": []})
        self.assertEqual(err.partial["content"], "ab")


class RetryWiringTests(unittest.TestCase):
    """/retry's prompt goes through request_reply in chat and /agent mode."""

    def _run(self, agent):
        client = ReachClient("http://relay/v1", model="codegpt-eco")
        client.agent = agent
        client.workpath = __import__("tempfile").mkdtemp()
        inputs = iter(["hello", "/retry", "/exit"])
        rec = _Recorder([_http_error(502), _http_error(502),
                         _Resp([_delta(content="hi"), "data: [DONE]\n"])])
        out = io.StringIO()
        with unittest.mock.patch("builtins.input", lambda *_: next(inputs)), \
                unittest.mock.patch("urllib.request.urlopen", rec), \
                unittest.mock.patch.object(chat_mod, "_sleep", lambda s: None), \
                unittest.mock.patch.object(chat_mod, "banner", lambda *a: None), \
                unittest.mock.patch.object(chat_mod, "MAX_ATTEMPTS", 1), \
                contextlib.redirect_stdout(out):
            chat_mod.run_chat(client, "http://relay/v1")
        return rec, out.getvalue()

    def test_retry_in_chat_mode(self):
        rec, out = self._run(agent=False)
        self.assertGreaterEqual(len(rec.payloads), 2)
        self.assertEqual(rec.payloads[-1]["messages"][-1]["content"], "hello")
        self.assertEqual({p["model"] for p in rec.payloads}, {"codegpt-eco"})
        self.assertNotIn("Traceback", out)

    def test_retry_in_agent_mode(self):
        rec, out = self._run(agent=True)
        self.assertIn("tools", rec.payloads[-1])
        self.assertIn("hello", [m.get("content") for m in rec.payloads[-1]["messages"]])
        self.assertEqual({p["model"] for p in rec.payloads}, {"codegpt-eco"})
        self.assertNotIn("Traceback", out)


class NoEndpointFallbackTests(unittest.TestCase):
    """resolve_base never swaps in the public pointer unless 'public' was picked."""

    def test_explicit_or_preset_base_is_kept_even_when_down(self):
        for base in ("http://127.0.0.1:1/v1", "http://127.0.0.1:20777/v1",
                     "https://my.relay.example/v1"):
            client = ReachClient(base)
            with unittest.mock.patch("reach_cli.client.discover_public_url",
                                     side_effect=AssertionError("gist used")), \
                    unittest.mock.patch("urllib.request.urlopen",
                                        side_effect=AssertionError("probe/gist used")):
                self.assertEqual(client.resolve_base(), base.rstrip("/"))

    def test_public_uses_the_pointer_only_when_chosen(self):
        client = ReachClient("public")
        with unittest.mock.patch("reach_cli.client.discover_public_url",
                                 return_value="https://pub.example/v1/\n".strip()):
            self.assertEqual(client.resolve_base(), "https://pub.example/v1")
        with unittest.mock.patch("reach_cli.client.discover_public_url", return_value=None):
            self.assertIsNone(client.resolve_base())

    def test_unreachable_endpoint_red_line_names_host_port(self):
        client = ReachClient("http://127.0.0.1:1/v1", model="m")
        refused = urllib.error.URLError(ConnectionRefusedError("refused"))
        rec = _Recorder([refused])
        out = io.StringIO()
        msgs = [{"role": "user", "content": "hi"}]
        with unittest.mock.patch("urllib.request.urlopen", rec), \
                unittest.mock.patch.object(chat_mod, "_sleep", lambda s: None), \
                contextlib.redirect_stdout(out):
            ok, _ = chat_mod.stream_reply(client, msgs)
        self.assertFalse(ok)
        self.assertIn(chat_mod.c_red(
            "  ✗ the model didn't answer: endpoint unreachable (127.0.0.1:1), after 4 tries"
            " — send your message again or /retry"), out.getvalue())
        self.assertEqual(set(rec.urls), {"http://127.0.0.1:1/v1/chat/completions"})


class ToolLineTests(unittest.TestCase):
    """Compact '⏺ tool args' / '⎿ ✓ summary' agent lines."""

    def setUp(self):
        from reach_cli import agent_tools
        self.at = agent_tools

    def capture(self, fn, *a):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fn(*a)
        return out.getvalue()

    def test_compact_args_not_json(self):
        self.assertEqual(self.at.format_args("read", {"path": "a.py", "startLine": 3}),
                         "path=a.py startLine=3")
        self.assertEqual(self.at.format_args("search", {"pattern": "def x", "regex": True}),
                         'pattern="def x" regex')
        self.assertEqual(self.at.format_args("todo_write", {"todos": [{}, {}]}), "2 item(s)")
        line = self.capture(chat_mod.show_tool_call, "list", {"path": "src"})
        self.assertEqual(line, "  ⏺ list  path=src\n")
        self.assertNotIn("{", line)

    def test_result_summaries(self):
        s = self.at.summarize_result
        self.assertEqual(s("read", "a.py (12 lines)\n    1 | x"), (True, "12 lines"))
        self.assertEqual(s("list", "a/\n  b\nc"), (True, "3 entries"))
        self.assertEqual(s("glob", "a.py\nb.py"), (True, "2 file(s)"))
        self.assertEqual(s("search", "no matches"), (True, "no matches"))
        self.assertEqual(s("shell", "exit code 1\n3 failed"), (False, "exit 1 · 3 failed"))
        self.assertEqual(s("read", "error: no such file: x"), (False, "no such file: x"))
        self.assertEqual(s("shell", "shell command denied by the user: rm"), (False, "denied"))
        out = self.capture(chat_mod.show_tool_result, "list", "a\nb")
        self.assertEqual(out, "    ⎿ ✓ 2 entries\n")

    def test_edit_shows_short_diff(self):
        args = {"path": "a.py", "search": "old = 1", "replace": "new = 2\nmore\nx\ny"}
        out = self.capture(chat_mod.show_tool_call, "edit", args)
        self.assertIn("⏺ edit  a.py", out)
        self.assertIn("      - old = 1", out)
        self.assertIn("      + new = 2", out)
        self.assertIn("+ … 1 more line(s)", out)

    def test_retry_lines_have_no_blank_lines_between(self):
        client = ReachClient("http://relay/v1", model="m")
        rec = _Recorder([_http_error(502)] * 4)
        out = io.StringIO()
        with unittest.mock.patch("urllib.request.urlopen", rec), \
                unittest.mock.patch.object(chat_mod, "_sleep", lambda s: None), \
                contextlib.redirect_stdout(out):
            chat_mod.stream_reply(client, [{"role": "user", "content": "x"}])
        lines = out.getvalue().split("\n")
        start = next(i for i, l in enumerate(lines) if "retrying" in l)
        tail = [l for l in lines[start:] if l != ""]
        self.assertEqual(lines[start:start + len(tail)], tail)  # contiguous
        self.assertEqual(len([l for l in tail if "retrying" in l]), 3)


class MarkdownRenderTests(unittest.TestCase):
    def setUp(self):
        from reach_cli import render, terminal
        self.render, self.terminal = render, terminal

    def lines(self, text, width=40):
        m = self.render.MarkdownStream(width)
        out = []
        for i in range(0, len(text), 7):  # arbitrary delta boundaries
            out += m.feed(text[i:i + 7])
        return out + m.flush()

    def test_blocks_plain_paint(self):
        text = ("# Title\n\nSome **bold** and `code`.\n```python\nprint(1)\n```\n"
                "- a bullet that is long enough to wrap around the width\n1. one\n")
        out = self.lines(text)
        self.assertEqual(out[0], "Title")
        self.assertEqual(out[2], "Some bold and code.")
        self.assertTrue(out[3].startswith("┌─ python "))
        self.assertEqual(out[4], "│ print(1)")
        self.assertTrue(out[5].startswith("└─"))
        self.assertTrue(out[6].startswith("• a bullet"))
        self.assertTrue(out[7].startswith("  "))  # hanging indent
        self.assertIn("1. one", out)
        self.assertTrue(all(len(l) <= 40 for l in out))

    def test_styles_when_colour_on(self):
        with unittest.mock.patch.object(self.terminal.PAINT, "on", True):
            out = self.lines("## Head\n**b** `c`\n```\nx\n")
        self.assertIn("\x1b[1m", out[0])
        self.assertIn("\x1b[1mb\x1b[0m", out[1])
        self.assertIn("\x1b[36mc\x1b[0m", out[1])
        self.assertIn("code", out[2])           # default fence label
        self.assertTrue(out[-1].endswith("\x1b[0m"))  # unterminated fence closed

    def test_stream_reply_renders_in_gutter_when_colour_on(self):
        client = ReachClient("http://relay/v1", model="m")
        rec = _Recorder([_Resp([_delta(content="# Hi\nline **two**\n"), "data: [DONE]\n"])])
        out = io.StringIO()
        with unittest.mock.patch.object(self.terminal.PAINT, "on", True), \
                unittest.mock.patch("urllib.request.urlopen", rec), \
                contextlib.redirect_stdout(out):
            ok, text = chat_mod.stream_reply(client, [{"role": "user", "content": "x"}])
            expected = self.terminal.c_cyan("  │ ") + "line " + self.terminal.c_bold("two")
        self.assertTrue(ok)
        self.assertEqual(text, "# Hi\nline **two**\n")  # history keeps raw markdown
        shown = out.getvalue()
        self.assertNotIn("# Hi", shown)
        self.assertIn(expected, shown)

    def test_no_color_prints_raw_text(self):
        client = ReachClient("http://relay/v1", model="m")
        rec = _Recorder([_Resp([_delta(content="# Hi **x**\n"), "data: [DONE]\n"])])
        out = io.StringIO()
        with unittest.mock.patch.object(self.terminal.PAINT, "on", False), \
                unittest.mock.patch("urllib.request.urlopen", rec), \
                contextlib.redirect_stdout(out):
            chat_mod.stream_reply(client, [{"role": "user", "content": "x"}])
        self.assertIn("ai ▸ # Hi **x**", out.getvalue())


class CtrlCTests(unittest.TestCase):
    """Ctrl-C stops only the current answer, keeps partial text."""

    def _interrupting_resp(self):
        class R(_Resp):
            def __iter__(self):
                yield _delta(content="partial ").encode()
                raise KeyboardInterrupt
        return R()

    def test_chat_mode_stop_keeps_partial_and_returns_to_prompt(self):
        client = ReachClient("http://relay/v1", model="m")
        client.workpath = __import__("tempfile").mkdtemp()
        inputs = iter(["hello", "again", "/exit"])
        rec = _Recorder([self._interrupting_resp(),
                         _Resp([_delta(content="fine"), "data: [DONE]\n"])])
        out = io.StringIO()
        with unittest.mock.patch("builtins.input", lambda *_: next(inputs)), \
                unittest.mock.patch("urllib.request.urlopen", rec), \
                unittest.mock.patch.object(chat_mod, "banner", lambda *a: None), \
                contextlib.redirect_stdout(out):
            chat_mod.run_chat(client, client.base)
        text = out.getvalue()
        self.assertIn(chat_mod.c_red("  ✗ stopped"), text)
        self.assertIn("bye.", text)  # REPL kept running to /exit
        second = rec.payloads[1]["messages"]
        self.assertIn({"role": "assistant", "content": "partial "}, second)
        self.assertEqual(second[-1]["content"], "again")
        self.assertNotIn("Traceback", text)

    def test_agent_mode_stop_ends_turn_keeps_partial(self):
        client = ReachClient("http://relay/v1", model="m")
        client.agent = True
        client.workpath = __import__("tempfile").mkdtemp()
        history = [{"role": "user", "content": "go"}]
        rec = _Recorder([self._interrupting_resp()])
        out = io.StringIO()
        with unittest.mock.patch("urllib.request.urlopen", rec), \
                contextlib.redirect_stdout(out):
            ok = chat_mod.run_agent_turn(client, history, chat_mod.AgentState())
        self.assertFalse(ok)
        self.assertEqual(history[-1], {"role": "assistant", "content": "partial "})
        self.assertEqual(out.getvalue().count("✗ stopped"), 1)
        self.assertEqual(len(rec.payloads), 1)  # no retry after a user stop


class RenderPaintBindingTests(unittest.TestCase):
    def test_enabled_follows_replaced_paint_object(self):
        from reach_cli import render, terminal
        saved = terminal.PAINT
        try:
            terminal.PAINT = terminal.Paint(True)   # what __main__ does at startup
            self.assertTrue(render.enabled())
            terminal.PAINT = terminal.Paint(False)
            self.assertFalse(render.enabled())
        finally:
            terminal.PAINT = saved


class FooterAndPromptHookTests(unittest.TestCase):
    """Hooks for Main Chat: terminal.read_prompt() and client.last_turn."""

    def _chat(self, script, inputs, agent=False, patch_reader=None):
        from reach_cli import terminal
        client = ReachClient("http://relay/v1", model="m")
        client.agent = agent
        client.workpath = __import__("tempfile").mkdtemp()
        it = iter(inputs)
        seen = []

        def footer(c, cited=False):
            seen.append(dict(c.last_turn))
        rec = _Recorder(script)
        ctx = [unittest.mock.patch("urllib.request.urlopen", rec),
               unittest.mock.patch.object(chat_mod, "banner", lambda *a: None),
               unittest.mock.patch.object(chat_mod, "print_footer", footer)]
        if patch_reader:
            ctx.append(unittest.mock.patch.object(terminal, "read_prompt",
                                                  lambda c, s: next(it), create=True))
        else:
            ctx.append(unittest.mock.patch("builtins.input", lambda *_: next(it)))
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            for c in ctx:
                stack.enter_context(c)
            stack.enter_context(contextlib.redirect_stdout(out))
            chat_mod.run_chat(client, client.base)
        return client, seen, rec

    def test_read_prompt_used_when_present(self):
        from reach_cli import terminal
        with unittest.mock.patch("builtins.input",
                                 side_effect=AssertionError("input() used")):
            _, seen, rec = self._chat(
                [_Resp([_delta(content="hi"), "data: [DONE]\n"])],
                ["hello", "/exit"], patch_reader=True)
        self.assertEqual(rec.payloads[0]["messages"][-1]["content"], "hello")

    def test_falls_back_to_input_without_read_prompt(self):
        from reach_cli import terminal
        saved = getattr(terminal, "read_prompt", None)
        if saved is not None:
            delattr(terminal, "read_prompt")
        try:
            _, _, rec = self._chat([_Resp([_delta(content="hi"), "data: [DONE]\n"])],
                                   ["hello", "/exit"])
        finally:
            if saved is not None:
                terminal.read_prompt = saved
        self.assertEqual(len(rec.payloads), 1)

    def test_last_turn_plain_chat_with_stream_usage(self):
        resp = _Resp([_delta(content="hi"),
                      _sse({"choices": [], "usage": {"prompt_tokens": 5,
                                                     "completion_tokens": 2,
                                                     "total_tokens": 7}}),
                      "data: [DONE]\n"])
        client, seen, _ = self._chat([resp], ["hello", "/exit"])
        self.assertEqual(seen[0]["tokens"], 7)
        self.assertEqual(seen[0]["rounds"], 1)
        self.assertIsInstance(seen[0]["latency"], float)
        self.assertEqual(client.last_turn, seen[0])

    def test_last_turn_tokens_none_without_usage(self):
        client, seen, _ = self._chat([_Resp([_delta(content="hi"), "data: [DONE]\n"])],
                                     ["hello", "/exit"])
        self.assertNotIn("tokens", seen[0])  # unknown keys are omitted
        self.assertEqual(seen[0]["rounds"], 1)

    def test_last_turn_agent_counts_rounds_and_sums_tokens(self):
        r1 = _Resp(body={"usage": {"total_tokens": 10}, "choices": [{"message": {
            "tool_calls": [{"id": "a", "type": "function",
                            "function": {"name": "list", "arguments": "{}"}}]}}]})
        r2 = _Resp(body={"usage": {"prompt_tokens": 3, "completion_tokens": 4},
                         "choices": [{"message": {"content": "done"}}]})
        from reach_cli import terminal  # noqa: F401
        client = ReachClient("http://relay/v1", model="m", no_stream=True)
        client.agent = True
        client.workpath = __import__("tempfile").mkdtemp()
        history = [{"role": "user", "content": "go"}]
        seen = []
        rec = _Recorder([r1, r2])
        with unittest.mock.patch("urllib.request.urlopen", rec), \
                unittest.mock.patch.object(chat_mod, "print_footer",
                                           lambda c, cited=False: seen.append(dict(c.last_turn))), \
                contextlib.redirect_stdout(io.StringIO()):
            chat_mod.run_agent_turn(client, history, chat_mod.AgentState())
        # prose after tool results is nudged MAX_RECOVERY times, so 4 rounds
        self.assertEqual(client.last_turn["rounds"], 2 + chat_mod.MAX_RECOVERY)
        self.assertEqual(client.last_turn["tokens"], 10 + 7 * (1 + chat_mod.MAX_RECOVERY))
        self.assertEqual(seen[-1], client.last_turn)

    def test_last_turn_published_on_failure(self):
        client = ReachClient("http://relay/v1", model="m")
        client.agent = True
        client.workpath = __import__("tempfile").mkdtemp()
        with unittest.mock.patch("urllib.request.urlopen", _Recorder([_http_error(401)])), \
                contextlib.redirect_stdout(io.StringIO()):
            chat_mod.run_agent_turn(client, [{"role": "user", "content": "x"}],
                                    chat_mod.AgentState())
        self.assertEqual(client.last_turn["rounds"], 1)
        self.assertNotIn("tokens", client.last_turn)


# run_chat probes the endpoint once at startup; keep REPL tests off the network
_REAL_ENDPOINT_NOTICE = chat_mod.endpoint_notice
_NOTICE_PATCH = unittest.mock.patch.object(chat_mod, "endpoint_notice", lambda c: False)


def setUpModule():
    _NOTICE_PATCH.start()


def tearDownModule():
    _NOTICE_PATCH.stop()


class StarterCompatTests(unittest.TestCase):
    def test_notice_when_local_relay_down_no_switch(self):
        client = ReachClient("http://127.0.0.1:20777/v1")
        out = io.StringIO()
        with unittest.mock.patch.object(ReachClient, "_reachable", staticmethod(lambda b, k="": False)), \
                contextlib.redirect_stdout(out):
            self.assertTrue(_REAL_ENDPOINT_NOTICE(client))
        self.assertIn("no answer from 127.0.0.1:20777 yet", out.getvalue())
        self.assertIn("python tools/reach.py start", out.getvalue())
        self.assertEqual(client.base, "http://127.0.0.1:20777/v1")  # never switched

    def test_no_notice_when_up(self):
        client = ReachClient("http://127.0.0.1:20777/v1")
        out = io.StringIO()
        with unittest.mock.patch.object(ReachClient, "_reachable", staticmethod(lambda b, k="": True)), \
                contextlib.redirect_stdout(out):
            self.assertFalse(_REAL_ENDPOINT_NOTICE(client))
        self.assertEqual(out.getvalue(), "")

    def test_windows_legacy_console_glyph_fallback(self):
        self.assertEqual(chat_mod.tool_glyphs({}, "nt"), ("●", "└"))
        self.assertEqual(chat_mod.tool_glyphs({"WT_SESSION": "x"}, "nt"), ("⏺", "⎿"))
        self.assertEqual(chat_mod.tool_glyphs({"TERM_PROGRAM": "vscode"}, "nt"), ("⏺", "⎿"))
        self.assertEqual(chat_mod.tool_glyphs({}, "posix"), ("⏺", "⎿"))

    def test_ctrl_c_is_immediate_while_request_blocks(self):
        # the request sits in a blocking read (as on Windows, where SIGINT
        # cannot interrupt it); the main thread must still see Ctrl-C at once
        import threading
        release = threading.Event()

        def blocking():
            release.wait(5)
            return "late"

        def interrupter():
            raise KeyboardInterrupt

        calls = {"n": 0}
        real_join = threading.Thread.join

        def join(self, timeout=None):
            calls["n"] += 1
            if calls["n"] == 2:
                interrupter()
            return real_join(self, 0.01)
        started = time.time()
        with unittest.mock.patch.object(threading.Thread, "join", join):
            with self.assertRaises(KeyboardInterrupt):
                chat_mod._interruptible(blocking)
        release.set()
        self.assertLess(time.time() - started, 1.0)

    def test_worker_exceptions_propagate(self):
        with self.assertRaises(ValueError):
            chat_mod._interruptible(lambda: (_ for _ in ()).throw(ValueError("x")))
        self.assertEqual(chat_mod._interruptible(lambda: 5), 5)


class ReadPromptContractTests(unittest.TestCase):
    """terminal.read_prompt(client, session): '' re-prompts, None exits."""

    def _run(self, reader, inputs=None):
        from reach_cli import terminal
        client = ReachClient("http://relay/v1", model="m")
        client.workpath = __import__("tempfile").mkdtemp()
        rec = _Recorder([_Resp([_delta(content="ok"), "data: [DONE]\n"])])
        out = io.StringIO()
        with contextlib.ExitStack() as st:
            st.enter_context(unittest.mock.patch("urllib.request.urlopen", rec))
            st.enter_context(unittest.mock.patch.object(chat_mod, "banner", lambda *a: None))
            if reader is None:
                saved = getattr(terminal, "read_prompt", None)
                if saved is not None:
                    st.enter_context(unittest.mock.patch.object(terminal, "read_prompt", None))
                it = iter(inputs)

                def fake_input(*_):
                    v = next(it)
                    if isinstance(v, BaseException):
                        raise v
                    return v
                st.enter_context(unittest.mock.patch("builtins.input", fake_input))
            else:
                st.enter_context(unittest.mock.patch.object(terminal, "read_prompt", reader,
                                                            create=True))
            st.enter_context(contextlib.redirect_stdout(out))
            chat_mod.run_chat(client, client.base)
        return out.getvalue(), rec, client

    def test_two_arg_reader_gets_client_and_session(self):
        calls = []
        answers = iter(["", "hello", None])

        def reader(client, session):
            calls.append((client, session))
            return next(answers)
        out, rec, client = self._run(reader)
        self.assertEqual(len(calls), 3)  # '' re-prompted instead of exiting
        self.assertIs(calls[0][0], client)
        self.assertTrue(hasattr(calls[0][1], "remember"))  # the ReplSession
        self.assertEqual(len(rec.payloads), 1)
        self.assertNotIn("bye.", out)  # None: reader already printed it

    def test_old_zero_arg_reader_still_works(self):
        answers = iter(["hello", EOFError()])

        def reader():
            v = next(answers)
            if isinstance(v, BaseException):
                raise v
            return v
        out, rec, _ = self._run(reader)
        self.assertEqual(len(rec.payloads), 1)
        self.assertEqual(out.count("bye."), 1)

    def test_input_fallback_eof_and_ctrl_c_print_bye_once(self):
        for stop in (EOFError(), KeyboardInterrupt()):
            out, rec, _ = self._run(None, ["hello", stop])
            self.assertEqual(len(rec.payloads), 1)
            self.assertEqual(out.count("bye."), 1)

    def test_footer_printed_once_per_turn(self):
        answers = iter(["hello", None])
        with unittest.mock.patch.object(chat_mod, "print_footer") as footer:
            self._run(lambda c, s: next(answers))
        self.assertEqual(footer.call_count, 1)
        self.assertEqual(footer.call_args.args[0].last_turn["rounds"], 1)
