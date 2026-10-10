"""Logical footer editing and native Windows Unicode event regressions."""

import os
import ctypes
import sys
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import footer_input
from reach_cli.footer_input import (EditBuffer, PosixKeyDecoder, WindowsKeyDecoder,
                                    WindowsMouseDecoder)


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

    def test_page_keys_preserve_repeats_and_ignore_releases(self):
        decoder = WindowsKeyDecoder()
        self.assertEqual(decoder.feed(True, 2, 0x21, "\0"),
                         [("scroll_page_up", "")] * 2)
        self.assertEqual(decoder.feed(True, 1, 0x22, "\0"),
                         [("scroll_page_down", "")])
        self.assertEqual(decoder.feed(False, 1, 0x21, "\0"), [])


class WindowsMouseDecoderTests(unittest.TestCase):
    def test_signed_wheel_deltas_and_multiple_notches(self):
        decoder = WindowsMouseDecoder()
        self.assertEqual(decoder.feed(240 << 16, 4), [("scroll_up", 2)])
        self.assertEqual(decoder.feed(((-120) & 0xffff) << 16, 4), [("scroll_down", 1)])

    def test_high_resolution_wheel_deltas_accumulate(self):
        decoder = WindowsMouseDecoder()
        self.assertEqual(decoder.feed(60 << 16, 4), [])
        self.assertEqual(decoder.feed(60 << 16, 4), [("scroll_up", 1)])
        self.assertEqual(decoder.feed(((-60) & 0xffff) << 16, 4), [])
        self.assertEqual(decoder.feed(((-60) & 0xffff) << 16, 4), [("scroll_down", 1)])

    def test_click_motion_and_horizontal_wheel_do_not_scroll(self):
        decoder = WindowsMouseDecoder()
        for flags in (0, 1, 2, 8):
            self.assertEqual(decoder.feed(120 << 16, flags), [])


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

    def test_page_keys_and_modifiers(self):
        decoder = PosixKeyDecoder()
        self.assertEqual(decoder.feed(b"\x1b[5~\x1b[6~\x1b[5;2~"),
                         [("scroll_page_up", ""), ("scroll_page_down", ""),
                          ("scroll_page_up", "")])

    def test_sgr_mouse_fragments_survive_waits_and_preserve_following_text(self):
        decoder = PosixKeyDecoder()
        events = []
        for byte in b"\x1b[<64;10;3M\x1b[<65;10;3Mtext":
            events.extend(decoder.feed(bytes([byte])))
            decoder.flush_escape() if decoder._escape != "\x1b" else None
        self.assertEqual(events[:2], [("scroll_up", 1), ("scroll_down", 1)])
        self.assertEqual("".join(text for key, text in events[2:]), "text")

    def test_sgr_modifiers_scroll_but_other_or_invalid_mouse_reports_do_not(self):
        decoder = PosixKeyDecoder()
        self.assertEqual(decoder.feed(b"\x1b[<84;10;3M"), [("scroll_up", 1)])
        for report in (b"\x1b[<64;0;3M", b"\x1b[<66;10;3M", b"\x1b[<0;10;3M",
                       b"\x1b[<64;10;3m", b"\x1b[<bad;10;3M", b"\x1b[<96;10;3M"):
            self.assertEqual(decoder.feed(report), [])
        self.assertEqual(decoder.feed(b"ok"), [("text", "o"), ("text", "k")])

    def test_legacy_x10_mouse_fragments_do_not_become_draft_text(self):
        decoder = PosixKeyDecoder()
        self.assertEqual(decoder.feed(b"\x1b[M"), [])
        self.assertEqual(decoder.feed(bytes([96, 37])), [])
        self.assertEqual(decoder.feed(bytes([37])), [("scroll_up", 1)])
        self.assertEqual(decoder.feed(b"\x1b[M" + bytes([97, 37, 37])),
                         [("scroll_down", 1)])

    def test_legacy_high_coordinate_bytes_do_not_steal_following_utf8_text(self):
        decoder = PosixKeyDecoder()
        events = []
        for byte in b"\x1b[M" + bytes([96, 194, 160]) + "X\u754c\r".encode("utf-8"):
            events.extend(decoder.feed(bytes([byte])))
        self.assertEqual(events, [("scroll_up", 1), ("text", "X"),
                                  ("text", "\u754c"), ("enter", "")])


class DriverTests(unittest.TestCase):
    def test_scroll_callbacks_preserve_draft_cursor_and_editor_history(self):
        editor = EditBuffer("  draft  ", history=("older",))
        editor.cursor = 3
        snapshots, actions = [], []
        result = footer_input._drive(
            editor, lambda *args: snapshots.append(args),
            [("scroll_page_up", ""), ("scroll_down", 2), ("scroll_page_down", ""),
             ("scroll_up", 1), ("enter", "")], lambda *args: actions.append(args))
        self.assertEqual(result, "  draft  ")
        self.assertEqual(editor.cursor, 3)
        self.assertIsNone(editor._history_index)
        self.assertEqual(snapshots, [("  draft  ", 3)])
        self.assertEqual(actions, [("page_up", 1), ("down", 2), ("page_down", 1), ("up", 1)])

    def test_scroll_without_callback_does_not_modify_input(self):
        result = footer_input._drive(EditBuffer("draft"), lambda *_: None,
                                     [("scroll_up", 1), ("enter", "")])
        self.assertEqual(result, "draft")

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
    def test_reader_construction_failure_resets_ownership(self):
        with patch.object(footer_input, "EditBuffer", side_effect=ValueError("construct")):
            with self.assertRaisesRegex(ValueError, "construct"):
                footer_input.read_line(lambda *_: None)
        self.assertFalse(footer_input._READ_ACTIVE)

    def test_callbacks_run_without_input_lock_and_poller_cannot_steal_input(self):
        acquired = []

        def change(*_):
            def other_thread():
                ready = footer_input._INPUT_LOCK.acquire(blocking=False)
                acquired.append(ready)
                if ready:
                    footer_input._INPUT_LOCK.release()
            worker = threading.Thread(target=other_thread)
            worker.start()
            worker.join(timeout=1)
            self.assertEqual(footer_input.poll_scroll_events(), [])

        def events():
            yield "enter", ""

        with patch.object(footer_input, "_windows_events", events), \
                patch.object(footer_input, "_posix_events", events), \
                patch.object(footer_input, "_windows_record_api") as native:
            self.assertEqual(footer_input.read_line(change), "")
            native.assert_not_called()
        self.assertEqual(acquired, [True])
        self.assertFalse(footer_input._READ_ACTIVE)

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
            quiet = (original | 0x0008 | 0x0010 | 0x0080) & ~(0x0004 | 0x0040 | 0x0200)
            api = types.SimpleNamespace(SetConsoleMode=lambda handle, mode:
                                        modes.append((handle, mode)) or True)
            with self.subTest(fail=fail), \
                    patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                    patch.object(footer_input, "_windows_console_mode",
                                 return_value=(api, 123, original)):
                try:
                    with footer_input.session_input_mode():
                        self.assertEqual(os.name, original_platform)
                        self.assertEqual(modes, [(123, quiet)])
                        self.assertTrue(modes[-1][1] & 0x0001)
                        self.assertTrue(modes[-1][1] & 0x0010)
                        self.assertFalse(modes[-1][1] & 0x0040)
                        self.assertTrue(footer_input._SESSION_ACTIVE)
                        if fail:
                            raise RuntimeError("session failed")
                except RuntimeError:
                    self.assertTrue(fail)
            self.assertEqual(modes, [(123, quiet), (123, original)])
            self.assertFalse(footer_input._SESSION_ACTIVE)

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
                        self.assertTrue(footer_input._SESSION_ACTIVE)
                        self.assertEqual(modes[-1][2][3], 0x01)
                        if fail:
                            raise RuntimeError("session failed")
                except RuntimeError:
                    self.assertTrue(fail)
            self.assertEqual(modes[-1], (321, 0, original))
            self.assertEqual(original[3], 0x01 | 0x08 | 0x40)
            self.assertFalse(footer_input._SESSION_ACTIVE)


class ScrollPollTests(unittest.TestCase):
    def fake_native(self, descriptions):
        class KEY(ctypes.Structure):
            _fields_ = [("down", ctypes.c_int32), ("repeat", ctypes.c_uint16),
                        ("key", ctypes.c_uint16), ("scan", ctypes.c_uint16),
                        ("char", ctypes.c_uint16), ("control", ctypes.c_uint32)]

        class COORD(ctypes.Structure):
            _fields_ = [("x", ctypes.c_int16), ("y", ctypes.c_int16)]

        class MOUSE(ctypes.Structure):
            _fields_ = [("position", COORD), ("buttons", ctypes.c_uint32),
                        ("control", ctypes.c_uint32), ("flags", ctypes.c_uint32)]

        class EVENT(ctypes.Union):
            _fields_ = [("key", KEY), ("mouse", MOUSE), ("padding", ctypes.c_byte * 16)]

        class RECORD(ctypes.Structure):
            _fields_ = [("kind", ctypes.c_uint16), ("event", EVENT)]

        records = []
        for description in descriptions:
            record = RECORD()
            record.kind = description.get("kind", 1)
            if record.kind == 1:
                record.event.key.down = description.get("down", True)
                record.event.key.repeat = 1
                record.event.key.key = description.get("key", 0)
                record.event.key.char = description.get("char", 0)
            elif record.kind == 2:
                record.event.mouse.buttons = description.get("delta", 120) << 16 & 0xffffffff
                record.event.mouse.flags = description.get("flags", 4)
            records.append(record)
        read_count = []

        def copy(record, buffer, count):
            ctypes.memmove(buffer, ctypes.byref(record), ctypes.sizeof(RECORD))
            count._obj.value = 1
            return True

        def peek(handle, buffer, length, count):
            if not records:
                count._obj.value = 0
                return True
            return copy(records[0], buffer, count)

        def read(handle, buffer, length, count):
            read_count.append(True)
            return copy(records.pop(0), buffer, count)

        api = types.SimpleNamespace(PeekConsoleInputW=peek, ReadConsoleInputW=read)
        return api, RECORD, records, read_count

    def poll(self, descriptions):
        api, record_type, records, reads = self.fake_native(descriptions)
        with patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_READ_ACTIVE", False), \
                patch.object(footer_input, "_windows_record_api", return_value=(api, 1, 0, record_type)), \
                patch.object(footer_input, "_WINDOWS_MOUSE", WindowsMouseDecoder()), \
                patch.object(footer_input, "_WINDOWS_DECODER", WindowsKeyDecoder()):
            actions = footer_input.poll_scroll_events()
        return actions, records, reads

    def test_leading_scroll_and_harmless_records_are_consumed_until_text(self):
        actions, records, reads = self.poll([
            {"key": 0x21}, {"key": 0x21, "down": False}, {"kind": 4},
            {"kind": 2, "delta": -240}, {"kind": 16}, {"char": ord("a")},
            {"key": 0x22},
        ])
        self.assertEqual(actions, [("page_up", 1), ("down", 2)])
        self.assertEqual(len(reads), 5)
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0].event.key.char, ord("a"))

    def test_unicode_alt_release_and_control_heads_are_not_consumed(self):
        for head in ({"char": ord("x")}, {"char": 3, "key": 0x43},
                     {"char": ord("x"), "key": 0x12, "down": False},
                     {"char": 0x0301, "key": 0x12, "down": False},
                     {"char": 0xd83d, "key": 0x12, "down": False},
                     {"char": 0xde42, "key": 0x12, "down": False}):
            with self.subTest(head=head):
                actions, records, reads = self.poll([head, {"key": 0x21}])
                self.assertEqual(actions, [])
                self.assertEqual(reads, [])
                self.assertEqual(len(records), 2)

    def test_enter_release_does_not_block_streaming_page_and_wheel(self):
        actions, records, reads = self.poll([
            {"key": 0x0d, "char": ord("\r"), "down": False},
            {"key": 0x21}, {"kind": 2, "delta": -120},
        ])
        self.assertEqual(actions, [("page_up", 1), ("down", 1)])
        self.assertEqual(len(reads), 3)
        self.assertEqual(records, [])

    def test_ordinary_key_releases_follow_editor_ignore_semantics(self):
        for release in ({"key": 0x58, "char": ord("x"), "down": False},
                        {"key": 0, "char": ord("界"), "down": False},
                        {"key": 0x43, "char": 3, "down": False},
                        {"key": 0x12, "down": False}):
            with self.subTest(release=release):
                actions, records, reads = self.poll([release, {"key": 0x21}])
                self.assertEqual(actions, [("page_up", 1)])
                self.assertEqual(len(reads), 2)
                self.assertEqual(records, [])

    def test_inactive_session_or_active_reader_does_not_touch_native_api(self):
        with patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                patch.object(footer_input, "_windows_record_api") as native:
            for session, reader in ((False, False), (True, True)):
                with patch.object(footer_input, "_SESSION_ACTIVE", session), \
                        patch.object(footer_input, "_READ_ACTIVE", reader):
                    self.assertEqual(footer_input.poll_scroll_events(), [])
            native.assert_not_called()

    def test_posix_polling_leaves_input_bytes_untouched(self):
        with patch.object(footer_input, "os", types.SimpleNamespace(name="posix")), \
                patch.object(footer_input, "_windows_record_api") as native:
            self.assertEqual(footer_input.poll_scroll_events(), [])
            native.assert_not_called()


if __name__ == "__main__":
    unittest.main()
