"""Words remain readable when ordinary CLI transcript text reaches an edge."""

import copy
import os
import sys
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import footer, splash, terminal  # noqa: E402
from reach_cli.pets import TerminalPet  # noqa: E402
from tests.test_reach_cli_footer_screen import MutableTTY  # noqa: E402
from tests.test_reach_cli_hud import FixedTelemetry  # noqa: E402


class TranscriptWordWrapTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(splash.set_layout, splash.layout_mode())
        splash.set_layout("full")
        self.stack.enter_context(mock.patch.object(
            terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(
            footer, "SystemTelemetry", FixedTelemetry))
        self.stack.enter_context(mock.patch.object(
            footer, "client_meta", return_value=("fixture", "local", "chat")))
        self.tty = MutableTTY(columns=21, rows=30)
        client = SimpleNamespace(
            model="fixture", base="local", agent=False, workpath="",
            session_totals={}, last_turn=None, pet="cat", pet_motion=False)
        self.screen = footer.FooterScreen(client, self.tty, size=self.tty.get_size)
        self.screen.pet = TerminalPet(clock=lambda: 0, motion=False)
        self.screen._active = True
        self.screen._draw()
        self.addCleanup(self.screen.close)

    def rows(self):
        return [splash.strip_ansi(text) for _, _, text in self.screen._visual_rows]

    def assert_whole_word(self, word):
        matching = [row for row in self.rows() if word in row]
        self.assertEqual(len(matching), 1,
                         "word should appear intact on one row: %r" % self.rows())

    def assert_rows_fit(self):
        width = self.screen.snapshot()["geometry"]["footer_width"]
        margin = self.screen.snapshot()["geometry"]["footer_left"]
        self.assertTrue(all(footer._glyph_width(row) <= width + margin
                            for row in self.rows()), self.rows())

    def visible_pointer(self, needle):
        screen = self.screen
        index, row = next((index, splash.strip_ansi(text))
                          for index, (_, _, text) in enumerate(screen._visual_rows)
                          if needle in splash.strip_ansi(text))
        state, geometry = screen._scroll_state, screen._geometry
        shown = min(state["visible_rows"], state["total_rows"] - state["top"])
        y = (geometry["transcript_top"] + state.get("padding", state["visible_rows"] - shown) +
             index - state["top"])
        x = footer._glyph_width(row[:row.index(needle)])
        return x, y

    def test_paragraph_moves_documentation_to_the_next_row(self):
        text = "Read the documentation carefully before continuing."
        self.screen.write(text + "\n")
        for word in text.split():
            self.assert_whole_word(word)
        self.assertEqual(" ".join(" ".join(self.rows()).split()), text)
        self.assert_rows_fit()

    def test_agent_completion_keeps_ordinary_words_intact(self):
        text = "agent complete: Summarized the documentation successfully."
        self.screen.write("\x1b[33m" + text + "\x1b[0m\n")
        for word in text.split():
            self.assert_whole_word(word)
        self.assert_rows_fit()

    def test_word_with_a_style_change_stays_together_and_keeps_color(self):
        self.screen.write("Read doc\x1b[31mument\x1b[0mation carefully.\n")
        self.assert_whole_word("documentation")
        styled = next(text for _, _, text in self.screen._visual_rows
                      if "documentation" in splash.strip_ansi(text))
        self.assertIn("\x1b[31mument", styled)
        self.assertEqual(" ".join(" ".join(self.rows()).split()),
                         "Read documentation carefully.")
        self.assert_rows_fit()

    def test_wide_unicode_and_composed_words_use_terminal_cells(self):
        for word in ("漢字word", "🇨🇦word", "création"):
            with self.subTest(word=word):
                self.tty.resize(10, 30)
                self.screen.clear_banner_on_submit()
                self.screen.write("Read " + word + " now.\n")
                self.assert_whole_word(word)
                self.assert_rows_fit()
                # Reset the logical transcript for an independent example.
                self.screen._banner_cleared = False

    def test_word_wider_than_the_entire_row_remains_complete(self):
        text = "Read " + "x" * 55 + " now."
        self.screen.write(text + "\n")
        self.assertEqual("".join("".join(self.rows()).split()),
                         "".join(text.split()))
        self.assert_whole_word("Read")
        self.assert_whole_word("now.")
        self.assert_rows_fit()

    def test_expanded_tool_details_wrap_words_beneath_the_call(self):
        token = self.screen.begin_tool_call(
            "  > read", ["Read the documentation carefully."])
        self.assertNotIn("documentation", "\n".join(self.rows()))
        self.assertTrue(self.screen.click(self.visible_pointer("> read")))
        self.assert_whole_word("documentation")
        self.assert_whole_word("carefully.")
        self.assertTrue(token.tool["expanded"])
        self.assert_rows_fit()

    def test_echoed_prompt_keeps_words_and_the_user_gutter(self):
        self.screen.finish_input("Read documentation carefully.")
        self.assert_whole_word("documentation")
        self.assert_whole_word("carefully.")
        self.assertTrue(any(row.startswith("you ▸ ") for row in self.rows()))
        self.assertTrue(next(row for row in self.rows()
                             if "documentation" in row).startswith("      "))
        self.assert_rows_fit()

    def test_streamed_word_moves_intact_when_the_last_fragment_arrives(self):
        for piece in ("Read the doc", "ument", "ation ", "care", "fully."):
            self.screen.write(piece)
            incremental = copy.deepcopy(self.screen._visual_rows)
            self.screen._visual_key = None
            self.screen._draw()
            self.assertEqual(incremental, self.screen._visual_rows,
                             "incremental and fresh reflow differ after %r" % piece)
            self.assert_rows_fit()
        self.assert_whole_word("documentation")
        self.assert_whole_word("carefully.")
        self.assertEqual(self.screen.snapshot()["transcript"],
                         "Read the documentation carefully.")

    def test_browsing_word_wrapped_history_survives_resize_and_incoming_text(self):
        self.screen.write("\n".join(
            "paragraph%02d documentation carefully finishes." % index
            for index in range(30)) + "\n")
        self.screen.set_input("keep this draft", 5)
        self.screen.scroll_lines(28)
        before = self.screen.snapshot()
        top = before["scroll"]["top"]
        first = self.screen._visual_rows[top][2]
        self.assertFalse(before["scroll"]["following"])
        self.screen.write("incoming documentation finishes.\n")
        self.tty.resize(41, 30)
        self.screen.flush()
        self.assertFalse(self.screen.snapshot()["scroll"]["following"])
        self.tty.resize(21, 30)
        self.screen.flush()
        restored = self.screen.snapshot()
        self.assertEqual(restored["scroll"]["anchor"], before["scroll"]["anchor"])
        self.assertEqual(self.screen._visual_rows[restored["scroll"]["top"]][2], first)
        self.assertEqual((restored["text"], restored["cursor"]), ("keep this draft", 5))
        self.assert_rows_fit()

    def test_thought_hover_follows_a_mark_that_moves_to_the_next_row(self):
        parts = ["files checked"]
        self.screen.write("Read documentation o... ")
        self.screen.note_thought(parts, 5)
        self.screen.write("answer\n")
        self.screen.set_input("draft remains", 4)
        self.assert_whole_word("o...")
        for columns in (21, 31, 21):
            with self.subTest(columns=columns):
                self.tty.resize(columns, 30)
                self.screen.flush()
                pointer = self.visible_pointer("o...")
                hit = self.screen._thought_at(*pointer)
                self.assertIsNotNone(hit)
                self.assertIs(hit[0]["parts"], parts)
                before = len(self.tty.getvalue())
                self.screen.hover(pointer)
                self.assertIsNotNone(self.screen._hover)
                # The screen keeps its base-row cache separate from the
                # thought overlay so hiding it restores the transcript.
                self.assertIn("files checked", splash.strip_ansi(
                    self.tty.getvalue()[before:]))
                self.screen.hover(None)
                self.assertEqual((self.screen.snapshot()["text"],
                                  self.screen.snapshot()["cursor"]),
                                 ("draft remains", 4))


if __name__ == "__main__":
    unittest.main()
