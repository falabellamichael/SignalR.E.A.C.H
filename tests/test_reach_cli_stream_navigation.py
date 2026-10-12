"""Response-phase navigation, stable click targets and a scrollable thought view."""
import contextlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.reach_cli import footer, footer_input, splash, terminal
from tools.reach_cli.pets import TerminalPet
from tests.test_reach_cli_footer_screen import MutableTTY
from tests.test_reach_cli_hud import FixedTelemetry


class StreamNavigationTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(splash.set_layout, splash.layout_mode())
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

    def mark(self, target="thought"):
        box = next(box for box in self.screen._interaction_boxes if box[-1][0] == target)
        return box[0], box[1]

    def thought(self, count=70):
        self.parts = ["reason step %03d\n" % i for i in range(count)]
        self.screen.write("ai > o... ")
        self.screen.note_thought(self.parts, 5)
        self.screen.write("answer text\n")
        pointer = self.mark()
        self.screen.hover(pointer)
        return pointer

    def popup_pointer(self):
        box = self.screen._bubble_geometry
        return box["left"] + 2, box["row"] + 1

    def thought_text(self):
        return "\n".join(row[2] for row in self.screen._thought_layout["rows"])

    def test_wheel_scrolls_popup_without_moving_transcript_and_new_parts_keep_reading_position(self):
        self.thought()
        before = self.screen.snapshot()
        top = self.screen.thought_snapshot()["top"]
        self.screen.scroll_ui("up", 6, self.popup_pointer())
        reading = self.screen.thought_snapshot()
        self.assertEqual(reading["top"], top - 6)
        self.assertFalse(reading["following"])
        self.assertEqual(self.screen.snapshot()["scroll"]["anchor"], before["scroll"]["anchor"])
        self.parts.extend("new reason %03d\n" % i for i in range(30))
        self.screen.hover(self.popup_pointer())
        grown = self.screen.thought_snapshot()
        self.assertEqual(grown["top"], reading["top"])
        self.assertGreater(grown["total"], reading["total"])
        self.assertIn("new reason 029", self.thought_text())

    def test_click_pins_then_page_keys_scroll_and_close_button_dismisses(self):
        pointer = self.thought()
        top = self.screen.thought_snapshot()["top"]
        self.assertTrue(self.screen.click(pointer))
        self.assertTrue(self.screen.thought_snapshot()["pinned"])
        self.assertEqual(self.screen.thought_snapshot()["top"], top)
        self.screen.hover((0, 0))
        self.assertTrue(self.screen.thought_snapshot()["pinned"])
        self.screen.scroll_ui("page_up")
        self.assertLess(self.screen.thought_snapshot()["top"], top)
        self.screen.scroll_ui("live")
        self.assertEqual(self.screen.thought_snapshot()["top"], self.screen.thought_snapshot()["max_top"])
        self.assertTrue(self.screen.thought_snapshot()["following"])
        box = self.screen._bubble_geometry
        self.assertTrue(self.screen.click((box["left"]+box["width"]-2, box["row"])))
        self.assertIsNone(self.screen.thought_snapshot())
        self.assertFalse(self.screen._covered)

    def test_pointer_can_enter_popup_and_read_while_answer_continues(self):
        pointer = self.thought(5)
        self.screen.hover(self.popup_pointer())
        self.assertIsNotNone(self.screen.thought_snapshot())
        before = self.screen._bubble_geometry.copy()
        self.screen.write("new answer line\n" * 30)
        self.assertIsNotNone(self.screen.thought_snapshot())
        self.assertEqual(self.screen._bubble_geometry["row"], before["row"])
        self.assertIsNotNone(self.screen.capture_click(pointer))
        self.screen.hover((0, 0))
        self.assertIsNone(self.screen.thought_snapshot())

    def test_closing_pinned_mark_stays_closed_under_stationary_pointer(self):
        pointer = self.thought()
        self.assertTrue(self.screen.click(pointer))
        with patch.object(footer_input, "poll_ui_events", return_value=[("click", pointer)]), \
                patch.object(footer_input, "poll_pointer", return_value=pointer):
            self.screen._watch_tick()
        self.assertIsNone(self.screen.thought_snapshot())
        self.parts.append("reasoning continues\n")
        self.screen.write("answer continues\n")
        self.screen.hover(pointer)
        self.assertIsNone(self.screen.thought_snapshot())
        self.screen.hover((0, 0))
        self.screen.hover(pointer)
        self.assertIsNotNone(self.screen.thought_snapshot())

    def test_explicit_click_can_reopen_a_dismissed_mark_without_mouse_motion(self):
        pointer = self.thought()
        self.assertTrue(self.screen.click(pointer))
        self.assertTrue(self.screen.click(pointer))
        self.screen.hover(pointer)
        self.assertIsNone(self.screen.thought_snapshot())
        self.assertTrue(self.screen.click(pointer))
        self.assertTrue(self.screen.thought_snapshot()["pinned"])

    def test_hover_holds_a_short_transcript_tool_in_place_before_click(self):
        token = self.screen.begin_tool_call("  > read", ["args"])
        pointer = self.mark("tool")
        self.screen.hover(pointer)
        self.screen.write("fast incoming line\n" * 40)
        self.assertEqual(self.screen.capture_click(pointer), ("tool", token))
        self.assertTrue(self.screen.click(pointer))
        self.assertTrue(token.tool["expanded"])

    def test_open_tool_holds_its_painted_row_as_more_answer_lines_arrive(self):
        for history in (0, 90):
            with self.subTest(history=history):
                self.screen.write("history\n" * history)
                self.screen.return_live()
                token = self.screen.begin_tool_call("  > read", ["args"])
                pointer = next(box[:2] for box in self.screen._interaction_boxes
                               if box[-1] == ("tool", token))
                self.assertTrue(self.screen.click(pointer))
                painted = next(box[:2] for box in self.screen._interaction_boxes
                               if box[-1] == ("tool", token))
                self.screen.write("answer keeps streaming\n" * 45)
                self.assertEqual(self.screen.capture_click(painted), ("tool", token))
                self.assertTrue(self.screen.click(painted))
                self.assertFalse(token.tool["expanded"])

    def test_captured_click_opens_original_call_after_live_rows_move(self):
        token = self.screen.begin_tool_call("  > read", ["original arguments"])
        pointer = self.mark("tool")
        class Captured(tuple):
            pass
        captured = Captured(pointer)
        captured.target = self.screen.capture_click(pointer)
        self.screen.write("rapid answer lines\n" * 80)
        self.assertTrue(self.screen.click(captured))
        self.assertTrue(token.tool["expanded"])
        self.assertIn("original arguments", "\n".join(splash.strip_ansi(row) for row in self.screen._last_display))

    def test_centered_arrow_matches_rendered_cell_at_small_page_margins(self):
        splash.set_layout("center")
        for columns in (98, 100, 102, 180):
            with self.subTest(columns=columns):
                self.tty.resize(columns, 30)
                self.screen.refresh_header()
                token = self.screen.begin_tool_call("  > read", ["args"])
                box = next(box for box in self.screen._interaction_boxes
                           if box[-1] == ("tool", token))
                row = splash.strip_ansi(self.screen._last_display[box[1]])
                pointer = (row.index(">"), box[1])
                self.assertEqual(pointer[0], self.screen._geometry["footer_left"] + 2)
                self.assertEqual(self.screen.capture_click(pointer), ("tool", token))
                self.assertTrue(self.screen.click(pointer))
                self.assertTrue(token.tool["expanded"])

    def test_captured_miss_does_not_toggle_later_call_and_deleted_target_is_ignored(self):
        class Captured(tuple):
            pass
        token = self.screen.begin_tool_call("  > read", ["args"])
        miss = Captured(self.mark("tool"))
        miss.target = None
        self.assertFalse(self.screen.click(miss))
        self.assertFalse(token.tool["expanded"])
        stale = Captured(miss)
        stale.target = ("tool", token)
        self.screen.clear_banner_on_submit()
        self.assertFalse(self.screen.click(stale))

    def test_pinned_popup_keeps_independent_scroll_when_wheel_is_over_chat(self):
        self.screen.write("history\n" * 70)
        pointer = self.thought()
        self.screen.click(pointer)
        popup = self.screen.thought_snapshot()
        chat_before = self.screen.snapshot()["scroll"]["top"]
        self.screen.scroll_ui("up", 3, (0, 0))
        self.assertLess(self.screen.snapshot()["scroll"]["top"], chat_before)
        self.assertEqual(self.screen.thought_snapshot()["top"], popup["top"])
        self.assertTrue(self.screen.thought_snapshot()["pinned"])

    def test_ordered_ui_tick_services_navigation_before_recurring_header_failure(self):
        self.screen.write("history\n" * 90)
        before = self.screen.snapshot()["scroll"]["top"]
        with patch.object(footer_input, "poll_ui_events", return_value=[("scroll", ("page_up", 1, None))]), \
                patch.object(footer_input, "poll_pointer", return_value=None), \
                patch.object(self.screen._telemetry, "snapshot", side_effect=RuntimeError("probe failed")):
            self.screen._watch_tick()
        self.assertLess(self.screen.snapshot()["scroll"]["top"], before)
        self.assertIn("scroll", splash.strip_ansi(self.screen._last_display[self.screen._geometry["scroll_status_row"]]))

    def test_thought_scroll_pin_and_growth_preserve_draft_cursor_and_reserved_header(self):
        pointer = self.thought()
        self.screen.set_input("follow-up draft", 5, chunks=("saved chunk",))
        before = self.screen.snapshot()
        self.screen.click(pointer)
        self.screen.scroll_ui("up", 9, self.popup_pointer())
        self.parts.append("additional reasoning\n")
        self.screen.hover(None)
        after = self.screen.snapshot()
        for key in ("text", "cursor", "chunks", "geometry"):
            self.assertEqual(before[key], after[key], key)
        header = self.screen._geometry["header_region_rows"]
        self.assertTrue(all(row >= header for row in self.screen._covered))

    def test_popup_resize_bounds_and_anchor_are_preserved(self):
        pointer = self.thought()
        self.screen.click(pointer)
        self.screen.scroll_ui("page_up")
        anchor = self.screen._hover["anchor"]
        for columns in (18, 36, 80):
            self.tty.resize(columns, 30)
            self.screen.refresh_header()
            box = self.screen._bubble_geometry
            self.assertLessEqual(box["left"]+box["width"], columns)
            self.assertGreaterEqual(box["row"], self.screen._geometry["transcript_top"])
            self.assertLessEqual(box["row"]+box["height"], self.screen._geometry["scroll_status_row"])
            self.assertTrue(self.screen.thought_snapshot()["pinned"])
        self.assertEqual(self.screen._hover["anchor"], anchor)

    def test_hidden_pinned_popup_releases_page_keys_to_chat_on_small_resize(self):
        self.screen.write("history\n" * 90)
        pointer = self.thought()
        self.screen.click(pointer)
        for columns, rows in ((80, 11), (5, 30)):
            self.tty.resize(columns, rows)
            self.screen.refresh_header()
            self.assertIsNone(self.screen._bubble_geometry)
            before = self.screen.snapshot()["scroll"]["top"]
            thought_top = self.screen.thought_snapshot()["top"]
            self.screen.scroll_ui("page_up")
            self.assertLess(self.screen.snapshot()["scroll"]["top"], before)
            self.assertEqual(self.screen.thought_snapshot()["top"], thought_top)
            self.assertTrue(self.screen.thought_snapshot()["pinned"])
        self.tty.resize(80, 30)
        self.screen.refresh_header()
        self.assertIsNotNone(self.screen._bubble_geometry)

    def test_incremental_long_thought_does_not_remeasure_all_old_text(self):
        self.thought(1)
        self.parts.append("word " * 6000)
        self.screen.hover(self.popup_pointer())
        measure = footer._glyph_width
        with patch.object(footer, "_glyph_width", wraps=measure) as measured:
            self.parts.append("more words")
            self.screen.hover(self.popup_pointer())
        self.assertLess(measured.call_count, 1600)
        self.assertIn("more words", self.thought_text())


if __name__ == "__main__":
    unittest.main()
