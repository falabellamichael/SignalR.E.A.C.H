"""The pet HUD owns a reserved screen region and paints independently of chat."""

import copy
import os
import re
import sys
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import terminal, splash, footer  # noqa: E402
from reach_cli.pets import TerminalPet  # noqa: E402
from tests.test_reach_cli_hud import FixedTelemetry, MutableTTY, frame_rows  # noqa: E402


class HeaderIsolationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.old_layout = splash.layout_mode()
        self.addCleanup(splash.set_layout, self.old_layout)
        splash.set_layout("full")
        self.stack.enter_context(mock.patch.object(
            terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(
            footer, "client_meta", return_value=("fixture", "local", "chat")))
        self.client = SimpleNamespace(
            model="fixture", base="local", agent=False, workpath="",
            session_totals={}, last_turn=None, pet="cat", pet_motion=True)
        self.clock = [0.0]
        self.tty = MutableTTY(columns=80, rows=24)

    def screen(self):
        with mock.patch.object(footer, "SystemTelemetry", FixedTelemetry):
            screen = footer.FooterScreen(self.client, self.tty, size=self.tty.get_size)
        screen.pet = TerminalPet(clock=lambda: self.clock[0])
        # Drive the screen directly so no watcher or live telemetry can race a
        # deterministic frame assertion.
        screen._active = True
        screen._draw()
        self.addCleanup(screen.close)
        return screen

    def assert_header_frame(self, output, header_rows):
        self.assertTrue(output.startswith("\x1b7"), repr(output))
        self.assertTrue(output.endswith("\x1b8"), repr(output))
        self.assertNotIn("\x1b[?25l", output)
        self.assertNotIn("\x1b[?25h", output)
        self.assertNotIn("\x1b[H", output)
        positions = [tuple(map(int, position)) for position in
                     re.findall(r"\x1b\[(\d+);(\d+)H", output)]
        self.assertTrue(positions)
        self.assertTrue(all(1 <= row <= header_rows and column == 1
                            for row, column in positions), positions)
        for text in frame_rows(output).values():
            self.assertLessEqual(footer._glyph_width(text), self.tty.columns)

    def protected_chat_render(self, screen):
        stack = ExitStack()
        for name in ("_visual_transcript", "_footer", "_hover_overlay", "_draw"):
            stack.enter_context(mock.patch.object(
                screen, name, side_effect=AssertionError(
                    "header repaint invoked chat renderer: " + name)))
        return stack

    def add_thought(self, screen, text="Fixture thought body"):
        parts = [text]
        screen.write("ai > o... ")
        screen.note_thought(parts, 5)
        screen.write("fixture answer\n")
        return parts

    def thought_pointer(self, screen):
        state = screen.snapshot()
        geometry, scroll = state["geometry"], state["scroll"]
        visible = scroll["visible_rows"]
        shown = min(visible, max(0, scroll["total_rows"] - scroll["top"]))
        return (geometry["footer_left"] + 6,
                geometry["transcript_top"] + visible - shown)

    def test_pet_tick_skips_chat_layout_and_open_overlay_and_preserves_state(self):
        screen = self.screen()
        self.add_thought(screen)
        screen.write("".join("history %d\n" % index for index in range(60)))
        screen.set_input("draft stays here", cursor=7)
        screen.scroll_lines(1000)
        screen.hover(self.thought_pointer(screen))
        self.assertFalse(screen.snapshot()["scroll"]["following"])
        self.assertTrue(screen._covered)
        screen.set_pet_activity("waiting")
        before = screen.snapshot()
        cached = list(screen._last_display)
        covered, hovered = set(screen._covered), copy.deepcopy(screen._hover)
        output_start = len(self.tty.getvalue())
        self.clock[0] = 3.0
        with self.protected_chat_render(screen):
            screen.refresh_header()
        output = self.tty.getvalue()[output_start:]
        after = screen.snapshot()
        self.assert_header_frame(output, before["geometry"]["header_rows"])
        for key in ("text", "cursor", "chunks", "transcript", "geometry", "scroll", "active"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(screen._covered, covered)
        self.assertEqual(screen._hover, hovered)
        header_rows = before["geometry"]["header_rows"]
        self.assertEqual(screen._last_display[header_rows:], cached[header_rows:])
        self.assertNotEqual(screen._last_display[:header_rows], cached[:header_rows])
        self.assertNotIn("Fixture thought body", output)
        self.assertNotIn("draft stays here", output)

    def test_telemetry_selection_motion_and_activity_use_the_isolated_path(self):
        screen = self.screen()
        screen.set_input("keep this draft", cursor=4)
        before = screen.snapshot()
        operations = (
            lambda: screen._telemetry.value.update(cpu_pct=91.0) or screen.refresh_header(),
            lambda: screen.select_pet("owl"),
            lambda: screen.set_pet_motion(False),
            lambda: screen.set_pet_motion(True),
            lambda: screen.set_pet_activity("thinking"),
            lambda: screen.set_pet_activity("responding"),
            lambda: screen.set_pet_activity("searching"),
            lambda: screen.set_pet_activity("reading"),
            lambda: screen.set_pet_activity("writing"),
            lambda: screen.set_pet_activity("running"),
            lambda: screen.set_pet_activity("checking"),
            lambda: screen.set_pet_activity("blocked"),
            lambda: screen.set_pet_activity("complete"),
        )
        for index, operation in enumerate(operations):
            with self.subTest(operation=index):
                output_start = len(self.tty.getvalue())
                with self.protected_chat_render(screen):
                    operation()
                self.assert_header_frame(
                    self.tty.getvalue()[output_start:], before["geometry"]["header_rows"])
                state = screen.snapshot()
                for key in ("text", "cursor", "chunks", "transcript", "geometry", "scroll"):
                    self.assertEqual(state[key], before[key], key)

    def test_long_draft_keeps_the_reserved_header_and_a_visible_editor_cursor(self):
        screen = self.screen()
        original = screen.snapshot()["geometry"]
        self.assertEqual(original["header_rows"], 5)
        self.assertEqual(original["header_gap"], 1)
        self.assertEqual(original["header_region_rows"], 6)
        draft = "wrapped fixture " * 300
        for cursor in (0, len(draft) // 2, len(draft)):
            with self.subTest(cursor=cursor):
                screen.set_input(draft, cursor)
                state = screen.snapshot()
                geometry = state["geometry"]
                self.assertEqual(state["text"], draft)
                self.assertEqual(state["cursor"], cursor)
                for key in ("header_rows", "header_gap", "header_region_rows", "transcript_top"):
                    self.assertEqual(geometry[key], original[key], key)
                self.assertGreaterEqual(geometry["transcript_rows"], 1)
                self.assertLessEqual(geometry["footer_rows"], 17)
                self.assertGreaterEqual(geometry["cursor_row"], geometry["footer_top"])
                self.assertLess(geometry["cursor_row"], self.tty.rows)
                self.assertGreaterEqual(geometry["cursor_column"], 0)
                self.assertLess(geometry["cursor_column"], self.tty.columns)
        screen.set_input("", 0)
        cleared = screen.snapshot()["geometry"]
        for key in ("header_rows", "header_gap", "header_region_rows", "transcript_top"):
            self.assertEqual(cleared[key], original[key], key)
        self.assertEqual(cleared["footer_rows"], 3)
        self.assertEqual(screen._last_display[5], "")

    def test_tiny_terminals_keep_header_spacer_editor_and_cursor_in_bounds(self):
        screen = self.screen()
        for columns in (1, 2, 18, 40, 80):
            for rows in range(1, 10):
                with self.subTest(columns=columns, rows=rows):
                    self.tty.resize(columns, rows)
                    screen.set_input("short", 3)
                    short = screen.snapshot()["geometry"]
                    screen.set_input("x" * 200, 190)
                    geometry = screen.snapshot()["geometry"]
                    for key in ("header_rows", "header_gap", "header_region_rows", "transcript_top"):
                        self.assertEqual(geometry[key], short[key], key)
                    self.assertLessEqual(geometry["header_rows"], 5)
                    self.assertIn(geometry["header_gap"], (0, 1))
                    self.assertEqual(geometry["header_region_rows"],
                                     geometry["header_rows"] + geometry["header_gap"])
                    self.assertEqual(geometry["transcript_top"], geometry["header_region_rows"])
                    self.assertEqual(geometry["footer_top"] + geometry["footer_rows"], rows)
                    self.assertGreaterEqual(geometry["footer_top"], geometry["header_region_rows"])
                    self.assertGreaterEqual(geometry["cursor_row"], geometry["footer_top"])
                    self.assertLess(geometry["cursor_row"], rows)
                    self.assertGreaterEqual(geometry["cursor_column"], 0)
                    self.assertLess(geometry["cursor_column"], columns)
                    self.assertEqual(len(screen._last_display), rows)
                    for text in screen._last_display:
                        self.assertLessEqual(footer._glyph_width(splash.strip_ansi(text)), columns)

    def test_header_frames_fit_each_species_at_narrow_and_wide_widths(self):
        screen = self.screen()
        for columns in (18, 24, 40, 80, 120, 200):
            self.tty.resize(columns, 24)
            screen._draw()
            for kind in ("cat", "owl", "bulldog"):
                with self.subTest(columns=columns, kind=kind):
                    screen.select_pet(kind)
                    screen.set_pet_activity("waiting")
                    self.clock[0] += 3.0
                    output_start = len(self.tty.getvalue())
                    with self.protected_chat_render(screen):
                        screen.refresh_header()
                    output = self.tty.getvalue()[output_start:]
                    # At compact widths several clock ticks may map to the
                    # same face. A cached frame should then emit no bytes.
                    if output:
                        self.assert_header_frame(
                            output, screen.snapshot()["geometry"]["header_rows"])
                    for text in screen._last_display:
                        self.assertLessEqual(footer._glyph_width(
                            splash.strip_ansi(text)), columns)

    def test_header_gap_preserves_chat_room_in_small_windows(self):
        screen = self.screen()
        for rows, gap in ((12, 0), (13, 1), (24, 1)):
            with self.subTest(rows=rows):
                self.tty.resize(80, rows)
                screen.set_input("", 0)
                geometry = screen.snapshot()["geometry"]
                self.assertEqual(geometry["header_rows"], 5)
                self.assertEqual(geometry["header_gap"], gap)
                self.assertEqual(geometry["transcript_top"], 5 + gap)
                self.assertGreaterEqual(geometry["transcript_rows"], 4)
                if gap:
                    self.assertEqual(screen._last_display[5], "")

    def test_resize_refresh_reframes_once_then_returns_to_header_only_frames(self):
        screen = self.screen()
        screen.write("fixture transcript\n")
        screen.set_input("resize draft " * 80, cursor=70)
        screen.set_pet_activity("waiting")
        before = screen.snapshot()
        self.tty.resize(120, 30)
        with mock.patch.object(screen, "_draw", wraps=screen._draw) as draw:
            screen.refresh_header()
        self.assertEqual(draw.call_count, 1)
        resized = screen.snapshot()
        for key in ("text", "cursor", "chunks", "transcript"):
            self.assertEqual(resized[key], before[key], key)
        self.assertEqual(resized["geometry"]["columns"], 120)
        self.assertEqual(resized["geometry"]["rows"], 30)
        output_start = len(self.tty.getvalue())
        self.clock[0] = 3.0
        with self.protected_chat_render(screen):
            screen.refresh_header()
        self.assert_header_frame(self.tty.getvalue()[output_start:],
                                 resized["geometry"]["header_rows"])
        self.assertEqual(screen.snapshot()["geometry"], resized["geometry"])

    def test_stationary_hover_updates_only_when_thought_fragments_change(self):
        screen = self.screen()
        parts = self.add_thought(screen, "first fixture thought")
        pointer = self.thought_pointer(screen)
        screen.hover(pointer)
        self.assertTrue(screen._covered)
        with mock.patch.object(screen, "_draw", wraps=screen._draw) as draw:
            screen.hover(pointer)
        draw.assert_not_called()
        parts.append(" plus newly arrived reasoning")
        output_start = len(self.tty.getvalue())
        with mock.patch.object(screen, "_draw", wraps=screen._draw) as draw:
            screen.hover(pointer)
        draw.assert_called_once()
        self.assertIn("newly arrived reasoning", self.tty.getvalue()[output_start:])
        self.assertEqual(screen._pointer, pointer)
        self.assertIs(screen._hover["parts"], parts)


if __name__ == "__main__":
    unittest.main()
