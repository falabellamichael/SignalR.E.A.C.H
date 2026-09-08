"""Offline unit tests for the SimpleREACH CLI (parser + grounding)."""
import json
import os
import re
import sys
import unittest

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
            self.assertIn("goodbye world", handle.read())
            self.assertNotIn("hello world", handle.read())

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
