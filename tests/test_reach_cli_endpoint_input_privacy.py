"""Submitted endpoint echo/history cannot retain supplied credential values."""

import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tests import test_reach_cli_agent_completion as helpers
from reach_cli import chatbox, input_privacy, prompt


RAW = '/endpoint add fixture https://user:secret_value@example.invalid/v1?api_key=query_secret#fragment_secret --key "literal_secret"'


class InputPrivacyTests(unittest.TestCase):
    def assert_private(self, text):
        for secret in ("secret_value", "query_secret", "fragment_secret", "literal_secret"):
            self.assertNotIn(secret, text)

    def test_userinfo_query_fragment_and_literal_key_are_redacted_together(self):
        visible = input_privacy.sanitize_endpoint_command(RAW)
        self.assert_private(visible)
        self.assertIn("https://[redacted]@example.invalid/v1?[redacted]", visible)
        self.assertIn("--key [redacted]", visible)

    def test_alias_quotes_equals_unclosed_quotes_and_multiline_key_values(self):
        for command in ("/endpoint", "/endpoints", "/ENDPOINTS"):
            for option in ('--key=literal_secret', "--key 'literal_secret'",
                           '--key "literal_secret', '--api-key literal_secret',
                           '--key "literal_secret\nsecond_secret"'):
                with self.subTest(command=command, option=option):
                    visible = input_privacy.sanitize_endpoint_command(command + " add fixture https://example.invalid/v1 " + option)
                    self.assert_private(visible)
                    self.assertNotIn("second_secret", visible)

    def test_ordinary_prose_quoted_code_and_supported_key_reference_are_unchanged(self):
        texts = ["Explain --key literal_secret and https://user:secret_value@example.invalid/v1",
                 "```text\n" + RAW + "\n```", "/other " + RAW,
                 '/endpoint add fixture https://example.invalid/v1 --key-env FIXTURE_API_KEY',
                 "/endpoint list", "/endpoints remove fixture"]
        for text in texts:
            with self.subTest(text=text):
                self.assertEqual(input_privacy.sanitize_endpoint_command(text), text)

    def test_malformed_urls_and_terminal_controls_cannot_expose_credential_components(self):
        text = "/endpoint add fixture https://user:secret_value@[invalid:port]/v1?query_secret\x1b[2J"
        visible = input_privacy.sanitize_endpoint_command(text)
        self.assert_private(visible)
        self.assertNotIn("\x1b", visible)

    def test_boxed_echo_is_safe_but_original_command_reaches_dispatch(self):
        out = io.StringIO()
        client = helpers.ScriptClient([], "")
        chunks = chatbox.read_boxed(client, lambda _prompt: RAW, out)
        self.assertEqual(chunks, [RAW])
        self.assert_private(out.getvalue())

    def test_pinned_echo_is_safe_and_original_command_is_returned(self):
        screen = mock.Mock()
        client = helpers.ScriptClient([], "")
        with mock.patch.object(chatbox, "active_footer", return_value=screen), \
                mock.patch("reach_cli.footer_input.read_line", return_value=RAW):
            chunks = chatbox.read_boxed(client)
        self.assertEqual(chunks, [RAW])
        self.assert_private(screen.finish_input.call_args.args[0])

    def test_initial_prompt_echo_is_safe_while_dispatch_validates_original(self):
        screen = mock.Mock()
        client = helpers.ScriptClient([], "")
        with mock.patch.object(chatbox, "active_footer", return_value=screen), \
                mock.patch.object(helpers.chat, "banner"), \
                mock.patch.object(helpers.chat, "endpoint_notice"), \
                mock.patch.object(helpers.chat, "ReplSession"), \
                mock.patch.object(helpers.chat, "cleanup_owned_processes"), \
                mock.patch.object(helpers.chat, "handle_slash", return_value=type("Quit", (), {"quit": True})()) as dispatch, \
                contextlib.redirect_stdout(io.StringIO()):
            helpers.chat._run_chat_loop(client, client.base, RAW)
        self.assert_private(screen.finish_input.call_args.args[0])
        self.assertEqual(dispatch.call_args.args[0], RAW)


class HistoryPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "fixture-history"
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(prompt, "history_file_path", return_value=str(self.path)))
        prompt.reset_readline_state()
        self.addCleanup(prompt.reset_readline_state)

    def test_plain_history_persists_only_redacted_submission(self):
        prompt._remember_history(RAW, None)
        text = self.path.read_text(encoding="utf-8")
        InputPrivacyTests.assert_private(self, text)
        self.assertIn("[redacted]", text)

    def test_readline_replaces_only_current_submission_and_keeps_earlier_history(self):
        path = self.path

        class Readline:
            rows = ["Earlier harmless question", RAW]
            def get_current_history_length(self):
                return len(self.rows)
            def get_history_item(self, index):
                return self.rows[index - 1]
            def replace_history_item(self, index, text):
                self.rows[index] = text
            def write_history_file(self, filename):
                Path(filename).write_text("\n".join(self.rows), encoding="utf-8")

        backend = Readline()
        prompt._READLINE_READY = True
        prompt._remember_history(RAW, backend)
        self.assertEqual(backend.rows[0], "Earlier harmless question")
        InputPrivacyTests.assert_private(self, path.read_text(encoding="utf-8"))

    def test_unreplaceable_readline_shim_never_serializes_unsafe_memory_later(self):
        backend = mock.Mock(spec=["write_history_file"])
        prompt._READLINE_READY = True
        prompt._remember_history(RAW, backend)
        prompt._remember_history("Later harmless question", backend)
        backend.write_history_file.assert_not_called()
        text = self.path.read_text(encoding="utf-8")
        InputPrivacyTests.assert_private(self, text)
        self.assertIn("Later harmless question", text)


if __name__ == "__main__":
    unittest.main()
