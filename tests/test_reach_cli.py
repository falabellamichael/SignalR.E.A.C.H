"""Offline unit tests for the SimpleREACH CLI (parser + grounding)."""
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


def time_placeholder_ok(system_prompt):
    """The system prompt embeds today's date; assert it rendered."""
    return re.search(r"\d{4}-\d{2}-\d{2}", system_prompt) is not None


if __name__ == "__main__":
    unittest.main(verbosity=2)
