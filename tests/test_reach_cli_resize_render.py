"""Regression tests for reply rendering when terminal width changes."""

import os
import sys
import unittest
from unittest import mock


sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))

from reach_cli import render, splash, terminal, themes  # noqa: E402


class NarrowTerminalTests(unittest.TestCase):
    def setUp(self):
        self.layout = splash.layout_mode()
        splash.set_layout("center")

    def tearDown(self):
        splash.set_layout(self.layout)

    def test_small_real_terminal_width_is_used_throughout_chrome(self):
        with mock.patch("shutil.get_terminal_size", return_value=os.terminal_size((12, 24))), \
                mock.patch.object(splash, "session_facts", return_value=(("model", "Sol ultra"),)):
            self.assertEqual(splash.terminal_columns(), 12)
            self.assertEqual(splash.content_width(), 11)
            self.assertEqual(splash.content_margin(), 0)
            self.assertEqual(render.text_width(), 2)
            self.assertTrue(all(splash.display_width(line) <= 11
                                for line in splash.render_banner_lines(None, "", "chat")))
            self.assertLessEqual(splash.display_width(splash.render_footer(None, columns=11)), 11)
            self.assertLessEqual(splash.display_width(splash.plain_header(None, "", "chat")), 12)

    def test_even_one_column_does_not_expand_to_default_width(self):
        with mock.patch("shutil.get_terminal_size", return_value=os.terminal_size((1, 24))), \
                mock.patch.object(splash, "session_facts", return_value=()):
            self.assertEqual(splash.terminal_columns(), 1)
            self.assertEqual(splash.content_width(), 1)
            self.assertTrue(all(splash.display_width(line) <= 1
                                for line in splash.render_banner_lines(None, "", "chat")))


class ReplyWidthTests(unittest.TestCase):
    def setUp(self):
        self.old_theme = themes.current_key()
        self.old_managed_screen = terminal.PAINT.managed_screen
        themes.select_theme("default")
        terminal.PAINT.managed_screen = False
        self.addCleanup(themes.select_theme, self.old_theme)
        self.addCleanup(setattr, terminal.PAINT, "managed_screen",
                        self.old_managed_screen)

    def test_live_stream_remeasures_each_source_line(self):
        stream = render.MarkdownStream()
        with mock.patch.object(render, "text_width", side_effect=(15, 5, 4)):
            first = stream.feed("one two three four\n")
            second = stream.feed("abcdefghijklmnop\n")
            tail = stream.feed("# \u4f60\u597d\u4e16\u754c\n")
        self.assertTrue(all(splash.display_width(line) <= 15 for line in first))
        self.assertTrue(all(splash.display_width(line) <= 5 for line in second))
        self.assertTrue(all(splash.display_width(line) <= 4 for line in tail))
        self.assertGreater(max(map(splash.display_width, first)), 5)

    def test_explicit_width_stays_fixed(self):
        stream = render.MarkdownStream(width=8)
        with mock.patch.object(render, "text_width", return_value=2):
            lines = stream.feed("1234567\n1234567\n")
        self.assertEqual(lines, ["1234567", "1234567"])

    def test_inline_styles_wide_glyphs_and_long_tokens_fit(self):
        with mock.patch.object(terminal.PAINT, "on", True):
            lines = render.wrap_inline("**\u4f60\u597d\u4e16\u754c** `123456789012345`", 6)
        self.assertTrue(all(splash.display_width(line) <= 6 for line in lines))
        self.assertTrue(any("\x1b[1m" in line for line in lines))
        self.assertTrue(any("\x1b[36m" in line for line in lines))
        self.assertEqual("".join(splash.strip_ansi(line).replace(" ", "") for line in lines),
                         "\u4f60\u597d\u4e16\u754c123456789012345")

    def test_hanging_prefixes_and_code_blocks_fit(self):
        stream = render.MarkdownStream(width=5)
        lines = stream.feed(
            "- abcdefghijklmn\n12. abcdefghijklmn\n> abcdefghijklmn\n"
            "```verylonglanguage\n    abcdefghijklmn\n```\n") + stream.flush()
        self.assertTrue(all(splash.display_width(line) <= 5 for line in lines))
        self.assertGreater(len(lines), 10)


if __name__ == "__main__":
    unittest.main()
