"""Logical footer editing and native Windows Unicode event regressions."""

import os
import ctypes
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch
from collections import deque
from contextlib import nullcontext
import time

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
    def setUp(self):
        self.broker_patch = patch.object(footer_input, "_InputBroker")
        self.broker = self.broker_patch.start().return_value
        self.addCleanup(self.broker_patch.stop)

    def test_windows_keeps_processed_input_and_restores_original(self):
        original_platform = os.name
        for fail in (False, True):
            modes = []
            original = 0x0001 | 0x0002 | 0x0004 | 0x0040
            quiet = (original | 0x0008 | 0x0010 | 0x0080) & ~(0x0002 | 0x0004 | 0x0040 | 0x0200)
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
                        self.assertFalse(modes[-1][1] & 0x0002)
                        self.assertFalse(modes[-1][1] & 0x0040)
                        self.assertTrue(footer_input._SESSION_ACTIVE)
                        if fail:
                            raise RuntimeError("session failed")
                except RuntimeError:
                    self.assertTrue(fail)
            self.assertEqual(modes, [(123, quiet), (123, original)])
            self.assertFalse(footer_input._SESSION_ACTIVE)

    def test_posix_raw_session_preserves_original_and_restores_on_error(self):
        original_platform = os.name
        for fail in (False, True):
            modes = []
            original = [0x80, 0x01, 0x00, 0x01 | 0x02 | 0x08 | 0x40, 0, 0, [0] * 32]
            api = types.SimpleNamespace(ECHO=0x08, ECHONL=0x40, ICANON=0x02, ISIG=0x01,
                                        ICRNL=0x80, OPOST=0x01, VMIN=6, VTIME=5, TCSANOW=0,
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
                        self.assertEqual(modes[-1][2][3], 0)
                        self.assertEqual(modes[-1][2][0], 0)
                        self.assertEqual(modes[-1][2][1], 0)
                        self.assertEqual(modes[-1][2][6][6], 1)
                        self.assertEqual(modes[-1][2][6][5], 0)
                        if fail:
                            raise RuntimeError("session failed")
                except RuntimeError:
                    self.assertTrue(fail)
            self.assertEqual(modes[-1], (321, 0, original))
            self.assertEqual(original[3], 0x01 | 0x02 | 0x08 | 0x40)
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
        broker = footer_input._InputBroker()
        broker._native = (api, 1, 0, record_type)
        with patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_READ_ACTIVE", False), \
                patch.object(footer_input, "_BROKER", broker):
            with broker._condition:
                while not broker._windows_pump():
                    pass
            actions = footer_input.poll_scroll_events()
        return actions, list(broker._pending), reads, records

    def test_typing_does_not_block_later_page_and_wheel_navigation(self):
        actions, pending, reads, records = self.poll([
            {"key": 0x21}, {"key": 0x21, "down": False}, {"kind": 4},
            {"kind": 2, "delta": -240}, {"kind": 16}, {"char": ord("a")},
            {"key": 0x22}, {"char": ord("b")}, {"key": 0x0d, "char": 13},
        ])
        self.assertEqual(actions, [("page_up", 1), ("down", 2), ("page_down", 1)])
        self.assertEqual(pending, [("text", "ab"), ("enter", "")])
        self.assertEqual(len(reads), 9)
        self.assertEqual(records, [])

    def test_alt_unicode_and_surrogates_are_retained_behind_navigation(self):
        actions, pending, reads, records = self.poll([
            {"char": ord("x"), "key": 0x12, "down": False},
            {"char": 0x0301, "key": 0x12, "down": False},
            {"char": 0xd83d, "key": 0x12, "down": False},
            {"key": 0x21},
            {"char": 0xde42, "key": 0x12, "down": False},
        ])
        self.assertEqual(actions, [("page_up", 1)])
        self.assertEqual(pending, [("text", "x\u0301\U0001f642")])
        self.assertEqual(len(reads), 5)
        self.assertEqual(records, [])

    def test_large_mixed_burst_coalesces_scroll_and_preserves_edit_fifo(self):
        descriptions = [{"char": ord("a")}] * 2000
        descriptions += [{"key": 0x21}] * 100
        descriptions += [{"key": 0x25}, {"char": ord("X")},
                         {"key": 0x0d, "char": 13}, {"char": ord("b")},
                         {"kind": 2, "delta": -120}]
        actions, pending, reads, records = self.poll(descriptions)
        self.assertEqual(actions, [("page_up", 100), ("down", 1)])
        self.assertEqual(pending, [("text", "a" * 2000), ("left", ""),
                                   ("text", "X"), ("enter", ""), ("text", "b")])
        self.assertEqual(len(reads), len(descriptions))
        self.assertEqual(records, [])

    def test_poll_never_reads_native_input_even_during_editor(self):
        broker = footer_input._InputBroker()
        with broker._condition:
            broker._put([("text", "draft"), ("scroll_up", 3)])
        with patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_READ_ACTIVE", True), \
                patch.object(footer_input, "_BROKER", broker), \
                patch.object(footer_input, "_windows_record_api") as native:
            self.assertEqual(footer_input.poll_scroll_events(), [("up", 3)])
            self.assertEqual(footer_input.poll_scroll_events(), [])
            native.assert_not_called()
        self.assertEqual(list(broker._pending), [("text", "draft")])

    def test_inactive_session_does_not_expose_old_broker(self):
        with patch.object(footer_input, "_SESSION_ACTIVE", False), \
                patch.object(footer_input, "_BROKER") as broker:
            self.assertEqual(footer_input.poll_scroll_events(), [])
            broker.navigation.assert_not_called()


class InputBrokerTests(unittest.TestCase):
    def put(self, broker, events):
        with broker._condition:
            broker._put(events)

    def test_control_priority_does_not_reorder_text_edit_enter_or_eof(self):
        broker = footer_input._InputBroker()
        with patch.object(footer_input, "_READ_ACTIVE", True):
            self.put(broker, [("text", "draft"), ("left", ""), ("eof", ""),
                              ("enter", ""), ("scroll_page_up", 2),
                              ("interrupt", ""), ("resize", "")])
        self.assertEqual(broker.event(), ("interrupt", ""))
        self.assertEqual(broker.event(), ("resize", ""))
        self.assertEqual([broker.event() for _ in range(4)],
                         [("text", "draft"), ("left", ""), ("eof", ""), ("enter", "")])
        self.assertEqual(broker.navigation(), [("page_up", 2)])

    def test_only_watcher_consumes_navigation_and_preserves_clamped_order(self):
        broker = footer_input._InputBroker()
        self.put(broker, [("scroll_up", 1)])
        first_watcher_batch = broker.navigation()
        # The watcher may pause before applying its first batch. An editor
        # must not steal and apply later navigation ahead of that batch.
        self.put(broker, [("scroll_down", 1), ("text", "draft"), ("enter", "")])
        self.assertEqual(broker.event(), ("text", "draft"))
        self.assertEqual(broker.event(), ("enter", ""))
        second_watcher_batch = broker.navigation()
        self.assertEqual(first_watcher_batch, [("up", 1)])
        self.assertEqual(second_watcher_batch, [("down", 1)])
        top = 0
        for action, amount in first_watcher_batch + second_watcher_batch:
            delta = amount if action == "up" else -amount
            top = max(0, min(10, top - delta))
        self.assertEqual(top, 1)
        # Reversing the batches would clamp down then up back to row zero.
        reverse = 0
        for action, amount in second_watcher_batch + first_watcher_batch:
            delta = amount if action == "up" else -amount
            reverse = max(0, min(10, reverse - delta))
        self.assertEqual(reverse, 0)

    def test_batch_scroll_calls_renderer_once_and_keeps_draft_cursor(self):
        class Screen:
            def __init__(self):
                self.batches = []
            def scroll(self, *args):
                self.fail = args
            def scroll_events(self, events):
                self.batches.append(events)
        screen = Screen()
        editor = EditBuffer("draft")
        editor.cursor = 2
        events = [("scroll_batch", [("page_up", 1), ("down", 2), ("up", 3)]),
                  ("enter", "")]
        result = footer_input._drive(editor, lambda *_: None, events, screen.scroll)
        self.assertEqual(result, "draft")
        self.assertEqual(editor.cursor, 2)
        self.assertEqual(screen.batches, [[("page_up", 1), ("down", 2), ("up", 3)]])
        self.assertFalse(hasattr(screen, "fail"))

    def test_urgent_posix_cancel_is_guarded_and_deduplicated(self):
        broker = footer_input._InputBroker()
        with patch.object(footer_input, "os", types.SimpleNamespace(name="posix")), \
                patch.object(footer_input, "_READ_ACTIVE", False), \
                patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_BROKER", broker), \
                patch("_thread.interrupt_main") as interrupt:
            self.put(broker, [("text", "before"), ("interrupt", ""),
                              ("interrupt", ""), ("text", "after")])
            interrupt.assert_called_once_with()
            self.assertEqual(list(broker._pending), [("text", "beforeafter")])
            broker.close()
            self.put(broker, [("interrupt", "")])
            interrupt.assert_called_once_with()

    def test_busy_bracketed_paste_retains_literal_cancel_and_crlf(self):
        decoder = PosixKeyDecoder()
        broker = footer_input._InputBroker()
        with patch.object(footer_input, "_READ_ACTIVE", False), \
                patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_BROKER", broker), \
                patch("_thread.interrupt_main") as interrupt:
            self.put(broker, decoder.feed(b"\x1b[200~A\r\nB\x03\x1b[201~\r"))
            self.assertEqual(list(broker._pending), [("text", "A\nB\x03"), ("enter", "")])
            interrupt.assert_not_called()

    def test_reply_cancel_signals_only_verified_own_foreground_group(self):
        import signal
        broker = footer_input._InputBroker()
        broker._fd = 91
        kill = Mock()
        platform = types.SimpleNamespace(name="posix", getpgrp=lambda: 123,
                                         tcgetpgrp=lambda fd: 123, killpg=kill)
        with patch.object(footer_input, "os", platform), \
                patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_READ_ACTIVE", False), \
                patch.object(footer_input, "_BROKER", broker), \
                patch("_thread.interrupt_main") as main_interrupt:
            self.put(broker, [("interrupt", ""), ("interrupt", "")])
            kill.assert_called_once_with(123, signal.SIGINT)
            main_interrupt.assert_not_called()

    def test_unverified_foreground_or_signal_error_falls_back_to_python(self):
        cases = [(0, 0, None), (-1, -1, None), (123, 999, None),
                 (123, OSError("no tty"), None),
                 (OSError("no group"), 123, None),
                 (123, 123, OSError("signal denied"))]
        for group, foreground, signal_error in cases:
            with self.subTest(group=group, foreground=foreground, signal_error=signal_error):
                broker = footer_input._InputBroker()
                broker._fd = 91
                get_group = Mock(return_value=group)
                get_foreground = Mock(return_value=foreground)
                if isinstance(group, Exception):
                    get_group.side_effect = group
                if isinstance(foreground, Exception):
                    get_foreground.side_effect = foreground
                kill = Mock(side_effect=signal_error)
                platform = types.SimpleNamespace(name="posix", getpgrp=get_group,
                                                 tcgetpgrp=get_foreground, killpg=kill)
                with patch.object(footer_input, "os", platform), \
                        patch("_thread.interrupt_main") as main_interrupt:
                    broker._interrupt_reply()
                    main_interrupt.assert_called_once_with()
                if signal_error is None:
                    kill.assert_not_called()

    def test_session_lifecycle_guard_prevents_foreground_signals_after_close(self):
        broker = footer_input._InputBroker()
        for active, owner, closed, stopped in ((False, broker, False, False),
                                               (True, object(), False, False),
                                               (True, broker, True, False),
                                               (True, broker, False, True)):
            with self.subTest(active=active, owner=owner, closed=closed, stopped=stopped):
                broker._closed = closed
                broker._stop.clear()
                if stopped:
                    broker._stop.set()
                with patch.object(footer_input, "os", types.SimpleNamespace(name="posix")), \
                        patch.object(footer_input, "_SESSION_ACTIVE", active), \
                        patch.object(footer_input, "_READ_ACTIVE", False), \
                        patch.object(footer_input, "_BROKER", owner), \
                        patch.object(broker, "_interrupt_reply") as signal_reply:
                    self.put(broker, [("interrupt", "")])
                    signal_reply.assert_not_called()

    def test_text_batching_preserves_multiline_unicode_and_boundary(self):
        broker = footer_input._InputBroker()
        text = "\u754c\U0001f642\n" * 4000
        self.put(broker, [("text", char) for char in text] + [("enter", ""), ("text", "next")])
        self.assertEqual("".join(value for key, value in broker._pending if key == "text"),
                         text + "next")
        self.assertLessEqual(len(broker._pending), 4)
        self.assertEqual([key for key, _ in broker._pending], ["text", "text", "enter", "text"])

    def test_fresh_reader_parks_all_native_backlog_and_restores_fifo(self):
        native = ScrollPollTests()
        api, record_type, records, reads = native.fake_native(
            [{"char": ord("a")}] * 300 + [{"char": ord("y")}, {"key": 0x0d, "char": 13}])
        broker = footer_input._InputBroker()
        broker._native = (api, 1, 0, record_type)
        with patch.object(footer_input, "os", types.SimpleNamespace(name="nt")):
            broker._thread = threading.Thread(target=broker._run, daemon=True)
            broker._thread.start()
            try:
                broker.begin_reader(fresh=True)
                self.assertEqual(records, [])
                self.assertEqual(list(broker._pending), [])
                self.assertEqual(list(broker._parked[0]), [("text", "a" * 300 + "y"), ("enter", "")])
                self.put(broker, [("text", "n"), ("enter", ""), ("text", "new")])
                self.assertEqual(broker.event(), ("text", "n"))
                self.assertEqual(broker.event(), ("enter", ""))
                broker.end_reader()
                self.assertEqual(list(broker._pending), [("text", "a" * 300 + "y"),
                                                       ("enter", ""), ("text", "new")])
            finally:
                broker.close()
        self.assertEqual(len(reads), 302)

    def test_fresh_boundary_timeout_is_fail_closed_and_cannot_park_later(self):
        broker = footer_input._InputBroker()
        self.put(broker, [("text", "y"), ("enter", "")])
        with self.assertRaisesRegex(EOFError, "prompt boundary"):
            broker.begin_reader(fresh=True)
        self.assertEqual(broker._barriers, [])
        self.assertIsNone(broker._parked)
        self.assertEqual(list(broker._pending), [("text", "y"), ("enter", "")])

    def test_unfinished_old_sequences_deny_approval_and_keep_normal_input(self):
        cases = [(b"\x1b[200~", b"y\x1b[201~\r", "y"),
                 (b"\x1b[200~y\x1b[20", b"1~\r", "y"),
                 ("\u754c".encode("utf8")[:1], "\u754c".encode("utf8")[1:] + b"\r", "\u754c"),
                 (b"\x1b", b"y\r", "y"),
                 (b"\x1b[M", bytes([96, 37, 37]) + b"y\r", "y")]
        for prefix, suffix, text in cases:
            with self.subTest(prefix=prefix):
                broker = footer_input._InputBroker()
                self.put(broker, broker._posix_decoder.feed(prefix))
                with patch.object(footer_input, "os", types.SimpleNamespace(name="posix")), \
                        patch.object(broker, "_posix_pump", return_value=True):
                    broker._thread = threading.Thread(target=broker._run, daemon=True)
                    broker._thread.start()
                    try:
                        with self.assertRaisesRegex(EOFError, "Incomplete terminal input"):
                            broker.begin_reader(fresh=True)
                        self.assertIsNone(broker._parked)
                        self.put(broker, broker._posix_decoder.feed(suffix))
                        result = footer_input._drive(EditBuffer(), lambda *_: None,
                                                     footer_input._broker_events(broker))
                        self.assertEqual(result, text)
                    finally:
                        broker.close()

    def test_unfinished_utf16_denies_approval_and_preserves_completion(self):
        broker = footer_input._InputBroker()
        self.put(broker, broker._windows_decoder.feed(True, 1, 0, "\ud83d"))
        with patch.object(footer_input, "os", types.SimpleNamespace(name="nt")), \
                patch.object(broker, "_windows_pump", return_value=True):
            broker._thread = threading.Thread(target=broker._run, daemon=True)
            broker._thread.start()
            try:
                with self.assertRaisesRegex(EOFError, "Incomplete terminal input"):
                    broker.begin_reader(fresh=True)
                self.put(broker, broker._windows_decoder.feed(True, 1, 0, "\ude42"))
                self.put(broker, [("enter", "")])
                result = footer_input._drive(EditBuffer(), lambda *_: None,
                                             footer_input._broker_events(broker))
                self.assertEqual(result, "\U0001f642")
            finally:
                broker.close()

    def test_fresh_prompt_cancel_during_boundary_is_immediate_and_preserves_typing(self):
        for during_pump, drained in ((False, True), (True, True), (True, False)):
            with self.subTest(during_pump=during_pump, drained=drained):
                broker = footer_input._InputBroker()
                self.put(broker, [("text", "old-y"), ("enter", "")])
                injected = []

                def pump():
                    if during_pump and broker._barriers and not injected:
                        broker._put([("interrupt", ""), ("interrupt", "")])
                        injected.append(True)
                    return drained

                def visible(text, cursor):
                    if not during_pump and not injected:
                        self.put(broker, [("interrupt", ""), ("interrupt", "")])
                        injected.append(True)

                with patch.object(footer_input, "_SESSION_ACTIVE", True), \
                        patch.object(footer_input, "_BROKER", broker), \
                        patch.object(footer_input, "_reader_mode", return_value=nullcontext()), \
                        patch.object(broker, "_windows_pump", side_effect=pump), \
                        patch.object(broker, "_posix_pump", side_effect=pump):
                    broker._thread = threading.Thread(target=broker._run, daemon=True)
                    broker._thread.start()
                    try:
                        with self.assertRaises(KeyboardInterrupt):
                            footer_input.read_line(visible, fresh=True)
                        self.assertEqual(injected, [True])
                        self.assertFalse(footer_input._READ_ACTIVE)
                        self.assertIsNone(broker._parked)
                        self.assertEqual(list(broker._urgent), [])
                        self.assertEqual(list(broker._pending), [("text", "old-y"), ("enter", "")])
                        self.assertEqual(footer_input.read_line(lambda *_: None), "old-y")
                    finally:
                        broker.close()

    def test_partial_decoder_state_is_shared_between_prompt_phases(self):
        decoder = PosixKeyDecoder()
        broker = footer_input._InputBroker()
        self.put(broker, decoder.feed("\u754c".encode("utf8")[:1]))
        self.assertEqual(list(broker._pending), [])
        self.put(broker, decoder.feed("\u754c".encode("utf8")[1:] + b"\x1b[200~first\r"))
        self.put(broker, decoder.feed(b"\nsecond\x1b[201~\r"))
        self.assertEqual(list(broker._pending), [("text", "\u754cfirst\nsecond"), ("enter", "")])

    def test_reader_callback_failure_restores_parked_input_and_ownership(self):
        broker = footer_input._InputBroker()
        broker._parked = (deque([("text", "old"), ("enter", "")]), deque())
        self.put(broker, [("text", "new")])
        with patch.object(footer_input, "_SESSION_ACTIVE", True), \
                patch.object(footer_input, "_BROKER", broker), \
                patch.object(footer_input, "_reader_mode", return_value=nullcontext()):
            def change(text, cursor):
                if text:
                    raise ValueError("render")
            with self.assertRaisesRegex(ValueError, "render"):
                footer_input.read_line(change)
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertIsNone(broker._parked)
        self.assertEqual(list(broker._pending), [("text", "old"), ("enter", "")])

    def test_close_stops_worker_and_clears_session_owned_queues(self):
        broker = footer_input._InputBroker()
        self.put(broker, [("text", "old"), ("enter", ""), ("scroll_up", 2)])
        broker.close()
        self.assertEqual(list(broker._pending), [])
        self.assertEqual(broker.navigation(), [])
        with self.assertRaises(EOFError):
            broker.event()


if __name__ == "__main__":
    unittest.main()
