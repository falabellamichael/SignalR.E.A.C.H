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
    """Replay row patches following the latest full redraw."""
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

    def test_transcript_scroll_lines_pages_and_return_live(self):
        self.tty.resize(40, 12)
        screen = self.screen()
        screen.start()
        screen.write("".join("history-%02d\n" % index for index in range(50)))
        live = screen.snapshot()["scroll"]
        self.assertTrue(
            {"following", "top", "max_top", "total_rows", "visible_rows"}
            <= set(live))
        self.assertEqual(len(live["anchor"]), 2)
        self.assertTrue(all(isinstance(value, int) and value >= 0
                            for value in live["anchor"]))
        self.assertTrue(live["following"])
        self.assertEqual(live["top"], live["max_top"])
        self.assertGreater(live["total_rows"], live["visible_rows"])
        self.assertIn("history-49", "\n".join(frame_rows(self.tty.getvalue()).values()))

        screen.scroll_lines(4)  # positive means older output
        up = screen.snapshot()["scroll"]
        self.assertFalse(up["following"])
        self.assertLess(up["top"], up["max_top"])
        self.assertLess(up["top"], live["top"])
        scrolled_rows = frame_rows(self.tty.getvalue())
        self.assertIn("scroll", "\n".join(scrolled_rows.values()).lower())
        self.assertNotIn("history-49", "\n".join(scrolled_rows.values()))

        screen.scroll_lines(-1)  # negative moves toward the live tail
        one_down = screen.snapshot()["scroll"]
        self.assertGreater(one_down["top"], up["top"])
        screen.scroll_pages(1)
        page_up = screen.snapshot()["scroll"]
        self.assertLess(page_up["top"], one_down["top"])
        screen.scroll_pages(-1)
        page_down = screen.snapshot()["scroll"]
        self.assertGreater(page_down["top"], page_up["top"])

        screen.return_live()
        returned = screen.snapshot()["scroll"]
        self.assertTrue(returned["following"])
        self.assertEqual(returned["top"], returned["max_top"])
        self.assertIn("history-49", "\n".join(frame_rows(self.tty.getvalue()).values()))

    def test_scrolled_view_keeps_anchor_draft_and_footer_during_output_and_resize(self):
        self.tty.resize(40, 12)
        screen = self.screen()
        screen.start()
        screen.write("".join("line-%02d\n" % index for index in range(45)))
        draft = "draft \u6f22\u5b57"
        screen.set_input(draft, cursor=7)
        screen.scroll_lines(8)
        initial = screen.snapshot()
        self.assertFalse(initial["scroll"]["following"])
        transcript_row = initial["geometry"]["transcript_top"] + 1
        anchor = frame_rows(self.tty.getvalue())[transcript_row]
        self.assertIn("line-", anchor)

        screen.write("line-45\n")
        streamed = screen.snapshot()
        self.assertFalse(streamed["scroll"]["following"])
        self.assertEqual(streamed["scroll"]["top"], initial["scroll"]["top"])
        self.assertGreater(streamed["scroll"]["total_rows"],
                           initial["scroll"]["total_rows"])
        self.assertEqual(frame_rows(self.tty.getvalue())[transcript_row], anchor)
        self.assertEqual((streamed["text"], streamed["cursor"]), (draft, 7))

        self.tty.resize(60, 14)
        screen.flush()
        resized = screen.snapshot()
        rows = frame_rows(self.tty.getvalue())
        self.assertFalse(resized["scroll"]["following"])
        transcript_row = resized["geometry"]["transcript_top"] + 1
        self.assertEqual(rows[transcript_row], anchor)
        self.assertEqual((resized["text"], resized["cursor"]), (draft, 7))
        self.assertIn("scroll", "\n".join(rows.values()).lower())
        top = resized["geometry"]["footer_top"] + 1
        self.assertTrue(rows[top].startswith(TL))
        self.assertTrue(rows[top].endswith(TR))
        self.assertIn("test-model", rows[top])
        self.assertTrue(rows[14].startswith(BL))
        self.assertTrue(rows[14].endswith(BR))
        self.assertIn("draft", "\n".join(rows.values()))
        cursor_row, cursor_column = last_cursor(self.tty.getvalue())
        self.assertEqual(cursor_row, resized["geometry"]["cursor_row"] + 1)
        self.assertEqual(cursor_column, resized["geometry"]["cursor_column"] + 1)

        screen.return_live()
        self.assertIn("line-45", "\n".join(frame_rows(self.tty.getvalue()).values()))

    def test_visible_submit_exits_scrollback_before_next_reply_streams(self):
        self.tty.resize(40, 12)
        screen = self.screen()
        screen.start()
        screen.finish_input("first question", echo=True)
        screen.write("".join("old-reply-%02d\n" % index for index in range(35)))
        screen.scroll_lines(8)
        self.assertFalse(screen.snapshot()["scroll"]["following"])

        screen.set_input("new question", cursor=len("new question"))
        screen.finish_input("new question", echo=True)
        submitted = screen.snapshot()
        self.assertTrue(submitted["scroll"]["following"])
        self.assertEqual(submitted["scroll"]["top"], submitted["scroll"]["max_top"])
        self.assertEqual((submitted["text"], submitted["cursor"]), ("", 0))
        screen.write("fresh-reply-marker\n")
        shown = "\n".join(frame_rows(self.tty.getvalue()).values())
        self.assertIn("new question", shown)
        self.assertIn("fresh-reply-marker", shown)
        self.assertTrue(screen.snapshot()["scroll"]["following"])

    def test_wrapped_line_anchor_round_trips_narrow_wide_narrow(self):
        self.tty.resize(18, 8)
        screen = self.screen()
        screen.start()
        long_line = "".join("%02d-" % index for index in range(40))
        screen.write("before\n" + long_line + "\nafter\n")
        screen.scroll_lines(3)
        narrow = screen.snapshot()
        self.assertFalse(narrow["scroll"]["following"])
        anchor = narrow["scroll"]["anchor"]
        self.assertGreater(anchor[1], 0, "the first row must be inside the wrapped line")
        transcript_row = narrow["geometry"]["transcript_top"] + 1
        first_row = frame_rows(self.tty.getvalue())[transcript_row]
        self.assertIn("-", first_row)

        self.tty.resize(60, 8)
        screen.flush()
        wide = screen.snapshot()
        self.assertFalse(wide["scroll"]["following"])
        self.assertEqual(wide["scroll"]["anchor"][0], anchor[0])
        self.assertEqual(wide["transcript"], narrow["transcript"])

        self.tty.resize(18, 8)
        screen.flush()
        restored = screen.snapshot()
        self.assertFalse(restored["scroll"]["following"])
        self.assertEqual(restored["scroll"]["anchor"], anchor)
        transcript_row = restored["geometry"]["transcript_top"] + 1
        self.assertEqual(frame_rows(self.tty.getvalue())[transcript_row], first_row)
        self.assertEqual(restored["transcript"], narrow["transcript"])

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

    def test_scrolling_large_history_does_not_rewrap_unchanged_lines(self):
        screen = self.screen()
        screen.start()
        screen.write("".join("history-%05d normal text \u6f22\u5b57\n" % index
                             for index in range(3000)))
        glyph_width = footer._glyph_width
        with patch.object(footer, "_glyph_width", wraps=glyph_width) as measure:
            screen.scroll_lines(8)
            self.assertLess(measure.call_count, 1500)
        self.assertEqual(screen.snapshot()["scroll"]["total_rows"], 3001)
        self.assertFalse(screen.snapshot()["scroll"]["following"])

    def test_streaming_long_partial_line_reflows_only_its_changed_tail(self):
        screen = self.screen()
        screen.start()
        screen.write("x" * 25000)
        glyph_width = footer._glyph_width
        with patch.object(footer, "_glyph_width", wraps=glyph_width) as measure:
            screen.write("e\u0301\u6f22")
            self.assertLess(measure.call_count, 1500)
        incremental = list(screen._visual_rows)
        screen._visual_key = None  # independent complete reflow of final cells
        screen._draw()
        self.assertEqual(screen._visual_rows, incremental)
        self.assertTrue(screen.snapshot()["transcript"].endswith("e\u0301\u6f22"))

    def test_streaming_while_scrolled_updates_status_without_repainting_history(self):
        screen = self.screen()
        screen.start()
        screen.write("".join("history-%03d\n" % index for index in range(100)))
        screen.set_input("keep this \u6f22\u5b57 draft", 5)
        screen.scroll_lines(50)
        before_state = screen.snapshot()
        before = len(self.tty.getvalue())
        screen.write("new streamed line\n")
        output = self.tty.getvalue()[before:]
        changed = frame_rows(output)
        self.assertNotIn("\x1b[?25l\x1b[H", output)
        self.assertEqual(set(changed), {
            before_state["geometry"]["scroll_status_row"] + 1})
        after = screen.snapshot()
        self.assertEqual(after["scroll"]["anchor"], before_state["scroll"]["anchor"])
        self.assertEqual((after["text"], after["cursor"]),
                         (before_state["text"], before_state["cursor"]))
        self.assertEqual(last_cursor(output),
                         (after["geometry"]["cursor_row"] + 1,
                          after["geometry"]["cursor_column"] + 1))

    def test_navigation_burst_preserves_event_order_and_draws_once(self):
        def ready_screen():
            tty = MutableTTY(columns=40, rows=12)
            screen = FooterScreen(self.client, tty, size=tty.get_size)
            self.addCleanup(screen.close)
            screen.start()
            screen.write("".join("row-%03d\n" % index for index in range(150)))
            screen.set_input("draft \u6f22\u5b57", 7)
            return screen

        events = ([('up', 1)] * 32 + [('down', 1)] * 8 +
                  [('page_up', 2), ('live', 1), ('up', 7),
                   ('page_down', 1), ('up', 4)])
        sequential, batched = ready_screen(), ready_screen()
        for action, amount in events:
            sequential.scroll(action, amount)
        with patch.object(batched, "_draw", wraps=batched._draw) as draw:
            batched.scroll_events(events)
            self.assertEqual(draw.call_count, 1)
        expected, actual = sequential.snapshot(), batched.snapshot()
        self.assertEqual(actual["scroll"], expected["scroll"])
        self.assertEqual((actual["text"], actual["cursor"]), ("draft \u6f22\u5b57", 7))
        self.assertEqual(actual["transcript"], expected["transcript"])

    def test_incremental_reflow_matches_full_reflow_for_edits_styles_and_resize(self):
        screen = self.screen()
        screen.start()
        chunks = (
            "before\n" + "abcdef\u6f22e\u0301" * 30,
            "\rready\x1b[K", "\n  \u2502 " + "box " * 80,
            "\x1b[31mRED\x1b[0m", "\b!", "\r\x1b[4Gnew",
            "\x1b[1Kstart", "\r\x1b[2K\u6f22\u5b57 clean", "\nlast",
        )
        for index, chunk in enumerate(chunks):
            with self.subTest(index=index):
                screen.write(chunk)
                incremental = list(screen._visual_rows)
                screen._visual_key = None
                screen._draw()
                self.assertEqual(screen._visual_rows, incremental)
        transcript = screen.snapshot()["transcript"]
        for columns in (18, 40, 120, 18, 80):
            with self.subTest(columns=columns):
                self.tty.resize(columns, 12)
                screen.flush()
                reflowed = list(screen._visual_rows)
                screen._visual_key = None
                screen._draw()
                self.assertEqual(screen._visual_rows, reflowed)
                self.assertEqual(screen.snapshot()["transcript"], transcript)

    def test_incremental_stream_frames_repaint_only_changed_rows(self):
        screen = self.screen()
        screen.start()
        screen.write("answer ")
        before = len(self.tty.getvalue())
        screen.write("more")
        output = self.tty.getvalue()[before:]
        self.assertEqual(len(frame_rows(output)), 1)
        self.assertIn("answer more", visible_text(output))
        self.assertNotIn("\x1b[?25l\x1b[H", output)
        complete = frame_rows(self.tty.getvalue())
        self.assertEqual(len(complete), 24)
        self.assertTrue(complete[22].startswith(TL))
        self.assertTrue(complete[24].endswith(BR))

    def test_response_indent_tracks_resize_between_newline_and_first_glyph(self):
        splash.set_layout("center")
        self.tty.resize(100, 24)
        screen = self.screen()
        screen.start()
        with patch.object(splash, "terminal_columns", side_effect=lambda: self.tty.columns), \
                patch.object(sys, "stdout", screen):
            screen.write(terminal.response_indent() + "LIVE00000\n")
            for index, columns in enumerate((150, 18, 100, 150, 100), 1):
                with self.subTest(columns=columns, index=index):
                    self.tty.resize(columns, 24)
                    screen.flush()  # existing empty line was created at the old width
                    marker = "LIVE%05d" % index
                    screen.write(terminal.response_indent() + marker + "\n")
                    margin = screen.snapshot()["geometry"]["footer_left"]
                    output = next(text for _, _, text in screen._visual_rows
                                  if marker in splash.strip_ansi(text))
                    self.assertEqual(splash.strip_ansi(output),
                                     " " * margin + "  \u2502 " + marker)
                    # Reflow every retained reply at the current gutter.
                    for _, _, text in screen._visual_rows:
                        visible = splash.strip_ansi(text)
                        if "LIVE" in visible:
                            self.assertTrue(visible.startswith(" " * margin + "  \u2502 "))

    def test_resize_margin_refresh_preserves_model_indent_and_input_prefix(self):
        splash.set_layout("center")
        self.tty.resize(100, 24)
        screen = self.screen()
        screen.start()
        screen.finish_input("    user indented", echo=True)
        screen.write("\n")
        self.tty.resize(150, 24)
        with patch.object(splash, "terminal_columns", return_value=150), \
                patch.object(sys, "stdout", screen):
            screen.write(terminal.response_indent() + "    model indented\n")
        rows = [splash.strip_ansi(text) for _, _, text in screen._visual_rows]
        self.assertIn(" " * 27 + "  \u2502     model indented", rows)
        self.assertIn(" " * 27 + "you \u25b8     user indented", rows)
        screen.scroll_lines(1)
        self.tty.resize(100, 24)
        screen.flush()
        rows = [splash.strip_ansi(text) for _, _, text in screen._visual_rows]
        self.assertIn(" " * 2 + "  \u2502     model indented", rows)
        self.assertIn(" " * 2 + "you \u25b8     user indented", rows)


if __name__ == "__main__":
    unittest.main()
