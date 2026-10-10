"""Observable contracts for the pinned CLI footer and its transcript owner."""

import io
import os
import re
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))

from reach_cli import terminal, splash, footer  # noqa: E402
from reach_cli.footer import FooterScreen  # noqa: E402


_CSI = re.compile(r"\x1b\[[?0-9;]*[ -/]*[@-~]")
TL, TR, BL, BR = "\u250c", "\u2510", "\u2514", "\u2518"


def visible_text(output):
    """Remove terminal controls when checking text emitted by a redraw."""
    return _CSI.sub("", output).replace("\x1b7", "").replace("\x1b8", "")


def last_cursor(output):
    """Last absolute cursor placement in an input repaint (row, column)."""
    positions = re.findall(r"\x1b\[(\d+);(\d+)H", output)
    if not positions:
        raise AssertionError("input repaint did not position the cursor")
    return tuple(map(int, positions[-1]))


def frame_rows(output):
    """Visible rows in the final full redraw, keyed by one-based screen row."""
    frame = output.rsplit("\x1b[?25l\x1b[H", 1)[-1]
    return {
        int(row): splash.strip_ansi(text)
        for row, text in re.findall(r"\x1b\[(\d+);1H(.*?)\x1b\[K", frame, re.S)
    }


def windows_native_width(text):
    """Cell widths observed in the native Windows console for these glyphs."""
    return sum(1 if ch in ("\u0301", "\u200d", "\ufe0f") else splash.char_width(ch)
               for ch in text)


class MutableTTY(io.StringIO):
    def __init__(self, columns=80, rows=24):
        super().__init__()
        self.columns = columns
        self.rows = rows
        self.flushes = 0

    def isatty(self):
        return True

    def fileno(self):
        return 91

    def get_size(self):
        return os.terminal_size((self.columns, self.rows))

    def resize(self, columns, rows):
        self.columns, self.rows = columns, rows

    def flush(self):
        self.flushes += 1
        return super().flush()


class FooterScreenTests(unittest.TestCase):
    def setUp(self):
        self.old_layout = splash.layout_mode()
        self.old_paint = terminal.PAINT
        splash.set_layout("full")
        terminal.PAINT = terminal.Paint(False)
        self.addCleanup(splash.set_layout, self.old_layout)
        self.addCleanup(setattr, terminal, "PAINT", self.old_paint)
        self.tty = MutableTTY()
        self.client = SimpleNamespace(
            model="test-model", base="http://127.0.0.1:20777/v1",
            agent=False, workpath="", session_totals={}, last_turn=None,
        )

    def screen(self):
        screen = FooterScreen(self.client, self.tty, size=self.tty.get_size)
        self.addCleanup(screen.close)
        return screen

    def test_footer_imports_in_a_fresh_python_process(self):
        root = os.path.dirname(os.path.dirname(__file__))
        result = subprocess.run(
            [sys.executable, "-B", "-c",
             "import sys; sys.path.insert(0, 'tools'); from reach_cli import footer"],
            cwd=root, capture_output=True, text=True, timeout=10, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_posix_bracketed_paste_toggle_leaves_geometry_unchanged(self):
        def start_and_close(platform_name):
            tty = MutableTTY(columns=40, rows=12)
            with patch.object(footer.os, "name", platform_name):
                screen = FooterScreen(self.client, tty, size=tty.get_size)
                try:
                    self.assertTrue(screen.start())
                    geometry = screen.snapshot()["geometry"]
                    at_start = tty.getvalue()
                finally:
                    screen.close()
                return at_start, tty.getvalue()[len(at_start):], geometry

        posix_start, posix_close, posix_geometry = start_and_close("posix")
        windows_start, windows_close, windows_geometry = start_and_close("nt")
        self.assertEqual(posix_geometry, windows_geometry)
        self.assertEqual(posix_geometry["footer_top"], 9)
        self.assertIn("\x1b[?2004h", posix_start)
        self.assertIn("\x1b[?2004l", posix_close)
        self.assertNotIn("\x1b[?2004l", posix_start)
        self.assertNotIn("\x1b[?2004h", posix_close)
        self.assertNotIn("\x1b[?2004h", windows_start + windows_close)
        self.assertNotIn("\x1b[?2004l", windows_start + windows_close)

    def test_pinned_box_stays_below_streaming_transcript(self):
        screen = self.screen()
        screen.start()
        opened = frame_rows(self.tty.getvalue())
        self.assertEqual(len(opened), 24)
        self.assertIn(TL, opened[22])
        self.assertIn(TR, opened[22])
        self.assertIn("\u2502", opened[23])
        self.assertIn(BL, opened[24])
        self.assertIn(BR, opened[24])

        before = len(self.tty.getvalue())
        screen.write("answer-one ")
        screen.write("answer-two\n")
        screen.flush()
        self.assertNotIn("\x1b[2J", self.tty.getvalue()[before:])
        shown = frame_rows(self.tty.getvalue())
        self.assertIn("answer-one answer-two", "\n".join(shown.values()))
        self.assertIn(TL, shown[22])
        self.assertIn(BL, shown[24])
        self.assertEqual((self.tty.columns, self.tty.rows), (80, 24))
        self.assertGreater(self.tty.flushes, 0)

    def test_stream_fragments_and_footer_geometry_survive_mid_reply_resize(self):
        screen = self.screen()
        screen.start()
        screen.write("fragment-one-")
        self.tty.resize(40, 12)
        before = len(self.tty.getvalue())
        screen.write("fragment-two")
        self.assertNotIn("\x1b[2J", self.tty.getvalue()[before:])
        narrow = frame_rows(self.tty.getvalue())
        self.assertIn("fragment-one-fragment-two", "\n".join(narrow.values()))
        self.assertIn(TL, narrow[10])
        self.assertIn(BL, narrow[12])

        self.tty.resize(100, 30)
        before = len(self.tty.getvalue())
        screen.write("-complete\n")
        self.assertNotIn("\x1b[2J", self.tty.getvalue()[before:])
        wide = frame_rows(self.tty.getvalue())
        self.assertIn("fragment-one-fragment-two-complete", "\n".join(wide.values()))
        self.assertIn(TL, wide[28])
        self.assertIn(BL, wide[30])

    def test_center_margin_tracks_width_for_transcript_and_footer(self):
        splash.set_layout("center")
        self.tty.resize(200, 24)
        screen = self.screen()
        screen.start()
        screen.write("centered-reply\n")
        wide = frame_rows(self.tty.getvalue())
        answer = next(line for line in wide.values() if "centered-reply" in line)
        self.assertTrue(answer.startswith(" " * 52))
        self.assertTrue(wide[22].startswith(" " * 52 + TL))
        self.assertEqual(splash.display_width(wide[22]), 52 + 96)

        self.tty.resize(60, 24)
        screen.flush()
        narrow = frame_rows(self.tty.getvalue())
        answer = next(line for line in narrow.values() if "centered-reply" in line)
        self.assertTrue(answer.startswith("centered-reply"))
        self.assertTrue(narrow[22].startswith(TL))
        self.assertEqual(splash.display_width(narrow[22]), 59)

    def test_narrow_footer_keeps_all_square_corners_with_session_stats(self):
        self.tty.resize(18, 6)
        self.client.session_totals = {
            "turns": 3, "tokens": 9800, "rounds": 5, "latency": 4.2,
        }
        screen = self.screen()
        screen.start()
        screen.set_input("draft", cursor=5)
        rows = frame_rows(self.tty.getvalue())
        self.assertTrue(rows[4].startswith(TL))
        self.assertTrue(rows[4].endswith(TR))
        self.assertTrue(rows[6].startswith(BL))
        self.assertTrue(rows[6].endswith(BR))
        for row in rows.values():
            self.assertLessEqual(splash.display_width(row), 17)

    def test_repeated_resizes_replay_transcript_and_keep_draft(self):
        self.tty.resize(100, 30)
        screen = self.screen()
        screen.start()
        screen.write("anchor-first\nanchor-second\n")
        screen.set_input("draft \u6f22\u5b57 e\u0301 \U0001f642", cursor=13)

        for columns, rows in ((40, 12), (18, 6), (150, 40), (40, 12), (100, 30)):
            with self.subTest(columns=columns, rows=rows):
                before = len(self.tty.getvalue())
                self.tty.resize(columns, rows)
                screen.set_input("draft \u6f22\u5b57 e\u0301 \U0001f642", cursor=13)
                screen.flush()
                redraw = self.tty.getvalue()[before:]
                self.assertNotIn("\x1b[2J", redraw)
                shown = frame_rows(redraw)
                self.assertEqual(len(shown), rows)
                self.assertIn("draft", "\n".join(shown.values()))
                self.assertIn(TL, "\n".join(shown.values()))
                self.assertIn(BL, shown[rows])
                if rows >= 12:
                    self.assertIn("anchor-second", "\n".join(shown.values()))
                row, col = last_cursor(redraw)
                self.assertGreaterEqual(row, rows - 2)
                self.assertLessEqual(row, rows - 1)
                self.assertGreaterEqual(col, 1)
                self.assertLessEqual(col, columns)

        final = "\n".join(frame_rows(self.tty.getvalue()).values())
        self.assertIn("anchor-first", final)
        self.assertIn("anchor-second", final)
        self.assertIn("\u6f22\u5b57", final)
        self.assertIn("\U0001f642", final)

    def test_cursor_uses_display_cells_for_wide_and_combining_text(self):
        screen = self.screen()
        screen.start()
        draft = "\u6f22e\u0301\U0001f642"
        positions = []
        for cursor in range(len(draft) + 1):
            before = len(self.tty.getvalue())
            screen.set_input(draft, cursor=cursor)
            positions.append(last_cursor(self.tty.getvalue()[before:]))
        self.assertEqual({row for row, _ in positions}, {23})
        columns = [col for _, col in positions]
        self.assertEqual([right - left for left, right in zip(columns, columns[1:])],
                         [2, 1, 0, 2])

    def test_control_character_in_draft_is_visible_and_moves_cursor_two_cells(self):
        screen = self.screen()
        screen.start()
        draft = "x\x1b[2Jy"

        before = len(self.tty.getvalue())
        screen.set_input(draft, cursor=1)
        row_before, column_before = last_cursor(self.tty.getvalue()[before:])

        before = len(self.tty.getvalue())
        screen.set_input(draft, cursor=2)  # immediately after the literal ESC
        output = self.tty.getvalue()[before:]
        row_after, column_after = last_cursor(output)
        self.assertEqual(row_after, row_before)
        self.assertEqual(column_after - column_before, 2)

        shown = "\n".join(frame_rows(output).values())
        self.assertIn("x^[[2Jy", shown)
        self.assertNotIn("\x1b[2J", output)

    def test_combining_draft_is_nfc_on_screen_but_logical_text_is_unchanged(self):
        screen = self.screen()
        screen.start()
        draft = "e\u0301"

        before = len(self.tty.getvalue())
        screen.set_input(draft, cursor=0)
        row_before, column_before = last_cursor(self.tty.getvalue()[before:])

        before = len(self.tty.getvalue())
        screen.set_input(draft, cursor=2)
        output = self.tty.getvalue()[before:]
        row_after, column_after = last_cursor(output)
        body = frame_rows(output)[23]
        self.assertIn("\u00e9", body)
        self.assertNotIn("\u0301", body)
        self.assertEqual(row_after, row_before)
        self.assertEqual(column_after - column_before, 1)

        snapshot = screen.snapshot()
        self.assertEqual(snapshot["text"], draft)
        self.assertEqual(snapshot["cursor"], 2)
        self.assertEqual(snapshot["geometry"]["cursor_row"], row_after - 1)
        self.assertEqual(snapshot["geometry"]["cursor_column"], column_after - 1)

    def test_windows_native_width_projection_keeps_cursor_and_border_aligned(self):
        selector = patch.object(footer, "_WINDOWS_NATIVE_WIDTH", True)
        selector.start()
        self.addCleanup(selector.stop)
        self.tty.resize(40, 12)
        screen = self.screen()
        screen.start()

        cases = (
            ("residual acute", "q\u0301", 2),
            ("standalone acute", "\u0301", 1),
            ("woman ZWJ laptop", "\U0001f469\u200d\U0001f4bb", 5),
            ("heart VS16", "\u2764\ufe0f", 2),
        )
        for name, text, cells in cases:
            with self.subTest(sequence=name):
                before = len(self.tty.getvalue())
                screen.set_input(text, cursor=0)
                row_before, col_before = last_cursor(self.tty.getvalue()[before:])
                before = len(self.tty.getvalue())
                screen.set_input(text, cursor=len(text))
                row_after, col_after = last_cursor(self.tty.getvalue()[before:])
                self.assertEqual(row_after, row_before)
                self.assertEqual(col_after - col_before, cells)
                snapshot = screen.snapshot()
                self.assertEqual(snapshot["text"], text)
                self.assertEqual(snapshot["cursor"], len(text))

        mixed = "q\u0301|\u0301|\U0001f469\u200d\U0001f4bb|\u2764\ufe0f|end"
        for columns in (18, 40):
            with self.subTest(columns=columns):
                self.tty.resize(columns, 12)
                screen.set_input(mixed, cursor=len(mixed))
                rows = frame_rows(self.tty.getvalue())
                body = [line for line in rows.values()
                        if line.startswith("\u2502") and line.endswith("\u2502")]
                self.assertTrue(body)
                for line in body:
                    self.assertEqual(windows_native_width(line), columns - 1)
                snapshot = screen.snapshot()
                self.assertEqual(snapshot["text"], mixed)
                self.assertEqual(snapshot["cursor"], len(mixed))

    def test_continuation_grows_footer_then_submission_resets_it(self):
        screen = self.screen()
        screen.start()
        before = len(self.tty.getvalue())
        screen.set_input("second", cursor=3, chunks=("first",))
        expanded = self.tty.getvalue()[before:]
        expanded_rows = frame_rows(expanded)
        self.assertIn(TL, expanded_rows[21])
        self.assertIn("first", "\n".join(expanded_rows.values()))
        self.assertIn("second", "\n".join(expanded_rows.values()))
        screen.finish_input("first\nsecond", echo=True)
        screen.reset_input()
        submitted = frame_rows(self.tty.getvalue())
        self.assertIn(TL, submitted[22])
        self.assertIn(BL, submitted[24])
        self.assertIn("first", "\n".join(submitted.values()))
        self.assertIn("second", "\n".join(submitted.values()))

    def test_carriage_return_and_erase_line_do_not_resurrect_stale_text(self):
        screen = self.screen()
        screen.start()
        screen.write("status-with-a-long-tail\rready\x1b[")
        screen.write("K\nspinner-before-erase\r\x1b[2")
        screen.write("Kcomplete\n")
        screen.flush()

        before = len(self.tty.getvalue())
        self.tty.resize(120, 30)
        screen.set_input("", cursor=0)
        screen.flush()
        redraw = "\n".join(frame_rows(self.tty.getvalue()[before:]).values())
        self.assertIn("ready", redraw)
        self.assertIn("complete", redraw)
        self.assertNotIn("status-with-a-long-tail", redraw)
        self.assertNotIn("spinner-before-erase", redraw)

    def test_split_csi_style_is_parsed_and_replayed_without_literal_escape(self):
        screen = self.screen()
        screen.start()
        screen.write("\x1b[")
        screen.write("31mRED")
        screen.write("\x1b[0m")
        frame = self.tty.getvalue().rsplit("\x1b[?25l\x1b[H", 1)[-1]
        self.assertIn("\x1b[31mRED\x1b[0m", frame)
        self.assertEqual("\n".join(frame_rows(self.tty.getvalue()).values()).count("RED"), 1)

        before = len(self.tty.getvalue())
        self.tty.resize(100, 30)
        screen.flush()
        redraw = self.tty.getvalue()[before:]
        self.assertIn("\x1b[31mRED\x1b[0m", redraw)
        self.assertNotIn("\x1b[2J", redraw)

    def test_startup_banner_is_cleared_once_without_erasing_later_turns(self):
        screen = self.screen()
        screen.start()
        screen.write("startup-only-banner\n")
        screen.clear_banner_on_submit()
        first_clear = self.tty.getvalue()
        screen.finish_input("hello", echo=True)
        screen.write("reply-after-banner\n")
        before_second = len(self.tty.getvalue())
        screen.clear_banner_on_submit()
        second_clear = self.tty.getvalue()[before_second:]
        self.assertNotIn("startup-only-banner", visible_text(second_clear))
        self.assertNotIn("\x1b[2J", second_clear)
        self.assertTrue(first_clear)

        before_resize = len(self.tty.getvalue())
        self.tty.resize(90, 26)
        screen.set_input("", cursor=0)
        redraw = "\n".join(frame_rows(self.tty.getvalue()[before_resize:]).values())
        self.assertIn("reply-after-banner", redraw)
        self.assertNotIn("startup-only-banner", redraw)

    def test_non_echo_input_keeps_startup_banner_until_first_visible_submit(self):
        screen = self.screen()
        screen.start()
        screen.write("startup-banner-marker\n")
        screen.finish_input("quiet setup", echo=False)
        self.assertIn("startup-banner-marker",
                      "\n".join(frame_rows(self.tty.getvalue()).values()))

        self.tty.resize(90, 26)
        screen.flush()
        self.assertIn("startup-banner-marker",
                      "\n".join(frame_rows(self.tty.getvalue()).values()))

        screen.finish_input("visible question", echo=True)
        shown = "\n".join(frame_rows(self.tty.getvalue()).values())
        self.assertNotIn("startup-banner-marker", shown)
        self.assertIn("visible question", shown)

    def test_file_like_tty_proxy_keeps_one_output_owner(self):
        screen = self.screen()
        original_stdout = sys.stdout
        self.assertTrue(screen.isatty())
        self.assertEqual(screen.fileno(), self.tty.fileno())
        screen.start()
        self.assertNotIn("\x1b[?7l", self.tty.getvalue())
        self.assertNotIn("\x1b[?7h", self.tty.getvalue())
        screen.write("owned-output\n")
        screen.flush()
        self.assertIs(sys.stdout, original_stdout)
        self.assertIn("owned-output", visible_text(self.tty.getvalue()))
        screen.close()
        restored = self.tty.getvalue()
        self.assertIn("\x1b[?1049l", restored)
        self.assertNotIn("\x1b[?7l", restored)
        self.assertNotIn("\x1b[?7h", restored)
        screen.close()
        self.assertEqual(self.tty.getvalue(), restored)


if __name__ == "__main__":
    unittest.main()
