"""Pinned editor ownership and plain-input compatibility regressions."""
import io
import os
import sys
import unittest
from contextlib import nullcontext
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'tools'))
from reach_cli import terminal, prompt, chatbox


class ResizeInputTests(unittest.TestCase):
    def tearDown(self):
        chatbox._SCREEN = None

    def test_injected_reader_is_plain_and_preserves_continuation(self):
        output = io.StringIO()
        answers = iter(['one \\', 'two'])
        with patch.object(chatbox, 'box_width', return_value=40):
            self.assertEqual(chatbox.read_boxed(None, lambda _: next(answers), output),
                             ['one ', 'two'])
        self.assertNotIn('\x1b[2J', output.getvalue())
        self.assertNotIn('\x1b[?1049', output.getvalue())

    def test_plain_nonterminal_fallback_preserves_draft(self):
        output = io.StringIO()
        with patch.object(terminal, 'PAINT', terminal.Paint(True)), \
             patch('sys.stdout', output), patch('builtins.input', return_value='  draft  '), \
             patch.object(terminal, 'load_readline', return_value=None), \
             patch.object(prompt, '_remember_history'):
            self.assertEqual(prompt.read_prompt(), '  draft  ')
        self.assertNotIn('\x1b[?1049', output.getvalue())

    def test_windows_pinned_editor_requires_no_optional_package(self):
        with patch.object(chatbox.os, 'name', 'nt'):
            self.assertTrue(chatbox.editor_available())

    def test_live_prompt_delegates_to_owned_editor(self):
        with patch.object(chatbox, 'read_boxed', return_value=['draft']) as read, \
             patch.object(prompt, '_remember_history'):
            self.assertEqual(prompt._read_boxed(None, None, None), 'draft')
        read.assert_called_once_with(None)

    def test_live_input_without_owned_screen_fails_safely(self):
        with self.assertRaisesRegex(RuntimeError, 'active footer'):
            chatbox.read_boxed(None)

    def test_unicode_echo_preserves_text_and_spaces(self):
        text = '  \u6f22\u5b57 e\u0301 ' * 30
        rows = chatbox._wrap_display(text, 8)
        self.assertEqual(''.join(rows), text)
        self.assertTrue(all(terminal.display_width(row) <= 8 for row in rows))
        for row in chatbox.echo_box(text, 24):
            self.assertLessEqual(chatbox.visible_width(row), 24)

    def test_chrome_fits_tiny_terminals_with_statistics(self):
        for width in (1, 6, 8, 18):
            for line in (chatbox.box_top(width), chatbox.box_row(width, 'draft'),
                         chatbox.box_bottom(width, stats='3 turns, 9.8k tok')):
                self.assertLessEqual(chatbox.visible_width(line), width)

    def test_approval_falls_back_without_footer(self):
        with patch('builtins.input', return_value='n') as reader:
            self.assertEqual(terminal.read_input('allow? '), 'n')
        reader.assert_called_once_with('allow? ')

    def test_session_restores_stdout_and_footer_on_error(self):
        class Screen(io.StringIO):
            started = False
            stopped = False
            def __init__(self, client, output):
                super().__init__()
            def start(self):
                self.started = True
                return True
            def close(self):
                self.stopped = True
        output = io.StringIO()
        with patch('reach_cli.prompt.use_chatbox', return_value=True), \
             patch('reach_cli.footer.FooterScreen', Screen), \
             patch('reach_cli.footer_input.session_input_mode', return_value=nullcontext()), \
             patch('sys.stdout', output):
            with self.assertRaisesRegex(ValueError, 'fixture'):
                with chatbox.footer_session(None) as screen:
                    self.assertIs(sys.stdout, screen)
                    self.assertTrue(screen.started)
                    raise ValueError('fixture')
            self.assertIs(sys.stdout, output)
            self.assertTrue(screen.stopped)
            self.assertIsNone(chatbox.active_footer())


if __name__ == '__main__':
    unittest.main()
