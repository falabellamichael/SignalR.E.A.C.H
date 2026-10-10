"""Logical footer editing and native Windows Unicode event regressions."""

import os
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import footer_input
from reach_cli.footer_input import EditBuffer, PosixKeyDecoder, WindowsKeyDecoder


class EditBufferTests(unittest.TestCase):
    def test_editing_retains_spaces_and_logical_cursor(self):
        buffer = EditBuffer("  draft-tail  ")
        self.assertEqual(buffer.cursor, len(buffer.text))
        for _ in range(7):
            buffer.feed("left")
        self.assertEqual(buffer.cursor, 7)
        self.assertTrue(buffer.feed("text", "-EDIT"))
        self.assertEqual(buffer.text, "  draft-EDIT-tail  ")
        self.assertEqual(buffer.cursor, 12)
        buffer.feed("right")
        buffer.feed("delete")
        self.assertEqual(buffer.text, "  draft-EDIT-ail  ")
        buffer.feed("backspace")
        self.assertEqual(buffer.text, "  draft-EDITail  ")

    def test_boundaries_do_not_move_past_text(self):
        buffer = EditBuffer("ab")
        self.assertFalse(buffer.feed("right"))
        self.assertFalse(buffer.feed("delete"))
        buffer.feed("home")
        self.assertEqual(buffer.cursor, 0)
        self.assertFalse(buffer.feed("left"))
        self.assertFalse(buffer.feed("backspace"))
        buffer.feed("end")
        self.assertEqual(buffer.cursor, 2)
        self.assertEqual(buffer.text, "ab")

    def test_unicode_insert_uses_codepoint_cursor(self):
        original = "  \u754c e\u0301 \U0001f642  "
        buffer = EditBuffer(original)
        buffer.feed("left")
        buffer.feed("left")
        before = buffer.cursor
        buffer.feed("text", "\u5b57")
        self.assertEqual(buffer.text, original[:-2] + "\u5b57" + original[-2:])
        self.assertEqual(buffer.cursor, before + 1)
        buffer.feed("backspace")
        self.assertEqual(buffer.text, original)
        self.assertEqual(buffer.cursor, before)

    def test_history_restores_unsent_draft(self):
        buffer = EditBuffer("  unsent draft  ", history=("first", "second"))
        buffer.feed("left")
        draft_cursor = buffer.cursor
        self.assertTrue(buffer.feed("up"))
        self.assertEqual(buffer.text, "second")
        buffer.feed("up")
        self.assertEqual(buffer.text, "first")
        self.assertFalse(buffer.feed("up"))
        buffer.feed("down")
        self.assertEqual(buffer.text, "second")
        buffer.feed("down")
        self.assertEqual(buffer.text, "  unsent draft  ")
        self.assertEqual(buffer.cursor, draft_cursor)
        self.assertFalse(buffer.feed("down"))

    def test_empty_history_preserves_draft(self):
        buffer = EditBuffer("draft")
        self.assertFalse(buffer.feed("up"))
        self.assertFalse(buffer.feed("down"))
        self.assertEqual((buffer.text, buffer.cursor), ("draft", 5))

    def test_completion_replaces_token_and_preserves_suffix(self):
        calls = []

        def complete(token, before_cursor):
            calls.append((token, before_cursor))
            return ["/workpath"]

        buffer = EditBuffer("  /wor trailing", complete=complete)
        for _ in range(len(" trailing")):
            buffer.feed("left")
        self.assertTrue(buffer.feed("tab"))
        self.assertEqual(calls, [("/wor", "  /wor")])
        self.assertEqual(buffer.text, "  /workpath trailing")
        self.assertEqual(buffer.cursor, len("  /workpath"))

    def test_no_completion_leaves_text_and_cursor_unchanged(self):
        buffer = EditBuffer("draft", complete=lambda token, before: [])
        self.assertFalse(buffer.feed("tab"))
        self.assertEqual((buffer.text, buffer.cursor), ("draft", 5))

    def test_completion_common_prefix_then_cycles_candidates(self):
        matches = ["/workpath", "/worktree"]
        buffer = EditBuffer("/wor", complete=lambda token, before: matches)
        buffer.feed("tab")
        self.assertEqual(buffer.text, "/work")
        selected = []
        for _ in range(2):
            buffer.feed("tab")
            selected.append(buffer.text)
        self.assertEqual(set(selected), set(matches))


class WindowsKeyDecoderTests(unittest.TestCase):
    def test_regular_release_does_not_duplicate_unicode(self):
        decoder = WindowsKeyDecoder()
        self.assertEqual(decoder.feed(True, 1, 0, "\u754c", 0), [("text", "\u754c")])
        self.assertEqual(decoder.feed(False, 1, 0, "\u754c", 0), [])
        self.assertEqual(decoder.feed(False, 1, 65, "a", 0), [])

    def test_alt_release_keeps_combining_and_surrogate_emoji(self):
        decoder = WindowsKeyDecoder()
        events = decoder.feed(False, 1, 0x12, "\u0301", 0)
        self.assertEqual(events, [("text", "\u0301")])
        self.assertEqual(decoder.feed(False, 1, 0x12, "\ud83d", 0), [])
        self.assertEqual(decoder.feed(False, 1, 0x12, "\ude42", 0),
                         [("text", "\U0001f642")])

    def test_surrogate_pair_is_retained_between_reads(self):
        decoder = WindowsKeyDecoder()
        self.assertEqual(decoder.feed(True, 1, 0, "\ud83d", 0), [])
        # A resize or an unrelated no-character key release must not consume
        # pending Unicode state before the next input-record batch arrives.
        self.assertEqual(decoder.feed(False, 1, 16, "\x00", 0), [])
        self.assertEqual(decoder.feed(True, 1, 0, "\ude42", 0),
                         [("text", "\U0001f642")])

    def test_repeat_count_preserves_each_character(self):
        decoder = WindowsKeyDecoder()
        events = decoder.feed(True, 3, 0, "\u754c", 0)
        self.assertTrue(all(key == "text" for key, _ in events))
        self.assertEqual("".join(text for _, text in events), "\u754c" * 3)

    def test_integer_unicode_records_are_accepted(self):
        decoder = WindowsKeyDecoder()
        self.assertEqual(decoder.feed(False, 1, 0x12, 0x0301, 0),
                         [("text", "\u0301")])

    def test_controls_remain_explicit_events(self):
        decoder = WindowsKeyDecoder()
        cases = ((0x0d, "\r", "enter"), (0x08, "\b", "backspace"),
                 (0x09, "\t", "tab"), (0x43, "\x03", "interrupt"),
                 (0x44, "\x04", "eof"), (0x5a, "\x1a", "eof"))
        for virtual_key, char, expected in cases:
            with self.subTest(char=repr(char)):
                events = decoder.feed(True, 1, virtual_key, char, 0)
                self.assertEqual([key for key, _ in events], [expected])

    def test_navigation_uses_virtual_key_without_text(self):
        decoder = WindowsKeyDecoder()
        expected = ((0x25, "left"), (0x27, "right"), (0x24, "home"),
                    (0x23, "end"), (0x26, "up"), (0x28, "down"),
                    (0x2e, "delete"))
        for virtual_key, key in expected:
            with self.subTest(key=key):
                self.assertEqual(decoder.feed(True, 1, virtual_key, "\x00", 0),
                                 [(key, "")])
                self.assertEqual(decoder.feed(False, 1, virtual_key, "\x00", 0), [])

    def test_altgr_translated_text_remains_unicode_text(self):
        decoder = WindowsKeyDecoder()
        # RIGHT_ALT_PRESSED | LEFT_CTRL_PRESSED can represent AltGr.
        self.assertEqual(decoder.feed(True, 1, 0, "\u00e9", 0x0009),
                         [("text", "\u00e9")])

    def test_plain_alt_release_without_character_is_ignored(self):
        decoder = WindowsKeyDecoder()
        self.assertEqual(decoder.feed(False, 1, 0x12, "\x00", 0), [])

    def test_control_navigation_and_word_delete(self):
        decoder = WindowsKeyDecoder()
        self.assertEqual(decoder.feed(True, 1, 0x25, "\0", 0x08),
                         [("word_left", "")])
        self.assertEqual(decoder.feed(True, 1, 0x08, "\x7f", 0x08),
                         [("erase_word", "")])


class PosixKeyDecoderTests(unittest.TestCase):
    def test_utf8_can_split_at_every_byte(self):
        decoder = PosixKeyDecoder()
        text = "  \u754c e\u0301 \U0001f642  "
        events = []
        for byte in text.encode("utf-8"):
            events.extend(decoder.feed(bytes([byte])))
        self.assertEqual("".join(value for key, value in events), text)
        self.assertTrue(all(key == "text" for key, _ in events))

    def test_split_navigation_sequences(self):
        decoder = PosixKeyDecoder()
        self.assertEqual(decoder.feed(b"\x1b["), [])
        self.assertEqual(decoder.feed(b"D"), [("left", "")])
        self.assertEqual(decoder.feed(b"\x1b[3~\x1b[H\x1bOF\x1bOA"),
                         [("delete", ""), ("home", ""), ("end", ""), ("up", "")])

    def test_bracketed_paste_keeps_controls_as_literal_text(self):
        decoder = PosixKeyDecoder()
        events = decoder.feed(b"\x1b[200~first\nsecond\t\x03\x1b[201~\r")
        self.assertEqual("".join(value for key, value in events if key == "text"),
                         "first\nsecond\t\x03")
        self.assertEqual(events[-1], ("enter", ""))

    def test_alt_character_does_not_swallow_following_text(self):
        decoder = PosixKeyDecoder()
        self.assertEqual(decoder.feed(b"\x1baX"), [("text", "a"), ("text", "X")])

    def test_paste_crlf_is_one_newline_and_literal_escape_is_retained(self):
        decoder = PosixKeyDecoder()
        events = decoder.feed(b"\x1b[200~A\r")
        events += decoder.feed(b"\nB\x1b[DZ\x1b[20")
        events += decoder.feed(b"1~\r")
        self.assertEqual("".join(value for key, value in events if key == "text"),
                         "A\nB\x1b[DZ")
        self.assertEqual(events[-1], ("enter", ""))


class DriverTests(unittest.TestCase):
    def test_resize_preserves_draft_and_nonend_cursor(self):
        changed = []
        events = iter([("text", "  draft  "), ("left", ""),
                       ("resize", ""), ("text", "EDIT"), ("enter", "")])
        result = footer_input._drive(EditBuffer(), lambda *args: changed.append(args), events)
        self.assertEqual(result, "  draft EDIT ")
        self.assertEqual(changed[-3], changed[-2])
        self.assertEqual(changed[0], ("", 0))

    def test_interrupt_and_empty_eof_raise(self):
        for key, error in (("interrupt", KeyboardInterrupt), ("eof", EOFError)):
            with self.subTest(key=key), self.assertRaises(error):
                footer_input._drive(EditBuffer(), lambda *_: None, iter([(key, "")]))

    def test_eof_on_nonempty_draft_deletes_at_cursor(self):
        editor = EditBuffer("tail")
        editor.cursor = 1
        result = footer_input._drive(editor, lambda *_: None,
                                     iter([("eof", ""), ("enter", "")]))
        self.assertEqual(result, "til")

    def test_accept_interrupt_and_callback_failure_close_reader(self):
        for key, error, callback in (
                ("enter", None, lambda *_: None),
                ("interrupt", KeyboardInterrupt, lambda *_: None),
                ("text", ValueError, lambda *_: (_ for _ in ()).throw(ValueError("render")))):
            closed = []

            def events():
                try:
                    yield key, "draft"
                finally:
                    closed.append(True)

            # Mode setup occurs only once the generator is entered. Initial
            # callback failure closes the unstarted reader without modes set.
            with self.subTest(key=key), \
                    patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                    patch.object(footer_input, "_windows_events", events):
                if error is None:
                    self.assertEqual(footer_input.read_line(callback), "")
                else:
                    with self.assertRaises(error):
                        footer_input.read_line(callback)
            self.assertEqual(closed, [] if key == "text" else [True])


class FooterReadDriverTests(unittest.TestCase):
    def test_resize_events_preserve_draft_and_cursor_before_edit(self):
        text = "  \u754c e\u0301 \U0001f642 " * 20 + "  "
        buffer = EditBuffer(text)
        snapshots = []
        events = [("left", ""), ("left", "")]
        events += [("resize", "")] * 8
        events += [("text", "X"), ("enter", "")]
        result = footer_input._drive(buffer,
                                     lambda draft, cursor: snapshots.append((draft, cursor)),
                                     events)
        self.assertEqual(result, text[:-2] + "X" + text[-2:])
        self.assertEqual(snapshots[3:11], [(text, len(text) - 2)] * 8)

    def test_eof_with_nonempty_draft_deletes_at_cursor(self):
        buffer = EditBuffer("ab")
        result = footer_input._drive(buffer, lambda text, cursor: None,
                                     [("left", ""), ("eof", ""), ("enter", "")])
        self.assertEqual(result, "a")

    def test_eof_with_empty_draft_raises(self):
        with self.assertRaises(EOFError):
            footer_input._drive(EditBuffer(), lambda text, cursor: None,
                                [("eof", "")])

    def test_read_line_closes_reader_after_accept_or_interrupt(self):
        for key, expected_exception in (("enter", None), ("interrupt", KeyboardInterrupt)):
            closed = []

            def events():
                try:
                    yield "text", "draft"
                    yield key, ""
                finally:
                    closed.append(True)

            with self.subTest(key=key), \
                    patch.object(footer_input, "_windows_events", events), \
                    patch.object(footer_input, "_posix_events", events):
                if expected_exception:
                    with self.assertRaises(expected_exception):
                        footer_input.read_line(lambda text, cursor: None)
                else:
                    self.assertEqual(footer_input.read_line(lambda text, cursor: None), "draft")
                self.assertEqual(closed, [True])

    def test_callback_failure_closes_active_reader(self):
        closed = []

        def events():
            try:
                yield "text", "draft"
            finally:
                closed.append(True)

        def render(text, cursor):
            if text:
                raise RuntimeError("renderer failure")

        with patch.object(footer_input, "_windows_events", events), \
                patch.object(footer_input, "_posix_events", events):
            with self.assertRaisesRegex(RuntimeError, "renderer failure"):
                footer_input.read_line(render)
        self.assertEqual(closed, [True])


class SessionInputModeTests(unittest.TestCase):
    def test_windows_keeps_processed_input_and_restores_original(self):
        original_platform = os.name
        for fail in (False, True):
            modes = []
            original = 0x0001 | 0x0002 | 0x0004 | 0x0040
            api = types.SimpleNamespace(SetConsoleMode=lambda handle, mode:
                                        modes.append((handle, mode)) or True)
            with self.subTest(fail=fail), \
                    patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                    patch.object(footer_input, "_windows_console_mode",
                                 return_value=(api, 123, original)):
                try:
                    with footer_input.session_input_mode():
                        self.assertEqual(os.name, original_platform)
                        self.assertEqual(modes, [(123, original & ~0x0004)])
                        self.assertTrue(modes[-1][1] & 0x0001)
                        if fail:
                            raise RuntimeError("session failed")
                except RuntimeError:
                    self.assertTrue(fail)
            self.assertEqual(modes, [(123, original & ~0x0004), (123, original)])

    def test_posix_keeps_isig_and_restores_original(self):
        original_platform = os.name
        for fail in (False, True):
            modes = []
            original = [0, 0, 0, 0x01 | 0x08 | 0x40, 0, 0, []]
            api = types.SimpleNamespace(ECHO=0x08, ECHONL=0x40, TCSANOW=0,
                                        tcgetattr=lambda fd: original,
                                        tcsetattr=lambda fd, when, mode:
                                        modes.append((fd, when, list(mode))))
            stdin = types.SimpleNamespace(fileno=lambda: 321)
            with self.subTest(fail=fail), \
                    patch.object(footer_input, "os", types.SimpleNamespace(name="posix")), \
                    patch.object(footer_input.sys, "stdin", stdin), \
                    patch.dict(sys.modules, {"termios": api}):
                try:
                    with footer_input.session_input_mode():
                        self.assertEqual(os.name, original_platform)
                        self.assertEqual(modes[-1][2][3], 0x01)
                        if fail:
                            raise RuntimeError("session failed")
                except RuntimeError:
                    self.assertTrue(fail)
            self.assertEqual(modes[-1], (321, 0, original))
            self.assertEqual(original[3], 0x01 | 0x08 | 0x40)


if __name__ == "__main__":
    unittest.main()
