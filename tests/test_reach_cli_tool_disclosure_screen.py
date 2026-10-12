"""Inline tool disclosures use the transcript's cell and scroll geometry."""
import copy
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.reach_cli import footer, splash, terminal
from tools.reach_cli.pets import TerminalPet
from tests.test_reach_cli_footer_screen import MutableTTY
from tests.test_reach_cli_hud import FixedTelemetry


class ToolDisclosureScreenTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        old_layout = splash.layout_mode()
        self.addCleanup(splash.set_layout, old_layout)
        splash.set_layout("full")
        self.stack.enter_context(patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(patch.object(footer, "SystemTelemetry", FixedTelemetry))
        self.tty = MutableTTY(80, 30)
        client = SimpleNamespace(model="fixture", base="local", workpath="", agent=False,
                                 session_totals={}, last_turn=None)
        self.screen = footer.FooterScreen(client, self.tty, size=self.tty.get_size)
        self.screen.pet = TerminalPet(clock=lambda: 0)
        self.screen._active = True
        self.screen._draw()
        self.addCleanup(self.screen.close)

    def shown(self):
        return "\n".join(splash.strip_ansi(row) for row in self.screen._last_display)

    def pointer(self, token):
        screen = self.screen
        index = next(i for i, (line, offset, _text) in enumerate(screen._visual_rows)
                     if screen._lines[line] is token and offset == 0)
        state, geometry = screen._scroll_state, screen._geometry
        shown = min(state["visible_rows"], state["total_rows"] - state["top"])
        row = geometry["transcript_top"] + state.get("padding", state["visible_rows"] - shown) + index - state["top"]
        column = geometry["footer_left"] + token.tool["arrow"]
        return column, row

    def test_collapsed_args_and_results_expand_beneath_the_call_then_collapse(self):
        token = self.screen.begin_tool_call("  > read  path=fixture.txt", ["arguments:", "fixture arguments"])
        self.assertIn("> read", self.shown())
        self.assertNotIn("fixture arguments", self.shown())
        self.assertTrue(self.screen.finish_tool_call(token, ["result:", "fixture output"]))
        self.assertNotIn("fixture output", self.shown())
        self.assertTrue(self.screen.click(self.pointer(token)))
        self.assertIn("v read", self.shown())
        self.assertIn("fixture arguments", self.shown())
        self.assertIn("fixture output", self.shown())
        self.assertTrue(self.screen.click(self.pointer(token)))
        self.assertIn("> read", self.shown())
        self.assertNotIn("fixture arguments", self.shown())
        self.assertNotIn("fixture output", self.shown())

    def test_each_call_owns_its_results_and_disclosure_state(self):
        first = self.screen.begin_tool_call("  > read", ["first args"])
        second = self.screen.begin_tool_call("  > list", ["second args"])
        self.screen.finish_tool_call(second, ["second output"])
        self.screen.finish_tool_call(first, ["first output"])
        self.screen.click(self.pointer(first))
        self.assertIn("first output", self.shown())
        self.assertNotIn("second output", self.shown())
        self.assertFalse(second.tool["expanded"])
        self.screen.click(self.pointer(second))
        self.assertIn("second output", self.shown())
        self.assertTrue(first.tool["expanded"])

    def test_running_call_receives_results_without_collapsing_open_details(self):
        token = self.screen.begin_tool_call("  > shell", ["command args"])
        self.screen.click(self.pointer(token))
        self.screen.write("other live output\n")
        self.screen.finish_tool_call(token, ["completed output"])
        self.assertTrue(token.tool["expanded"])
        self.assertIn("completed output", self.shown())
        # Opening the call holds its painted viewport; incoming answer rows
        # stay in history and are visible when the reader returns live.
        self.assertIn("other live output", "\n".join(splash.strip_ansi(row[2])
                                                   for row in self.screen._visual_rows))
        self.screen.return_live()
        self.assertIn("other live output", self.shown())

    def test_click_preserves_draft_cursor_chunks_and_reserved_header(self):
        token = self.screen.begin_tool_call("  > read", ["read details"])
        self.screen.set_input("draft with words", 6, chunks=("saved chunk",))
        before = self.screen.snapshot()
        header = self.screen._last_display[:before["geometry"]["header_region_rows"]]
        self.screen.click(self.pointer(token))
        after = self.screen.snapshot()
        for key in ("text", "cursor", "chunks", "geometry"):
            self.assertEqual(before[key], after[key], key)
        self.assertEqual(header, self.screen._last_display[:len(header)])

    def test_long_results_stay_scrollable_and_click_target_survives_resize(self):
        self.screen.write("before history\n" * 30)
        token = self.screen.begin_tool_call("  > read", ["result line %d" % i for i in range(100)])
        self.screen.write("after history\n" * 30)
        self.screen._follow_tail = False
        self.screen._scroll_anchor = (token.tool["index"], 0)
        self.screen._draw()
        self.screen.click(self.pointer(token))
        self.assertIn("result line 0", self.shown())
        self.assertFalse(self.screen.snapshot()["scroll"]["following"])
        self.screen.scroll_lines(-10)
        self.assertIn("result line 10", self.shown())
        self.tty.resize(42, 22)
        self.screen.refresh_header()
        self.assertTrue(token.tool["expanded"])
        self.assertIn("result line 10", self.shown())
        self.screen._scroll_anchor = (token.tool["index"], 0)
        self.screen._draw()
        self.assertTrue(self.screen.click(self.pointer(token)))
        self.assertNotIn("result line", self.shown())

    def test_centered_layout_and_wide_text_keep_hit_tests_and_rows_in_bounds(self):
        splash.set_layout("center")
        self.tty.resize(180, 30)
        self.screen.refresh_header()
        token = self.screen.begin_tool_call("  > read", ["漢字 e\u0301 " * 55])
        self.assertGreater(self.screen._geometry["footer_left"], 0)
        self.assertTrue(self.screen.click(self.pointer(token)))
        self.assertTrue(all(footer._glyph_width(splash.strip_ansi(row)) <= 180
                            for row in self.screen._last_display))

    def test_non_tool_cells_and_detail_rows_do_not_toggle(self):
        self.screen.write("ordinary text\n")
        token = self.screen.begin_tool_call("  > read", ["details"])
        column, row = self.pointer(token)
        for pointer in ((0, 0), (0, self.screen._geometry["footer_top"]),
                        (column - 1, row), (79, row)):
            self.assertFalse(self.screen.click(pointer))
        self.screen.click((column, row))
        column, row = self.pointer(token)
        self.assertFalse(self.screen.click((column + 2, row + 1)))
        self.assertTrue(token.tool["expanded"])

    def test_cleared_banner_invalidates_old_tokens(self):
        token = self.screen.begin_tool_call("  > read", ["old args"])
        self.screen.clear_banner_on_submit()
        self.assertFalse(self.screen.finish_tool_call(token, ["stale output"]))
        fresh = self.screen.begin_tool_call("  > list", ["new args"])
        self.screen.click(self.pointer(fresh))
        self.assertNotIn("stale output", self.shown())

    def test_detail_control_sequences_render_as_text_not_cursor_commands(self):
        token = self.screen.begin_tool_call("  > read", ["unsafe \x1b[2J\x1b]0;title\x07", "\x1b[31mred\x1b[0m"])
        self.screen.click(self.pointer(token))
        self.assertIn("^[[2J", self.shown())
        self.assertNotIn("\x1b[2J", self.tty.getvalue())
        self.assertIn("red", self.shown())

    def test_header_animation_skips_chat_even_with_tool_open(self):
        token = self.screen.begin_tool_call("  > read", ["open details"])
        self.screen.click(self.pointer(token))
        before = copy.deepcopy(self.screen.snapshot())
        shown = self.shown()
        with patch.object(self.screen, "_draw", side_effect=AssertionError("chat repaint")), \
                patch.object(self.screen, "_visual_transcript", side_effect=AssertionError("chat reflow")):
            self.screen.set_pet_activity("responding")
        self.assertEqual(before, self.screen.snapshot())
        self.assertIn("open details", self.shown())
        self.assertTrue(token.tool["expanded"])


if __name__ == "__main__":
    unittest.main()
