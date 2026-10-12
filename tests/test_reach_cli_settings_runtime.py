"""Offline settings effects on requests and the native CLI agent runtime."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from reach_cli import chat, terminal
from reach_cli.client import ReachClient, ReachTransientError, _retry_after_seconds


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({"choices": [{"message": {"content": "fixture answer"}}]}).encode()


def configured(budgets=None, conversation=None):
    client = ReachClient("http://fixture.invalid/v1", model="fixture", no_stream=True)
    client.cli_settings = {"budgets": budgets or {}, "conversation": conversation or {}}
    return client


class SettingsRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(mock.patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(chat, "_set_pet_activity"))
        self.stack.enter_context(mock.patch.object(chat, "print_footer"))

    def payload(self, client):
        with mock.patch("urllib.request.urlopen", return_value=Response()) as request:
            result = client.complete([{"role": "user", "content": "hello"}])
        self.assertEqual(result["content"], "fixture answer")
        return json.loads(request.call_args.args[0].data), request.call_args.kwargs["timeout"]

    def test_explicit_generation_budgets_reach_the_provider(self):
        payload, timeout = self.payload(configured({"maxTokens": 73, "requestTimeoutMs": 2400}))
        self.assertEqual(payload["max_tokens"], 73)
        self.assertEqual(timeout, 2.4)
        self.assertEqual(payload["model"], "fixture")

    def test_zero_output_and_timeout_remove_the_application_caps(self):
        payload, timeout = self.payload(configured({"maxTokens": 0, "requestTimeoutMs": 0}))
        self.assertNotIn("max_tokens", payload)
        self.assertIsNone(timeout)

    def test_no_configured_budget_preserves_existing_request_defaults(self):
        client = configured()
        client.timeout = 81
        payload, timeout = self.payload(client)
        self.assertNotIn("max_tokens", payload)
        self.assertEqual(timeout, 81)

    def test_retry_limit_zero_does_not_retry_a_transport_failure(self):
        client = configured({"retryLimit": 0})
        with mock.patch.object(client, "complete", side_effect=ReachTransientError("busy", status=503)) as request, \
                mock.patch.object(chat, "_sleep") as wait:
            ok, result = chat.request_reply(client, [])
        self.assertFalse(ok)
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(request.call_count, 1)
        wait.assert_not_called()

    def test_retry_budget_uses_configured_backoff_and_ceiling(self):
        client = configured({"retryLimit": 2, "retryBaseMs": 300, "retryMaxMs": 400})
        steps = [ReachTransientError("busy", status=503), ReachTransientError("busy", status=503),
                 {"content": "answer", "tool_calls": []}]
        with mock.patch.object(client, "complete", side_effect=steps) as request, \
                mock.patch.object(chat, "_sleep") as wait:
            ok, result = chat.request_reply(client, [])
        self.assertTrue(ok)
        self.assertEqual(result["content"], "answer")
        self.assertEqual(request.call_count, 3)
        self.assertEqual([call.args[0] for call in wait.call_args_list], [0.3, 0.4])

    def test_retry_after_header_is_read_and_honored_with_its_own_cap(self):
        client = configured({"retryLimit": 1, "retryAfterCapMs": 700})
        failure = urllib.error.HTTPError(client.base, 429, "busy", {"Retry-After": "12"}, io.BytesIO(b"{}"))
        with mock.patch("urllib.request.urlopen", side_effect=[failure, Response()]), \
                mock.patch.object(chat, "_sleep") as wait:
            ok, result = chat.request_reply(client, [])
        self.assertTrue(ok)
        self.assertEqual(result["content"], "fixture answer")
        wait.assert_called_once_with(0.7)

    def test_retry_after_zero_cap_honors_the_provider_wait(self):
        client = configured({"retryAfterCapMs": 0})
        error = ReachTransientError("busy", retry_after=16)
        self.assertEqual(chat._retry_wait(client, 1, error), 16)
        for value in ("NaN", "-1", "inf", "nonsense", None):
            self.assertIsNone(_retry_after_seconds(value))

    def test_cli_workpath_context_can_be_disabled_and_bounded(self):
        client = configured({"codeContext": False})
        client.agent = True
        client.workpath = "fixture-workpath"
        with mock.patch.object(chat, "workpath_context", return_value="source context") as context:
            self.assertNotIn("Files in the workpath", chat.build_system(client))
            context.assert_not_called()
            client.cli_settings["budgets"] = {"codeContextChars": 6}
            self.assertTrue(chat.build_system(client).endswith("source"))

    def run_round_fixture(self, maximum, builtin_limit=16):
        client = configured({"maxRounds": maximum})
        client.agent = True
        # Exercise the round budget with actual plan advancement, so the
        # independent repeated-bookkeeping guard does not end this fixture.
        steps = [(True, {"content": "", "tool_calls": [{
            "id": "fixture_" + status, "type": "function", "function": {
                "name": "todo_write", "arguments": json.dumps({"todos": [
                    {"text": "Verify fixture", "status": status}]})}}]})
            for status in ("pending", "in_progress", "completed")]
        steps.append((True, {"content": '```agent_status\n{"status":"complete","summary":"Done"}\n```'}))
        with mock.patch.object(chat, "stream_reply", side_effect=steps) as request, \
                mock.patch.object(chat, "MAX_AGENT_ROUNDS", builtin_limit):
            self.assertTrue(chat.run_agent_turn(client, [{"role": "user", "content": "do it"}], chat.AgentState()))
        return request.call_count

    def test_explicit_round_limit_bounds_tool_requests(self):
        self.assertEqual(self.run_round_fixture(1), 1)
        self.assertIn("round limit reached", self.output.getvalue())

    def test_zero_round_limit_continues_past_the_legacy_round_cap(self):
        self.assertEqual(self.run_round_fixture(0, builtin_limit=2), 4)
        self.assertIn("agent complete: Done", self.output.getvalue())

    def test_auto_all_approves_execution_but_keeps_edit_review_independent(self):
        state = chat.AgentState()
        state.configure(configured(conversation={"approvals": "auto-all", "reviewEdits": True}))
        with mock.patch.object(terminal, "read_input", return_value="n") as ask:
            self.assertTrue(state.approve("run_command", "fixture command"))
            self.assertFalse(state.approve("edit", "fixture edit"))
        self.assertEqual(ask.call_count, 1)

    def test_disabled_edit_review_with_auto_all_applies_a_real_fixture_edit(self):
        client = configured(conversation={"approvals": "auto-all", "reviewEdits": False})
        state = chat.AgentState()
        state.configure(client)
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "note.txt"
            file.write_text("before", encoding="utf-8")
            client.workpath = temporary
            with mock.patch.object(terminal, "read_input", side_effect=AssertionError("unexpected prompt")):
                result = chat._execute_actions(client, [{"action": "edit", "path": "note.txt",
                                                        "search": "before", "replace": "after"}], state)
            self.assertIn("applied edit", result)
            self.assertEqual(file.read_text(encoding="utf-8"), "after")

    def test_review_all_answer_does_not_bypass_the_next_edit_review(self):
        state = chat.AgentState()
        state.configure(configured(conversation={"approvals": "auto-all", "reviewEdits": True}))
        with mock.patch.object(terminal, "read_input", side_effect=["a", "n"]) as ask:
            self.assertTrue(state.approve("edit", "first"))
            self.assertFalse(state.approve("edit", "second"))
        self.assertEqual(ask.call_count, 2)

    def test_unconfigured_sessions_preserve_the_legacy_always_approve_switch(self):
        from reach_cli.settings import apply_client_settings
        client = configured(conversation={"approvals": "prompt", "reviewEdits": True})
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "config.json"
            file.write_text("{}", encoding="utf-8")
            apply_client_settings(client, path=str(file))
        self.assertEqual(client.cli_settings_explicit_conversation, set())
        state = chat.AgentState()
        state.configure(client)
        with mock.patch.object(terminal, "read_input", return_value="a") as ask:
            self.assertTrue(state.approve("edit", "first"))
            self.assertTrue(state.approve("edit", "second"))
        ask.assert_called_once()

    def test_switching_permission_mode_clears_an_old_always_grant(self):
        client = configured(conversation={"approvals": "auto-all", "reviewEdits": False})
        state = chat.AgentState()
        state.configure(client)
        state.auto_approve = True
        client.cli_settings["conversation"]["approvals"] = "auto-read"
        state.configure(client)
        with mock.patch.object(terminal, "read_input", return_value="n") as ask:
            self.assertFalse(state.approve("shell", "fixture command"))
        ask.assert_called_once()


if __name__ == "__main__":
    unittest.main()
