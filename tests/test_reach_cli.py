"""Offline unit tests for the SimpleREACH CLI (parser + grounding)."""
import json
import os
import re
import sys
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

        def fake_chat(messages, stream=True):
            seen.append([m.get("content") for m in messages if m.get("role") == "user"])
            yield "ok"

        client.chat = fake_chat
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

        def failing_then_ok(messages, stream=True):
            calls["n"] += 1
            seen.append([m.get("content") for m in messages if m.get("role") == "user"])
            if calls["n"] == 1:
                raise ReachApiError("nope")
            yield "recovered"

        client.chat = failing_then_ok
        answers = iter(["hello", "/retry", "/exit"])
        with unittest.mock.patch("builtins.input", side_effect=lambda _prompt="": next(answers)), self.redirect_stdout(self.io.StringIO()):
            run_chat(client, client.base)
        self.assertEqual(seen, [["hello"], ["hello"]])

        def refuse_send(_messages, stream=True):
            raise AssertionError("slash commands must not be sent as prompts")

        client.chat = refuse_send
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
