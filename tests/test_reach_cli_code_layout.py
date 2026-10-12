"""Readable reply code and whole-word wrapping across inline style changes."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))

from reach_cli import render, splash, terminal, themes  # noqa: E402


class CodeLayoutTests(unittest.TestCase):
    def setUp(self):
        self.theme = themes.current_key()
        themes.select_theme("default")
        self.addCleanup(themes.select_theme, self.theme)

    def lines(self, text, width=60, paint=False):
        stream = render.MarkdownStream(width)
        with mock.patch.object(terminal.PAINT, "on", paint):
            out = []
            for index in range(0, len(text), 3):
                out.extend(stream.feed(text[index:index + 3]))
            return out + stream.flush()

    def test_code_box_uses_available_width_and_language(self):
        for width in (1, 2, 5, 40, 61, 96):
            with self.subTest(width=width):
                lines = self.lines("```python\nprint(1)\n```\n", width)
                self.assertEqual(splash.display_width(lines[0]), width)
                self.assertEqual(splash.display_width(lines[-1]), width)
                self.assertTrue(all(splash.display_width(line) <= width for line in lines))
                if width >= 12:
                    self.assertIn("python", lines[0])

    def test_code_moves_path_token_to_next_row(self):
        lines = self.lines("```sh\ngrep needle studio/main.mjs | wc -l\n```", 24)
        body = lines[1:-1]
        self.assertNotIn("studi", body[0])
        self.assertTrue(any("studio/main.mjs" in line for line in body))
        self.assertTrue(body[1].startswith("│ ↳ "))
        self.assertTrue(all(splash.display_width(line) <= 24 for line in lines))

    def test_indented_code_and_spaces_are_preserved(self):
        source = "    return  process_items(values, allow_cached=True)"
        lines = self.lines("```python\n" + source + "\n```", 30)
        body = lines[1:-1]
        self.assertTrue(body[0].startswith("│     return  "))
        self.assertTrue(all(line.startswith("│ ↳     ") for line in body[1:]))
        rebuilt = body[0][2:] + "".join(line[8:] for line in body[1:])
        self.assertEqual(rebuilt, source)

    def test_tabs_expand_at_four_column_stops(self):
        lines = self.lines("```\n\tvalue\t=\t1\n```", 30)
        self.assertEqual(lines[1], "│     value   =   1")

    def test_quoted_code_text_moves_as_a_unit_when_it_fits(self):
        lines = self.lines('```python\nlog("hello there")\n```', 18)
        # A quoted string is kept together unless it exceeds the row budget.
        self.assertTrue(all(splash.display_width(line) <= 18 for line in lines))
        lines = self.lines('```python\nprint_name = "hello there"\n```', 21)
        self.assertIn('"hello there"', "\n".join(lines[1:-1]))

    def test_small_code_widths_and_wide_glyphs_fit(self):
        text = "```python\n    value = '你好世界'\n    verylongidentifierwithoutspaces\n```"
        for width in range(1, 33):
            with self.subTest(width=width):
                lines = self.lines(text, width, paint=True)
                self.assertTrue(all(splash.display_width(line) <= width for line in lines))
                self.assertLess(len(lines), 100)

    def test_highlighted_code_keeps_exact_visible_source(self):
        source = '    return "hello # world" + 12  # note'
        painted = self.lines("```python\n" + source + "\n```", 70, paint=True)
        self.assertEqual(splash.strip_ansi(painted[1]), "│ " + source)
        self.assertIn("\x1b[36mreturn", painted[1])
        self.assertIn('\x1b[32m"hello # world"', painted[1])
        self.assertIn("\x1b[35m12", painted[1])
        self.assertIn("\x1b[2m# note", painted[1])

    def test_unknown_language_is_verbatim(self):
        source = 'return "hello" + 12 # note'
        painted = self.lines("```custom\n" + source + "\n```", 70, paint=True)
        with mock.patch.object(terminal.PAINT, "on", True):
            self.assertEqual(painted[1], terminal.c_dim("│ ") + source)

    def test_unterminated_and_wrong_fence_remain_bounded(self):
        lines = self.lines("~~~python\nreturn 1\n```\n", 16)
        self.assertIn("│ ```", lines)
        self.assertTrue(lines[-1].startswith("└"))
        self.assertTrue(all(splash.display_width(line) <= 16 for line in lines))

    def test_plain_and_styled_fragments_do_not_split_a_word(self):
        with mock.patch.object(terminal.PAINT, "on", True):
            lines = render.wrap_inline("prefix **under**standing", 16)
        self.assertEqual(list(map(splash.strip_ansi, lines)), ["prefix", "understanding"])

    def test_inline_path_style_boundaries_stay_together(self):
        with mock.patch.object(terminal.PAINT, "on", True):
            lines = render.wrap_inline("read `studio/`main.mjs next", 20)
        self.assertEqual(list(map(splash.strip_ansi, lines)),
                         ["read studio/main.mjs", "next"])

    def test_long_styled_word_preserves_all_fragments(self):
        with mock.patch.object(terminal.PAINT, "on", True):
            lines = render.wrap_inline("**abc**`def`ghijk", 3)
        self.assertEqual("".join(map(splash.strip_ansi, lines)), "abcdefghijk")
        self.assertTrue(all(splash.display_width(line) <= 3 for line in lines))

    def test_inline_spaces_are_whole_word_wrap_points(self):
        self.assertEqual(render.wrap_inline("alpha  **beta** gamma", 10),
                         ["alpha beta", "gamma"])

    def test_source_mode_keeps_semantic_lines_for_resize(self):
        stream = render.MarkdownStream(width=5, source_mode=True)
        records = stream.feed("# Heading\n```sh\ngrep needle studio/main.mjs\n```\n")
        self.assertEqual([record.kind for record in records],
                         ["prose", "code_top", "code", "code_bottom"])
        self.assertEqual(records[2].text, "grep needle studio/main.mjs")
        self.assertEqual(records[2].language, "sh")
        self.assertEqual(records[0].plain(), "Heading")
        self.assertEqual(records[2].plain(), "│ grep needle studio/main.mjs")
        narrow = records[2].render(22)
        wide = records[2].render(60)
        self.assertGreater(len(narrow), 1)
        self.assertEqual(wide, ["│ grep needle studio/main.mjs"])
        self.assertEqual(splash.display_width(records[1].render(60)[0]), 60)
        self.assertEqual(splash.display_width(records[3].render(22)[0]), 22)

    def test_source_mode_closes_unterminated_fence_once(self):
        stream = render.MarkdownStream(source_mode=True)
        records = stream.feed("~~~python\nreturn 1") + stream.flush()
        self.assertEqual([record.kind for record in records],
                         ["code_top", "code", "code_bottom"])
        self.assertEqual(stream.flush(), [])
        self.assertTrue(records[-1].render(30)[0].startswith("└"))

    def test_source_records_preserve_matching_fence_rules(self):
        stream = render.MarkdownStream(source_mode=True)
        records = stream.feed("~~~py\n```\n~~~python\n~~~\n")
        self.assertEqual([record.kind for record in records],
                         ["code_top", "code", "code", "code_bottom"])
        self.assertEqual(records[1].render(20), ["│ ```"])

    def test_code_row_anchors_exclude_visual_continuations(self):
        source = "    " + " ".join("item%03d" % i for i in range(80))
        record = render.MarkdownSource(source, "code", "text")
        plain = record.plain()
        for width in (15, 37, 65, 120):
            with self.subTest(width=width):
                rows = record.render_rows(width)
                self.assertEqual([row for _, row in rows], record.render(width))
                self.assertEqual(rows[0][0], 0)
                offsets = [offset for offset, _ in rows]
                self.assertEqual(offsets, sorted(set(offsets)))
                self.assertTrue(all(offset < len(plain) for offset in offsets))
                for offset, row in rows[1:]:
                    self.assertTrue(row.startswith("│ ↳     "))
                    body = row[len("│ ↳     "):]
                    self.assertTrue(plain[offset:].startswith(body))

    def test_code_row_anchors_use_expanded_source_character_positions(self):
        source = "\talpha  你好 e\u0301 flags='🇨🇦' morewords"
        record = render.MarkdownSource(source, "code", "text")
        plain = record.plain()
        rows = record.render_rows(24)
        self.assertEqual([row for _, row in rows], record.render(24))
        for offset, row in rows[1:]:
            body = row[len("│ ↳     "):]
            self.assertTrue(plain[offset:].startswith(body), (offset, row, plain))

    def test_fence_rows_have_zero_source_anchor(self):
        for kind in ("code_top", "code_bottom"):
            record = render.MarkdownSource("```python", kind, "python")
            self.assertEqual(record.render_rows(40), [(0, record.render(40)[0])])
        self.assertEqual(render.MarkdownSource("", "code").render_rows(40),
                         [(0, "│ ")])


if __name__ == "__main__":
    unittest.main()
