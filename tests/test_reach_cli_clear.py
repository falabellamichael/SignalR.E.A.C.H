"""Conversation reset regressions; no endpoint or tool execution required."""

import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach_cli import chat, commands
from reach_cli.client import ReachClient


class ClearTests(unittest.TestCase):
    def test_clear_resets_agent_state_in_each_scope(self):
        for target in (None, "worker"):
            with self.subTest(scope=target):
                client = ReachClient("http://127.0.0.1:20777/v1")
                client.agent = True
                client.workpath = "."
                states = []

                def route(_client, line):
                    if line.startswith("@worker "):
                        return "worker", line[len("@worker "):]
                    return None, line

                def turn(_client, history, state):
                    states.append(state)
                    if len(states) == 1:
                        state.todos.append({"text": "old task", "status": "pending"})
                        state.selected_tools.add("old_tool")
                        state.auto_approve = True
                        state.resume_results = (True, True)
                        state.last_tool_results.append("old result")
                        client.last_thought = "old thought"
                        return False
                    self.assertEqual(state.todos, [])
                    self.assertEqual(state.selected_tools, set())
                    self.assertFalse(state.auto_approve)
                    self.assertIsNone(state.resume_results)
                    self.assertEqual(state.last_tool_results, [])
                    self.assertEqual(client.last_thought, "")
                    self.assertEqual([m["content"] for m in history if m["role"] == "user"], ["new task"])
                    return True

                prefix = "@worker " if target else ""
                lines = [prefix + "old task", prefix + "/clear", prefix + "new task", None]
                with contextlib.redirect_stdout(io.StringIO()), \
                        mock.patch.object(chat, "banner"), \
                        mock.patch.object(chat, "endpoint_notice"), \
                        mock.patch.object(chat, "read_user_line", side_effect=lines), \
                        mock.patch.object(chat, "prepare_agent_message", side_effect=route), \
                        mock.patch.object(chat, "run_agent_turn", side_effect=turn), \
                        mock.patch.object(chat, "cleanup_owned_processes") as cleanup, \
                        mock.patch("reach_cli.state.validate_restored_model"):
                    client._restored_model_blocked = False
                    chat._run_chat_loop(client, client.base)
                self.assertEqual(len(states), 2)
                self.assertIsNot(states[0], states[1])
                self.assertTrue(any(call.args[1]["todos"] is states[0].todos
                                    for call in cleanup.call_args_list))

    def test_clear_resets_retry_and_thought(self):
        client = ReachClient("http://127.0.0.1:20777/v1")
        client.last_thought = "old thought"
        session = commands.ReplSession()
        session.remember("old task")
        history = [{"role": "user", "content": "old task"}]
        with contextlib.redirect_stdout(io.StringIO()):
            result = commands._cmd_clear(client, history, session, "")
        self.assertTrue(result.success)
        self.assertIsNone(session.last_prompt)
        self.assertEqual(client.last_thought, "")
        self.assertFalse(any(message["role"] == "user" for message in history))


if __name__ == "__main__":
    unittest.main()
