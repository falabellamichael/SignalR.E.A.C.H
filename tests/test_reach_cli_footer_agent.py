"""Offline regressions for approvals sharing the persistent footer editor."""

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach_cli import agent_tools, chat, chatbox, footer_input, terminal
from reach_cli.footer import FooterScreen


def native(name, arguments, ident):
    return {"id": ident, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments)}}


COMPLETE = '```agent_status\n{"status":"complete","summary":"Offline approval checked."}\n```'


class FakeTTY(io.StringIO):
    def isatty(self):
        return True


class FooterApprovalTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.tmp = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.work = Path(self.tmp)
        self.note = self.work / "note.txt"
        self.note.write_text("original safe fixture\n", encoding="utf-8")
        self.client = SimpleNamespace(
            base="http://offline.invalid/v1", model="fixture", agent=True,
            system="Offline approval fixture", workpath=str(self.work),
            usage={}, session_totals={}, last_turn=None,
        )
        self.tty = FakeTTY()
        self.screen = FooterScreen(
            self.client, self.tty, size=lambda: os.terminal_size((40, 12)))
        self.screen.start()
        self.addCleanup(self.screen.close)
        self.stack.enter_context(mock.patch.object(chatbox, "_SCREEN", self.screen))
        self.stack.enter_context(mock.patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(contextlib.redirect_stdout(self.screen))
        self.stack.enter_context(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")))
        self.stack.enter_context(mock.patch.object(agent_tools.subprocess, "run", side_effect=AssertionError("shell forbidden")))
        self.stack.enter_context(mock.patch("builtins.input", side_effect=AssertionError("owned footer must read native keys")))

    @staticmethod
    def answer(text):
        def read(on_change, history=(), initial=""):
            events = [("text", text), ("enter", "")]
            return footer_input._drive(footer_input.EditBuffer(initial, history), on_change, iter(events))
        return mock.patch.object(footer_input, "read_line", side_effect=read)

    def test_owned_approval_uses_footer_and_resets_draft(self):
        with self.answer("y") as reader:
            self.assertEqual(terminal.read_input("allow fixture?"), "y")
        reader.assert_called_once()
        snapshot = self.screen.snapshot()
        self.assertTrue(snapshot["active"])
        self.assertEqual(snapshot["text"], "")
        self.assertIn("allow fixture?", snapshot["transcript"])
        # The answer is not echoed into the transcript as a new user turn.
        self.assertNotIn("you", snapshot["transcript"])
        self.assertIn("allow", self.tty.getvalue())

    def test_unowned_approval_preserves_builtin_fallback(self):
        with mock.patch.object(chatbox, "_SCREEN", None), \
                mock.patch("builtins.input", return_value="n") as builtin, \
                mock.patch.object(footer_input, "read_line") as reader:
            self.assertEqual(terminal.read_input("allow fallback?"), "n")
        builtin.assert_called_once_with("allow fallback?")
        reader.assert_not_called()

    def test_interrupted_owned_approval_resets_and_propagates(self):
        def interrupted(on_change, history=(), initial=""):
            on_change("unfinished approval", 5)
            raise KeyboardInterrupt
        with mock.patch.object(footer_input, "read_line", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                chat.AgentState().approve("edit", "isolated fixture")
        snapshot = self.screen.snapshot()
        self.assertTrue(snapshot["active"])
        self.assertEqual((snapshot["text"], snapshot["cursor"]), ("", 0))

    def check_cancelled_batch(self, answer):
        calls = [native("read", {"path": "note.txt"}, "completed-read"),
                 native("edit", {"path": "note.txt", "search": "original", "replace": "changed"}, "cancelled-edit"),
                 native("shell", {"command": "must never execute"}, "pending-shell")]
        histories = []
        responses = iter([{"content": "", "tool_calls": calls},
                          {"content": COMPLETE, "tool_calls": []}])

        def reply(client, history, **kwargs):
            histories.append(copy.deepcopy(history))
            return True, next(responses)

        history = [{"role": "user", "content": "inspect then edit safely"}]
        state = chat.AgentState()
        with mock.patch.object(chat, "stream_reply", side_effect=reply), answer:
            self.assertFalse(chat.run_agent_turn(self.client, history, state))
            results = [m for m in history if m.get("role") == "tool"]
            self.assertEqual([m["tool_call_id"] for m in results],
                             ["completed-read", "cancelled-edit", "pending-shell"])
            self.assertIn("original safe fixture", results[0]["content"])
            self.assertTrue(all("stopped by the user" in m["content"] for m in results[1:]))
            history.append({"role": "user", "content": "continue from stopped turn"})
            self.assertTrue(chat.run_agent_turn(self.client, history, state))
        continued = [m for m in histories[1] if m.get("role") == "tool"]
        self.assertEqual(continued, results)
        self.assertEqual(self.note.read_text(encoding="utf-8"), "original safe fixture\n")
        self.assertEqual(self.client.session_totals["turns"], 2)
        self.assertTrue(self.screen.snapshot()["active"])

    def test_ctrlc_closes_native_batch_and_preserves_completed_results(self):
        self.check_cancelled_batch(mock.patch.object(footer_input, "read_line", side_effect=KeyboardInterrupt))

    def test_q_closes_native_batch_and_preserves_completed_results(self):
        self.check_cancelled_batch(self.answer("q"))

    def test_denial_never_starts_executor_or_resolves_write_target(self):
        calls = [native("shell", {"command": "must never execute"}, "denied-shell"),
                 native("edit", {"path": "note.txt", "search": "original", "replace": "changed"}, "denied-edit")]
        responses = iter([{"content": "", "tool_calls": calls},
                          {"content": COMPLETE, "tool_calls": []}])
        history = [{"role": "user", "content": "request actions requiring approval"}]
        with self.answer("n"), \
                mock.patch.object(chat, "stream_reply", side_effect=lambda *a, **kw: (True, next(responses))), \
                mock.patch.object(agent_tools, "_resolve", side_effect=AssertionError("write target must not resolve")) as resolve, \
                mock.patch.object(agent_tools.subprocess, "run") as executor:
            self.assertTrue(chat.run_agent_turn(self.client, history, chat.AgentState()))
        executor.assert_not_called()
        resolve.assert_not_called()
        results = [m for m in history if m.get("role") == "tool"]
        self.assertEqual([m["tool_call_id"] for m in results], ["denied-shell", "denied-edit"])
        self.assertTrue(all("denied by the user" in m["content"] for m in results))
        self.assertEqual(self.note.read_text(encoding="utf-8"), "original safe fixture\n")

    def test_auto_approval_persists_without_requesting_another_line(self):
        state = chat.AgentState()
        with self.answer("a") as reader:
            self.assertTrue(state.approve("edit", "isolated fixture"))
            self.assertTrue(state.approve("shell", "never executed in this test"))
        reader.assert_called_once()
        self.assertTrue(state.auto_approve)


if __name__ == "__main__":
    unittest.main(verbosity=2)
