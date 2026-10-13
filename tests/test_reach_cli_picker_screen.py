"""Keyboard menus remain separate from the retained chat and composer."""

import os
import re
import sys
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import footer, splash, terminal  # noqa: E402
from tests.test_reach_cli_hud import FixedTelemetry, MutableTTY  # noqa: E402


def menu_rows(output, geometry):
    """Read the final physical writes inside this menu's overlay rectangle."""
    rows = {}
    for row, left, text in re.findall(
            r"\x1b\[(\d+);(\d+)H(.*?)(?=\x1b\[(?:\d+;\d+H|\?25[hl])|$)",
            output, re.S):
        row, left = int(row) - 1, int(left) - 1
        if (text and geometry["row"] <= row < geometry["row"] + geometry["height"] and
                left == geometry["left"]):
            rows[row] = splash.strip_ansi(text)
    return rows


class PickerScreenTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.old_layout = splash.layout_mode()
        self.addCleanup(splash.set_layout, self.old_layout)
        splash.set_layout("full")
        self.stack.enter_context(mock.patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(
            footer, "client_meta", return_value=("fixture", "local", "chat")))
        self.client = SimpleNamespace(
            model="fixture", base="local", agent=False, workpath="",
            session_totals={}, last_turn=None, pet="cat", pet_motion=False)
        self.tty = MutableTTY(columns=80, rows=24)
        with mock.patch.object(footer, "SystemTelemetry", FixedTelemetry):
            self.screen = footer.FooterScreen(self.client, self.tty, size=self.tty.get_size)
        # No background watcher is needed to drive a deterministic frame.
        self.screen._active = True
        self.screen._draw()
        self.addCleanup(self.screen.close)
        self.choices = tuple(("endpoint%d" % index, "Endpoint %d" % index,
                              "http://fixture%d.example/v1" % index)
                             for index in range(30))

    def paint_menu(self, selected=0, choices=None):
        start = len(self.tty.getvalue())
        self.screen.set_menu("Select endpoint", choices or self.choices,
                             selected=selected, current="endpoint2")
        output = self.tty.getvalue()[start:]
        geometry = self.screen.snapshot()["menu_geometry"]
        return output, geometry, menu_rows(output, geometry)

    def test_menu_navigation_and_clear_preserve_chat_draft_cursor_and_scroll(self):
        self.screen.write("".join("history %d\n" % index for index in range(70)))
        self.screen.set_input("unsent draft stays", 7, chunks=("earlier line",))
        self.screen.scroll_lines(12)
        before = self.screen.snapshot()
        for selected in (0, 2, 17, 29):
            output, geometry, rows = self.paint_menu(selected)
            self.assertIn("Endpoint %d" % selected, "\n".join(rows.values()))
            self.assertTrue(geometry["start"] <= selected < geometry["end"])
            self.assertNotIn("\x1b[?25h", output)
            after = self.screen.snapshot()
            for key in ("text", "cursor", "chunks", "transcript", "scroll", "geometry"):
                self.assertEqual(after[key], before[key], key)
            self.assertEqual(after["menu"]["selected"], selected)
        start = len(self.tty.getvalue())
        self.screen.clear_menu()
        after = self.screen.snapshot()
        for key in ("text", "cursor", "chunks", "transcript", "scroll", "geometry"):
            self.assertEqual(after[key], before[key], key)
        self.assertIsNone(after["menu"])
        self.assertIsNone(after["menu_geometry"])
        self.assertIn("\x1b[?25h", self.tty.getvalue()[start:])
        self.assertFalse(self.screen._covered)

    def test_selected_current_marker_detail_and_bounded_page_are_visible(self):
        _output, geometry, rows = self.paint_menu(2)
        text = "\n".join(rows.values())
        self.assertIn("> Endpoint 2 (current)", text)
        self.assertIn("http://fixture2.example/v1", text)
        self.assertIn("Enter select", text)
        self.assertIn("Esc cancel", text)
        self.assertLessEqual(geometry["end"] - geometry["start"], 10)
        self.assertNotIn("Endpoint 29", text)

    def test_small_and_resized_terminals_keep_selected_entry_and_cells_in_bounds(self):
        choices = tuple((str(index), "Z" if index == 17 else "Other", "漢字" * 80)
                        for index in range(30))
        for columns in (1, 2, 4, 8, 18, 40, 80):
            for height in (1, 2, 3, 4, 6, 8, 12, 24):
                with self.subTest(columns=columns, height=height):
                    self.tty.resize(columns, height)
                    self.screen.set_input("long draft " * 30, 71)
                    _output, geometry, rows = self.paint_menu(17, choices)
                    self.assertIn("Z", "\n".join(rows.values()))
                    self.assertGreaterEqual(geometry["row"], 0)
                    self.assertLessEqual(geometry["row"] + geometry["height"], height)
                    self.assertLessEqual(geometry["left"] + geometry["width"], columns)
                    self.assertEqual(len(rows), geometry["height"])
                    for text in rows.values():
                        self.assertLessEqual(footer._glyph_width(text), geometry["width"])
        self.assertEqual(self.screen.snapshot()["cursor"], 71)

    def test_menu_suppresses_thoughts_stale_clicks_and_background_scroll(self):
        parts = ["private fixture thought"]
        self.screen.write("ai > o... ")
        self.screen.note_thought(parts, 5)
        self.screen.write("fixture answer\n")
        state = self.screen.snapshot()
        geometry, scroll = state["geometry"], state["scroll"]
        shown = min(scroll["visible_rows"], max(0, scroll["total_rows"] - scroll["top"]))
        pointer = (geometry["footer_left"] + 6,
                   geometry["transcript_top"] + scroll["visible_rows"] - shown)
        self.screen.hover(pointer)
        self.assertIsNotNone(self.screen.thought_snapshot())
        target = self.screen.capture_click(pointer)
        before = self.screen.snapshot()
        with mock.patch.object(self.screen, "_hover_overlay",
                               side_effect=AssertionError("thought painted behind menu")):
            output, _geometry, _rows = self.paint_menu(2)
            self.screen.hover(pointer)
            self.assertFalse(self.screen.click(SimpleNamespace(target=target)))
            self.screen.scroll_ui("up", 4, pointer)
            self.screen.scroll_lines(4)
            self.screen.scroll_pages(1)
            self.screen.scroll("down", 4)
            self.screen.return_live()
        self.assertEqual(self.screen.snapshot()["scroll"], before["scroll"])
        self.assertIsNone(self.screen.capture_click(pointer))
        self.assertEqual(self.screen._interaction_boxes, ())
        self.assertNotIn("private fixture thought", output)
        self.screen.clear_menu()
        self.assertIsNotNone(self.screen.thought_snapshot())
        self.assertTrue(self.screen._interaction_boxes)

    def test_menu_data_controls_are_visible_text_and_never_terminal_commands(self):
        output, geometry, rows = self.paint_menu(
            choices=(("safe", "Safe\x1b[2J label", "URL\r\nnext\x07"),))
        text = "\n".join(rows.values())
        self.assertIn("Safe^[[2J label", text)
        self.assertIn("URL^M↵next^G", text)
        self.assertNotIn("\x1b[2J", output)
        self.assertTrue(all(footer._glyph_width(line) <= geometry["width"]
                            for line in rows.values()))


if __name__ == "__main__":
    unittest.main()
