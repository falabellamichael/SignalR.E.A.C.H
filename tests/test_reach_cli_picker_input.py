"""Picker keys share the footer reader and restore its input ownership."""

import os
import sys
import unittest
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

# terminal initializes the compatibility command exports before commands.
from reach_cli import terminal, chatbox, commands, footer, footer_input, picker


class _MenuScreen:
    def __init__(self):
        self.frames = []
        self.rows = 14
        self.cleared = 0
        self.started = 0
        self.closed = 0

    def set_menu(self, title, choices, selected=0, current=None):
        self.frames.append((title, tuple(choices), selected, current, self.rows))

    def snapshot(self):
        return {"geometry": {"transcript_rows": self.rows}}

    def clear_menu(self):
        self.cleared += 1

    def start(self):
        self.started += 1
        return True

    def close(self):
        self.closed += 1


class PickerInputTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(footer_input, "_READ_ACTIVE", False))
        self.stack.enter_context(mock.patch.object(footer_input, "_MENU_ACTIVE", False))
        self.stack.enter_context(mock.patch.object(footer_input, "_SESSION_ACTIVE", False))
        self.stack.enter_context(mock.patch.object(footer_input, "_BROKER", None))
        self.stack.enter_context(mock.patch.object(picker, "available", return_value=True))
        self.screen = _MenuScreen()
        self.stack.enter_context(mock.patch.object(chatbox, "active_footer", return_value=self.screen))
        self.choices = tuple(("choice%d" % index, "Choice %d" % index, "Detail %d" % index)
                             for index in range(24))
        self.lifecycle = []

    def events(self, keys):
        try:
            self.lifecycle.append("opened")
            self.assertTrue(footer_input._READ_ACTIVE)
            self.assertTrue(footer_input._MENU_ACTIVE)
            for event in keys:
                if callable(event):
                    event()
                elif isinstance(event, BaseException):
                    raise event
                else:
                    yield event
        finally:
            self.lifecycle.append("closed")

    def choose(self, keys, current="choice10", quick_pick=False):
        # Patch only the OS source; exercise read_keys and ownership cleanup.
        with mock.patch.object(footer_input, "os", SimpleNamespace(name="nt")), \
                mock.patch.object(footer_input, "_windows_events", return_value=self.events(keys)):
            result = picker.choose("Select endpoint", self.choices, current=current,
                                   quick_pick=quick_pick)
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)
        self.assertEqual(self.lifecycle[-2:], ["opened", "closed"])
        return result

    def test_native_windows_navigation_selects_the_painted_row(self):
        cases = ((0x26, "up", 9), (0x28, "down", 11),
                 (0x25, "left", 9), (0x27, "right", 11),
                 (0x24, "home", 0), (0x23, "end", 23),
                 (0x21, "scroll_page_up", 0), (0x22, "scroll_page_down", 20))
        for virtual_key, normalized, selected in cases:
            with self.subTest(key=normalized):
                decoder = footer_input.WindowsKeyDecoder()
                event = decoder.feed(True, 1, virtual_key, "\0")
                self.assertEqual(event, [(normalized, "")])
                keys = event + decoder.feed(True, 1, 0x0d, "\r")
                result = self.choose(keys)
                self.assertEqual(result, self.choices[selected][0])
                self.assertEqual(self.screen.frames[-1][2], selected)

    def test_native_posix_navigation_selects_the_painted_row(self):
        cases = ((b"\x1b[A", "up", 9), (b"\x1b[B", "down", 11),
                 (b"\x1b[D", "left", 9), (b"\x1b[C", "right", 11),
                 (b"\x1b[H", "home", 0), (b"\x1b[F", "end", 23),
                 (b"\x1b[5~", "scroll_page_up", 0),
                 (b"\x1b[6~", "scroll_page_down", 20))
        for sequence, normalized, selected in cases:
            with self.subTest(key=normalized):
                decoder = footer_input.PosixKeyDecoder()
                event = []
                for byte in sequence:
                    event.extend(decoder.feed(bytes([byte])))
                self.assertEqual(event, [(normalized, "")])
                result = self.choose(event + decoder.feed(b"\r"))
                self.assertEqual(result, self.choices[selected][0])
                self.assertEqual(self.screen.frames[-1][2], selected)

    def test_native_escape_cancels_and_closes_reader_on_both_platforms(self):
        windows = footer_input.WindowsKeyDecoder().feed(True, 1, 0x1b, "\x1b")
        posix = footer_input.PosixKeyDecoder()
        self.assertEqual(posix.feed(b"\x1b"), [])
        for events in (windows, posix.flush_escape()):
            with self.subTest(events=events):
                self.assertEqual(events, [("escape", "")])
                before = len(self.screen.frames)
                self.assertIsNone(self.choose(events))
                self.assertEqual(len(self.screen.frames), before + 1)
        self.assertEqual(self.screen.cleared, 2)
        self.assertEqual(self.screen.closed, 0, "the retained session screen must stay open")

    def test_standalone_posix_source_closes_after_enter(self):
        events = footer_input.PosixKeyDecoder().feed(b"\x1b[B\r")
        with mock.patch.object(footer_input, "os", SimpleNamespace(name="posix")), \
                mock.patch.object(footer_input, "_posix_events", return_value=self.events(events)), \
                mock.patch.object(footer_input, "_windows_events", side_effect=AssertionError("wrong platform reader")):
            result = picker.choose("Select endpoint", self.choices, current="choice10")
        self.assertEqual(result, "choice11")
        self.assertEqual(self.lifecycle, ["opened", "closed"])
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)

    def test_posix_escape_waits_for_sequence_timeout_and_retains_split_arrow(self):
        decoder = footer_input.PosixKeyDecoder()
        with mock.patch.object(footer_input.time, "monotonic", return_value=20.0):
            self.assertEqual(decoder.feed(b"\x1b"), [])
        with mock.patch.object(footer_input.time, "monotonic", return_value=20.02):
            self.assertEqual(decoder.flush_escape(force=False), [])
        self.assertEqual(decoder.feed(b"[A"), [("up", "")])
        self.assertEqual(decoder.flush_escape(), [])
        with mock.patch.object(footer_input.time, "monotonic", return_value=30.0):
            self.assertEqual(decoder.feed(b"\x1b"), [])
        with mock.patch.object(footer_input.time, "monotonic", return_value=30.1):
            self.assertEqual(decoder.flush_escape(force=False), [("escape", "")])
        self.assertEqual(decoder.flush_escape(), [])

    def test_resize_uses_new_page_size_without_moving_the_current_row(self):
        def resize():
            self.screen.rows = 7
        result = self.choose([
            ("down", ""), resize, ("resize", ""),
            ("scroll_page_down", ""), ("enter", ""),
        ])
        self.assertEqual(result, "choice14")
        self.assertEqual([(frame[2], frame[4]) for frame in self.screen.frames],
                         [(10, 14), (11, 14), (11, 7), (14, 7)])

    def test_text_and_bracketed_pasted_commands_cannot_change_endpoint_selection(self):
        decoder = footer_input.PosixKeyDecoder()
        pasted = decoder.feed(b"\x1b[200~/endpoint remove choice10\r\n3\x1b[A\x03\x1b[201~")
        self.assertTrue(all(key == "text" for key, _value in pasted))
        result = self.choose([("text", "j"), ("text", "q"), ("text", "3")] + pasted + [("enter", "")])
        self.assertEqual(result, "choice10")
        self.assertEqual(len(self.screen.frames), 1)

    def test_model_picker_retains_single_digit_quick_selection(self):
        with mock.patch.object(picker, "choose", wraps=picker.choose) as choose, \
                mock.patch.object(footer_input, "os", SimpleNamespace(name="nt")), \
                mock.patch.object(footer_input, "_windows_events", return_value=self.events([("text", "3")])):
            result = commands._interactive_pick_model(["a", "b", "c"], current="a")
        self.assertEqual(result, "c")
        self.assertTrue(choose.call_args.kwargs["quick_pick"])
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)
        self.assertEqual(self.lifecycle, ["opened", "closed"])

    def test_multicharacter_numeric_text_is_not_a_model_quick_pick(self):
        result = self.choose([("text", "12"), ("text", "0"), ("enter", "")], quick_pick=True)
        self.assertEqual(result, "choice10")

    def test_interrupt_eof_and_source_failures_restore_menu_and_reader(self):
        cases = ([('interrupt', '')], [('eof', '')], [KeyboardInterrupt()], [EOFError()])
        for events in cases:
            with self.subTest(events=events):
                self.assertIsNone(self.choose(events))
        self.assertEqual(self.screen.cleared, len(cases))

    def test_callback_failure_restores_reader_flags_and_closes_event_source(self):
        with mock.patch.object(footer_input, "os", SimpleNamespace(name="nt")), \
                mock.patch.object(footer_input, "_windows_events", return_value=self.events([("down", "")])):
            with self.assertRaisesRegex(ValueError, "paint failed"):
                footer_input.read_keys(mock.Mock(side_effect=ValueError("paint failed")))
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)
        self.assertEqual(self.lifecycle, ["opened", "closed"])

    def test_picker_render_failure_clears_menu_and_restores_reader(self):
        paint = self.screen.set_menu
        calls = []

        def repaint(*args, **kwargs):
            calls.append(True)
            if len(calls) > 1:
                raise ValueError("paint failed")
            return paint(*args, **kwargs)

        with mock.patch.object(self.screen, "set_menu", side_effect=repaint):
            with self.assertRaisesRegex(ValueError, "paint failed"):
                self.choose([("down", "")])
        self.assertEqual(self.screen.cleared, 1)
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)
        self.assertEqual(self.lifecycle, ["opened", "closed"])

    def test_owned_standalone_screen_closes_on_enter_and_cancel(self):
        for keys, expected in (([("enter", "")], "choice10"), ([("eof", "")], None)):
            with self.subTest(keys=keys):
                owned = _MenuScreen()
                with mock.patch.object(chatbox, "active_footer", return_value=None), \
                        mock.patch.object(footer, "FooterScreen", return_value=owned):
                    result = self.choose(keys)
                self.assertEqual(result, expected)
                self.assertEqual((owned.started, owned.cleared, owned.closed), (1, 1, 1))

    def test_owned_screen_closes_even_when_clearing_menu_repaint_fails(self):
        owned = _MenuScreen()
        with mock.patch.object(chatbox, "active_footer", return_value=None), \
                mock.patch.object(footer, "FooterScreen", return_value=owned), \
                mock.patch.object(owned, "clear_menu", side_effect=ValueError("clear failed")) as clear:
            with self.assertRaisesRegex(ValueError, "clear failed"):
                self.choose([("enter", "")])
        clear.assert_called_once_with()
        self.assertEqual((owned.started, owned.closed), (1, 1))
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)
        self.assertEqual(self.lifecycle, ["opened", "closed"])


class PickerBrokerTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.broker = footer_input._InputBroker()
        self.addCleanup(self.broker.close)
        self.stack.enter_context(mock.patch.object(footer_input, "_READ_ACTIVE", False))
        self.stack.enter_context(mock.patch.object(footer_input, "_MENU_ACTIVE", False))
        self.stack.enter_context(mock.patch.object(footer_input, "_SESSION_ACTIVE", True))
        self.stack.enter_context(mock.patch.object(footer_input, "_BROKER", self.broker))
        self.mode = []

    def put(self, events):
        with self.broker._condition:
            self.broker._put(events)

    @contextmanager
    def reader_mode(self, events):
        self.mode.append("raw")
        self.assertTrue(footer_input._READ_ACTIVE)
        self.assertTrue(footer_input._MENU_ACTIVE)
        self.put(events)
        try:
            yield
        finally:
            self.mode.append("restored")

    def test_session_routes_page_and_wheel_to_menu_then_back_to_transcript(self):
        events = [("scroll_page_down", ""), ("scroll_up", 2),
                  ("scroll_down", 1), ("scroll_page_up", ""), ("enter", "")]
        seen = []

        def keypress(key, value):
            seen.append((key, value))
            self.assertEqual(footer_input.poll_scroll_events(), [])
            self.assertEqual(footer_input.poll_ui_events(), [])
            return key == "enter"

        with mock.patch.object(footer_input, "_reader_mode", side_effect=lambda: self.reader_mode(events)), \
                mock.patch.object(self.broker, "begin_reader", wraps=self.broker.begin_reader) as begin, \
                mock.patch.object(self.broker, "end_reader", wraps=self.broker.end_reader) as end, \
                mock.patch.object(footer_input, "_windows_events", side_effect=AssertionError("second native reader")), \
                mock.patch.object(footer_input, "_posix_events", side_effect=AssertionError("second native reader")):
            footer_input.read_keys(keypress)
        self.assertEqual(seen, events)
        self.assertEqual(self.mode, ["raw", "restored"])
        begin.assert_called_once_with(False)
        end.assert_called_once_with()
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)
        self.put(events[:-1])
        self.assertEqual(list(self.broker._pending), [])
        self.assertEqual(footer_input.poll_scroll_events(), [
            ("page_down", 1), ("up", 2), ("down", 1), ("page_up", 1),
        ])

    def test_session_interrupt_and_eof_restore_input_mode_and_end_reader(self):
        for event, error in (("interrupt", KeyboardInterrupt), ("eof", EOFError)):
            with self.subTest(event=event), \
                    mock.patch.object(footer_input, "_reader_mode", side_effect=lambda: self.reader_mode([(event, "")])), \
                    mock.patch.object(self.broker, "end_reader", wraps=self.broker.end_reader) as end:
                with self.assertRaises(error):
                    footer_input.read_keys(lambda *_: False)
                end.assert_called_once_with()
                self.assertFalse(footer_input._READ_ACTIVE)
                self.assertFalse(footer_input._MENU_ACTIVE)
        self.assertEqual(self.mode, ["raw", "restored", "raw", "restored"])

    def test_windows_session_mode_is_restored_after_menu_interrupt(self):
        native = SimpleNamespace(SetConsoleMode=mock.Mock(return_value=True))
        with mock.patch.object(footer_input, "os", SimpleNamespace(name="nt")), \
                mock.patch.object(footer_input, "_windows_console_mode", return_value=(native, 42, 0x0207)):
            with self.assertRaises(KeyboardInterrupt):
                with footer_input._key_reader(menu=True) as events:
                    self.put([("interrupt", "")])
                    key, _value = next(events)
                    self.assertEqual(key, "interrupt")
                    raise KeyboardInterrupt
        self.assertEqual(native.SetConsoleMode.call_args_list[-1], mock.call(42, 0x0207))
        self.assertEqual(native.SetConsoleMode.call_count, 2)
        self.assertFalse(footer_input._READ_ACTIVE)
        self.assertFalse(footer_input._MENU_ACTIVE)


if __name__ == "__main__":
    unittest.main()
