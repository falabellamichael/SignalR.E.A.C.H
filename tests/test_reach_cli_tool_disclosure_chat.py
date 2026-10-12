"""Tool disclosure integration retains each call's arguments, output and history."""

import contextlib
import io
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import chat, chatbox, terminal  # noqa: E402


class DisclosureScreen:
    def __init__(self):
        self.calls = []
        self.finished = []

    def begin_tool_call(self, summary, details):
        token = object()
        self.calls.append((token, summary, details))
        return token

    def finish_tool_call(self, token, details):
        self.finished.append((token, details))
        return True


class ToolDisclosureChatTests(unittest.TestCase):
    def setUp(self):
        paint = mock.patch.object(terminal, "PAINT", terminal.Paint(False))
        paint.start()
        self.addCleanup(paint.stop)
        self.screen = DisclosureScreen()
        screen = mock.patch.object(chatbox, "active_footer", return_value=self.screen)
        screen.start()
        self.addCleanup(screen.stop)
        self.output = io.StringIO()
        stdout = contextlib.redirect_stdout(self.output)
        stdout.__enter__()
        self.addCleanup(stdout.__exit__, None, None, None)

    def body(self, index=0):
        return "\n".join(self.screen.calls[index][2])

    def results(self, index=0):
        return "\n".join(self.screen.finished[index][1])

    def test_arrow_header_defers_arguments_and_result_to_its_body(self):
        token = chat.show_tool_call("read", {"path": "sample.txt", "startLine": 3})
        chat.show_tool_result("read", "sample.txt (2 lines)\n3 | first\n4 | last", token=token)
        self.assertEqual(self.output.getvalue(), "")
        self.assertEqual(self.screen.calls[0][1], "  > read  path=sample.txt startLine=3")
        self.assertIn('"startLine": 3', self.body())
        self.assertIn("✓ 2 lines", self.results())
        self.assertIn("4 | last", self.results())
        self.assertIs(self.screen.calls[0][0], self.screen.finished[0][0])

    def test_full_arguments_beyond_compact_preview_are_available(self):
        value = "prefix " + "x" * 150 + " retained tail"
        chat.show_tool_call("search", {"pattern": value, "regex": True})
        self.assertNotIn("retained tail", self.screen.calls[0][1])
        self.assertIn(value, self.body())
        self.assertIn('"regex": true', self.body())

    def test_edit_has_argument_values_and_colored_diff_in_body(self):
        chat.show_tool_call("edit", {
            "path": "sample.py", "search": "before = 1", "replace": "after = 2"})
        self.assertEqual(self.screen.calls[0][1], "  > edit  sample.py")
        self.assertIn("- before = 1", self.body())
        self.assertIn("+ after = 2", self.body())
        self.assertEqual(self.output.getvalue(), "")

    def test_hidden_arguments_and_output_use_existing_credential_redaction(self):
        token = chat.show_tool_call("shell", {
            "command": "echo useful", "api_key": "private-key",
            "password": "private-password", "note": "\x1b[2Jnormal"})
        chat.show_tool_result("shell", "exit code 0\nTOKEN=private-token\nuseful output", token=token)
        shown = self.body() + self.results()
        for secret in ("private-key", "private-password", "private-token"):
            self.assertNotIn(secret, shown)
        self.assertIn("[redacted]", shown)
        self.assertNotIn("\x1b", shown)
        self.assertIn("useful output", shown)

    def test_sensitive_nested_argument_subtrees_are_redacted_before_serialization(self):
        chat.show_tool_call("write_json", {
            "path": "config.json", "data": {
                "credential": {"value": "fixture-private-value"},
                "authorization": ["fixture-private-list-value"],
                "nested": [{"password": {"private": "fixture-private-nested-value"}}],
                "useful": {"name": "retained"}}})
        shown = self.body()
        for secret in ("fixture-private-value", "fixture-private-list-value",
                       "fixture-private-nested-value"):
            self.assertNotIn(secret, shown)
        self.assertIn('"credential": "[redacted]"', shown)
        self.assertIn('"authorization": "[redacted]"', shown)
        self.assertIn('"password": "[redacted]"', shown)
        self.assertIn('"name": "retained"', shown)

    def test_env_write_and_edit_content_preserve_file_redaction(self):
        for tool, fields in (("write_file", {"content": "CUSTOM=private-value"}),
                             ("edit", {"search": "CUSTOM=old-value", "replace": "CUSTOM=new-value"})):
            with self.subTest(tool=tool):
                chat.show_tool_call(tool, dict(path="config/.env", **fields))
                shown = self.body(-1)
                for secret in ("private-value", "old-value", "new-value"):
                    self.assertNotIn(secret, shown)
                self.assertIn("CUSTOM=[redacted]", shown)

    def test_plain_or_older_screen_keeps_compact_output_and_edit_diff(self):
        for screen in (None, SimpleNamespace()):
            with self.subTest(screen=screen), mock.patch.object(chatbox, "active_footer", return_value=screen):
                self.output.seek(0)
                self.output.truncate(0)
                token = chat.show_tool_call("edit", {
                    "path": "a.py", "search": "old", "replace": "new"})
                self.assertIsNone(token)
                chat.show_tool_result("edit", "updated a.py", token=token)
                self.assertIn("  > edit  a.py\n", self.output.getvalue())
                self.assertIn("      - old\n", self.output.getvalue())
                self.assertIn("✓ updated a.py", self.output.getvalue())

    def test_inactive_screen_declining_call_uses_plain_fallback(self):
        with mock.patch.object(self.screen, "begin_tool_call", return_value=None):
            token = chat.show_tool_call("list", {"path": "src"})
        self.assertIsNone(token)
        self.assertEqual(self.output.getvalue(), "  > list  path=src\n")

    def test_cosmetic_api_failure_does_not_interrupt_tool_output(self):
        with mock.patch.object(self.screen, "begin_tool_call", side_effect=RuntimeError("paint failed")):
            self.assertIsNone(chat.show_tool_call("list", {"path": "src"}))
        token = chat.show_tool_call("read", {"path": "sample.txt"})
        with mock.patch.object(self.screen, "finish_tool_call", side_effect=RuntimeError("paint failed")):
            chat.show_tool_result("read", "sample.txt (1 lines)\n1 | text", token=token)
        self.assertIn("  > list  path=src", self.output.getvalue())
        self.assertIn("✓ 1 lines", self.output.getvalue())

    def test_completion_uses_original_screen_even_when_active_footer_changes(self):
        token = chat.show_tool_call("read", {"path": "sample.txt"})
        other = DisclosureScreen()
        with mock.patch.object(chatbox, "active_footer", return_value=other):
            chat.show_tool_result("read", "sample.txt (1 lines)\n1 | body", token=token)
        self.assertEqual(len(self.screen.finished), 1)
        self.assertEqual(other.finished, [])

    def test_native_batch_pairs_distinct_tokens_and_retains_tool_history(self):
        calls = [{"id": "first", "function": {"name": "read", "arguments": '{"path":"a.txt"}'}},
                 {"id": "second", "function": {"name": "read", "arguments": '{"path":"b.txt"}'}}]
        with mock.patch.object(chat, "_run_pet_tool", side_effect=["A body", "B body"]):
            history = chat._execute_native(SimpleNamespace(workpath="fixture"), calls, chat.AgentState())
        self.assertEqual(history, [{"role": "tool", "tool_call_id": "first", "content": "A body"},
                                   {"role": "tool", "tool_call_id": "second", "content": "B body"}])
        self.assertEqual([item[0] for item in self.screen.calls],
                         [item[0] for item in self.screen.finished])
        self.assertIsNot(self.screen.calls[0][0], self.screen.calls[1][0])
        self.assertIn("A body", self.results(0))
        self.assertNotIn("B body", self.results(0))
        self.assertIn("B body", self.results(1))

    def test_fenced_batch_preserves_model_results_and_call_ownership(self):
        actions = [{"action": "read", "path": "a.txt"}, {"action": "list", "path": "src"}]
        with mock.patch.object(chat, "_run_pet_tool", side_effect=["A body", "src entries"]):
            history = chat._execute_actions(SimpleNamespace(workpath="fixture"), actions, chat.AgentState())
        self.assertEqual(history, '[tool result]\ntool read {"path": "a.txt"}:\nA body\n\n'
                         'tool list {"path": "src"}:\nsrc entries')
        self.assertEqual([item[0] for item in self.screen.calls],
                         [item[0] for item in self.screen.finished])

    def test_unreadable_native_arguments_get_failure_details_without_execution(self):
        calls = [{"id": "bad", "function": {"name": "read", "arguments": "[]"}}]
        with mock.patch.object(chat, "_run_pet_tool") as run:
            history = chat._execute_native(SimpleNamespace(workpath="fixture"), calls, chat.AgentState())
        run.assert_not_called()
        self.assertIn("arguments must be a JSON object", history[0]["content"])
        self.assertIn("✗", self.results())
        self.assertIn("resend the call", self.results())

    def test_cancellation_finishes_only_started_disclosure_and_native_history(self):
        calls = [{"id": name, "function": {"name": "read", "arguments": '{"path":"a.txt"}'}}
                 for name in ("started", "unstarted")]
        with mock.patch.object(chat, "_run_pet_tool", side_effect=KeyboardInterrupt):
            with self.assertRaises(chat._ToolCancelled) as caught:
                chat._execute_native(SimpleNamespace(workpath="fixture"), calls, chat.AgentState())
        self.assertEqual(len(self.screen.calls), 1)
        self.assertEqual(len(self.screen.finished), 1)
        self.assertIn("tool stopped by the user", self.results())
        self.assertEqual([item["tool_call_id"] for item in caught.exception.messages],
                         ["started", "unstarted"])


if __name__ == "__main__":
    unittest.main()
